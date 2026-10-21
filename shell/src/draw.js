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

/* 字体：走原型调过的那一套 —— **细体**，不是系统默认。
 *
 * 这件事对点阵影响非常大：600 字重的汉字在 2~3px 点距下每一笔都是 2~3 颗点，
 * 糊成一块墨；换成 Light（DengXian Light / PingFang 300）笔画只剩一条中线，
 * 正好一颗点，字才立得起来。
 *
 * Mac 上没有等线，靠 "PingFang SC" + font-weight:300 落到 Light 字面。
 * 纯拉丁/数字（71%、10-17）用 Bahnschrift Light：更窄，粒子下更像仪表盘。 */
export const FONT = '"DengXian Light","Microsoft YaHei Light","PingFang SC","Microsoft YaHei",ui-sans-serif,sans-serif';
export const FONT_LAT = '"Bahnschrift Light",Bahnschrift,Candara,"PingFang SC","Segoe UI",sans-serif';
const WEIGHT = 300;

/* ── 具象图形：模板库 ──
 *
 * 起因是一次真实的失败：用户说"画一只小狗"，7B 给的 d 是
 *   "M .25 .35 C .25 .25 .35 .25 .5 .35 C .65 .25 .65 .35 .65 .5 ..."
 * 它上屏了（2703 个点），但那是随手拐弯的曲线，谁也认不出是狗。
 *
 * 结论和当初 gauge 半径那件事一样：**具象形状的几何不该由模型负责**。
 * 模型能可靠做的只有"选一个名字"（就像 face 只让它选 mood），
 * 所以这里给一批画得准的模板。
 *
 * 坐标一律 0~1，画在以 at 为中心、边长 size 的方框里。
 * 记号：c 圆 / e 椭圆 / p 折线(close 收口) / l 线段 / dot 实心点 / arc 弧 / path 路径
 */
const star = (() => {
  const p = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 0.19 : 0.44;
    p.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r]);
  }
  return p;
})();

const sunRays = (() => {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    out.push({ l: [[0.5 + Math.cos(a) * 0.27, 0.5 + Math.sin(a) * 0.27],
      [0.5 + Math.cos(a) * 0.41, 0.5 + Math.sin(a) * 0.41]] });
  }
  return out;
})();

export const STENCILS = {
  dog: [
    { e: [0.50, 0.635, 0.168, 0.100] },                                  // 身子
    { c: [0.50, 0.372, 0.100] },                                         // 头
    /* 耳朵是**垂的椭圆**，不是尖三角：尖三角一上去就变猫，而狗的第一识别特征
       恰恰是那两片挂着的耳朵。 */
    { e: [0.398, 0.382, 0.038, 0.058] },
    { e: [0.602, 0.382, 0.038, 0.058] },
    { dot: [0.470, 0.352, 0.011] },
    { dot: [0.530, 0.352, 0.011] },
    { e: [0.500, 0.424, 0.055, 0.030] },                                 // 口鼻
    { dot: [0.500, 0.410, 0.010] },                                      // 鼻头
    { l: [[0.404, 0.715], [0.404, 0.845]] },
    { l: [[0.464, 0.725], [0.464, 0.845]] },
    { l: [[0.536, 0.725], [0.536, 0.845]] },
    { l: [[0.596, 0.715], [0.596, 0.845]] },
    { path: 'M .662 .600 C .716 .596 .742 .556 .748 .494' },             // 尾巴：贴身往上翘
  ],
  cat: [
    { e: [0.50, 0.640, 0.150, 0.098] },                                  // 身子
    { c: [0.50, 0.372, 0.098] },
    { p: [[0.424, 0.306], [0.400, 0.188], [0.478, 0.264]], close: true }, // 尖耳（猫）
    { p: [[0.576, 0.306], [0.600, 0.188], [0.522, 0.264]], close: true },
    { dot: [0.470, 0.350, 0.010] },
    { dot: [0.530, 0.350, 0.010] },
    { l: [[0.468, 0.412], [0.418, 0.398]] },                             // 胡须
    { l: [[0.468, 0.428], [0.414, 0.436]] },
    { l: [[0.532, 0.412], [0.582, 0.398]] },
    { l: [[0.532, 0.428], [0.586, 0.436]] },
    { l: [[0.452, 0.722], [0.452, 0.828]] },
    { l: [[0.548, 0.722], [0.548, 0.828]] },
    { path: 'M .648 .628 C .712 .618 .742 .566 .744 .486' },             // 尾巴
  ],
  house: [
    { p: [[0.302, 0.862], [0.302, 0.462], [0.698, 0.462], [0.698, 0.862]], close: true },
    { p: [[0.242, 0.480], [0.500, 0.238], [0.758, 0.480]], close: true },
    { p: [[0.438, 0.862], [0.438, 0.686], [0.562, 0.686], [0.562, 0.862]] },
    { p: [[0.586, 0.556], [0.664, 0.556], [0.664, 0.634], [0.586, 0.634]], close: true },
  ],
  tree: [
    { p: [[0.462, 0.862], [0.462, 0.610], [0.538, 0.610], [0.538, 0.862]], close: true },
    { c: [0.500, 0.412, 0.212] },
  ],
  star: [{ p: star, close: true }],
  heart: [{ path: 'M .50 .828 C .175 .612 .175 .340 .340 .302 C .440 .280 .500 .362 .500 .420 '
    + 'C .500 .362 .560 .280 .660 .302 C .825 .340 .825 .612 .50 .828 Z' }],
  check: [{ p: [[0.258, 0.520], [0.436, 0.702], [0.744, 0.336]] }],
  cross: [{ l: [[0.302, 0.302], [0.698, 0.698]] }, { l: [[0.698, 0.302], [0.302, 0.698]] }],
  arrow: [
    { l: [[0.500, 0.842], [0.500, 0.238]] },
    { p: [[0.352, 0.386], [0.500, 0.218], [0.648, 0.386]] },
  ],
  sun: [{ c: [0.5, 0.5, 0.196] }, ...sunRays],
  cloud: [
    { c: [0.398, 0.530, 0.108] },
    { c: [0.532, 0.462, 0.136] },
    { c: [0.662, 0.540, 0.098] },
    { l: [[0.292, 0.640], [0.762, 0.640]] },
  ],
  person: [
    { c: [0.500, 0.250, 0.088] },
    { l: [[0.500, 0.338], [0.500, 0.628]] },
    /* 手臂稍微下垂、两腿再分开些 —— 一条水平横线 + 一个窄 V 会像个风向标 */
    { l: [[0.500, 0.414], [0.336, 0.502]] },
    { l: [[0.500, 0.414], [0.664, 0.502]] },
    { l: [[0.500, 0.628], [0.376, 0.868]] },
    { l: [[0.500, 0.628], [0.624, 0.868]] },
  ],
};

export const STENCIL_NAMES = Object.keys(STENCILS);

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

/**
 * 模板图形：把 0~1 的记号铺到以 at 为中心、边长 size 的方框里。
 * 先 translate + scale，再按 box 反算线宽 —— 这样模板本身不用关心画布多大。
 */
function paintStencil(g, L, W, H) {
  const box = Math.max(48, L.size || Math.min(W, H) * 0.62);
  const [cx, cy] = L.at || [W / 2, H / 2];
  const parts = STENCILS[L.name] || STENCILS.dog;
  g.save();
  g.translate(cx - box / 2, cy - box / 2);
  g.scale(box, box);
  g.lineWidth = (L.width ?? 5) / box;

  for (const s of parts) {
    if (s.c) {
      g.beginPath(); g.arc(s.c[0], s.c[1], s.c[2], 0, Math.PI * 2); g.stroke();
    } else if (s.e) {
      g.beginPath(); g.ellipse(s.e[0], s.e[1], s.e[2], s.e[3], 0, 0, Math.PI * 2); g.stroke();
    } else if (s.dot) {
      g.beginPath(); g.arc(s.dot[0], s.dot[1], s.dot[2], 0, Math.PI * 2); g.fill();
    } else if (s.l) {
      g.beginPath(); g.moveTo(s.l[0][0], s.l[0][1]); g.lineTo(s.l[1][0], s.l[1][1]); g.stroke();
    } else if (s.arc) {
      g.beginPath(); g.arc(s.arc[0], s.arc[1], s.arc[2], s.arc[3], s.arc[4]); g.stroke();
    } else if (s.p) {
      g.beginPath();
      s.p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      if (s.close) g.closePath();
      if (s.fill || L.fill) g.fill(); else g.stroke();
    } else if (s.path) {
      const p = new Path2D(s.path);
      if (L.fill) g.fill(p); else g.stroke(p);
    }
  }
  g.restore();
}

function paintLayer(g, L, W, H) {
  const w = L.width ?? 5;
  g.lineWidth = w;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';

  switch (L.type) {
    case 'path': {
      const p = new Path2D(L.d);
      /* 0~1 坐标的 path：等比缩到短边、居中。等比而不是拉满，
         否则圆会被画布的长宽比拉成椭圆 —— 模型给的形状该是什么就是什么。 */
      if (L.norm) {
        const S = Math.min(W, H);
        g.save();
        g.translate((W - S) / 2, (H - S) / 2);
        g.scale(S, S);
        g.lineWidth = w / S;
        if (L.fill) g.fill(p); else g.stroke(p);
        g.restore();
      } else if (L.fill) g.fill(p); else g.stroke(p);
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
      if (!Array.isArray(pts) || pts.length < 2) break;
      g.beginPath();
      pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
      /* closed：让折线自己收口。多给一个字段比多给一堆重复点省事，
         模型画"脸/身体"这类闭合轮廓时不必把首点再写一遍。 */
      if (L.closed) g.closePath();
      if (L.fill) g.fill(); else g.stroke();
      break;
    }
    case 'arrow': {
      pathArrow(g, L.from, L.to, L.head);
      break;
    }
    case 'text': {
      const size = L.size || 96;
      g.font = `${L.weight ?? WEIGHT} ${size}px ${L.font || FONT}`;
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
    case 'stencil':
      paintStencil(g, L, W, H);
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
