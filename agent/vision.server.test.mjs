/**
 * 看图端到端：**请求里真的带上了那张图**。
 *
 * 单测（`vision.test.mjs`）证明的是"判断逻辑对"，这一份证明的是
 * **图真的进了模型的上下文** —— 这条链路上最容易假装通过的一步就是
 * "工具返回了 __img，然后没人用它"：工具说自己看过了，模型其实什么都没收到，
 * 而它照样会编一段"图里是……"。
 *
 * 所以这里的桩会把**收到的请求体**记下来，断言两件事：
 *   ① 那一轮请求里有一张真的图（`image_url` + `data:image/png;base64,`）；
 *   ② 工具消息里**没有** base64（图不能从工具结果里漏进上下文 —— 那是几十万字符）。
 *
 * 还测了反面：桩明确说"不收图片"（400）时，这一轮**不能死**，
 * 而且要把结论写进台账（下次不用再撞一次）。
 *
 * 以及一条被用户纠正过的纪律：**不许为了查能力偷偷发试探请求**。
 * 能力来自公开资料（`models.mjs` 的 `vision` 列），这里断言"一轮里没有多余请求"。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redPNG } from './vision.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

let failed = 0;
const ok = (c, l, e = '') => {
  if (c) console.log('  ✓ ' + l);
  else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假模型（OpenAI 兼容）。`reject` = 见到图就 400（模拟"这个模型不收图"）。 */
function stubModel(port, { reject = false } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch { /* 探活没有 body */ }
      const msgs = body.messages || [];
      const imgParts = [];
      for (const m of msgs) {
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content) if (p?.type === 'image_url') imgParts.push({ url: String(p.image_url?.url || ''), role: m.role });
      }
      const toolMsg = msgs.find((m) => m.role === 'tool');
      /* 能力探测长这样：**只有一条** user 消息，里面一张图，问的是颜色。 */
      const isProbe = msgs.length === 1 && imgParts.length === 1;
      seen.push({
        n: msgs.length,
        probe: isProbe,
        images: imgParts,
        toolHasB64: /base64,/.test(String(toolMsg?.content || '')),
        toolContent: String(toolMsg?.content || '').slice(0, 400),
      });

      /* 探测要单独应答：不认它的话，探测会被当成"用户第一句话"，
         于是探测永远答非所问、能力永远是"不知道"。 */
      if (isProbe && !reject) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'p1', object: 'chat.completion', model: 'stub',
          choices: [{ index: 0, message: { role: 'assistant', content: '红色' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
        }));
        return;
      }
      if (reject && imgParts.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'image_url content type is not supported by this model' } }));
        return;
      }

      const done = msgs.some((m) => m.role === 'tool');
      const out = done
        ? { content: imgParts.length ? '看过了，图里是一个红色的方块。' : '我没看到图，只能听你说。', tool_calls: [] }
        : {
          content: '',
          tool_calls: [{
            id: 'call_v1',
            type: 'function',
            function: { name: 'fs_view', arguments: JSON.stringify({ path: '~/Downloads/shot.png' }) },
          }],
        };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', model: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', ...out }, finish_reason: out.tool_calls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
      }));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, seen })));
}

const post = (port, p, obj) => new Promise((res, rej) => {
  const data = JSON.stringify(obj);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 8000 }, (r) => {
    let b = '';
    r.on('data', (c) => { b += c; });
    r.on('end', () => res({ status: r.statusCode, body: b }));
  });
  req.on('error', rej);
  req.on('timeout', () => { req.destroy(rej(new Error('timeout'))); });
  req.end(data);
});

const getRaw = (port, p) => new Promise((res) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(chunks) }));
  });
  req.on('error', (e) => res({ status: 0, error: e.code }));
  req.on('timeout', () => { req.destroy(); res({ status: 0, error: 'timeout' }); });
});

/** 起一套（桩 + server），跑一轮，返回所有观察值。 */
async function run({ reject = false, port }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), reject ? 'vsl-' : 'vok-'));
  const home = path.join(tmp, 'root', 'Home');
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  const png = redPNG(32);
  fs.writeFileSync(path.join(home, 'Downloads', 'shot.png'), png);
  fs.writeFileSync(path.join(home, 'Downloads', 'notes.txt'), '这是文字，不是图');

  const model = await stubModel(port.model, { reject });
  const srv = spawn(NODE, [path.join(ROOT, 'agent/server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port.app), HOST: '127.0.0.1', SYS: 'mock',
      MODEL: 'local/vstub', MODEL_KEY: 'stub-key',
      MODEL_LOCAL_BASE: `http://127.0.0.1:${port.model}/v1`,
      /* 用户空间：`<root>/Home`（fs 层自己去发现） */
      FS_ROOT: path.join(tmp, 'root'),
      SETTINGS_FILE: path.join(tmp, 'settings.json'),
      TASKS_FILE: path.join(tmp, 'tasks.json'),
      MISTAKES_FILE: path.join(tmp, 'mistakes.json'),
      VISION_FILE: path.join(tmp, 'vision.json'),
      SESSIONS_DIR: path.join(tmp, 'sessions'),
      USAGE_DIR: path.join(tmp, 'usage'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });

  const ping = () => new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port: port.app, path: '/api/health', timeout: 2000 }, (r) => { res(r.statusCode); r.resume(); });
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
    srv.kill('SIGKILL'); model.srv.close();
    return { up: false, log, tmp };
  }

  const sid = reject ? 'sid-vsreject01' : 'sid-vsview001';
  /* `sid` 在 **body** 里，不在 query 上 —— 放错地方会得到一个 202 加一次静默的什么都没发生 */
  await post(port.app, '/api/send', { sid, t: 'ask', text: '看看我下载的那张图' });
  /* 一轮 = 两次请求（工具调用 + 收口）。等够时间。 */
  await wait(2500);

  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', `${sid}.json`), 'utf8')); } catch { /* 没落盘 */ }
  let vis = null;
  try { vis = JSON.parse(fs.readFileSync(path.join(tmp, 'vision.json'), 'utf8')); } catch { /* 没测 */ }

  const img = await getRaw(port.app, '/api/fs/img?path=' + encodeURIComponent('~/Downloads/shot.png'));
  const notImg = await getRaw(port.app, '/api/fs/img?path=' + encodeURIComponent('~/Downloads/notes.txt'));
  const escape = await getRaw(port.app, '/api/fs/img?path=' + encodeURIComponent('/etc/passwd'));

  srv.kill('SIGKILL'); model.srv.close();
  await wait(200);
  return { up: true, seen: model.seen, saved, vis, img, notImg, escape, log, sid };
}

const base = 19600 + Math.floor(Math.random() * 200);
const pos = await run({ port: { model: base, app: base + 1 } });

console.log('① 图真的进了模型上下文');
{
  ok(pos.up, '服务起来了');
  /* **不许有探测请求。** 能不能看图是公开信息，查表就够了；
     发一次 8×8 小红图去问一遍，是拿真钱问一个查得到的问题（用户当场纠正过）。 */
  const probes = (pos.seen || []).filter((s) => s.probe);
  const withImg = (pos.seen || []).filter((s) => s.images.length);
  ok(probes.length === 0, `没有偷偷探测（探测请求 ${probes.length} 次）`);
  ok(withImg.length === 1, `业务请求恰好一次带图（${withImg.length}）`);
  const u = withImg[0]?.images?.[0]?.url || '';
  ok(/^data:image\/png;base64,/.test(u), `是 data URL（${u.slice(0, 32)}…）`);
  ok(u.length > 120, `是 32×32 那张原图（${u.length} 字符）`);
  ok(withImg[0]?.images?.[0]?.role === 'user', '图挂在 user 消息上（工具消息塞不进图）');
}

console.log('\n② 工具结果里没有 base64（否则一次就吃满窗口）');
{
  const bad = (pos.seen || []).filter((s) => s.toolHasB64);
  ok(bad.length === 0, `没有任何一条工具结果带 base64（${bad.length} 条）`);
  const t = (pos.seen || []).find((x) => x.toolContent)?.toolContent || '';
  ok(/looked|image|看/.test(t), `工具结果是一句"看过了"（${t.slice(0, 80)}）`);
}

console.log('\n③ 会话里留着那条带图的消息（下一步还要用）');
{
  const msgs = pos.saved?.messages || [];
  const withParts = msgs.filter((m) => Array.isArray(m.content));
  ok(withParts.length === 1, `历史里有一条图文消息（${withParts.length}）`);
  ok(withParts[0]?.role === 'user' && /刚打开|图/.test(JSON.stringify(withParts[0].content.slice(0, 1))), '文字部分说明了"这是你刚打开的图"');
}

console.log('\n④ 屏幕能拿到那张图（用户要知道它在看什么）');
{
  ok(pos.img.status === 200 && pos.img.headers['content-type'] === 'image/png', `/api/fs/img 吐的是 PNG（${pos.img.status}）`);
  ok(pos.img.buf?.length > 50 && pos.img.buf[0] === 0x89 && pos.img.buf[1] === 0x50, `字节是真的 PNG（${pos.img.buf?.length} 字节，头 ${pos.img.buf?.subarray(0, 4).toString('hex')}）`);
  ok(pos.notImg.status === 415, `非图片 415（${pos.notImg.status}）—— 否则这个口子就是文件下载器`);
  ok(pos.escape.status === 400, `越界 400（${pos.escape.status}）`);
}

console.log('\n⑤ 没为"查能力"多花一次请求');
{
  /* 一次成功发图**不写成"能看见"**：网关可能把图悄悄丢了而照样回 200，
     所以"能看"只能来自公开资料，不能来自"这次没报错"。 */
  ok(!pos.vis || Object.keys(pos.vis).length === 0, `台账里没多出记录（${JSON.stringify(pos.vis || {})}）`);
  const reqs = (pos.seen || []).length;
  ok(reqs === 2, `一轮只发了两次请求：工具调用 + 收口（实际 ${reqs}）`);
}

/* ── 反面：接口说"不收图" ── */
const neg = await run({ reject: true, port: { model: base + 2, app: base + 3 } });

console.log('\n⑥ 接口不收图时：这一轮不死，而且记下来');
{
  ok(neg.up, '服务起来了');
  const msgs = neg.saved?.messages || [];
  const said = msgs.filter((m) => m.role === 'assistant').map((m) => String(m.content || '')).join(' ');
  ok(!!said.trim(), `它还是说话了（${said.slice(0, 40)}）`);
  ok(/没看到图|只能听你说|听你说/.test(said), '说的是实话（没假装看过）');
  const k = Object.values(neg.vis || {})[0] || {};
  ok(k.vision === false, `能力表记成 false（${k.why}）`);
  /* 关键：撞了一次之后不该每步都撞 —— 历史里的图要被换成文字 */
  const stillImg = msgs.filter((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'));
  ok(stillImg.length === 0, `历史里的图已经撤掉（还剩 ${stillImg.length} 条带图）`);
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
