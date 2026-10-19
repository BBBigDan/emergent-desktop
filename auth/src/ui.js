/**
 * 登录界面「墨稿」—— 用 2D canvas 画出应该有的字形与线条，再栅格化成点阵。
 *
 * 内容照官方登录页（头像 / 用户名 / 提示 / 密码框 + 箭头），
 * **但尺度不照官方** —— 官方那个 262×300 的卡片是为 14px 文字设计的，
 * 塞进点阵里根本立不起来。这里用原型 UI 模式的那套尺度：
 *
 *   原型：UI_W=760 UI_H=490 逻辑画布，SCAN_CELL=2.5，UI_S=0.144，
 *         相机距 48 / fov 55 → 可见世界高 50 → 逻辑像素上屏放大 2.59 倍。
 *         于是标题 72 逻辑 px 在屏幕上是 187px，汉字 98px 高，
 *         点距 6.5 屏幕 px、点径 12.2 屏幕 px —— 点径是点距的 1.9 倍，
 *         点与点重叠，笔画汇成一条连续的亮线。
 *
 * 本文件：LW=600 LH=400 逻辑画布、CELL=2.5（和原型同一个密度），
 * 上屏缩放由 login.js 的 calcScale 取 min(W/LW, H/LH)，
 * 在 1440×900 下是 2.25 倍 → 缩放比、点距、点径三项都和原型对齐。
 *
 * 直接照官方那个小卡片放大是没用的：字号 ÷ 点距 只有 16 格（原型 28.8 格），
 * 汉字少四成格子，怎么调都是「散」或「糊」。
 *
 * 头像不在这里画 —— 它是真实照片，用 DOM img 渲染，外圈另有粒子流包裹。
 *
 * 每个控件能**单独绘制 + 单独扫描**（scanPart）：悬停时增援粒子要按更细的
 * 网格灌进那个控件，灌得越密控件越清楚。所以 paint() 只是把几个 draw 串起来。
 */

export const LW = 600;
export const LH = 400;

/* 点阵栅格（逻辑 px）—— 原型的 SCAN_CELL。
   字号 ÷ 2.5 ≥ 25 时汉字才有 25 格以上可辨；配合覆盖率阈值 0.45
   就能保证「每个笔画横截面恒为 1 格、笔画之间恒留 1 格暗缝」。 */
export const CELL = 2.5;
/* 增援层用更密的网格：(2.5/1.35)² ≈ 3.4 倍槽位，悬停的控件才会明显变实 */
export const CELL_R = 1.35;
const TH = 0.45;     // 原型 SCAN_TH
/* 增援细网格的覆盖率阈值（比骨架略低，细笔画才不至于整条丢失） */
const TH_R = 0.45;

const CX = LW / 2;

/* 头像：直径 132 逻辑（屏幕 ~297px），圆心偏上留出文字空间 */
export const AVA = {
  d: 96,
  cx: CX,
  cy: 101.25,
  r: 48,
};

const NAME_Y = 188;
const HINT_Y = 250;

/* 所有坐标都对齐到**格心**（n + 0.5）× CELL。
   差半格就会让 1 格宽的边框跨 2 行点 —— 2.4px 的线落在 2.5px 格边界上时，
   两格各占 1.2/2.5 = 0.48，都刚过阈值 0.45，于是边框变成两排点。
   对齐到格心后覆盖率 0.96 只点亮一格，就是原型那种「单行珠子」。 */
export const HIT = {
  input: {
    x: 66.25,
    y: 281.25,
    w: 467.5,
    h: 77.5,
  },
  /* 输入框右端的箭头，就是官方那 18px 留白放大后的样子 */
  button: {
    x: 66.25 + 467.5 - 56.25,
    y: 281.25,
    w: 48.75,
    h: 77.5,
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
 * 所以中文走等线 Light，西文走 Bahnschrift（可变字重 + 窄字宽），
 * 字重一律 300；再给汉字加一格字距（全角字默认紧贴，两个字会并成一团）。 */
const F_CJK = '"DengXian Light","Microsoft YaHei Light","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif';
const F_LAT = '"Bahnschrift Light",Bahnschrift,Candara,"Segoe UI","Helvetica Neue",sans-serif';
const TRACK = CELL;                 // 汉字之间留一格暗缝
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
const hasCJK = (t) => CJK.test(t);

/** 把一行文本切成「中文段 / 拉丁段」—— 两段字体栈、字号都不同 */
function splitRuns(str) {
  const runs = [];
  let cur = '', curCJK = null;
  for (const ch of str) {
    const isC = CJK.test(ch);
    if (curCJK === null) { curCJK = isC; cur = ch; }
    else if (isC === curCJK) cur += ch;
    else { runs.push([cur, curCJK]); cur = ch; curCJK = isC; }
  }
  if (cur) runs.push([cur, curCJK]);
  return runs;
}

function fontOf(isCJK, px) {
  /* 中文 300（等线 Light 笔画刚好 0.8 格）；西文 400 —— Light 在同样像素下
     笔画太细，点不亮一格。拉丁再降 12% 字号，视觉高度才和汉字齐平
     （Bahnschrift 的 cap height 比汉字高，同字号下看着大一号）。 */
  const size = Math.round(isCJK ? px : px * 0.80);
  return `${isCJK ? 300 : 400} ${size}px ${isCJK ? F_CJK : F_LAT}`;
}

/**
 * 画一行混排文字：逐段选字体、量宽、整体居中。
 * @returns {number} 实测总宽度
 */
function uiText(c, role, px, str, x, y, align = 'center') {
  const runs = splitRuns(str);
  c.textBaseline = 'middle';
  c.fillStyle = tone(role);

  /* 先量：每段宽度（中文段要带字距） */
  const widths = runs.map(([t, isC]) => {
    c.font = fontOf(isC, px);
    if (isC && 'letterSpacing' in c) c.letterSpacing = TRACK + 'px';
    const w = c.measureText(t).width;
    if (isC && 'letterSpacing' in c) c.letterSpacing = '0px';
    return w;
  });
  const total = widths.reduce((a, b) => a + b, 0);

  let cur = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const dx = align === 'center' ? -TRACK / 2 : 0;   // 尾随字距补偿（视觉居中）
  c.textAlign = 'left';
  let first = true;
  runs.forEach(([t, isC], i) => {
    c.font = fontOf(isC, px);
    if (isC && 'letterSpacing' in c) c.letterSpacing = TRACK + 'px';
    c.fillText(t, cur + (first ? dx : 0), y);
    if (isC && 'letterSpacing' in c) c.letterSpacing = '0px';
    cur += widths[i];
    first = false;
  });
  return total;
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
export const CAPK = { button: 0.75, input: 0.75, name: 0.34, hint: 0.34 };
/* 为什么不是 1：灌到 1 时 2400 颗全进控件，指针周围一颗旋转的都不剩 ——
   而"大量旋转的粒子"本身就是原型的一半观感。留一半在指针周围转，
   灌进去的那一半把控件填实，这才是"随鼠标移动、同时增加到附近组件上"。 */

/* ------------------------------------------------------------ 各控件绘制 */
function drawName(c, s) {
  const shortName = (s.olaresId || 'Olares').split('@')[0];
  /* 汉字 64px/2.5 = 25.6 格（原型标题 72/2.5 = 28.8 格） */
  const size = hasCJK(shortName) ? 66 : 62;
  const w = uiText(c, ROLE.NAME, size, shortName, CX, NAME_Y, 'center');
  RECT.name = { x: CX - w / 2 - 2, y: NAME_Y - size / 2, w: w + 4, h: size };
}

function drawHint(c) {
  /* 18.4 格 —— 再小笔画就填不满一格，竖笔会断成虚线 */
  const size = 46;
  const txt = '登录 Olares';
  const w = uiText(c, ROLE.HINT, size, txt, CX, HINT_Y, 'center');
  RECT.hint = { x: CX - w / 2 - 2, y: HINT_Y - size / 2, w: w + 4, h: size };
}

function drawInput(c, s) {
  const I = HIT.input;
  c.strokeStyle = tone(ROLE.FRAME);
  /* 线宽 4 逻辑 = 1.6 格 → 边框占 2 行点，才连成一条带子而不是虚线 */
  c.lineWidth = s.focused ? 3.4 : 2.4;
  roundRect(c, I.x, I.y, I.w, I.h, 18);
  c.stroke();

  const cy = I.y + I.h / 2;
  const padX = I.x + 28;
  const n = s.password.length;
  c.textBaseline = 'middle';

  if (n === 0 && !s.focused) {
    uiText(c, ROLE.PLACE, 46, '密码', padX, cy, 'left');
  } else {
    /* 密码点：4 格见方（屏幕 22px）。16px（6.4 格）时它比字还重，
       一排方块压在输入框里，视觉重心直接从"界面"掉到"密码框"。
       间距也从 26 收到 16，让 8 个字符仍然排在框体前 2/3 以内。 */
    const box = 10;
    const gap = 16;
    let dx = padX;
    const maxVisible = Math.floor((I.w - 100) / (box + gap));
    /* 圆点：方块的直角在点阵里缺角，4×4 格出来是"小乱码"；圆形栅格化后
       是干净的 3×3~4×4 圆斑，才像官方那种 bullet */
    const dot = (px, py, r, role) => {
      c.fillStyle = tone(role);
      c.beginPath();
      c.arc(px, py, r, 0, 6.2832);
      c.fill();
    };
    for (let i = 0; i < Math.min(n, maxVisible); i++) {
      dot(dx + box / 2, cy, box / 2, ROLE.DOT);
      dx += box + gap;
    }
    /* 光标位 */
    if (s.focused && n < maxVisible) {
      dot(dx + box / 2, cy, box / 2, ROLE.CURSOR);
    }
    if (n > maxVisible) {
      /* 溢出的用三个点表示 */
      c.fillStyle = tone(ROLE.HINT);
      const d3 = 5, g3 = 7;
      for (let i = 0; i < 3; i++) {
        c.beginPath();
        c.arc(dx + i * (d3 + g3) + d3 / 2, cy, d3 / 2, 0, 6.2832);
        c.fill();
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
    c.fillRect(ax - 20, cy - 3, 40, 6);
  } else {
    /* 一个向右的箭头：横线 + 箭尖，整体 38 逻辑 px 宽 */
    c.lineWidth = 3.2;
    c.beginPath();
    c.moveTo(ax - 19, cy);
    c.lineTo(ax + 17, cy);
    c.moveTo(ax + 3, cy - 14);
    c.lineTo(ax + 17, cy);
    c.lineTo(ax + 3, cy + 14);
    c.stroke();
  }

  RECT.button = { x: ax - 24, y: cy - 26, w: 48, h: 52 };
}

function drawError(c, s) {
  if (!s.error) return;
  const I = HIT.input;
  uiText(c, ROLE.ERROR, 34, s.error, CX, Math.min(LH - 14, I.y + I.h + 30), 'center');
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
    /* 覆盖率必须按**整格面积**算。
       scanPart 的扫描区是「控件矩形 ±pad」，起止点通常落在格子中间；
       如果按 y0/x0 裁掉格子的半边（max(y0, ·)），分母就只剩不到 1px，
       那么边缘的 1 个抗锯齿像素会被算成 100% 覆盖 → 整列/整行点亮，
       屏幕上就是控件外框那条「凭空多出来的边」。
       画布上此刻只画了当前这一个控件（scanPart 先 clearRect），
       所以放宽到整格不会吸到相邻控件的墨。 */
    const yy0 = Math.max(0, Math.round(cy * cell));
    const yy1 = Math.min(H, Math.round((cy + 1) * cell));
    if (yy1 <= yy0) continue;
    for (let cx = cx0; cx < cx1; cx++) {
      const xx0 = Math.max(0, Math.round(cx * cell));
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
 * @returns {number[]} [x, y, role, key] 四元组，行优先（已按 y,x 有序）。
 *   key 是格子索引，setSlots 靠它做**粘性分配**：密码框里多打一个字符时，
 *   边框那些格子的 key 一个都没变，占着它们的粒子就该继续待在那儿，
 *   而不是每敲一个键就整批重洗一遍角色（那就是"乱"的来源）。
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
  /* 线条类（边框 / 箭头）**用骨架格**取槽位：槽位正好落在骨架点上，
     灌注只是把那一颗点叠亮。细格在这里是有害的 —— 线宽 2.4 跨 2.05 个细格，
     无论怎么写都会点亮 2 行，边框看起来就"凭空粗了一圈"。
     面状控件（文字）才用细格加密，因为文字的笔画内部有空隙可以填。 */
  const contour = id === 'input' || id === 'button';
  const cell = contour ? CELL : CELL_R / Math.max(0.72, Math.min(1.15, scale));
  const pad = 2;
  return scanIn(
    d, W, H, sat, cell, TH_R,
    Math.max(0, r.x - pad), Math.max(0, r.y - pad),
    Math.min(W, r.x + r.w + pad), Math.min(H, r.y + r.h + pad),
    true,   // 带 key：供增援层做粘性分配
  );
}
