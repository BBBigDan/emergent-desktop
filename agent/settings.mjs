/**
 * 设置 —— 用户在屏幕上能改的那几件事。
 *
 * 它存在的理由很具体：**能换的模型、能改的提示词，都不该只能改 .env 再重启。**
 * 上一轮把"换模型"放出来了（`models.mjs` + `modelpick.js`），但那只覆盖了
 * "已经写死在表里的那些"。用户手里可能有一个自己的中转站、一个公司内网的
 * OpenAI 兼容端点、或者只是想让它说话换个语气 —— 那两类东西都必须能从他手里进去。
 *
 * 三块，边界很清楚：
 *
 *   ① `providers` —— 额外的接口地址（新的 API 端点）。每条给一组模型名，
 *      进模型表的第三组「自定义」。**不探测能力**：那是别人的服务，
 *      我们唯一诚实的说法是"没测过"（想/工 两列写 `?`），而不是按名字猜。
 *   ② `prompt` —— 系统提示词。默认是**追加**：内置那套（场的说明书、工具怎么调、
 *      上限多少）一个字不动，只在末尾加用户的要求。另有一个"整段替换"的口子，
 *      因为有人确实想从零写；但它默认关着，且界面上写清代价。
 *   ③ `behavior` —— 温度和每轮步数。前者改"怎么说话"；后者**默认 0 = 不限**，
 *      只有用户自己想省钱时才设个数（以前它是"安全网"，默认 10 —— 那会把
 *      正常的长任务掐在半路，看起来像模型不行）。
 *
 * 落盘位置由 `SETTINGS_FILE` 决定（集群里挂到 state 目录，见 deploy 的 yaml）——
 * 它必须**跟着数据走、不跟着镜像走**，否则换个 tag 用户配的接口就没了。
 *
 * key 的处理有一条硬规矩：**GET 不返回明文。** 面板里显示的是 `…abcd`，
 * 编辑时留空表示"不改"。这不是防谁，是因为这块面板可能被投到屏幕上、
 * 被截图、被人从旁边看一眼 —— 而一个 key 泄露的代价和一句提示词完全不是一回事。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/** 存在哪。默认 `agent/config/settings.json`；集群里指向 state 挂载点。 */
export const settingsFile = () =>
  path.resolve(process.env.SETTINGS_FILE || path.join(HERE, 'config', 'settings.json'));

/* 上限是防手滑，不是产品限制：一个人不会配 13 个中转站，但复制粘贴出错时
   可能一下贴进去一整个 JSON。 */
const MAX_PROVIDERS = 12;
const MAX_MODELS = 24;
const ID_RE = /^p_[a-z0-9]{4,10}$/;

const DEFAULTS = () => ({
  providers: [],
  prompt: { append: '', replace: '' },
  /* `maxSteps` = 一轮最多几步，**0 = 不限，这是默认**。
     以前它的默认值是 10 —— 那时它还叫"安全网"。可长任务本来就要几十次工具调用，
     10 步会把正常的长活掐在半路（而且看起来像模型能力不行）。现在安全网换成
     "有没有进展 / 跑多久 / 上下文满没满"（见 server.mjs 的循环和 turnstop.mjs）。
     `v` 是语义版本：v2 起 0 表示不限，读旧文件时见 loadSettings 里的迁移。 */
  behavior: { v: 2, temp: 0.3, maxSteps: Number(process.env.MAX_STEPS || 0) },
});

let cur = DEFAULTS();
let loaded = false;

/* ───────────────────────── 校验与归一化 ───────────────────────── */

/**
 * 地址归一化。三种手滑都在这儿接住，因为它们的报错在界面上长得一模一样
 * （"连不上"），用户没法自己看出是哪一种：
 *
 *   · 结尾多个斜杠 → 去掉（拼 `/models` 时会变成 `//models`，有的网关 404）
 *   · 直接贴了 `…/chat/completions` → 剥到 `/v1`。这是最常见的一种：
 *     用户从别处的示例代码里复制了完整 URL。不剥的话每个请求会变成
 *     `…/chat/completions/chat/completions`。
 *   · 没写协议 → 补 `https://`。少了它 `fetch` 直接抛 "Failed to parse URL"。
 */
function normBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return { url: '', fix: null };
  let fix = null;
  if (!/^https?:\/\//i.test(s)) { s = `https://${s}`; fix = '补上了 https://'; }
  s = s.replace(/\/+$/, '');
  const m = /^(.*?)\/chat\/completions$/i.exec(s);
  if (m) { s = m[1].replace(/\/+$/, ''); fix = '去掉了结尾的 /chat/completions'; }
  if (!/^https?:\/\/[^/\s]+/i.test(s)) return { url: '', fix: '这不是一个网址' };
  /* **只允许出现一次 `://`。** 粘贴两遍是这个框里最常见的错
     （`https://a/v1https://a/v1`），而 `new URL()` 会照单全收 ——
     它会把它解析成「host=a，path=/v1https://a/v1」，校验全绿、
     请求却发到一个不存在的路径上。挡在这里比事后从 404 倒推省事。 */
  const rest = s.slice(s.indexOf('://') + 3);
  if (rest.includes('://')) return { url: '', fix: '地址里有两次 https://（是不是粘了两遍）' };
  return { url: s, fix };
}

/** 给 server 的「测一下」用：把用户输的地址收拾成 baseURL。 */
export function normalizeBaseURL(raw) {
  return normBase(raw).url;
}

function normModels(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]/);
  const out = [];
  for (const x of arr) {
    const v = String(x || '').trim();
    /* 模型名里可以有 `/`（`openai/gpt-4o`），所以只去掉空白，不按斜杠切 */
    if (!v || v.length > 120) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** 一条接口的 id。存在就沿用（改名字不该让它变成另一条），不存在就发一个。 */
function providerId(raw, prevIds) {
  const s = String(raw || '');
  if (ID_RE.test(s) && prevIds.has(s)) return s;
  return `p_${crypto.randomBytes(4).toString('hex').slice(0, 6)}`;
}

/**
 * 把前端传来的 providers 归一化。
 *
 * `apiKey` 的三态（必须写清楚，否则"我明明没改，key 怎么没了"）：
 *   · 字段不存在 → **保留原值**（面板只显示 `…abcd`，没动就不该动）
 *   · 空字符串   → 清掉（本地服务不需要 key，这是合法的）
 *   · 非空字符串 → 换掉
 */
function normProviders(list, prev) {
  const src = Array.isArray(list) ? list.slice(0, MAX_PROVIDERS) : [];
  const byId = new Map((prev || []).map((p) => [p.id, p]));
  const prevIds = new Set(byId.keys());
  const out = [];
  const notes = [];
  for (const raw of src) {
    const name = String(raw?.name || '').trim().slice(0, 40);
    const { url: baseURL, fix } = normBase(raw?.baseURL);
    const models = normModels(raw?.models);
    /* 整条都是空的就**静默丢掉**：用户点「+ 加一个接口」看了一眼又不想填，
       保存时不该弹一句红字骂他。只有"填了一半"才值得说。 */
    if (!name && !String(raw?.baseURL || '').trim() && !models.length) continue;
    if (!baseURL) { notes.push(`${name || '一条接口'}：${fix || '地址不对'}，没保存`); continue; }
    if (!models.length) { notes.push(`${name || baseURL}：至少填一个模型名`); continue; }
    const id = providerId(raw?.id, prevIds);
    const old = byId.get(id);
    let apiKey;
    if (raw?.apiKey === undefined || raw?.apiKey === null) apiKey = old?.apiKey || '';
    else apiKey = String(raw.apiKey).trim();
    out.push({
      id,
      name: name || new URL(baseURL).host,
      baseURL,
      apiKey,
      models,
    });
    if (fix) notes.push(`${name || baseURL}：${fix}`);
  }
  return { providers: out, notes };
}

function normPrompt(p, prev) {
  const append = String(p?.append ?? prev.append ?? '').slice(0, 8000);
  /* 替换是危险操作，但**空字符串等于没写** —— 面板上把字删光不该让系统提示词
     变成空的（那会让模型连"你面前是片粒子场"都不知道）。所以空就退回内置。 */
  const replace = String(p?.replace ?? prev.replace ?? '').slice(0, 20000).trim();
  return { append, replace };
}

function normBehavior(b, prev) {
  const temp = Number(b?.temp);
  const steps = Number(b?.maxSteps);
  const n = Math.round(steps);
  return {
    /* 温度卡在 0~1.2。>1.2 的模型会开始胡说，而这不是"更有创意"，
       是"scene_show 的字段名写错"（实测过 8B 在 1.5 上）。 */
    temp: Number.isFinite(temp) ? Math.max(0, Math.min(1.2, +temp.toFixed(2))) : prev.temp,
    /* 步数 **0 = 不限（默认）**，显式限制时 3~200。
       1~2 会抬到 3：少于 3 步连"查一下再说"都走不完，
       那不是"省钱"，是"每一轮都半路死"。0 是另一件事 —— 它是"放开"。 */
    maxSteps: Number.isFinite(steps) ? (n <= 0 ? 0 : Math.max(3, Math.min(200, n))) : prev.maxSteps,
    v: 2,
  };
}

/* ───────────────────────── 读写 ───────────────────────── */

/** 读盘。文件不存在 / 坏了都退回默认值 —— 一份坏掉的设置不该让 agent 起不来。 */
export async function loadSettings(file = settingsFile()) {
  const base = DEFAULTS();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const j = JSON.parse(raw);
    const { providers } = normProviders(j?.providers, []);
    /* 旧文件（v1）里的 `maxSteps` 默认是 10，那时它的意思是"安全网"，
       不是用户的选择。上线后第一件事就是把它当成"用户设了 10 步"，
       结果长任务还是被掐 —— 这正是这次要拆掉的东西。
       所以没有 `v` 字段的文件一律按"不限"读；真有人想限制，面板上一拖就有。 */
    if (j?.behavior && typeof j.behavior === 'object' && j.behavior.v == null) j.behavior.maxSteps = 0;
    cur = {
      providers,
      prompt: normPrompt(j?.prompt, base.prompt),
      behavior: normBehavior(j?.behavior, base.behavior),
    };
  } catch {
    cur = base;
  }
  loaded = true;
  return cur;
}

/** 当前生效的设置（**含明文 key**，只给服务端自己用）。 */
export function getSettings() {
  if (!loaded) { loaded = true; }
  return cur;
}

export function behavior() {
  return getSettings().behavior;
}

export function customProviders() {
  return getSettings().providers;
}

/** 存一份（不落盘，只改内存）。校验失败抛错，调用方负责告诉用户。 */
export function applyPatch(patch = {}) {
  /* 只归一化**一次**。调两次的话，新条目的 id 会各生成一个（随机），
     而 notes 记的是那批没被采用的 id —— 排查"怎么多出来一条"时会被它带偏。 */
  const np = patch.providers === undefined ? null : normProviders(patch.providers, cur.providers);
  cur = {
    providers: np ? np.providers : cur.providers,
    prompt: normPrompt(patch.prompt, cur.prompt),
    behavior: normBehavior(patch.behavior, cur.behavior),
  };
  return { settings: cur, notes: np ? np.notes : [] };
}

export async function saveSettings(patch = {}, file = settingsFile()) {
  const { notes } = applyPatch(patch);
  await fs.mkdir(path.dirname(file), { recursive: true });
  /* 0600：这个文件里有 key。目录 0700 同理 —— 同机器上的其他用户不该看见。 */
  await fs.writeFile(file, JSON.stringify(cur, null, 2), { mode: 0o600 });
  return { settings: cur, notes };
}

/* ───────────────────────── 给界面的那一份 ───────────────────────── */

const tail = (k) => (k ? String(k).slice(-4) : '');

/**
 * 脱敏之后的样子。**没有 `apiKey` 这个字段** —— 不是不填，是根本不发。
 * 前端拿 `keyTail` 显示"已保存 …abcd"，拿 `hasKey` 决定要不要显示"清除"。
 */
export function publicSettings() {
  const s = getSettings();
  return {
    providers: s.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      models: p.models,
      hasKey: !!p.apiKey,
      keyTail: tail(p.apiKey),
    })),
    prompt: s.prompt,
    behavior: s.behavior,
    file: settingsFile(),
  };
}

/** 自测用：把内存里的设置清回默认。 */
export function _reset() {
  cur = DEFAULTS();
  loaded = false;
}
