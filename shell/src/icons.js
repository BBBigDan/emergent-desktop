/**
 * 官方图标 → 点阵。
 *
 * 左边缘应用栏（rail，方框 76px / 32 格）和应用列表（launcher，方框 132px / 44 格）
 * 共用这一份采样，只是**格数跟着图标大小走** —— 图标越大格子要越密，
 * 否则同样的 32 格放到 132px 上，点会粗得像马赛克。
 *
 * 采样结果缓存两层：图片（避免重复请求）和点阵（同一 url + 尺寸只算一次）。
 */

export const DEFAULT_TINT = ['#a9dcff', '#2f7fc8'];

export const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const imgCache = new Map();
const dotCache = new Map();

function loadImg(url) {
  let p = imgCache.get(url);
  if (p) return p;
  p = new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';   // CDN 带 ACAO: *，可以读像素
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('icon load failed'));
    im.src = url;
  });
  /* 失败的不要留在缓存里，否则以后永远拿不到 */
  p.catch(() => imgCache.delete(url));
  imgCache.set(url, p);
  return p;
}

/**
 * 官方图标降采样成点阵。
 * 缩到 grid×grid 再读像素 = 每格一个"平均色"，这是最忠实的降采样。
 *
 * @param {string} url
 * @param {number} size 方框边长（CSS px），点的坐标/直径都以它为基准
 * @param {number} grid 采样格数
 * @returns {Promise<Array<{dx:number,dy:number,c:number[],s:number,a:number}>>}
 */
export function officialDots(url, size, grid) {
  const key = `${url}|${size}|${grid}`;
  let p = dotCache.get(key);
  if (p) return p;
  p = (async () => {
    const im = await loadImg(url);

    const c = document.createElement('canvas');
    c.width = c.height = grid;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(im, 0, 0, grid, grid);
    const d = x.getImageData(0, 0, grid, grid).data;

    const cell = size / grid;
    const R = grid * 0.26;        // 圆角半径（官方桌面上的图标是圆角）
    const dots = [];

    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const o = (gy * grid + gx) * 4;
        /* 圆角遮罩：四角留空，否则一列方形色块像贴纸 */
        const qx = Math.min(gx + 0.5, grid - gx - 0.5);
        const qy = Math.min(gy + 0.5, grid - gy - 0.5);
        if (qx < R && qy < R && Math.hypot(qx - R, qy - R) > R) continue;
        if (d[o + 3] < 40) continue;

        /* 加色混合里点只有中心是"满色"，直接搬原色会整体发灰：
           做一次 gamma 提亮（^0.86），保住色相、把暗部抬起来 */
        const col = [0, 1, 2].map((k) => Math.min(255, Math.round(255 * Math.pow(d[o + k] / 255, 0.86))));

        dots.push({
          dx: (gx + 0.5) * cell - size / 2,
          dy: (gy + 0.5) * cell - size / 2,   // canvas 坐标，y 向下（field 那边翻）
          c: col,
          s: cell * 1.06,                     // 略大于格距：点相互咬合成块，远看就是那个图标
          a: 1,
        });
      }
    }
    return dots;
  })();
  p.catch(() => dotCache.delete(key));
  dotCache.set(key, p);
  return p;
}

/* --------------------------- 字形兜底 → 点阵 --------------------------- */

/**
 * 拿不到官方图标时（离线 / 跨域失败）用字形顶上。
 * @param {(x:CanvasRenderingContext2D, size:number) => void} draw
 */
export function scanGlyph(draw, size, grid) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d', { willReadFrequently: true });
  draw(x, size);
  const d = x.getImageData(0, 0, size, size).data;
  const CELL = size / grid;
  const out = [];

  for (let cy = 0; cy < grid; cy++) {
    for (let cx = 0; cx < grid; cx++) {
      const x0 = Math.round(cx * CELL), x1 = Math.min(size, Math.round((cx + 1) * CELL));
      const y0 = Math.round(cy * CELL), y1 = Math.min(size, Math.round((cy + 1) * CELL));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let xx = x0; xx < x1; xx++) { sum += d[(y * size + xx) * 4 + 3]; n++; }
      }
      const cov = n ? sum / n / 255 : 0;
      if (cov < 0.34) continue;
      out.push({
        dx: (cx + 0.5) * CELL - size / 2 + (Math.random() - 0.5) * CELL * 0.3,
        dy: (cy + 0.5) * CELL - size / 2 + (Math.random() - 0.5) * CELL * 0.3,
        cov,
      });
    }
  }
  return out;
}

/** 字形点阵补上颜色 / 点径 / 亮度（和官方点阵同一种结构） */
export function tintDots(dots, tint, size, grid) {
  const [ct, cb] = (tint || DEFAULT_TINT).map(hex);
  const cell = size / grid;
  for (const d of dots) {
    const k = Math.max(0, Math.min(1, (d.dy + size / 2) / size));
    d.c = [
      Math.round(ct[0] + (cb[0] - ct[0]) * k),
      Math.round(ct[1] + (cb[1] - ct[1]) * k),
      Math.round(ct[2] + (cb[2] - ct[2]) * k),
    ];
    d.s = cell * (0.86 + 0.24 * d.cov);
    d.a = 0.68 + 0.52 * d.cov;
  }
  return dots;
}

/** 首字兜底（连字形都没有的自定义应用） */
export function letterDots(title, size, grid) {
  return tintDots(scanGlyph((x, s) => {
    x.fillStyle = '#fff';
    x.font = `600 ${Math.round(s * 0.66)}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(String(title || '?').slice(0, 1), s / 2, s * 0.54);
  }, size, grid), DEFAULT_TINT, size, grid);
}
