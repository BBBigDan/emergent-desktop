/**
 * dock 图标的粒子化渲染。
 *
 * 数据流：glyph.js 在 100×100 上画白色墨迹 → 这里按 CELL 格统计覆盖率 →
 * 每个够覆盖的格子放一颗点（颜色取官方主色的竖向渐变）。
 * 和登录页同一套逻辑（paint → scan → 点阵），只是这里渲染在 2D canvas 上：
 * dock 是 z-index 6 的不透明面板，粒子场（z-index 3）穿不过来。
 *
 * 动画：每颗点有自己的相位，做 ±0.5px 的微环 + 呼吸；
 * 悬停时点会整体抬升、变亮，外面再浮一层环绕的光尘（和登录页的悬停增援同源）。
 */
import { glyphOf, paintGlyph, TINT } from './glyph.js';

const CELL = 1.85;       // 每格多少 CSS px（52px 图标 → 28 格，字形才认得清）
const COV = 0.34;        // 覆盖率阈值：低于它就当空白
const registered = new Set();
let raf = 0;
let prev = 0;
let parity = 0;

const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * 把一个按钮变成粒子图标。
 * @param {HTMLElement} host  放 canvas 的容器（.dock-icon）
 * @param {{name?:string,title?:string,size?:number,glyph?:string}} opt
 * @returns {{el:HTMLCanvasElement, burst():void, setHover(v:boolean):void}}
 */
export function createDockIcon(host, { name, title, size = 52, glyph } = {}) {
  const gname = glyph || glyphOf(name, title) || null;
  const cv = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  cv.style.width = size + 'px';
  cv.style.height = size + 'px';
  host.appendChild(cv);
  const ctx = cv.getContext('2d');

  /* 没有匹配到字形的应用：退化成「首字母」点阵，至少不是空白 */
  const dots = [];
  let cellDev = CELL * dpr;
  const push = (x, y, cov) => dots.push({ x, y, cov, ph: Math.random() * 6.283, sp: 0.7 + Math.random() * 0.9 });
  if (gname) cellDev = sampleGlyph(gname, size * dpr, push);
  else cellDev = sampleText((title || '?').slice(0, 1), size * dpr, push);

  const [cTop, cBot] = TINT[gname] ? TINT[gname].map(hex) : [[150, 220, 255], [70, 140, 210]];
  for (const d of dots) {
    const k = d.y / (size * dpr);            // 0 = 顶, 1 = 底
    d.c = [
      Math.round(cTop[0] + (cBot[0] - cTop[0]) * k),
      Math.round(cTop[1] + (cBot[1] - cTop[1]) * k),
      Math.round(cTop[2] + (cBot[2] - cTop[2]) * k),
    ];
  }

  const icon = {
    el: cv,
    ctx,
    dots,
    size,
    dpr,
    cellDev,
    hover: 0,
    target: 0,
    burstT: 0,
    get name() { return gname; },
    setHover(v) { icon.target = v ? 1 : 0; },
    burst() { icon.burstT = 1; },
  };
  registered.add(icon);
  start();
  return icon;
}

/* ─────────────────────────── 采样 ─────────────────────────── */

function scan(srcCanvas, cb) {
  const c = srcCanvas.getContext('2d', { willReadFrequently: true });
  const W = srcCanvas.width, H = srcCanvas.height;
  const d = c.getImageData(0, 0, W, H).data;
  const cell = Math.max(2, CELL * (W / 52));   // 跟尺寸一起缩放，保持 ~22 格

  for (let cy = 0; cy * cell < H; cy++) {
    for (let cx = 0; cx * cell < W; cx++) {
      const x0 = Math.round(cx * cell), x1 = Math.min(W, Math.round((cx + 1) * cell));
      const y0 = Math.round(cy * cell), y1 = Math.min(H, Math.round((cy + 1) * cell));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) { sum += d[(y * W + x) * 4 + 3]; n++; }
      }
      const cov = n ? sum / n / 255 : 0;
      if (cov >= COV) cb((cx + 0.5) * cell, (cy + 0.5) * cell, Math.min(1, cov));
    }
  }
  return cell;
}

function offscreen(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.strokeStyle = '#fff';
  x.lineCap = 'round';
  x.lineJoin = 'round';
  return { c, x };
}

function sampleGlyph(name, size, cb) {
  const { c, x } = offscreen(size);
  paintGlyph(x, name, size);
  return scan(c, cb);
}

function sampleText(ch, size, cb) {
  const { c, x } = offscreen(size);
  x.font = `700 ${Math.round(size * 0.72)}px ui-sans-serif, system-ui, sans-serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(ch, size / 2, size * 0.54);
  return scan(c, cb);
}

/* ─────────────────────────── 绘制 ─────────────────────────── */

function draw(icon, t) {
  const { ctx, size, dpr, dots } = icon;
  const S = size * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';

  /* 悬停缓动（抬升 / 变亮）；点击给一次径向冲击 */
  icon.hover += (icon.target - icon.hover) * 0.16;
  const h = icon.hover;
  const bt = icon.burstT;
  if (bt > 0) icon.burstT = Math.max(0, bt - 1 / 30);

  const cx = S / 2, cy = S / 2;
  const cell = icon.cellDev;

  for (const d of dots) {
    /* 微环：每颗点绕自己的格心画一个独立相位的小圈 */
    const ox = Math.cos(t * d.sp + d.ph) * 0.42 * dpr;
    const oy = Math.sin(t * d.sp * 1.13 + d.ph) * 0.42 * dpr;

    /* 悬停：整组向外撑开一点（1.06），并叠一点径向位移 */
    let px = cx + (d.x - cx) * (1 + 0.06 * h) + ox;
    let py = cy + (d.y - cy) * (1 + 0.06 * h) + oy;

    /* 点击冲击：沿径向弹开，随 bt 衰减 */
    if (bt > 0) {
      let vx = d.x - cx, vy = d.y - cy;
      const L = Math.hypot(vx, vy) || 1;
      const k = bt * bt * 9 * dpr;
      px += (vx / L) * k;
      py += (vy / L) * k;
    }

    const breathe = 0.88 + 0.12 * Math.sin(t * 2.1 + d.ph * 1.7);
    const rad = cell * 0.46 * (0.62 + 0.38 * d.cov) * breathe * (1 + 0.16 * h);
    const a = Math.min(1, (0.34 + 0.66 * d.cov) * (0.85 + 0.15 * breathe) * (1 + 0.45 * h));
    ctx.fillStyle = `rgba(${d.c[0]},${d.c[1]},${d.c[2]},${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, 6.2832);
    ctx.fill();
  }

  /* 悬停光尘：绕着字形浮的一圈亮点，指针离开就散掉 */
  if (h > 0.02) {
    const R = S * 0.52;
    for (let i = 0; i < 14; i++) {
      const a0 = (i / 14) * 6.2832 + t * (0.5 + (i % 3) * 0.18);
      const rr = R * (0.94 + 0.10 * Math.sin(t * 1.4 + i));
      const px = cx + Math.cos(a0) * rr;
      const py = cy + Math.sin(a0) * rr * 0.92;
      const a = h * (0.30 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.4 + i * 1.7)));
      ctx.fillStyle = `rgba(190,240,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, 0.9 * dpr, 0, 6.2832);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

function start() {
  if (raf) return;
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    /* 图标很小，30fps 足够，省一半 CPU */
    if ((parity ^= 1) === 0) return;
    const t = now / 1000;
    prev = now;
    for (const ic of registered) draw(ic, t);
  };
  raf = requestAnimationFrame(tick);
}
