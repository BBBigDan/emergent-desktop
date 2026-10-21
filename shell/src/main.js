/**
 * 壳层入口：拿应用列表 → 左侧边缘的应用栏 → 点击时从粒子里长出一个窗口。
 *
 * 应用栏不常驻：鼠标贴到屏幕左边，粒子才聚成图标；移开就散。
 * 图标是 WebGL 粒子画的（field.js 的 rail 组），DOM 那层是透明的命中区。
 */
import { Field } from './field.js';
import { ShellWindow } from './window.js';
import { createRail } from './rail.js';
import { createLauncher } from './launcher.js';
import { createStatus } from './status.js';
import { createDeskAgent } from './deskagent.js';
import { myApps, gotoLogin, logout, terminusBase } from './api.js';

/* WebGL 起不来时别静默失败：整个桌面就只剩一块渐变背景，没有任何报错。
   （macOS 上曾有这个问题：画布 alpha 一直是 0，ANGLE/Metal 按规范当全透明处理。） */
let field = null;
try {
  field = new Field(document.getElementById('scene'));
} catch (e) {
  console.error('[shell] 粒子场初始化失败', e);
  const el = document.createElement('div');
  el.id = 'fatal';
  el.textContent = 'WebGL 初始化失败：' + (e && e.message ? e.message : e);
  document.body.appendChild(el);
  throw e;
}
const wins = new Map();          // group -> ShellWindow
const freeGroups = [2, 1, 0];    // 后进先出，避免和已有窗口抢同一组粒子
const boot = document.getElementById('boot');

let rail = null;
let launch = null;
let status = null;
/* 桌面里的 agent：不是页面，是这一层。唤出时它接管同一批粒子，
   桌面（应用栏 / 启动台 / 状态面板）让位；收起时粒子散回球面。 */
let agent = null;

window.addEventListener('resize', () => {
  field.resize();
  if (rail) field.setRailCenters(rail.layout());
  status?.layout();
  for (const w of wins.values()) field.setRect(w.g, w.rect);
});

/* ------------------------- 应用列表（launchpad） -------------------------
 * 手势：**按住鼠标来回快速甩**。桌面 → 3D 圆环画廊 → 2D 平铺 → 桌面（循环）。
 *   - 每一"甩"由 field.detectFlick 在拖动过程中判（不要求松手）；
 *   - 这里只负责数"两下"：1.1s 内凑够两次才算一组。
 * 为什么用甩动而不是按钮：桌面平时没有任何 UI，甩动是唯一不打断沉浸的手势。 */
let flicks = [];
let flickLock = 0;

function cycleLaunch() {
  const next = field.launchMode === 2 ? 0 : field.launchMode + 1;
  if (!next) {
    launch?.close();
    field.setLaunchMode(0);
    return;
  }
  rail?.close();
  launch?.open(next);
  field.setLaunchMode(next);
}

/* 点应用栏里的「启动台」：直接进平铺 —— 官方的 launchpad 本来就是网格那种 */
function openLaunchpad() {
  if (!launch || field.launchMode === 2) return;
  rail?.close();
  launch.open(2);
  field.setLaunchMode(2);
}

function onFlick() {
  const now = performance.now();
  /* 刚切完视图，手还在按着往回收，惯性里很容易再蹭出一下。
     冷却期内不收 —— 不然"甩两下进列表"会连着变成"甩四下进平铺"。 */
  if (now < flickLock) return;
  flicks = flicks.filter((t) => now - t < 1100);
  flicks.push(now);
  if (flicks.length >= 2) {
    flicks = [];
    flickLock = now + 850;
    cycleLaunch();
    return;
  }
}

/* ------------------------------- 主循环 ------------------------------- */
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  field.step(dt);
  for (const [g, w] of wins) w.setReveal(field.revealOf(g));
  /* 图标是粒子画的，DOM 那层只负责名字/命中区，位置每帧跟着投影走 */
  if (launch?.isOpen()) launch.sync((i) => field.lpScreen[i] || null);
  /* 面板的文字跟着粒子走：粒子流到位，字才浮出来（同窗口的 --rev） */
  status?.sync(field.statReveal());
  field.render();

  // 散开结束后才真正移除 DOM，避免粒子还在飞但窗口已经消失
  for (const [g, w] of wins) {
    if (w.dying && !field.groups[g].active) {
      const id = w.app.id;
      w.destroy();
      wins.delete(g);
      freeGroups.unshift(g);
      /* 那个应用没有别的窗口了，就把应用栏里的"已打开"标记清掉 */
      if (![...wins.values()].some((x) => x.app.id === id)) rail?.setActive('');
      if (!wins.size) document.body.classList.remove('has-win');
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ------------------------------- 窗口管理 ------------------------------- */
function openApp(app, at) {
  /* 从应用列表里点开：先退出列表（图标散开），再把窗口从粒子里长出来 */
  if (field.launchMode) {
    launch?.close();
    field.setLaunchMode(0);
  }
  // 已经开着就置前
  for (const [, w] of wins) {
    if (w.app.id === app.id) {
      w.el.style.zIndex = String(++zTop);
      if (w.minimized) { w.restore(); field.setRect(w.g, w.rect); field.open(w.g, w.rect); }
      return;
    }
  }
  if (!freeGroups.length) {
    const oldest = [...wins.values()][0];
    oldest.requestClose();
    setTimeout(() => openApp(app), 60);
    return;
  }
  const g = freeGroups.pop();
  const w = new ShellWindow(app, g, () => {});
  w.el.style.zIndex = String(++zTop);
  wins.set(g, w);

  w.onResize = (gg, rect) => field.setRect(gg, rect);
  w.onMinimize = () => {
    w.minimized = true;
    w.el.classList.add('minimized');
    field.close(g);
  };
  w.onClose = () => {
    w.dying = true;
    field.close(g);
  };
  stage(w, app);
  field.open(g, w.rect, at);
  document.body.classList.add('has-win');
}

let zTop = 10;

function stage(w, app) {
  // 同标题栏重叠时点一下能置前
  w.el.addEventListener('pointerdown', () => { w.el.style.zIndex = String(++zTop); });
  rail?.setActive(app.id);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ------------------------------- 启动 ------------------------------- */

/* `?apps=demo`：不带登录态也能把桌面立起来。
 * 调 UI（尤其是 agent 这一层）不该先过一次 SSO —— 它和登录本来就没关系。
 * 图标是粒子按名字生成的，所以这里不需要真实 icon。 */
function demoApps() {
  if (new URLSearchParams(location.search).get('apps') !== 'demo') return null;
  return [
    { id: 'files', name: 'files', title: 'Files', icon: '', host: 'about:blank', openMethod: 'default' },
    { id: 'vault', name: 'vault', title: 'Vault', icon: '', host: 'about:blank', openMethod: 'default' },
    { id: 'n8n', name: 'n8n', title: 'n8n', icon: '', host: 'about:blank', openMethod: 'default' },
    { id: 'navidrome', name: 'navidrome', title: 'Navidrome', icon: '', host: 'about:blank', openMethod: 'default' },
  ];
}

(async function start() {
  try {
    /* agent 先挂上：它不需要应用列表，但它是这个桌面的"底" ——
       用户任何时候贴着底边都该能把它拉出来，哪怕应用列表还没到。 */
    agent = createDeskAgent({
      field,
      onOpenChange: (v) => {
        if (!v) return;
        /* 场被 agent 接管时，桌面的三处"边缘 UI"先收拢：
           它们用的是各自的粒子段，不会覆盖场，但同时在屏幕上就是三套东西在说话。 */
        rail?.close();
        launch?.close();
        field.setLaunchMode(0);
        status?.close();
      },
    });

    const apps = demoApps() || await myApps();

    rail = createRail({
      apps,
      onPick: (app, at) => openApp(app, at),
      onLaunchpad: openLaunchpad,
      onLogout: logout,
      onOpen: (ptr) => field.openRail(ptr),
      onClose: () => field.closeRail(),
      onHover: (i, v) => field.setRailHover(i, v),
      onBurst: (i) => field.closeRail(i),
      onActive: (i) => field.setRailActive(i),
      /* 官方图标是异步换上的，到了就重建一次槽位（sig 带 rev，能识别出换过） */
      onIcons: () => { if (rail) field.setRail(rail.items, rail.layout()); },
    });
    // 先给点阵，再给屏幕坐标：field 两侧都齐了才开始有目标可拉
    field.setRail(rail.items, rail.layout());

    /* 应用列表用同一批应用（和左边缘应用栏同一个数据源），
       但图标采样更细：132px 的方框配 44 格 */
    launch = createLauncher({
      apps,
      onPick: (app, at) => openApp(app, at),
      onHover: (i, v) => field.setLaunchHover(v ? i : -1),
      onDots: (items) => field.setLaunch(items),
    });
    field.setLaunch(launch.items);

    /* 右下角设备状态：走的是和应用栏同一条"流"，只是目标换成了仪表盘点阵 */
    status = createStatus({
      onOpen: () => field.openStat(),
      onClose: () => field.closeStat(),
      onDots: (dots, panel) => field.setStat(dots, panel),
    });
    status.layout();
    field.setStat(status.dots, status.panel);

    field.onFlick = onFlick;
    /* 图标上的"按下-抬起"（几乎没位移）当成点击：位置判定在 field 里做 */
    field.onIcon = (i) => launch?.pick(i);

    /* ?debug=1 时把内部对象挂出去，便于用 CDP 量粒子状态 */
    if (new URLSearchParams(location.search).has('debug')) {
      window.__em = { field, rail, launch, status, wins, cycleLaunch, agent };
    }

    boot.classList.add('hide');
    setTimeout(() => boot.remove(), 700);

    /* ?stat=1 直接展开设备状态面板：调参时不用把鼠标挪到角落 */
    if (new URLSearchParams(location.search).has('stat')) {
      setTimeout(() => status.open(), 700);
    }

    // ?open=<id|title 关键字> 直接开一个，便于反复调参
    const want = new URLSearchParams(location.search).get('open');
    if (want) {
      const hit = apps.find((a) => a.id === want || a.title.toLowerCase().includes(want.toLowerCase()));
      if (hit) setTimeout(() => openApp(hit), 500);
    }
  } catch (e) {
    if (e.code === 'NO_SESSION') { gotoLogin(); return; }
    boot.innerHTML = `<div class="boot-err">加载失败：${escapeHtml(e.message)}<br><small>${escapeHtml(terminusBase())}</small></div>`;
  }
})();

/* ------------------------------- 全屏 -------------------------------
 * F 键切全屏。不加任何提示文案 —— 桌面平时一个字都没有，全靠手势/按键，
 * 看过仓库的人知道有这回事。iframe 里的按键不会冒泡到本文档，所以不影响应用内部。 */
function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement) { d.exitFullscreen?.().catch(() => {}); return; }
  d.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
}

// Esc：先收 agent，再退出应用列表，再收应用栏，都没有就关最上层窗口
const _esc = () => {
  /* Esc 撤掉的是"眼前最上面那一层"：记录是浮在场上的，先收它 */
  if (agent?.isOpen()) {
    /* 三级：先收记录，再停这一轮，最后才收整个场。
       "停下这一轮"排在"收起"前面，因为跑着的时候用户按 Esc 想撤的多半是
       这三十秒的等待，而不是他刚打开的这片界面。 */
    /* 按"眼前最上面那一层"排：渲染树是屏幕正中最大的东西，先收它；
       然后是记录面板、再是这一轮、最后才收整个场。 */
    if (agent.closeSurface?.()) return;
    if (agent.closeHistory?.()) return;
    if (agent.isDrawing?.()) { agent.stopDraw?.(); return; }
    if (agent.isBusy?.()) { agent.abort?.(); return; }
    agent.close();
    return;
  }
  if (field.launchMode) { launch?.close(); field.setLaunchMode(0); return; }
  if (rail?.isOpen()) { rail.close(); return; }
  let top = null;
  for (const w of wins.values()) if (!w.dying && (!top || +w.el.style.zIndex > +top.el.style.zIndex)) top = w;
  top?.requestClose();
};
window.addEventListener('keydown', (e) => {
  /* 在输入框里打字时，按键归输入框。不排除的话，跟 agent 说话时打一个 "f"
     就会整个桌面进全屏 —— 而且用户完全不知道是自己打出来的。 */
  const t = document.activeElement;
  const typing = t instanceof Element
    && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (typing && e.key !== 'Escape') return;
  if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    toggleFullscreen();
    return;
  }
  if (e.key === 'Escape') {
    if (document.activeElement?.tagName === 'IFRAME') return;  // iframe 里的 Esc 不算
    _esc();
  }
});


/* ------------------------------- 诊断 -------------------------------
 * ?diag=1 在左上角摊开 WebGL 的真实情况 —— 专治"某个浏览器上看不到粒子"
 * 这种没法远程复现的问题（尤其 macOS 的 ANGLE/Metal 和各家 GPU 驱动）。
 * 只在显式带参数时出现，正常桌面一个字都没有。 */
if (new URLSearchParams(location.search).has('diag')) {
  const el = document.createElement('div');
  el.id = 'diag';
  document.body.appendChild(el);

  const gl = field.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  let frames = 0;
  let fps = 0;
  const tick = () => { frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => { fps = frames; frames = 0; }, 1000);

  const rows = () => {
    const ca = gl.getContextAttributes() || {};
    const info = field.renderer.info;
    return [
      ['UA', navigator.userAgent],
      ['viewport', `${innerWidth}×${innerHeight} @${devicePixelRatio}x`],
      ['canvas', `${field.canvas.width}×${field.canvas.height} · css ${field.canvas.style.width}×${field.canvas.style.height}`],
      ['gl', gl.getParameter(gl.VERSION)],
      ['gpu', dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(no debug ext)'],
      ['ctx', `alpha=${ca.alpha} premultiplied=${ca.premultipliedAlpha} depth=${ca.depth}`],
      ['points', `${field.geo.attributes.position.count} 个顶点 · ${info.render.calls} draw calls`],
      ['blend', `src=${field.mat.blendSrc} dst=${field.mat.blendDst} srcA=${field.mat.blendSrcAlpha}`],
      ['fps', String(fps)],
    ];
  };

  const paint = () => {
    el.textContent = rows().map(([k, v]) => `${k.padEnd(9)}${v}`).join('\n');
  };
  paint();
  setInterval(paint, 700);
}
