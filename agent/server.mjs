/**
 * emergent-agent · 基座（M0 协议 + M1 真模型）
 *
 * 跑起来：
 *   node agent/server.mjs              # 读 agent/.env，默认硅基流动
 *   MODEL=mock node agent/server.mjs   # 不联网，用假模型跑协议
 *   SYS=mock MODEL=<任意模型> node agent/server.mjs
 *                                      # 真模型 + 可复现的假数据（调提示词用）
 *
 * 这一版接上了真模型（OpenAI 兼容），工具还是假的（k8s / 文件系统待接）。
 * 它证明的是那条链路：**模型发工具调用 → 工具执行 → 场景指令下发 →
 * 手势意图回灌 → 审批挂起**。换真工具只改 tools.mjs 的 run()，协议一个字不用动。
 *
 * 为什么下行用 SSE 而不是 WebSocket：这条链路上真正需要"流"的只有服务端 → 客户端
 * （一条工具的执行要分 run/ok 两次，模型的话要逐句来）。上行是低频率的点击和输入，
 * POST 就够。SSE 是 HTTP/1.1 上最省事的流式方案，反代也只要关掉缓冲。
 *
 * 零依赖：只用 Node 内建模块。部署进 k8s 时不需要 npm install。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

import { makeTools, defaultOverview, coldTools } from './tools.mjs';
import { normalizeSpec, patchToSpec } from './scene.schema.mjs';
import { createMockModel } from './model.mock.mjs';
import { createOpenAIModel } from './model.openai.mjs';
/* "能换的模型"那张表（含默认模型、单价、本地发现）。默认模型这个常数
   只在 `models.mjs` 里写一次 —— 这里以前也抄了一份，换模型时漏改，
   日志打得像"改了没生效"。 */
import {
  DEFAULT_MODEL, catalog, findModel, routeOf, setCustomProviders, _resetCache as resetModelCache,
} from './models.mjs';
import { buildSystemPrompt, FORGE_GUIDE, systemPrompt } from './prompt.mjs';
/* 设置（`settings.json`）：用户在界面上能改的那几件事 —— 额外的接口地址、
   系统提示词、温度与步数上限。它落盘跟着数据走（见 deploy 的 state 挂载）。 */
import {
  loadSettings, getSettings, saveSettings, publicSettings, settingsFile,
  behavior as settingsBehavior, normalizeBaseURL,
} from './settings.mjs';
import { createMemory, EXTRACT_SYS } from './memory.mjs';
import { createForge } from './tools/forge.mjs';
import { createMeter, estTokens, ymd } from './usage.mjs';
import { trimHistory, foldToolResults } from './history.mjs';
import { createPersona, traceRefs } from './persona.mjs';
import { createOlares } from './olares.mjs';
import { createComfy } from './comfy.mjs';
import { createSub } from './sub.mjs';
import { createSkills } from './skills.mjs';
import { cleanSpeech } from './speech.mjs';
import { toolLine, cut, reasonLines, alike } from './trace.mjs';
/* 收口的三句措辞。单独一个文件是为了能**不起服务**就测住它们 ——
   见 turnstop.mjs 开头的说明。 */
import { finalizePrompt, closeLine, stopWord, progressLine, resumeHint } from './turnstop.mjs';
import {
  compactPlan, applyCompact, transcriptFor,
  COMPACT_SYS, EPISODE_SYS, SUMMARY_TAG,
} from './history.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');            // 仓库根
/* 页面（agent.html 与它 import 的 src/、vendor/）在哪个目录。
   集群里代码挂在 /app，页面就在 /app/shell —— 用环境变量指过去，
   静态路由和相对引用的对应关系不变。 */
const WEB_ROOT = path.resolve(process.env.WEB_ROOT || path.join(ROOT, 'shell'));

/* .env 只给本地调试用：key 不进仓库（.gitignore 里有 agent/.env）。
   自己读而不用 dotenv，是为了保持"零依赖"——这个服务将来要直接丢进 k8s。 */
async function loadEnv(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 没有 .env 就用纯环境变量 */ }
}
await loadEnv(path.join(HERE, '.env'));

/* 设置要在**任何会话被创建之前**读进来：系统提示词和自定义接口都要用它。
   这份文件不存在是正常的（第一次跑），读失败也退回默认值 —— 一份坏掉的
   设置不该让整个 agent 起不来。 */
await loadSettings();
setCustomProviders(getSettings().providers);

const PORT = Number(process.env.PORT || 8788);
const SYS = process.env.SYS || 'k8s';            // k8s | host | mock —— 只决定"数据从哪来"
/* 模型与数据源是**两件事**：SYS=mock + 真模型，能在可复现的假数据上调提示词；
   SYS=host + mock 模型，能在真数据上验工具。混成一个开关就没法分开排障。
   k8s 是默认值：这台东西存在的意义就是管那台 Olares。没有集群凭据时
   tools.mjs 会打一行警告并退回本机读数，不会静默。 */
/* 默认模型**只在 model.openai.mjs 里写一次**。
   这里以前也抄了一份 —— 换模型时改了一处、漏了这处，线上跑的还是旧的，
   而日志里 `model=` 打的是这一份，看起来像"改了没生效"。
   同一个常数分两处写，迟早漂（这条踩过不止一次）。 */
const MODEL_ID = process.env.MODEL || (process.env.MODEL_KEY ? DEFAULT_MODEL : 'mock');
/* 一轮最多几步。**默认 0 = 不限。**
 *
 * 以前这里是 5、后来 10（造工具放宽到 16），出发点都是省钱 ——
 * 每多一步就是多一次整份上下文（12k 起）。但那个算盘打错了一件事：
 * **长任务本来就需要很多次工具调用**。查一个组件版本、翻三层目录、
 * 装完再验一遍，20 步是常态；掐在 10 步上，用户看到的是"它做了一半就不做了"，
 * 而这种失败**看起来像模型能力问题**，其实是循环的形状问题。
 *
 * 所以现在默认不设限，安全网换成另外三条，判的都是"有没有进展"而不是"几次"：
 *   · `stuck`  —— 同一组参数反复调（三步内两次重复）→ 没有进展，收口；
 *   · `long`   —— 单回合墙钟到点（`TURN_HARD_MS`）→ 停下，**可续跑**；
 *   · `ctx`    —— 上下文快满且折不动了 → 停下，**可续跑**。
 *
 * `MAX_STEPS` / `MAX_STEPS_FORGE` 仍然认（设置页的滑块也还写这个字段），
 * 只有显式设成 >0 时才是上限 —— 自测和"我就想省点钱"的人用它。
 */
const MAX_STEPS = Number(process.env.MAX_STEPS || 0);
const MAX_STEPS_FORGE = Number(process.env.MAX_STEPS_FORGE || 0);
/* 一整轮能跑多久。**这是一个"可续跑的断点"，不是终点。**
 *
 * 时间这条仍然要留：一次 HTTP 回合挂半小时，用户已经不知道它在干什么了，
 * 而且进程重启/SW 刷新都会把这一轮丢掉。所以到点就收口 ——
 * 但收口时会给一份中途汇报，并明说「继续」能接着来（历史全在）。
 *
 * 15 分钟：`olares_act --watch` 本身 90 秒，装一个应用加前后查询能到 4~5 分钟，
 * 再留出"装完再验一遍"的余量。以前这里是 180 秒 —— 那才是真正在半路掐活的东西。 */
const TURN_HARD_MS = Number(process.env.TURN_HARD_MS || process.env.TURN_MS || 15 * 60 * 1000);
/* 心跳间隔：长任务不能安静地跑。见 turnstop.mjs 的 `progressLine`。 */
const BEAT_MS = Number(process.env.BEAT_MS || 45000);
/* 上下文满窗自收的水位（见 history.mjs）。78% 动手，收到 45% ——
   留出滞回，否则每轮都会裁一点点，而"每轮都变"对前缀缓存是最坏的事。 */
const CTX_TRIM_AT = Number(process.env.CTX_TRIM_AT || 0.78);
const CTX_TRIM_TO = Number(process.env.CTX_TRIM_TO || 0.45);
const APPROVAL_MS = 90_000;

/* ───────────────────────── 会话 ───────────────────────── */

/** @type {Map<string, any>} */
/* 官方 olares-cli 的封装。**全局一个**，不是每会话一个 ——
   它只是 exec + 审计，没有会话状态（身份在 CLI 自己的 profile 里）。
   探一次"装没装、有没有身份"，把结论打到启动日志：
   没有它的时候系统层会退化成 k8s 视角，而那必须让人看得见。 */
const olares = createOlares();

/* ComfyUI：只认一个 HTTP 地址（`COMFY_URL`，默认 127.0.0.1:8188）。
   **没卡也能建**：出图慢是运行时的事，不是构造条件 —— 而"连不上"由 op=status
   如实说出来。开发期这个地址指向 `tools/dev/stub-comfy.mjs` 就行。 */
const comfy = createComfy();

/**
 * 子 agent：**换一个上下文，把立场锁住**（见 `agent/sub.mjs` 文件头）。
 *
 * 每次调用现造一个实例，而不是全局一个 —— 因为 `complete` 必须跟着**这个会话当前的模型**
 * 走：换了模型之后子 agent 也该换（否则主对话在 8B 上、审它的却是另一个 7B，结论没法比）。
 *
 * 用量要记进这个会话的账本：一次判断 = 多一次调用，不记的话"今天花了多少"是假的。
 */
async function runSubFor(s, a = {}) {
  if (!s?.model) return { ok: false, code: 'sub_unavailable', error: '这个会话还没有模型' };
  const sub = createSub({
    complete: (req) => s.model.complete(req),
    onUsage: (u) => {
      try {
        /* `parts` 要给全（sys/tools/hist）：账本用它算"上下文里谁占得多"。
           子 agent 没有工具表，所以 tools 是 0 —— 这不是缺数据，是事实。 */
        s.meter?.add?.(u, { ms: 0, msgs: 2, parts: { sys: 0, tools: 0, hist: 0 } });
      } catch { /* 记账失败不该让判断失败 */ }
    },
    timeout: Number(a.timeout || 120_000),
  });
  return sub.run(a);
}

/* ── 自动过一遍反方：**唯一一个不靠模型自觉的接点** ──
 *
 * 为什么单挑"写完代码"这一处：`tool_write` / `tool_code` 的产物是**以后会被人信任**的东西
 * （它能进工具表、能被执行），而写它的那个上下文刚刚才决定这么写，天然不会自我否定。
 * 实测过的形状：模型写完脚本、`tool_try` 跑一次"能跑"，就当它对了 —— 边界条件、
 * 失败分支、参数校验一概没有。这里补一次审，成本是一次调用（无工具、一轮），值。
 *
 * 三个约束：
 *   · 一轮最多两次（`s.subN`）：写三个工具就审三次，那还不如不写；
 *   · 超时短（60 秒）：它是旁支，不该把主回合拖住；
 *   · 审的结果**只作为参考回给模型**，不阻断、不改代码 —— 要不要改由它自己决定。
 */
const SUB_REVIEW_TOOLS = /^(tool_write|tool_code)$/;
const SUB_REVIEW_MAX = 2;

async function autoReviewCode(s, name, args, result) {
  if (!SUB_REVIEW_TOOLS.test(name)) return null;
  if (!result || result.error || result.ok === false) return null;   // 本来就没成功，不审
  if ((s.subN || 0) >= SUB_REVIEW_MAX) return null;
  if (process.env.SUB_REVIEW === '0') return null;
  const code = String(args?.code || args?.script || args?.src || '');
  if (code.length < 40) return null;      // 太短的东西没有可审的（一句话的胶水）

  s.subN = (s.subN || 0) + 1;
  const t0 = Date.now();
  const r = await runSubFor(s, {
    role: 'critic',
    subject: `一段即将被装进工具表的 JavaScript（工具名 ${args?.name || name}）`,
    timeout: 60_000,
    task: [
      '下面是一段会被当作工具执行的 JavaScript（Node ESM，零依赖）。找出**会在真实运行中坏掉**的地方。',
      '重点看：边界条件（空数组/0/undefined/超长输入）、失败分支（接口 500、超时、字段缺失）、',
      '有没有把不该信的东西当真的（文件内容、接口返回）、有没有可能吞掉用户可见的失败。',
      '不要评价风格，不要说"建议补充注释"。',
      '',
      '```js',
      code.slice(0, 6000),
      '```',
    ].join('\n'),
  });
  if (!r.ok) {
    console.log(`[sub] 自审失败 ${r.code}：${r.error}`);
    return null;
  }
  if (r.fence) {
    /* 它自己也中和了 —— 这条结果按"没答"处理，不要拿它当依据（也说明 brief 需要再收紧）。 */
    console.log('[sub] 自审给了一段和稀泥的话，已丢弃');
    return null;
  }
  trace(s, 'step', {
    text: '让另一个人挑了毛病',
    detail: r.conclusion ? `${r.conclusion.slice(0, 60)}` : undefined,
    tool: 'sub_run',
  });
  console.log(`[sub] 自审 ${Date.now() - t0}ms：${r.conclusion.slice(0, 60)}`);
  return {
    verdict: r.conclusion,
    issues: r.reasons,
    /* 对方最强的那一点：让模型看到"最坏会怎么坏"，比一串小毛病有用 */
    worst: r.counter || undefined,
  };
}

/* 官方技能包（12 份 SKILL.md，构建时从 olares-cli 里 export 出来）。
   索引在启动时读一次（`await skills.index()`，见 listen 之前），
   因为工具 schema 的 enum 用的是**同步**拿到的名字表。 */
const skills = createSkills();

const sessions = new Map();

/* 会话落盘。为什么需要：这套界面的状态几乎全在"场"里 —— 刷新一下、
   反代重启一次，用户看到的就是一片空粒子，刚才那屏和那行结论全没了。
   而这一屏往往是他正在看的东西，不是可以随手丢掉的过程。
   存三样就够：对话（模型的上下文）、最后一屏（眼睛看到的）、最后的读数（兜底要用）。 */
const SESS_DIR = path.join(HERE, 'sessions');
/* 日账本目录。**和会话分开**：会话是"这段对话说了什么"，
   账本是"这一天一共烧了多少"——重启会话不该让今天的账清零。 */
const USAGE_DIR = path.join(HERE, 'usage');
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;   // sid 会变成文件名，先卡死形状

async function loadSession(sid) {
  try {
    const raw = await fs.readFile(path.join(SESS_DIR, `${sid}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

let saveTimer = null;
function scheduleSave(s) {
  /* 已经归档的会话不该再写回来（见 newSession）。 */
  if (s.dead) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow(s).catch(() => {}); }, 800);
}

async function saveNow(s) {
  if (s.dead) return;
  try {
    await fs.mkdir(SESS_DIR, { recursive: true });
    const data = {
      sid: s.sid,
      updatedAt: Date.now(),
      /* 只留最近 40 条：文件要小，模型上下文也不该无限长（8B 的窗口撑不住） */
      messages: s.messages.slice(-40),
      scene: s.lastSceneSpec || null,
      ops: s.postOps || null,
      line: s.lastLine || '',
      /* 说话记录：屏幕上那一行只活一回合，用户想回头看一眼"刚才它怎么说的"
         没有别的地方可查 —— 场里 20 格、工具调用也不该给用户看。 */
      log: (s.log || []).slice(-40),
      modelId: s.modelId || null,
      status: s.lastStatus || null,
      apps: s.lastApps || null,
      /* token 账本也一起存：刷新之后"这个会话花了多少"不能从零开始。
         存的是快照不是 meter 实例 —— 恢复时重建，避免把闭包塞进 JSON。 */
      usage: s.meter ? s.meter.snap() : null,
    };
    await fs.writeFile(path.join(SESS_DIR, `${s.sid}.json`), JSON.stringify(data));
  } catch { /* 落盘失败不该影响对话 */ }
}

/**
 * 造一个模型实例。
 *
 * `id` 是**表里的那个 id**（见 `models.mjs`），不是发给接口的模型名 ——
 * 前缀 `local/` 表示"走本机那个推理服务"。这层翻译只在 `routeOf()` 里做一次：
 * 别的地方（尤其是前端）都不该自己拆这个字符串，两边拆法一旦不同，
 * 表现是"本地模型被发去了硅基流动"，然后是一个看不懂的 404。
 */
function makeModel(id = MODEL_ID) {
  const route = routeOf(id);
  if (route.kind === 'mock') {
    const m = createMockModel();
    m.id = 'mock';
    return m;
  }
  try {
    const m = createOpenAIModel({
      model: route.model, baseURL: route.baseURL, apiKey: route.apiKey,
      /* 温度是**设置**里的，不是环境变量里的。改它要让下一轮立刻用上，
         所以每次造实例都现取（实例在换模型时才会重建，见 switchModel）。 */
      temperature: settingsBehavior().temp,
    });
    m.id = id;
    return m;
  } catch (e) {
    /* 配错了不要静默退回 mock：那会让人以为"模型变笨了"，其实是一直没连上 */
    console.error('[model]', e.message);
    throw e;
  }
}

/* ───────────────────────── 长期记忆 ───────────────────────── */

/* 抽取走**同一个模型配置**。理由在 memory.mjs 里：lobster 的原设计就是
   "你就是抽取器"。多一个模型就是多一份 key、多一个延迟、多一种不一致。
   它跑在后台，不挡回话 —— 抽一条事实的成本不该由用户等。 */
let memModel = null;
/* 这是**当前**哪个模型在干活。会话可以中途换模型，抽取器也要跟着换 ——
   否则用户省着钱换成了免费的，后台还在偷偷用那个收费的模型抽事实。
   只记一个 id：抽取器没有 sid（它拿到的是文本），而这是个单用户桌面。 */
let liveModelId = MODEL_ID;
const memory = createMemory({
  extractor: async (text) => {
    /* mock 模型不会老实返回 JSON，本地跑协议时干脆不抽 —— 记忆本身照常可用 */
    if (liveModelId === 'mock') return '{"facts":[]}';
    if (!memModel || memModel.id !== liveModelId) memModel = makeModel(liveModelId);
    const out = await memModel.complete({
      messages: [
        { role: 'system', content: EXTRACT_SYS },
        { role: 'user', content: text },
      ],
    });
    return out.content || '';
  },
});

/* 状态区要的那个「16 条」。
 *
 * 为什么不在每次 hello 里现算：`stats()` 要遍历整张边表（每条 'about' 边都要取一次
 * 目标节点），记忆库大到几千条时那是一次几十毫秒的同步开销，而它只是屏幕上一行
 * 11px 的小字。15 秒缓存 + 轮末强制刷新 —— 用户看到的"刚记住一条"照样会变。
 *
 * 它**不进模型上下文**：这是给人看的数字，不是给模型的提示。
 */
let memCache = { at: 0, v: null };
async function memBrief(force = false) {
  if (!force && memCache.v && Date.now() - memCache.at < 15000) return memCache.v;
  let v = { on: false, facts: 0, last: null, recent: null };
  try {
    if (memory.ok) {
      const s = await memory.stats();
      const r = s.recent?.[0];
      v = { on: true, facts: s.facts || 0, last: r?.when || null, recent: r?.text || null };
    }
  } catch { /* 记忆挂了不影响说话 —— 这条链上任何失败都只是那一格空着 */ }
  memCache = { at: Date.now(), v };
  return v;
}

/** 记忆上下文拼进**第一条 system**，而不是另起一条 system。
 *  另起一条在 OpenAI 兼容服务上不一定被接受（有的只认第一条 system），
 *  而"改了第一条的内容"在协议上永远安全。 *//* ───────────────────────── 自造工具 ─────────────────────────
 * 用户目录下的 ~/Agent/tools（脚本 + manifest）和 ~/Agent/skills（做法）。
 * 和记忆一样是可降级的：没挂上用户目录就只有内置工具，对话照常。 */
/* TOOLBOX_HOME 只给本地调试用：没有 /userspace 时也能把工具落到一个干净的目录里 */
const forge = createForge({ home: process.env.TOOLBOX_HOME || '' });

/* ───────────────────────── 人格层（M5） ─────────────────────────
 * 两件事：**它记得自己做过什么**（种子），以及**偶尔说一句与当下无关的旧事**（漂移）。
 *
 * 事实种子（记忆库里已经落地的旧事）每轮刷一次，缓存放在这里：
 * 它必须是**与当前问题无关**的那一批，所以不能直接用 memory.context 的命中结果
 * —— 命中的恰恰是"相关"的，会被正交判据全部挡掉，漂移就永远没有材料。
 */
let factPool = [];
const persona = createPersona({
  on: process.env.PERSONA !== 'off',
  /* 跟记忆落在同一个目录：它在 Files 里必须看得见。
     踩过：集群上记忆在 /userspace/pvc-xxx/Home/Agent/memory，人格却写进了 /root 下，
     那是个容器内的私有目录 —— pod 一删全没，用户也永远翻不到它在记什么。 */
  dir: () => memory.dir || '',
  recallFacts: (n) => factPool.slice(0, n),
});

function withMemory(messages, note) {
  if (!note) return messages;
  const i = messages.findIndex((m) => m.role === 'system');
  if (i < 0) return [{ role: 'system', content: note }, ...messages];
  const out = messages.slice();
  out[i] = { ...out[i], content: `${out[i].content}\n\n${note}` };
  return out;
}

/** 容量探针：**故意**把上下文撑大，用来回答"多长算太长"。
 *
 *   CTX_PAD=3000 node agent/server.mjs
 *
 * 只在显式设了才生效，而且不改任何规则 —— 它只在系统提示词后面追加一段
 * 与本轮无关的占位文字。这样"变蠢"如果发生，原因就只剩长度这一个变量。
 * 没有这个开关，所有"上下文太大了"的判断都只能靠感觉。
 */
const CTX_PAD = Number(process.env.CTX_PAD || 0);
function padded(sys) {
  if (!CTX_PAD) return sys;
  const unit = '（以下是与本轮无关的占位文字，用来测量上下文长度的影响。）';
  return sys + '\n\n' + unit.repeat(Math.ceil(CTX_PAD / unit.length)).slice(0, CTX_PAD);
}

/**
 * 当前生效的系统提示词。
 *
 * 它是**唯一出口**：新建会话、恢复历史会话、改完设置之后刷新，全都走这里。
 * 以前这行是 `padded(buildSystemPrompt())` 直接散在两处 —— 现在设置里能改
 * 提示词了，散着写的话"改了没生效"会变成一个找不到原因的现象
 * （尤其是历史会话：它的第一条 system 早就存进 sessions/*.json 了）。
 */
function sysPrompt() {
  return padded(systemPrompt(getSettings().prompt));
}

/**
 * 让一段历史用上**当前**的系统提示词。
 *
 * 系统提示词是**配置**，不是历史：它跟着设置走，不该被 10 月 20 日那次保存
 * 冻住。所以恢复会话时把第一条 system 换掉，其余消息一条不动。
 *
 * 换之前先比对（`content === cur`）—— 一样就返回原数组，省得每轮都新建。
 */
function withCurrentSystem(msgs) {
  const cur = sysPrompt();
  const i = msgs.findIndex((m) => m.role === 'system');
  if (i < 0) return [{ role: 'system', content: cur }, ...msgs];
  if (msgs[i].content === cur) return msgs;
  const out = msgs.slice();
  out[i] = { ...out[i], content: cur };
  return out;
}

async function getSession(sid) {
  let s = sessions.get(sid);
  if (!s) {
    const saved = SID_RE.test(sid) ? await loadSession(sid) : null;
    s = {
      sid,
      /* 系统提示词是会话的第一条消息，进历史。这样 /api/debug 能直接看到
         模型当时到底被喂了什么 —— 调提示词全靠这个。 */
      messages: saved?.messages?.length
        ? withCurrentSystem(saved.messages)
        : [{ role: 'system', content: sysPrompt() }],
      reses: new Set(),      // 这段会话的所有下行连接（可能有多个：刷新、多标签页）
      tools: makeTools({ source: SYS, memory, forge, olares, skills, comfy,
        /* 子 agent 的出口：闭包引用 `s`，所以拿的是**这个会话当前**的模型
           （换模型之后子 agent 也跟着换，见 runSubFor 的注释）。 */
        sub: { run: (a) => runSubFor(s, a) } }),
      model: null,
      /* 这段对话用的是哪个模型。**要落盘**：换过一次之后刷新，
         不能又回到默认那个 —— 用户会以为"换了没生效"（他刚踩过这个）。 */
      modelId: saved?.modelId || MODEL_ID,
      pending: null,        // 审批挂起：{id, resolve}
      abortCtl: null,       // 这一轮的中断开关（用户按停）
      busy: false,
      turn: 0,
      lastAdjustTo: null,
      lastSceneSpec: saved?.scene || null,
      postOps: saved?.ops || null,
      lastLine: saved?.line || '',
      log: Array.isArray(saved?.log) ? saved.log : [],
      lastStatus: saved?.status || null,
      lastApps: saved?.apps || null,
      resumed: !!saved?.scene,
    };
    liveModelId = s.modelId;
    s.model = makeModel(s.modelId);
    /* 账本按模型建：上下文上限和单价都是**模型**的属性，不是会话的属性。
       落在 sessions/*.json 里的是快照，这里重建实例再灌回去 —— 刷新之后
       "这个会话花了多少"不能从零开始算。
       用 `modelId`（表里的 id）而不是 `s.model.model`（发给接口的名字）：
       单价表是按表里的 id 建的，拿 `qwen3:8b` 去查本地那一行会查不到。 */
    s.meter = await createMeter({ model: s.modelId, dir: USAGE_DIR });
    s.meter.restore(saved?.usage);
    sessions.set(sid, s);
  }
  return s;
}

/* 兜底屏要的那条曲线。
 * CPU 比内存更适合做"这台机器忙不忙"的背景 —— 内存在这个集群上是条直线
 * （40% ~ 42%，一天都不怎么动），画出来什么都看不出来；CPU 有 14%~67% 的起伏。
 * 取不到就返回 null，兜底屏退化成三个仪表，不影响别的。 */
/* "这一屏比上一屏少东西吗"。
 * 只有真正**新增了一个问题时**才允许变少 —— 因为问句本身就是新信息，
 * 为了给问句腾地方而收掉一格仪表是合理的。 */
function shrinks(next, prev) {
  const count = (s, k) => (s.layers || []).filter((l) => l.kind === k).length;
  const nextN = (next.layers || []).length;
  const prevN = (prev.layers || []).length;
  if (nextN >= prevN) return false;
  const newAsk = count(next, 'fork') > count(prev, 'fork');
  const newNote = count(next, 'condense') > count(prev, 'condense');
  return !newAsk && !newNote;
}

/**
 * 把一条分叉 op 放到屏幕上 —— **有那一层就改，没有就长出来**。
 *
 * `scene.patch()` 遇到不存在的层会 `continue`（静默），所以"问一句"这件事
 * 在**没有任何分叉的屏幕**上从来不会发生。两处踩过：
 *   ① 模型调 `scene_ask`（线上："要在 Navidrome 中查找《千与千寻》吗"）；
 *   ② 系统自己的"拖了仪表代问"兜底。
 * 两处都走这里，别再各写一份。
 */
function askOnScreen(s, op) {
  const known = new Set((s.lastSceneSpec?.layers || []).map((l) => l.id));
  if (known.has(op.id)) {
    s.postOps = [...(s.postOps || []), op].slice(-8);
    emit(s, { t: 'scene', op: 'patch', ops: [op] });
    return true;
  }
  const norm = normalizeSpec(patchToSpec(s.lastSceneSpec, [op]));
  if (!norm.spec) return false;
  s.lastSceneSpec = norm.spec;
  s.postOps = [];
  s.drew = true;
  emit(s, { t: 'scene', op: 'set', spec: norm.spec });
  return true;
}

/**
 * 兜底铺一屏：模型没给出这一屏（空回复、超时、429）时，用**这一轮已经拿到的读数**铺。
 *
 * 两条触发路径共用它：
 *   · 模型回了空 —— 出现在正常流程末尾（原来那段内联代码就在这儿）；
 *   · 模型抛异常 —— 出现在 catch 里。**这一条以前没有**，所以超时的时候
 *     屏幕上只有"模型没响应"，而工具其实 4 秒前就把 3 个应用和它们的版本
 *     递到手上了。信息在手里、却因为"最后一个环节失败"整个丢掉，是最亏的一种失败。
 *
 * 返回 true 表示铺了。`s.salvaged` 挡住重复：空回复路径铺过之后，
 * catch 里不该再铺一次（屏幕上会闪两下）。
 */
async function salvage(s) {
  if (s.salvaged || s.drew) return false;
  if (s.goal?.kind !== 'ask') return false;
  const freshStatus = s.statusTurn === s.turn ? s.lastStatus : null;
  const freshApps = s.appsTurn === s.turn ? (s.lastApps || []) : [];
  if (!freshStatus && !freshApps.length) return false;

  s.salvaged = true;
  const line = s.lastVoice
    || (freshStatus
      ? `CPU ${Math.round((freshStatus.cpu ?? 0) * 100)}% · 内存 ${Math.round((freshStatus.mem ?? 0) * 100)}%`
      : `${freshApps.length} 个应用在跑`);
  /* 曲线只在有**本轮**节点读数时才配。应用列表那类问题如果也挂一条 CPU 曲线，
     屏幕上就是"三个应用 + 一条不相干的 CPU 走势"，比没有更让人困惑。 */
  const built = defaultOverview(
    freshStatus || {}, freshApps, line,
    freshStatus ? await trendSeries(s.tools) : null,
    { note: !s.spoke },
  );
  if (!built) return false;
  if (!s.spoke) { s.spoke = true; speak(s, built.say); }
  emit(s, { t: 'scene', op: 'set', spec: built.spec });
  emit(s, { t: 'note', message: '模型没有给出这一屏，由系统按读数兜底铺开' });
  return true;
}

async function trendSeries(tools) {
  if (!tools.series) return null;
  try {
    const data = await tools.series('cpu', { minutes: 60, points: 60 });
    return data.length >= 2 ? { label: 'CPU 一小时', data, axis: [0, 1] } : null;
  } catch { return null; }
}

function emit(s, ev) {
  if (!s.reses?.size) return;
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of s.reses) {
    if (res.writableEnded) { s.reses.delete(res); continue; }
    res.write(line);
  }
}

/**
 * 「思考过程」一行。
 *
 * 这不是调试日志（那是 `?dev=1` 的观察窗和 stdout）：这是**给用户看的经过**。
 * 所以它必须是人话、有宾语、有耗时，而且**只在这一轮里有效** ——
 * 换一题就清空，它不是历史记录（那是 ↑ 记录 那一层的事）。
 *
 * 三种 kind：
 *   step  —— 一件正在做的事（`id` 用于之后把结果补上去）
 *   end   —— step 的结局（ok / err / denied / timeout）
 *   note  —— 不属于任何 step 的一句话（上下文压了、模型空回复、系统代问）
 */
function trace(s, k, o = {}) {
  emit(s, { t: 'trace', k, ...o });
}

/** 记一次模型调用的 token。
 *
 *  为什么在**调用点**记、而不是在模型适配器里记：只有这里知道两件
 *  适配器看不见的事 —— ① 实际发出去的上下文（记忆注入、技能注入都在
 *  `withMemory` 里拼的，适配器只收到结果）；② 这是第几步、属于哪一轮。
 *  账要按"用户看到的那一轮"算，不是按"HTTP 请求"算。 */
function recordUsage(s, out, msgs, schemas) {
  if (!s.meter) return null;
  /* 适配器没给 usage 时（mock、本地桩、某些网关）按字数估，但**标出来**：
     估算值和账单长得一样，是这个功能最坏的失败方式。
     **工具表必须算进去**：它每次请求都发，估算漏掉它会让水位偏低三分之三 ——
     而水位正是"该不该裁历史"的唯一依据。 */
  const u = out?.usage || {
    prompt: estTokens(JSON.stringify(msgs || [])) + estTokens(JSON.stringify(schemas || [])),
    completion: estTokens(out?.content || ''),
    cached: 0,
    est: true,
  };
  /* 上下文的构成。真实 usage 只给总数（12k），而 12k 里可能 9k 是系统提示词 ——
     不知道这件事，"裁历史省 token"就会裁错地方。三份按字数估、最后按比例
     对齐到真实总数（见 usage.mjs），所以比例可信、绝对值是估的。 */
  const sysMsg = (msgs || []).find((m) => m.role === 'system');
  const parts = {
    sys: estTokens(sysMsg?.content || ''),
    tools: estTokens(JSON.stringify(schemas || [])),
    hist: estTokens(JSON.stringify((msgs || []).filter((m) => m.role !== 'system'))),
  };
  const snap = s.meter.add(u, { ms: out?.ms, msgs: (msgs || []).length, parts });
  emit(s, { t: 'usage', ...snap });
  return snap;
}

/* ───────────────────────── 说过什么 ───────────────────────── */

/* 场里那一行每回合都会被新的一句顶掉，于是"刚才它怎么说的"在界面上不留痕。
 * 这里把两边说过的话按顺序记下来：屏幕不常驻，但按上键能翻回去。
 * 它不是聊天记录 —— 没有气泡、没有角色头像，只有"这台机器最近说过什么"。 */
const LOG_MAX = 40;

function pushLog(s, r, text) {
  s.log = s.log || [];
  s.log.push({ r, t: String(text).slice(0, r === 'u' ? 300 : 120), ts: Date.now() });
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  scheduleSave(s);
}

function speak(s, text) {
  /* 唯一的出口，所以清洗也放在这里。
     实测 7B 会自己"插图"：`![小狗](data:image/png;base64,iVBOR…)` —— 它能画的是
     粒子，不是位图；那串东西进说话行就是几十个乱码字符，还会把后面的话全挤掉。 */
  const t = String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, '')
    .replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, '')
    .replace(/https?:\/\/\S{40,}/g, '')
    /* 行内 markdown 记号在点阵里就是几个多余的符号：「`~/Downloads`」会原样画出来 */
    .replace(/[*`_]{1,2}([^*`_]+)[*`_]{1,2}/g, '$1')
    /* 只压空格与制表符，**保留换行**：一段回答的段落是内容的一部分，
       全压成一行之后 400 字就是一块没有停顿的墙（wrapText 认 \n）。 */
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!t) return;
  /* 同一句话不记两次：一轮里"模型自由文本"和"兜底句"可能撞车 */
  const last = (s.log || [])[s.log.length - 1];
  if (!last || last.r !== 'a' || last.t !== t) pushLog(s, 'a', t);
  s.lastSpoken = t;
  /* 反向核对：这一轮注入的旧事，有哪些真的被说出来了。
     模型自己带编号是不保险的（7B 实测内容说对、编号没带），所以这里核一遍：
     说到了就把编号留下 —— 那句"我记得…"从此有出处，而不是一句无法核对的口气。 */
  if (s.driftItems?.length && !s.traced) {
    const ids = traceRefs(t, s.driftItems);
    if (ids.length) {
      s.traced = ids;
      emit(s, { t: 'persona', trace: { ids, said: t } });
      console.log(`[persona] 它提到了 ${ids.join(' ')}`);
    }
  }
  emit(s, { t: 'say', text: t });
}

/**
 * 把这一轮该说的那段话交给屏幕。
 *
 * 一轮里可能有两个说话来源：模型自由文本（content）和 scene_show 的 reading。
 * 老规则是"一轮只说一句、后到的覆盖" —— 那是屏幕上只有一行 20 格时的产物。
 * 答案块扩到 400 字一页之后，这条规则的后果是：
 *   · reading 常常只有一行读数（提示词以前就这么教），它会把已经说出口的
 *     整段回答**盖掉**；
 *   · 于是用户看到的一直是"一行回复"（2026-10-22 的反馈，上一轮只改了字数上限
 *     没动覆盖规则，所以看起来像"没修好"）。
 * 新规则：先到的先上屏（不让用户干等），**后来那段明显更长才换掉它**。
 * 换而不是拼：拼接会把同一句结论说两遍，读起来像两个人在说话。
 *
 * @param {object} s 会话
 * @param {string} text 候选文本
 * @param {{force?:boolean}} [opt]
 * @returns {boolean} 有没有真的换掉屏幕上的话
 */
function putVoice(s, text, opt = {}) {
  const t = String(text || '').trim().slice(0, 1200);
  if (!t) return false;
  const prev = s.lastVoice || '';
  /* 1.5 倍 + 20 字：只是多一句客套（"好的，我看一下"）不该把长回答顶掉 */
  if (s.spoke && !opt.force && t.length < prev.length * 1.5 + 20) return false;
  s.spoke = true;
  s.lastVoice = t;
  s.lastLine = t;
  speak(s, t);
  return true;
}

function hear(s, text, r = 'u') {  const t = String(text || '').trim();
  if (t) pushLog(s, r, t);
}

/* ───────────────────────── 审批门 ───────────────────────── */

/**
 * 危险工具的唯一出口。
 *
 * 一条规则：**用户通过分叉给出的明确选择，就是对那个动作的批准。**
 * 已经点过"压到 34%"的人，不该再被问一次"确定压到 34% 吗"——
 * 那不是在保护他，是在确认他没读过自己刚点的东西。
 *
 * 所以只有"模型自己拿的主意"才走这道门。
 */
function needsGate(s, name) {
  const lv = s.tools.level(name);
  /* `confirm` 也是门。自造工具默认就是 confirm（文档 §5："默认 confirm"），
     之前只认 danger，等于所有自造工具都不用点头就跑了 —— 实测一轮里
     "把 So What 加进周末"直接执行，卡片没出现。名字叫 confirm 的东西不该静默执行。 */
  if (lv !== 'danger' && lv !== 'confirm') return false;
  const g = s.goal;
  /* 不过"用户在分叉上点过这个选项"只对 danger 有效：那是明确的授权；
     自造工具每次动手都要看见一次（它要做的事不预先确定）。 */
  const explicit = lv === 'danger' && g?.kind === 'intent' && g.intent?.kind === 'pick';
  return !explicit;
}

/* 这句话里有"托付动作"吗。
   中文里请求和疑问的边界很细：「能帮我把 x 挪走吗」是请求（带"挪"），
   「n8n 正常吗」是疑问（没有任何动作词）。所以先找动作词，再找疑问词 ——
   顺序很重要，反过来所有客气的请求都会被误判成疑问。
   应用层的几个动词（停/开/装/升级）也要算动作 —— 少一个，"帮我停掉 n8n"
   就会被判成"只是问问"，于是它查完状态就停在那里，用户以为自己说清楚了。 */
const ACT_WORDS = /(帮我|帮忙|替我|给我|麻烦|把|挪|移|删除|删掉|删了|清掉|清理|重装|装个|卸载|重启|重启一下|停掉|停一下|停了它|关掉|开回|开一下|启动|装上|装一下|升级|取消|写|创建|新建|保存|压缩|改个名|重命名)/;
const ASK_WORDS = /([?？]|吗|呢|是不是|有没有|为什么|为何|怎么|如何|什么|哪)/;

function asksOnly(s) {
  if (s.goal?.kind !== 'ask') return false;
  const t = String(s.goal.text || '');
  if (ACT_WORDS.test(t)) return false;
  return ASK_WORDS.test(t);
}

function requestApproval(s, { id, name, args }) {
  return new Promise(async (resolve) => {
    /* "首次运行必须看代码"那道门。
       顺序是**先看代码、再问要不要跑** —— 反过来就是"你先答应，代码待会儿再说"，
       那不叫知情。代码由系统自己去磁盘读，不经模型转述。 */
    try {
      await showToolCode(s, name, args);
    } catch (e) {
      console.warn('[forge] 代码预览失败：' + e.message);
    }
    /* 它要连哪儿，由系统从代码里读出来，写进卡片 —— 模型填不对 needs.net，
       但代码是它写的，代码里有什么我们看得见。 */
    let extraNet = null;
    if (name === 'tool_try' && args?.name) {
      try { extraNet = await forge.inferred(args.name); } catch { extraNet = null; }
    }
    const d = describeDanger(s, name, args, extraNet);
    s.pending = { id, resolve };
    emit(s, { t: 'approval', id, tool: name, args, label: d.label, danger: d.detail });
    /* 审批在等待时，那一栏要停在这一句上 —— 否则用户盯着"停掉 navidrome"那行
       看它转，却不知道它其实在等自己点按钮。 */
    trace(s, 'note', { text: '等你确认', detail: d.label, tone: 'gate', id });
    const timer = setTimeout(() => {
      if (s.pending?.id !== id) return;
      s.pending = null;
      emit(s, { t: 'approval', id, tool: name, args, label: d.label, danger: d.detail, state: 'timeout' });
      resolve(false);
    }, APPROVAL_MS);
    s.pending.timer = timer;
  });
}

/** needs 变成人话：审批卡上那一行小字。 */
function needsText(needs) {
  const net = needs?.net || [];
  const fs = needs?.fs || [];
  const bits = [];
  if (net.length) bits.push(`访问 ${net.join('、')}`);
  if (fs.length) bits.push(`读写 ${fs.join('、')}`);
  return bits.length ? bits.join(' · ') : '不碰网络和文件';
}

/** 把要跑的那份代码铺到场里。同一份代码在同一会话里只铺一次。 */
async function showToolCode(s, name, args) {
  const target = name === 'tool_try' ? args?.name
    : name === 'tool_keep' ? args?.name
      : (s.tools.isDynamic(name) ? name : null);
  if (!target) return;
  s.codeShown = s.codeShown || new Set();
  const key = `${target}`;
  if (s.codeShown.has(key)) return;
  const info = await forge.code(target);
  if (!info) return;
  s.codeShown.add(key);
  s.drew = true;
  emit(s, {
    t: 'surface', op: 'set',
    spec: {
      title: `${info.name}${info.status === 'draft' ? '（草稿）' : ''}`,
      subtitle: `v${info.version} · ${needsText(info.needs)}`,
      root: { type: 'code', lang: 'javascript', code: info.code.slice(0, 6000) },
    },
  });
}

/** 审批卡片要两段文字：一句短的进分叉（场里字很少），一句长的进日志（能说清代价） */
function describeDanger(s, name, args, extraNet) {
  if (name === 'mem_trim') {
    return {
      label: `压到 ${Math.round(args.to * 100)}%？`,
      detail: `会重启占内存最多的应用，它正在做的事会中断`,
    };
  }
  if (name === 'fs_move') {
    return { label: `把「${args.from}」移到「${args.to}」？`, detail: '移动后原位置就没了' };
  }
  if (name === 'fs_delete') {
    return { label: `把「${args.path}」删掉？`, detail: '进 ~/.trash，还能捞回来' };
  }
  if (name === 'fs_write') {
    return {
      label: `写「${args.path}」？`,
      detail: `${String(args.content ?? '').length} 字，同名文件会被覆盖`,
    };
  }
  if (name === 'memory_forget') {
    return { label: `忘掉「${args.query}」？`, detail: '从长期记忆里删掉。软删，能捞回来' };
  }
  if (name === 'k8s_restart') {
    return { label: `重启「${args.app}」？`, detail: '它正在做的事会中断，十几秒不可用' };
  }
  if (name === 'olares_act') {
    /* 卡片上那句短的进分叉（场里字很少），长的那句进日志。
       四个动词的代价不一样，别统一说成"会改变这台机器上的东西" ——
       "停"和"卸载"在下一次点击之后就分不出区别了。 */
    const n = String(args?.name || '').trim();
    const acts = {
      stop: { label: `停掉「${n}」？`, detail: '它会在应用列表里变成已停止，随时能开回来' },
      resume: { label: `开回「${n}」？`, detail: '会重新占内存，起来要十几秒' },
      restart: { label: `重启「${n}」？`, detail: '正在跑的任务会中断，十几秒不可用' },
      install: { label: `装「${n}」？`, detail: '会从市场拉镜像并创建它自己的命名空间，最慢几分钟' },
      upgrade: { label: `升级「${n}」？`, detail: '会拉新版本并重启它，正在跑的任务会中断' },
      uninstall: { label: `卸载「${n}」？`, detail: '入口会消失、数据一般保留，但重装不一定能接回原来的配置' },
      cancel: { label: '取消当前操作？', detail: '停在半截的装/卸/升级会留在那个状态' },
    };
    return acts[args?.op] || { label: `${args?.op}「${n}」？`, detail: '会改变这台机器上的东西' };
  }
  if (name === 'tool_try') {
    const m = s.tools.all?.[String(args?.name || '')] || {};
    /* 合并 declare 的和从代码里读出来的，去重后一起说。
       用户看到的必须是"这一次真的能连哪些"。 */
    const net = [...new Set([...(m.needs?.net || []), ...(extraNet || [])])];
    return {
      label: `试跑「${args?.name}」？`,
      detail: `${needsText({ net, fs: m.needs?.fs || [] })}。上面是它要跑的代码`,
    };
  }
  if (name === 'tool_keep') {
    return {
      label: `把「${args?.name}」装起来？`,
      detail: '以后每次用到它都会再问你一次（除非它自己声明成不需要问）',
    };
  }
  if (s.tools.isDynamic(name)) {
    const m = s.tools.all?.[name] || {};
    return { label: `用「${name}」动手？`, detail: needsText(m.needs) };
  }
  return { label: `${name}？`, detail: '会改变这台机器上的东西' };
}

function settleApproval(s, ok) {
  const p = s.pending;
  if (!p) return false;
  clearTimeout(p.timer);
  s.pending = null;
  emit(s, { t: 'approval_done', id: p.id, ok });
  p.resolve(ok);
  return true;
}

/* ───────────────────────── 工具调用循环 ───────────────────────── */

/** 意图里的人话名字。**永远不许出现 undefined** ——
 *  它是写进对话历史的一句话，模型下一轮会照着它理解"用户刚刚做了什么"，
 *  而「点了 undefined」教给它的只有"用户点了个不存在的东西"。 */
const nm = (i) => String(i?.label || i?.target || '那个东西');
const INTENT_ZH = {
  adjust: (i) => `把「${nm(i)}」从 ${Math.round(i.from * 100)}% 拖到 ${Math.round(i.to * 100)}%`,
  pick: (i) => `在「${nm(i)}」选了「${String(i.optionLabel || i.option || '其中一项')}」`,
  tap: (i) => `点了「${nm(i)}」`,
  pan: (i) => `把「${nm(i)}」横向翻了一段`,
  seek: (i) => `把「${nm(i)}」跳到 ${Math.round(i.to * 100)}%`,
};

const summarize = (r) => {
  if (r == null) return '';
  if (r.denied) return '已拒绝';
  if (r.error) return r.error;
  /* 被校验层丢掉的字段是个信号：模型说的和画出来的不是一回事。
     不显示出来，界面上"少了半个仪表"就永远查不到原因。 */
  const cut = Array.isArray(r.dropped) && r.dropped.length ? ` · 丢 ${r.dropped.length}` : '';
  if (r.op) return `scene.${r.op}${cut}`;
  if (r.apps) return `${r.apps.length} 个应用`;
  if (r.files) return `${r.files.length} 个文件`;
  if (r.freedGB != null) return `释放 ${r.freedGB} GB`;
  if (r.cpu != null) return `CPU ${Math.round(r.cpu * 100)}% · 内存 ${Math.round(r.mem * 100)}%`;
  if (r.lines) return `${r.lines.length} 行日志`;
  if (r.version != null && r.name && (r.status || r.already)) return `${r.name} v${r.version}`;
  if (r.ms != null) return r.ok === false ? '没成' : `跑完了 ${r.ms}ms`;
  return 'ok';
};

/* "这一轮被打断了"不是一种错误，是一条单独的路。
   用哨兵而不是 Error：它不该被下面的 catch 当成失败去写 error 事件，
   也不该出现在模型的上下文里。 */
const ABORT_TURN = Symbol('turn aborted');

/**
 * 打断。三件事必须一起做，否则"停"会留下烂摊子：
 *   1. 掐掉在飞的模型请求（AbortSignal 一路传到 fetch）
 *   2. 放掉挂着的审批 —— 它在等一个再也不会来的回答
 *   3. 补上缺失的 tool 结果（见 healToolCalls）
 */
function abortTurn(s) {
  if (!s.busy || !s.abortCtl) return false;
  s.abortCtl.abort();
  if (s.pending) {
    const p = s.pending;
    s.pending = null;
    clearTimeout(p.timer);
    p.resolve(false);
    emit(s, { t: 'approval_done', ok: false });
  }
  return true;
}

/**
 * 换模型 —— 界面上点一下那个名字就是调这里。
 *
 * 三件事都不做会出问题：
 *
 *   ① **不许在跑着的时候换。** 一轮里可能有五次模型往返，`s.model` 是在循环
 *      里逐次取的；换到一半，前半轮想的是 A、后半轮想的是 B —— 而屏幕上
 *      只有一行"思考过程"，没人能看出这件事发生过。所以这一轮跑着就直说"等它说完"。
 *   ② **账本只换属性、不换本子。** 见 `usage.retarget()`：日账本和会话累计
 *      都挂在那一个实例上，换模型重开一本，用户会看到"今天花了多少"忽然归零。
 *   ③ **抽取器跟着换。** 用户为了省钱换成免费的，后台不该还在用收费那个
 *      抽记忆（见 `liveModelId`）。
 *
 * 校验只认表里的 id。不校验的话，前端拼错一个字符会得到一个 404，
 * 而那个 404 在界面上长得像"模型没响应"。
 */
async function switchModel(s, id) {
  if (s.busy) return { ok: false, error: '这一轮还在跑，等它说完再换' };
  const entry = await findModel(id).catch(() => null);
  if (!entry) return { ok: false, error: '表里没有这个模型' };
  /* 不可选的模型（不会调工具的那些）：**在表里能看见，但换不过去**。
     让它换过去的话，第一句话就会得到"它没铺屏、也没调工具"，而原因
     根本不在提示词上 —— 那是这一层该拦住的事。 */
  if (!entry.usable) return { ok: false, error: entry.why || '这个模型跑不了 agent（它不会调工具）' };
  if (entry.id === s.modelId) return { ok: true, same: true };

  const prev = s.modelId;
  try {
    s.model = makeModel(entry.id);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  s.modelId = entry.id;
  liveModelId = entry.id;
  memModel = null;                    // 下一轮抽取时按新模型重建
  const usage = s.meter ? s.meter.retarget(entry.id) : null;

  emit(s, {
    t: 'model', ok: true, id: entry.id, name: entry.name,
    think: entry.think, tools: entry.tools, price: entry.price,
    from: prev, usage,
  });
  /* 那句话要说清"以后会有什么不一样"，因为换模型最直观的后果就在那栏里：
     不会想的模型，左上那一栏从此只有动作。 */
  const tail = entry.think === true ? '它会想' : entry.think === false ? '它不会想：那栏里只有动作' : '';
  const money = entry.price?.free ? '¥0' : entry.price ? '按量计费' : '单价未配置';
  emit(s, { t: 'note', message: `换成 ${entry.name}（${[tail, money].filter(Boolean).join(' · ')}）` });
  scheduleSave(s);
  console.log(`[model] ${prev} → ${entry.id}`);
  return { ok: true };
}

/**
 * 设置改完之后，把它**真正接到正在跑的东西上**。
 *
 * 三件事，少一件都会出现"改了没生效"：
 *
 *   ① 自定义接口要重新注入模型表 —— 不然刚加的地址要等重启才出现在换模型列表里。
 *   ② 模型表缓存要清 —— 平台/本地那两组有 TTL（60s / 5min），
 *      用户刚把一条接口删了，列表里还挂着它，点下去就是"表里没有这个模型"。
 *   ③ **活跃会话的第一条 system 要换掉。** 提示词是配置不是历史，
 *      但它是以"消息"的形式存在会话里的（这样 /api/debug 才看得到模型当时
 *      被喂了什么）。不换的话，正在聊的那个会话会一直用旧提示词，
 *      而用户刷新一下又"生效了" —— 这种一半生效最难查。
 *
 * 另外：如果当前用的模型来自一条被删掉的接口，必须退回默认。
 * 不退回的话，下一轮会往一个已经不存在的地址发请求，报错看起来像"网络问题"。
 */
async function applySettings() {
  const st = getSettings();
  setCustomProviders(st.providers);
  resetModelCache();

  const sys = sysPrompt();
  let swapped = 0;
  let rebound = 0;
  for (const s of sessions.values()) {
    const first = s.messages?.[0];
    if (first?.role === 'system' && first.content !== sys) {
      first.content = sys;
      swapped++;
    }
    if (!s.modelId) continue;
    /* **只校验 `x/` 开头的那些。** 平台 / 本地 / mock 不会因为改设置而消失，
       而 `findModel` 对平台模型要发一次 `/v1/models`（4 秒超时）——
       保存设置时不该为了几个不会变的东西等它。 */
    if (!String(s.modelId).startsWith('x/')) continue;
    const still = await findModel(s.modelId).catch(() => null);
    if (still) continue;
    /* 这条模型没了（比如它属于刚被删掉的那个接口）→ 退回默认 */
    const prev = s.modelId;
    s.modelId = DEFAULT_MODEL;
    liveModelId = DEFAULT_MODEL;
    try { s.model = makeModel(DEFAULT_MODEL); } catch { /* 没 key 也不该拦着保存设置 */ }
    s.meter?.retarget(DEFAULT_MODEL);
    emit(s, {
      t: 'model', ok: true, id: DEFAULT_MODEL, from: prev,
      usage: s.meter ? s.meter.snap() : null,
    });
    emit(s, { t: 'note', message: `原来的 ${prev} 已经不在了（接口被删），先换回默认的` });
    scheduleSave(s);
    rebound++;
  }
  console.log(`[settings] 保存；提示词替换 ${swapped} 个会话，模型回退 ${rebound} 个`);
  return { swapped, rebound };
}

/**
 * 「测一下」—— 只问那个地址要模型清单。
 *
 * 为什么是 `/models` 而不是发一句话：那要花钱、要等模型回话，而用户在配地址
 * 这一步真正想知道的是"能不能连上、key 对不对、它有哪些模型"。
 * `/models` 一次回答三件事，而且几乎每个 OpenAI 兼容接口都有。
 *
 * 它**不会**替用户保存 —— 测通了之后要按保存。两个动作分开是有意的：
 * 一个按钮既测又存，失败时用户不知道"到底是没连上，还是没存上"。
 */
async function probeEndpoint({ baseURL, apiKey, id }) {
  const base = normalizeBaseURL(baseURL || '');
  if (!base) return { ok: false, error: '这不是一个网址（要 http:// 或 https:// 开头）' };
  let key = String(apiKey ?? '').trim();
  /* 面板里 key 是脱敏的（只显示 …abcd），所以"测一下"要能沿用已存的那个 */
  if (!key && id) key = getSettings().providers.find((p) => p.id === id)?.apiKey || '';

  let r;
  try {
    r = await fetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '8 秒没有响应'
      : e?.cause?.code === 'ENOTFOUND' ? '这个域名解析不到'
        : e?.cause?.code === 'ECONNREFUSED' ? '这个地址拒绝连接'
          : (e?.cause?.code || e?.message || String(e));
    return { ok: false, error: `连不上：${why}`, base };
  }

  let text = '';
  try { text = await r.text(); } catch { /* 有的网关会中途断 */ }
  if (!r.ok) {
    /* 401/403 单独说清楚：地址是通的，是 key 的问题 —— 这两件事用户会当成同一件 */
    const hint = r.status === 401 || r.status === 403 ? '（地址是通的，是 key 不对）' : '';
    return {
      ok: false, status: r.status, base, error: `HTTP ${r.status}${hint}`,
      body: text.slice(0, 200),
    };
  }
  let list = [];
  try {
    const j = JSON.parse(text);
    list = (j.data || j.models || []).map((m) => m.id || m.name).filter((x) => typeof x === 'string');
  } catch {
    /* 有的接口 /models 返回的是一段 HTML（反代登录页）—— 那说明地址指错了层 */
    return { ok: false, status: r.status, base, error: '这个地址回的不是 JSON，可能指到了别的东西上' };
  }
  return {
    ok: true, base, models: list.slice(0, 100),
    note: list.length ? '' : '能连上，但这个接口不返回模型清单 —— 模型名手动填',
  };
}

/**
 * 打断时，历史可能停在"助手要调工具、结果还没回来"。
 * 下一次请求会因此 400 —— OpenAI 协议要求每个 tool_call 都有对应的 tool 消息。
 * 补一条"被打断"的结果：这不是假装执行过，是把"它确实没拿到结果"如实写进历史。
 */
function healToolCalls(s) {
  let i = s.messages.length - 1;
  while (i >= 0 && s.messages[i].role === 'tool') i--;
  const m = s.messages[i];
  if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return;
  const answered = new Set(
    s.messages.slice(i + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id),
  );
  for (const c of m.tool_calls) {
    if (answered.has(c.id)) continue;
    s.messages.push({
      role: 'tool', name: c.function?.name, tool_call_id: c.id,
      content: JSON.stringify({ error: '用户打断了这一轮，没有执行完' }),
    });
  }
}

/** 这一轮要不要把"冷门工具组"和它们的说明书发出去。
 *
 *  判据是**用户这句话**，不是模型的自述。两个方向的代价不对称：
 *  漏判 = 它明明能做却说做不到（用户直接损失一次）；误判 = 多花 2.6k token。
 *  所以关键词宁可宽。
 *
 *  为什么必须在这里做：工具表 6k token 是**每一次调用**都要重发的，
 *  而造工具那六件 + 1500 token 的规程，三十轮里难得用一次。
 */
/* ───────────── 上下文：压缩（摘要）与会话（换 sid） ───────────── */

const COMPACT_MIN = Number(process.env.COMPACT_MIN || 6);   // 少于这么多条就别压（压了也是空话）

/** 现在的水位（百分比）。给状态条和"压缩一下"的反馈用。 */
function ctxPct(s) {
  const snap = s.meter?.snap();
  if (!snap?.limit) return 0;
  return Math.round((snap.ctx.tokens / snap.limit) * 100);
}

/**
 * 把"更早的那段"讲成一段话，替换进去。
 *
 * 和 trimHistory 的分工：
 *   · trimHistory 是**兜底**（接口 400 的最后一道），丢掉最老的消息；
 *   · 这个是**正解**（用户想接着聊），先摘要再丢。
 * 顺序也是这个：先试压缩，失败或没得压才回落到丢。
 *
 * 为什么不等"满了再说"：压缩本身要一次模型调用，而调用发生在**下一轮开始前**。
 * 所以它必须在 78% 这个阈值上动手，给摘要留出时间 —— 等真满了，
 * 那一轮已经被 400 挡在门外了。
 */
async function compactSession(s, { manual = false } = {}) {
  if (!s.model) return { ok: false, reason: 'no-model' };
  if ((s.messages || []).length < COMPACT_MIN) return { ok: false, reason: 'short' };

  const plan = compactPlan(s.messages, { tail: 4 });
  if (!plan) return { ok: false, reason: 'short' };

  const txt = transcriptFor(plan.head);
  /* 上下文很小时压缩是纯亏（一次调用的钱换不到几百 token）——
     手动压是用户的要求，照做；自动压只在真的长起来之后才动。 */
  if (!manual && txt.length < 1200) return { ok: false, reason: 'short' };

  const t0 = Date.now();
  let out;
  try {
    out = await s.model.complete({
      messages: [
        { role: 'system', content: COMPACT_SYS },
        { role: 'user', content: txt },
      ],
      tools: [],
    });
  } catch (e) {
    console.warn('[ctx] 压缩失败：' + e.message);
    return { ok: false, reason: 'model', error: e.message };
  }
  const applied = applyCompact(s.messages, plan, out.content);
  if (!applied) return { ok: false, reason: 'empty' };

  const before = s.messages.length;
  s.messages = applied.messages;
  s.compactedAt = Date.now();
  /* 这一次调用也要进账本 —— 不然"压缩省了钱"是个无法核对的说法 */
  try { recordUsage(s, out, [{ role: 'system', content: COMPACT_SYS }, { role: 'user', content: txt }], []); } catch { /* 记账失败不影响对话 */ }

  console.log(`[ctx] 压缩 ${before}→${s.messages.length} 条，摘要 ${applied.summary.length} 字，${Date.now() - t0}ms`);
  return { ok: true, summarized: applied.summarized, summary: applied.summary, before, after: s.messages.length };
}

/**
 * 开一个新会话。
 *
 * 三件事缺一不可（少一件用户就会觉得"它把我刚说的忘了"）：
 *   ① 把上一段压成**一条记忆**（episode）—— 新会话里问"上次那个日志"，recall 能取到；
 *   ② 换 sid、清屏、重建系统提示（新会话的第一条就是 system）；
 *   ③ 旧会话**归档**，不删（"能回溯"比"能切回"便宜得多，本期只做前者）。
 *
 * 摘要**不**塞进新会话的第一条 system：那会让"新会话"没那么新，还重复占上下文。
 * 需要时它自己 memory_recall —— 符合"记忆是相关才取，不是常驻"。
 */
async function newSession(s, { reason = '' } = {}) {
  const old = s.sid;
  /* ① episode：整段对话压成一行。失败也要开新会话（用户点了，就得开）。 */
  let episode = '';
  if ((s.messages || []).length > 2 && s.model) {
    try {
      const txt = transcriptFor(s.messages.filter((m) => m.role !== 'system'), { head: 1500, tail: 3500 });
      if (txt.length > 60) {
        const out = await s.model.complete({
          messages: [
            { role: 'system', content: EPISODE_SYS },
            { role: 'user', content: txt },
          ],
          tools: [],
        });
        try { recordUsage(s, out, [], []); } catch { /* 记账失败不影响开新会话 */ }
        /* 一行、无换行、不带引号；长度卡在记忆的形状上限内（60） */
        episode = String(out.content || '')
          .replace(/^["'「]|["'」]$/g, '')
          .split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
        episode = episode.replace(/\s+/g, ' ').slice(0, 58);
      }
    } catch (e) {
      console.warn('[ctx] 新会话的 episode 没写成：' + e.message);
    }
  }
  if (episode) {
    try {
      await memory.remember({ text: episode, about: [], kind: 'episode', valence: 0 }, `episode:${old}`);
    } catch (e) {
      console.warn('[ctx] episode 落库失败：' + e.message);
    }
  }

  /* ② 归档旧会话（不删） */
  try {
    await saveNow(s);
    const dir = path.join(SESS_DIR, 'archive');
    await fs.mkdir(dir, { recursive: true });
    await fs.rename(path.join(SESS_DIR, `${old}.json`), path.join(dir, `${old}.json`)).catch(() => {});
  } catch (e) {
    console.warn('[ctx] 归档失败：' + e.message);
  }
  /* 归档之后**禁止再落盘**：回合结束时的 idle 保存（scheduleSave）会把
     刚移走的那份又写回来，下一次 /new 就会看到两份同名会话。 */
  s.dead = true;

  /* ③ 换 sid。**先告诉前端**，再让它的 SSE 断掉重连 ——
     顺序反过来的话，前端会先收到一屏属于旧会话的事件。 */
  const sid = newSid();
  emit(s, { t: 'session', sid, episode: episode || undefined, reason });
  for (const r of s.reses) { try { r.end(); } catch { /* 已经断了 */ } }
  s.reses.clear();
  /* 从内存表里摘掉，也**不要**再 saveNow —— 否则刚归档的文件会被原样写回来一份。 */
  sessions.delete(old);

  /* 新会话立刻建好、立刻落盘：刷新之后回到的必须是**这个**新会话，
     而不是"文件不存在 → 客户端再随机一个 id"（那样一刷就是另一段了）。 */
  try {
    const ns = await getSession(sid);
    await saveNow(ns);
  } catch (e) {
    console.warn('[ctx] 新会话落盘失败：' + e.message);
  }

  return { sid, episode };
}

/** 新会话 id：时间 + 随机，肉眼可排序、又不会撞 */
function newSid() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-`
    + Math.random().toString(36).slice(2, 8);
}

/* ───────────────────── 用户的两种"整理"指令 ───────────────────── */

/** 「压缩一下」/「/compact」*/
const CMD_COMPACT = /^\/?(compact|压缩(一下|上下文)?|收一收|整理一下上下文)$/i;
/** 「开个新会话」/「/new」*/
const CMD_NEW = /^\/?(new|新会话|开个新会话|开个新(的)?对话|换个话题吧|重新开始)$/i;

function isCompactCmd(t) { return CMD_COMPACT.test(String(t || '').trim()); }
function isNewCmd(t) { return CMD_NEW.test(String(t || '').trim()); }

/** 这一轮要不要把"冷门工具组"和它们的说明书发出去。
 *
 *  判据是**用户这句话**，不是模型的自述。两个方向的代价不对称：
 *  漏判 = 它明明能做却说做不到（用户直接损失一次）；误判 = 多花 2.6k token。
 *  所以关键词宁可宽。
 *
 *  为什么必须在这里做：工具表 6k token 是**每一次调用**都要重发的，
 *  而造工具那六件 + 1500 token 的规程，三十轮里难得用一次。
 */
function coldAllow(goal) {
  const text = goal.kind === 'ask'
    ? String(goal.text || '')
    : `${goal.intent?.kind || ''} ${goal.intent?.target || ''} ${goal.intent?.label || ''}`;
  const allow = new Set();
  if (/工具|脚本|接口|api|歌单|插件|技能|装个|写个|做个|造|下载|爬|抓|webhook|hook|文档|文档里|http/i.test(text)) {
    allow.add('forge');
  }
  return allow;
}

/* ───────────────────── 收口：这一轮必须有结局 ───────────────────── */

/**
 * 最后一句话，**不经过模型**。
 *
 * 走到这里说明：预算用尽 / 墙钟到点 / 原地打转 / 空回复，而且模型连
 * "总结一下"都没说出来。这时候屏幕上绝不能是空的 —— 空白会被读成"它没听见"。
 *
 * 但**也不能拿不相干的东西顶上**。这一轮问的是"系统里装了什么"，
 * 摆一段旧记忆就是答非所问，比空白更糟：用户会以为它答了，只是答歪了。
 * （实测就是这么发生的：屏幕上最后一句是"我记得这件事"。）
 *
 * 所以这里只用**这一轮真的发生过的事**说话：调过哪几个工具（翻成人话）、
 * 几次没成。宁可说"我查了三遍都没拿到东西"，也不装作答上了。
 */
function closeFallback(s, why) {
  const line = closeLine(s.acts || [], why, s.actN || 0);
  s.spoke = true;
  speak(s, line);
  return line;
}

/**
 * 收口（finalize）：这一轮不是"模型把话说完了"结束的，所以**再问它一次结论**。
 *
 * 参考的是几个真跑在生产里的循环怎么处理"没说完"：
 * OpenAI Agents SDK 撞上 `max_turns` 会抛 `MaxTurnsExceeded`（带上已有结果），
 * Anthropic 的服务端循环撞上限回 `pause_turn` —— 含义都是"**没做完**"，
 * 而不是"结束了"。我们这边的对应做法是：关掉工具，再要一次结论，
 * 拿不到就由系统说一句实话（`closeFallback`）。
 *
 * 三个刻意的决定：
 *
 * ① **撤掉工具表，而不是只写 `tool_choice:'none'`。** 那个参数不是每个
 *    服务端都认（`required` 已经被拒过，见 `model.openai.mjs` 的降级），
 *    而"没有工具可用"在任何 OpenAI 兼容接口上都成立 —— 空表意味着适配器
 *    根本不会带 `tools` 字段。
 * ② **要结论，不要道歉。** 提示里明确写"不要说抱歉、不要解释这件事本身"：
 *    7B 会写"很抱歉我无法完成"，那句话对用户零信息，还占满一屏。
 * ③ **`force` 写进去。** `putVoice` 默认"长回答优先"，而这一轮很可能
 *    已经说过一句"我先看看"——不强制的话，真正的结论会被那句客套挡住。
 */
async function finalize(s, why, ctxNote, steps = 0) {
  if (s.abortCtl?.signal?.aborted) return false;
  const ask = finalizePrompt(why, steps);

  /* **这段提示不进历史。**
     它写着"工具已经关掉了" —— 真写进 s.messages，下一轮模型会以为
     直到现在工具还是关的，于是"能查也不查"。只在这一次请求里临时附上，
     历史里留下的是 user(问题) → assistant(结论)，干净。 */
  const reqMsgs = [...s.messages, { role: 'user', content: `（${ask}）` }];

  emit(s, { t: 'think', on: true, step: steps });
  let out;
  try {
    out = await s.model.complete({
      messages: withMemory(reqMsgs, ctxNote),
      tools: [],                       // 空表 = 适配器不带 tools 字段 = 只能说话
      goal: { ...s.goal, closing: true },
      signal: s.abortCtl.signal,
    });
  } catch (e) {
    if (e?.aborted || s.abortCtl?.signal?.aborted) return false;
    /* 收口这一问也失败了（超时 / 429）。不往上抛：这一轮的数据还在手里，
       交给下面的兜底说一句话，比抛出去让用户看到"模型超时"好。 */
    console.warn('[finalize] 收口调用失败：' + (e?.message || e));
    closeFallback(s, why);
    emit(s, { t: 'note', message: `收口没成（${e?.message || e}），由系统说一句` });
    return true;
  } finally {
    emit(s, { t: 'think', on: false, step: steps });
  }

  recordUsage(s, out, reqMsgs, []);
  let text = cleanSpeech(String(out.content || '').trim());
  /* 它可能把"我需要调用 xxx"当结论写出来 —— 那是给自己下的指令，不是话。 */
  if (/^\s*[[{]/.test(text) || /^(调用|请调用|我应该调)/.test(text)) text = '';

  if (text) {
    putVoice(s, text, { force: true });
    /* 说了话就进历史。不然下一轮模型看到的是"我问了它一句、它没答"，
       会以为上一轮彻底失败了（其实它答过，只是那句话只出现在屏幕上）。 */
    s.messages.push({ role: 'assistant', content: text });
    emit(s, { t: 'note', message: `这一轮到此为止：${stopWord(why)}，我把结论说出来了` });
  } else {
    closeFallback(s, why);
    emit(s, { t: 'note', message: `这一轮到此为止：${stopWord(why)}，模型没说结论，由系统说一句` });
  }
  return true;
}

async function runTurn(s, goal) {
  if (s.busy) { emit(s, { t: 'busy' }); return; }
  /* 预算闸放在最前面：**不是**等这一轮跑完再记账。
     限额的意义就是"不让它开始"，跑完再说超了，钱已经花了。
     默认不限（TOKEN_DAY_CAP 没设），设了才拦。 */
  if (s.meter?.overBudget()) {
    const u = s.meter.snap();
    speak(s, '今天的量用完了');
    emit(s, { t: 'usage', ...u });
    emit(s, { t: 'note', message: `今日已用 ${u.day.in + u.day.out} token，上限 ${u.cap.limit}（TOKEN_DAY_CAP）` });
    emit(s, { t: 'idle' });
    return;
  }
  s.busy = true;
  s.abortCtl = new AbortController();
  let aborted = false;
  s.goal = goal;
  s.turn++;
  s.meter?.beginTurn();

  /* 上下文满窗自收：用**上一轮结束时**量到的水位，在**这一轮开始前**处理。
     放在这里而不是"请求失败后重试"，是因为满窗的失败发生在工具跑到一半，
     用户看到的是"做了一半不动了" —— 比一开始就拒绝还难理解。
     两条路：先试**压缩**（摘要，能接着聊），不行才**丢**（保命）。 */
  {
    const snap = s.meter?.snap();
    const over = snap && snap.limit && (snap.ctx.tokens / snap.limit) >= CTX_TRIM_AT;
    if (over) {
      const pct = Math.round((snap.ctx.tokens / snap.limit) * 100);
      /* 同一段水位只压一次：压缩后水位会掉下来；掉不下来的话别每轮都花一次调用 */
      const cool = s.compactedAt && Date.now() - s.compactedAt < 60_000;
      let done = false;
      if (!cool) {
        emit(s, { t: 'compact', on: true, auto: true, pct });
        const c = await compactSession(s).catch(() => ({ ok: false }));
        done = !!c.ok;
        emit(s, { t: 'compact', on: false, auto: true, ok: done });
        if (done) {
          emit(s, { t: 'note', message: `上下文 ${pct}%：把更早的 ${c.summarized} 条压成了一段，接着聊` });
        }
      }
      if (!done) {
        const trim = trimHistory(s.messages, {
          used: snap.ctx.tokens, limit: snap.limit, parts: snap.ctx.parts,
          at: CTX_TRIM_AT, to: CTX_TRIM_TO,
        });
        if (trim) {
          s.messages = trim.messages;
          emit(s, {
            t: 'note',
            message: trim.cramped
              ? `上下文 ${pct}%：系统提示和工具表本身就把窗口占满了，历史已清到最少`
              : `上下文 ${pct}%：丢了最早 ${trim.dropped} 条消息（更早的事靠 memory_recall）`,
          });
        }
      }
    }
  }
  s.spoke = false;          // 这一轮还没说过话（见下面 scene 工具回带的 say）
  s.narrated = false;       // 观察窗里还没提示过"旁白被咽掉"
  s.sets = 0;
  s.lastSpecSig = null;
  s.drew = false;           // 这一轮模型有没有自己铺屏（没铺就由系统兜底）
  s.salvaged = false;       // 这一轮有没有已经兜底铺过（见 salvage）
  s.painted = false;        // 这一轮有没有先铺过"渐进首屏"
  s.acts = [];              // 这一轮调过哪些工具（只给记忆抽取用，不进上下文）
  s.subN = 0;               // 这一轮自动审过几次代码（上限 SUB_REVIEW_MAX，见 autoReviewCode）
  s.actN = 0;               // 这一轮真正调了多少次（acts 有 12 条上限，长任务会截断）
  s.reasonN = 0;            // 这一轮已经上屏了几条"想"（整轮封顶 8 条，见下面）
  s.reasonSeen = new Set(); // 已经上过屏的那几句（跨步去重）
  s.traced = null;          // 这一轮它有没有把注入的旧事说出来（说了就记下编号）
  s.lastSpoken = '';
  s.pendingNext = '';     // 上一件工具留下的"下一步"（只用来推模型一把）
  s.forgeStep = false;    // 这一轮有没有动造工具的那几个（决定步数上限，见 MAX_STEPS）

  /* 每轮取一次记忆。取的是**用户这句话**相关的几条 ——
     不是把整本日记塞进去：7B 的窗口撑不住，而且它会开始复述过去。
     取失败就当没有记忆，不能因为记忆服务而答不上一句话。 */
  let memNote = '';
  let memHits = [];
  try {
    const m = await memory.context(goal.kind === 'ask' ? goal.text : '');
    memNote = m.text;
    memHits = m.hits || [];
  } catch (e) {
    console.warn('[memory] 取上下文失败：' + e.message);
  }
  if (memHits.length) console.log(`[memory] 注入 ${memNote.length} 字，命中 ${memHits.length} 条`);

  /* 事实种子的原料：**最近发生的事**，不是这一问的命中。
     这一步也是漂移唯一可能失败的地方 —— 记忆库空的时候它没什么可说的，
     那时它就该闭嘴，而不是把读数包装成"回忆"。 */
  try {
    factPool = await memory.recent(8);
  } catch (e) {
    factPool = [];
    console.warn('[persona] 取旧事失败：' + e.message);
  }
  /* 漂移：抽 1~2 条与本问正交的旧事。返回空是常态 —— 每轮都说旧事就成了祥林嫂。 */
  const driftNote = persona.drift(goal.kind === 'ask' ? goal.text : '', { turn: s.turn });
  s.driftItems = driftNote.items;
  if (driftNote.items.length) {
    emit(s, { t: 'persona', items: driftNote.items.map((r) => ({ id: r.id, text: r.text })) });
  }

  /* 技能（用户教过的做法）和工具表。两样都每轮刷新一次：
     "以后就这么办"和"装起来吧"都在某一轮里说完，下一轮就该生效 —— 
     重启才生效的约定，用户是看不见的。 */
  let skillNote = '';
  try {
    skillNote = await forge.skillsForPrompt();
  } catch (e) {
    console.warn('[forge] 技能读取失败：' + e.message);
  }
  try {
    const n = await s.tools.reload();
    if (n) console.log(`[forge] 自造工具 ${n} 个可用`);
  } catch (e) {
    console.warn('[forge] 工具表刷新失败：' + e.message);
  }
  /* 冷门组按场景发：这一轮用户没提造工具，那六个工具和它 1500 token 的规程就都不发。
     判据在代码里（coldAllow），不靠模型自觉 —— 它连 needs.net 都填不对。 */
  const allow = coldAllow(goal);
  const guideNote = allow.has('forge') ? FORGE_GUIDE : '';
  /* 身份段在**每次请求**里都出现（它是"你是谁"，不是"这轮用得上什么"）；
     漂移段只在真的抽到东西时才出现。两段都走 ctxNote，不写进历史 ——
     写进历史的话，同一句话会在每一轮的上下文里留一份副本。 */
  const ctxNote = [persona.promptText(), memNote, driftNote.text, skillNote, guideNote]
    .filter(Boolean).join('\n\n');


  /* 意图也要变成一条 user 消息进历史 —— 真模型靠上下文理解"用户刚才做了什么"，
     所以它必须是会话的一部分，不能是旁路通道。 */
  if (goal.kind === 'ask') {
    s.messages.push({ role: 'user', content: goal.text });
    hear(s, goal.text);
    emit(s, { t: 'turn', round: s.turn, kind: 'ask' });
  } else {
    const it = goal.intent || {};
    if (it.kind === 'adjust') s.lastAdjustTo = it.to;
    const line = (INTENT_ZH[it.kind] || (() => '动了一下'))(it);
    s.messages.push({ role: 'user', content: `[手势] ${line}`, intent: it });
    /* 手势也进记录，但它不是"一句话" —— 前端按另一种笔调排（更暗、前缀是括号） */
    hear(s, line, 'i');
    emit(s, { t: 'turn', round: s.turn, kind: 'intent', intent: it });
  }

  /* 记忆命中要说出来。不说的后果是：模型忽然提起三周前的事，
     用户以为它在编 —— 而屏幕上本来能显示"翻到 2 条旧事"。
     **放在 turn 之后**：前端在 turn 上清空那一栏，先发就被清掉了。 */
  if (memHits.length) {
    trace(s, 'note', {
      text: `翻到 ${memHits.length} 条旧事`,
      /* 用 cut 而不是 slice：直接切会在逗号/句号后面断开，
         屏幕上就成了"上次查过 n8n，" —— 一句话没说完的样子。 */
      detail: cut(memHits[0]?.text, 18),
      tone: 'mem',
    });
  }
  if (driftNote.items.length) {
    trace(s, 'note', { text: '想起一件别的事', detail: cut(driftNote.items[0]?.text, 16), tone: 'mem' });
  }

  try {
    let lastSig = '';
    let repeats = 0;
    let nudges = 0;
    /* 步数上限现在默认是 0（不限），设置里可以设。造工具那几轮仍然另算 ——
       那是**任务形状**决定的，不该被一个滑块改掉。 */
    const stepCap = () => {
      const forge = MAX_STEPS_FORGE > 0 ? MAX_STEPS_FORGE : 0;
      const mine = Number(settingsBehavior().maxSteps) || MAX_STEPS || 0;
      const n = s.forgeStep ? (forge || mine) : mine;
      /* 0 / 没设 = 不限。**不是**随便给个 10 —— 那正是这次要拆掉的东西。 */
      return n > 0 ? Math.max(3, n) : Infinity;
    };
    /* ── 这一轮怎么结束 ──
     *
     * **不是"走完 N 步"。** 参考的是几个真跑在生产里的循环：
     *   · Anthropic：`while stop_reason == "tool_use"` —— 退出条件是"模型给出
     *     最终回答"，其它任何停止理由都由应用处理；服务端循环撞上限会回
     *     `pause_turn`，含义是"没做完，接着来"，**不是**结束。
     *   · OpenAI Agents SDK：输出分类成 final / handoff / tool_calls，只有 final
     *     才结束；`max_turns` 是安全网，撞上**抛异常**并带上已有结果。
     *   · LangGraph：`recursion_limit` 撞上抛 `GraphRecursionError`。
     *
     * 它们有一条共同的纪律：**"没有最终输出"是一个必须显式处理的状态**，
     * 不能当成正常返回。
     *
     * 我们以前正是 `for (step < 5)` —— 把安全网当成了正常终点：第 5 步用完
     * 就跳出循环，**从来没有再问过模型"那你说结论"**。用户问"系统里装了什么"，
     * 它查了五次，屏幕上一句话都没有（复现脚本 `.tmp/repro-silent.mjs loop`，
     * 最后竟是"我记得这件事"顶上去的）。这就是"它去查了，然后就没有然后"。
     *
     * 现在只有两条路能结束：
     *   ① 模型不再要工具 —— 它给出了回答（正常终局，`stop` 保持空串）；
     *   ② 没有进展 / 太久 / 上下文满 —— `stop` 记下原因，
     *      出去之后**必须收口**（`finalize()`：关掉工具，再问一次要结论）。
     *
     * **"次数"不在 ② 里。** 默认不设步数上限（`MAX_STEPS=0`），因为长任务本来
     * 就要几十次工具调用；判"该不该停"要看**有没有进展**，不是数了几次。
     * 那条纪律的代价是这一轮可能跑很久 —— 所以配了三样：
     *   · 心跳（`progressLine`）：每 45 秒说一句"第几步 / 多久"，别让长任务看起来像卡死；
     *   · 上下文折叠（`foldToolResults`）：一轮里几十个工具结果会把窗口吃满，
     *     折最老的那几条，结构不动（tool_call_id 留着，永远不会 400）；
     *   · 硬上限可续跑：撞上 `long`/`ctx`/`cap` 时收口会给中途汇报，
     *     并明说「继续」能接着来 —— 历史全在，不是从头再来。
     */
    let step = 0;
    let stop = '';
    const tTurn = Date.now();
    let beat = tTurn + BEAT_MS;
    for (;;) {
      /* 上一轮工具刚跑完就被按了停：这里也要接住，别再多问模型一次 */
      if (s.abortCtl.signal.aborted) { aborted = true; throw ABORT_TURN; }
      if (step >= stepCap()) { stop = 'cap'; break; }
      if (Date.now() - tTurn > TURN_HARD_MS) { stop = 'long'; break; }
      /* 心跳。**长任务最怕的不是慢，是安静** —— 屏幕上粒子在抖、一句话没有，
         和"卡死了"没有区别。这一句几乎不花钱，但它把两件事分开了。 */
      if (Date.now() > beat) {
        beat = Date.now() + BEAT_MS;
        /* 花了多少也一起报（单价未配置时 `cost` 是 null，那就别写）。
           不设步数上限之后，一轮真能花掉几毛钱 —— 这笔钱要在过程中看得见，
           等轮末才显示，人已经觉得被坑了。 */
        let cost = null;
        try { cost = s.meter?.snap?.()?.turn?.cost ?? null; } catch { /* 账本不该挡住对话 */ }
        emit(s, {
          t: 'note',
          message: progressLine({ step, ms: Date.now() - tTurn, acts: s.actN || 0, cost }),
        });
      }
      const at = step;
      step = at + 1;
      emit(s, { t: 'think', on: true, step: at });
      let out;
      const reqMsgs = withMemory(s.messages, ctxNote);
      const schemas = s.tools.schemas(coldTools(allow));
      try {
        out = await s.model.complete({
          messages: reqMsgs,
          tools: schemas,
          /* 第一轮的第一步**强制取证**。
             这不是不信任模型，是"先看再说"属于协议而不是建议：
             便宜模型很容易跳过工具、直接凭上下文编一个读数（实测过：
             它把示例里的 71% 原样抄了出来）。让它自己决定要不要看，
             等于让最不可靠的一环决定"事实从哪来"。
             代价是纯闲聊也要付一次 sys_status —— 一次本地读 /proc，可以接受。 */
          /* 强制取证是为了防止它凭空编读数。但**记忆里已经有答案**时，
             强制调工具反而有害：实测它会去挑一个"看起来相关"的工具（k8s_get），
             拿到与该问题无关的结果，然后什么也不说 —— 记忆就白存了。 */
          toolChoice: at === 0 && goal.kind === 'ask' && !memHits.length ? 'required' : 'auto',
          goal: { ...goal, pendingTo: s.lastAdjustTo },
          signal: s.abortCtl.signal,
        });
      } catch (e) {
        /* 用户按停 / 信号已断：走打断那条路，不当作模型故障 */
        if (e?.aborted || s.abortCtl.signal.aborted) { aborted = true; throw ABORT_TURN; }
        throw e;
      } finally {
        /* 必须放 finally：模型超时或 402 时 await 会抛，写在后面的
           think:off 就永远发不出去 —— 前端会一直停在"低相干度"，
           整个场看起来在抖，像是卡住了，而不是"出错了"。 */
        emit(s, { t: 'think', on: false, step: at });
      }
      recordUsage(s, out, reqMsgs, schemas);

      /* ── 一轮之内的上下文闸 ──
       *
       * 步数不设限之后，吃满窗口的不再是"聊了很多轮"，而是**这一轮干了很多事**：
       * 三十次工具调用、每次回一段 JSON，一轮就能吃掉半个窗口。
       * 而满窗的失败发生在工具跑到一半，用户看到的是"做了一半不动了"。
       *
       * 所以每到水位就折一次最老的工具结果（结构不动，见 history.mjs 的
       * `foldToolResults`）。折不动还超线，才停 —— 停下也带着中途汇报和「继续」，
       * 不是把这一轮判死。 */
      {
        const snap = s.meter?.snap?.();
        if (snap?.limit) {
          const ratio = (snap.ctx.tokens || 0) / snap.limit;
          if (ratio >= CTX_TRIM_AT) {
            const f = foldToolResults(s.messages, { keep: 6 });
            if (f) {
              s.messages = f.messages;
              emit(s, {
                t: 'note',
                message: `上下文 ${Math.round(ratio * 100)}%：把 ${f.folded} 条较早的工具结果折叠了`
                  + '（省下约 ' + Math.round(f.chars / 3) + ' token，要细节可以再查一次）',
              });
            } else if (ratio >= 0.95) {
              stop = 'ctx';
              break;
            }
          }
        }
      }

      /* 空回复重试一次。
         7B 实测会偶尔吐一个空 message（没有 content，也没有 tool_calls）——
         一句话不说，屏幕上就是一片安静的粒子，看起来像"它没听懂"，
         其实是模型这一口气没接上。给它一句提示再问一遍，成功率明显高于
         把这一轮判死。只重试 step 0，免得在本该停下的地方原地打转。 */
      if (at === 0 && !(out.tool_calls || []).length && !String(out.content || '').trim()) {
        emit(s, { t: 'note', message: '模型空回复，重试一次' });
        /* 那一次空回复**也要记账**：它同样发了整份上下文，同样计费。
           上面那次已经记过了，这里只记重试这一次。 */
        const retryMsgs = withMemory(s.messages, (ctxNote ? ctxNote + '\n\n' : '')
          + '（上一次回答是空的。不要解释这件事，直接用一句话回答用户刚才的问题。）');
        try {
          out = await s.model.complete({
            messages: retryMsgs,
            tools: schemas,
            toolChoice: memHits.length ? 'auto' : 'required',
            goal: { ...goal, pendingTo: s.lastAdjustTo },
            signal: s.abortCtl.signal,
          });
        } catch (e) {
          if (e?.aborted || s.abortCtl.signal.aborted) { aborted = true; throw ABORT_TURN; }
          throw e;
        }
        recordUsage(s, out, retryMsgs, schemas);
      }

      const calls = out.tool_calls || [];
      /* ── 它的思考，上屏 ──
       *
       * 这是"思考过程"那栏里**唯一真正是思考**的东西：其余的都是动作
       * （调了哪个工具、画了几层）。模型返回 `reasoning_content` 时这里就有货，
       * 不返回（免费的小模型多半没有）就是空数组，那栏只剩动作 ——
       * 也就是用户说的"看起来很奇怪"的那个状态。
       *
       * 三条约束：
       *   · 每步最多 3 条。8 步 × 4 条会把 250px 高的那栏刷成瀑布，
       *     用户根本来不及读；真正要看的永远是"它一开始怎么想的"。
       *   · 整轮最多 8 条。第 4 步之后的想法多是"再确认一下"，说了也没信息量。
       *   · 一条一行、不带结局符号 —— 它不是"一件事做完了"，是"它此刻在想"。
       */
      if (s.reasonN == null) s.reasonN = 0;
      if (!s.reasonSeen) s.reasonSeen = new Set();
      /* 每步 2 条、整轮 8 条。
         **跨步要去重**：一个"其实每步都想同一件事"的模型（桩就是）会把同一句
         想三遍，屏幕上连着三行一样的话，看起来像卡住了 —— 而它其实在正常跑。 */
      const budget = Math.min(2, 8 - s.reasonN);
      const lines = budget > 0 ? reasonLines(out.thinking, budget) : [];
      for (const ln of lines) {
        /* 判"说过类似的话"而不是"说过同一句话"：实测同一个模型会在不同步里想
           「…应用，挑一个占内存最多…」和「…应用，并挑一个占内存最多…」——
           差一个字，按整句比拦不住，屏幕上连着两行几乎一样的话看着像卡住。 */
        if ([...s.reasonSeen].some((old) => alike(old, ln))) continue;
        s.reasonSeen.add(ln);
        s.reasonN += 1;
        trace(s, 'reason', { text: ln });
      }

      /* 便宜模型会把示例里的记号一起抄出来（"content: ..."、"→ scene_set(...)"），
         也会写一整段带换行和清单的计划。 */
      let rawSpeech = String(out.content || '')
        .replace(/^\s*(content|回答|你说)\s*[:：]\s*/i, '')
        .replace(/^["'「](.*)["'」]$/, '$1')
        /* 取**所有非空行**，不是第一行。
           以前这里是 `.filter(Boolean)[0]` —— 那是"场里只有一行 20 格"时代的写法，
           屏幕上放不下一段话，干脆只留第一句。答案块到 400 字以后，这个 [0] 的
           后果是：模型写了五段，用户只看到第一行（原话："仍然只能看到一行回复"）。
           上一轮只把 40 改成 1200，没动这个 [0]，等于没改 —— 这次一起改掉。 */
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        /* 以自造标注开头的行整行丢掉：`{手势} 把「内存」从 48% 拖到 34%`、
           `【建议】...` —— 那是它给自己写的舞台提示，不是给用户的话。
           实测原话就是这么上屏的（2026-10-22 线上实拍，答案最后一行）。
           只认行首的短标注（≤8 字），免得误伤正文里正常的括号。 */
        .filter((l) => !HEAD_TAG.test(l))
        /* 列表符号、序号都去掉：屏幕不解释 "-" 和 "1." */
        .map((l) => l.replace(/^\s*[-*·]\s*/, '').replace(/^\s*\d+[.、)]\s*/, ''))
        .join('\n')
        /* 先清掉它自己插的图，再截字数 —— 反过来的话 1200 字的额度会被 base64 吃掉，
           真正的那段话一个字都留不下。 */
        .replace(/!\[[^\]]*\]\([^)]*\)?/g, '')
        .replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, '')
        .trim();
      /* 把"它给自己下的指令"从要上屏的那段话里切掉。
         实测（2026-10-22 线上）：正文写完之后它会接着写
         "第 1 步，调 logs_tail 查看 n8n 的最近日志…第 2 步，调 scene_show…"，
         还把参数 JSON 放进 ``` 代码块 —— 全都上屏了。
         那是草稿，不是回答：屏幕是粒子，代码块在点阵里就是一堵乱码墙。 */
      rawSpeech = cleanSpeech(rawSpeech);
      /* 提到工具名的话是"它对自己下的指令"，不是给用户的话。
         实测原话："请调用 scene_ask 把问题问出来" —— 用户看到只会莫名其妙。 */
      /* 也不要 JSON 残片。实测 7B 会把本该是参数的东西写进 content：
         `{"reading":"CPU 21% · 内存 41% · 磁盘 37%","` —— 屏幕上就是这串鬼东西。
         凡是像 JSON 开头的，一律不算说话。 */
      const looksLikeJSON = /^[[{]\s*"?\w+"?\s*:/.test(rawSpeech.replace(/[「」]/g, '"'));
      /* 手势回合干脆不要它说话：这一行该说"代价"，而代价（要重启谁）是系统知道的事，
         模型只会复述用户动作或复述自己的计划。要它表达的地方是 scene_ask 的问题本身。 */
      const isAdjust = s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust';
      /* 工具名 / 旁白那两条只在**短句**上判。
         它们要挡的是"请调用 scene_ask 把问题问出来"这种指令式短句；
         而一段正经回答里提到 fs_scan、sys_status 是正常的说明，整段丢掉就变成
         "它一声不吭"。 */
      const short = rawSpeech.length < 60;
      const junk = looksLikeJSON
        || (short && (TOOL_WORDS.test(rawSpeech) || META_TALK.test(rawSpeech)));
      const speech = (isAdjust || junk) ? '' : rawSpeech.slice(0, 1200);
      /* 一轮可能说一段，不只一句 —— 取舍规则见 putVoice。
         以前这里是 `speech && !s.spoke`：模型先说的那段被 reading 一行读数
         盖掉，屏幕就只剩一行。 */
      const voice = putVoice(s, speech) ? String(speech).slice(0, 1200) : '';
      if (!voice && speech && !s.narrated) {
        /* 只留第一条。实测一轮里模型会补三次旁白，每条的句式都一样，
           观察窗被刷得看不清工具调用 —— 而"它爱说旁白"这件事看一条就够了。 */
        s.narrated = true;
        emit(s, { t: 'note', message: `旁白已咽掉：${speech.slice(0, 24)}` });
      }

      if (!calls.length) {
        if (voice) s.messages.push({ role: 'assistant', content: voice });
        /* 造工具这件事是**多步**的：写元数据 → 贴代码 → 试跑 → 装。
           实测 7B 常常在"读完文档"或"写完元数据"之后就说起客套话收工了 ——
           从用户那边看，就是"它说在做，然后没动静了"。
           所以只要上一件工具的返回里留着 next，就再推它一把（最多两次）。
           这不是替它做决定，是把"你还没做完"这句话说给它听。 */
        if (s.pendingNext && nudges < 2) {
          nudges++;
          s.messages.push({ role: 'user', content: `（还没做完。${s.pendingNext}）` });
          continue;
        }
        /* 没调工具、也没说出能上屏的话（空回复，或整段被清洗掉）——
           这同样不是"它说完了"，是"这一口气没接上"。 */
        if (!voice && !s.spoke) stop = 'silent';
        break;
      }

      /* 同一组调用连着来 = 模型卡住了（它没意识到"已经做过"）。
         直接停比跑满 8 步好：多出来的那几次会把同一个动画重播八遍，
         用户看到的是"界面上有东西在抽"，而不是"模型在思考"。 */
      const sig = calls.map((c) => `${c.function.name}:${c.function.arguments}`).join('|');
      if (sig === lastSig) {
        repeats++;
        /* 允许连一次：换了代码再试一次时，tool_try 的参数**本来就是一样的**
           （"同一个工具、同一组参数、新版本"），按一次就掐会把它自己的正常重试
           判成卡住。上限仍是 8 步，不会因此转圈。 */
        if (repeats >= 2) {
          /* 原地打转同样是"没说完就断了"：以前这里只发一条 note 就 break，
             用户看到的是思考栏里同一行动作闪了三遍然后安静下来。
             现在记下原因，出去收口（让模型用已经拿到的东西说一句）。 */
          stop = 'stuck';
          emit(s, { t: 'note', message: '模型重复了同一组调用，这一轮就此收口' });
          break;
        }
      } else {
        lastSig = sig;
        repeats = 0;
      }

      s.messages.push({ role: 'assistant', content: out.content || '', tool_calls: calls });

      for (const c of calls) {
        const name = c.function.name;
        /* 造工具是长跑：一旦这一轮动了 tool_* / skill_save，步数上限放宽。
           其余情况按 5 步收 —— 每多一步都是一次完整的上下文重发。 */
        if (/^(tool_|skill_save)/.test(name)) s.forgeStep = true;
        const argsRaw = safeJSON(c.function.arguments);
        /* 一条消息里有多个 tool_call 时，**第一个的参数会被服务端截断**
           （实测：tool_write 的 code 直接没了，只剩 name/description/params）。
           这是拼装层的行为，关不掉（parallel_tool_calls: false 被静默忽略）。
           所以这里把因果说出来：不说的话，模型看到的是"少了 code"，
           会以为是自己的 JSON 写错，再发一遍还是两个调用，就这么转圈。 */
        const multi = calls.length > 1
          ? `（同一条消息里还有 ${calls.length - 1} 个调用没执行：一条消息只能有一个 tool_call，`
            + '多个会让服务端把第一个的参数截断。下一次只发这一个。）'
          : '';
        const brokenArgs = argsRaw === null;
        /* 模型忘了填的参数在这里补（只补 tool_* 的 name），而且必须在**审批之前**补：
           卡片上写着"把 x 装起来？"，用户才知道自己在批什么。 */
        const args = s.tools.fill ? s.tools.fill(name, brokenArgs ? {} : argsRaw) : (brokenArgs ? {} : argsRaw);
        const id = c.id;
        const t0 = Date.now();
        emit(s, { t: 'tool', id, name, args, state: 'run' });
        /* 「它现在在干什么」—— 和上面那条是同一件事的两个听众：
           tool 事件给观察窗和状态条（要原始参数），trace 给用户（要人话）。 */
        const tl = toolLine(name, args);
        trace(s, 'step', { id, text: tl.verb, detail: tl.detail || undefined, tool: name });

        let result;
        try {
          const badArgs = brokenArgs ? '' : (s.tools.check ? s.tools.check(name, args) : '');
          if (badArgs) {
            result = { error: badArgs };
          } else if (brokenArgs) {
            /* 不执行，直接告诉它为什么 —— 这类失败百分之九十是"代码太长被截断"，
               不点名的话，它会以为参数没错，只是工具没装好。
               但**只有 tool_* 才是"代码太长"**：实测 sys_status 发了个坏参数，
               收到的是"把脚本压到 40 行以内、再调一次 tool_write" ——
               它当时没有脚本，这条建议把它带偏了一整轮（多花一次 10k 上下文）。 */
            result = {
              error: '参数不是合法 JSON'
                + (calls.length > 1 ? '：一条消息里有多个 tool_call 时，第一个会被截断。' : '（少了个括号）')
                + (name.startsWith('tool_')
                  ? ' 把脚本压到 40 行以内、一条消息只发一个调用，再调一次 tool_write。'
                  : ` 重新发一次 ${name}，只发这一个调用，参数写完整。`),
            };
          } else if (s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust' && s.tools.level(name) === 'danger') {
            /* 「拖一下」只是意图，决不能在同一个回合里直接变成执行。
             这是整套交互里最要紧的一条语义（用户明确要求过：向下拖内存 =
             "我想降内存"，此时应该**问**他，而不是替他做）。
             写成代码而不是提示词，是因为它不该随模型好坏而变：
             弱模型会跳过问话直接调 mem_trim（实测过），强模型也可能在某次偷懒。
             等用户在分叉上点了 yes（那是 pick 手势），才放行。 */
            result = {
              error: '拖动只是意图，不是命令。用 scene_ask 把问题问出来就停手，等用户点选项 —— '
                + '这一回合不要再执行任何动作。',
            };
          } else if (name === 'scene_ask' && s.goal?.kind !== 'intent') {
            /* scene_ask 是给手势回合用的（"你拖了，要不要真压下去？"）。
               普通问答里模型会照抄示例、在没有拖动的场面上换一个问题 ——
               用户会看到一句跟他刚才说的话无关的质问。问答回合的问题走 scene_show 的 ask 字段。 */
            result = { error: 'scene_ask 只用于手势回合。要问问题，用 scene_show 的 ask/yes/no 字段重新铺一屏。' };
          } else if (asksOnly(s) && s.tools.level(name) === 'danger') {
            /* 疑问不是授权。
               实测：用户问「n8n 现在正常吗」，7B 查完状态顺手调了 k8s_restart，
               把 n8n 重启了一遍 —— 它把"问情况"读成了"帮我处理"。
               审批门拦不住这件事：按钮上写着"重启 n8n？"，用户很容易顺手点允许，
               而他从头到尾没要求过重启。
               所以判据放在**用户的这句话**上：话里有动作（删/挪/重启/写）才算委托；
               只有疑问（吗/怎么/为什么/正常吗）就只准看、不准动 —— 要动先问。 */
            result = {
              error: '用户这句是在问情况，不是让你动手。先用 scene_show 的 ask 把'
                + '「要不要我这么做」问出来，等他点了再说 —— 这一回合不要执行任何改变。',
            };
          } else if (needsGate(s, name)) {
            const ok = await requestApproval(s, { id, name, args });
            result = ok ? await s.tools.exec(name, args) : { denied: true, reason: 'user refused' };
          } else {
            result = await s.tools.exec(name, args);
          }
        } catch (e) {
          result = { error: String(e?.message || e) };
        }

        /* ── 另外两个输出通道 ──
           渲染树进 DOM、绘画进粒子，两者都不改变世界，所以都不进审批。
           但它们的**体积**不能进模型上下文（上面已经切成一句摘要）。 */
        if (result && result.ok && result.surface) {
          s.lastSurface = result.surface;
          s.drew = true;          // 铺过东西了，兜底屏不该再来盖一层
          emit(s, { t: 'surface', op: 'set', spec: result.surface });
        }
        if (result && result.ok && result.closeSurface) {
          s.lastSurface = null;
          emit(s, { t: 'surface', op: 'close' });
        }
        if (result && result.ok && result.draw) {
          /* 画也算"这一屏已经有内容"。不标的话，兜底屏会在画刚上去之后把仪表铺过来 ——
             用户看到的是自己要求画的东西被一块读数顶掉。 */
          if (!result.draw.stop) s.drew = true;
          emit(s, { t: 'draw', spec: result.draw });
        }
        /* 生成的图：这一屏的主角，单独一条事件。
         *
         * 三个刻意的决定：
         *   ① **不进 scene**。场景层是模型能画的东西，图是工具的产物 ——
         *      混进去等于给"任意 URL 上屏"开一个口子（`scene.schema` 里根本没有
         *      image 这种 kind，也不该有）。
         *   ② `s.drew` 置上：兜底屏不能把刚画好的图盖掉。
         *   ③ 存进 `s.lastImage`：刷新/重连之后要能还原（和 `lastSceneSpec` 同一个理由），
         *      否则用户去倒杯水回来，屏上是空的。 */
        if (result && result.ok && result.image?.url) {
          s.drew = true;
          s.lastImage = {
            url: result.image.url,
            width: result.image.width,
            height: result.image.height,
            seed: result.seed,
            ms: result.ms,
            turn: s.turn,
          };
          emit(s, { t: 'image', ...s.lastImage });
          /* 它自己也该说一句（"画好了，512×512，6 步"）——
             不说的话，屏上多了一张图而它一声不吭，用户会以为是别的什么弹出来了。 */
          if (result.say) putVoice(s, String(result.say));
        }

        /* 一行日志：Pod 里没有别的观察窗，出问题时只能靠它。
           画/渲染树只记层数，不记内容 —— 那些可能有几十 KB。 */
        if (result) {
          const tag = result.error ? `err ${String(result.error).slice(0, 70)}`
            : result.draw ? `draw ${result.draw.stop ? 'stop' : `${result.draw.layers?.length || 0}层`}`
              : result.surface ? `surface ${result.surface.root?.type || ''}`
                : result.op ? `scene ${result.op}` : 'ok';
          console.log(`[tool] ${name} ${Date.now() - t0}ms ${tag}`);
          /* 这一轮干过什么。它**不进**模型上下文（那会让模型变成在念流水账），
             只在回合结束时交给记忆抽取：审计日志是"真实发生过的事"，
             而真实发生过的事才是 L0 记忆该有的种子。 */
          s.actN = (s.actN || 0) + 1;
          if (s.acts.length < 12) {
            /* ok/denied 一起带上：人格层只收"造成了后果的动作"。
               被拒的、报错的调用没有改变任何东西，记下来只会在下一轮变成
               "我试过但失败了"——那是日志，不是经历。 */
            s.acts.push({
              name,
              brief: JSON.stringify(args ?? {}).slice(0, 70),
              note: summarize(result),
              /* 工具不一定带 ok 字段（k8s_restart 返回的是 {app, restarted, note}）——
                 所以判"成功"看的是**没被拒、没报错**，而不是有没有 ok:true。 */
              ok: !result?.denied && !result?.error && result?.ok !== false,
              denied: !!result?.denied,
            });
          }
        }

        /* 场景工具不是"数据"，是给眼睛的指令 —— 直接下发，不进工具结果里让模型再读一遍 */
        if (result && result.ok && result.op) {
          /* patch 打在一个**不存在的层**上会被静默丢掉（`scene.patch` 找不到就 continue）。
           *
           * 实测（2026-10-22 线上）：屏幕上是三个仪表，模型调 `scene_ask` 问
           * 「要在 Navidrome 中查找《千与千寻》吗」，op 是 patch id=ask ——
           * 当场没有 ask 那一层，于是**屏幕上什么都没出现**，而模型以为问过了，
           * 下一轮就按"用户已经回答"往下走。用户看到的是"它说了好多个选项，
           * 但屏幕上没有"。
           *
           * 所以这里补一层：patch 里出现新 id 时，把这一屏**升级成 set**
           * （旧层保留 + 新层加进去）。视角上是从"三个仪表"变成"三个仪表 + 一个问题"，
           * 而不是什么都不发生。 */
          if (result.op === 'patch' && Array.isArray(result.ops) && result.ops.length) {
            const known = new Set((s.lastSceneSpec?.layers || []).map((l) => l.id));
            const fresh = result.ops.filter((o) => o.id && !known.has(o.id));
            if (fresh.length) {
              const merged = patchToSpec(s.lastSceneSpec, result.ops);
              const norm = normalizeSpec(merged);
              if (norm.spec) {
                result = { ...result, op: 'set', spec: norm.spec, ops: undefined, upgraded: true };
              }
            }
          }
          /* 曲线要延续。
           *
           * 实测：系统先铺的兜底屏带了一条 CPU 曲线，模型随后用 scene_show
           * 重铺一屏（它只想换个 reading），参数里没有 trend —— 于是曲线那一层
           * 直接消失，用户看到的是"已经在那儿的东西被溶解掉了"。
           * 这比一开始就没有曲线更糟：它像是界面在丢东西。
           *
           * 所以 scene_show 默认继承上一屏的曲线。模型真的不要曲线时，
           * 用 scene_set 明确给一屏没有 trace 的 spec。 */
          if (name === 'scene_show' && result.op === 'set' && result.spec && s.lastSceneSpec) {
            const prev = s.lastSceneSpec.layers?.find((l) => l.kind === 'trace');
            const has = result.spec.layers.some((l) => l.kind === 'trace');
            if (prev && !has) result.spec = { ...result.spec, layers: [...result.spec.layers, prev] };
          }
          /* 同一屏连铺两遍 = 模型在原地打转（实测：它会为了"更完整"再铺一次，
             屏幕上就是同一屏反复溶解重组）。判重放在服务端而不是提示词里：
             "做过没有"是状态问题，模型看不见自己的历史，服务端看得见。 */
          if (result.op === 'set' && result.spec) {
            const sig = JSON.stringify(result.spec.layers);
            s.sets = (s.sets || 0) + 1;
            /* 一轮只铺一次。
             *
             * 实测：模型铺完"两仪表 + 曲线"后，会再铺一次"三仪表 + 曲线"
             * （它觉得更完整）。屏上看到的是**同一屏又溶解重组了一遍** ——
             * 对用户来说什么都没变，只是闪了一下。
             *
             * 判"完全一样"不够（这次多了一个 gauge 就绕过去了），
             * 改成按次数：一轮一次。要换屏是下一个回合的事。 */
            /* 但"次数"这条对**系统铺的首屏**不适用 —— 模型覆盖首屏是设计好的。
               （首屏不占 s.sets，所以这里 s.sets 已经是模型自己的次数。） */
            if (result.upgraded) {
              /* 这条是从 patch 升级来的（新层），本来就不是"重铺一遍" */
              s.lastSpecSig = sig;
            } else if (sig === s.lastSpecSig) {
              result.duplicate = true;
              result.hint = '这一屏和现在屏幕上的一样，不要再铺一次';
            } else if (s.sets > 1) {
              result.duplicate = true;
              result.hint = '这一轮已经铺过一屏了。屏幕上已经是你要表达的东西，'
                + '多铺一次只会让它重新溶解一遍。停在这里，把决定权交给用户。';
            } else if (s.painted && s.lastSceneSpec && shrinks(result.spec, s.lastSceneSpec)) {
              /* 屏不能越铺越少。
                 实测：系统首屏是"三仪表 + 曲线"，模型覆盖时只给"两仪表 + 曲线"，
                 磁盘那格就凭空消失了。用户看到的是**界面在丢东西**，
                 而模型以为自己"重新组织了信息"。 */
              result.duplicate = true;
              result.hint = '这一屏比现在屏幕上的内容更少，铺上去等于把东西擦掉。'
                + '要么给出更多信息，要么就别动它。';
            } else {
              s.lastSpecSig = sig;
            }
          }
          /* reading 只是**候选之一**，不是"后到即盖"。
             它常常只有一行读数（"CPU 18% · 内存 41%"），而模型在 content 里
             已经说了一段完整回答 —— 直接覆盖的话，屏幕就只剩那一行读数。
             取舍规则见 putVoice。 */
          if (!result.duplicate && result.say) putVoice(s, result.say);
          if (!result.duplicate) {
            s.drew = true;
            /* 记住"眼睛现在看到的东西"，供刷新/重连时原样还原。
               patch 不带完整 spec，所以要把它叠在上一屏之后记着 ——
               否则恢复出来的是"换问题之前"的那一屏，比空白更让人困惑。 */
            if (result.op === 'set' || result.op === 'transition') {
              s.lastSceneSpec = result.spec;
              s.postOps = [];
            } else if (result.op === 'patch' && Array.isArray(result.ops)) {
              s.postOps = [...(s.postOps || []), ...result.ops].slice(-8);
            }
            emit(s, { t: 'scene', op: result.op, spec: result.spec, ops: result.ops, kind: result.kind, at: result.at });
          } else {
            emit(s, { t: 'note', message: `重复的整屏已忽略：${result.hint}` });
          }
        }

        /* ── 写完代码自动过一遍反方 ──
           放在这里（而不是工具内部）是因为它要**改 `result`**：审出来的问题必须跟着
           这次工具调用的结果一起回给模型，否则它看完成功就往下走了。
           放在 forContext 之前：这段结果没有 surface/draw，forContext 就是 result 本身，
           所以 review 会原样进上下文 —— 这正是我们要的。 */
        if (result && !result.error) {
          const rv = await autoReviewCode(s, name, args, result).catch(() => null);
          if (rv) result = { ...result, review: rv };
        }

        /* 渲染树 / 绘画同样不是"数据"，是给眼睛的指令。
           但**必须**把体积从上下文里切掉：一屏表格 20KB，回灌给 7B 模型
           就是把它的窗口填满，后面几轮全在复读表头。 */
        /* 图只回一句"画好了，多大"：URL 是给前端用的，进上下文只会被模型
           原样念出来（屏幕上就是一串 /api/comfy/img?filename=…）。 */
        const forContext = result?.surface ? { ok: true, shown: 'surface' }
          : result?.closeSurface ? { ok: true, closed: true }
            : result?.image ? { ok: true, drawn: 'image', width: result.image.width, height: result.image.height, seed: result.seed }
              : result?.draw ? { ok: true, drawn: result.draw.stop ? 0 : (result.draw.layers?.length || 0) }
                : result;
        /* 失败的调用把"多调用"这条因果一起回给模型 —— 这是它唯一能改对的信息。 */
        const ctxObj = forContext && typeof forContext === 'object' ? forContext : { r: forContext };
        const ctxContent = multi && (result?.error || result?.ok === false)
          ? JSON.stringify({ ...ctxObj, hint: multi })
          : JSON.stringify(forContext);
        s.messages.push({ role: 'tool', name, tool_call_id: id, content: ctxContent });
        emit(s, { t: 'tool', id, name, state: result?.denied ? 'denied' : result?.error ? 'err' : 'ok', ms: Date.now() - t0, note: summarize(result) });
        /* 结局补到同一行上，而不是再开一行 —— 一行工具 = 一件事+它的下场。
           失败的那行 `note` 通常是"为什么失败"（模型没给参数、参数不是 JSON），
           那正是用户最需要看见的一句。 */
        trace(s, 'end', {
          id, ms: Date.now() - t0,
          status: result?.denied ? 'denied' : result?.error ? 'err' : 'ok',
          note: summarize(result) || undefined,
        });

        /* 记下最近一次的真实数据。它不是给模型的上下文，是给兜底用的：
           模型没铺屏时，系统要能自己画出来，画得准的前提是它拿着原始读数。 */
        if (name === 'sys_status' && result?.cpu != null) {
          s.lastStatus = result;
          s.statusTurn = s.turn;
          /* 应用状态现在跟着 sys_status 一起回来（合并成一次往返），
             所以兜底屏要用的 lastApps 也从这里取。留着 app_list 那条分支
             只是为了让旧会话恢复出来的行为不变。 */
          if (Array.isArray(result.apps)) { s.lastApps = result.apps; s.appsTurn = s.turn; }
        }
        if (name === 'app_list' && Array.isArray(result?.apps)) { s.lastApps = result.apps; s.appsTurn = s.turn; }
        /* 官方 CLI 那条路也要登记，否则"模型空回复"时系统不会兜底：
           它只认 sys_status / app_list 这两个名字，而模型现在会先调 olares。
           实测症状：模型调完 olares（3 个应用、4.5 秒、日志 ok），
           第二轮吐空 → 屏幕上一句话都没有，而数据明明已经拿到了。 */
        if (name === 'olares' && result && !result.error) {
          if (result.apps?.length) { s.lastApps = result.apps; s.appsTurn = s.turn; }
          if (result.physical) {
            const ph = result.physical;
            s.lastStatus = {
              cpu: ph.cpu?.pct, mem: ph.memory?.pct, disk: ph.disk?.pct,
              cores: ph.cpu?.total,
              memTotal: ph.memory?.total, memUsed: ph.memory?.value,
              /* 兜底屏的仪表要 0~1；CLI 给的就是 0~1，缺了就别猜 */
            };
            s.statusTurn = s.turn;
          }
        }
        /* 文件类问题（"什么占地方"、"下载了什么"）的答案是**文件**，不是仪表。
           标一下，兜底屏就别再拿内存读数去凑 —— 实测它会给"磁盘什么最占地方"
           铺出三个内存百分比，"n8n 占 2%"，语义全错而且看不出来。 */
        if (name.startsWith('fs_')) { s.fsTurn = s.turn; }
        /* 兜底要用的原始结果。只在有内容时覆盖 —— 空目录不算"有东西可铺"。
           而且**各自记自己的回合**：fs_move 也会把 fsTurn 置上，如果用 fsTurn
           判断"这轮扫过盘吗"，一次移动就会把上一轮那张扫描表翻出来。 */
        /* 自造工具：装好了要有一屏（否则"装起来了"只是屏幕上飘过的一句话，
           用户不知道它叫什么、会碰什么、下次怎么用），跑挂了也要有一屏
           （错误全文在日志里，用户看不到，也看不懂）。 */
        /* 下一步该干什么，由工具自己说（forge 的返回值里带 next）。
           它会被用来"推模型一把"——见下面回合结束那段。 */
        if (result?.next) s.pendingNext = String(result.next);
        if (result?.missing) s.pendingNext = `先用 tool_code 写代码。${result.next || ''}`.trim();
        if (name === 'tool_keep' && result?.ok) { s.lastKept = result; s.keepTurn = s.turn; s.pendingNext = ''; }
        if (name === 'tool_try' && result?.ok && result?.ok !== false && !result?.error) s.pendingNext = '试跑通了，可以 tool_keep 把它装起来';
        if ((name === 'tool_try' || s.tools.isDynamic?.(name)) && result && result.ok === false) {
          s.lastToolErr = { name: String(args?.name || name), error: String(result.error || '跑了但没成') };
          s.toolErrTurn = s.turn;
        }
        if (name === 'fs_scan' && Array.isArray(result?.items) && result.items.length) {
          s.lastScan = result; s.scanTurn = s.turn;
        }
        if (name === 'fs_list' && Array.isArray(result?.entries) && result.entries.length) {
          s.lastList = result; s.listTurn = s.turn;
        }
        if (name === 'k8s_get' && result?.app) { s.lastDiag = result; s.diagTurn = s.turn; }
        /* 记忆类工具各自记自己的回合：拿"这轮问过记忆"去判断"这轮看过文件"会铺错屏 */
        if (name === 'memory_stats' && result?.ok) { s.lastMemStats = result; s.memTurn = s.turn; }
        if (name === 'memory_recall' && result?.ok) { s.lastMemHits = result; s.memTurn = s.turn; }

        /* ── 渐进首屏 ──
           数据到手（1~2 秒）就先按真实读数铺开，不等模型想完整屏（4~9 秒）。
           用户看到的是"屏在长"，而不是"盯着一片抖动的粒子等它想"。
           模型后面自己铺的那一屏会盖掉它 —— 那才是最终形态。 */
        /* 只要**本轮**读到了 status 就够铺了。不必等 app_list ——
           实测模型经常只调 sys_status 就开始说话，卡着等 app_list
           会让首屏白白晚 1.5 秒。应用列表是"补一句谁在吃"，不是首屏的前提。
           但必须是本轮的：上一轮留下的 CPU 读数在"我装了哪些应用"这种问题里
           完全不相干，铺上去等于答非所问。 */
        if (!s.painted && !s.drew && s.goal?.kind === 'ask' && s.statusTurn === s.turn) {
          const line = `CPU ${Math.round((s.lastStatus.cpu ?? 0) * 100)}% · 内存 ${Math.round((s.lastStatus.mem ?? 0) * 100)}%`;
          const built = defaultOverview(s.lastStatus, s.lastApps || [], line, await trendSeries(s.tools), { note: false });
          if (built) {
            s.painted = true;
            s.drew = true;
            /* 注意这里**不占** s.sets 的额度。
               这一屏是系统铺的，模型还没发言；如果它占了额度，模型随后
               想铺的那一屏就会被判成"重复"而拦掉 —— 屏会永远停在兜底版。
               实测踩过：模型想补一句结论，结果被拦，用户看到的是没有结论的屏。 */
            s.lastSceneSpec = built.spec;
            s.lastSpecSig = JSON.stringify(built.spec.layers);
            s.postOps = [];
            if (!s.spoke) { s.spoke = true; s.lastLine = line; speak(s, line); }
            emit(s, { t: 'scene', op: 'set', spec: built.spec });
            emit(s, { t: 'note', message: '数据到手，先铺一屏；模型随后补充' });
          }
        }
      }

      /* 手势回合里，只要把问题问出去了就停 —— 球在用户那边。
         不写这条，模型会接着"那我先执行吧"，然后在拦截和重试之间来回撞。 */
      if (s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust' && s.drew) {
        emit(s, { t: 'note', message: '已经把问题问出去了，这一轮到此为止' });
        break;
      }
    }

    /* ── 收口 ──
       走到这里，如果 `stop` 有值，说明这一轮**不是模型说完的**：
       预算用尽 / 墙钟到点 / 原地打转 / 空回复。那就再问它一次结论。

       这一步是整件事的重点。没有它，用户看到的就是"它去查了，然后没有然后" ——
       而屏幕上的最后一句可能是毫不相干的兜底（实测：问"系统里装了什么"，
       它最后说"我记得这件事"）。 */
    if (stop) {
      await finalize(s, stop, ctxNote, step);
      /* 停下的**不是**结束：长任务被硬上限拦下时，历史里全都是查到的结果，
         用户一句「继续」就能接着走。不说这句话，他会以为这轮已经收尾了。 */
      const hint = resumeHint(stop);
      if (hint) emit(s, { t: 'note', message: hint });
    }

    /* 手势回合里把话补上：问题已经问出去了，但那一行字不能空着 */
    if (s.drew && !s.spoke && s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust') {
      s.spoke = true;
      speak(s, `压到 ${Math.round((s.goal.intent.to ?? 0) * 100)}% 要重启占内存最多的那个`);
    }

    /* ── 兜底 1：拖了仪表，模型却没问 ──
       手势路径上模型最容易"直接动手"或"什么都不做"。前者被上面的协议拦住了，
       后者会留下一片空白 —— 而这时用户的手还停在仪表上，等他一个回应。 */
    if (!s.drew && s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust') {
      const it = s.goal.intent;
      const to = Math.round((it.to ?? 0) * 100);
      if (!s.spoke) {
        s.spoke = true;
        speak(s, `压到 ${to}% 要重启占内存最多的那个`);
      }
      /* **这里以前是直接 emit 一个 patch**，而屏幕上通常只有仪表、没有分叉 ——
         patch 打在不存在的层上会被静默丢掉，于是"系统代问"也什么都没问出来。
         用户看到的是：拖了一下仪表，屏幕没反应，它说了一句话就没下文。
         所以走同一个"有就改、没有就长一个"的入口。 */
      askOnScreen(s, {
        id: 'ask',
        label: `压到 ${to}%？`,
        options: [{ id: 'yes', label: `压到 ${to}%` }, { id: 'no', label: '算了' }],
      });
      emit(s, { t: 'note', message: '模型没有把问题问出来，由系统代问' });
    }

    /* ── 兜底 2：模型看了数据却没铺屏 ──
       实测四个免费模型都会栽在这一步（详见 tools.mjs 的 defaultOverview）。
       没有这一层，用户问一句"机器怎么卡"，最后屏幕上什么都没有。 */
    /* 兜底也只认**本轮**取到的数据。跨回合沿用的读数用在这类"先铺一下"的场合
       会答非所问：问"装了哪些应用"，屏幕上却是上一轮的 CPU 曲线。 */
    const freshStatus = s.statusTurn === s.turn;
    const freshApps = s.appsTurn === s.turn;

    /* 文件类问题：兜底给**表**，不给仪表。
       "磁盘上什么最占地方"的正确形态是一列文件，不是三个内存百分比 ——
       之前这里没分流，模型兜底铺出来的屏语义全错（n8n 占 2% 磁盘？），
       而且数字是真的，所以看起来特别像回事。 */
    const sc = s.scanTurn === s.turn ? s.lastScan : null;
    const ls = sc ? null : (s.listTurn === s.turn ? s.lastList : null);
    if (!s.drew && (sc || ls)) {
      const spec = sc
        ? (sc.totalBytes === 0
          ? {
            title: '这儿是空的',
            subtitle: `${sc.path || '~'} · 共 0B`,
            /* 一张全是 0B 的表看起来像"没查到"，不如直说 */
            root: { type: 'text', text: '这几个目录里都没有文件。' },
          }
          : {
            title: '最占地方的几项',
            subtitle: `${sc.path || '~'} · 共 ${sc.totalText}`,
            root: {
              type: 'table',
              head: ['名字', '占用'],
              rows: sc.items.map((i) => [i.path || i.name, i.sizeText]),
            },
          })
        : {
          title: `${ls.path || '~'} 里有什么`,
          subtitle: `共 ${ls.total} 项`,
          root: {
            type: 'table',
            head: ['名字', '大小', '日期'],
            rows: ls.entries.map((e) => [e.name, e.dir ? '目录' : (e.sizeText || '—'), e.mtime || '']),
          },
        };
      s.drew = true;
      emit(s, { t: 'surface', op: 'set', spec });
      emit(s, { t: 'note', message: '模型没给这一屏，由系统按文件结果铺了一张表' });
    }

    /* 诊断类问题：兜底给一张"证据卡"，不留空屏。
       "n8n 正常吗"这种问题，正确答案就是几行事实（状态、就绪、重启次数、
       容器等没等待、最近事件）。模型只调了 k8s_get 就说话时，屏幕上原本什么都没有 ——
       而这几行恰好是它嘴里那句话的依据。 */
    const dg = s.diagTurn === s.turn ? s.lastDiag : null;
    if (!s.drew && dg && !sc && !ls) {
      const up = dg.upH == null ? ''
        : dg.upH >= 1 ? `已运行约 ${Math.round(dg.upH)} 小时`
          : dg.upH * 60 >= 1 ? `已运行约 ${Math.round(dg.upH * 60)} 分钟` : '刚起来不到 1 分钟';
      const items = [{
        title: `${dg.state === 'running' ? '运行中' : (dg.state || dg.phase || '状态未知')}`,
        sub: [`就绪 ${dg.ready || '?'}`, `重启 ${dg.restarts ?? 0} 次`, up].filter(Boolean).join(' · '),
      }];
      if (dg.memMB) items.push({ title: `占内存 ${dg.memMB} MB` });
      for (const c of dg.containers || []) {
        if (c.waiting?.reason) {
          items.push({ title: `${c.name}：卡在 ${c.waiting.reason}`, sub: c.waiting.message || '', icon: '!' });
        } else if (c.lastTerminated?.reason && c.lastTerminated.reason !== 'Completed') {
          items.push({ title: `${c.name}：上一次是 ${c.lastTerminated.reason}`, sub: `退出码 ${c.lastTerminated.exitCode}` });
        }
      }
      /* 只要 Warning。Created / Started / Pulled 是每次启动都有的例行事件，
         铺出来就是四行噪音 —— 用户问"正常吗"，答案不该是"它被创建过"。 */
      const warns = (dg.events || []).filter((e) => e.type === 'Warning').slice(0, 4);
      for (const e of warns) {
        items.push({ title: `${e.reason}（${e.count} 次）`, sub: e.message, icon: '!' });
      }
      if (!warns.length) items.push({ title: '没有异常事件', sub: '最近这个 pod 没报错' });
      s.drew = true;
      emit(s, {
        t: 'surface', op: 'set',
        spec: { title: dg.app || '应用状态', subtitle: `${dg.ns || ''} · ${dg.pod || ''}`.trim(), root: { type: 'list', items } },
      });
      emit(s, { t: 'note', message: '模型没给这一屏，由系统按诊断结果铺了一张卡' });
    }

    /* 记忆类问题：兜底也要有一屏。
       "你记得什么"最糟的答案是屏幕上只有一行字和一片空粒子 —— 那看起来像"什么都不记得"。
       这里直接把 stats 铺成表，数字都是服务端自己算的，不经过模型转述。 */
    const ms = s.memTurn === s.turn ? s.lastMemStats : null;
    if (!s.drew && ms && ms.facts) {
      s.drew = true;
      emit(s, {
        t: 'surface', op: 'set',
        spec: {
          title: '记得的事',
          subtitle: `${ms.facts} 条记忆 · ${ms.entities} 个实体 · ${ms.communities} 个社群`,
          root: {
            type: 'table',
            head: ['主题', '条数', '最近'],
            rows: (ms.themes || []).map((t) => [t.label, String(t.n), t.last || '—']),
          },
        },
      });
      emit(s, { t: 'note', message: '模型没铺这一屏，由系统按记忆统计铺了一张表' });
    }
    const mh = s.memTurn === s.turn ? s.lastMemHits : null;
    if (!s.drew && mh && mh.found) {
      s.drew = true;
      emit(s, {
        t: 'surface', op: 'set',
        spec: {
          title: '记忆里的这几条',
          subtitle: `共 ${mh.found} 条`,
          root: { type: 'list', items: mh.facts.map((f) => ({ title: f.text, sub: f.when })) },
        },
      });
      emit(s, { t: 'note', message: '模型没铺这一屏，由系统按回忆结果铺了一张卡' });
    }

    /* 记忆兜底：模型什么都没说、什么都没铺，但这轮从记忆里取到了东西。
       沉默是最坏的答案 —— 用户会以为它不记得。这里把取到的那几条摆出来。

       但要**多加一个前提**：这一轮它压根没动手。一旦它调过工具（`s.acts` 非空），
       说明问的是别的事、只是没查成 —— 这时候摆一段旧记忆就是答非所问，
       比空白更糟：用户会以为它答了，只是答歪了。
       （实测原话：问"系统里装了什么"，屏幕上最后一句是"我记得这件事"。
       那条兜底以前只看"它没说话"，不看"它有没有在查别的东西"。） */
    if (!s.spoke && !s.drew && !(s.acts || []).length && memHits.length && s.goal?.kind === 'ask') {
      s.drew = true;
      s.spoke = true;
      speak(s, '我记得这件事');
      emit(s, {
        t: 'surface', op: 'set',
        spec: {
          title: '记忆里是这么记的',
          subtitle: `来自以前的会话 · ${memHits.length} 条`,
          root: { type: 'list', items: memHits.map((h) => ({ title: h.text, sub: h.when })) },
        },
      });
      emit(s, { t: 'note', message: '模型没有回答，由系统把记忆摆出来' });
    }

    /* 自造工具的两头。装起来了要看到它是什么；跑挂了要看到那句话。
       这两件事都不该只活在"它说了一句"里 —— 用户第二天想问"我让它装过什么"，
       唯一的答案是屏幕上的这一屏。 */
    const kept = s.keepTurn === s.turn ? s.lastKept : null;
    if (!s.drew && kept) {
      const m = s.tools.all?.[kept.name] || {};
      s.drew = true;
      emit(s, {
        t: 'surface', op: 'set',
        spec: {
          title: `装好了：${kept.name}`,
          subtitle: `v${kept.version || 1} · ${needsText(m.needs)}`,
          root: {
            type: 'list',
            items: [
              { title: String(m.describe || '').replace(/（自造工具 v\d+）$/, ''), sub: '现在可以直接让它做这件事' },
              { title: '代码在 ~/Agent/tools/' + kept.name, sub: '想改就改，改完它会重新问你要不要跑' },
            ],
          },
        },
      });
    }
    const te = s.toolErrTurn === s.turn ? s.lastToolErr : null;
    if (!s.drew && te) {
      s.drew = true;
      emit(s, {
        t: 'surface', op: 'set',
        spec: {
          title: `${te.name} 没跑成`,
          subtitle: '这是它自己报的错',
          root: { type: 'code', lang: 'text', code: te.error.slice(0, 1200) },
        },
      });
    }

    if (!s.drew && (freshStatus || freshApps) && s.goal?.kind === 'ask') await salvage(s);

    /* ── 不变量：这一轮不许"什么都没有" ──
     *
     * 上面那一长串兜底都是"按遇到的事铺一屏"，每一条都有自己的前提
     * （本轮读过状态 / 列过文件 / 命中记忆…）。**只要前提全不成立，
     * 它们就一起不触发** —— 而用户那边看到的是同一件事：它去查了，然后没然后。
     *
     * 所以最后留一道闸：到这儿还没说过话、也没铺过东西，就由系统说一句实话。
     * 这句话不装作答上了（见 closeFallback），它只说明"查到了什么、卡在哪"。
     * 有它兜着，"静默退出"这条路才算真的堵死。 */
    if (!s.spoke && !s.drew) {
      closeFallback(s, stop || 'silent');
      console.warn(`[turn] 静默收口：${s.sid} 第 ${s.turn} 轮没有产出（stop=${stop || 'none'}，工具 ${(s.acts || []).length} 次）`);
    }
  } catch (e) {
    if (e !== ABORT_TURN) {
      /* 模型挂了（超时 / 429 / 连不上）时，**先把已经拿到的数据铺出来**。
         用户问"我装了哪些应用"，工具明明 4 秒就跑完了，屏幕上却只有
         "模型没响应" —— 那是把已经到手的信息扔掉了。
         （实测：60 秒超时，2 个应用、版本、CPU 全在手里，屏幕一片黑。） */
      try {
        await salvage(s);
      } catch { /* 兜底再失败就算了，别把原始错误盖掉 */ }
      emit(s, { t: 'error', message: String(e?.message || e) });
    }
  } finally {
    if (aborted) {
      healToolCalls(s);
      emit(s, { t: 'note', message: '这一轮被打断了' });
      /* 说一句，别让屏幕"忽然安静" —— 用户按了停，需要看到它承认这件事。
         不说"好的"：它不是答应了什么，是停下来了。
         这一句也进记录：它同样是"说出口的话"。 */
      speak(s, '停下了');
    }
    /* 回合结束后台抽记忆。只抽问答回合：
       手势回合里的话大多是"把内存拖到 34%"，那是一次操作，不是一件值得记住的事。
       抽取失败只丢这一轮，不影响对话（memory.mjs 里自己 catch）。 */
    if (!aborted && goal.kind === 'ask') {
      memory.afterTurn({
        sid: s.sid,
        turn: s.turn,
        user: goal.text,
        reply: s.lastSpoken || '',
        actions: s.acts || [],
      }).catch(() => {});
    }
    /* 种子只在这一轮真的动了世界时才写（重启/挪文件/装了工具）。
       失败与被拒的调用在 acts 里就带着 ok:false，进来也没用。 */
    const made = persona.afterTurn({ sid: s.sid, turn: s.turn, actions: s.acts || [] });
    if (made.length) {
      emit(s, { t: 'note', message: `记下了：${made.map((x) => x.text).join('；')}` });
    }
    s.busy = false;
    s.abortCtl = null;
    /* 轮末结账。放在 idle **之前**：前端收到 idle 就会把状态条改成 ready，
       这时候再冒一个 usage 出来，等于让那一行闪一下 —— 顺序反了会显得卡。 */
    if (s.meter) {
      const u = await s.meter.endTurn().catch(() => s.meter.snap());
      /* `final` 只是给前端一个记号：轮末这份是总账，和最后一步的数字一样，
         再往观察窗里插一行就重复了。 */
      emit(s, { t: 'usage', ...u, final: true });
    }
    /* 记忆条数：一轮结束后抽取器可能刚记住一条新的，状态区那一格要跟着变。
       放在 idle 之前，和 usage 同一个理由（idle 之后到来会闪一下）。 */
    emit(s, { t: 'mem', ...(await memBrief(true)) });
    emit(s, { t: 'idle' });
    scheduleSave(s);         // 一轮结束才落盘：中途存的是半句话，恢复出来更糟
  }
}

/* 参数解析。**失败要能区分出来** —— "解析失败"和"模型真传了空对象"是两件事，
   混成一个空对象，模型会以为自己的参数被收下了，然后在同一件事上错第二次。

   另外有一条真机现象：**同一条消息里的第二个 tool_call，参数常常少一个右括号**
   （实测 Qwen 7B 经 SiliconFlow，连着三次都只差一个 `}`）。补括号能救回来的
   就救 —— 但**只准补括号和方括号，绝不准补引号**：补引号意味着原来那个字符串
   本来就被截断了，把半个脚本当完整的存下来、再执行它，比明确失败坏得多。 */
const safeJSON = (v) => {
  if (typeof v !== 'string') return v || {};
  if (!v.trim()) return {};
  try { return JSON.parse(v); } catch { /* 往下试修 */ }
  const t = v.replace(/,\s*$/, '');
  for (const tail of ['}', '}}', '}}}', ']', ']}', ']}}', '}]']) {
    try { return JSON.parse(t + tail); } catch { /* 下一个 */ }
  }
  return null;
};

/* 工具名出现在"说的话"里 = 它在自言自语（"请调用 scene_ask ……"），不该给用户看 */
/* 行首的自造标注：`{手势}`、`【建议】`、`(注)` 这类短括注。
   模型会给自己写舞台提示，然后它一起被当成正文上屏 ——
   实测原话："{手势} 把「内存」从 48% 拖到 34%"，就挂在答案最后一行。
   只认行首、且括注 ≤8 字，正常的括号说明（"（这台机器上）"）不会中枪。 */
const HEAD_TAG = /^[[{【〔（(]\s*[^\]}】〕）)]{1,8}\s*[\]}】〕）)]/;

const TOOL_WORDS = /(sys_status|app_list|olares_act|olares|skill_use|tool_write|tool_code|tool_try|tool_keep|tool_list|skill_save|memory_recall|memory_stats|memory_forget|fs_scan|logs_tail|mem_trim|fs_move|comfy|sub_run|scene_show|scene_ask|scene_set|scene_patch|scene_pulse|scene_transition)/;
/* 复述输入、复述用户意图、复述自己的计划 —— 都是旁白。
   实测原话："[手势] 把「内存」从 65% 拖到 34% 表示用户想把内存占用压低。我们先确……" */
/* 这几类话都不是"给用户看的一行"，是模型在自言自语：
   · "[手势] 用户把..." —— 复述输入
   · "我们先把... / 用户希望..." —— 复述计划
   · "机器的 CPU、内存和磁盘使用情况如下：" —— **导语**
     最典型的坏句子：一个字的信息量都没有，却把整行占满，
     真正的读数（23%）反而被挤掉。实测它会稳定地这么写，
     因为训练数据里的助手都这么开头。以"如下 / 以下"收尾、
     或"情况 / 状态 / 信息"打头再接"如下"的，一律不算说话。 */
const META_TALK = /^\[?手势|用户(想|希望|需要|要求|的意思)|我们(先|需要|应该|可以)|(如下|以下|有|包括)[：:]?$|(情况|状态|信息|数据|结果|应用|监控)[^。]{0,8}(如下|以下)|请稍等|稍等|我明白了|让我(先|来)|重新铺/;

/* ───────────────────────── HTTP ───────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  let p = decodeURIComponent(u.pathname);

  /* 统一前缀 `/agent/`。
   *
   * 为什么要它：这个东西最终要挂在那台机器的桌面上，和官方的 `/api/*`
   * 共用一个域名。把 agent 的接口放在 `/agent/` 下面，才不会和
   * olares-app 的登录/接口抢路径。
   *
   * 剥掉前缀之后，下面所有路由照旧按 `/api/*`、`/` 判断 —— 于是同一份代码
   * 本地（直接 8788）和集群里（nginx 转过来）走的是完全相同的分支。
   * 前端也因此可以用**相对**路径（`api/events`），不必知道自己在哪个前缀下。 */
  if (p === '/agent' || p.startsWith('/agent/')) p = p.slice('/agent'.length) || '/';

  /* ── 下行事件流 ── */
  if (p === '/api/events' && req.method === 'GET') {
    const sid = u.searchParams.get('sid') || crypto.randomUUID();
    let s;
    try {
      s = await getSession(sid);
    } catch (e) {
      /* 模型配错（缺 key、模型名拼错）时，错误必须回到界面上，
         而不是只在服务端控制台留一行 —— 否则前端只会一直"正在连接"。 */
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',        // nginx 不缓冲，否则事件会攒着一起发
    });
    res.write('retry: 1500\n\n');
    /* 一个会话可以有多个连接：刷新的一瞬间旧连接还没断、新连接已经建好；
       开第二个标签页也是同一段会话。**不能"新连接踢掉旧连接"** ——
       两个页面会互相把对方踢成 disconnected，然后各自重连，永远在打架。 */
    s.reses = s.reses || new Set();
    s.reses.add(res);
    emit(s, {
      /* `model` 给的是**表里的 id**（`local/qwen3:8b`、`mock`、
         `deepseek-ai/…`），不是适配器自己的名字（`sf:…`）—— 状态条和那个
         列表要对得上，对不上就分不清"现在用的是哪一个"。 */
      t: 'hello', sid, model: s.modelId, sys: SYS,
      tools: Object.keys(s.tools.all),
      /* 一连上就把账本交出去：刷新、换标签页、隔夜回来，用户第一眼
         就该看到"这个会话已经用掉多少"，而不是等下一轮才发现。 */
      usage: s.meter?.snap() || null,
      /* 记忆条数 —— 状态区那一格。它和 usage 并排出现，因为它们都是
         "这个会话现在怎么样"，而不是"它刚说了什么"。 */
      mem: await memBrief(),
    });
    /* 重连/刷新：把上一屏原样还回去。它必须是"已经在那儿"的状态，
       不是重新长一遍 —— 用户没有发起任何事，不该看到一场动画。
       判据不是"是不是刚从磁盘读出来的"：服务还活着、会话还在内存里时刷新，
       同样要恢复（第一版只在 resuming 时发，于是刷新后一片空白）。 */
    if (s.lastSceneSpec) {
      emit(s, { t: 'resume', scene: s.lastSceneSpec, ops: s.postOps || null, line: s.lastLine || '', log: (s.log || []).slice(-LOG_MAX) });
    }
    /* 上一轮是"画了张图"结束的，刷新之后图要还在 —— 否则用户倒杯水回来，
       屏上只剩粒子在飘，他会以为刚才那张根本没成功。 */
    if (s.lastImage?.url) emit(s, { t: 'image', ...s.lastImage });

    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    req.on('close', () => { clearInterval(ping); s.reses?.delete(res); });
    return;
  }

  /* ── 上行：一句话 / 一个手势 / 一次批准 ── */
  if (p === '/api/send' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = null; }
    if (!body || !body.sid) { res.writeHead(400).end('{"error":"sid required"}'); return; }
    const s = await getSession(body.sid);
    res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}');

    if (body.t === 'ask' && body.text) {
      const text = String(body.text).slice(0, 2000);
      /* 两条"整理"指令走旁路，不占模型一轮。
         为什么用指令而不是按钮：它们说的是"这段对话怎么处理"，
         和"问一件事"不是同一个层级；写进输入行还能被 ↑ 记录翻到。 */
      if (isNewCmd(text)) {
        (async () => {
          hear(s, text);
          emit(s, { t: 'note', message: '开个新会话（上一段会变成一条记忆）' });
          const r = await newSession(s, { reason: text }).catch((e) => ({ error: String(e?.message || e) }));
          if (r?.error) emit(s, { t: 'note', message: '新会话没开成：' + r.error });
        })();
      } else if (isCompactCmd(text)) {
        (async () => {
          hear(s, text);
          emit(s, { t: 'compact', on: true, pct: ctxPct(s) });
          const r = await compactSession(s, { manual: true }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          emit(s, { t: 'compact', on: false, ok: !!r?.ok, pct: ctxPct(s) });
          if (r?.ok) speak(s, `收好了：${r.summarized} 条压成一段`);
          else {
            speak(s, r?.reason === 'short'
              ? '这段还短，不用收'
              : '没收成，先把这一段留着');
            /* "太短"不是故障，别在观察窗里报一条红字。
               观察窗里的每条 note 都该是"你要知道的事"，不是内部枚举值。 */
            if (r?.reason !== 'short') {
              emit(s, { t: 'note', message: `压缩失败：${r?.error || r?.reason || '未知'}` });
            }
          }
          emit(s, { t: 'idle' });
        })();
      } else {
        runTurn(s, { kind: 'ask', text });
      }
    } else if (body.t === 'intent' && body.intent) {
      /* 空白处的一次点击（`target: null` 的 tap）不是意图。
         老前端会把它发上来，服务端这边也挡一道：它没有内容可指，
         交给模型只会让它对着「点了 undefined」编一段回答，还白烧一轮。 */
      if (body.intent.kind === 'tap' && !body.intent.target) return;
      runTurn(s, { kind: 'intent', intent: body.intent });
    } else if (body.t === 'approve') {
      settleApproval(s, !!body.ok);
    } else if (body.t === 'abort') {
      /* 打断也要回执：客户端点了停却什么都没发生，是最难受的一种失败 */
      const ok = abortTurn(s);
      emit(s, { t: 'note', message: ok ? '收到「停」' : '当前没有在跑的回合' });
    } else if (body.t === 'model' && body.id) {
      (async () => {
        const r = await switchModel(s, String(body.id)).catch((e) => ({ ok: false, error: String(e?.message || e) }));
        if (!r.ok) {
          emit(s, { t: 'note', message: `换不了：${r.error}` });
          /* 失败也要回一条 model 事件：前端在等这个事件落定"当前是哪个"，
             只发 note 的话它会一直以为"正在换"。**同一条事件管成功和失败** ——
             两种回执两个名字，迟早有一边忘了处理。 */
          emit(s, { t: 'model', id: s.modelId, ok: false, error: r.error });
        }
      })();
    }
    return;
  }

  /* 调试用：把会话消息原样吐出来（**含系统提示词和记忆注入**）。
     排障时它是最快的一条路，但线上不能开着 —— 它把"这台东西知道什么"整份交出去。
     所以默认关：要看就 `DEBUG=1 node agent/server.mjs`。 */
  if (p === '/api/debug' && req.method === 'GET') {
    if (process.env.DEBUG !== '1') {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('debug 接口默认关闭：设 DEBUG=1 启动再看');
      return;
    }
    const s0 = sessions.get(u.searchParams.get('sid'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s0?.messages ?? [], null, 1));
    return;
  }

  /* 说话记录。前端平时靠 SSE 累积，这一条是给"刚打开、还没收到 resume"
     和"想单独看一眼"用的 —— 刷新、跨设备、换标签页都能拿到同一份。 */
  if (p === '/api/history' && req.method === 'GET') {
    const sid = u.searchParams.get('sid') || '';
    if (!SID_RE.test(sid)) { res.writeHead(400).end('{"error":"bad sid"}'); return; }
    let s;
    try {
      s = await getSession(sid);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ log: (s.log || []).slice(-LOG_MAX) }));
    return;
  }

  /* 记忆。给调试和验收用：`GET /agent/api/memory?q=n8n`。
     它也是"这台东西到底记不记得住"的**唯一可观测入口** ——
     平时用户看不到记忆，出了问题也没法问它"你记了什么"。 */
  if (p === '/api/memory' && req.method === 'GET') {
    const q = u.searchParams.get('q') || '';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      /* `?sweep=1` 立刻做一次巩固。验收要用：等 6 轮才能看到"社群在合并"，
         而这件事恰恰是记忆里最需要被看见的部分（剪掉了什么、合并了什么）。 */
      if (u.searchParams.get('sweep') === '1') await memory.consolidate();
      res.end(JSON.stringify(await memory.debug(q), null, 1));
    } catch (e) {
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  /* 人格层面板。`GET /agent/api/persona` —— 验收标准就压在这条路径上：
     "它会说'我今天看到…'，且能指出那条信息是哪来的" —— 说不出编号、
     或者编号在记录里查不到，这条验收就是没通过，而不是"感觉还行"。 */
  if (p === '/api/persona' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      res.end(JSON.stringify({ ...persona.stats(), debug: u.searchParams.get('all') === '1' ? persona.debug() : undefined }, null, 1));
    } catch (e) {
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  /* token 账本。`GET /agent/api/usage?sid=` 给当前会话；
     `?day=1` 直接读今天的日账本（不需要 sid，重启后也能查）。
     这条路径存在的理由和 /api/memory 一样：**看不见的东西管不住** ——
     用户问"刚才那轮花了多少"，没有入口就只能猜。 */
  if (p === '/api/usage' && req.method === 'GET') {
    const sid = u.searchParams.get('sid') || '';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      let day = null;
      try {
        const f = path.join(USAGE_DIR, `${ymd()}.json`);
        day = JSON.parse(await fs.readFile(f, 'utf8'));
      } catch { /* 今天还没记过 */ }
      const s = SID_RE.test(sid) ? await getSession(sid) : null;
      res.end(JSON.stringify({
        session: s?.meter?.snap() || null,
        recent: s?.meter?.history() || [],
        day,
      }, null, 1));
    } catch (e) {
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  /* 就绪检查。**不是"端口开着"** —— k8s 的 readiness 用 tcpSocket 时，
     一个没有模型 key 的进程也会被判成就绪，用户看到"服务正常"但每句话都报错。
     这里判的是"能不能干活"：模型配了没有、数据源是什么、两个可降级的子系统活没活。
     模型没配 → 503 → pod 一直是 NotReady，界面直接显示"未就绪"，不用等第一句话。 */
  /* 图片代理：ComfyUI 上的图搬到屏幕上必经这里。
   *
   * 为什么不让前端直接 `<img src="http://comfy:8188/view?...">`：
   *   · ComfyUI 可能在另一台机器上（这台没卡时尤其如此），浏览器到它没有通路；
   *   · 跨源、带 cookie、端口暴露，每一条都是新的边；
   *   · 路径要过白名单（只 output/temp、只 png/jpg），否则这个代理就是一个
   *     "读 ComfyUI 机器上任何文件"的口子。
   * 所以前端只认 `/api/comfy/img?…`，由服务端取字节再吐出去。 */
  if (p === '/api/comfy/img' && req.method === 'GET') {
    const q = u.searchParams;
    const r = await comfy.imageBytes({
      filename: q.get('filename') || '',
      subfolder: q.get('subfolder') || '',
      type: q.get('type') || 'output',
    });
    if (!r.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: r.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': r.type, 'Content-Length': r.buf.length, 'Cache-Control': 'private, max-age=600' });
    res.end(r.buf);
    return;
  }

  if (p === '/api/health' && req.method === 'GET') {
    const hasModel = MODEL_ID === 'mock' || !!process.env.MODEL_KEY;
    const body = {
      ok: hasModel,
      model: MODEL_ID,
      sys: SYS,
      memory: memory.store || 'off',
      persona: persona.on,
      sessions: sessions.size,
      up: Math.round(process.uptime()),
    };
    if (!hasModel) body.hint = 'MODEL_KEY 没配。装的时候要建 Secret emergent-desktop-env';
    res.writeHead(hasModel ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }

  /* 设置：看一眼 / 改一下 / 测一个地址。
   *
   * GET 不回 key 明文（见 settings.mjs 的 publicSettings）—— 这块面板会被投到
   * 屏幕上、被截图，而一个 key 泄露和一句提示词泄露完全不是一回事。
   */
  if (p === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      const ps = publicSettings();
      res.end(JSON.stringify({
        ...ps,
        /* 内置那套的全文。**要给出去**：用户改提示词时最常犯的错是"重复说一遍
           它已经知道的"，而只有让他读到原文才知道哪些说过了。约 10KB，
           单用户桌面上这点开销远小于"改了但不知道为什么没用"。 */
        builtin: systemPrompt(),
        /* 两段字数：面板上要能说清"你写的是加在 9745 字后面的，还是替掉了它" */
        builtinChars: systemPrompt().length,
        sysChars: sysPrompt().length,
        sys: SYS,
        model: MODEL_ID,
        defaultModel: DEFAULT_MODEL,
      }));
    } catch (e) {
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  if (p === '/api/settings' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = null; }
    if (!body) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }));
      return;
    }
    try {
      const saved = await saveSettings({
        providers: body.providers,
        prompt: body.prompt,
        behavior: body.behavior,
      });
      /* 落盘之后**立刻**接到运行中的东西上（见 applySettings 的三件事） */
      const applied = await applySettings();
      /* 通知这个进程里的所有连接：别的标签页里打开的设置面板要跟着更新 */
      for (const x of sessions.values()) emit(x, { t: 'settings', at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true, settings: publicSettings(), notes: saved.notes, applied,
        sysChars: sysPrompt().length,
      }));
    } catch (e) {
      /* 写盘失败（权限/磁盘）时内存里已经改了 —— 必须说清楚"只在本次运行有效"，
         否则用户会以为保存成功了，下次重启才发现没了。 */
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: `没能写进 ${settingsFile()}：${e?.message || e}` }));
    }
    return;
  }

  if (p === '/api/settings/probe' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = null; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      res.end(JSON.stringify(await probeEndpoint(body || {})));
    } catch (e) {
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
    return;
  }

  /* 能换的模型。**每次现探**（本地那一组是运行时发现的，缓存一分钟）：
     用户刚 `ollama pull` 了一个模型，刷新面板就该看见它 ——
     写死一张表的话，他得重启服务才能换上新模型，而没人会想到要这么做。 */
  if (p === '/api/models' && req.method === 'GET') {
    const sid = u.searchParams.get('sid') || '';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    try {
      let current = MODEL_ID;
      let busy = false;
      if (SID_RE.test(sid)) {
        const s = await getSession(sid);
        current = s.modelId || MODEL_ID;
        busy = !!s.busy;
      }
      const c = await catalog({ force: u.searchParams.get('force') === '1' });
      res.end(JSON.stringify({ ...c, current, busy }));
    } catch (e) {
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }

  if (p === '/api/session') {
    const sid = u.searchParams.get('sid');
    const s = sid ? sessions.get(sid) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exists: !!s, busy: !!s?.busy, messages: s?.messages.length ?? 0 }));
    return;
  }

  /* ── 静态 ──
   * WEB_ROOT 指向**装页面那个目录**（默认仓库里的 shell/），于是页面里的
   * 相对引用 `./src/field.js` 天然对应 `/src/field.js`。
   * 部署进集群时把它指到 /app/shell，路径规则一个字不用改。
   *
   * 根路径给**桌面壳**，不是 agent 页：agent 已经是桌面的一层（deskagent.js），
   * 不再是一个独立页面。agent.html 还留着，但它现在只是"把场单独拿出来看"
   * 的调试页（?dev=1 那套观察窗还在上面）。 */
  let file = path.join(WEB_ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const st = await fs.stat(file);
    if (st.isDirectory()) file = path.join(file, 'index.html');
    const buf = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

/* 记忆要在开门之前就绪：第一个请求进来时可能立刻就要"你记得吗"。
   它起不来只降级成无记忆，不能连累主循环 —— 一个打不开的库让整台桌面罢工，
   是比失忆严重得多的事故。

   **要重试**。这是多容器应用共有的一个坑：agent 和记忆侧车同时启动，
   python 拉起 axolotl 要半秒多，agent 先连必然失败。只试一次的代价是
   "装好了、pod 2/2 Running、记忆一直是 off" —— 而日志里那句
   "侧车不可用"看起来像环境问题，不像竞态。（实测第一次装就是这样。）
   重试 6 次 / 每次 2 秒：够等一个 python 进程，也不至于让服务卡住不开门。 */
for (let i = 0; i < 6; i++) {
  try {
    await memory.start();
    if (i) console.log(`[memory] 侧车第 ${i + 1} 次尝试连上了`);
    break;
  } catch (e) {
    if (i === 5) {
      console.warn('[memory] 启动失败，退化为无记忆模式：' + e.message);
    } else {
      console.warn(`[memory] 侧车还没就绪，2s 后重试（${i + 1}/6）：${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/* 还有第三种失败，它比上面那个更坏：**冷启动拉镜像**。
   第一次部署时 memory 镜像要在节点上下 150MB，侧车出现得比 agent 晚几十秒，
   上面那 20 秒等不到就放弃了。表现是"3/3 Running、桌面正常、记忆一直 off"，
   而日志里那句"侧车不可用"看不出是拉镜像慢。等下次删 pod 才恢复 —— 没人会去删。
   所以这里留一个后台重试：每 30 秒试一次、最多 10 分钟，连上了就照常工作。
   只重试 axolotl 这一条路，绝不顺手退回 SQLite（两份库并存 = 记忆分叉）。 */
if (!memory.ok) {
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    if (memory.ok || tries > 20) { clearInterval(timer); return; }
    try {
      await memory.start();
      if (memory.ok) {
        console.log(`[memory] 后台第 ${tries} 次重试连上了侧车`);
        clearInterval(timer);
      }
    } catch { /* 还没起来，下一轮再说 */ }
  }, 30_000);
  timer.unref?.();
}

/* 人格层同理：它起不来就当没有这个人格（不注入身份、不漂移），
   而不是让整个服务打不开。 */
try {
  await persona.start();
} catch (e) {
  console.warn('[persona] 启动失败，人格层关闭：' + e.message);
}

/* 停机时把后台抽取跑完再走。kubectl delete pod 给的是 SIGTERM，
   node 默认立刻退出 —— 那正好会把"最后一轮记忆"丢掉，而它往往是刚说完的那件正事。 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { await Promise.race([memory.drain(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* 不等了 */ }
    await memory.stop();
    process.exit(0);
  });
}

/* 技能索引要在开门之前读好：工具 schema 的 enum 用的是**同步**拿到的名字表，
   读晚了第一轮就只有一个技能可选（而模型会以为系统只有这一块能力）。 */
try {
  const list = await skills.index();
  console.log(list.length
    ? `[skills] ${list.length} 份官方技能：${list.map((x) => x.name.replace(/^olares-/, '')).join(' / ')}`
    : '[skills] 没有技能包（构建时没 export），skill_use 不可用');
} catch (e) {
  console.warn('[skills] 索引失败：' + e.message);
}

/* 绑哪个地址。默认是 Node 的老行为（不带 host = `::`/0.0.0.0 双栈），
   pod 里要的就是这个 —— 只绑 127.0.0.1 的话 k8s 的探针和 Service 都进不来。
   但**本机自测用得上 127.0.0.1**：GitHub runner 上 `listen(PORT)` 的行为
   和本机不一致（自测里 server 明明打印了启动横幅、`fetch('http://127.0.0.1:…')`
   却一直连不上），给一个显式开关比猜平台差异省事。 */
const onListen = () => {
  console.log(`emergent-agent  http://127.0.0.1:${PORT}/agent/`);
  console.log(`  model=${MODEL_ID}  data=${SYS}  base=${process.env.MODEL_BASE || 'https://api.siliconflow.cn/v1'}`);
  /* 系统层的两个状态要分开报：**有没有这个二进制**、**有没有身份**。
     混成一句的话，"没装"和"没授权"在日志里长得一样，排障时会白跑一圈。 */
  olares.available()
    .then(async (has) => {
      if (!has) { console.log('[olares] 没有 olares-cli：系统层退化为 k8s 视角'); return; }
      /* warm 而不是 probe：顺带把内存配额预取掉（overview 要 8.5 秒，
         放在这里跑等于用户第一次提问不用等它）。 */
      const p = await olares.warm();
      console.log(p.ok
        ? `[olares] CLI 就绪 · ${p.who}${p.role ? ` (${p.role})` : ''} · 配额预热中`
        : `[olares] CLI 就绪但没身份（${p.code}）：系统层要授权后才能用`);
    })
    .catch(() => console.log('[olares] 探测失败，按"没有"处理'));
  if (MODEL_ID !== 'mock' && !process.env.MODEL_KEY) {
    console.warn('  ⚠ 没有 MODEL_KEY，连上后会报错。在 agent/.env 里写 MODEL_KEY=sk-...');
  }
};
if (process.env.HOST) server.listen(PORT, process.env.HOST, onListen);
else server.listen(PORT, onListen);
