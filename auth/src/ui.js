/**
 * 登录界面「墨稿」—— 用 2D canvas 画出应该有的字形与线条，再栅格化成点阵。
 *
 * 布局不是自己编的，是照官方登录页量的（1440×900 下）：
 *   卡片 262×300 居中、透明
 *   头像 124×124 圆形，水平居中，距卡片顶 16
 *   用户名 24px/700，margin 16 0 4
 *   提示「登录 Olares」14px，margin 0 0 12
 *   输入框 220×32，圆角 8，背景 rgba(255,255,255,.4)
 *   输入框右侧留了 18px 给箭头
 *
 * 点阵需要字更大才认得出，所以整体放大 K 倍；比例完全照官方。
 * 头像不在这里画 —— 它是真实照片，用 DOM img 渲染，外圈另有粒子流包裹。
 *
 * 每个控件能**单独绘制 + 单独扫描**（scanPart）：悬停时增援粒子要按更细的
 * 网格灌进那个控件，灌得越密控件越清楚。所以 paint() 只是把几个 draw 串起来。
 */

export const LW = 820;
export const LH = 560;

/* 点阵栅格：cell = 逻辑 px。
   2.5 时拉丁字很干净，但 CJK 小字（登录 Olares / 密码）笔画间距正好等于一格，
   抗锯齿后随机合并成一片。收到 2.2 让字怀能稳定留出一格暗缝。 */
/* 1.9：字号 32~35px 的等线 Light 笔画 ≈1.6px = 0.84 格 —— 恰好"一笔一格"，
   字怀还能留出一格暗缝。格子再大（2.2）笔画只有 0.7 格，点阵就碎成散点。 */
export const CELL = 1.9;
/* 增援层用更密的网格：悬停控件的槽位数 ×(2.2/1.4)² ≈ 2.5 倍，
   不然 2400 颗增援粒子无槽可去，只能在鼠标周围空转。 */
export const CELL_R = 1.2;
const TH = 0.40;
const TH_R = 0.34;   // 细网格的覆盖率阈值也降一点，细笔画才不至于整条丢失

/* 官方尺寸 → 本画布的放大系数 */
const K = 1.16;

const CARD_H = 300 * K;
const Y_OFF = 12;                       // 目测校准：内容在画布上偏上，往下压一点
const CARD_TOP = (LH - CARD_H) / 2 + Y_OFF;
const CX = LW / 2;

/* 头像：124 圆，距卡片顶 16 */
export const AVA = {
  d: 124 * K,
  cx: CX,
  cy: CARD_TOP + (16 + 62) * K,
  r: (124 * K) / 2,
};

/* 用户名 / 提示 / 输入框，y 取官方相对卡片的偏移 */
const NAME_Y = CARD_TOP + 156 * K;
const HINT_Y = CARD_TOP + 196 * K;

export const HIT = {
  input: {
    x: CX - 110 * K,
    y: CARD_TOP + 234 * K,
    w: 220 * K,
    h: 32 * K,
  },
  /* 输入框右端的箭头，官方那 18px 留白就是它 */
  button: {
    x: CX + 110 * K - 26 * K,
    y: CARD_TOP + 234 * K,
    w: 24 * K,
    h: 32 * K,
  },
};

export const ROLE = {
  NAME: 1,
  HINT: 2,
  FRAME: 3,
  DOT: 4,
  ARROW: 5,
  PLACE: 6,
  CURSOR: 7,
  ERROR: 8,
};

const tone = (role) => `rgb(${role * 25}, 0, 0)`;   // R = role×25

/* ————————————— 字体工程（原型 v0.14 的结论，直接复用） —————————————
 * 点阵能不能读，取决于**笔画占多少格**，不是字号：
 *   微软雅黑 400 / SimHei：笔画 ≈1.2 格，邻域连通度 2.6~3.0 → 每个笔画横截面
 *   占 2 格，字怀（笔画之间的空隙）被填死 = 糊成块。
 *   等线 Light：笔画 ≈0.8 格 → 笔画恰 1 格、字怀留 1 格暗缝 = 能认的点阵字。
 * 所以中文走等线 Light，西文走 Bahnschrift Light（可变字重 + 窄字宽），
 * 字重一律 300；再给汉字加一格字距（全角字默认紧贴，两个字会并成一团）。
 * 之前用 700 PingFang，那就是"太粗、影响阅读"的根源。 */
const F_CJK = '"DengXian Light","Microsoft YaHei Light","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif';
const F_LAT = '"Bahnschrift Light",Bahnschrift,Candara,"Segoe UI","Helvetica Neue",sans-serif';
const TRACK = CELL;                 // 汉字之间留一格暗缝
const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;
const hasCJK = (t) => CJK.test(t);

/**
 * 画一行字：自动挑字体栈、加字距、居中补偿。
 * @returns {number} 实测宽度（含字距）
 */
function uiText(c, role, px, str, x, y, align = 'center') {
  const cjk = hasCJK(str);
  const size = Math.round(px);
  /* 中文 300（等线 Light 的笔画刚好 0.8 格）；西文 400 —— Bahnschrift Light
     在 30px 这个尺寸笔画只有 ~1.3px（0.6 格），点阵会碎成散点。 */
  c.font = `${cjk ? 300 : 400} ${size}px ${cjk ? F_CJK : F_LAT}`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillStyle = tone(role);

  let w;
  if (cjk && 'letterSpacing' in c) {
    c.letterSpacing = TRACK + 'px';
    /* Chrome 把尾随字距算进宽度 → 居中时视觉左偏半格，补回来 */
    const dx = align === 'center' ? -TRACK / 2 : 0;
    w = c.measureText(str).width;
    c.fillText(str, x + dx, y);
    c.letterSpacing = '0px';
  } else {
    w = c.measureText(str).width;
    c.fillText(str, x, y);
  }
  return w;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* 控件矩形（逻辑坐标），由 draw 时实测填入；悬停命中和细扫描都用它 */
const RECT = { name: null, hint: null, input: null, button: null };

/* 命中检测顺序：button 压在 input 上，必须先判 */
const HIT_ORDER = ['button', 'input', 'name', 'hint'];

/** 逻辑坐标 → 控件 id */
export function partAt(lx, ly) {
  for (const id of HIT_ORDER) {
    const r = RECT[id];
    if (r && lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) return id;
  }
  return null;
}

/* 容量系数：线条类灌满更亮（一维结构越密越像实线），大段文字低一点
   （字怀本来就靠暗缝成立，灌太满会糊回去）。和原型的分档一致。 */
export const CAPK = { button: 0.95, input: 0.95, name: 0.5, hint: 0.5 };

/* ------------------------------------------------------------ 各控件绘制 */
function drawName(c, s) {
  const shortName = (s.olaresId || 'Olares').split('@')[0];
  /* 中文 ID 要比拉丁大两号才够格数（30px/2.2 ≈ 13.6 格，34px ≈ 15.5 格） */
  const size = hasCJK(shortName) ? 36 : 34;
  const w = uiText(c, ROLE.NAME, size, shortName, CX, NAME_Y, 'center');
  RECT.name = { x: CX - w / 2 - 2, y: NAME_Y - size / 2, w: w + 4, h: size };
}

function drawHint(c) {
  /* 汉字点阵 13 格勉强、15 格才稳 → 提示比官方 14px 放大到约 2.4 倍 */
  const size = 32;
  const txt = '登录 Olares';
  const w = uiText(c, ROLE.HINT, size, txt, CX, HINT_Y, 'center');
  RECT.hint = { x: CX - w / 2 - 2, y: HINT_Y - size / 2, w: w + 4, h: size };
}

function drawInput(c, s) {
  const I = HIT.input;
  c.strokeStyle = tone(ROLE.FRAME);
  c.lineWidth = s.focused ? 3.0 : 2.2;
  roundRect(c, I.x, I.y, I.w, I.h, 9 * K);
  c.stroke();

  const cy = I.y + I.h / 2;
  const n = s.password.length;
  c.textBaseline = 'middle';

  if (n === 0 && !s.focused) {
    /* 占位：两个字比四个更经得起点阵（字间至少留一格） */
    uiText(c, ROLE.PLACE, 30, '密码', I.x + 14 * K, cy, 'left');
  } else {
    /* 密码点：一格一个方点，左对齐 */
    const box = 12 * K;
    const gap = 15 * K;
    let dx = I.x + 14 * K;
    const maxVisible = Math.floor((I.w - 46 * K) / (box + gap));
    for (let i = 0; i < Math.min(n, maxVisible); i++) {
      c.fillStyle = tone(ROLE.DOT);
      c.fillRect(dx, cy - box / 2, box, box);
      dx += box + gap;
    }
    /* 光标位 */
    if (s.focused && n < maxVisible) {
      c.fillStyle = tone(ROLE.CURSOR);
      c.fillRect(dx, cy - box / 2, box, box);
    }
    if (n > maxVisible) {
      /* 溢出的用三个点表示：一条细横线在 1.9 的格子上会缩成一个孤点 */
      c.fillStyle = tone(ROLE.HINT);
      const d3 = 3.2 * K, g3 = 3.4 * K;
      for (let i = 0; i < 3; i++) {
        c.fillRect(dx + i * (d3 + g3), cy - d3 / 2, d3, d3);
      }
    }
  }

  RECT.input = { x: I.x, y: I.y, w: I.w, h: I.h };
}

function drawArrow(c, s) {
  const B = HIT.button;
  const cy = B.y + B.h / 2;
  const ax = B.x + B.w / 2;

  c.strokeStyle = tone(ROLE.ARROW);
  if (s.busy) {
    /* 忙碌：箭头变成一小段正在走的横线 */
    c.fillStyle = tone(ROLE.ARROW);
    c.fillRect(ax - 9 * K, cy - 1.5, 18 * K, 3);
  } else {
    /* 一个向右的箭头：横线 + 箭尖 */
    c.lineWidth = 2.1;
    c.beginPath();
    c.moveTo(ax - 8 * K, cy);
    c.lineTo(ax + 7 * K, cy);
    c.moveTo(ax + 1 * K, cy - 6 * K);
    c.lineTo(ax + 7 * K, cy);
    c.lineTo(ax + 1 * K, cy + 6 * K);
    c.stroke();
  }

  RECT.button = { x: ax - 10 * K, y: cy - 10 * K, w: 20 * K, h: 20 * K };
}

function drawError(c, s) {
  if (!s.error) return;
  const I = HIT.input;
  /* 报错要看清：比提示小一号，但仍守住 12 格以上 */
  uiText(c, ROLE.ERROR, 24, s.error, CX, I.y + I.h + 30 * K, 'center');
}

const DRAW = {
  name: drawName,
  hint: drawHint,
  input: drawInput,
  button: drawArrow,
};

/**
 * 完整墨稿
 * @param {{olaresId:string, password:string, focused:boolean, busy:boolean, error:string}} s
 */
export function paint(ctx, s) {
  const c = ctx;
  c.clearRect(0, 0, LW, LH);
  c.textBaseline = 'middle';
  c.textAlign = 'center';

  drawName(c, s);
  drawHint(c, s);
  drawInput(c, s);
  drawArrow(c, s);
  drawError(c, s);
}

/* ------------------------------------------------------------ 栅格化采样 */

const A_MIN = 90;

/** 积分图：一次 O(W·H) 建表，之后每格覆盖率 O(1)；几何判定用二值掩膜 */
function buildSat(d, W, H) {
  const S = W + 1;
  const sat = new Uint32Array(S * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0;
    const cur = (y + 1) * S, prev = y * S, row = y * W;
    for (let x = 0; x < W; x++) {
      if (d[(row + x) * 4 + 3] > A_MIN) rs += 1;
      sat[cur + x + 1] = sat[prev + x + 1] + rs;
    }
  }
  return sat;
}

/** 在 [x0,x1)×[y0,y1) 内按 cell 网格采样，返回 [x, y, role, key] */
function scanIn(d, W, H, sat, cell, th, x0, y0, x1, y1, withKey) {
  const S = W + 1;
  const pts = [];
  const cx0 = Math.floor(x0 / cell), cx1 = Math.ceil(x1 / cell);
  const cy0 = Math.floor(y0 / cell), cy1 = Math.ceil(y1 / cell);

  for (let cy = cy0; cy < cy1; cy++) {
    const yy0 = Math.max(y0, Math.round(cy * cell));
    const yy1 = Math.min(H, Math.round((cy + 1) * cell));
    if (yy1 <= yy0) continue;
    for (let cx = cx0; cx < cx1; cx++) {
      const xx0 = Math.max(x0, Math.round(cx * cell));
      const xx1 = Math.min(W, Math.round((cx + 1) * cell));
      if (xx1 <= xx0) continue;

      const sum = sat[yy1 * S + xx1] - sat[yy1 * S + xx0] - sat[yy0 * S + xx1] + sat[yy0 * S + xx0];
      if (sum / ((xx1 - xx0) * (yy1 - yy0)) < th) continue;

      /* 角色取格内**最不透明**那个像素的 R 值（=role×25）。
         不能用均值：占位符 alpha 0.42，均值会把角色压低、亮度也跟着错。 */
      let bestA = -1, role = 1;
      for (let y = yy0; y < yy1; y++) {
        const row = y * W;
        for (let x = xx0; x < xx1; x++) {
          const o = (row + x) * 4, a = d[o + 3];
          if (a > bestA) { bestA = a; role = Math.round(d[o] / 25); }
        }
      }
      role = Math.max(1, Math.min(8, role));
      pts.push((cx + 0.5) * cell, (cy + 0.5) * cell, role);
      if (withKey) pts.push(cx * 4096 + cy);
    }
  }
  return pts;
}

/**
 * 采样：格内墨的覆盖率 ≥ TH 就点亮该格，点落在**格心**。
 * 采样点本身是规整的，但位置上还有流场在推（见 field.js）——所以不是死图。
 */
export function scan(ctx) {
  const W = LW, H = LH;
  const d = ctx.getImageData(0, 0, W, H).data;
  const sat = buildSat(d, W, H);
  return scanIn(d, W, H, sat, CELL, TH, 0, 0, W, H, true);
}

/**
 * 只扫某个控件，用细网格 —— 给增援层当槽位。
 * 注意：会清空并重画画布，调用方事后要 paint() 还原。
 * @returns {number[]} [x, y, role] 三元组，行优先（已按 y,x 有序）
 */
export function scanPart(ctx, s, id, scale) {
  const r = RECT[id];
  const draw = DRAW[id];
  if (!r || !draw) return null;

  const W = LW, H = LH;
  ctx.clearRect(0, 0, W, H);
  draw(ctx, s);

  const d = ctx.getImageData(0, 0, W, H).data;
  const sat = buildSat(d, W, H);
  /* 槽位坐标要跟骨架落在同一个世界坐标里，所以这里用同一个 scale；
     但 cell 仍按逻辑 px 取 → 屏幕上大约 1.4×scale CSS px 的密度。
     scale 很小时（窄屏）槽位会稀，这里按 scale 反向补偿一点。 */
  const cell = CELL_R / Math.max(0.72, Math.min(1.15, scale));
  const pad = 2;
  return scanIn(
    d, W, H, sat, cell, TH_R,
    Math.max(0, r.x - pad), Math.max(0, r.y - pad),
    Math.min(W, r.x + r.w + pad), Math.min(H, r.y + r.h + pad),
    false,
  );
}
