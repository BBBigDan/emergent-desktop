#!/usr/bin/env python3
"""
记忆的存储侧车 —— 真的图库，不是模拟。

`agent/memory.mjs` 通过 `agent/sources/graph.axolotl.mjs` 用 HTTP 调这里，
这里用 `axolotl_rs`（Rust 引擎的 PyO3 绑定）把节点和边写进一个 `.axeb`。

为什么是侧车、不是重写进 Node：
   文档 §6.4 已经定了这件事 —— axolotl 是验证过的 Rust 实现，重写一遍没有收益，
   只会引入新 bug。同 pod 共享 localhost，一个容器崩了不带走另一个；
   **这边起不来时，agent 会退回 SQLite（无记忆模式）而不是跟着挂掉。**

接口只有一组 `POST /call {op, args}`。op 的名字与 `sources/graph.mjs`
（SQLite 那份实现）一一对应 —— 上层的 memory.mjs 不知道自己下面换了引擎。

  启动：AX_USERSPACE=/userspace python3 server.py
  环境：AX_DB        直接指定 .axeb 路径（优先）
        AX_USERSPACE 没给 AX_DB 时，按 pvc-userspace-*/Home/Agent/memory 推导
        PORT         默认 7801
"""

import hashlib
import json
import os
import signal
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import axolotl_rs
except Exception as e:  # pragma: no cover - 起不来要吵，但不能把 agent 带下水
    print(f"[memsvc] 无法加载 axolotl_rs：{e}", flush=True)
    sys.exit(2)

PORT = int(os.environ.get("PORT", "7801"))
SAVE_IDLE_MS = int(os.environ.get("AX_SAVE_MS", "2500"))
META_SID = "__meta__"

_lock = threading.RLock()
_dirty = False
_last_write = 0.0
_stop = threading.Event()


# ───────────────────────── 路径 ─────────────────────────

def resolve_db():
    direct = os.environ.get("AX_DB")
    if direct:
        return direct
    root = os.environ.get("AX_USERSPACE", "")
    if root and os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            if name.startswith("pvc-userspace-"):
                d = os.path.join(root, name, "Home", "Agent", "memory")
                os.makedirs(d, exist_ok=True)
                return os.path.join(d, "memory.axeb")
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "memory")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "memory.axeb")


DB_PATH = resolve_db()
os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
g = axolotl_rs.AxolotlGraph.open(DB_PATH)


# ───────────────────────── 编解码 ─────────────────────────

def hid(s):
    """字符串 id → u64。图的顶点 id 是数字，而我们的 id 是 `f:<hash>` / `e:<hash>`。
    取 sha1 前 8 字节，碰撞概率在这个量级上可以忽略；真撞了会在读回时
    因为 `sid` 对不上而被发现（不会静默串台）。"""
    return int.from_bytes(hashlib.sha1(str(s).encode()).digest()[:8], "big")


def now_ms():
    return int(time.time() * 1000)


def _shape(sid, kind, label, j):
    return {
        "id": sid,
        "kind": kind,
        "label": label,
        "props": j.get("props") or {},
        "valence": float(j.get("valence", 0)),
        "freq": int(j.get("freq", 1)),
        "access": int(j.get("access", 0)),
        "weight": float(j.get("weight", 0)),
        "firstTs": int(j.get("firstTs", 0)),
        "lastTs": int(j.get("lastTs", 0)),
        "accessTs": j.get("accessTs"),
        "alive": bool(j.get("alive", True)),
        "src": j.get("src"),
        "community": j.get("community"),
    }


def read_node(sid):
    v = g.get_vertex(hid(sid))
    if not v or v.get("sid") != sid:
        return None
    try:
        j = json.loads(v.get("j") or "{}")
    except Exception:
        j = {}
    return _shape(sid, v.get("kind", ""), v.get("label", ""), j)


def write_node(n):
    """整条覆盖写。`add_vertex` 对已存在的 id 是"更新属性"，不是插入 —— 
    这一点是这套实现能用的前提（见 gpu_edge_block.rs:157）。"""
    j = {
        "props": n["props"], "valence": n["valence"], "freq": n["freq"], "access": n["access"],
        "weight": n["weight"], "firstTs": n["firstTs"], "lastTs": n["lastTs"],
        "accessTs": n.get("accessTs"), "alive": n["alive"], "src": n.get("src"),
        "community": n.get("community"),
    }
    g.add_vertex(hid(n["id"]), {"sid": n["id"], "kind": n["kind"], "label": n["label"],
                                "j": json.dumps(j, ensure_ascii=False)})
    mark_dirty()


def all_nodes(kind=None):
    out = []
    for vid, props in g.vertices():
        sid = props.get("sid")
        if not sid or sid == META_SID:
            continue
        k = props.get("kind", "")
        if kind and k != kind:
            continue
        try:
            j = json.loads(props.get("j") or "{}")
        except Exception:
            j = {}
        out.append(_shape(sid, k, props.get("label", ""), j))
    return out


def all_edges():
    """边按**字符串 id** 返回。图的顶点 id 是 u64，上层说的是 `f:<hash>`，
    翻译必须在边界上做完一次 —— 让每个调用方自己记着两套 id 是 bug 的温床。"""
    by_h = {hid(n["id"]): n["id"] for n in all_nodes()}
    out = []
    for fr, to, w, props in g.edges():
        out.append({"src": by_h.get(fr), "dst": by_h.get(to), "weight": float(w),
                    "type": props.get("type", ""), "firstTs": props.get("first_ts"),
                    "lastTs": props.get("last_ts")})
    return out


# ───────────────────────── 落盘 ─────────────────────────

def mark_dirty():
    global _dirty, _last_write
    _dirty = True
    _last_write = time.time()


def save_now(target=None):
    """原子落盘：先写临时文件再 rename。
    直接覆盖 .axeb 时，进程在半路被杀会留下半个图 —— 那比丢最后一条记忆糟得多。"""
    global _dirty
    target = target or DB_PATH
    tmp = target + ".tmp"
    with _lock:
        g.save_to(tmp)
        os.replace(tmp, target)
        _dirty = False
    return target


def saver():
    while not _stop.is_set():
        time.sleep(0.5)
        if _dirty and (time.time() - _last_write) * 1000 >= SAVE_IDLE_MS:
            try:
                save_now()
            except Exception as e:
                print(f"[memsvc] 落盘失败：{e}", flush=True)


# ───────────────────────── 迁移 ─────────────────────────

def migrate_from_sqlite():
    """从上一版（SQLite）接过来。只在图是空的时候做一次 —— 
    两套库同时活着比丢几条测试记忆危险得多。"""
    sq = os.path.join(os.path.dirname(DB_PATH), "memory.db")
    if not os.path.exists(sq) or g.vertex_count() > 0:
        return 0
    try:
        conn = sqlite3.connect(sq)
        conn.row_factory = sqlite3.Row
        n = 0
        for r in conn.execute("select * from nodes"):
            try:
                props = json.loads(r["props"] or "{}")
            except Exception:
                props = {}
            write_node({
                "id": r["id"], "kind": r["kind"], "label": r["label"], "props": props,
                "valence": r["valence"], "freq": r["freq"], "access": r["access"],
                "weight": r["weight"], "firstTs": r["first_ts"], "lastTs": r["last_ts"],
                "accessTs": r["access_ts"], "alive": bool(r["alive"]), "src": r["src"],
                "community": r["community"],
            })
            n += 1
        for e in conn.execute("select * from edges"):
            if not e["alive"]:
                continue
            g.add_edge(hid(e["src"]), hid(e["dst"]), float(e["weight"]),
                       {"type": e["type"], "first_ts": e["first_ts"], "last_ts": e["last_ts"]})
        meta = {}
        for m in conn.execute("select k, v from meta"):
            try:
                meta[m["k"]] = json.loads(m["v"])
            except Exception:
                pass
        if meta:
            write_meta(meta)
        conn.close()
        save_now()
        # 迁完就把旧库改名。留着它的话，万一哪天 .axeb 被清空，会**再迁一次** ——
        # 那等于把删掉的记忆复活，比丢记忆更难解释。
        try:
            os.replace(sq, sq + ".migrated")
        except Exception:
            pass
        print(f"[memsvc] 从 SQLite 迁入 {n} 个节点（旧库改名为 memory.db.migrated）", flush=True)
        return n
    except Exception as e:
        print(f"[memsvc] 迁移失败（不影响启动）：{e}", flush=True)
        return 0


# ───────────────────────── meta ─────────────────────────

def read_meta():
    v = g.get_vertex(hid(META_SID))
    if not v or v.get("sid") != META_SID:
        return {}
    try:
        return json.loads(v.get("j") or "{}")
    except Exception:
        return {}


def write_meta(obj):
    g.add_vertex(hid(META_SID), {"sid": META_SID, "kind": "meta", "label": "meta",
                                 "j": json.dumps(obj, ensure_ascii=False)})


# ───────────────────────── ops ─────────────────────────

OPS = {}


def op(name):
    def deco(fn):
        OPS[name] = fn
        return fn
    return deco


@op("upsertNode")
def _upsert_node(a):
    sid = str(a["id"])
    ts = int(a.get("ts") or now_ms())
    prev = read_node(sid)
    if prev:
        n = dict(prev)
        if a.get("mode") == "put":
            n["label"] = a.get("label", n["label"])
            n["props"] = a.get("props", n["props"])
            n["weight"] = float(a.get("weight", n["weight"]))
            n["lastTs"] = ts
        else:
            n["freq"] += 1
            n["lastTs"] = ts
            n["valence"] = (n["valence"] + float(a.get("valence", 0))) / 2
            n["weight"] = max(n["weight"], float(a.get("weight", 0)))
            n["props"] = {**(n["props"] or {}), **(a.get("props") or {})}
        n["alive"] = True
        write_node(n)
        return n
    n = {
        "id": sid, "kind": str(a.get("kind") or "fact"), "label": str(a.get("label") or ""),
        "props": a.get("props") or {}, "valence": float(a.get("valence", 0)), "freq": 1,
        "access": 0, "weight": float(a.get("weight", 0)), "firstTs": ts, "lastTs": ts,
        "accessTs": None, "alive": True, "src": a.get("src"), "community": None,
    }
    write_node(n)
    return n


@op("upsertEdge")
def _upsert_edge(a):
    fr, to = hid(a["src"]), hid(a["dst"])
    ts = int(a.get("ts") or now_ms())
    w = float(a.get("weight", 1))
    typ = str(a.get("type") or "")
    # 一对顶点之间我们只用一种边（fact→entity 的 about）。axolotl 支持平行边，
    # 但"累加权重"没有原地更新接口 —— 先删再按新总重加，语义最直白。
    for ew, _p in (g.get_edges(fr, to) or []):
        g.remove_edge(fr, to)
        g.add_edge(fr, to, float(ew) + w, {"type": typ, "first_ts": ts, "last_ts": ts})
        mark_dirty()
        return {"src": a["src"], "dst": a["dst"], "type": typ, "weight": float(ew) + w}
    g.add_edge(fr, to, w, {"type": typ, "first_ts": ts, "last_ts": ts})
    mark_dirty()
    return {"src": a["src"], "dst": a["dst"], "type": typ, "weight": w}


@op("touch")
def _touch(a):
    n = read_node(str(a["id"]))
    if not n:
        return None
    n["access"] += 1
    n["accessTs"] = int(a.get("ts") or now_ms())
    write_node(n)
    return n


@op("softDelete")
def _soft_delete(a):
    ids = a.get("ids") or []
    n = 0
    for sid in ids:
        node = read_node(str(sid))
        if node:
            node["alive"] = False
            write_node(node)
            n += 1
    return n


@op("setCommunity")
def _set_community(a):
    n = read_node(str(a["id"]))
    if not n:
        return None
    n["community"] = a.get("community")
    write_node(n)
    return n


@op("setWeight")
def _set_weight(a):
    n = read_node(str(a["id"]))
    if not n:
        return None
    n["weight"] = float(a.get("weight", 0))
    write_node(n)
    return n


@op("setWeights")
def _set_weights(a):
    n = 0
    for it in (a.get("items") or []):
        node = read_node(str(it["id"]))
        if not node:
            continue
        node["weight"] = float(it.get("weight", 0))
        write_node(node)
        n += 1
    return n


@op("setCommunities")
def _set_communities(a):
    n = 0
    for it in (a.get("items") or []):
        node = read_node(str(it["id"]))
        if not node:
            continue
        node["community"] = it.get("community")
        write_node(node)
        n += 1
    return n


@op("getNode")
def _get_node(a):
    return read_node(str(a["id"]))


@op("nodeByLabel")
def _by_label(a):
    kind, label = a.get("kind"), str(a.get("label") or "").lower()
    for n in all_nodes(kind):
        if n["alive"] and n["label"].lower() == label:
            return n
    return None


@op("nodes")
def _nodes(a):
    kind = a.get("kind")
    limit = int(a.get("limit") or 20000)
    rows = [n for n in all_nodes(kind) if n["alive"]]
    rows.sort(key=lambda n: n["lastTs"], reverse=True)
    return rows[:limit]


@op("edges")
def _edges(a):
    return all_edges()


@op("degreeMap")
def _degree(a):
    deg = {}
    for e in all_edges():
        for sid in (e["src"], e["dst"]):
            if sid:
                deg[sid] = deg.get(sid, 0) + 1
    return deg


@op("stats")
def _stats(a):
    ns = all_nodes()
    es = all_edges()
    facts = sum(1 for n in ns if n["alive"] and n["kind"] == "fact")
    ents = sum(1 for n in ns if n["alive"] and n["kind"] == "entity")
    comms = sum(1 for n in ns if n["alive"] and n["kind"] == "community")
    return {"facts": facts, "entities": ents, "communities": comms,
            "edges": len(es), "pruned": sum(1 for n in ns if not n["alive"])}


@op("metaGet")
def _meta_get(a):
    return read_meta().get(a["k"])


@op("metaSet")
def _meta_set(a):
    m = read_meta()
    if a.get("v") is None:
        m.pop(a["k"], None)
    else:
        m[a["k"]] = a["v"]
    write_meta(m)
    mark_dirty()
    return True


@op("sweepEdges")
def _sweep_edges(a):
    dead = {n["id"] for n in all_nodes() if not n["alive"]}
    if not dead:
        return 0
    removed = 0
    for e in all_edges():
        if e["src"] in dead:
            if g.remove_edge(hid(e["src"]), hid(e["dst"])):
                removed += 1
    if removed:
        mark_dirty()
    return removed


@op("snapshot")
def _snapshot(a):
    save_now(a.get("target"))
    return a.get("target") or DB_PATH


@op("save")
def _save(a):
    return save_now()


@op("health")
def _health(a):
    return {"ok": True, "db": DB_PATH, "vertices": g.vertex_count(), "edges": g.edge_count(),
            "dirty": _dirty, "pid": os.getpid()}


# ───────────────────────── HTTP ─────────────────────────

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 只要写操作，别把每个 GET 都刷出来
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            with _lock:
                return self._send(200, _health({}))
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/call"):
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._send(400, {"ok": False, "error": f"bad json: {e}"})
        name = req.get("op")
        fn = OPS.get(name)
        if not fn:
            return self._send(400, {"ok": False, "error": f"unknown op: {name}"})
        try:
            with _lock:
                return self._send(200, {"ok": True, "result": fn(req.get("args") or {})})
        except Exception as e:
            return self._send(200, {"ok": False, "error": f"{type(e).__name__}: {e}"})


def on_term(*_):
    _stop.set()
    try:
        save_now()
    except Exception:
        pass
    print("[memsvc] 已落盘退出", flush=True)
    os._exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    print(f"[memsvc] axolotl {DB_PATH} · {g.vertex_count()} 节点 / {g.edge_count()} 边", flush=True)
    migrate_from_sqlite()
    # 上次没落盘就死了（WAL 之外的粗粒度兜底）：起一个后台线程按空闲时间落盘
    threading.Thread(target=saver, daemon=True).start()
    print(f"[memsvc] listening 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
