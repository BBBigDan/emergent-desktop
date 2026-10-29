/**
 * 定时任务起真 server 的自测：`node agent/sched.server.test.mjs`
 *
 * `sched.test.mjs` 测的是"时间算得对不对"，这一份测的是**"到点真的有东西发生"** ——
 * 这两件事必须分开测：纯函数全绿而线上纹丝不动，是这类功能最典型的死法
 * （定时器没起、会话打不开、自动回合被当成普通问答、事件发给了没人连的 SSE）。
 *
 * 所以这里起一个真 server，配一个**故意想动手**的假模型：
 * 它一上来就调 `olares_act`（danger，装应用）。断言的是三件：
 *
 *   ① 到点自己开了一轮（会话文件里出现 `[定时]` 那句话）；
 *   ② **danger 工具被拒**，而且理由说的是"没人在跟前"，不是"工具坏了"
 *      —— 定时回合没人能点同意，这是硬边界（roadmap ① 的代价一节）；
 *   ③ 没人连着看的时候，这一轮算**未读**。
 *
 * 不起 SSE 连接正是为了 ③：有连接就"有人在看"，未读不该涨。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

let failed = 0;
const ok = (c, l, e = '') => {
  if (c) console.log('  ✓ ' + l);
  else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SID = 'sid-sched00001';

/**
 * 假模型（OpenAI 兼容）。它要模拟的是"7B 在定时回合里想动手"：
 * 第一步发一个 danger 工具调用，拿到拒信之后才说话。
 */
function stubModel(port) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch { /* 探活请求没有 body */ }
      const msgs = body.messages || [];
      /* 最后一条是不是工具结果 —— 是就说明"动手"被拒过了，该收口说话 */
      const last = msgs[msgs.length - 1] || {};
      const sawToolResult = msgs.some((m) => m.role === 'tool');
      seen.push({ n: msgs.length, sawToolResult });

      const out = sawToolResult
        ? { content: '看了一眼：还在。要动手得你在的时候。', tool_calls: [] }
        : {
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'olares_act', arguments: JSON.stringify({ op: 'install', app: 'n8n' }) },
          }],
        };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', model: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', ...out }, finish_reason: out.tool_calls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, seen })));
}

const basePort = 19300 + Math.floor(Math.random() * 300);
const sport = basePort;
const aport = basePort + 1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schedsrv-'));
const tasksFile = path.join(tmp, 'tasks.json');
const sessDir = path.join(tmp, 'sessions');
const usageDir = path.join(tmp, 'usage');
fs.mkdirSync(sessDir, { recursive: true });

/* 预置一条**已经过期**的任务：server 一启动，第一次 tick 就该开火。
   这也顺带钉住"过期只补一次"那一半 —— tick 500ms，如果它每拍都跑，
   三秒内 runs 会远大于 1。 */
const now = Date.now();
fs.writeFileSync(tasksFile, JSON.stringify([{
  id: 'tabc12', sid: SID, task: '看一眼 n8n 有没有又重启',
  everyMs: 60_000, at: null, factor: 1, runs: 0, same: 0, lastHash: '',
  createdAt: now - 600_000, lastAt: 0, nextAt: now - 120_000, paused: false,
}]));

const model = await stubModel(sport);
const srv = spawn(NODE, [path.join(ROOT, 'agent/server.mjs')], {
  env: {
    ...process.env,
    PORT: String(aport), HOST: '127.0.0.1',
    SYS: 'mock',
    /* mock 之外的一个本地模型 id：走 `local/` 路由，指向下面这个桩 */
    MODEL: 'local/schedstub',
    MODEL_KEY: 'stub-key',
    MODEL_LOCAL_BASE: `http://127.0.0.1:${sport}/v1`,
    SETTINGS_FILE: path.join(tmp, 'settings.json'),
    TASKS_FILE: tasksFile,
    SESSIONS_DIR: sessDir,
    USAGE_DIR: usageDir,
    SCHED_TICK_MS: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

const ping = () => new Promise((res) => {
  const req = http.get({ host: '127.0.0.1', port: aport, path: '/api/health', timeout: 2000 }, (r) => { res(r.statusCode); r.resume(); });
  req.on('error', (e) => res(e.code || e.message));
  req.on('timeout', () => { req.destroy(); res('timeout'); });
});

let up = false;
for (let i = 0; i < 100; i++) {
  if (srv.exitCode !== null) break;
  if (await ping() === 200) { up = true; break; }
  await wait(300);
}
if (!up) {
  console.log('  ✗ server 没起来\n' + log.slice(-1500));
  srv.kill('SIGKILL'); model.srv.close();
  process.exit(1);
}

/* 给两三个 tick 的时间：一次开火 + 一轮模型往返 */
await wait(4000);

const sessFile = path.join(sessDir, `${SID}.json`);
let saved = null;
try { saved = JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch { /* 没落盘 */ }

console.log('\n① 到点自己开了一轮');
{
  ok(!!saved, '会话落盘了（真开了那一轮）');
  const kick = (saved?.messages || []).find((m) => m.role === 'user' && String(m.content).startsWith('[定时]'));
  ok(!!kick, '历史里有那条 `[定时]` 的话（不是被当成普通问答）');
  ok(kick && kick.content.includes('看一眼 n8n'), '话术是任务里那句（模型靠它知道该干什么）');
}

console.log('\n② 定时回合只能查不能改');
{
  const toolMsg = (saved?.messages || []).find((m) => m.role === 'tool');
  const text = String(toolMsg?.content || '');
  ok(!!toolMsg, 'danger 工具确实被叫过（假模型一上来就想装应用）');
  ok(/定时任务/.test(text) && /没人在跟前|不能改/.test(text), `拒信说的是"没人在跟前"（实际：${text.slice(0, 60)}）`);
  ok(!/"ok":true/.test(text), '没有被放行');
}

console.log('\n③ 没人在看 → 未读');
{
  ok((saved?.unread || 0) >= 1, `未读涨了（${saved?.unread}）`);
}

console.log('\n④ 只补跑一次，且下一次已经排好');
{
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const t = tasks[0];
  ok(t.runs === 1, `三秒钟里只跑了 1 次（实际 ${t.runs}）`);
  ok(t.nextAt > Date.now(), '下一次在未来');
  ok(t.running === false || t.running === undefined, '没有卡在 running（卡住就再也不跑了）');
}

console.log('\n⑤ 结论进说话记录');
{
  const said = (saved?.log || []).filter((e) => e.r === 'a');
  ok(said.length >= 1, `说的话进了记录（${said.length} 条）`);
}

srv.kill('SIGKILL');
model.srv.close();
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
if (failed) console.log('\n--- server 日志 ---\n' + log.slice(-2000));
process.exit(failed ? 1 : 0);
