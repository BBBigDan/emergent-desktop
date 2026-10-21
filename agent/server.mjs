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

import { makeTools, defaultOverview } from './tools.mjs';
import { createMockModel } from './model.mock.mjs';
import { createOpenAIModel } from './model.openai.mjs';
import { buildSystemPrompt } from './prompt.mjs';

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

const PORT = Number(process.env.PORT || 8788);
const SYS = process.env.SYS || 'k8s';            // k8s | host | mock —— 只决定"数据从哪来"
/* 模型与数据源是**两件事**：SYS=mock + 真模型，能在可复现的假数据上调提示词；
   SYS=host + mock 模型，能在真数据上验工具。混成一个开关就没法分开排障。
   k8s 是默认值：这台东西存在的意义就是管那台 Olares。没有集群凭据时
   tools.mjs 会打一行警告并退回本机读数，不会静默。 */
/* 默认用**免费**模型。这不是省钱，是"零余额账户"这条现实：
   硅基流动的规则是「现金余额 < 0 → 账户级停服」，而停服是账户级的 ——
   收费模型欠的不到一分钱，会把 ¥0 的免费模型一起带走（2026-10-21 实测踩过）。
   所以默认值必须落在价格表 ¥0 的那一列上，想花钱自己改 MODEL。 */
const DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct';
const MODEL_ID = process.env.MODEL || (process.env.MODEL_KEY ? DEFAULT_MODEL : 'mock');
const MAX_STEPS = Number(process.env.MAX_STEPS || 8);
const APPROVAL_MS = 90_000;

/* ───────────────────────── 会话 ───────────────────────── */

/** @type {Map<string, any>} */
const sessions = new Map();

/* 会话落盘。为什么需要：这套界面的状态几乎全在"场"里 —— 刷新一下、
   反代重启一次，用户看到的就是一片空粒子，刚才那屏和那行结论全没了。
   而这一屏往往是他正在看的东西，不是可以随手丢掉的过程。
   存三样就够：对话（模型的上下文）、最后一屏（眼睛看到的）、最后的读数（兜底要用）。 */
const SESS_DIR = path.join(HERE, 'sessions');
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;   // sid 会变成文件名，先卡死形状

async function loadSession(sid) {
  try {
    const raw = await fs.readFile(path.join(SESS_DIR, `${sid}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

let saveTimer = null;
function scheduleSave(s) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow(s).catch(() => {}); }, 800);
}

async function saveNow(s) {
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
      status: s.lastStatus || null,
      apps: s.lastApps || null,
    };
    await fs.writeFile(path.join(SESS_DIR, `${s.sid}.json`), JSON.stringify(data));
  } catch { /* 落盘失败不该影响对话 */ }
}

function makeModel() {
  if (MODEL_ID === 'mock') return createMockModel();
  try {
    return createOpenAIModel({ model: MODEL_ID });
  } catch (e) {
    /* 配错了不要静默退回 mock：那会让人以为"模型变笨了"，其实是一直没连上 */
    console.error('[model]', e.message);
    throw e;
  }
}

async function getSession(sid) {
  let s = sessions.get(sid);
  if (!s) {
    const saved = SID_RE.test(sid) ? await loadSession(sid) : null;
    s = {
      sid,
      /* 系统提示词是会话的第一条消息，进历史。这样 /api/debug 能直接看到
         模型当时到底被喂了什么 —— 调提示词全靠这个。 */
      messages: saved?.messages?.length ? saved.messages : [{ role: 'system', content: buildSystemPrompt() }],
      reses: new Set(),      // 这段会话的所有下行连接（可能有多个：刷新、多标签页）
      tools: makeTools({ source: SYS }),
      model: null,
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
    s.model = makeModel();
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
  const t = String(text || '').trim();
  if (!t) return;
  /* 同一句话不记两次：一轮里"模型自由文本"和"兜底句"可能撞车 */
  const last = (s.log || [])[s.log.length - 1];
  if (!last || last.r !== 'a' || last.t !== t) pushLog(s, 'a', t);
  emit(s, { t: 'say', text: t });
}

function hear(s, text, r = 'u') {
  const t = String(text || '').trim();
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
  if (s.tools.level(name) !== 'danger') return false;
  const g = s.goal;
  const explicit = g?.kind === 'intent' && g.intent?.kind === 'pick';
  return !explicit;
}

function requestApproval(s, { id, name, args }) {
  return new Promise((resolve) => {
    const d = describeDanger(name, args);
    s.pending = { id, resolve };
    emit(s, { t: 'approval', id, tool: name, args, label: d.label, danger: d.detail });
    const timer = setTimeout(() => {
      if (s.pending?.id !== id) return;
      s.pending = null;
      emit(s, { t: 'approval', id, tool: name, args, label: d.label, danger: d.detail, state: 'timeout' });
      resolve(false);
    }, APPROVAL_MS);
    s.pending.timer = timer;
  });
}

/** 审批卡片要两段文字：一句短的进分叉（场里字很少），一句长的进日志（能说清代价） */
function describeDanger(name, args) {
  if (name === 'mem_trim') {
    return {
      label: `压到 ${Math.round(args.to * 100)}%？`,
      detail: `会重启占内存最多的应用，它正在做的事会中断`,
    };
  }
  if (name === 'fs_move') return { label: '移动这些文件？', detail: `共 ${args.files?.length ?? '?'} 个` };
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

const INTENT_ZH = {
  adjust: (i) => `把「${i.label}」从 ${Math.round(i.from * 100)}% 拖到 ${Math.round(i.to * 100)}%`,
  pick: (i) => `在「${i.label}」选了「${i.optionLabel || i.option}」`,
  tap: (i) => `点了「${i.label}」`,
  pan: (i) => `把「${i.label}」横向翻了一段`,
  seek: (i) => `把「${i.label}」跳到 ${Math.round(i.to * 100)}%`,
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

async function runTurn(s, goal) {
  if (s.busy) { emit(s, { t: 'busy' }); return; }
  s.busy = true;
  s.abortCtl = new AbortController();
  let aborted = false;
  s.goal = goal;
  s.turn++;
  s.spoke = false;          // 这一轮还没说过话（见下面 scene 工具回带的 say）
  s.narrated = false;       // 观察窗里还没提示过"旁白被咽掉"
  s.sets = 0;
  s.lastSpecSig = null;
  s.drew = false;           // 这一轮模型有没有自己铺屏（没铺就由系统兜底）
  s.painted = false;        // 这一轮有没有先铺过"渐进首屏"

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

  try {
    let lastSig = '';
    let repeats = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      /* 上一轮工具刚跑完就被按了停：这里也要接住，别再多问模型一次 */
      if (s.abortCtl.signal.aborted) { aborted = true; throw ABORT_TURN; }
      emit(s, { t: 'think', on: true, step });
      let out;
      try {
        out = await s.model.complete({
          messages: s.messages,
          tools: s.tools.schemas(),
          /* 第一轮的第一步**强制取证**。
             这不是不信任模型，是"先看再说"属于协议而不是建议：
             便宜模型很容易跳过工具、直接凭上下文编一个读数（实测过：
             它把示例里的 71% 原样抄了出来）。让它自己决定要不要看，
             等于让最不可靠的一环决定"事实从哪来"。
             代价是纯闲聊也要付一次 sys_status —— 一次本地读 /proc，可以接受。 */
          toolChoice: step === 0 && goal.kind === 'ask' ? 'required' : 'auto',
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
        emit(s, { t: 'think', on: false, step });
      }

      const calls = out.tool_calls || [];
      /* 便宜模型会把示例里的记号一起抄出来（"content: ..."、"→ scene_set(...)"），
         或者写一整段带换行和清单的计划。场里只有**一行** 20 格，这些都不该下去：
         截到第一行、去掉列表符号，剩下的由前端按字数再压。 */
      const rawSpeech = String(out.content || '')
        .replace(/^\s*(content|回答|你说)\s*[:：]\s*/i, '')
        .replace(/^["'「](.*)["'」]$/, '$1')
        .split('\n')[0]
        .replace(/^\s*[-*·]\s*/, '')
        .trim();
      /* 提到工具名的话是"它对自己下的指令"，不是给用户的话。
         实测原话："请调用 scene_ask 把问题问出来" —— 用户看到只会莫名其妙。 */
      /* 也不要 JSON 残片。实测 7B 会把本该是参数的东西写进 content：
         `{"reading":"CPU 21% · 内存 41% · 磁盘 37%","` —— 屏幕上就是这串鬼东西。
         凡是像 JSON 开头的，一律不算说话。 */
      const looksLikeJSON = /^[[{]\s*"?\w+"?\s*:/.test(rawSpeech.replace(/[「」]/g, '"'));
      /* 手势回合干脆不要它说话：这一行该说"代价"，而代价（要重启谁）是系统知道的事，
         模型只会复述用户动作或复述自己的计划。要它表达的地方是 scene_ask 的问题本身。 */
      const isAdjust = s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust';
      const speech = (isAdjust || looksLikeJSON || TOOL_WORDS.test(rawSpeech) || META_TALK.test(rawSpeech))
        ? '' : rawSpeech.slice(0, 40);
      /* 一轮只说一句话。
         scene_show 的 reading 已经替它说过话了；之后模型再补一段
         "机器当前负载情况是这样的……"，那不是给用户的话，是旁白。
         场里只有一行，多说的每一句都要挤掉真正要看的东西 —— 所以后面的都咽掉，
         但在观察窗留一条，免得以后查"它到底说了什么"时一头雾水。 */
      const voice = speech && !s.spoke ? speech : '';
      /* s.spoke 必须在这里也置上：模型的自由文本同样占了那一行。
         之前只在 scene 工具的 say 里置位，于是"模型说一句 + 兜底再说一句"
         会同时出现 —— 一行字被两句话争着写，最后看到的是后一句。 */
      if (voice) { s.spoke = true; s.lastVoice = voice; speak(s, voice); }
      else if (speech && !s.narrated) {
        /* 只留第一条。实测一轮里模型会补三次旁白，每条的句式都一样，
           观察窗被刷得看不清工具调用 —— 而"它爱说旁白"这件事看一条就够了。 */
        s.narrated = true;
        emit(s, { t: 'note', message: `旁白已咽掉：${speech.slice(0, 24)}` });
      }

      if (!calls.length) {
        if (voice) s.messages.push({ role: 'assistant', content: voice });
        break;
      }

      /* 同一组调用连着来 = 模型卡住了（它没意识到"已经做过"）。
         直接停比跑满 8 步好：多出来的那几次会把同一个动画重播八遍，
         用户看到的是"界面上有东西在抽"，而不是"模型在思考"。 */
      const sig = calls.map((c) => `${c.function.name}:${c.function.arguments}`).join('|');
      if (sig === lastSig) {
        repeats++;
        if (repeats >= 1) {
          emit(s, { t: 'note', message: '模型重复了同一组调用，已中止这一轮' });
          break;
        }
      } else {
        lastSig = sig;
        repeats = 0;
      }

      s.messages.push({ role: 'assistant', content: out.content || '', tool_calls: calls });

      for (const c of calls) {
        const name = c.function.name;
        const args = safeJSON(c.function.arguments);
        const id = c.id;
        const t0 = Date.now();
        emit(s, { t: 'tool', id, name, args, state: 'run' });

        let result;
        try {
          /* 「拖一下」只是意图，决不能在同一个回合里直接变成执行。
             这是整套交互里最要紧的一条语义（用户明确要求过：向下拖内存 =
             "我想降内存"，此时应该**问**他，而不是替他做）。
             写成代码而不是提示词，是因为它不该随模型好坏而变：
             弱模型会跳过问话直接调 mem_trim（实测过），强模型也可能在某次偷懒。
             等用户在分叉上点了 yes（那是 pick 手势），才放行。 */
          if (s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust' && s.tools.level(name) === 'danger') {
            result = {
              error: '拖动只是意图，不是命令。用 scene_ask 把问题问出来就停手，等用户点选项 —— '
                + '这一回合不要再执行任何动作。',
            };
          } else if (name === 'scene_ask' && s.goal?.kind !== 'intent') {
            /* scene_ask 是给手势回合用的（"你拖了，要不要真压下去？"）。
               普通问答里模型会照抄示例、在没有拖动的场面上换一个问题 ——
               用户会看到一句跟他刚才说的话无关的质问。问答回合的问题走 scene_show 的 ask 字段。 */
            result = { error: 'scene_ask 只用于手势回合。要问问题，用 scene_show 的 ask/yes/no 字段重新铺一屏。' };
          } else if (needsGate(s, name)) {
            const ok = await requestApproval(s, { id, name, args });
            result = ok ? await s.tools.exec(name, args) : { denied: true, reason: 'user refused' };
          } else {
            result = await s.tools.exec(name, args);
          }
        } catch (e) {
          result = { error: String(e?.message || e) };
        }

        /* 场景工具不是"数据"，是给眼睛的指令 —— 直接下发，不进工具结果里让模型再读一遍 */
        if (result && result.ok && result.op) {
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
            if (sig === s.lastSpecSig) {
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
          if (!result.duplicate && result.say) {
            s.spoke = true;
            s.lastVoice = String(result.say).slice(0, 40);
            s.lastLine = s.lastVoice;
            speak(s, String(result.say).slice(0, 40));
          }
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

        s.messages.push({ role: 'tool', name, tool_call_id: id, content: JSON.stringify(result) });
        emit(s, { t: 'tool', id, name, state: result?.denied ? 'denied' : result?.error ? 'err' : 'ok', ms: Date.now() - t0, note: summarize(result) });

        /* 记下最近一次的真实数据。它不是给模型的上下文，是给兜底用的：
           模型没铺屏时，系统要能自己画出来，画得准的前提是它拿着原始读数。 */
        if (name === 'sys_status' && result?.cpu != null) { s.lastStatus = result; s.statusTurn = s.turn; }
        if (name === 'app_list' && Array.isArray(result?.apps)) { s.lastApps = result.apps; s.appsTurn = s.turn; }

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
      emit(s, {
        t: 'scene', op: 'patch',
        ops: [{
          id: 'ask',
          label: `压到 ${to}%？`,
          options: [{ id: 'yes', label: `压到 ${to}%` }, { id: 'no', label: '算了' }],
        }],
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
    if (!s.drew && (freshStatus || freshApps) && s.goal?.kind === 'ask') {
      const line = s.lastVoice
        || (freshStatus
          ? `CPU ${Math.round((s.lastStatus.cpu ?? 0) * 100)}% · 内存 ${Math.round((s.lastStatus.mem ?? 0) * 100)}%`
          : `${s.lastApps.length} 个应用在跑`);
      /* 曲线只在有**本轮**节点读数时才配。应用列表那类问题如果也挂一条 CPU 曲线，
         屏幕上就是"三个应用 + 一条不相干的 CPU 走势"，比没有更让人困惑。 */
      const built = defaultOverview(
        freshStatus ? s.lastStatus : {}, s.lastApps || [], line,
        freshStatus ? await trendSeries(s.tools) : null,
        { note: !s.spoke },
      );
      if (built) {
        if (!s.spoke) { s.spoke = true; speak(s, built.say); }
        emit(s, { t: 'scene', op: 'set', spec: built.spec });
        emit(s, { t: 'note', message: '模型没有给出这一屏，由系统按读数兜底铺开' });
      }
    }
  } catch (e) {
    if (e !== ABORT_TURN) emit(s, { t: 'error', message: String(e?.message || e) });
  } finally {
    if (aborted) {
      healToolCalls(s);
      emit(s, { t: 'note', message: '这一轮被打断了' });
      /* 说一句，别让屏幕"忽然安静" —— 用户按了停，需要看到它承认这件事。
         不说"好的"：它不是答应了什么，是停下来了。
         这一句也进记录：它同样是"说出口的话"。 */
      speak(s, '停下了');
    }
    s.busy = false;
    s.abortCtl = null;
    emit(s, { t: 'idle' });
    scheduleSave(s);         // 一轮结束才落盘：中途存的是半句话，恢复出来更糟
  }
}

const safeJSON = (v) => {
  if (typeof v !== 'string') return v || {};
  try { return JSON.parse(v); } catch { return {}; }
};

/* 工具名出现在"说的话"里 = 它在自言自语（"请调用 scene_ask ……"），不该给用户看 */
const TOOL_WORDS = /(sys_status|app_list|fs_scan|logs_tail|mem_trim|fs_move|scene_show|scene_ask|scene_set|scene_patch|scene_pulse|scene_transition)/;
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
const META_TALK = /^\[?手势|用户(想|希望|需要|要求|的意思)|我们(先|需要|应该|可以)|(如下|以下|有|包括)[：:]?$|(情况|状态|信息|数据|结果|应用|监控)[^。]{0,8}(如下|以下)/;

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
    emit(s, { t: 'hello', sid, model: s.model.name, sys: SYS, tools: Object.keys(s.tools.all) });
    /* 重连/刷新：把上一屏原样还回去。它必须是"已经在那儿"的状态，
       不是重新长一遍 —— 用户没有发起任何事，不该看到一场动画。
       判据不是"是不是刚从磁盘读出来的"：服务还活着、会话还在内存里时刷新，
       同样要恢复（第一版只在 resuming 时发，于是刷新后一片空白）。 */
    if (s.lastSceneSpec) {
      emit(s, { t: 'resume', scene: s.lastSceneSpec, ops: s.postOps || null, line: s.lastLine || '', log: (s.log || []).slice(-LOG_MAX) });
    }

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
      runTurn(s, { kind: 'ask', text: String(body.text).slice(0, 2000) });
    } else if (body.t === 'intent' && body.intent) {
      runTurn(s, { kind: 'intent', intent: body.intent });
    } else if (body.t === 'approve') {
      settleApproval(s, !!body.ok);
    } else if (body.t === 'abort') {
      /* 打断也要回执：客户端点了停却什么都没发生，是最难受的一种失败 */
      const ok = abortTurn(s);
      emit(s, { t: 'note', message: ok ? '收到「停」' : '当前没有在跑的回合' });
    }
    return;
  }

  /* 调试用：把会话消息原样吐出来。M0 阶段排障全靠它，生产要关掉。 */
  if (p === '/api/debug' && req.method === 'GET') {
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

server.listen(PORT, () => {
  console.log(`emergent-agent  http://127.0.0.1:${PORT}/agent/`);
  console.log(`  model=${MODEL_ID}  data=${SYS}  base=${process.env.MODEL_BASE || 'https://api.siliconflow.cn/v1'}`);
  if (MODEL_ID !== 'mock' && !process.env.MODEL_KEY) {
    console.warn('  ⚠ 没有 MODEL_KEY，连上后会报错。在 agent/.env 里写 MODEL_KEY=sk-...');
  }
});
