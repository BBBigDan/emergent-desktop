/**
 * 记忆的存储：走 axolotl（Rust 图引擎）的侧车。
 *
 * 和 `graph.mjs`（SQLite）是**同一套方法**，返回同样的形状 ——
 * 所以 `memory.mjs` 不知道下面换的是哪个引擎，换引擎只换这一层的选择。
 * 区别只有一个：网络调用是异步的，所以这一份的每个方法都返回 Promise，
 * `memory.mjs` 一律 await（SQLite 那份 await 一个普通值也没问题）。
 *
 * 为什么是 HTTP 而不是把 Rust 编成 Node 插件：
 * 侧车的形态在文档 §6.4 就定了 —— 同 pod 共享 localhost，一个容器崩了不带走另一个。
 * 现在这个 HTTP 服务是 `agent/memsvc/server.py`，它只做"搬运 + 落盘"，
 * 图的算法与持久化全在 axolotl 里。
 */

const DEFAULTS = { url: 'http://127.0.0.1:7801', timeoutMs: 4000 };

export async function openAxolotl(o = {}) {
  const url = (o.url || process.env.MEMORY_URL || DEFAULTS.url).replace(/\/+$/, '');
  const timeoutMs = Number(o.timeoutMs || process.env.MEMORY_TIMEOUT || DEFAULTS.timeoutMs);

  async function call(op, args = {}) {
    const r = await fetch(`${url}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok !== true) {
      throw new Error(`${op}: ${j?.error || `HTTP ${r.status}`}`);
    }
    return j.result;
  }

  /* 开门先握手。同一个 pod 里的两个容器是**并行**起的，agent 常常比侧车先准备好 ——
     实测差 1~2 秒，第一次部署就撞上了（fetch failed，然后记忆被停用）。
     所以这里等一会儿：总共约 8 秒，够 Python 解释器 + 加载 wheel + 开图。
     等不到就抛，上层据此停用记忆（记忆可以降级，主循环不能挂）。 */
  let health = null;
  let lastErr = null;
  for (let i = 0; i < 16; i++) {
    try {
      health = await call('health');
      if (health?.ok) break;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!health?.ok) throw new Error(`memsvc 未就绪：${lastErr?.message || 'no health'}`);

  return {
    kind: 'axolotl',
    file: health.db,
    health,

    /* ── 写 ── */
    upsertNode: (n) => call('upsertNode', n),
    putNode: (n) => call('upsertNode', { ...n, mode: 'put' }),
    upsertEdge: (e) => call('upsertEdge', e),
    touch: (id, ts) => call('touch', { id, ts }),
    softDelete: (ids) => call('softDelete', { ids }),
    sweepEdges: () => call('sweepEdges'),
    setCommunity: (id, community) => call('setCommunity', { id, community }),
    setWeight: (id, weight) => call('setWeight', { id, weight }),
    setWeights: (items) => call('setWeights', { items }),
    setCommunities: (items) => call('setCommunities', { items }),

    /* ── 读 ── */
    getNode: (id) => call('getNode', { id }),
    nodeByLabel: (kind, label) => call('nodeByLabel', { kind, label }),
    nodes: (kind = null, limit = 20000) => call('nodes', { kind, limit }),
    async edges(srcIds = null, type = null) {
      const all = await call('edges');
      let out = all;
      if (srcIds) {
        const set = new Set(srcIds);
        out = out.filter((e) => set.has(e.src) || set.has(e.dst));
      }
      if (type) out = out.filter((e) => e.type === type);
      return out;
    },
    /* JSON 里没有 Map。上层用的是 `deg.get(id)`（和 SQLite 那版一致），
       所以在边界上转回来 —— 别让调用方去猜"这次拿到的是 Map 还是对象"。 */
    async degreeMap() {
      const o = await call('degreeMap');
      return new Map(Object.entries(o));
    },
    stats: () => call('stats'),

    meta: {
      get: (k) => call('metaGet', { k }),
      set: (k, v) => call('metaSet', { k, v }),
    },

    snapshot: (target) => call('snapshot', { target }),
    close: () => call('save').catch(() => {}),
  };
}
