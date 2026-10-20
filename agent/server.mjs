/**
 * emergent-agent · M0 基座（mock 形态）
 *
 * 跑起来：
 *   node agent/server.mjs              # → http://127.0.0.1:8788/shell/agent.html
 *   SYS=mock node agent/server.mjs     # 工具返回固定假数据（截图要可复现）
 *
 * 这一版**没有接真模型**，也没有接 k8s。它的目标只有一个：
 * 把「模型发工具调用 → 工具执行 → 场景指令下发 → 手势意图回灌 → 审批挂起」
 * 这条链路跑通，从而**把协议定下来**。之后换真模型只改 model.*.mjs，
 * 换真工具只改 tools.mjs 的 run()，协议一个字不用动。
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

import { makeTools } from './tools.mjs';
import { createMockModel } from './model.mock.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');            // 仓库根：dev 模式下同时服务 shell/
const PORT = Number(process.env.PORT || 8788);
const SYS = process.env.SYS || 'host';            // host | mock
const MAX_STEPS = 8;                              // 一轮最多几次模型往返（防跑飞）
const APPROVAL_MS = 90_000;

/* ───────────────────────── 会话 ───────────────────────── */

/** @type {Map<string, any>} */
const sessions = new Map();

function getSession(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = {
      sid,
      messages: [],
      res: null,
      tools: makeTools({ source: SYS }),
      model: createMockModel(),
      pending: null,        // 审批挂起：{id, resolve}
      busy: false,
      turn: 0,
      lastAdjustTo: null,
    };
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
  if (r.op) return `scene.${r.op}`;
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
      const out = await s.model.complete({
        messages: s.messages,
        tools: s.tools.schemas(),
        goal: { ...goal, pendingTo: s.lastAdjustTo },
      });
      emit(s, { t: 'think', on: false, step });

      const calls = out.tool_calls || [];
      if (out.content) emit(s, { t: 'say', text: out.content });

      if (!calls.length) {
        if (out.content) s.messages.push({ role: 'assistant', content: out.content });
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
          if (needsGate(s, name)) {
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
          emit(s, { t: 'scene', op: result.op, spec: result.spec, ops: result.ops, kind: result.kind, at: result.at });
        }

        s.messages.push({ role: 'tool', name, tool_call_id: id, content: JSON.stringify(result) });
        emit(s, { t: 'tool', id, name, state: result?.denied ? 'denied' : result?.error ? 'err' : 'ok', ms: Date.now() - t0, note: summarize(result) });
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
    const s = getSession(sid);
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
  console.log(`emergent-agent (mock)  http://127.0.0.1:${PORT}/shell/agent.html   sys=${SYS}`);
});
