/**
 * 回合循环的自测：`node agent/loop.test.mjs`
 *
 * 它钉住的是一件事，而且是唯一一件事：
 *
 *   **一轮结束时，屏幕上必须有东西 —— 无论模型多不配合。**
 *
 * 起因是线上的一句反馈："我问它系统里装了什么，它去查了，然后就没有然后了。"
 * 查下去发现不是模型的毛病，是循环的形状错了：`for (step < 5)` 走完就算"结束"，
 * 从来没有再问过模型"那你说结论"。而屏幕上的最后一句，往往是一条**不相干**的
 * 兜底（实测："我记得这件事"）。
 *
 * 所以这里不起真模型，起一个**故意坏掉**的桩（`tools/dev/stub-flaky.mjs`），
 * 把"模型不配合"的四种样子都摆一遍：
 *
 *   loop  —— 一直调工具，每步参数都不同，从不说话（= 用户遇到的那种）
 *   stuck —— 每一步都调同一个工具、同一组参数（原地打转）
 *   mute  —— 空回复，没有 content 也没有 tool_calls
 *   dead  —— 连"你说结论"都不理（测最后那道系统兜底）
 *
 * 四种都必须：① 说过话；② 那句话不能是答非所问的记忆兜底；
 * ③ 上层确实向它要过一次结论（收口）。
 *
 * 顺带说明为什么这一份必须起真 server：收口、兜底、不变量都长在回合的**尾部**，
 * 只测纯函数测不到"四条路有没有汇到同一个出口"。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { finalizePrompt, closeLine, stopWord } from './turnstop.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

let failed = 0;
const ok = (c, l, e = '') => {
  if (c) console.log('  ✓ ' + l);
  else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个假模型 + 一个真 server，问一句话，收回这一轮的全部事件。 */
async function runCase(mode) {
  const basePort = 18700 + (process.pid % 200) + Math.floor(Math.random() * 60);
  const fport = basePort;
  const sport = basePort + 300;
  const log = path.join(os.tmpdir(), `flaky-${mode}-${process.pid}.log`);
  try { fs.unlinkSync(log); } catch { /* 首次运行没有 */ }

  const kids = [];
  const kill = () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* 已经死了 */ } } };

  const stub = spawn(NODE, [path.join(ROOT, 'tools/dev/stub-flaky.mjs')], {
    env: { ...process.env, MODE: mode, PORT: String(fport), LOG: log },
    stdio: 'ignore',
  });
  kids.push(stub);

  /* `MODEL=local/xxx` 走"本机那个 OpenAI 兼容服务"，不需要任何 key。
     `SYS=mock` 让工具返回固定数据 —— 这一份测的是循环，不是数据源。 */
  const srv = spawn(NODE, [path.join(ROOT, 'agent/server.mjs')], {
    env: {
      ...process.env,
      PORT: String(sport), SYS: 'mock', DEBUG: '1',
      /* 显式绑 IPv4。默认的 `listen(PORT)` 在 GitHub runner 上出现过
         "banner 打印了、fetch 却连不上"（本机同样的代码没问题）——
         不去猜平台差异，直接让它绑 127.0.0.1。 */
      HOST: '127.0.0.1',
      MODEL: `local/stub-${mode}`,
      MODEL_LOCAL_BASE: `http://127.0.0.1:${fport}/v1`,
      MAX_STEPS: '4',          // 压低一点，测试快；判的是"撞上限有没有收口"，不是上限本身
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(srv);
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.stderr.on('data', (d) => { srvLog += d; });

  const base = `http://127.0.0.1:${sport}`;
  let up = false;
  /* 45 秒。CI 的 2 核冷启动比本机慢一倍多（实测本机 12s、runner 上更久），
     18 秒那版在 GitHub 上四个用例全部"server 起不来"—— 而其实只是慢。
     `exitCode` 一旦非空就别再等了：那才是真失败，等下去只是把错误拖长。 */
  let lastErr = '';
  for (let i = 0; i < 150; i++) {
    if (srv.exitCode !== null) break;
    try { const r = await fetch(`${base}/api/health`); if (r.ok) { up = true; break; } } catch (e) {
      /* `fetch failed` 什么也没说 —— 把 cause 的 code 留住，否则排障只能靠猜 */
      lastErr = `${e.message}${e.cause ? ` / ${e.cause.code || e.cause.message}` : ''}`;
    }
    await wait(300);
  }
  if (!up) {
    /* 再用 http 模块探一次：它只走 IPv4，能把"没监听"和"fetch 这一层的问题"分开 */
    const probe = await new Promise((res) => {
      const req = http.get({ host: '127.0.0.1', port: sport, path: '/api/health', timeout: 3000 }, (r) => {
        res(`HTTP ${r.statusCode}`); r.resume();
      });
      req.on('error', (e) => res(`err ${e.code || e.message}`));
      req.on('timeout', () => { req.destroy(); res('timeout'); });
    });
    kill();
    /* 失败时必须能看见根因：进程是**死了**还是**只是慢**，以及它最后说了什么。 */
    return {
      up: false, exit: srv.exitCode, probe, fetchErr: lastErr,
      log: srvLog.slice(-900),
    };
  }

  const evs = [];
  const sid = `loop-${mode}-${Date.now()}`;
  const ac = new AbortController();
  const sse = fetch(`${base}/api/events?sid=${sid}`, { signal: ac.signal }).then(async (r) => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const p of parts) {
          const line = p.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { evs.push(JSON.parse(line.slice(6))); } catch { /* 半包，下一轮会有 */ }
        }
      }
    } catch { /* abort 就是收尾方式 */ }
  });
  await wait(500);

  await fetch(`${base}/api/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, t: 'ask', text: '系统里装了什么？' }),
  });

  for (let i = 0; i < 100; i++) {
    if (evs.some((e) => e.t === 'idle')) break;
    await wait(300);
  }
  ac.abort();
  await sse.catch(() => {});
  kill();

  /* 桩的请求日志：`tools=0` 且提示里有"不要再调工具"的那一次，就是收口。 */
  let asked = false;
  try {
    asked = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
      /* 桩自己判好了（那段提示一百多字，切尾部切不到关键句） */
      .some((l) => JSON.parse(l).closing === true);
  } catch { /* 一次都没被调过 */ }

  return {
    up: true,
    said: evs.filter((e) => e.t === 'say').map((e) => String(e.text || '')),
    notes: evs.filter((e) => e.t === 'note').map((e) => String(e.message || '')),
    tools: evs.filter((e) => e.t === 'tool' && e.state === 'run').map((e) => e.name),
    asked,
    warned: /静默收口/.test(srvLog),
    idle: evs.some((e) => e.t === 'idle'),
    log: srvLog,
  };
}

/* ── 先测不依赖网络的：收口到底说什么 ──
 *
 * 这三句是"必须有结局"的最后一道话。它们以前埋在 server.mjs 的闭包里，
 * 只能起一个真 server 去测 —— 而 GitHub runner 的本机回环不可靠
 * （同一个地址 fetch 报 ECONNREFUSED、http.get 却拿到 503），
 * 那道闸在 CI 上等于没有。搬到 turnstop.mjs 之后这里就能直接断言。
 */
console.log('收口说什么');
{
  const p1 = finalizePrompt('cap', 7);
  ok(p1.includes('7 次'), '提示里带上"调了 7 次"（模型才知道为什么停）');
  ok(p1.includes('不要再调工具'), '明确禁止再调工具（7B 会硬发文本形式的调用）');
  ok(p1.includes('不要说抱歉'), '明确不要道歉（"很抱歉我无法完成"零信息）');
  ok(p1.includes('查了什么'), '要求说清"查了什么、卡在哪"');
  for (const w of ['cap', 'slow', 'stuck', 'silent']) {
    ok(finalizePrompt(w).length > 10, `${w}：有对应的原因句`);
    ok(stopWord(w) !== w, `${w}：界面上那行是人话（${stopWord(w)}）`);
  }

  /* 模型彻底不说话时：宁可说实话，也不装作答上了 */
  const empty = closeLine([]);
  ok(empty.includes('空的'), '一步没走成 → 说"模型返回的是空的"');
  ok(!/记得|记忆/.test(empty), '不拿记忆顶替');
  const some = closeLine([
    { name: 'fs_list', ok: false }, { name: 'fs_list', ok: false }, { name: 'sys_status', ok: true },
  ], 'cap');
  ok(some.includes('3 次'), `说出真查了几次（${some}）`);
  ok(some.includes('2 次没成'), '说出其中几次没成');
  ok(!/记得|记忆/.test(some), '同样不拿记忆顶替');
  const stuck = closeLine([{ name: 'sys_status', ok: true }], 'stuck');
  ok(stuck.includes('卡住'), '打转时说明是卡住了');
  /* 动词要翻成人话，不能把工具名糊上去 */
  ok(!/fs_list|sys_status/.test(some), '不把工具名直接写给用户看');
}

/** 这个环境的本机回环通不通。不通就别测端到端了 —— 那是环境问题，不是代码问题。 */
async function loopbackOk() {
  const srv = http.createServer((q, r) => { r.writeHead(200); r.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try { const r = await fetch(`http://127.0.0.1:${port}/`); return r.ok; } catch { return false; } finally { srv.close(); }
}

const CASES = [
  { mode: 'loop', why: '一直调工具，从不说话（用户遇到的那种）' },
  { mode: 'stuck', why: '原地打转，同一组参数调三遍' },
  { mode: 'mute', why: '空回复' },
  { mode: 'dead', why: '连"你说结论"也不理' },
];

console.log('每一轮都必须有结局（端到端）');
const endToEnd = (await loopbackOk()) ? CASES : [];
if (!endToEnd.length) {
  console.log('  ⚠ 这个环境的本机回环不通，跳过端到端那四个用例 —— 上面那组纯逻辑已经跑过；');
  console.log('    端到端请在本机跑 `node agent/loop.test.mjs`。');
}
for (const c of endToEnd) {
  const r = await runCase(c.mode);
  ok(r.up, `${c.mode}：server 起来了`,
    `exit=${r.exit === undefined ? '(还在跑)' : r.exit}  probe=${r.probe}  fetch="${r.fetchErr}"
`
    + String(r.log || '').slice(-500));
  if (!r.up) continue;

  ok(r.idle, `${c.mode}：这一轮正常收尾（收到 idle），没有卡住`);
  ok(r.said.length > 0, `${c.mode}：说过话 → ${JSON.stringify(r.said.at(-1) || '')}`);

  /* 答非所问比空白更糟：用户会以为它答了。
     "我记得这件事"只在**它压根没动手**时才允许出现（见 runTurn 里的记忆兜底）。 */
  if (c.mode !== 'mute') {
    ok(r.said.at(-1) !== '我记得这件事', `${c.mode}：没有拿一段旧记忆答非所问`);
  }
  ok(r.asked, `${c.mode}：向模型要过一次结论（收口请求不带工具）`);

  /* 系统兜底那一条只在"模型也没说"时才该说话；说了就说明最后一道闸在。
     `loop`/`stuck`/`mute` 的桩都会给结论，所以这一条只对 dead 有要求。 */
  if (c.mode === 'dead') {
    ok(/查了 \d+ 次|没能给出回答/.test(r.said.at(-1) || ''),
      `${c.mode}：系统按"真的查过什么"说了实话 → ${JSON.stringify(r.said.at(-1) || '')}`);
  }
}

console.log(failed ? `\n${failed} 项没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
