/**
 * 壳层入口：拿应用列表 → 画 dock → 点击时从粒子里长出一个窗口。
 */
import { Field } from './field.js';
import { ShellWindow } from './window.js';
import { createDockIcon } from './dockicon.js';
import { myApps, gotoLogin, logout, terminusBase } from './api.js';

const field = new Field(document.getElementById('scene'));
const wins = new Map();          // group -> ShellWindow
const freeGroups = [2, 1, 0];    // 后进先出，避免和已有窗口抢同一组粒子
const boot = document.getElementById('boot');
const dockEl = document.getElementById('dock');
const hudEl = document.getElementById('hud');

window.addEventListener('resize', () => {
  field.resize();
  for (const w of wins.values()) field.setRect(w.g, w.rect);
});

/* ------------------------------- 主循环 ------------------------------- */
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  field.step(dt);
  for (const [g, w] of wins) w.setReveal(field.revealOf(g));
  field.render();

  // 散开结束后才真正移除 DOM，避免粒子还在飞但窗口已经消失
  for (const [g, w] of wins) {
    if (w.dying && !field.groups[g].active) {
      w.destroy();
      wins.delete(g);
      freeGroups.unshift(g);
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ------------------------------- 窗口管理 ------------------------------- */
function openApp(app) {
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
  dockIcons.get(app.id)?.burst();
  field.open(g, w.rect);
}

let zTop = 10;

function stage(w, app) {
  // 同标题栏重叠时点一下能置前
  w.el.addEventListener('pointerdown', () => { w.el.style.zIndex = String(++zTop); });
  dockEl.querySelectorAll('.dock-item').forEach((d) =>
    d.classList.toggle('active', d.dataset.id === app.id && !w.dying));
}

/* ------------------------------- dock ------------------------------- */
/* 图标不是 <img>，是粒子画的：glyph.js 出字形 → dockicon.js 采样成点阵 */
const ICON = 52;
const dockIcons = new Map();     // app.id -> icon

function dockButton(cls, label) {
  const b = document.createElement('button');
  b.className = 'dock-item' + (cls ? ' ' + cls : '');
  b.title = label;
  const slot = document.createElement('span');
  slot.className = 'dock-icon';
  b.appendChild(slot);
  b.addEventListener('pointerenter', () => iconOf(b)?.setHover(true));
  b.addEventListener('pointerleave', () => iconOf(b)?.setHover(false));
  return { b, slot };
}
const iconOf = (b) => b.__icon;

function renderDock(apps) {
  dockEl.innerHTML = '';
  dockIcons.clear();
  for (const app of apps) {
    const { b, slot } = dockButton('', app.title);
    b.dataset.id = app.id;
    const ic = createDockIcon(slot, { name: app.name, title: app.title, size: ICON });
    b.__icon = ic;
    dockIcons.set(app.id, ic);
    b.addEventListener('click', () => { ic.burst(); openApp(app); });
    dockEl.appendChild(b);
  }
  // 登出放在最右
  const { b: out, slot: oslot } = dockButton('dock-logout', '登出');
  out.__icon = createDockIcon(oslot, { glyph: 'power', title: '登出', size: ICON });
  out.addEventListener('click', logout);
  dockEl.appendChild(out);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ------------------------------- 启动 ------------------------------- */
(async function start() {
  try {
    const apps = await myApps();
    renderDock(apps);
    hudEl.textContent = `${terminusBase()} · ${apps.length} 个应用`;
    boot.classList.add('hide');
    setTimeout(() => boot.remove(), 700);

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

// Esc 关闭最上层窗口
const _esc = () => {
  let top = null;
  for (const w of wins.values()) if (!w.dying && (!top || +w.el.style.zIndex > +top.el.style.zIndex)) top = w;
  top?.requestClose();
};
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.activeElement?.tagName === 'IFRAME') return;  // iframe 里的 Esc 不算
    _esc();
  }
});
