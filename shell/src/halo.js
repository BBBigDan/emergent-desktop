/**
 * 输入行的光环 —— 一圈绕着输入框流动的粒子。
 *
 * 为什么要有它：展开之后屏幕上没有"输入框"这个东西（它本来就该是透明的，
 * 中文输入法的候选框要挂在真 caret 上）。光标之外，用户没有任何视觉线索
 * 知道"话该往哪儿说"。所以这一圈不是装饰，它是**这一层里唯一的输入 affordance**。
 *
 * 三条约束（和骨架同一套规矩，别在这里破例）：
 *   · **不能是静态描边**。均匀亮度的闭合环读成"一个框"，那就回到 DOM 边框了。
 *     所以环上的点是有速度差的流：三处亮头沿周长跑，尾巴按距离衰减。
 *   · **不能钉死**。整圈跟着相干流场呼吸 ±1.5px，相位按屏幕坐标采，所以和背景
 *     起伏同源，不是各自抖。
 *   · **点距 2.4、点径 1.9**。这是 20px 文字上验证过的同一组数（pui 的 dot 公式
 *     16px→1.72 / 20px→2.0），再细就断成虚线、再粗就糊成一条白边。
 *
 * 形状用**椭圆**而不是圆角矩形：输入行是一行字，"圈住它"用椭圆最省点数，
 * 而且没有四个角那种"框"的味道。按角度采样会让长轴两端点挤成一堆
 * （rx/ry ≈ 5 时能差 3 倍密度），所以这里先建一张**弧长表**，按弧长均分。
 */

const TAU = Math.PI * 2;

/* 环的可见尺寸。输入行宽 620、高 34（.ag-type），所以横轴比它宽 60、
   纵轴比它高 36 —— 写字时不会碰到环，不写字时环又确实"包住"了那一行。 */
export const HALO_RX = 340;
export const HALO_RY = 36;

/** 弧长表精度：720 段足够让 2.4px 的取样不抖 */
const LUT_N = 720;

export function createHalo({ field, alloc, slots = 420 }) {
  const base = alloc.alloc(slots, 'halo');
  let cx = 0;
  let cy = 0;
  let rx = HALO_RX;
  let ry = HALO_RY;
  let raf = 0;
  let t0 = 0;
  let level = 0;        // 0 = 收起，1 = 全亮
  let levelTo = 0;
  let hot = 0;          // 正在打字/提交时额外亮一点
  let hotTo = 0;

  /* 弧长表：累计长度 + 每段的方向（法线用不到，光尘只需要位置）。
     一次性建好，几何变了才重建。 */
  let lut = null;
  const buildLut = () => {
    const xs = new Float32Array(LUT_N + 1);
    const ys = new Float32Array(LUT_N + 1);
    const cum = new Float32Array(LUT_N + 1);
    let len = 0;
    for (let i = 0; i <= LUT_N; i++) {
      const a = (i / LUT_N) * TAU;
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry;
      xs[i] = x;
      ys[i] = y;
      if (i > 0) len += Math.hypot(x - xs[i - 1], y - ys[i - 1]);
      cum[i] = len;
    }
    lut = { xs, ys, cum, len };
  };

  /** 弧长参数 u∈[0,1) → 坐标。表是等角度采的，这里二分找段再做线性插值。 */
  function at(u) {
    const target = ((u % 1) + 1) % 1 * lut.len;
    let lo = 0;
    let hi = LUT_N;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (lut.cum[mid] <= target) lo = mid; else hi = mid;
    }
    const seg = lut.cum[hi] - lut.cum[lo] || 1;
    const f = (target - lut.cum[lo]) / seg;
    return {
      x: cx + lut.xs[lo] + (lut.xs[hi] - lut.xs[lo]) * f,
      y: cy + lut.ys[lo] + (lut.ys[hi] - lut.ys[lo]) * f,
    };
  }

  /* 每颗粒子在环上的**基准位置**是均分的（i/slots）；流动靠加一个全局相位。
     别用 random —— 每帧重新随机会让环"沸腾"，看起来像噪点而不是流。 */
  const u0 = new Float32Array(slots);
  /* 径向抖动（固定种子，每颗自己的）。这是"粒子流"和"描边"的分界线：
     均分 + 同一亮度 = 一条虚线边框；每颗偏离 2px 上下 = 一圈有厚度的尘。 */
  const jit = new Float32Array(slots);
  for (let i = 0; i < slots; i++) {
    u0[i] = i / slots;
    const r = Math.sin(i * 91.7 + 3.1) * 43758.5453;
    jit[i] = ((r - Math.floor(r)) * 2 - 1);
  }

  function tick() {
    const t = (performance.now() - t0) / 1000;
    level += (levelTo - level) * 0.10;
    hot += (hotTo - hot) * 0.12;
    if (level < 0.004 && levelTo === 0) {          // 收干净了就别再画
      field.slotBlank(base, slots);
      raf = requestAnimationFrame(tick);
      return;
    }

    const pts = [];
    /* 环上跑三处亮头，速度不同 —— 同速会让整圈看起来在"整体旋转"，
       而输入框的光应该是"有东西在流"，不是表盘在转。 */
    const heads = [t * 0.13 % 1, (0.37 + t * 0.095) % 1, (0.71 - t * 0.070 + 1) % 1];
    const a = Math.max(0, Math.min(1, level));
    for (let i = 0; i < slots; i++) {
      const u = (u0[i] + t * 0.030) % 1;
      const p = at(u);
      /* 呼吸：按屏幕坐标采样一条低频正弦，整圈同相位、幅度 1.5px 以内 */
      const br = Math.sin((p.x * 0.011 + p.y * 0.017) + t * 0.9) * 1.4
        + jit[i] * 2.4;
      /* 亮头：到最近一处头部的距离（按环上的比例，绕过接缝取小的那个） */
      let near = 1;
      for (const h of heads) {
        const d = Math.abs(((u - h) % 1 + 1.5) % 1 - 0.5);
        if (d < near) near = d;
      }
      const streak = near < 0.16 ? Math.pow(1 - near / 0.16, 2.2) : 0;
      /* 底色压到 0.06：环的"存在"由流动的亮头给，不靠一圈均匀的底光 ——
         均匀底光就是边框。 */
      pts.push({
        x: p.x + br,
        y: p.y + br * 0.7,
        ink: (0.05 + 0.16 * a + 0.86 * streak) * (0.55 + 0.45 * a) * (1 + hot * 0.5),
      });
    }
    /* scl 走热值：提交的一瞬间整圈亮一档，然后自己回落 —— 它替"回车按下了"说话，
       比任何 toast 都轻。 */
    field.slotPut(base, pts, [0.42, 0.70, 0.96], 0.9 + hot * 0.5, null, 1.9);
    raf = requestAnimationFrame(tick);
  }

  return {
    get base() { return base; },
    get level() { return level; },
    layout(o) {
      cx = o.x; cy = o.y;
      rx = o.rx ?? rx;
      ry = o.ry ?? ry;
      buildLut();
    },
    start() {
      if (raf) return;
      if (!lut) buildLut();
      t0 = performance.now() - 2000;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      field.slotBlank(base, slots);
    },
    /** 0 = 收起（agent 关着），1 = 亮着；hot 是"刚说过话"的那一下 */
    setLevel(v) { levelTo = Math.max(0, Math.min(1, v)); },
    setHot(v) { hotTo = Math.max(0, Math.min(1, v)); },
    dispose() { this.stop(); },
  };
}
