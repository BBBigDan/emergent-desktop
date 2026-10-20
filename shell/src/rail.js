/**
 * 左边缘应用栏（rail）—— 不常驻，鼠标贴到屏幕左边才「聚」出来。
 *
 * 视觉全部交给 WebGL 粒子场（field.js 的 rail 组），这里只做三件事：
 *   1. 把**官方图标**采样成点阵（位置 / 颜色），交给 field；
 *   2. 建一层**透明**的 DOM 按钮做命中测试（悬停 / 点击 / 无障碍），
 *      位置和点阵严格对齐 —— 所以点阵是"散"的，命中区仍然是准的；
 *   3. 管开合时机：进左边缘 → 聚；离开 → 散；点某个 → 炸开后消散。
 *
 * 图标来源：**直接用官方 icon.png**，缩到 24×24 后每格的色值就是一颗点。
 * 之前自己画字形（glyph.js）的教训：手绘再像也不是"那个图标"，
 * 而重画一套图标语言本来就不该是我们的工作。现在形状和配色都来自官方图，
 * 只在官方图拿不到时（离线 / 跨域失败）退回字形。
 */
import { glyphOf, paintGlyph, TINT } from './glyph.js';
import { officialDots, scanGlyph, tintDots, letterDots } from './icons.js';

const SIZE = 76;       // 图标方框（CSS px）
const GRID = 32;       // 官方图缩到 32×32 采样 → 每图标 ~900 颗点
const GAP = 20;        // 图标间距
const LEFT = 18;       // 距屏幕左边

/* 官方 dock 的默认清单 —— 直接抄桌面应用的 get_default_dock_list()：
 *     const a = ["files", "launchpad", "market", "settings"]
 * 只有这 4 项，而且列表存在 localStorage("dockerApps") 里，是**用户自己的布局**：
 * 新装的应用不会自动进来（只出现在启动台里），要用户手动 pin 才加。
 * 之前的做法是"把所有应用取前 8 个塞进来"，所以比官方多、还会自己长出来。 */
const DOCK = ['files', 'launchpad', 'market', 'settings'];

/* 系统应用的标题走 i18n（官方是 system_app.${title}），这里直接给中文 */
const TITLE = { files: '文件', launchpad: '启动台', market: '应用市场', settings: '设置' };

/* 启动台是**内置**项，不是应用：官方图标固定取 CDN 这张九宫格 */
const LAUNCHPAD = { id: '__launchpad', title: TITLE.launchpad, kind: 'launchpad' };
const LAUNCHPAD_ICON = 'https://app.cdn.olares.com/appstore/launchpad/icon.png';

/** 按名字找应用（id 形如 `olares-app:files`，name 才是短名） */
function findApp(apps, name) {
  return apps.find((a) => a.name === name)
    || apps.find((a) => {
      const id = String(a.id || '');
      return id === name || id.startsWith(name + ':') || id.endsWith(':' + name);
    });
}

/* --------------------------- 图标 → 点阵 ---------------------------
 * 采样逻辑在 icons.js（应用列表用的是同一份，只是格数更密）。
 * 这里只负责"官方图拿不到就用字形顶上"这一层兜底。 */

function glyphDots(app) {
  const g = glyphOf(app.name, app.title);
  return g
    ? tintDots(scanGlyph((x, s) => paintGlyph(x, g, s), SIZE, GRID), TINT[g], SIZE, GRID)
    : letterDots(app.title, SIZE, GRID);
}

/* ------------------------------- 主件 ------------------------------- */

/**
 * @param {{
 *   apps: Array<{id:string,title:string,name?:string,icon?:string}>,
 *   onOpen?: (ptr:{x:number,y:number}) => void,
 *   onClose?: () => void,
 *   onHover?: (i:number, v:boolean) => void,
 *   onBurst?: (i:number) => void,
 *   onActive?: (i:number) => void,
 *   onPick?: (app:object) => void,
 *   onLaunchpad?: () => void,
 *   onLogout?: () => void,
 *   onIcons?: () => void,
 * }} opt
 */
export function createRail({
  apps, onOpen, onClose, onHover, onBurst, onActive, onPick, onLaunchpad, onLogout, onIcons,
}) {
  const items = [];

  /* 只放官方默认的那 4 项；没装的名字直接跳过（官方也是 `if (!e) continue`） */
  for (const name of DOCK) {
    if (name === LAUNCHPAD.kind) {
      items.push({
        ...LAUNCHPAD,
        app: null,
        icon: LAUNCHPAD_ICON,
        dots: glyphDots({ name: 'appstore', title: LAUNCHPAD.title }),
        box: SIZE,
        rev: 0,
        hover: false,
      });
      continue;
    }
    const app = findApp(apps, name);
    if (!app) continue;
    const title = TITLE[name] || app.title;
    items.push({
      id: app.id, title, glyph: glyphOf(app.name, app.title),
      /* 传给 openApp 的副本带上中文名：窗口标题栏用的是 title */
      app: { ...app, title },
      icon: app.icon,
      dots: glyphDots(app), box: SIZE,
      rev: 0,                    // 0 = 字形兜底，1 = 官方图标（field 靠它判断要不要重建槽位）
      hover: false,
    });
  }

  /* 登出固定排在最后 */
  const outDots = tintDots(scanGlyph((x, s) => paintGlyph(x, 'power', s), SIZE, GRID), TINT.power, SIZE, GRID);
  items.push({ id: '__logout', title: '登出', glyph: 'power', dots: outDots, box: SIZE, rev: 0, hover: false });

  const zone = document.createElement('div');
  zone.className = 'rail-zone';
  const col = document.createElement('div');
  col.className = 'rail';
  zone.appendChild(col);
  document.body.appendChild(zone);

  /* 后台把图标换成官方图：先用字形顶上，图到了再整体换一次（不会空白等待） */
  (async function upgradeIcons() {
    const targets = items.filter((it) => it.icon);
    if (!targets.length) return;
    let changed = false;
    for (const it of targets) {
      try {
        const dots = await officialDots(it.icon, SIZE, GRID);
        if (!dots || !dots.length) continue;
        it.dots = dots;
        it.rev = 1;
        changed = true;
      } catch { /* 单个失败就继续用字形，不影响其它图标 */ }
    }
    if (changed) onIcons?.();
  })();

  let open = false;
  let closeTimer = 0;
  const ptr = { x: 0, y: 0 };

  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rail-item' + (it.id === '__logout' ? ' rail-logout' : '');
    b.style.width = b.style.height = SIZE + 'px';
    b.dataset.id = it.id;
    const lab = document.createElement('span');
    lab.className = 'rail-label';
    lab.textContent = it.title;
    b.appendChild(lab);

    b.addEventListener('pointerenter', () => { it.hover = true; onHover?.(i, true); });
    b.addEventListener('pointerleave', () => { it.hover = false; onHover?.(i, false); });
    b.addEventListener('click', () => {
      /* 先收（"全部散开"），再对被点的图标补一次冲击 —— 顺序反了会被吹散的速度覆盖 */
      closeRail();
      onBurst?.(i);
      /* 把图标中心一起给出去：开窗那条"流"从这一侧流进中心，
         看起来就是"图标散回团里、窗口从团里游出来"（和图标回流的同一段时间） */
      const r = b.getBoundingClientRect();
      const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      if (it.kind === 'launchpad') onLaunchpad?.(at);
      else if (it.app) onPick?.(it.app, at);
      else onLogout?.();
    });

    col.appendChild(b);
    it.btn = b;
  });

  /* 竖排、**整体垂直居中**：现在只有 4 项 + 登出，居中最稳，
     顶部起排会显得"贴在屏幕上沿"、下面空一大片。 */
  function layout() {
    const H = window.innerHeight;
    const n = items.length;
    let gap = GAP;
    const need = n * SIZE + (n - 1) * gap;
    if (need > H - 56) gap = Math.max(4, (H - 56 - n * SIZE) / Math.max(1, n - 1));
    const total = n * SIZE + (n - 1) * gap;
    let y = Math.round((H - total) / 2);

    const centers = [];
    for (const it of items) {
      it.btn.style.left = LEFT + 'px';
      it.btn.style.top = y + 'px';
      centers.push({ x: LEFT + SIZE / 2, y: y + SIZE / 2 });
      y += SIZE + gap;
    }
    return centers;
  }

  function openRail() {
    clearTimeout(closeTimer);
    closeTimer = 0;
    if (open) return;
    open = true;
    zone.classList.add('open');
    onOpen?.({ ...ptr });
  }

  function closeRail() {
    if (!open) return;
    open = false;
    zone.classList.remove('open');
    for (let i = 0; i < items.length; i++) {
      if (!items[i].hover) continue;
      items[i].hover = false;
      onHover?.(i, false);
    }
    onClose?.();
  }

  zone.addEventListener('pointerenter', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; openRail(); });
  zone.addEventListener('pointermove', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; });
  zone.addEventListener('pointerleave', () => {
    clearTimeout(closeTimer);
    /* 220ms 宽限：从图标边上擦过去不至于闪一下 */
    closeTimer = setTimeout(closeRail, 220);
  });
  zone.addEventListener('pointerdown', (e) => {
    ptr.x = e.clientX; ptr.y = e.clientY;
    if (e.pointerType === 'touch') openRail();
  });

  return {
    el: zone,
    /* 共用一个数组：官方图标是异步换上的，快照一份会让 field 永远拿不到新点阵 */
    items,
    layout,
    close: closeRail,
    isOpen: () => open,
    setActive(id) {
      let idx = -1;
      items.forEach((it, i) => {
        const on = it.id === id;
        it.btn.classList.toggle('active', on);
        if (on) idx = i;
      });
      onActive?.(idx);
    },
  };
}
