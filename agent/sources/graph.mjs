/**
 * 记忆的形状：一张图，落在 SQLite 里。
 *
 * 为什么是图而不是一张"事实表"：
 *   记忆真正有用的时候不是"我以前说过什么"，而是"我现在问的这个东西，
 *   跟以前哪件事连着"。用户问「n8n 那个端口是多少」，命中靠的是
 *   n8n ← about ← 「我把 n8n 挪到了 5679」。边的种类（about / follows /
 *   covers）就是那层"连着"。
 *
 * 为什么这一版是 SQLite 而不是 axolotl：
 *   设计文档 §6.3 里 GraphStore 是接口，AxolotlStore 和 SqliteStore 两个实现，
 *   而 §6.3 自己写了"备胎够用"的理由 —— 个人记忆是 5 万节点 / 15 万边，
 *   这个规模上任何实现都是毫秒级。这一版先把**上层**（抽取、五信号、社群合并、
 *   定向回忆）跑通；换引擎只换这个文件，memory.mjs 一行不用动。
 *   接口就照文档那九个方法，一个不多。
 *
 * 零依赖：node:sqlite 是 Node 22.5+ 的内建模块（22.13 起不用开 flag），
 * 和仓库"部署时什么都不用装"的约定一致。
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

/** 事实节点的 id 由**规范化后的文本**决定 —— 同一句话天然去重，不需要额外查表。 */
export const factId = (text) => 'f:' + sha(norm(text));
export const entityId = (label) => 'e:' + sha(norm(label));

/** 归一化：全角空格、多余空白、大小写都要收敛，否则"n8n"和"N8n "是两个实体。 */
export function norm(s) {
  return String(s || '')
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
    .toLowerCase();
}

const now = () => Date.now();

const SCHEMA = `
create table if not exists nodes (
  id         text primary key,
  kind       text not null,              -- fact | entity | community
  label      text not null,
  props      text not null default '{}',
  valence    real not null default 0,    -- -1 ~ 1，情绪色彩（五信号之一）
  freq       integer not null default 1, -- 被重复提到几次（巩固/去重时 +1）
  access     integer not null default 0, -- 被回忆命中几次
  weight     real not null default 0,    -- 最近一次巩固算出来的分数
  first_ts   integer not null,
  last_ts    integer not null,
  access_ts  integer,
  alive      integer not null default 1, -- 软删除。删掉的东西要能捞回来
  src        text,                       -- 来源：<sid>#<turn>，审计要指得回去
  community  text
);
create index if not exists nodes_kind on nodes(kind, alive);
create index if not exists nodes_label on nodes(label);
create index if not exists nodes_last on nodes(last_ts);

create table if not exists edges (
  src      text not null,
  dst      text not null,
  type     text not null,                -- about | follows | covers | same_as
  weight   real not null default 1,
  first_ts integer not null,
  last_ts  integer not null,
  alive    integer not null default 1,
  primary key (src, dst, type)
);
create index if not exists edges_dst on edges(dst, type, alive);
create index if not exists edges_src on edges(src, type, alive);

create table if not exists meta (k text primary key, v text);
`;

/**
 * @param {string} file  .db 路径
 */
export function openGraph(file) {
  const db = new DatabaseSync(file);
  /* WAL 是为了"进程被杀也不会把库写坏"，而不是为了并发 —— 这个服务只有一个写者。
     它和 axolotl 的 WAL 是同一个道理：记忆可以丢最后一条，不能整个打不开。 */
  db.exec('pragma journal_mode = wal');
  db.exec('pragma synchronous = normal');
  db.exec(SCHEMA);

  const stmt = (sql) => db.prepare(sql);

  const row2node = (r) => (r ? {
    id: r.id, kind: r.kind, label: r.label,
    props: safeJSON(r.props),
    valence: r.valence, freq: r.freq, access: r.access, weight: r.weight,
    firstTs: r.first_ts, lastTs: r.last_ts, accessTs: r.access_ts,
    alive: !!r.alive, src: r.src || null, community: r.community || null,
  } : null);

  const row2edge = (r) => ({
    src: r.src, dst: r.dst, type: r.type, weight: r.weight,
    firstTs: r.first_ts, lastTs: r.last_ts, alive: !!r.alive,
  });

  return {
    file,

    /* ── 写 ── */

    upsertNode({ id, kind, label, props = {}, valence = 0, weight = 0, src = null, ts = now() }) {
      const prev = row2node(stmt('select * from nodes where id = ?').get(id));
      if (prev) {
        /* 重复提到 = 强化，不是插入新行。情绪取平均：同一条事实被反复说了三次，
           三次都带负情绪，说明这件事真的让他不舒服；平均比"取最后一次"稳。 */
        const v = (prev.valence + valence) / 2;
        stmt(`update nodes set freq = freq + 1, last_ts = ?, valence = ?, weight = ?,
              alive = 1, props = ? where id = ?`)
          .run(ts, v, Math.max(prev.weight, weight), JSON.stringify({ ...prev.props, ...props }), id);
        return { ...prev, freq: prev.freq + 1, lastTs: ts, valence: v, alive: true };
      }
      stmt(`insert into nodes (id, kind, label, props, valence, freq, access, weight, first_ts, last_ts, alive, src)
            values (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, 1, ?)`)
        .run(id, kind, label, JSON.stringify(props), valence, weight, ts, ts, src);
      return { id, kind, label, props, valence, freq: 1, access: 0, weight, firstTs: ts, lastTs: ts, alive: true, src };
    },

    /** 摘要节点用：覆盖写、**不**强化 freq。同一批成员重算两次不该算"被提到两次"。 */
    putNode({ id, kind, label, props = {}, weight = 0, src = null, ts = now() }) {
      const prev = row2node(stmt('select * from nodes where id = ?').get(id));
      if (prev) {
        stmt('update nodes set label = ?, props = ?, weight = ?, last_ts = ?, alive = 1 where id = ?')
          .run(label, JSON.stringify(props), weight, ts, id);
        return { ...prev, label, props, weight, lastTs: ts, alive: true };
      }
      stmt(`insert into nodes (id, kind, label, props, valence, freq, access, weight, first_ts, last_ts, alive, src)
            values (?, ?, ?, ?, 0, 1, 0, ?, ?, ?, 1, ?)`)
        .run(id, kind, label, JSON.stringify(props), weight, ts, ts, src);
      return { id, kind, label, props, valence: 0, freq: 1, access: 0, weight, firstTs: ts, lastTs: ts, alive: true, src };
    },

    upsertEdge({ src, dst, type, weight = 1, ts = now() }) {
      const prev = stmt('select * from edges where src = ? and dst = ? and type = ?').get(src, dst, type);
      if (prev) {
        stmt('update edges set weight = weight + ?, last_ts = ?, alive = 1 where src = ? and dst = ? and type = ?')
          .run(weight, ts, src, dst, type);
      } else {
        stmt('insert into edges (src, dst, type, weight, first_ts, last_ts, alive) values (?, ?, ?, ?, ?, ?, 1)')
          .run(src, dst, type, weight, ts, ts);
      }
    },

    /** 回忆命中一次 —— 这是 access 信号的唯一来源。 */
    touch(id, ts = now()) {
      stmt('update nodes set access = access + 1, access_ts = ? where id = ?').run(ts, id);
    },

    softDelete(ids) {
      const del = stmt('update nodes set alive = 0 where id = ?');
      /* 事实的边跟着一起下葬。不这样做，stats 里的主题计数会把"剪掉的记忆"
         继续算进去（实测：删了 4 条，n8n 仍然显示 9 条），
         用户看到的数字和实际能回忆到的东西对不上。 */
      const delEdge = stmt('update edges set alive = 0 where src = ?');
      let n = 0;
      for (const id of ids) { del.run(id); delEdge.run(id); n++; }
      return n;
    },

    /** 收拾历史遗留：早先软删的节点，边还活着。巩固时扫一遍（幂等）。 */
    sweepEdges() {
      const r = stmt('update edges set alive = 0 where alive = 1 and src in (select id from nodes where alive = 0)').run();
      return r.changes || 0;
    },

    setCommunity(id, community) {
      stmt('update nodes set community = ? where id = ?').run(community, id);
    },

    setWeight(id, weight) {
      stmt('update nodes set weight = ? where id = ?').run(weight, id);
    },

    /* 批量版。巩固一次要给几千个节点打分数 —— 一个个 write 在网络存储上
       就是几千次往返，批量是必须的（SQLite 这版只是顺手对齐接口）。 */
    setWeights(items) {
      const st = stmt('update nodes set weight = ? where id = ?');
      for (const { id, weight } of items) st.run(weight, id);
      return items.length;
    },

    setCommunities(items) {
      const st = stmt('update nodes set community = ? where id = ?');
      for (const { id, community } of items) st.run(community, id);
      return items.length;
    },

    /* ── 读 ── */

    getNode(id) { return row2node(stmt('select * from nodes where id = ?').get(id)); },

    nodeByLabel(kind, label) {
      return row2node(stmt('select * from nodes where kind = ? and label = ? and alive = 1').get(kind, norm(label)));
    },

    /** 全量（活着的那部分）。个人记忆这个量级上，在 JS 里排序比写 40 条 SQL 清楚。 */
    nodes(kind = null, limit = 20000) {
      const rows = kind
        ? stmt('select * from nodes where alive = 1 and kind = ? order by last_ts desc limit ?').all(kind, limit)
        : stmt('select * from nodes where alive = 1 order by last_ts desc limit ?').all(limit);
      return rows.map(row2node);
    },

    edges(srcIds = null, type = null) {
      if (!srcIds) {
        const rows = stmt('select * from edges where alive = 1').all();
        return rows.map(row2edge);
      }
      if (!srcIds.length) return [];
      const ph = srcIds.map(() => '?').join(',');
      const sql = `select * from edges where alive = 1 and (src in (${ph}) or dst in (${ph}))`
        + (type ? ' and type = ?' : '');
      const params = type ? [...srcIds, ...srcIds, type] : [...srcIds, ...srcIds];
      return stmt(sql).all(...params).map(row2edge);
    },

    degreeMap() {
      const out = new Map();
      for (const r of stmt('select src as id, count(*) as n from edges where alive = 1 group by src').all()) {
        out.set(r.id, (out.get(r.id) || 0) + r.n);
      }
      for (const r of stmt('select dst as id, count(*) as n from edges where alive = 1 group by dst').all()) {
        out.set(r.id, (out.get(r.id) || 0) + r.n);
      }
      return out;
    },

    stats() {
      const one = (sql) => stmt(sql).get();
      return {
        facts: one("select count(*) n from nodes where alive = 1 and kind = 'fact'").n,
        entities: one("select count(*) n from nodes where alive = 1 and kind = 'entity'").n,
        communities: one("select count(*) n from nodes where alive = 1 and kind = 'community'").n,
        edges: one('select count(*) n from edges where alive = 1').n,
        pruned: one('select count(*) n from nodes where alive = 0').n,
      };
    },

    meta: {
      get(k) { const r = stmt('select v from meta where k = ?').get(k); return r ? safeJSON(r.v) : null; },
      set(k, v) {
        stmt('insert into meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v')
          .run(k, JSON.stringify(v));
      },
    },

    /** 一致性快照。用 VACUUM INTO 而不是复制文件 —— 复制一个正在写的 WAL 库会得到半张图。 */
    snapshot(target) {
      db.exec(`vacuum into '${String(target).replace(/'/g, "''")}'`);
      return target;
    },

    close() { try { db.close(); } catch { /* 已经关了 */ } },
  };
}

/** 故意不抛：记错字段的记忆节点比"整个服务起不来"好得多。 */
function safeJSON(s) {
  if (typeof s !== 'string') return s || {};
  try { return JSON.parse(s); } catch { return {}; }
}
