/**
 * 粒子绘画编译器 —— 把一份绘画 spec 变成「屏幕坐标的点云」。
 *
 * 为什么是「画布 + 采样」而不是让模型直接给点：
 *   点必须沿笔画中线均匀铺开，否则要么断成虚线、要么在拐角堆成一坨。
 *   而"沿中线均匀"这件事浏览器已经做对了（Canvas2D 的描边、fillText、弧线），
 *   所以先栅格化成墨迹，再按格子取**墨迹质心**——
 *   这是唯一能同时支持 path / text / chart / face 四种表达、
 *   又不用给每种各写一套采样器的办法。
 *
 * 三条硬约束（来自之前调点阵踩的坑）：
 *   1. 点距要和「可见芯径」匹配，落点 1.0~1.5 之间：>1.5 显断，<0.8 叠加过曝显糊
 *   2. 取质心而不是取首个像素 —— 质心落在笔画中线上，边缘才干净
 *   3. 采样只做一次、结果存成静态缓冲，不要每帧重算（每帧抖动 = 噪点）
 */

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/* 表情库：只参数化三样东西 —— 眼型、眉斜率、嘴曲率。
 * 让模型说 "happy" 比自己写两条贝塞尔曲线可靠得多，也便宜得多。 */
const MOODS = {
  happy:     { eye: 'arc',    brow: 0.10, mouth:  0.85, open: 0 },
  smiling:   { eye: 'arc',    brow: 0.05, mouth:  0.45, open: 0 },
  neutral:   { eye: 'dot',    brow: 0.00, mouth:  0.05, open: 0 },
  sad:       { eye: 'dot',    brow: -0.30, mouth: -0.55, open: 0 },
  angry:     { eye: 'slash',  brow: 0.75, mouth: -0.45, open: 0 },
  surprised: { eye: 'circle', brow: 0.35, mouth:  0.15, open: 1 },
  sleepy:    { eye: 'line',   brow: -0.10, mouth:  0.00, open: 0 },
};

function hexToRgb(hex) {
  const s = String(hex || '#9FE1CB').replace('#', '');
  const v = s.length === 3
    ? s.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  return [(v[0] || 0) / 255, (v[1] || 0) / 255, (v[2] || 0) / 255];
}

/* ------------------------------- 图元 ------------------------------- */

function pathArrow(g, a, b, head) {
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.stroke();
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const h = head || 16;
  g.beginPath();
  g.moveTo(b[0], b[1]);
  g.lineTo(b[0] - Math.cos(ang - 0.42) * h, b[1] - Math.sin(ang - 0.42) * h);
  g.moveTo(b[0], b[1]);
  g.lineTo(b[0] - Math.cos(ang + 0.42) * h, b[1] - Math.sin(ang + 0.42) * h);
  g.stroke();
}

/* 图表：坐标轴和刻度由我们算，模型只给数据。
 * 绝不让模型算像素坐标 —— 它算不准，而且一改数据就得全部重算。 */
function paintChart(g, L) {
  const [w, h] = L.size || [320, 180];
  const [x0, y0] = L.at || [0, 0];
  const data = (L.data || []).map(Number);
  if (!data.length) return;
  const kind = L.kind || 'bars';
  const padL = L.padL ?? Math.max(18, w * 0.10);
  const padB = L.padB ?? Math.max(14, h * 0.16);
  const padT = L.padT ?? Math.max(8, h * 0.06);
  const padR = L.padR ?? 8;
  const x = x0 + padL;
  const y = y0 + padT;
  const gw = w - padL - padR;
  const gh = h - padB - padT;
  const max = Math.max(...data, 1e-6);
  const lw = L.width || 3;

  g.lineWidth = lw;
  /* 轴：只在模型要的时候画（默认画，图表没有轴不好读） */
  if (L.axis !== false) {
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + gh);
    g.lineTo(x + gw, y + gh);
    g.stroke();
  }

  if (kind === 'bars') {
    const bw = (gw / data.length) * 0.58;
    data.forEach((v, i) => {
      const cx = x + (gw / data.length) * (i + 0.5);
      const bh = (v / max) * gh * 0.94;
      g.beginPath();
      g.rect(cx - bw / 2, y + gh - bh, bw, bh);
      g.fill();
    });
  } else if (kind === 'line') {
    const pt = data.map((v, i) => [
      x + (gw * i) / Math.max(1, data.length - 1),
      y + gh - (v / max) * gh * 0.94,
    ]);
    g.beginPath();
    pt.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
    g.stroke();
    for (const [px, py] of pt) {
      g.beginPath();
      g.arc(px, py, Math.max(3, lw * 1.4), 0, Math.PI * 2);
      g.fill();
    }
  } else if (kind === 'pie') {
    const cx = x + gw / 2;
    const cy = y + gh / 2;
    const r = Math.min(gw, gh) * 0.42;
    const sum = data.reduce((a, b) => a + b, 0) || 1;
    let a0 = -Math.PI / 2;
    for (const v of data) {
      const a1 = a0 + (v / sum) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, r, a0, a1);
      g.closePath();
      g.stroke();
      a0 = a1;
    }
  }
}

/* 表情：瞳孔/眉毛/嘴全由 mood 参数推出来 */
function paintFace(g, L) {
  const [cx, cy] = L.at || [0, 0];
  const R = (L.size || 160) / 2;
  const m = MOODS[L.mood] || MOODS.neutral;
  const lw = L.width || Math.max(2, R * 0.045);
  g.lineWidth = lw;

  /* 脸 */
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.stroke();

  const ex = R * 0.40;
  const ey = -R * 0.18;
  const er = R * 0.13;

  for (const s of [-1, 1]) {
    const x = cx + s * ex;
    const y = cy + ey;
    g.beginPath();
    if (m.eye === 'dot') {
      g.arc(x, y, er * 0.72, 0, Math.PI * 2);
      g.fill();
    } else if (m.eye === 'circle') {
      g.arc(x, y, er * 1.05, 0, Math.PI * 2);
      g.stroke();
    } else if (m.eye === 'arc') {
      /* 笑眼：上凸的弧 */
      g.arc(x, y + er * 0.5, er * 1.15, Math.PI * 1.15, Math.PI * 1.85);
      g.stroke();
    } else if (m.eye === 'line') {
      g.moveTo(x - er, y);
      g.lineTo(x + er, y);
      g.stroke();
    } else if (m.eye === 'slash') {
      g.moveTo(x - er, y - er * 0.5);
      g.lineTo(x + er, y + er * 0.5);
      g.stroke();
    }
  }

  /* 眉毛：斜率由 mood 决定，愤怒时向内压、悲伤时向外垂。
     位置贴着上眼睑（-0.22R），再高就变成两条浮在额头上的横线。 */
  if (m.brow !== 0) {
    const by = cy + ey - R * 0.22;
    for (const s of [-1, 1]) {
      const x = cx + s * ex;
      const dy = m.brow * R * 0.07;
      g.beginPath();
      g.moveTo(x - er * 1.15, by + dy * s);
      g.lineTo(x + er * 1.15, by - dy * s);
      g.stroke();
    }
  }

  /* 嘴：二次曲线的控制点高度 = 情绪。open 时画成椭圆（惊讶） */
  const my = cy + R * 0.34;
  if (m.open) {
    const rx = R * 0.17;
    const ry = R * 0.24;
    g.beginPath();
    g.ellipse(cx, my + ry * 0.5, rx, ry, 0, 0, Math.PI * 2);
    g.stroke();
  } else {
    const cy2 = my + m.mouth * R * 0.30;
    const half = R * 0.36;
    g.beginPath();
    g.moveTo(cx - half, my);
    g.quadraticCurveTo(cx, cy2, cx + half, my);
    g.stroke();
  }
}

/* ------------------------------ 分层绘制 ------------------------------ */

function paintLayer(g, L, W, H) {
  const w = L.width ?? 5;
  g.lineWidth = w;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';

  switch (L.type) {
    case 'path': {
      const p = new Path2D(L.d);
      if (L.fill) g.fill(p); else g.stroke(p);
      break;
    }
    case 'circle': {
      g.beginPath();
      g.arc(L.c[0], L.c[1], L.r, 0, Math.PI * 2);
      if (L.fill) g.fill(); else g.stroke();
      break;
    }
    case 'rect': {
      const [x, y, rw, rh] = L.r || [L.at[0], L.at[1], L.size[0], L.size[1]];
      if (L.fill) g.fillRect(x, y, rw, rh);
      else g.strokeRect(x, y, rw, rh);
      break;
    }
    case 'polyline':
    case 'line': {
      const pts = L.type === 'line' ? [L.from, L.to] : L.points;
      g.beginPath();
      pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.stroke();
      break;
    }
    case 'arrow': {
      pathArrow(g, L.from, L.to, L.head);
      break;
    }
    case 'text': {
      const size = L.size || 96;
      g.font = `${L.weight || 600} ${size}px ${L.font || FONT}`;
      g.textAlign = L.align || 'center';
      g.textBaseline = L.baseline || 'middle';
      if (L.width && L.stroke) {
        g.strokeText(L.text, L.at[0], L.at[1]);
      } else {
        g.fillText(L.text, L.at[0], L.at[1]);
      }
      break;
    }
    case 'chart':
      paintChart(g, L);
      break;
    case 'face':
      paintFace(g, L);
      break;
    default:
      break;
  }
}

/* ------------------------------- 采样 ------------------------------- */

/**
 * 抖动网格采样：格子边长 = 目标点距，每格取墨迹的**加权质心**。
 * 质心而不是随机像素 —— 随机会在笔画边缘留下锯齿，而且每次跑结果都不一样。
 */
function sampleInk(data, W, H, cell) {
  const pts = [];
  const n = Math.max(1, Math.round(cell));
  for (let gy = 0; gy < H; gy += n) {
    const y1 = Math.min(H, gy + n);
    for (let gx = 0; gx < W; gx += n) {
      const x1 = Math.min(W, gx + n);
      let sw = 0;
      let sx = 0;
      let sy = 0;
      for (let y = gy; y < y1; y++) {
        const row = y * W;
        for (let x = gx; x < x1; x++) {
          const a = data[(row + x) * 4 + 3];
          if (a > 24) {
            const w = a / 255;
            sw += w; sx += x * w; sy += y * w;
          }
        }
      }
      /* 阈值 0.25：一格只蹭到一两个半透明像素时不生成点，避免边缘毛刺 */
      if (sw > 0.25) pts.push({ x: sx / sw, y: sy / sw, ink: Math.min(1, sw / (n * n * 0.55)) });
    }
  }
  return pts;
}

function countInk(data) {
  let c = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 24) c++;
  return c;
}

/* ------------------------------- 入口 ------------------------------- */

/**
 * @param {object} spec  { points?, layers: Layer[], motion?: {...} }
 * @param {object} area  { w, h, max? }  绘制区（CSS px）
 * @returns {{w,h,points,spacing,layers,over}}
 */
export function compileDraw(spec, area) {
  const W = Math.max(64, Math.round(area.w));
  const H = Math.max(64, Math.round(area.h));
  const budget = Math.min(spec.points || 4200, area.max || 6400);
  const layers = (spec.layers || []).filter(Boolean);

  if (!layers.length) return { w: W, h: H, points: [], spacing: 0, layers: 0, over: 0 };

  /* 1) 逐层栅格化，留一份 ImageData（每层单独一张画布：颜色按层算，重叠也不串） */
  const rasters = layers.map((L) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.lineCap = 'round';
    g.lineJoin = 'round';
    paintLayer(g, L, W, H);
    const img = g.getImageData(0, 0, W, H);
    return { L, data: img.data, ink: countInk(img.data) };
  });

  const totalInk = rasters.reduce((a, r) => a + r.ink, 0);
  if (!totalInk) return { w: W, h: H, points: [], spacing: 0, layers: layers.length, over: 0 };

  /* 2) 由"墨迹面积 / 预算"反推点距：每个点覆盖 cell² 的墨迹面积，
   *    所以 cell = sqrt(area / budget)。这个式子自洽地落在"一笔宽一个点"附近。 */
  let cell = Math.sqrt(totalInk / budget);
  cell = Math.min(18, Math.max(3.2, cell));

  /* 3) 采样：点距双向调整到"用满预算"
   *    只放大不缩小的话，简单图形（一张脸只用一千多点）会一直很稀 ——
   *    明明还有三千颗粒子闲着，笔画却是一串珠子。
   *    规则：超预算就放大格子；没到 85% 就收密。最多四趟，留最后一个合法解。 */
  let out = [];
  let best = null;
  let over = 0;
  for (let pass = 0; pass < 4; pass++) {
    out = [];
    for (const r of rasters) {
      const pts = sampleInk(r.data, W, H, cell);
      const col = hexToRgb(r.L.color);
      for (const p of pts) out.push({ ...p, c: col, layer: r.L });
    }
    if (out.length <= budget) {
      best = { pts: out, cell };
      if (out.length >= budget * 0.85) break;
    } else {
      over = out.length;
      if (best) break;                       // 已经有合法解了，别再动
    }
    const ratio = Math.max(0.02, out.length / budget);
    cell = Math.min(20, Math.max(2.2, cell * Math.sqrt(ratio) * (out.length > budget ? 1.04 : 0.94)));
  }
  if (best) { out = best.pts; cell = best.cell; }
  if (out.length > budget) {
    /* 兜底：按步长均匀取样，宁可少画也不要让点挤成一片糊掉 */
    over = out.length;
    const stride = out.length / budget;
    const cut = [];
    for (let k = 0; k < budget; k++) cut.push(out[Math.floor(k * stride)]);
    out = cut;
  }

  /* 4) 排序成"按层、按纵坐标"—— drawOn 时像一支笔从上往下写 */
  out.sort((a, b) => (a.layer === b.layer ? a.y - b.y : rasters.indexOf(a.layer) - rasters.indexOf(b.layer)));

  return { w: W, h: H, points: out, spacing: cell, layers: layers.length, over };
}

/** 场景示例：给测试页和文档用 */
export const SCENES = {
  face: {
    points: 3200,
    layers: [{ type: 'face', mood: 'happy', at: [360, 210], size: 300, color: '#9FE1CB' }],
  },
  chart: {
    points: 3600,
    layers: [
      { type: 'chart', kind: 'bars', data: [3, 8, 5, 12, 7, 9], at: [60, 40], size: [420, 260], color: '#FAC775', width: 4 },
      { type: 'text', text: '本周', at: [270, 320], size: 34, color: '#8A8880', weight: 500 },
    ],
  },
  text: {
    points: 3000,
    layers: [{ type: 'text', text: '你好', at: [300, 190], size: 190, color: '#9FE1CB', weight: 700 }],
  },
  /* 矢量层：自由涂鸦——路径、圆弧、折线、箭头，
     模型只有在"画示意图/手绘"时才用这一层（语义层能表达的就别写路径） */
  doodle: {
    points: 4200,
    layers: [
      { type: 'path', d: 'M110,320 C125,190 215,110 305,140 C395,170 405,260 355,320', width: 6, color: '#9FE1CB' },
      { type: 'circle', c: [520, 180], r: 68, color: '#FAC775' },
      { type: 'polyline', points: [[110, 372], [210, 340], [310, 380], [410, 350]], color: '#EDEBE4' },
      { type: 'arrow', from: [430, 300], to: [545, 262], color: '#8BB7E8' },
    ],
  },
  all: {
    points: 6200,
    layers: [
      { type: 'face', mood: 'surprised', at: [150, 120], size: 120, color: '#9FE1CB' },
      { type: 'chart', kind: 'line', data: [2, 6, 4, 9, 6, 11], at: [330, 60], size: [330, 210], color: '#FAC775', width: 3 },
      { type: 'text', text: '今晚吃啥', at: [280, 340], size: 72, color: '#EDEBE4' },
      { type: 'arrow', from: [420, 300], to: [520, 250], color: '#8BB7E8' },
    ],
  },
};
