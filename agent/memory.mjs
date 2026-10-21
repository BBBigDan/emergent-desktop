/**
 * 长期记忆 —— 让"关掉再打开"之后它还记得昨天。
 *
 * 一件事只做三件：
 *   1. **抽取**：一轮对话结束，让模型把"值得长期记住"的东西写成几条事实
 *      （不是整段对话 —— 对话已经存在会话文件里了，那是短期记忆）
 *   2. **回忆**：下一轮开始时，按这句话去图里定向取几条，塞进系统提示
 *   3. **巩固**：每 N 轮算一次五信号（valence / freq / recency / access /
 *      centrality），剪掉没人再碰的，把连成一团的记忆塌缩成摘要节点
 *
 * 三个刻意的选择：
 *
 * · **抽取由主模型做，不引第二个模型。** 这是 lobster-memory 的原设计：
 *   "你就是抽取器"。多一个模型就是多一份 key、多一个延迟、多一种不一致。
 *   代价是每轮多一次 LLM 调用（7B 约 1~2 秒），所以它在后台跑，不挡回话。
 *
 * · **回忆是定向的，不是 dump。** 5 万节点的图塞不进 7B 的窗口；而且全量 dump
 *   等于每轮都给它念一遍日记，它会开始复述过去而不是回答现在。
 *
 * · **删是软删。** 记忆丢错了没法道歉。剪掉的节点 alive=0，能捞回来，
 *   快照还在 snapshots/ 里 —— 用户说"你把我说的那件事忘了"时，这是唯一体面的回答。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openGraph, factId, entityId, norm } from './sources/graph.mjs';

const DAY = 86_400_000;
const JOURNAL_MAX = 40;          // 一轮里最多抽几条（模型一般给 1~3 条）
const CONSOLIDATE_EVERY = 6;     // 每几轮巩固一次
const SWEEP_EVERY = 6 * 3600_000; // 或者每 6 小时，哪个先到算哪个
const KEEP_MAX = 4000;           // 图的上限。超了按分数剪最弱的
const SNAPSHOTS = 5;

/** 这些词不是"实体"。把它们建成节点会让整张图连成一团，社群合并就失去意义。 */
const GENERIC = new Set(['用户', '我', '这台机器', '这台', '机器', '系统', '桌面', '你']);
const KINDS = new Set(['pref', 'event', 'fact', 'task', 'relation']);

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

/* 部件词表。
 *
 * 7B 给的 about 往往只有主语（"n8n"），可"同一条记忆里还提到了什么"
 * 恰恰是回忆的跳板：问"日志"要能找到谈论 n8n 日志的那一条。
 * 与其求模型多写两个词（实测求不动），不如让它只负责**主语**，
 * 部件由这份词表兜住 —— 它比模型稳定，也比模型便宜。
 * 加词要有节制：这些是这台机器上真正常出现的东西，不是通用名词表。 */
const PARTS = ['端口', '日志', '内存', '磁盘', 'CPU', '备份', '相册', '下载', '网络',
  '域名', '证书', '数据库', '容器', '镜像', '配置', '权限', '温度', '队列', '任务',
  '通知', '账号', '密码', '代理', '隧道', '风扇'];

function partsOf(text) {
  const t = String(text || '').toLowerCase();
  return PARTS.filter((p) => t.includes(p.toLowerCase())).slice(0, 2);
}

/* ───────────────────────── 文本工具 ───────────────────────── */

/** 中文没有空格，2-gram 是"能命中"和"完全命中"之间最省事的那一档。 */
function grams(s) {
  const t = norm(s);
  const out = new Set();
  for (const m of t.matchAll(/[a-z0-9_.\-]{2,}/g)) out.add(m[0]);
  for (const seg of t.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
    if (seg.length === 1) out.add(seg);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 查询要被切成"能被 includes 命中的片段"。整句 includes 太严，单字太松。 */
function termsOf(q) {
  const t = norm(q);
  const out = new Set();
  for (const m of t.matchAll(/[a-z0-9_.\-]{2,}/g)) out.add(m[0]);
  for (const seg of t.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length <= 3) out.add(seg);
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  /* 长度优先：命中了"端口"比命中了"的"有信息量得多（见 score 里的权重） */
  return [...out].filter((x) => x.length >= 2).sort((a, b) => b.length - a.length).slice(0, 40);
}

function whenText(ts, nowTs = Date.now()) {
  const d = Math.floor((nowTs - ts) / DAY);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 7) return `${d} 天前`;
  if (d < 30) return `${Math.floor(d / 7)} 周前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

/* ───────────────────────── 抽取 ───────────────────────── */

/* 抽取用的提示词独立于主提示词：它不需要知道"场"长什么样，
   只需要知道"什么值得记"。混在一起会让模型开始给记忆铺屏。 */
export const EXTRACT_SYS = `你把一段刚结束的对话压缩成**几条值得长期记住的事实**。

只记这几种：
- 用户的偏好、习惯、忌讳（"不喜欢在半夜被重启应用"）
- 用户做过的事、改过的东西（"把 n8n 挪到了 5679 端口"）
- 结论与因果（"n8n 每小时重启一次，原因是内存超限"）
- 认得的东西（"那堆 iso 指的是 Downloads 里三个系统镜像"）

不记：任何读数（CPU 18%、内存 41%）、寒暄、你打算做什么、临时状态、屏幕上有几个仪表。

输出**只有** JSON，不要解释、不要代码围栏：
{"facts":[{"text":"用户把 n8n 挪到了 5679 端口","about":["n8n"],"kind":"event","valence":0.2}]}

规则：
- 最多 3 条。宁少勿多 —— 记错一条比少记一条糟得多。
- **只写对话里出现过的。** 用户说"怀疑"，就写"用户怀疑…"；不要替他把原因定下来。
  你写下的每一句都要能在上面这段对话里找到出处。编一条因果，比不记这一轮坏得多。
- **"我说"那一行不作数。** 那是我自己的回话，我可能说错（实测有过：
  用户说日志在 ~/n8n.log，我却回了"没有日志文件"）。事实只从"用户说"和
  "我做了 → 工具返回"里来；拿不准就不写。
- text 是一句完整的话，用第三人称，不超过 40 个字，不要写"用户说"，也不要写半句
  （"怀疑是重启太频繁"不行，"用户怀疑 n8n 重启太频繁"可以）。
- about 是这句话里出现的**所有**具体东西：应用名、文件名、部件（端口 / 日志 / 内存）、
  人、主题，1~3 个。只写一个"n8n"太少了 —— 两个东西一起出现在同一句话里，
  以后才能顺着它找回另一件事。不要写"用户""这台机器"。
- kind 只能是 pref / event / fact / task / relation。
- valence 是这件事对用户的好坏，-1（很糟）到 1（很好），中性写 0。
- 没有值得记的就输出 {"facts":[]}。

例（示例里的名字和数字只是形状，不许照抄到结果里）：
"我把 PhotoPrism 挪到 8000 了，以后相册超过 10 万张就提醒我"
→ {"facts":[
  {"text":"用户把 PhotoPrism 挪到了 8000 端口","about":["PhotoPrism","8000 端口"],"kind":"event","valence":0.2},
  {"text":"用户要求相册超过 10 万张时提醒他","about":["PhotoPrism","相册"],"kind":"task","valence":0}]}`;

/** 只取**第一个完整的 JSON 对象**。
 *
 * 实测 7B 会复读：先给一份正确的 JSON，再跟一句「```json」把同一份重抄一遍。
 * 之前用的是"第一个 { 到最后一个 }"，于是两段被拼成一个非法字符串，
 * 整轮记忆静默丢失 —— 而日志里只看到"抽取失败"或者干脆什么都没有。
 * 现在按括号配平扫（带字符串转义），第一段完整对象就是答案，后面的复读直接忽略。
 */
function firstJsonObject(s) {
  const start = String(s || '').indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return s.slice(start, i + 1); }
  }
  return null;
}

/** 模型给的东西不一定干净：围栏、前导解释、复读、单引号。能救的就救，救不了就丢。 */
export function parseFacts(raw) {
  const obj = firstJsonObject(raw);
  if (!obj) return [];
  let j;
  try { j = JSON.parse(obj); } catch { return []; }
  const list = Array.isArray(j?.facts) ? j.facts : (Array.isArray(j) ? j : []);
  return list;
}

/** 一条事实的形状检查。"看起来像读数"的一律不要 —— 它比空记忆更坏。 */
export function cleanFact(f) {
  if (!f || typeof f !== 'object') return null;
  let text = String(f.text || '').replace(/^["'「](.*)["'」]$/, '$1').replace(/\s+/g, ' ').trim();
  if (text.length < 5 || text.length > 60) return null;
  /* 纯读数：「内存是 41%」「n8n 内存 2.3% · CPU 5.5%」。这类东西每轮都变，
     记下来只会污染回忆 —— 而且它看起来"很事实"，最容易被当真。
     判据不看开头，看**整句**：带百分比且没有任何"会持续下去"的动作/偏好词，就是读数。 */
  const pct = (text.match(/\d+(\.\d+)?\s*%/g) || []).length;
  /* 动作词用双字，不用单字："占用"里的"用"会让读数过关（踩过）。
     这张表和 persona.mjs 的 DURABLE 必须一致 —— 同一句话在记忆侧收进来、
     在人格侧又说成"我做过的事"，两边判据不一样时就是这么分裂的。 */
  const durable = /(挪|删除|装了|装好|装上|换成|写到|写了|保存|重启|调整|调到|调成|调过|配置|关闭|打开|创建|移动|加了|加进|放到|放回|设成|设为|改到|改成|要求|喜欢|不希望|不想|需要|应该|不要|记得|提醒)/.test(text);
  if (pct && !durable) return null;
  /* 抽取失败的残渣。实测 7B 会把「我做了 → 工具返回」这种自己的旁白当成一条事实交上来，
     而且形状检查全都通过（长度够、没有百分比）。它比空记忆更坏：
     人格层会把它当"我做过的事"说出来，用户看到一句无意义的自述还带着编号。 */
  if (/→|\{"|工具返回|^\s*(我|助手|模型)(做了|试了|调用了|先看)/.test(text)) return null;
  const about = (Array.isArray(f.about) ? f.about : [])
    .map((x) => String(x || '').trim())
    .filter((x) => x.length >= 1 && x.length <= 20 && !GENERIC.has(norm(x)))
    .slice(0, 3);
  const kind = KINDS.has(String(f.kind)) ? String(f.kind) : 'fact';
  const v = Number(f.valence);
  return { text, about, kind, valence: Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0 };
}

/* ───────────────────────── 主体 ───────────────────────── */

/**
 * @param {object} o
 * @param {string} [o.dir]        记忆目录（默认 ~/Agent/memory，取不到就落在 agent/memory）
 * @param {(t:string)=>Promise<string>} [o.extractor] 传一段对话，返回模型原文
 */
export function createMemory(o = {}) {
  const enabled = o.enabled !== false && process.env.MEMORY !== '0';
  const custom = o.dir || process.env.MEMORY_DIR || '';
  const storeMode = String(o.store || process.env.MEMORY_STORE || 'auto').toLowerCase();
  let dir = '';
  let g = null;
  let storeKind = '';
  let extractor = o.extractor || null;
  let turnsSince = 0;
  let queue = Promise.resolve();
  let snapChain = Promise.resolve();
  let pending = 0;

  /* 落盘位置：优先用用户在 Files 里看得见的 ~/Agent/memory（文档 §6.6），
     挂载不可用时退回 agent/memory。两种都能跑，区别只是"能不能直接翻"。
     PVC 名字带随机后缀，所以认前缀而不是记整串。 */
  async function resolveDir() {
    if (custom) return custom;
    const root = process.env.FS_ROOT;
    if (root) {
      try {
        const ents = await fs.readdir(root, { withFileTypes: true });
        const pvc = ents.find((e) => e.isDirectory() && e.name.startsWith('pvc-userspace-'));
        if (pvc) {
          const home = path.join(root, pvc.name, 'Home');
          await fs.access(home);
          return path.join(home, 'Agent', 'memory');
        }
      } catch { /* 没挂载就退回本地目录 */ }
    }
    return path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory');
  }

  /**
   * 选存储。默认 auto：先连 axolotl 侧车，连不上退回 SQLite。
   *
   * 这个降级是故意的：侧车崩了，用户该失去的是"记忆"，不是"桌面"。
   * 但显式写了 MEMORY_STORE=axolotl 时就不许降级 —— 那种情况下静默退回
   * 才是最坏的：你以为在调真图库，其实在调备胎，两边行为不一样，查一天。
   */
  async function openStore() {
    if (storeMode !== 'sqlite') {
      try {
        const { openAxolotl } = await import('./sources/graph.axolotl.mjs');
        const s = await openAxolotl({});
        storeKind = 'axolotl';
        return s;
      } catch (e) {
        if (storeMode === 'axolotl') throw new Error(`axolotl 侧车不可用：${e.message}`);
        console.warn('[memory] axolotl 侧车不可用，退回 SQLite：' + e.message);
      }
    }
    storeKind = 'sqlite';
    return openGraph(path.join(dir, 'memory.db'));
  }

  async function start() {
    if (!enabled) { console.log('[memory] 已关闭（MEMORY=0）'); return false; }
    dir = await resolveDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'snapshots'), { recursive: true });
    try {
      g = await openStore();
    } catch (e) {
      /* 显式要求 axolotl 时失败就**不要**退回 SQLite：两份库同时活着等于
         记忆分叉，之后"它怎么忘了刚才那句"会查到你怀疑人生。宁可这一轮没记忆。 */
      if (storeMode === 'axolotl') {
        console.error('[memory] axolotl 侧车不可用，记忆停用（桌面照常）：' + e.message);
        return false;
      }
      /* 库坏了：按 SQLite 重开一个，别让整台桌面跟着罢工 */
      console.warn('[memory] 打不开记忆库，改用 SQLite：' + e.message);
      storeKind = 'sqlite';
      try {
        await fs.rename(path.join(dir, 'memory.db'), path.join(dir, `memory.broken-${Date.now()}.db`));
      } catch { /* 没文件 */ }
      g = openGraph(path.join(dir, 'memory.db'));
    }
    const s0 = await stats();
    console.log(`[memory] ${storeKind} · ${dir} · ${s0.facts} 条记忆 / ${s0.entities} 个实体 / ${s0.communities} 个社群`);
    /* 上次巩固太久以前（比如关机三天）就补一次，但别挡启动 */
    const last = Number((await g.meta.get('lastSweep')) || 0);
    if (s0.facts && Date.now() - last > SWEEP_EVERY) {
      setTimeout(() => { consolidate().catch((e) => console.warn('[memory] 启动巩固失败：' + e.message)); }, 4000);
    }
    return true;
  }

  const ok = () => !!(enabled && g);
  const nowTs = () => Date.now();

  /* ── 五信号打分 ──
   * 这五样不是拍脑袋的：valence 决定"这件事重不重要"，freq 决定"说了几次"，
   * recency 决定"还新鲜吗"，access 决定"用过没有"，centrality 决定"它在图的中心吗"。
   * 剪枝只看分数，不看时间单独一项 —— 一句话被反复提起，就算很老也该留。 */
  function score(n, terms, deg, ts) {
    const hay = norm(n.label);
    let hit = 0;
    for (const t of terms) if (hay.includes(t)) hit += Math.min(3, t.length / 2);
    const days = Math.max(0, (ts - n.lastTs) / DAY);
    const recency = Math.exp(-days / 21);
    const freq = Math.min(1, Math.log1p(n.freq) / Math.log(6));
    const access = Math.min(1, Math.log1p(n.access) / Math.log(8));
    const central = Math.min(1, (deg.get(n.id) || 0) / 6);
    return hit + 0.7 * recency + 0.35 * freq + 0.25 * access + 0.2 * central + 0.2 * Math.abs(n.valence);
  }

  /** 定向回忆：先按这句话打分，再沿 about 边走一跳（"同一个东西的其它记忆"）。 */
  async function recall(query, k = 5) {
    if (!ok()) return { facts: [], entities: [], total: 0 };
    const ts = nowTs();
    const terms = termsOf(query);
    const deg = await g.degreeMap();
    const facts = await g.nodes('fact');
    const base = new Map(facts.map((f) => [f.id, f]));

    const seed = facts
      .map((f) => ({ f, s: score(f, terms, deg, ts) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(4, k * 2));

    /* 一跳扩散。没有这一步，"n8n 端口是多少"只能命中字面提到 n8n 的那条；
       而人回答这类问题靠的是"关于 n8n 我还知道什么"。 */
    const ids = new Set(seed.map((x) => x.f.id));
    const ents = new Map();
    for (const e of await g.edges([...ids])) {
      if (e.type !== 'about') continue;
      if (ids.has(e.src)) {
        const n = await g.getNode(e.dst);
        if (n && n.kind === 'entity') ents.set(n.id, n);
      }
    }
    const extra = [];
    if (ents.size) {
      for (const e of await g.edges([...ents.keys()])) {
        if (e.type !== 'about' || ids.has(e.src)) continue;
        const f = base.get(e.src);
        if (f) extra.push({ f, s: score(f, terms, deg, ts) * 0.45 });
      }
    }

    const ranked = [...seed, ...extra].sort((a, b) => b.s - a.s).slice(0, k);
    /* 只把真正有命中的留下：没有命中的"最近的一条"在"这个问题"上就是噪音。
       唯一的例外是查询本身没给出任何词（比如"你记得什么"），那时按新鲜度排。 */
    const picked = terms.length ? ranked.filter((x) => x.s > 0.55) : ranked;
    const out = [];
    for (const { f, s } of picked) {
      const about = [];
      for (const e of await g.edges([f.id])) {
        if (e.type === 'about' && e.src === f.id) {
          const n = await g.getNode(e.dst);
          if (n) about.push(n.props?.display || n.label);
        }
      }
      /* 老账本里的脏数据也要挡：以前版本进过库的读数（"n8n 占用 60% 内存"）、
         抽取残渣，现在还会被 recall 命中。不在这里再筛一遍，
         它们会一直出现在"你记得的事"里，而用户看到的是一句过期的读数。 */
      if (!cleanFact({ text: f.label, about: [], kind: f.props?.kind })) continue;
      out.push({ id: f.id, text: f.label, kind: f.props?.kind || 'fact', when: whenText(f.lastTs), about, score: +s.toFixed(2) });
    }
    for (const r of out) await g.touch(r.id);
    return { facts: out, entities: [...ents.values()].map((n) => n.props?.display || n.label), total: out.length };
  }

  /** 最近发生的事。用户问"昨天我让你做了什么"时，命中靠的不是关键词而是时间。 */
  async function recent(n = 4) {
    if (!ok()) return [];
    return (await g.nodes('fact', n)).map((f) => ({
      id: f.id, text: f.label, kind: f.props?.kind || 'fact', when: whenText(f.lastTs), about: [], score: 0,
    }));
  }

  async function digest() {
    if (!ok()) return '';
    const s = await stats();
    if (!s.facts) return '';
    const themes = s.themes.slice(0, 4).map((t) => `${t.label}（${t.n}）`).join('、');
    return `你已经有 ${s.facts} 条长期记忆，${s.entities} 个实体${themes ? `，主要在：${themes}` : ''}。`
      + (s.communities ? `其中 ${s.communities} 个主题已经合并成摘要。` : '');
  }

  /**
   * 每轮开始时拼给模型看的那一段。它是临时的：只加在这一轮的请求里，
   * 不写进会话历史 —— 否则历史会越来越长，而且下次回忆到的东西永远停在第一次那份。
   */
  async function context(query = '') {
    if (!ok()) return { text: '', hits: [] };
    const q = String(query || '');
    const lines = [];
    const d = await digest();
    if (!d) return { text: '', hits: [] };
    lines.push('## 你记得的事');
    lines.push('（长期记忆，来自以前的会话。数字会过时：跟这一轮工具读到的不一致时，以工具为准。）');

    let hits = q ? (await recall(q, 5)).facts : [];
    /* 时间问句：关键词命中不了"昨天"，但用户要的就是"昨天"。 */
    if (!hits.length && /(昨天|前天|上次|之前|以前|最近|这几天|记得|做过|说过|聊过)/.test(q)) {
      hits = await recent(4);
    }
    for (const h of hits) {
      lines.push(`- ${h.when} · ${h.text}${h.about.length ? `（${h.about.join('、')}）` : ''}`);
    }
    lines.push(d);
    /* 命中列表一起给出去：模型没说话时，服务端要能用同一批记忆兜底铺一屏，
       而不是再查一次（再查会重复累加 access，回忆的信号就被污染了）。 */
    return { text: lines.join('\n'), hits };
  }

  /* ── 写 ── */

  /** 实体节点：按标签查，没有就建。display 保留原始大小写，label 归一化后当键。 */
  async function ensureEntity(label, ts) {
    return (await g.nodeByLabel('entity', label)) || (await g.upsertNode({
      id: entityId(label), kind: 'entity', label: norm(label), props: { display: label }, ts,
    }));
  }

  async function linkEntity(factNode, label, ts) {
    const e = await ensureEntity(label, ts);
    await g.upsertEdge({ src: factNode.id, dst: e.id, type: 'about', ts });
  }

  /** 一条事实落图：精确去重（id 由文本决定）+ 近似去重（2-gram Jaccard）。 */
  async function remember(fact, src, ts = nowTs()) {
    const text = fact.text;
    let target = factId(text);
    let prev = await g.getNode(target);

    if (!prev) {
      /* 近似去重：同一个意思换个说法，不该在回忆里出现两遍。
         只跟最近 300 条比 —— 覆盖全量是 O(n²)，而这个量级上没有必要精确。 */
      const g1 = grams(text);
      const cand = await g.nodes('fact', 300);
      let best = null;
      let bestJ = 0;
      for (const c of cand) {
        const j = jaccard(g1, grams(c.label));
        if (j > bestJ) { bestJ = j; best = c; }
      }
      if (best && bestJ >= 0.75) { target = best.id; prev = best; }
    }

    const node = await g.upsertNode({
      id: target, kind: 'fact', label: text,
      props: { kind: fact.kind, about: fact.about }, valence: fact.valence, src, ts,
    });

    for (const label of [...fact.about, ...partsOf(text).filter((p) => !fact.about.includes(p))]) {
      await linkEntity(node, label, ts);
    }
    return { node, reinforced: !!prev };
  }

  /** 一轮结束：把这段对话交给模型抽几条事实。后台跑，不挡下一轮。 */
  function afterTurn(t) {
    if (!ok() || !extractor) return Promise.resolve(0);
    const text = buildTranscript(t);
    if (!text) return Promise.resolve(0);
    const key = `t:${t.sid}:${t.turn}`;

    pending++;
    const job = queue.then(async () => {
      if (await g.meta.get(key)) return 0;   // 同一轮只抽一次（重启/重放都安全）
      const raw = await extractor(text);
      const facts = parseFacts(raw).map(cleanFact).filter(Boolean).slice(0, 3);
      if (!facts.length) { await g.meta.set(key, { at: nowTs(), facts: 0 }); return 0; }
      const src = `${t.sid}#${t.turn}`;
      const ts = nowTs();
      let n = 0;
      for (const f of facts) { await remember(f, src, ts); n++; }
      await g.meta.set(key, { at: ts, facts: n });
      turnsSince += 1;
      const last = Number((await g.meta.get('lastSweep')) || 0);
      if (turnsSince >= CONSOLIDATE_EVERY || ts - last > SWEEP_EVERY) await consolidate();
      return n;
    }).catch((e) => {
      /* 记忆坏了不能连累对话：抽错了就是这一轮没记住，下一轮照常 */
      console.warn('[memory] 抽取失败：' + e.message);
      return 0;
    }).finally(() => { pending--; });

    queue = job.then(() => {}, () => {});
    return job;
  }

  /** 巩固：打分 → 剪枝 → 社群合并 → 快照。所有数字都写进 meta，memory_stats 读它。 */
  async function consolidate() {
    if (!ok()) return null;
    const ts = nowTs();
    await g.sweepEdges();
    const deg = await g.degreeMap();
    const facts = await g.nodes('fact');
    const ents = await g.nodes('entity');
    const factById = new Map(facts.map((f) => [f.id, f]));

    await g.setWeights([...facts, ...ents].map((n) => ({ id: n.id, weight: +score(n, [], deg, ts).toFixed(3) })));

    /* 剪枝的判据要同时满足四条。只看分数会剪掉"很久以前但很重要"的事，
       只看时间会剪掉"三个月前但每周都提"的事。 */
    const doomed = facts.filter((f) => {
      const days = (ts - f.lastTs) / DAY;
      const w = score(f, [], deg, ts);
      return days > 21 && f.access === 0 && f.freq <= 1 && w < 0.32;
    });
    /* 图太大时按分数兜底：超过上限的部分从最弱的开始剪，保证回忆不会被拖慢 */
    const alive = facts.length - doomed.length;
    if (alive > KEEP_MAX) {
      const dead = new Set(doomed.map((f) => f.id));
      const rest = facts.filter((f) => !dead.has(f.id)).sort((a, b) => a.weight - b.weight);
      doomed.push(...rest.slice(0, alive - KEEP_MAX));
    }
    if (doomed.length) await g.softDelete(doomed.map((f) => f.id));

    /* ── 社群合并 ──
     * 两个实体在同一条记忆里一起出现过，就连一条边；反复一起出现（≥2 次）才成团。
     * 门槛设 2 是有意的：一次同框是巧合（"n8n 和 Downloads 都提到了"），
     * 两次同框才是一个人的真实关注点。
     * 团够大（≥4 个事实）就塌缩成一个摘要节点 —— 回忆时先给摘要，细节还留在下面。 */
    const entById = new Map(ents.map((e) => [e.id, e]));
    const pair = new Map();
    const factsOf = new Map();      // 实体 → 提到它的事实
    const aboutOf = new Map();      // 事实 → 它提到的实体
    for (const e of await g.edges()) {
      if (e.type !== 'about') continue;
      if (!aboutOf.has(e.src)) aboutOf.set(e.src, new Set());
      aboutOf.get(e.src).add(e.dst);
    }
    /* 补边。老事实（抽取提示词还不要求多实体时写下的）只有主语，
       巩固顺手把它们和提到的部件接上。幂等：已经有这条边就不动。 */
    let relinked = 0;
    for (const f of facts) {
      const have = aboutOf.get(f.id) || new Set();
      for (const label of partsOf(f.label)) {
        const e = await g.nodeByLabel('entity', label);
        if (e && have.has(e.id)) continue;
        const ent = e || await ensureEntity(label, ts);
        await g.upsertEdge({ src: f.id, dst: ent.id, type: 'about', ts });
        have.add(ent.id);
        entById.set(ent.id, ent);
        relinked++;
      }
      aboutOf.set(f.id, have);
    }
    for (const [fid, set] of aboutOf) {
      for (const eid of set) {
        if (!entById.has(eid)) continue;
        if (!factsOf.has(eid)) factsOf.set(eid, []);
        factsOf.get(eid).push(fid);
      }
    }
    for (const f of facts) {
      const es = [...(aboutOf.get(f.id) || [])];
      for (let i = 0; i < es.length; i++) {
        for (let j = i + 1; j < es.length; j++) {
          const k = es[i] < es[j] ? `${es[i]}|${es[j]}` : `${es[j]}|${es[i]}`;
          pair.set(k, (pair.get(k) || 0) + 1);
        }
      }
    }
    /* 并查集：只连 weight ≥ 2 的对 */
    const parent = new Map([...entById.keys()].map((id) => [id, id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const [k, w] of pair) {
      if (w < 2) continue;
      const [a, b] = k.split('|');
      if (!parent.has(a) || !parent.has(b)) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }
    const groups = new Map();
    for (const id of entById.keys()) {
      const r = find(id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(id);
    }

    const madeIds = new Set();
    const memberOf = [];
    let covered = 0;
    for (const [, ids] of groups) {
      if (ids.length < 2) continue;
      const fs = new Set();
      for (const id of ids) for (const f of (factsOf.get(id) || [])) fs.add(f);
      if (fs.size < 4) continue;             // 太小了不合并，合并只是多一层转述
      const labels = ids.map((id) => entById.get(id).props?.display || entById.get(id).label);
      const cid = 'c:' + sha([...ids].sort().join('|'));
      const members = [...fs].sort();
      const top = members
        .map((id) => factById.get(id))
        .filter(Boolean)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3);
      await g.putNode({
        id: cid, kind: 'community',
        label: `关于 ${labels.slice(0, 2).join('、')} 的记忆`,
        props: { entities: labels, members, sample: top.map((f) => f.label) },
        weight: 0.5 + Math.min(0.5, members.length / 20),
        ts,
      });
      for (const id of members) memberOf.push({ id, community: cid });
      madeIds.add(cid);
      covered += members.length;
    }
    if (memberOf.length) await g.setCommunities(memberOf);
    /* 团散了，摘要也得跟着散 —— 不然用户会看到"关于 A、B 的记忆"，
       点开里面全是早就不相关的东西。 */
    const stale = (await g.nodes('community')).filter((c) => !madeIds.has(c.id)).map((c) => c.id);
    if (stale.length) await g.softDelete(stale);

    const finalStats = await g.stats();
    const report = {
      at: ts, pruned: doomed.length, communities: madeIds.size, covered, relinked,
      facts: finalStats.facts, edges: finalStats.edges,
    };
    await g.meta.set('lastSweep', ts);
    await g.meta.set('lastReport', report);
    turnsSince = 0;
    snapshot().catch(() => {});
    console.log(`[memory] 巩固：剪掉 ${report.pruned} 条，${report.communities} 个社群覆盖 ${report.covered} 条`);
    return report;
  }

  async function doSnapshot() {
    if (!ok()) return null;
    const dirS = path.join(dir, 'snapshots');
    await fs.mkdir(dirS, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      + `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    /* 同一秒拍两张是真实会发生的（启动补一次 + 刚好攒够轮次），加序号别把自己绊倒。 */
    const ext = storeKind === 'axolotl' ? '.axeb' : '.db';
    let target = path.join(dirS, `${stamp}${ext}`);
    for (let i = 1; ; i++) {
      try { await fs.access(target); } catch { break; }
      target = path.join(dirS, `${stamp}-${i}${ext}`);
    }
    await g.snapshot(target);
    const files = (await fs.readdir(dirS)).filter((f) => f.endsWith(ext)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - SNAPSHOTS))) {
      await fs.unlink(path.join(dirS, f)).catch(() => {});
    }
    return target;
  }

  /* 快照排队：巩固结束时后台拍一张，用户也可能正好手动拍一张。
     两个快照撞在同一个文件上会直接报错（实测），串行化最省事。 */
  function snapshot() {
    snapChain = snapChain.then(doSnapshot, doSnapshot);
    return snapChain;
  }

  /** 忘掉。软删，能捞回来 —— 用户说"忘掉这件事"时不该真的不可逆。 */
  async function forget(query) {
    if (!ok()) return { forgotten: [] };
    const hits = (await recall(query, 3)).facts.filter((f) => f.score >= 1);
    if (!hits.length) return { forgotten: [] };
    await g.softDelete(hits.map((h) => h.id));
    return { forgotten: hits.map((h) => h.text) };
  }

  async function stats() {
    if (!ok()) return { facts: 0, entities: 0, communities: 0, edges: 0, pruned: 0, themes: [], recent: [], last: null };
    const s = await g.stats();
    const counts = new Map();
    const cache = new Map();
    for (const e of await g.edges()) {
      if (e.type !== 'about') continue;
      let n = cache.get(e.dst);
      if (n === undefined) { n = await g.getNode(e.dst); cache.set(e.dst, n); }
      if (!n || n.kind !== 'entity') continue;
      const key = n.props?.display || n.label;
      const cur = counts.get(key) || { label: key, n: 0, last: 0 };
      cur.n += 1;
      cur.last = Math.max(cur.last, n.lastTs);
      counts.set(key, cur);
    }
    return {
      ...s,
      themes: [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 6)
        .map((t) => ({ label: t.label, n: t.n, last: whenText(t.last) })),
      recent: (await g.nodes('fact', 5)).map((f) => ({ text: f.label, when: whenText(f.lastTs) })),
      last: (await g.meta.get('lastReport')) || null,
      turns: turnsSince,
    };
  }

  /** 等后台抽取跑完。给测试和优雅停机用 —— 平时没人等它。 */
  async function drain() { await queue; }

  async function stop() {
    if (!g) return;
    try { await g.close(); } catch { /* 已经关了 */ }
  }

  return {
    start, stop, drain, enabled,
    get dir() { return dir; },
    get store() { return storeKind; },
    setExtractor(fn) { extractor = fn; },
    context, recall, recent, digest, stats, consolidate, remember, forget, afterTurn, snapshot,
    /** 只给调试端点用 */
    async debug(q) { return { store: storeKind, dir, stats: await stats(), recall: q ? await recall(q, 5) : null }; },
  };
}

/** 一轮的"可记忆摘要"。只挑有信息量的工具，屏幕/画/曲线不进 —— 那是表达，不是事实。 */
function buildTranscript(t) {
  const lines = [];
  const u = String(t.user || '').trim();
  if (u) lines.push(`用户说：${u.slice(0, 200)}`);
  const a = String(t.reply || '').trim();
  if (a) lines.push(`我说：${a.slice(0, 120)}`);
  const acts = (t.actions || []).filter((x) => x && !/^(scene_|surface_|draw|face|draw_stop)/.test(x.name));
  if (acts.length) {
    lines.push('我做了：' + acts.slice(0, 6).map((x) => `${x.name}(${String(x.brief || '').slice(0, 60)})${x.note ? ` → ${String(x.note).slice(0, 60)}` : ''}`).join('；'));
  }
  /* 太短的一轮不值得花一次模型调用：一句"嗯"抽不出事实，只会抽出一句废话。 */
  const chars = lines.join('').length;
  if (chars < 12) return '';
  return lines.join('\n').slice(0, 1200);
}
