/**
 * loading 区：一张小表情 + 一组粒子化的"在想"。
 *
 * 它不是一个"有 loading 才出现的控件"，而是一个一直在的小东西：
 * 不转的时候有表情，一开口想就收成螺旋 + 云 + 流的叠加体。
 *
 * 几条被反复踩过的约束，写在这里免得下次又忘：
 *  · 48px 是下限。再小，眼睛和嘴的笔画间距会小于 3px，并成一条线。
 *  · 换表情只在 idle。思考、逐字输出期间锁定 —— 一边等一边换表情，
 *    读起来是"它没在听"。
 *  · 眼睛 ±2px 微动、整块跟着相干流场起伏，和骨架同一条规则：绝不钉死。
 *  · 点距 2.2 / 可见芯 ≈ 2.1，笔画才连成线；这是 18px 文字上验证过的同一组数。
 */

const TAU = Math.PI * 2;

/* 每帧都要算出"同一片云"，所以不能用 Math.random() */
function rnd(n, seed) {
  const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* 线 / 弧 / 圆 → 点阵。间距 2.2px 是"点和点相接"的实测值 */
const STEP = 2.2;

function line(x1, y1, x2, y2, out, ink = 1) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(2, Math.round(len / STEP));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    out.push({ x: x1 + (x2 - x1) * u, y: y1 + (y2 - y1) * u, ink });
  }
  /* 两行：单行点在点距 2.2 下会断成虚线 */
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    out.push({ x: x1 + (x2 - x1) * u, y: y1 + (y2 - y1) * u + 1.15, ink });
  }
}

function arc(cx, cy, r, a0, a1, out, ink = 1, squash = 1) {
  const len = Math.abs(a1 - a0) * r;
  const n = Math.max(3, Math.round(len / STEP));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * squash, ink });
  }
}

function circle(cx, cy, r, out, ink = 1) {
  arc(cx, cy, r, 0, TAU, out, ink);
  arc(cx, cy, r - 1.1, 0, TAU, out, ink * 0.9);
}

/**
 * 表情的点集。尺寸 s 是"整张脸的跨度"，48 是基准。
 * 返回的坐标是相对中心的。
 */
function facePts(mood, s, t, blink) {
  const pts = [];
  const ex = s * 0.19;      // 眼距的一半
  const ew = s * 0.13;      // 眼半长
  const ey = -s * 0.06;
  const mw = s * 0.22;      // 嘴半宽
  const my = s * 0.24;
  /* 眼睛微动：幅度 2px 以内 —— 再大就成了"抽搐"而不是"活着" */
  const jx = Math.sin(t * 0.9) * 1.4;
  const jy = Math.cos(t * 0.7) * 1.1;

  if (mood === 'sleepy') {
    arc(-ex, ey + 2, ew, Math.PI * 1.12, Math.PI * 1.88, pts);
    arc(ex, ey + 2, ew, Math.PI * 1.12, Math.PI * 1.88, pts);
    line(-mw, my, mw, my, pts);
  } else if (mood === 'alert') {
    circle(-ex + jx, ey + jy, ew * 0.5, pts);
    circle(ex + jx, ey + jy, ew * 0.5, pts);
    circle(0, my, s * 0.055, pts);
  } else if (mood === 'speak') {
    line(-ex - ew + jx, ey + jy, -ex + ew + jx, ey + jy, pts);
    line(ex - ew + jx, ey + jy, ex + ew + jx, ey + jy, pts);
    /* 嘴是椭圆的上下一半：张合时两条弧的距离变 */
    const open = s * 0.055 + Math.abs(Math.sin(t * 9)) * s * 0.045;
    arc(0, my - open * 0.5, mw * 0.62, 0, Math.PI, pts, 1, 0.7 + open / (s * 0.2));
    arc(0, my - open * 0.5, mw * 0.62, Math.PI, TAU, pts, 1, 0.7 + open / (s * 0.2));
  } else {
    /* calm / blink：眨眼时眼睛缩到 45% */
    const sh = blink ? 0.45 : 1;
    line(-ex - ew * sh + jx, ey + jy, -ex + ew * sh + jx, ey + jy, pts);
    line(ex - ew * sh + jx, ey + jy, ex + ew * sh + jx, ey + jy, pts);
    line(-mw, my, mw, my, pts);
  }
  return pts;
}

/** "在想"的三种形态叠在一起：螺旋给结构、云给体积、流给方向 */
function loadPts(s, t, n) {
  const pts = [];
  const R = s * 0.92;
  const ARMS = 3;

  /* 1) 螺旋骨架：三条对数臂，向内收，慢转 */
  const nSpiral = Math.round(n * 0.46);
  for (let k = 0; k < nSpiral; k++) {
    const u = k / nSpiral;
    const arm = k % ARMS;
    const a = (arm / ARMS) * TAU + u * TAU * 1.05 + t * 1.25;
    const r = 3 + u * R;
    const j = Math.sin(k * 12.9898 + t * 3.1) * 1.7;
    pts.push({
      x: Math.cos(a) * (r + j),
      y: Math.sin(a) * (r + j) * 0.92,
      ink: 0.52 - u * 0.30,
    });
  }

  /* 2) 云：不沿任何路径，只是被噪声推着涨落 —— 它负责"有厚度" */
  const nCloud = Math.round(n * 0.31);
  for (let k = 0; k < nCloud; k++) {
    const a = rnd(k, 3) * TAU + t * 0.40;
    const r = 5 + rnd(k, 5) * R * 0.82 + Math.sin(t * 1.2 + k * 0.7) * 3.5;
    pts.push({
      x: Math.cos(a) * r * 0.80,
      y: Math.sin(a) * r * 0.68,
      ink: 0.10 + 0.12 * (0.5 + 0.5 * Math.sin(t * 2.1 + k * 1.7)),
    });
  }

  /* 3) 粒子流：沿螺旋臂向外跑的亮点，带一条越来越暗的尾 */
  const nFlow = n - nSpiral - nCloud;
  for (let k = 0; k < nFlow; k++) {
    const lane = k % ARMS;
    const back = (k / nFlow) * 0.30;
    let u = (t * 0.40 + lane / ARMS - back) % 1;
    if (u < 0) u += 1;
    const a = (lane / ARMS) * TAU + u * TAU * 1.05 + t * 1.25;
    const r = 3 + u * R;
    pts.push({
      x: Math.cos(a) * r,
      y: Math.sin(a) * r * 0.92,
      ink: Math.pow(Math.max(0, 1 - back / 0.30), 2.2) * 1.1,
    });
  }
  return pts;
}

const MOOD_COLOR = {
  calm: [0.50, 0.89, 0.82],
  blink: [0.50, 0.89, 0.82],
  sleepy: [0.40, 0.72, 0.78],
  speak: [0.62, 0.92, 0.86],
  alert: [0.95, 0.42, 0.40],
};

const LOAD_COLOR = [0.48, 0.86, 0.95];

export function createFace({ field, alloc, slots = 300 }) {
  const base = alloc.alloc(slots, 'face');
  let cx = 0;
  let cy = 0;
  let size = 48;
  let N = slots;

  let mood = 'calm';
  let loading = false;
  let busy = false;        // 一轮在跑（含逐字输出）
  let blend = 0;          // 0 = 表情，1 = 螺旋
  let raf = 0;
  let t0 = 0;

  /* 眨眼与换表情的时钟。两个都用"下一次"的时间戳，
     而不是每帧判余数 —— 余数做法在掉帧时会连眨两下。 */
  let nextBlink = 0;
  let blinkUntil = 0;
  let nextMood = 0;
  let alertUntil = 0;

  function layout(o) {
    cx = o.x;
    cy = o.y;
    if (o.size) size = o.size;
    N = Math.min(slots, o.slots || slots);
  }

  function tick() {
    const t = (performance.now() - t0) / 1000;
    const now = performance.now();

    /* 眨眼：4~7 秒一次，闭 120ms（<60 看不见，>200 像卡顿） */
    if (!nextBlink) nextBlink = now + 4000 + Math.random() * 3000;
    if (now > nextBlink) {
      blinkUntil = now + 120;
      nextBlink = now + 4000 + Math.random() * 3000;
    }
    const blink = now < blinkUntil;

    /* 换表情只在 idle —— 一边转一边换脸，读起来是"它没在听"。
       三条优先级：告警 > 正在跑（说话/在想）> 空闲轮换。 */
    if (now < alertUntil) {
      mood = 'alert';
    } else if (!loading && busy) {
      /* 逐字输出时嘴随字开合。节拍跟的是同一个 t，不另设计时器 ——
         两份节拍必然漂移，而漂移的表现是"嘴和字不同步"。 */
      mood = 'speak';
    } else if (!loading && now > nextMood) {
      const pool = ['calm', 'calm', 'sleepy'];
      mood = pool[Math.floor(Math.random() * pool.length)];
      nextMood = now + 8000 + Math.random() * 7000;
    }

    /* 表情与螺旋之间的过渡：位置和亮度一起 lerp，所以是"散开再聚"，
       不是"淡出换一个" —— 同一批粒子、同一个位置，只有状态变。 */
    const target = loading ? 1 : 0;
    blend += (target - blend) * 0.09;
    if (Math.abs(blend - target) < 0.004) blend = target;

    const face = facePts(mood, size, t, blink);
    /* 表情用不完的槽位：围着它的一圈光尘（呼吸），不浪费，也不抢戏 */
    for (let k = face.length; k < N; k++) {
      const a = rnd(k, 7) * TAU + t * 0.28;
      const r = size * 0.62 + rnd(k, 13) * size * 0.40;
      face.push({
        x: Math.cos(a) * r,
        y: Math.sin(a) * r * 0.92,
        ink: 0.04 + 0.09 * (0.5 + 0.5 * Math.sin(t * 1.6 + k)),
      });
    }

    const load = loadPts(size, t, N);

    const fc = MOOD_COLOR[mood] || MOOD_COLOR.calm;
    const b = blend;
    const col = [
      fc[0] + (LOAD_COLOR[0] - fc[0]) * b,
      fc[1] + (LOAD_COLOR[1] - fc[1]) * b,
      fc[2] + (LOAD_COLOR[2] - fc[2]) * b,
    ];

    const pts = [];
    for (let i = 0; i < N; i++) {
      const f = face[i] || { x: 0, y: 0, ink: 0 };
      const l = load[i] || f;
      pts.push({
        x: cx + f.x + (l.x - f.x) * b,
        y: cy + f.y + (l.y - f.y) * b,
        ink: f.ink + (l.ink - f.ink) * b,
      });
    }
    /* 点径：和字号那条公式同源（18px → 1.72），小表情取略小一档 */
    field.slotPut(base, pts, col, 1 + b * 0.35, null, 1.05);

    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (raf) return;
    t0 = performance.now() - 1000;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    field.slotBlank(base, slots);
  }

  return {
    get base() { return base; },
    get slots() { return slots; },
    get loading() { return loading; },
    get blend() { return blend; },
    get mood() { return mood; },
    layout,
    start,
    stop,
    setMood(m) { mood = m; nextMood = performance.now() + 8000 + Math.random() * 7000; },
    /** 一轮在跑：逐字输出时锁定"说话"表情（§7.3：思考与输出期间不换表情） */
    setBusy(on) {
      busy = !!on;
      if (!busy) nextMood = performance.now() + 3000;
    },
    /** 告警：红脸 3.5 秒后自己回到常态 —— 工具失败不该永久改变它的表情 */
    alert(ms = 3500) { alertUntil = performance.now() + ms; },
    setLoading(on) {
      loading = !!on;
      if (!loading) nextMood = performance.now() + 3000;
    },
    dispose() { stop(); field.slotBlank(base, slots); },
  };
}
