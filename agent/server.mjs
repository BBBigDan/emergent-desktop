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
const ROOT = path.resolve(HERE, '..');            // 仓库根：dev 模式下同时服务 shell/

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
const SYS = process.env.SYS || 'host';            // host | mock —— 只决定"数据从哪来"
/* 模型与数据源是**两件事**：SYS=mock + 真模型，能在可复现的假数据上调提示词；
   SYS=host + mock 模型，能在真数据上验工具。混成一个开关就没法分开排障。 */
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

function getSession(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = {
      sid,
      /* 系统提示词是会话的第一条消息，进历史。这样 /api/debug 能直接看到
         模型当时到底被喂了什么 —— 调提示词全靠这个。 */
      messages: [{ role: 'system', content: buildSystemPrompt() }],
      res: null,
      tools: makeTools({ source: SYS }),
      model: null,
      pending: null,        // 审批挂起：{id, resolve}
      busy: false,
      turn: 0,
      lastAdjustTo: null,
    };
    s.model = makeModel();
    sessions.set(sid, s);
  }
  return s;
}

function emit(s, ev) {
  if (!s.res || s.res.writableEnded) return;
  s.res.write(`data: ${JSON.stringify(ev)}\n\n`);
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

async function runTurn(s, goal) {
  if (s.busy) { emit(s, { t: 'busy' }); return; }
  s.busy = true;
  s.goal = goal;
  s.turn++;
  s.spoke = false;          // 这一轮还没说过话（见下面 scene 工具回带的 say）
  s.sets = 0;
  s.lastSpecSig = null;
  s.drew = false;           // 这一轮模型有没有自己铺屏（没铺就由系统兜底）

  /* 意图也要变成一条 user 消息进历史 —— 真模型靠上下文理解"用户刚才做了什么"，
     所以它必须是会话的一部分，不能是旁路通道。 */
  if (goal.kind === 'ask') {
    s.messages.push({ role: 'user', content: goal.text });
    emit(s, { t: 'turn', round: s.turn, kind: 'ask' });
  } else {
    const it = goal.intent || {};
    if (it.kind === 'adjust') s.lastAdjustTo = it.to;
    const line = (INTENT_ZH[it.kind] || (() => '动了一下'))(it);
    s.messages.push({ role: 'user', content: `[手势] ${line}`, intent: it });
    emit(s, { t: 'turn', round: s.turn, kind: 'intent', intent: it });
  }

  try {
    let lastSig = '';
    let repeats = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
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
        });
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
      /* 手势回合干脆不要它说话：这一行该说"代价"，而代价（要重启谁）是系统知道的事，
         模型只会复述用户动作或复述自己的计划。要它表达的地方是 scene_ask 的问题本身。 */
      const isAdjust = s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust';
      const speech = (isAdjust || TOOL_WORDS.test(rawSpeech) || META_TALK.test(rawSpeech))
        ? '' : rawSpeech.slice(0, 40);
      /* 一轮只说一句话。
         scene_show 的 reading 已经替它说过话了；之后模型再补一段
         "机器当前负载情况是这样的……"，那不是给用户的话，是旁白。
         场里只有一行，多说的每一句都要挤掉真正要看的东西 —— 所以后面的都咽掉，
         但在观察窗留一条，免得以后查"它到底说了什么"时一头雾水。 */
      const voice = speech && !s.spoke ? speech : '';
      if (voice) emit(s, { t: 'say', text: voice });
      else if (speech) emit(s, { t: 'note', message: `旁白已省略：${speech.slice(0, 24)}` });

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
          /* 同一屏连铺两遍 = 模型在原地打转（实测：它会为了"更完整"再铺一次，
             屏幕上就是同一屏反复溶解重组）。判重放在服务端而不是提示词里：
             "做过没有"是状态问题，模型看不见自己的历史，服务端看得见。 */
          if (result.op === 'set' && result.spec) {
            const sig = JSON.stringify(result.spec.layers);
            s.sets = (s.sets || 0) + 1;
            if (sig === s.lastSpecSig) {
              result.duplicate = true;
              result.hint = '这一屏和现在屏幕上的一样，不要再铺一次';
            } else if (s.sets > 2) {
              result.duplicate = true;
              result.hint = '这一轮已经铺过两屏了，停在这里，把决定权交给用户';
            } else {
              s.lastSpecSig = sig;
            }
          }
          if (!result.duplicate && result.say) {
            s.spoke = true;
            s.lastVoice = String(result.say).slice(0, 40);
            emit(s, { t: 'say', text: String(result.say).slice(0, 40) });
          }
          if (!result.duplicate) {
            s.drew = true;
            emit(s, { t: 'scene', op: result.op, spec: result.spec, ops: result.ops, kind: result.kind, at: result.at });
          } else {
            emit(s, { t: 'note', message: `重复的整屏已忽略：${result.hint}` });
          }
        }

        s.messages.push({ role: 'tool', name, tool_call_id: id, content: JSON.stringify(result) });
        emit(s, { t: 'tool', id, name, state: result?.denied ? 'denied' : result?.error ? 'err' : 'ok', ms: Date.now() - t0, note: summarize(result) });

        /* 记下最近一次的真实数据。它不是给模型的上下文，是给兜底用的：
           模型没铺屏时，系统要能自己画出来，画得准的前提是它拿着原始读数。 */
        if (name === 'sys_status' && result?.cpu != null) s.lastStatus = result;
        if (name === 'app_list' && Array.isArray(result?.apps)) s.lastApps = result.apps;
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
      emit(s, { t: 'say', text: `压到 ${Math.round((s.goal.intent.to ?? 0) * 100)}% 要重启占内存最多的那个` });
    }

    /* ── 兜底 1：拖了仪表，模型却没问 ──
       手势路径上模型最容易"直接动手"或"什么都不做"。前者被上面的协议拦住了，
       后者会留下一片空白 —— 而这时用户的手还停在仪表上，等他一个回应。 */
    if (!s.drew && s.goal?.kind === 'intent' && s.goal.intent?.kind === 'adjust') {
      const it = s.goal.intent;
      const to = Math.round((it.to ?? 0) * 100);
      if (!s.spoke) {
        s.spoke = true;
        emit(s, { t: 'say', text: `压到 ${to}% 要重启占内存最多的那个` });
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
    if (!s.drew && s.lastStatus && s.goal?.kind === 'ask') {
      const line = s.lastVoice
        || `CPU ${Math.round((s.lastStatus.cpu ?? 0) * 100)}% · 内存 ${Math.round((s.lastStatus.mem ?? 0) * 100)}%`;
      const built = defaultOverview(s.lastStatus, s.lastApps || [], line);
      if (built) {
        if (!s.spoke) { s.spoke = true; emit(s, { t: 'say', text: built.say }); }
        emit(s, { t: 'scene', op: 'set', spec: built.spec });
        emit(s, { t: 'note', message: '模型没有给出这一屏，由系统按读数兜底铺开' });
      }
    }
  } catch (e) {
    emit(s, { t: 'error', message: String(e?.message || e) });
  }

  s.busy = false;
  emit(s, { t: 'idle' });
}

const safeJSON = (v) => {
  if (typeof v !== 'string') return v || {};
  try { return JSON.parse(v); } catch { return {}; }
};

/* 工具名出现在"说的话"里 = 它在自言自语（"请调用 scene_ask ……"），不该给用户看 */
const TOOL_WORDS = /(sys_status|app_list|fs_scan|logs_tail|mem_trim|fs_move|scene_show|scene_ask|scene_set|scene_patch|scene_pulse|scene_transition)/;
/* 复述输入、复述用户意图、复述自己的计划 —— 都是旁白。
   实测原话："[手势] 把「内存」从 65% 拖到 34% 表示用户想把内存占用压低。我们先确……" */
const META_TALK = /^\[?手势|用户(想|希望|需要|要求|的意思)|我们(先|需要|应该|可以)/;

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
  const p = decodeURIComponent(u.pathname);

  /* ── 下行事件流 ── */
  if (p === '/api/events' && req.method === 'GET') {
    const sid = u.searchParams.get('sid') || crypto.randomUUID();
    let s;
    try {
      s = getSession(sid);
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
    if (s.res) { try { s.res.end(); } catch { /* 旧连接已断 */ } }
    s.res = res;
    emit(s, { t: 'hello', sid, model: s.model.name, sys: SYS, tools: Object.keys(s.tools.all) });

    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    req.on('close', () => { clearInterval(ping); if (s.res === res) s.res = null; });
    return;
  }

  /* ── 上行：一句话 / 一个手势 / 一次批准 ── */
  if (p === '/api/send' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = null; }
    if (!body || !body.sid) { res.writeHead(400).end('{"error":"sid required"}'); return; }
    const s = getSession(body.sid);
    res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}');

    if (body.t === 'ask' && body.text) {
      runTurn(s, { kind: 'ask', text: String(body.text).slice(0, 2000) });
    } else if (body.t === 'intent' && body.intent) {
      runTurn(s, { kind: 'intent', intent: body.intent });
    } else if (body.t === 'approve') {
      settleApproval(s, !!body.ok);
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

  if (p === '/api/session') {
    const sid = u.searchParams.get('sid');
    const s = sid ? sessions.get(sid) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exists: !!s, busy: !!s?.busy, messages: s?.messages.length ?? 0 }));
    return;
  }

  /* ── 静态（dev 模式：仓库根，于是 /shell/agent.html 能直接 import ./src/*） ── */
  let file = path.join(ROOT, p === '/' ? '/shell/agent.html' : p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
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
  console.log(`emergent-agent  http://127.0.0.1:${PORT}/shell/agent.html`);
  console.log(`  model=${MODEL_ID}  data=${SYS}  base=${process.env.MODEL_BASE || 'https://api.siliconflow.cn/v1'}`);
  if (MODEL_ID !== 'mock' && !process.env.MODEL_KEY) {
    console.warn('  ⚠ 没有 MODEL_KEY，连上后会报错。在 agent/.env 里写 MODEL_KEY=sk-...');
  }
});
