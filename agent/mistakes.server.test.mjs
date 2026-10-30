/**
 * 错题本起真 server 的端到端自测：`node agent/mistakes.server.test.mjs`
 *
 * `mistakes.test.mjs` 测的是判据（哪句话算纠正、什么算命中）。这一份测的是**那条链路**：
 *
 *   ① 用户当场纠正 → 错题落盘（wrong 是它上一轮说的原话，不是总结）；
 *   ② 以后再问同一件事 → **请求里真的带上了那段"上次判断错过"**
 *      （这是最容易假装通过的一步：记了、存了、但从来没 inject 进模型）；
 *   ③ 无关的问题 → 不带（错题不能变成每轮都道歉）。
 *
 * 假模型的作用只是"把收到的请求记下来"，它回什么不重要 ——
 * 要断言的是**服务端喂给它的东西**。
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

const SID = 'sid-mist0001';
const basePort = 19600 + Math.floor(Math.random() * 300);
const sport = basePort;          // 假模型
const aport = basePort + 1;      // agent
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mistake-srv-'));
const sessDir = path.join(tmp, 'sessions');
const misFile = path.join(tmp, 'mistakes.json');
fs.mkdirSync(sessDir, { recursive: true });

/** 假模型：把每次请求里的 messages 存下来，回一句固定的话 */
const requests = [];
const stub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(buf || '{}'); } catch { /* 探活 */ }
    if (Array.isArray(body.messages)) requests.push(body.messages);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'c1', object: 'chat.completion', model: 'stub',
      choices: [{ index: 0, message: { role: 'assistant', content: '音乐库是 Navidrome。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
    }));
  });
});
await new Promise((r) => stub.listen(sport, '127.0.0.1', r));

const srv = spawn(NODE, [path.join(ROOT, 'agent/server.mjs')], {
  env: {
    ...process.env,
    PORT: String(aport), HOST: '127.0.0.1', SYS: 'mock',
    MODEL: 'local/miststub', MODEL_KEY: 'stub-key',
    MODEL_LOCAL_BASE: `http://127.0.0.1:${sport}/v1`,
    SETTINGS_FILE: path.join(tmp, 'settings.json'),
    SESSIONS_DIR: sessDir,
    USAGE_DIR: path.join(tmp, 'usage'),
    TASKS_FILE: path.join(tmp, 'tasks.json'),
    MISTAKES_FILE: misFile,
    /* 记忆侧车在这台机器上没有 → 关掉，测的是错题本自己的链路 */
    MEMORY: '0',
    SCHED_TICK_MS: '600000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

const get = (p) => new Promise((res) => {
  const req = http.get({ host: '127.0.0.1', port: aport, path: p, timeout: 3000 }, (r) => { res(r.statusCode); r.resume(); });
  req.on('error', (e) => res(e.code || e.message));
  req.on('timeout', () => { req.destroy(); res('timeout'); });
});
const post = (p, body) => new Promise((res) => {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port: aport, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); });
  req.on('error', () => res(0));
  req.write(data);
  req.end();
});

let up = false;
for (let i = 0; i < 100; i++) {
  if (srv.exitCode !== null) break;
  if (await get('/api/health') === 200) { up = true; break; }
  await wait(300);
}
if (!up) {
  console.log('  ✗ server 没起来\n' + log.slice(-1200));
  srv.kill('SIGKILL'); stub.close();
  process.exit(1);
}

const sessFile = path.join(sessDir, `${SID}.json`);
const readSess = () => { try { return JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch { return null; } };

/** 问一句，等这一轮真的落盘（落盘 = 回合结束） */
async function ask(text) {
  const before = (readSess()?.messages || []).length;
  await post('/api/send', { sid: SID, t: 'ask', text });
  for (let i = 0; i < 60; i++) {
    await wait(250);
    const s = readSess();
    if (s && (s.messages || []).length > before + 1 && s.line) return s;
  }
  return readSess();
}

console.log('\n① 第一轮：它答错了（假模型固定回答"音乐库是 Navidrome"）');
{
  const s = await ask('我的音乐库跑在哪个服务上？');
  ok(!!s && /Navidrome/.test(s.line || ''), `它说了那句话（${(s?.line || '').slice(0, 20)}）`);
  ok(!fs.existsSync(misFile), '还没纠正，不该有错题');
}

console.log('\n② 用户当场纠正 → 落一条错题');
{
  const s = await ask('不对，我说的是 Jellyfin');
  ok(!!s, '这一轮跑完了');
  const arr = fs.existsSync(misFile) ? JSON.parse(fs.readFileSync(misFile, 'utf8')) : [];
  ok(arr.length === 1, `错题落盘一条（实际 ${arr.length}）`);
  ok(/Navidrome/.test(arr[0]?.wrong || ''), `wrong 是它上一轮的原话（${arr[0]?.wrong}）`);
  ok(/Jellyfin/.test(arr[0]?.right || ''), `right 是用户的原话（${arr[0]?.right}）`);
  ok(arr[0]?.scene?.includes('jellyfin'), `场景词抽到了具体名字（${arr[0]?.scene}）`);
}

console.log('\n③ 再问同一件事 → 错题真的进了请求');
{
  const mark = requests.length;
  await ask('Jellyfin 里有几个用户？');
  const fresh = requests.slice(mark).flat();
  const all = fresh.map((m) => String(m.content || '')).join('\n');
  ok(/上次这里判断错过/.test(all), '请求里带上了"上次这里判断错过"这一段');
  ok(/Navidrome/.test(all) && /Jellyfin/.test(all), '两句原话都在（模型能照着避开）');
  ok(fresh.some((m) => m.role === 'user' && /Jellyfin 里有几个用户/.test(m.content || '')), '问题本身也在（没串台）');
}

console.log('\n④ 无关的问题 → 不带（错题不能变成每轮道歉）');
{
  const mark = requests.length;
  await ask('磁盘还剩多少空间？');
  const all = requests.slice(mark).flat().map((m) => String(m.content || '')).join('\n');
  ok(!/上次这里判断错过/.test(all), '没把错题塞进无关问题');
}

console.log('\n⑤ 同一句纠正再来一次 → 只加重，不重复记');
{
  await ask('不是，我说的是 Jellyfin');
  const arr = JSON.parse(fs.readFileSync(misFile, 'utf8'));
  ok(arr.length === 1 && arr[0].repeat >= 1, `还是一条，repeat=${arr[0]?.repeat}`);
}

srv.kill('SIGKILL');
stub.close();
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
if (failed) console.log('\n--- server 日志 ---\n' + log.slice(-1500));
process.exit(failed ? 1 : 0);
