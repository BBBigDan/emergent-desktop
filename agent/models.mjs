/**
 * 能换的模型 —— 点开屏幕上那个名字看到的那张表。
 *
 * 一张这样的表必须对每一行回答四件事。少一件，界面上就会出现一个
 * **看起来能用、其实不能用**的选项：
 *
 *   ① 会不会想（`reasoning_content`）—— 不会想，左上那栏「思考过程」就只剩动作，
 *      用户的原话是"感觉很奇怪"；
 *   ② 会不会调工具 —— 不会调，它连一屏都铺不出来（`scene_show` 就是一个工具），
 *      所以这种模型在表里**可看不可选**；
 *   ③ 多少钱 —— 不知道就写 `null`，界面写"单价未配置"。**绝不填 0**：
 *      "¥0.0000" 和"免费"在屏幕上长得一样，含义完全不同（这条踩过）；
 *   ④ 走哪个接口 —— 本地那几行不过网络，平台那几行要 key。
 *
 * 这些属性**都不靠名字猜**：
 *   · 平台那一列来自 README「换模型这件事」里的实测表（2026-10-23，
 *     `tools/dev/probe-think.mjs` 探的是"返回 reasoning_content 吗"和
 *     "工具调用靠得住吗"两件事，不是"能不能跑"）；
 *   · 本地那一列来自 Ollama 自己的 `/api/show` 返回的 `capabilities` ——
 *     那是模型自己声明的，比我们按名字猜可靠。
 *
 * 平台接口（`/v1/models`）**只给 id，不给上面任何一条**：所以这份表是手写的。
 * 反过来，它也用来做一次存在性核对 —— 平台下架了的模型不该还留在表里被人点。
 */

/* 默认模型：一个**会思考**的模型。
 *
 * 为什么不是 Qwen2.5-7B-Instruct（它便宜、免费、够老实）：它没有 reasoning 能力，
 * 返回里永远没有 `reasoning_content`，于是屏幕上那栏"思考过程"只有工具动作。
 *
 * 免费名单里**确实有**能思考的（实测），但都慢 3~10 倍、一轮想上千字，
 * 所以默认落在这个上面；想省钱就在界面上换，不用改代码。
 *
 * 这个常数**只写在这里**。`server.mjs` 抄过一份、`model.openai.mjs` 也有一份，
 * 结果换模型时改了一处漏了另一处，线上跑的还是旧的，日志里却打得像"改了没生效"。
 */
export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash';

const sfBase = () => (process.env.MODEL_BASE || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const sfKey = () => process.env.MODEL_KEY || '';
/* 本地推理服务的地址。任何 OpenAI 兼容实现的都行：默认值给的是 Ollama。
   `MODEL_LOCAL_BASE` 指过去之后，本地那一组会**自动发现**它装了哪些模型。 */
export const localBase = () => (process.env.MODEL_LOCAL_BASE || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const localKey = () => process.env.MODEL_LOCAL_KEY || 'ollama';   // 本地服务多半不校验 key，但适配器要求非空

/* ───────────────────────── 平台（硅基流动） ─────────────────────────
 *
 * 顺序就是界面上的顺序：默认那个在最前，然后按"能干活的程度"排。
 * `speed` 是**实测**的一步延迟，不是标称吞吐 —— 用户要判断的是"问一句要等多久"。
 * `note` 一句话说清它的毛病，因为参数表里看不出"回灌要 12 秒"这种事。
 */
const PLATFORM = [
  {
    id: DEFAULT_MODEL,
    think: true,
    tools: true,
    cost: 'paid',
    speed: '3~6s/步',
    tag: '默认',
    note: '会想、工具稳；按量计费，本机没配单价',
  },
  {
    id: 'Qwen/Qwen3-8B',
    think: true,
    tools: true,
    cost: 'free',
    speed: '8.5s/步',
    note: '免费里最像样的思考；首次调用可能要 90 秒冷启动',
  },
  {
    id: 'Qwen/Qwen2.5-7B-Instruct',
    think: false,
    tools: true,
    cost: 'free',
    speed: '0.9s/步',
    note: '最快最稳，但不会想 —— 那栏里只有动作',
  },
  {
    id: 'THUDM/GLM-Z1-9B-0414',
    think: true,
    tools: true,
    cost: 'free',
    speed: '2.7s/步',
    note: '会想；工具结果回灌那一步要 12 秒',
  },
  {
    id: 'THUDM/GLM-4-9B-0414',
    think: false,
    tools: true,
    cost: 'free',
    speed: '0.5s/步',
    note: '不会想，工具一次到位；测"提示词本身好不好"时的对照组',
  },
  {
    id: 'Qwen/Qwen3.5-9B',
    think: true,
    tools: true,
    cost: 'free',
    speed: '4.4s/步',
    note: '会想；时好时坏，有时只看一个指标就停',
  },
  {
    id: 'XingChenAGI/Xing4.0-29B',
    think: true,
    tools: true,
    cost: 'free',
    speed: '0.8s/步',
    note: '想得少（45 字），会重复调同一个工具',
  },
  {
    /* 这两条**故意留在表里**：它们不是"可选但不好"，是"根本不能跑 agent"。
       删掉的话，用户在别处听说 R1 免费又能想，只会觉得这张表漏了东西；
       留在表里并且写明原因，才是回答了那个问题。 */
    id: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
    think: true,
    tools: false,
    cost: 'free',
    speed: null,
    why: '不支持 function call（接口直接 400）',
    note: '会想，但 agent 用不了它',
  },
  {
    id: 'Qwen/Qwen3.5-4B',
    think: true,
    tools: false,
    cost: 'free',
    speed: null,
    why: '把工具调用写成 <tool_call> 文本，不产生真的调用',
    note: '会想，但工具调用是假的',
  },
];

/* ───────────────────── 自定义接口（设置页加的那些） ─────────────────────
 *
 * 这一组和上面两组都不一样：**能力不是我们测出来的，是"不知道"。**
 *
 * 用户从设置页填进来一个地址（自己的中转站、公司内网、某个兼容网关），
 * 我们只做一件事：把它列出来、把 id 翻译成"发到哪个 baseURL"。至于那个模型
 * 会不会想、会不会调工具 —— 没跑过就是没跑过，表里如实写 `?`。
 * 按名字猜的代价踩过：标着"会想"，结果那栏里一个字都没有。
 *
 * 表本身不读 `settings.mjs`（那是另一个方向），由 server 在启动和保存后注入。
 * 这样 `models.mjs` 仍然是"纯粹算一张表"的模块，自测不用起服务、不用碰磁盘。
 */
let CUSTOM = [];
export function setCustomProviders(list) {
  CUSTOM = Array.isArray(list) ? list : [];
}

/** 自定义接口的 id 形状：`x/<providerId>/<model 名>`。model 里可以有 `/`。 */
const X_PREFIX = 'x/';

function parseCustom(id) {
  const s = String(id || '');
  if (!s.startsWith(X_PREFIX)) return null;
  const rest = s.slice(X_PREFIX.length);
  const i = rest.indexOf('/');
  if (i < 0) return null;
  const pid = rest.slice(0, i);
  const model = rest.slice(i + 1);
  if (!pid || !model) return null;
  const p = CUSTOM.find((x) => x.id === pid);
  return p ? { p, model } : null;
}

/* 离线桩。它不是"本地模型"，但它是唯一**一定存在**的本地那个 ——
   没网、没 key、要复现一次协议问题时，它比任何真模型都可靠。 */
const MOCK = {
  id: 'mock',
  name: 'mock',
  org: '离线桩',
  think: true,
  tools: true,
  cost: 'free',
  speed: '0ms',
  note: '不联网的假模型：把工具循环跑起来，用来验协议',
};

/* ───────────────────────── 价格 ─────────────────────────
 *
 * 两条纪律（都踩过）：
 *   · 没有单价就不算钱 —— 返回 `null`，界面写"单价未配置"，**不填 0**；
 *   · 确定是 0 的才敢写 0。价格会变，所以数字只放在环境变量里：
 *     `MODEL_PRICE_IN` / `MODEL_PRICE_OUT`（元/百万 token，两个一起给才生效）。
 */
const priceFromEnv = () => {
  const pin = Number(process.env.MODEL_PRICE_IN || NaN);
  const pout = Number(process.env.MODEL_PRICE_OUT || NaN);
  if (!Number.isFinite(pin) || !Number.isFinite(pout)) return null;
  return { in: pin, out: pout, src: 'env', free: pin === 0 && pout === 0 };
};

export function priceOf(id) {
  const s = String(id || '');
  if (s === 'mock') return { in: 0, out: 0, src: 'mock', free: true };
  /* 本地：不花 API 的钱。这是**事实**（电费和硬件折旧不算在这本账里）。 */
  if (s.startsWith('local/')) return { in: 0, out: 0, src: 'local', free: true };
  const env = priceFromEnv();
  if (env) return env;
  const e = PLATFORM.find((m) => m.id === s);
  if (e?.cost === 'free') return { in: 0, out: 0, src: 'table', free: true };
  return null;   // 不知道就说不知道
}

/* ───────────────────────── 本地发现 ─────────────────────────
 *
 * 为什么要探测而不是写死：本地装了哪些模型，只有那台机器知道。
 * 猜一个 `qwen3:8b` 放进表里，用户点了会得到"连不上"——比不列出来更糟。
 *
 * 超时要短（900ms）：这段代码在**打开面板**的路径上，慢一点用户就以为点了没反应。
 * 探不到就把那一组写成"没发现" —— 不报错，因为"没装本地模型"是个正常状态。
 */
const LIVE_TTL = 60_000;          // 本地清单缓存 1 分钟
const AVAIL_TTL = 5 * 60_000;     // 平台清单缓存 5 分钟
const cache = { local: null, localAt: 0, localFly: null, ids: null, idsAt: 0, idsFly: null };

async function ollamaCaps(root, model, ms) {
  try {
    const r = await fetch(`${root}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) return null;
    const j = await r.json();
    /* capabilities 是 Ollama 0.6+ 才有的。老版本没有这一项 ——
       那就**不知道**，界面写"?"，不要按名字猜（猜错的代价是
       "标着会想、那栏里一个字都没有"，用户会以为界面坏了）。 */
    if (!Array.isArray(j?.capabilities)) return null;
    return {
      think: j.capabilities.includes('thinking'),
      tools: j.capabilities.includes('tools'),
      ctx: Number(j?.model_info?.['*.context_length'] || j?.parameters?.num_ctx || 0) || null,
    };
  } catch { return null; }
}

async function probeLocal(ms = 900) {
  const base = localBase();
  const root = base.replace(/\/v1$/, '');
  let tags;
  try {
    const r = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    tags = Array.isArray(j?.models) ? j.models : [];
  } catch {
    return { up: false, models: [] };
  }
  const out = await Promise.all(tags.map(async (m) => {
    const name = String(m.name || m.model || '');
    if (!name) return null;
    const caps = await ollamaCaps(root, name, ms).catch(() => null);
    const gb = Number(m.size) ? +(Number(m.size) / 1e9).toFixed(1) : null;
    return {
      id: `local/${name}`,
      name,
      org: 'Ollama',
      think: caps ? caps.think : null,
      tools: caps ? caps.tools : null,
      cost: 'local',
      speed: null,
      ctx: caps?.ctx || null,
      note: caps
        ? (gb ? `${gb}GB，跑在本机` : '跑在本机')
        : '这个 Ollama 没报能力清单，想/工具都不知道',
      sizeGB: gb,
    };
  }));
  return { up: true, models: out.filter(Boolean) };
}

export async function localList({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.local && now - cache.localAt < LIVE_TTL) return cache.local;
  if (cache.localFly) return cache.localFly;
  cache.localFly = probeLocal()
    .then((v) => { cache.local = v; cache.localAt = Date.now(); cache.localFly = null; return v; })
    .catch(() => { cache.local = { up: false, models: [] }; cache.localAt = Date.now(); cache.localFly = null; return cache.local; });
  return cache.localFly;
}

/* 平台此刻真的挂着哪些模型。**只用来剔除**，不用来新增 ——
   接口里那 60 多个模型没有一个带"会不会想""多少钱"，全列出来等于把选择题变成填空。 */
async function platformIds({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.ids && now - cache.idsAt < AVAIL_TTL) return cache.ids;
  if (cache.idsFly) return cache.idsFly;
  const key = sfKey();
  if (!key) return null;
  cache.idsFly = fetch(`${sfBase()}/models?sub_type=chat`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(4000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const set = new Set((j?.data || []).map((m) => m.id));
      cache.ids = set.size ? set : null;
      cache.idsAt = Date.now();
      cache.idsFly = null;
      return cache.ids;
    })
    .catch(() => { cache.idsFly = null; return null; });   // 拉不到就不筛：宁可多显示，不要凭空少一个
  return cache.idsFly;
}

/* ───────────────────────── 表的形状 ───────────────────────── */

function decorate(m, ids, o = {}) {
  const short = String(m.id).includes('/') ? String(m.id).slice(String(m.id).indexOf('/') + 1) : m.id;
  const org = String(m.id).includes('/') ? String(m.id).slice(0, String(m.id).indexOf('/')) : (m.org || '');
  const avail = ids ? ids.has(m.id) : null;
  /* `o.blocked` 是"这一整组现在都换不了"（比如没配 MODEL_KEY）。
     照样列出来、但标成不可选 —— 和"不会调工具"走同一条判据，
     界面因此只有一种"灰着"的样子，不用记两套。 */
  const usable = m.tools !== false && avail !== false && !o.blocked;
  return {
    id: m.id,
    name: m.name || short,
    org: m.org || org,
    think: m.think ?? null,
    tools: m.tools ?? null,
    price: priceOf(m.id),
    cost: m.cost || (priceOf(m.id)?.free ? 'free' : 'unknown'),
    speed: m.speed || null,
    /* 本地模型会带上服务自己声明的窗口大小；平台那几个只认 `usage.mjs` 的表 */
    ctx: m.ctx || null,
    tag: m.tag || null,
    note: m.note || '',
    /* 不可选的原因要给出来。"灰着不能点"而不说为什么，等于让用户猜。 */
    usable,
    why: m.why
      || (o.blocked ? o.blocked : null)
      || (avail === false ? '平台上已经没有这个模型了' : null),
  };
}

/**
 * 整张表。
 * @param {{force?:boolean}} [o] force = 忽略缓存（用户刚装了一个本地模型）
 */
export async function catalog(o = {}) {
  const [local, ids] = await Promise.all([localList(o), platformIds(o)]);
  return {
    groups: [
      {
        key: 'local',
        label: '本地',
        /* 探测不到本地服务时**不写那句"没发现"**：下面的 empty 已经说了，
           同一个意思写两遍会让这一组看起来像出错了。 */
        note: local.up ? '跑在这台机器上 · 不走网络 · ¥0' : '',
        empty: local.up ? null : '没发现本地模型：把 MODEL_LOCAL_BASE 指到一个 OpenAI 兼容的本地服务（比如 Ollama）',
        models: [decorate(MOCK, null), ...local.models.map((m) => decorate(m, null))],
      },
      {
        key: 'platform',
        label: '平台',
        note: '硅基流动 · 按量计费',
        empty: sfKey() ? null : '没配 MODEL_KEY，平台这一组换不了',
        /* 没有 key 时整组灰着：留着是为了让人看见"有这些、但还差一个 key"，
           而点下去只会得到一个 400。 */
        models: PLATFORM.map((m) => decorate(m, ids, { blocked: sfKey() ? null : '没配 MODEL_KEY' })),
      },
      /* 只在用户真配过的时候才出现：空着一组会让"设置"看起来没生效 */
      ...(CUSTOM.length ? [{
        key: 'custom',
        label: '自定义',
        note: `你自己配的接口 · ${CUSTOM.length} 个`,
        empty: null,
        models: CUSTOM.flatMap((p) => p.models.map((m) => decorate({
          id: `${X_PREFIX}${p.id}/${m}`,
          name: m,
          org: p.name,
          /* 没测过就写 null（界面上是 `?`），不按名字猜 */
          think: null,
          tools: null,
          cost: 'custom',
          speed: null,
          note: p.baseURL,
        }, null))),
      }] : []),
    ],
    at: Date.now(),
  };
}

/** 找到一条（含运行时发现的本地模型）。找不到就是 null —— 调用方必须拒绝切换。 */
export async function findModel(id) {
  const s = String(id || '');
  if (!s) return null;
  if (s === MOCK.id) return decorate(MOCK, null);
  const hit = PLATFORM.find((m) => m.id === s);
  if (hit) return decorate(hit, await platformIds());
  if (s.startsWith('local/')) {
    const local = await localList();
    const m = local.models.find((x) => x.id === s);
    return m ? decorate(m, null) : null;
  }
  /* 自定义接口：设置页把这条删掉之后，这里就该返回 null ——
     否则会话里存着的 modelId 会让它继续发往一个已经不存在的地址。 */
  const x = parseCustom(s);
  if (x) return decorate({
    id: s, name: x.model, org: x.p.name, think: null, tools: null, cost: 'custom', note: x.p.baseURL,
  }, null);
  return null;
}

/**
 * id → 走哪个接口。**只有这一处**知道 id 的前缀是什么意思，
 * 别的地方（包括前端）都不该自己拆字符串。
 */
export function routeOf(id) {
  const s = String(id || DEFAULT_MODEL);
  if (s === 'mock') return { kind: 'mock', model: s };
  if (s.startsWith('local/')) return { kind: 'openai', model: s.slice('local/'.length), baseURL: localBase(), apiKey: localKey() };
  const x = parseCustom(s);
  if (x) {
    /* 适配器要求 key 非空（它无条件拼 `Authorization`），而不少自建网关
       根本不校验 —— 所以没填 key 时给一个占位，而不是抛"缺少 MODEL_KEY"。
       那个错误会让用户以为"设置没生效"，其实设置是对的。 */
    return { kind: 'openai', model: x.model, baseURL: x.p.baseURL, apiKey: x.p.apiKey || 'not-needed' };
  }
  return { kind: 'openai', model: s, baseURL: sfBase(), apiKey: sfKey() };
}

/** 自测用：把缓存清掉，别让上一个用例的探测结果影响下一个 */
export function _resetCache() {
  cache.local = null; cache.localAt = 0; cache.localFly = null;
  cache.ids = null; cache.idsAt = 0; cache.idsFly = null;
}
