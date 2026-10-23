/**
 * 「思考过程」那一栏的**粒子框** —— 一圈沿圆角矩形流动的点，把一块屏幕围成"空间"。
 *
 * 它为什么不是 CSS 边框：这一层里没有"边框"这个东西。一块区域要被圈出来，
 * 只能是粒子自己围出来 —— 而且必须是**流动**的：
 *
 *   · 均匀亮度的闭合线读成"一个框"，那就退回 DOM 了；
 *   · 所以边界上的点是**沿周长单向流动**的（不是原地呼吸），再叠两个速度不同的
 *     亮头，让它看起来像一股围着这块地方打转的流；
 *   · 四角额外压实一点 —— 流动的线在拐角处会显得薄，角上补密度才有"这里拐了个弯"。
 *
 * 三条从 halo（输入行光环）继承的规矩，别再破一次：
 *   · 点距 ~2.6、点径 ~1.9：20px 字上验证过的同一组数，再细就断成虚线；
 *   · 每颗点有固定种子的径向抖动（±1.8px），不均分才不会像"虚线描边"；
 *   · 从头到尾**没碰相干度** —— 那是溶解的语法，不是"在干活"的语法。
 *
 * 另外两件事：
 *   · **开口**是从小脸那一侧（左边中点）**同时向上下生长**出来的，
 *     所以观感是"从它身上拉出一块空间"，不是"一个框淡入"。
 *   · 收起之后如果这一轮还有经过可看，小脸外圈留一道很暗的细弧 ——
 *     那是唯一的"点这里还有东西"的提示，不说就没人会去点那张脸。
 */

const TAU = Math.PI * 2;

/** 一圈点 + 连接线 + 内部尘埃 + 收起态细弧
 *
 * 密度是这里第一个踩到的坑：520 颗围 1409px 的周长 = 点距 2.7px，而点径只有 1.6px
 * —— 在 DPR 1 的屏幕上断开成一串独立的圆点，截图里就是**一条虚线边框**，
 * 正是这个模块开头要避免的那件事。点距必须落在 1.5~1.8：点和点相切才成线。
 * 900 颗 → 1.56px，配合 0.95 的点径倍数，边才连起来。
 *
 * 连接线同理：30 颗走 130px 是 4.3px 一颗，看起来像撒了一把沙子。 */
const N_FRAME = 900;
const N_LINK = 70;
const N_DUST = 60;
const N_RING = 30;
const N_SPARK = 80;
const SLOTS = N_FRAME + N_LINK + N_DUST + N_RING + N_SPARK;

/* 「看不见」不等于 `ink: 0` —— slotPut 的 alpha 是 (0.55 + 0.45×ink)×scl，
   ink 归零还剩 55% 的亮度。所以让一颗点消失的**唯一**办法是把它挪出屏幕。
   这条在这套粒子界面里反复踩：凡是"淡出"的地方都得判断位置，不是判断亮度
   （踩过的现场：收起之后边框还留着两串大点在边上亮着）。 */
const HIDDEN = { x: -9999, y: -9999, ink: 0 };

/* 点距是这套粒子边框唯一的"能不能连成线"的开关，而点数（900）是**固定的** ——
   于是周长越长，点距越大：那一栏（≈1300px）是 1.56px，换模型表面板
   （≈1800px）就变成 2.0px，屏幕上是一条**虚线**（截图里一眼看出来）。
   补不了点数（槽位是场景的），就按点距把**点径**放大同样的比例 ——
   "点和点相切"这件事只跟 点径÷点距 有关，跟绝对尺寸无关。
   1.32 是上限：再粗就成了霓虹灯管，不如让它细一点、看得出是点。 */
const PER_REF = 1300;
const DOT_REF = 1.55;

export function createTraceFrame({ field, alloc, slots = SLOTS }) {
  const base = alloc.alloc(slots, 'trace');

  let rect = { x: 0, y: 0, w: 430, h: 236, r: 18 };
  /* 牵引线的起点（小脸的圆心）。可以**没有**：换模型那张表是从状态条上那个名字
     长出来的，它就在表的正上方，再拉一根从名字到左中点的曲线会绕一个多余的圈 ——
     那种面板不该有牵引线。`anchor:null` 就是"这块地方是独立的"。 */
  let anchor = { x: 0, y: 0 };
  let raf = 0;
  let t0 = 0;
  /* 0 = 收起，1 = 全开。rev 是"生长到哪一步"，和 level 分开：
     生长只影响**可见范围**，level 影响**亮度**，两者相乘不会互相打脸。 */
  let level = 0;
  let levelTo = 0;
  let rev = 0;
  let revTo = 0;
  let ringLevel = 0;
  let ringTo = 0;

  /* 逐点固定量：基准 u、径向抖动、内部尘埃的漂移参数 */
  const u0 = new Float32Array(N_FRAME);
  const jit = new Float32Array(N_FRAME);
  const grain = new Float32Array(N_FRAME);   // 逐点的亮度差，破掉"均分=虚线"的观感
  const dust = new Float32Array(N_DUST * 4);   // u, v, phase, speed
  for (let i = 0; i < N_FRAME; i++) {
    u0[i] = i / N_FRAME;
    jit[i] = rnd(i * 91.7 + 3.1) * 2 - 1;
    grain[i] = 0.72 + rnd(i * 41.3 + 7.7) * 0.5;
  }
  for (let i = 0; i < N_DUST; i++) {
    dust[i * 4] = rnd(i * 13.3 + 1.7);
    dust[i * 4 + 1] = rnd(i * 71.9 + 5.3);
    dust[i * 4 + 2] = rnd(i * 37.1 + 9.9) * TAU;
    dust[i * 4 + 3] = 0.4 + rnd(i * 53.7 + 2.2) * 0.8;
  }

  function rnd(n) {
    const x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
  }

  /* ── 周长参数化：从左边中点出发，顺时针绕一圈 ─────────────────────
     九段（四条边各被圆角切成两半 + 四个 90° 弧）。先算段长，再按 u 落点。
     不能按角度采样：长边和短边的点密度会差三倍。 */
  let segs = [];
  let per = 0;
  function build() {
    const { x, y, w, h, r } = rect;
    const rr = Math.min(r, w / 2 - 1, h / 2 - 1);
    const s = [];
    const line = (x1, y1, x2, y2) => s.push({ k: 'l', x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1) });
    const arc = (cx, cy, a0, a1) => s.push({ k: 'a', cx, cy, a0, a1, len: Math.abs(a1 - a0) * rr });
    /* 从左边中点向上 */
    line(x, y + h / 2, x, y + rr);
    arc(x + rr, y + rr, Math.PI, Math.PI * 1.5);
    line(x + rr, y, x + w - rr, y);
    arc(x + w - rr, y + rr, Math.PI * 1.5, TAU);
    line(x + w, y + rr, x + w, y + h - rr);
    arc(x + w - rr, y + h - rr, 0, Math.PI * 0.5);
    line(x + w - rr, y + h, x + rr, y + h);
    arc(x + rr, y + h - rr, Math.PI * 0.5, Math.PI);
    line(x, y + h - rr, x, y + h / 2);
    segs = s;
    per = s.reduce((n, g) => n + g.len, 0);
  }

  /** u ∈ [0,1) → 周长上的点 */
  function at(u, out) {
    let d = ((u % 1) + 1) % 1 * per;
    for (const g of segs) {
      if (d > g.len) { d -= g.len; continue; }
      const f = g.len ? d / g.len : 0;
      if (g.k === 'l') {
        out.x = g.x1 + (g.x2 - g.x1) * f;
        out.y = g.y1 + (g.y2 - g.y1) * f;
      } else {
        const a = g.a0 + (g.a1 - g.a0) * f;
        const rr = Math.min(rect.r, rect.w / 2 - 1, rect.h / 2 - 1);
        out.x = g.cx + Math.cos(a) * rr;
        out.y = g.cy + Math.sin(a) * rr;
      }
      return out;
    }
    out.x = rect.x;
    out.y = rect.y + rect.h / 2;
    return out;
  }

  const P = { x: 0, y: 0 };
  const smooth = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));

  let frames = 0;
  let errs = 0;
  function tick() {
    frames += 1;
    /* rAF 里的异常是**静默**的：回调一抛，这条链就断了，屏幕上只是"框不动了"，
       控制台一行提示都没有（为了这件事查了二十分钟）。所以这一层包住，
       并且只喊前三次 —— 每帧一条会把控制台刷穿。 */
    try {
      tickBody();
    } catch (e) {
      if (errs++ < 3) console.error('[traceframe]', e && e.message, (e && e.stack ? e.stack.split('\n')[1] : ''));
    }
  }
  function tickBody() {
    const t = (performance.now() - t0) / 1000;
    level += (levelTo - level) * 0.12;
    rev += (revTo - rev) * 0.14;
    ringLevel += (ringTo - ringLevel) * 0.10;

    /* 收干净了就别再画（省 600 次计算，也避免残留点亮着） */
    if (level < 0.004 && levelTo === 0 && ringLevel < 0.01) {
      field.slotBlank(base, slots);
      raf = requestAnimationFrame(tick);
      return;
    }

    /* ── 框：沿周长流动的一圈点 ── */
    const pts = [];
    /* 两个亮头，速度不同 —— 同速会让整圈看起来在"整体旋转"，
       而异速的两处亮光读起来才是"有东西在流"。 */
    const h1 = (t * 0.09) % 1;
    const h2 = (0.46 - t * 0.062 + 1) % 1;
    for (let i = 0; i < N_FRAME; i++) {
      /* 生长：从左边中点（u=0）向两头同时展开 */
      const d = Math.min(u0[i], 1 - u0[i]) / 0.5;
      const vis = smooth((rev * 1.12 - d) / 0.16);
      if (vis <= 0.001) { pts.push(HIDDEN); continue; }
      const u = (u0[i] + t * 0.026) % 1;
      at(u, P);
      /* 呼吸：按屏幕坐标采低频，整圈同相位；再叠自己的固定抖动 */
      const br = Math.sin(P.x * 0.012 + P.y * 0.016 + t * 0.85) * 1.2 + jit[i] * 1.8;

      /* 亮头：到最近头部的环形距离 */
      let near = 1;
      for (const hh of [h1, h2]) {
        const dd = Math.abs(((u - hh) % 1 + 1.5) % 1 - 0.5);
        if (dd < near) near = dd;
      }
      const streak = near < 0.13 ? Math.pow(1 - near / 0.13, 2.0) : 0;

      /* 四角压实：离哪个角近，就亮一点、密一点 */
      const cx0 = Math.min(P.x - rect.x, rect.x + rect.w - P.x);
      const cy0 = Math.min(P.y - rect.y, rect.y + rect.h - P.y);
      const corner = Math.max(0, 1 - Math.hypot(cx0, cy0) / 46) * 0.5;

      /* 底色 0.22 + 亮头 0.62 + 四角 0.42。
         底色不能压太暗（0.06 时整圈只剩亮头可见，看起来是"两粒光在跑"，
         而不是"一圈围住这块地方的流"）；也不能全靠 ink 拉开对比 ——
         alpha 的映射是 0.55+0.45×ink，ink 从 0 到 1 只差 1.8 倍。 */
      const ink = (0.22 + 0.62 * streak + corner * 0.42) * grain[i];
      pts.push({ x: P.x + br, y: P.y + br * 0.62, ink: Math.min(1, ink) * vis * level });
    }

    /* ── 连接线：从小脸拉到框的左边中点 ──
       它不是装饰：没有它，框看起来是"凭空出现的一块 UI"；有了它，
       读起来是"那团东西伸出来一块"。 */
    const lx = rect.x;
    const ly = rect.y + rect.h / 2;
    /* 没有锚点（换模型那张表）就整批挪出屏幕。**判断必须在取 anchor.x 之前** ——
       写在循环里的话，`ax` 那两行会先抛 TypeError，而 rAF 里的异常是静默的：
       框不动了、控制台一行都没有（这一条在模块头上写过，别再踩）。 */
    const ax = anchor ? anchor.x + 22 : 0;
    const ay = anchor ? anchor.y + 2 : 0;
    for (let i = 0; i < N_LINK; i++) {
      if (!anchor) { pts.push(HIDDEN); continue; }
      const f = i / (N_LINK - 1);
      /* 二次贝塞尔：控制点在下方，线微微下垂，像被拉出来的一道丝 */
      const mx = (ax + lx) / 2;
      const my = Math.max(ay, ly) + 14;
      const x = (1 - f) * (1 - f) * ax + 2 * (1 - f) * f * mx + f * f * lx;
      const y = (1 - f) * (1 - f) * ay + 2 * (1 - f) * f * my + f * f * ly;
      const wob = Math.sin(t * 2.2 + i * 0.7) * 0.9;
      /* 越靠近框越亮：这根线是"从它身上拉出来"的，方向感靠亮度梯度给 */
      pts.push({ x, y: y + wob, ink: (0.14 + 0.5 * f * f) * level * rev });
    }

    /* 点径 1.85 —— 和输入行那圈光同一个数。
       这是"点阵能不能连成线"的唯一开关：1.56px 的点距配 0.95 的点径时，
       实际可见芯只有 0.43×2.4 ≈ 1.1px（柔光吃掉了大半），屏幕上是**一串独立圆点**，
       也就是一条虚线边框。1.55 时可见芯 ≈ 1.7px，点与点相接，边才成一条线（再往上就糊成一条粗光带，
       1.85 试过 —— 厚得像霓虹灯管）；
       流动感由那两道更大的流光给（见下面 spark）。 */
    /* 点径跟着周长走：1.55 是在 ≈1300px 的周长上量的（见 PER_REF） */
    const dotK = Math.min(1.32, Math.max(1, per / PER_REF));
    field.slotPut(base, pts, [0.44, 0.80, 1.0], 0.88, null, DOT_REF * dotK);

    /* ── 内部尘埃：框里那点"空气" ──
       面板是半透明的玻璃（0.72 + blur），这些点透过它变成一层很淡的底噪。
       没有它们，玻璃后面是纯黑 —— 看起来像贴了张不透明卡片。 */
    const dustPts = [];
    for (let i = 0; i < N_DUST; i++) {
      const u = (dust[i * 4] + t * 0.006 * dust[i * 4 + 3]) % 1;
      const v = (dust[i * 4 + 1] + t * 0.004 * dust[i * 4 + 3] * 0.7) % 1;
      const x = rect.x + 14 + u * (rect.w - 28);
      const y = rect.y + 12 + v * (rect.h - 24);
      const tw = 0.5 + 0.5 * Math.sin(t * 1.1 + dust[i * 4 + 2]);
      if (level * rev < 0.10) { dustPts.push(HIDDEN); continue; }
      dustPts.push({ x, y, ink: (0.05 + 0.16 * tw) * level * rev });
    }
    field.slotPut(base + N_FRAME + N_LINK, dustPts, [0.40, 0.72, 0.95], 0.9, null, 0.62);

    /* ── 收起态：小脸外圈一道很暗的细弧，慢慢转 ──
       它是**唯一的提示**：这一轮还有经过可看，点那张脸。 */
    const ringPts = [];
    const rr = 31;
    for (let i = 0; i < N_RING; i++) {
      const a = (i / N_RING) * TAU + t * 0.5;
      /* 只画三分之二圈：闭合的圈会读成"加载中"，开口的弧才是"这里还有东西" */
      if (i / N_RING > 0.66 || ringLevel < 0.04) { ringPts.push(HIDDEN); continue; }
      const fade = Math.sin((i / N_RING / 0.66) * Math.PI);
      ringPts.push({
        x: anchor.x + Math.cos(a) * rr,
        y: anchor.y + Math.sin(a) * rr * 0.92,
        ink: 0.34 * fade * ringLevel,
      });
    }
    field.slotPut(base + N_FRAME + N_LINK + N_DUST, ringPts, [0.50, 0.82, 1.0], 0.85, null, 0.75);

    /* ── 流光：沿边框跑的两道亮头 ──
     *
     * 为什么必须单独一批：`slotPut` 的亮度映射是 `(0.55 + 0.45×ink) × scl` ——
     * ink 从 0 到 1 只差 1.8 倍，**边框永远是一圈亮度均匀的线**（截图里就是虚线框）。
     * 真正拉开对比的是**点径**：这一批用 2.1 倍点径 + 更白的颜色，
     * 于是"流"是几粒明显更大的光在跑，而不是"整圈一起亮一下"。
     * 这也是 halo 那圈看上去在流动的原因（它整圈都用了 1.9 倍点径做亮头）。 */
    const sparkPts = [];
    const heads2 = [t * 0.075 % 1, (0.55 - t * 0.052 + 1) % 1];
    for (let hi = 0; hi < heads2.length; hi++) {
      for (let k = 0; k < N_SPARK / 2; k++) {
        const u = (heads2[hi] - k * 0.0032 + 1) % 1;
        at(u, P);
        /* 尾巴按 k 衰减：前面一颗最亮，后面拖成一段淡影 */
        const fade = Math.pow(1 - k / (N_SPARK / 2), 2.4);
        /* 尾巴末端、以及整个框正在收的时候 —— 一律挪出屏幕。
           这一条是**踩出来的**：`ink=0` 的 alpha 是 0.55 而不是 0，
           所以"淡出"用 ink 是做不出来的，收完的框会剩两串大点在边上亮着。 */
        if (fade < 0.06 || level * rev < 0.10) { sparkPts.push(HIDDEN); continue; }
        sparkPts.push({ x: P.x, y: P.y, ink: (0.35 + 0.65 * fade) * level * rev });
      }
    }
    field.slotPut(base + N_FRAME + N_LINK + N_DUST + N_RING, sparkPts,
      [0.78, 0.94, 1.0], 1, null, 1.9);

    raf = requestAnimationFrame(tick);
  }

  return {
    get slots() { return slots; },
    /* 临时探针：为什么 level 不涨（查完删） */
    dbg: () => ({ level, rev, levelTo, revTo, raf: raf ? 1 : 0, frames, per, base, slots, rect: { ...rect }, anchor: { ...anchor } }),
    get open() { return levelTo > 0; },
    get level() { return level; },

    layout(o) {
      const prev = { ...rect };
      rect = {
        x: Math.round(o.x), y: Math.round(o.y),
        w: Math.round(o.w), h: Math.round(o.h),
        r: o.r ?? 18,
      };
      anchor = o.anchor ? { x: o.anchor.x, y: o.anchor.y } : null;
      if (prev.x !== rect.x || prev.y !== rect.y || prev.w !== rect.w || prev.h !== rect.h) build();
    },

    start() {
      if (raf) return;
      if (!per) build();
      t0 = performance.now() - 3000;
      raf = requestAnimationFrame(tick);
    },

    stop() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      field.slotBlank(base, slots);
    },

    /* 开：从脸上长出来 */
    setOpen(on) {
      levelTo = on ? 1 : 0;
      revTo = on ? 1 : 0;
      /* 收起时把"还有记录"那道弧的点亮起来由 deskagent 决定（see setHint） */
      if (!on) revTo = 0;
    },

    /** 收起之后还留着经过 → 脸外圈那道细弧；点开或换题就灭 */
    setHint(on) {
      ringTo = on ? 1 : 0;
    },

    dispose() { this.stop(); },
  };
}
