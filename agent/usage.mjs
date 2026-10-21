/**
 * token 账本。
 *
 * 为什么单独一个文件：token 有三个身份 —— **钱**（这一轮花了多少）、
 * **能力**（上下文还剩多少）、**过程**（每一步的输入输出是多少）。
 * 三个都从同一份 `usage` 来，分摊在各个调用点必然对不上账。
 *
 * 两条硬规矩，都是被"看起来正常"坑过之后立的：
 *
 * 1. **没有单价就不算钱。** 查不到的模型显示"单价未配置"，绝不拿 0 顶替 ——
 *    屏幕上写着 ¥0.0000 和真的免费是两件事，前者会让人放心地跑一整天。
 * 2. **估算值必须自己承认是估算。** mock / 本地桩 / 个别服务端不回 usage，
 *    这时候只能按字数推；推出来的数不能和账单上的数长得一样。
 *
 * 还有一个容易漏的：**`prompt_tokens` 就是当前上下文大小**。
 * 每次请求都把 system + 记忆注入 + 全部历史重新发一遍，所以最后一次
 * 调用的 prompt_tokens 恰好是"现在这个会话占了多少窗口"——
 * 不用自己累加，累加反而会因为重试、裁剪、注入而算错。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ───────────────────────── 上限与价格 ───────────────────────── */

/* 上下文窗口。**这张表是给人看的**，值要能被推翻：
   写错一个数会让水位百分比全错，而百分比正是"该不该裁历史"的唯一依据。
   只收本机真用过 / 确定过的；查不到就落 DEFAULT 并且**标出来是缺省值**。 */
const CTX_TABLE = [
  [/qwen2\.5|qwen-2\.5/i, 32768],
  [/qwen3/i, 40960],
  [/deepseek/i, 65536],
  [/glm-4/i, 131072],
  [/kimi|moonshot/i, 131072],
  [/gpt-4o|gpt-4\.1/i, 128000],
];
const DEFAULT_CTX = 32768;

/* 单价（¥ / 百万 token）。**只放确实为 0 的**。
   收费模型的价格会变，写死在代码里迟早过期，所以走环境变量：
   `MODEL_PRICE_IN` / `MODEL_PRICE_OUT`（元/百万 token，两个一起给才生效）。 */
const FREE_TABLE = [
  /Qwen\/Qwen2\.5-7B-Instruct/i,
];

function ctxLimitOf(model) {
  const env = Number(process.env.MODEL_CTX || 0);
  if (env > 0) return { limit: env, src: 'env' };
  for (const [re, n] of CTX_TABLE) if (re.test(model)) return { limit: n, src: 'table' };
  return { limit: DEFAULT_CTX, src: 'default' };
}

function priceOf(model) {
  /* 假模型不花钱是**事实**，不是"不知道" —— 它连网都没连。 */
  if (/^mock/i.test(model)) return { in: 0, out: 0, src: 'mock', free: true };
  const pin = Number(process.env.MODEL_PRICE_IN || NaN);
  const pout = Number(process.env.MODEL_PRICE_OUT || NaN);
  if (Number.isFinite(pin) && Number.isFinite(pout)) {
    return { in: pin, out: pout, src: 'env', free: pin === 0 && pout === 0 };
  }
  for (const re of FREE_TABLE) if (re.test(model)) return { in: 0, out: 0, src: 'table', free: true };
  return null;   // 不知道就说不知道
}

/* ───────────────────────── 估算 ───────────────────────── */

/** 没有 usage 时的兜底：CJK 一字一 token，其余四字符一 token。
 *  这不是精确值，是"量级对得上"——中文按 4 字符算会低估 3 倍。 */
export function estTokens(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/** 把 OpenAI 形状的 usage 洗干净。不同服务端的字段名不一样，别在调用点各判一次。 */
export function normUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const p = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const c = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!p && !c) return null;
  const cached = Number(
    u.prompt_tokens_details?.cached_tokens
    ?? u.prompt_cache_hit_tokens
    ?? u.cached_tokens
    ?? 0,
  );
  return { prompt: p, completion: c, cached: Number.isFinite(cached) ? cached : 0, est: false };
}

/* ───────────────────────── 账本 ───────────────────────── */

const blankTurn = () => ({ calls: 0, in: 0, out: 0, cached: 0, ms: 0, est: false });

/* 本地时间，不是 UTC。用户看"今天花了多少"用的是自己的今天。 */
export function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function createMeter(o = {}) {
  const model = o.model || process.env.MODEL || 'unknown';
  const { limit, src: limitSrc } = ctxLimitOf(model);
  const price = priceOf(model);
  const dayCap = Number(process.env.TOKEN_DAY_CAP || 0);   // 0 = 不限
  const dir = o.dir || '';

  let turn = blankTurn();
  const sess = { in: 0, out: 0, cached: 0, calls: 0, turns: 0, est: false, since: Date.now() };
  let ctx = 0;          // 最后一次 prompt_tokens = 当前上下文
  let msgs = 0;         // 历史消息条数（用户能理解的"多长"）
  let parts = null;     // 上下文的构成（系统提示 / 工具表 / 历史），估算后按真实总数缩放
  let lastMs = 0;
  const recent = [];    // 最近几轮的明细，给前端/接口看
  const day = { date: ymd(), in: 0, out: 0, calls: 0, turns: 0, est: false };

  /* 日账本跨会话累计：重启一次就把"今天"清零，那这个数就没用了。 */
  if (dir) {
    try {
      const raw = await fs.readFile(path.join(dir, `${day.date}.json`), 'utf8');
      const j = JSON.parse(raw);
      Object.assign(day, { in: +j.in || 0, out: +j.out || 0, calls: +j.calls || 0, turns: +j.turns || 0 });
    } catch { /* 今天还没记过 */ }
  }

  const money = (tin, tout) => {
    if (!price) return null;
    return +(tin / 1e6 * price.in + tout / 1e6 * price.out).toFixed(6);
  };

  function snap() {
    const used = ctx || (turn.in || sess.in);
    return {
      model,
      limit,
      limitSrc,
      price,
      ctx: {
        tokens: used,
        pct: limit ? +((used / limit) * 100).toFixed(1) : 0,
        msgs,
        /* 光说"用了 12k"不够 —— 12k 里 9k 是系统提示词，那么"裁历史"就白裁。
           三个部分按估算比例分摊到**真实**总数上，所以比例是准的、绝对值是估的。 */
        parts,
      },
      turn: { ...turn, cost: money(turn.in, turn.out) },
      session: {
        ...sess,
        cost: money(sess.in, sess.out),
        mins: Math.max(1, Math.round((Date.now() - sess.since) / 60000)),
      },
      day: { ...day, cost: money(day.in, day.out), cap: dayCap || null },
      cap: dayCap ? { limit: dayCap, used: day.in + day.out, over: day.in + day.out >= dayCap } : null,
      lastMs,
    };
  }

  async function flush() {
    if (!dir) return;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${day.date}.json`), JSON.stringify(day));
    } catch { /* 记账失败不该影响对话 */ }
  }

  return {
    snap,
    /** 从落盘快照恢复**会话级**累计。日账本不在这里恢复 —— 它自己会读当天的文件，
        两边都写会双计。 */
    restore(snap) {
      if (!snap) return;
      const c = snap.ctx || {};
      if (c.tokens) ctx = c.tokens;
      if (c.msgs) msgs = c.msgs;
      if (c.parts) parts = c.parts;
      const z = snap.session || {};
      sess.in = +z.in || 0;
      sess.out = +z.out || 0;
      sess.cached = +z.cached || 0;
      sess.calls = +z.calls || 0;
      sess.turns = +z.turns || 0;
      sess.est = !!z.est;
      if (z.since) sess.since = z.since;
    },
    /** 记一次模型调用。`x.msgs` 是当前历史条数，用来解释"上下文有多长"。 */
    add(u, x = {}) {
      const n = u && !u.est
        ? u
        : (u || { prompt: estTokens(x.promptText || ''), completion: estTokens(x.completionText || '') });
      const est = !!n.est || !u;
      turn.calls++;
      turn.in += n.prompt || 0;
      turn.out += n.completion || 0;
      turn.cached += n.cached || 0;
      turn.ms += x.ms || 0;
      turn.est = turn.est || est;

      sess.calls++;
      sess.in += n.prompt || 0;
      sess.out += n.completion || 0;
      sess.cached += n.cached || 0;
      sess.est = sess.est || est;

      day.calls++;
      day.in += n.prompt || 0;
      day.out += n.completion || 0;
      day.est = day.est || est;

      if (n.prompt) ctx = n.prompt;   // 真实值才拿来当上下文水位
      if (x.msgs) msgs = x.msgs;
      if (x.ms) lastMs = x.ms;
      /* 构成：先按字数算三份，再按比例缩放到真实 prompt 总数。
         直接显示估算的绝对值会出现"三份加起来 15k，总数写着 12k" —— 那比不给更糟。 */
      if (x.parts) {
        const p = x.parts;
        const tot = (p.sys || 0) + (p.tools || 0) + (p.hist || 0);
        const real = n.prompt || tot;
        const k = tot ? real / tot : 0;
        parts = {
          sys: Math.round((p.sys || 0) * k),
          tools: Math.round((p.tools || 0) * k),
          hist: Math.round((p.hist || 0) * k),
        };
      }
      return snap();
    },
    beginTurn() { turn = blankTurn(); },
    async endTurn() {
      sess.turns++;
      day.turns++;
      recent.push({ at: Date.now(), ...turn, cost: money(turn.in, turn.out) });
      if (recent.length > 20) recent.splice(0, recent.length - 20);
      await flush();
      return snap();
    },
    history: () => recent.slice(),
    /** 预算闸：超了要能**挡住下一轮**，而不是等账单来了才发现。 */
    overBudget() {
      if (!dayCap) return false;
      return day.in + day.out >= dayCap;
    },
  };
}
