/**
 * 应用列表（launchpad）—— 两种形态，同一批粒子图标：
 *
 *   ring —— 3D 圆环画廊：图标沿一个水平圆环排开，可左右拖动旋转，
 *           外侧有粒子流（field.js 的 halo）绕着它们转，像被一团星尘包裹；
 *   grid —— 2D 平铺：图标落到页面上的网格里，带名字，和官方启动台一个意思。
 *
 * 图标本身是 WebGL 粒子（field.js 的 launch 组，每个图标一个 Points，
 * 这样能按深度排序、前面的图标才会挡住后面的），
 * 这一层 DOM 只负责：透明的命中区 + 名字。
 *
 * 入场手势由 field 的「甩动」识别触发（见 main.js 的 onFlick）。
 */
import { officialDots, scanGlyph, tintDots, letterDots } from './icons.js';
import { glyphOf, paintGlyph, TINT } from './glyph.js';

export const LP_ICON = 132;   // 图标方框（CSS px）—— 比应用栏大，格数也跟着加密
const GRID = 44;              // 132 / 44 = 3px 一格，点距和 76px 的应用栏图标相当
const MAX = 11;               // 与 field.js 的 LP_MAX 一致

function glyphDots(app) {
  const g = glyphOf(app.name, app.title);
  return g
    ? tintDots(scanGlyph((x, s) => paintGlyph(x, g, s), LP_ICON, GRID), TINT[g], LP_ICON, GRID)
    : letterDots(app.title, LP_ICON, GRID);
}

/**
 * @param {{
 *   apps: Array<object>,
 *   onPick?: (app:object) => void,   // 由 field.onIcon 触发，见 main.js
 *   onHover?: (i:number, v:boolean) => void,
 *   onDots?: (items:Array) => void,
 * }} opt
 */
export function createLauncher({ apps, onPick, onHover, onDots }) {
  const root = document.createElement('div');
  root.className = 'launch';
  root.hidden = true;

  const items = apps.slice(0, MAX).map((app, i) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'lp-tile';
    tile.style.width = tile.style.height = `${LP_ICON}px`;
    tile.setAttribute('aria-label', app.title);

    const name = document.createElement('span');
    name.className = 'lp-name';
    name.textContent = app.title;

    tile.addEventListener('pointerenter', () => onHover?.(i, true));
    tile.addEventListener('pointerleave', () => onHover?.(i, false));
    /* 点击不挂在这里：拖动起手也必须落在图标上（要能直接拖着图标转圆环），
       所以"点击 vs 拖动"由 field 按位移 + 投影位置判定，见 field.js 的 up()。 */

    root.appendChild(tile);
    root.appendChild(name);
    return { app, tile, name, dots: glyphDots(app), box: LP_ICON, rev: 0 };
  });

  document.body.appendChild(root);

  /* 官方图标异步换上：先用字形顶上，图到了再让 field 重建那一个图标的点阵 */
  (async function upgrade() {
    for (const it of items) {
      if (!it.app.icon) continue;
      try {
        const dots = await officialDots(it.app.icon, LP_ICON, GRID);
        if (!dots || !dots.length) continue;
        it.dots = dots;
        it.rev = 1;
        onDots?.(items);
      } catch { /* 单个失败就继续用字形 */ }
    }
  })();

  let open = false;
  let mode = 1;

  return {
    items,
    iconSize: LP_ICON,
    el: root,

    pick(i) {
      const it = items[i];
      if (!it) return;
      /* 带上图标中心：开窗那条"流"从这个方向流进中心，和"图标散回团里"同一段时间 */
      const r = it.tile.getBoundingClientRect();
      onPick?.(it.app, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    },

    isOpen: () => open,

    setMode(m) {
      mode = m;
      root.dataset.mode = String(m);
    },

    open(m) {
      open = true;
      root.hidden = false;
      document.body.classList.add('launching');
      this.setMode(m);
    },

    close() {
      open = false;
      root.hidden = true;
      document.body.classList.remove('launching');
    },

    /**
     * 每帧把粒子图标的投影位置同步给 DOM。
     * @param {(i:number) => ({x:number,y:number,k:number,a:number,lab:number}|null)} get
     */
    sync(get) {
      if (!open) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const p = get(i);
        if (!p || p.a < 0.015) {
          it.tile.style.opacity = '0';
          it.name.style.opacity = '0';
          it.tile.style.pointerEvents = 'none';
          continue;
        }
        const k = p.k;
        const half = (it.box * k) / 2;
        /* 平铺模式每个图标外面有一圈粒子流（半径 ≈ 0.72 个图标宽），
           名字得让到那圈外面去，否则会压在流上 */
        const nameDy = mode === 2 ? half * 1.55 + 10 : half + 8;
        it.tile.style.transform =
          `translate3d(${(p.x - it.box / 2).toFixed(2)}px, ${(p.y - it.box / 2).toFixed(2)}px, 0) scale(${k.toFixed(3)})`;
        it.tile.style.opacity = String(Math.min(1, p.a));
        it.tile.style.pointerEvents = p.a > 0.5 ? 'auto' : 'none';
        it.name.style.transform =
          `translate3d(${p.x.toFixed(2)}px, ${(p.y + nameDy).toFixed(2)}px, 0) translate(-50%, 0)`;
        it.name.style.opacity = String(Math.max(0, Math.min(1, p.lab)));
      }
    },
  };
}
