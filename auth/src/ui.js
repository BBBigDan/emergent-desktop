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
 */

export const LW = 820;
export const LH = 560;

/* 点阵栅格：cell = 逻辑 px。
   2.5 时拉丁字很干净，但 CJK 小字（登录 Olares / 密码）笔画间距正好等于一格，
   抗锯齿后随机合并成一片。收到 2.2 让字怀能稳定留出一格暗缝。 */
export const CELL = 2.2;
const TH = 0.40;

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

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/**
 * @param {{olaresId:string, password:string, focused:boolean, busy:boolean, error:string}} s
 */
export function paint(ctx, s) {
  const c = ctx;
  c.clearRect(0, 0, LW, LH);
  c.textBaseline = 'middle';
  c.textAlign = 'center';

  /* ── 用户名（官方位置在头像下方 16px） ── */
  const shortName = (s.olaresId || 'Olares').split('@')[0];
  c.fillStyle = tone(ROLE.NAME);
  c.font = `700 ${Math.round(24 * K)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  c.fillText(shortName, CX, NAME_Y);

  /* ── 提示 ── */
  c.fillStyle = tone(ROLE.HINT);
  c.font = `500 ${Math.round(26 * K)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  c.letterSpacing = '2px';
  c.fillText('登录 Olares', CX, HINT_Y);
  c.letterSpacing = '0px';

  /* ── 输入框：官方是 0.4 白色填充，点阵里改成描边（实心会糊成一块） ── */
  const I = HIT.input;
  c.strokeStyle = tone(ROLE.FRAME);
  c.lineWidth = s.focused ? 2.4 : 1.7;
  roundRect(c, I.x, I.y, I.w, I.h, 9 * K);
  c.stroke();

  const cy = I.y + I.h / 2;
  const n = s.password.length;

  if (n === 0 && !s.focused) {
    /* 占位：两个字比四个更经得起点阵（字间至少留一格） */
    c.fillStyle = tone(ROLE.PLACE);
    c.font = `600 ${Math.round(21 * K)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    c.textAlign = 'left';
    c.fillText('密码', I.x + 14 * K, cy);
    c.textAlign = 'center';
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
      c.fillStyle = tone(ROLE.HINT);
      c.fillRect(dx + 1, cy - 1.5, 11 * K, 3);
    }
  }

  /* ── 右端箭头 ── */
  const B = HIT.button;
  const ax = B.x + B.w / 2;
  c.strokeStyle = tone(ROLE.ARROW);
  if (s.busy) {
    /* 忙碌：箭头变成一小段正在走的横线 */
    c.fillStyle = tone(ROLE.ARROW);
    c.fillRect(ax - 9 * K, cy - 1.5, 18 * K, 3);
  } else {
    /* 一个向右的箭头：横线 + 箭尖 */
    c.lineWidth = 2.0;
    c.beginPath();
    c.moveTo(ax - 7 * K, cy);
    c.lineTo(ax + 6 * K, cy);
    c.moveTo(ax + 1 * K, cy - 5 * K);
    c.lineTo(ax + 6 * K, cy);
    c.lineTo(ax + 1 * K, cy + 5 * K);
    c.stroke();
  }

  /* ── 错误 ── */
  if (s.error) {
    c.fillStyle = tone(ROLE.ERROR);
    c.font = `500 ${Math.round(15 * K)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    c.fillText(s.error, CX, I.y + I.h + 26 * K);
  }
}

/**
 * 采样：格内墨的覆盖率 ≥ TH 就点亮该格，点落在**格心**（零抖动）。
 */
export function scan(ctx) {
  const W = LW, H = LH;
  const d = ctx.getImageData(0, 0, W, H).data;
  const S = W + 1;
  const sat = new Uint32Array(S * (H + 1));
  const A_MIN = 90;

  for (let y = 0; y < H; y++) {
    let rs = 0;
    const cur = (y + 1) * S, prev = y * S, row = y * W;
    for (let x = 0; x < W; x++) {
      if (d[(row + x) * 4 + 3] > A_MIN) rs += 1;
      sat[cur + x + 1] = sat[prev + x + 1] + rs;
    }
  }

  const cols = Math.ceil(W / CELL);
  const rows = Math.ceil(H / CELL);
  const pts = [];   // [x, y, role, key]

  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.min(H, Math.round(cy * CELL));
    const y1 = Math.min(H, Math.round((cy + 1) * CELL));
    if (y1 <= y0) continue;
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.min(W, Math.round(cx * CELL));
      const x1 = Math.min(W, Math.round((cx + 1) * CELL));
      if (x1 <= x0) continue;

      const sum = sat[y1 * S + x1] - sat[y1 * S + x0] - sat[y0 * S + x1] + sat[y0 * S + x0];
      if (sum / ((x1 - x0) * (y1 - y0)) < TH) continue;

      let bestA = -1, role = 1;
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        for (let x = x0; x < x1; x++) {
          const o = (row + x) * 4, a = d[o + 3];
          if (a > bestA) { bestA = a; role = Math.round(d[o] / 25); }
        }
      }
      role = Math.max(1, Math.min(8, role));
      pts.push((cx + 0.5) * CELL, (cy + 0.5) * CELL, role, cx * 4096 + cy);
    }
  }
  return pts;
}
