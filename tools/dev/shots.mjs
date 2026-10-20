/**
 * README 截图：一条会话里把每个状态拍下来（真实页面、真实 rAF，不是首帧）。
 *
 * 用法（先起 mock 服务、再起一个带调试端口的 Chrome）：
 *
 *   node tools/dev/mock-shell.mjs 8778 &
 *   chrome --headless=new --remote-debugging-port=9224 --no-proxy-server  *          --hide-scrollbars --window-size=1440,900 about:blank
 *   node tools/dev/shots.mjs http://127.0.0.1:8778/?debug=1 docs/images
 *
 * 鼠标一律走 CDP 的 Input.dispatchMouseEvent（真实的 hover，会触发 :hover 和
 * pointerenter），不用合成事件 —— 这样截图里的悬停态就是用户真看到的那样。
 *
 * 窗口里的 iframe 是 https://mock-files.local（本地没这个域名，会变成白错误页），
 * 所以开窗后用 Page.setDocumentContent 把那个 frame 换成一个仿 Olares Files 的页面 ——
 * 只为了截图好看，不动仓库里的任何代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CDP_PORT || 9224);
const BASE = process.argv[2] || 'http://127.0.0.1:8778/?debug=1';
const OUT = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/images'));
const VIEW = (process.env.VIEW || '1440x900').split('x').map(Number);

const http = async (p, method = 'GET') => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${p}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES_HTML = `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; overflow:hidden; font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;
         color:#dfeaf7; background:linear-gradient(160deg,#0b1522 0%,#0a1120 55%,#0c1424 100%); }
  .app { display:flex; height:100vh; }
  .side { width:196px; padding:18px 12px; border-right:1px solid rgba(120,180,255,.09);
          background:rgba(9,18,30,.55); }
  .grp { margin-bottom:22px; }
  .gh { font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:#5e7893; padding:0 10px 8px; }
  .it { display:flex; align-items:center; gap:9px; padding:7px 10px; border-radius:8px; color:#a9bed4; font-size:13px; }
  .it.on { background:rgba(64,160,255,.13); color:#8fd3ff; }
  .dot { width:6px; height:6px; border-radius:50%; background:currentColor; opacity:.75; }
  .main { flex:1; padding:22px 26px; overflow:hidden; }
  .bar { display:flex; align-items:center; gap:12px; margin-bottom:20px; }
  .path { font-size:12.5px; color:#6d8aa6; }
  .path b { color:#c9ddf0; font-weight:600; }
  .tools { margin-left:auto; display:flex; gap:8px; }
  .pill { font-size:11.5px; padding:5px 11px; border-radius:20px; color:#7fa6c8;
          border:1px solid rgba(120,180,255,.14); }
  h2 { font-size:15px; font-weight:600; color:#cfe4f7; margin:0 0 14px; letter-spacing:.02em; }
  .grid { display:grid; grid-template-columns:repeat(5,1fr); gap:14px; }
  .card { padding:14px 12px 12px; border-radius:12px; text-align:center;
          background:rgba(126,182,255,.045); border:1px solid rgba(126,182,255,.07); }
  .ico { width:38px; height:30px; margin:0 auto 9px; border-radius:4px;
         background:linear-gradient(180deg,rgba(120,200,255,.55),rgba(60,130,220,.35));
         box-shadow:0 0 18px rgba(80,170,255,.18); }
  .nm { font-size:12px; color:#b6cde2; }
  .mt { font-size:10.5px; color:#5d7893; margin-top:3px; }
  .row { display:flex; align-items:center; gap:12px; padding:9px 10px; border-radius:9px; }
  .row:nth-child(odd) { background:rgba(126,182,255,.03); }
  .row .ic { width:22px; height:18px; border-radius:3px; background:rgba(120,200,255,.35); }
  .row .nm2 { flex:1; font-size:12.5px; color:#aec5da; }
  .row .sz { font-size:11px; color:#5d7893; width:64px; text-align:right; }
  .row .dt { font-size:11px; color:#5d7893; width:96px; text-align:right; }
</style>
<div class="app">
  <aside class="side">
    <div class="grp">
      <div class="gh">Workspace</div>
      <div class="it on"><span class="dot"></span>Home</div>
      <div class="it"><span class="dot"></span>Documents</div>
      <div class="it"><span class="dot"></span>Pictures</div>
      <div class="it"><span class="dot"></span>Downloads</div>
    </div>
    <div class="grp">
      <div class="gh">Drive</div>
      <div class="it"><span class="dot"></span>Sync</div>
      <div class="it"><span class="dot"></span>Shared with me</div>
      <div class="it"><span class="dot"></span>External</div>
    </div>
  </aside>
  <main class="main">
    <div class="bar">
      <div class="path">Home / <b>Documents</b></div>
      <div class="tools"><span class="pill">Name</span><span class="pill">Modified</span><span class="pill">Size</span></div>
    </div>
    <h2>Folders</h2>
    <div class="grid">
      <div class="card"><div class="ico"></div><div class="nm">Design</div><div class="mt">18 items</div></div>
      <div class="card"><div class="ico"></div><div class="nm">Notes</div><div class="mt">42 items</div></div>
      <div class="card"><div class="ico"></div><div class="nm">Photos</div><div class="mt">1.2k items</div></div>
      <div class="card"><div class="ico"></div><div class="nm">Archive</div><div class="mt">96 items</div></div>
      <div class="card"><div class="ico"></div><div class="nm">Backups</div><div class="mt">7 items</div></div>
    </div>
    <h2 style="margin-top:24px">Files</h2>
    <div class="row"><span class="ic"></span><span class="nm2">emergent-desktop-设计方案.pdf</span><span class="sz">2.4 MB</span><span class="dt">今天 09:12</span></div>
    <div class="row"><span class="ic"></span><span class="nm2">particle-field-notes.md</span><span class="sz">18 KB</span><span class="dt">昨天 22:40</span></div>
    <div class="row"><span class="ic"></span><span class="nm2">portal-v0.17.mp4</span><span class="sz">64 MB</span><span class="dt">10 月 18 日</span></div>
    <div class="row"><span class="ic"></span><span class="nm2">读数与点距验证.csv</span><span class="sz">240 KB</span><span class="dt">10 月 17 日</span></div>
  </main>
</div>`;

async function main() {
  let target;
  try { target = await http('/json/new?' + encodeURIComponent(BASE), 'PUT'); }
  catch { target = await http('/json/new?' + encodeURIComponent(BASE)); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const jsErrors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    /* iframe 请求被拦下来换成仿 Olares Files 的页面（本地没有 mock-files.local 这个域名） */
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params;
      const body = Buffer.from(FILES_HTML, 'utf8').toString('base64');
      const p = request.url.includes('mock-files.local')
        ? send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
          body,
        })
        : send('Fetch.continueRequest', { requestId });
      p.catch(() => { });
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*mock-files.local*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1, mobile: false,
  });
  await new Promise((res) => {
    const t = setTimeout(res, 20000);
    const h = (e) => {
      if (JSON.parse(e.data).method === 'Page.loadEventFired') { clearTimeout(t); ws.removeEventListener('message', h); res(); }
    };
    ws.addEventListener('message', h);
  });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) console.error('[expr-exception]', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('  [' + name + ']');
  };
  /* 真实鼠标：hover / click 都走 Input 域，:hover 才会生效 */
  const mouse = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  const click = async (x, y) => {
    await mouse(x, y);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };

  await sleep(3200);   // 应用列表 + 图标采样

  /* 截图要的是"稳态"：指定形态 + 跳过 0.9s 的收拢 + 关掉心跳（别拍到抽搐那一帧）。
     shapeT 归零，免得拍着拍着 9s 到了自己换形态。 */
  const settle = (id) => ev(`(()=>{const f=__em.field;f.shapeId=${id};f.shapeT=0;f.shapeSeed=0.35;`
    + `f.computeShape();f.shapeAt=f.time-5;f.beatNext=1e9;f.beatT=0.5;return 'ok'})()`);

  /* 1. 桌面空闲态 */
  await settle(0);
  await mouse(1330, 800);
  await sleep(1800);
  await shot('shell-desktop');

  /* 2. 左边缘应用栏：真实 hover 到第二个图标（启动台），名字会浮出来 */
  await settle(0);
  await mouse(10, 450);
  await sleep(2500);
  await mouse(56, 350);
  await sleep(1100);
  await shot('shell-rail');

  /* 3. 3D 圆环画廊 */
  await mouse(700, 700);
  await sleep(700);
  await ev('__em.cycleLaunch()');
  await sleep(3400);
  await shot('shell-launch-ring');

  /* 4. 2D 平铺（每个图标一圈粒子流） */
  await ev('__em.cycleLaunch()');
  await sleep(3400);
  await shot('shell-launch-grid');

  /* 5. 右下角设备状态（空白桌面，面板才干净） */
  await ev('__em.cycleLaunch()');       // 回桌面
  await sleep(2400);
  await settle(2);                      // 星系形态，和面板一起入镜
  /* 用 JS 展开面板、再把光标挪开：真实交互下光标必须一直待在角落，
     打开后把光标移走，面板会保持到指针移出。 */
  await ev('__em.status.open()');
  await sleep(3400);
  await mouse(980, 330);
  await sleep(900);
  console.log('  status: ' + await ev('JSON.stringify({on:+__em.field.statOn.toFixed(2),rev:+__em.field.statReveal().toFixed(2),mode:__em.status.src.mode,v:__em.status.src.values})'));
  await shot('shell-status');
  const det = await send('Page.captureScreenshot', {
    format: 'png', clip: { x: 1032, y: 692, width: 388, height: 196, scale: 3 },
  });
  fs.writeFileSync(`${OUT}/shell-status-detail.png`, Buffer.from(det.data, 'base64'));
  console.log('  [shell-status-detail]');
  await ev('__em.status.close()');
  await sleep(700);

  /* 6. 开窗：先拍"门"撑开的中途，再拍定型（粒子全部让到窗口外缘的日冕） */
  await settle(0);
  await mouse(10, 450);
  await sleep(2400);
  await click(56, 250);                 // 文件
  await sleep(2000);          // 门走到一半：内容刚开始析出、边框还在流
  await shot('shell-door');
  await sleep(1900);
  await sleep(600);
  /* 光标停在标题栏上：别停在内容区边缘，免得 hover 态和截图对不上 */
  await mouse(900, 124);
  await sleep(1200);
  await shot('shell-window');

  if (jsErrors.length) console.error('[js-errors]\n' + jsErrors.join('\n'));
  else console.log('  no js errors');
  ws.close();
  try { await http('/json/close/' + target.id); } catch { }
  process.exit(0);
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
