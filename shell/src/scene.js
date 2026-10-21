/**
 * 场场景编译器：语义描述 → 粒子布局 → 逐帧演化。
 *
 * 这一层是「给模型的接口」和「粒子」之间的唯一桥梁，所以它只认语义：
 *   scene_set({ focus, layers:[{id,kind,...}] })
 *   scene_patch([{ id, progress }])
 *   scene_pulse(kind, { at })
 * 几何（角度、半径、点距、字数）全部在这里算，模型永远不需要知道。
 *
 * 和 surface.js（DOM 渲染树）的分工：那边是"要读进去的东西"，
 * 这里是"看一眼就知道的东西"。两者共用同一套动作回灌。
 *
 * 六种 kind 对应六个编码器（见 docs/场界面-设计与接口.md §2）：
 *   gauge      标量 → 环形沉积量
 *   stream     进度 → 流动 + 沉积
 *   fork       二选一 → 两股流
 *   turbulence 异常 → 局部湍流
 *   condense   读数 → 凝聚成字
 *   trace      时间序列 → 曲线 + 扫掠头（历史靠"余晖"免费留在场里）
 *
 * 三个动词之外还有第四个：transition(next) —— 相变换页（溶解 → 重组）。
 * 它不是"两套 UI 交叉淡入淡出"，而是把相干度压到 0、换几何、再拉回 1。
 */

import { ParticleText, SlotAllocator, glyphBudget } from './pui.js';
import { FONT, FONT_LAT } from './draw.js';
import { TIMING } from './timing.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const COL = {
  ink: '#a9d4f7',
  dim: '#5d7fa4',
  line: '#3d5f85',
  ok: '#7fe3cf',
  warn: '#ffb257',
  bad: '#ff7c93',
  accent: '#7fc4ff',
};

/**
 * 把一段标签压进 n 个字。
 *
 * 场的字按"字数 × 预算"占槽位，超了就会被硬截断 —— 而硬截断会把数字切成
 * "换 34"这种没有意义的碎片。所以优先在空格/句读处断，实在没有才硬切，
 * 并且补一个省略号：**宁可少几个字，也不要留一个看着像算错了的半截数字**。
 */
function fit(text, n) {
  const ch = Array.from(String(text ?? ''));
  if (ch.length <= n) return ch.join('');
  const cut = ch.slice(0, n);
  for (let i = cut.length - 1; i > Math.floor(n * 0.45); i--) {
    if (' ·、，。；：'.includes(cut[i])) return `${cut.slice(0, i).join('')}…`;
  }
  return `${cut.slice(0, n - 1).join('')}…`;
}

function rgb(hex) {
  const s = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}

/** 沉降网格：沿一条曲线取 n 个点（格心对齐，避免亚像素相位差导致的噪点感） */
function alongPath(n, fn) {
  const out = [];
  for (let k = 0; k < n; k++) out.push(fn((k + 0.5) / n));
  return out;
}

function arcPoint(cx, cy, r, a) {
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
}

/**
 * 一个可交互区域的命中代价。返回 null 表示"没打中"。
 *
 * 用"到中心的距离"当代价，而不是布尔命中：分叉的两个分支和它的总锚点会重叠，
 * 谁的中心更近就是谁。这样"点在左边那股流上"不会误判成"点在分叉上"。
 */
function hotDist(h, x, y) {
  if (!h) return null;
  if (h.type === 'circle') {
    const d = Math.hypot(x - h.cx, y - h.cy);
    return d <= h.r ? d : null;
  }
  const inside = x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1;
  if (!inside) return null;
  /* 盒子内部：靠中线越近越优先（折线和进度条都是"越靠中间越像本体"） */
  return Math.abs(y - (h.y0 + h.y1) / 2) + Math.abs(x - (h.x0 + h.x1) / 2) * 0.02;
}

/** 窗口内数据的最小/最大值 —— 给读数用，也用来判"窗口里这段是新还是旧" */
function rangeOf(data, w) {
  const M = data.length;
  if (!M) return { min: 0, max: 0 };
  const a = Math.max(0, Math.floor(w[0] * (M - 1)));
  const b = Math.min(M - 1, Math.ceil(w[1] * (M - 1)));
  let min = Infinity;
  let max = -Infinity;
  for (let k = a; k <= b; k++) {
    if (data[k] < min) min = data[k];
    if (data[k] > max) max = data[k];
  }
  return { min, max };
}

export class FieldScene {
  /**
   * @param {object} o
   * @param {import('./field.js').Field} o.field
   * @param {{x:number,y:number,w:number,h:number}} o.area
   */
  constructor(o) {
    this.field = o.field;
    this.area = o.area;
    /* slotStart：场之外的常驻元素（比如演示页的提问字幕）先占住 0..N，
       场景从 N 往后分配。槽位是一条直线，两个分配器各开一个必然互相覆盖。 */
    this.slotStart = o.slotStart || 0;
    this.alloc = new SlotAllocator(6400, this.slotStart);
    this.layers = new Map();     // id -> { spec, nodes }
    this.texts = [];             // ParticleText
    this.flows = [];             // { idx:Uint16Array, path, speed, span, s0 }
    this.traces = [];            // 时间序列（曲线 + 扫掠头）
    this.t = 0;
    this.rev = 0;
    this.tr = null;              // 进行中的相变
    this.a11y = o.a11y || null;  // 可访问性镜像层（见 aria.js）
    /* 系统级降低动态：场的"活着"本身是动态，所以这里只能减幅不能归零，
       否则"流到哪了"这种信息就没了。 */
    this.reduced = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** 布局：整场重建。幂等，可以反复调用。 */
  set(spec) {
    const f = this.field;
    const a = this.area;
    this.alloc = new SlotAllocator(6400, this.slotStart);
    this.layers.clear();
    this.texts.length = 0;
    this.flows.length = 0;
    this.traces.length = 0;
    this.rev = spec.rev ?? this.rev + 1;

    /* 全局相干度基调：calm 静一点，alert 抖一点。抖动在后面逐帧加，
       这里先记住幅度（0 = 完全不抖）。 */
    this.jitter = spec.mood === 'alert' ? 1.1 : spec.mood === 'working' ? 0.55 : 0.3;
    if (this.reduced) this.jitter *= 0.35;

    f.slotBegin({ dim: 0.97, dot: 0.95 });

    const list = (spec.layers || []).filter((x) => x && x.kind);
    /* 只有 focus 那一个进 L2（凝聚成字），其余只给形状 —— 这是注意力分层，
       不是省事：同时展开三个细节，场就变成了低分辨率的表格。 */
    const focus = spec.focus || list[0]?.id;

    const gauges = list.filter((l) => l.kind === 'gauge');
    gauges.forEach((l, i) => this._gauge(l, i, gauges.length, a));

    list.filter((l) => l.kind === 'stream').forEach((l, i) => this._stream(l, i, a));

    list.filter((l) => l.kind === 'trace').forEach((l, i) => this._trace(l, i, a));

    const forks = list.filter((l) => l.kind === 'fork');
    forks.forEach((l) => this._fork(l, a));

    list.filter((l) => l.kind === 'condense').forEach((l, i) => this._condense(l, i, a));

    list.filter((l) => l.kind === 'turbulence').forEach((l) => this._turbulence(l, a));

    /* focus 的细节：任何 kind 都可以有一个 valueText，挂在它的锚点上 */
    const fl = list.find((l) => l.id === focus);
    if (fl) this._detail(this.layers.get(fl.id) || { spec: fl, anchor: null }, a);

    this.spec = spec;
    this.focus = focus;
    if (this.a11y && !this._noAnnounce) this.a11y.announce(spec, { force: true });
    return this;
  }

  /**
   * 相变换页：溶解 → 重组。
   *
   * 为什么不叠两套状态层：那需要一个"出场容器"和"入场容器"，两套布局、两次槽位分配，
   * 而且要处理"旧的在淡出、新的已可点"这段混乱期。场里不需要 ——
   * 相干度压到 0 时，旧结构自己就不成立了；换完几何再拉回 1，新结构自己长出来。
   * 全程同一批粒子，中途没有任何一刻是"两个界面同时在屏幕上"。
   *
   * @param {object} spec 新场景
   * @param {{outMs?:number, inMs?:number}} [opt]
   */
  transition(spec, opt = {}) {
    const from = this.field.coh;
    this.tr = {
      spec,
      phase: 'out',
      t: 0,
      from,
      /* 从当前相干度出发，时长按比例缩 —— 半途被新景打断时不会先"补满"再溶 */
      outMs: Math.max(80, (opt.outMs ?? TIMING.out) * from),
      inMs: opt.inMs ?? TIMING.in,
    };
    return this;
  }

  get busy() {
    return this.tr != null;
  }

  /** 只改数值，不重排（进度推进、指标刷新走这里） */
  patch(ops) {
    for (const op of ops || []) {
      const layer = this.layers.get(op.id);
      if (!layer) continue;
      if (op.progress != null && layer.spec.kind === 'stream') {
        layer.spec.progress = clamp(op.progress, 0, 1);
        this._stream(layer.spec, layer.i, this.area, layer);
        if (layer.detail) this._detail(layer, this.area);
      }
      if (op.value != null && layer.spec.kind === 'gauge') {
        layer.spec.value = clamp(op.value, 0, 1);
        this._gauge(layer.spec, layer.i, layer.n, this.area, layer);
        if (layer.detail) this._detail(layer, this.area);
      }
      if (op.data != null && layer.spec.kind === 'trace') {
        /* 换一批数据 = 每条曲线的目标高度变了。**不重画**，只改目标：
           弹簧自己会把整条曲线滑过去（DOM 里要逐点 FLIP 才做得到）。 */
        layer.spec.data = op.data;
        this._tracePoints(layer);
        this._refreshTraceText(layer);
      }
      if (op.label != null && layer.spec.kind === 'fork') {
        /* 分叉的文案可换，几何不动 —— 于是"改成另一个问题"是**零重排**的。
           这是"决策是排他的"能成立的技术前提：场里只有一个决策槽，
           新问题来了就地把旧的换掉，不新建、不叠两个。 */
        layer.spec.label = op.label;
        layer.title?.set(fit(op.label, 14));
        if (Array.isArray(op.options)) {
          layer.spec.options = op.options;
          op.options.slice(0, 2).forEach((o, k) => {
            const br = layer.branches[k];
            if (!br) return;
            br.option = { ...br.option, ...o };
            br.hot.option = br.option.id;    // 命中测试读的是 hot 上的 option
            br.text?.set(fit(o.label, 8));
          });
        }
      }
    }
    if (this.a11y) this.a11y.announce(this.spec);
    return this;
  }

  /** 一次性事件。四种 kind 各自翻译成一个物理动作。 */
  pulse(kind, opt = {}) {
    const f = this.field;
    const a = this.area;
    const at = opt.at && this.layers.get(opt.at);
    const p = at?.anchor || { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    if (kind === 'confirm') {
      /* 全场相位对齐一次：从中心向外一圈冲量，像一次心跳 */
      f.impulse(p.x, p.y, { r: 420, power: 210 });
      setTimeout(() => f.impulse(p.x, p.y, { r: 260, power: 120 }), 90);
    } else if (kind === 'error') {
      /* 局部湍流：连着敲几下小的，位置偏移 —— 观感是"这一片在抖" */
      for (let k = 0; k < 4; k++) {
        setTimeout(() => {
          f.impulse(p.x + (Math.random() - 0.5) * 90, p.y + (Math.random() - 0.5) * 60,
            { r: 110, power: 260 });
        }, k * 70);
      }
    } else if (kind === 'arrive') {
      f.impulse(p.x, p.y, { r: 200, power: 420 });
    } else if (kind === 'settle') {
      f.impulse(p.x, p.y, { r: 300, power: 90 });
    }
    if (this.a11y) this.a11y.event(kind, opt);
    return this;
  }

  /** 每帧：让"流"真的在流，推进相变，扫掠 tail 的头。这是 DOM 给不了的部分。 */
  step(dt) {
    this.t += dt;
    const f = this.field;
    const t = this.t;

    /* ── 相变时钟 ──
       和物理共用 dt，所以冻结物理时它也冻住，可以逐帧取样。 */
    const tr = this.tr;
    if (tr) {
      tr.t += dt * 1000;
      if (tr.phase === 'out') {
        const k = clamp(tr.t / tr.outMs, 0, 1);
        f.setCoherence(tr.from * (1 - k * k));   // 慢起步、越散越快
        if (k >= 1) {
          f.setCoherence(0);
          this._noAnnounce = true;
          this.set(tr.spec);                        // 几何换掉，此时相干度还是 0
          this._noAnnounce = false;
          tr.phase = 'in';
          tr.t = 0;
        }
      } else {
        const k = clamp(tr.t / tr.inMs, 0, 1);
        f.setCoherence(1 - Math.pow(1 - k, 3));     // 快起步、慢慢收
        /* 重组阶段提刚度：相干度 0.8s 就回 1，而平时的弹簧要走 1.2s 才落定，
           不提就会"已经宣布成形、字形还在抖"。
           注意**不能**写成随 k 衰减回 1：正好在收尾最需要硬的时候变软了，
           实测平均位置误差停在 6px（点距才 2.4px），看着就是"毛边"。 */
        f.setStiff(2.4);
        if (k >= 1) {
          f.setCoherence(1);
          f.setStiff(1);
          this.tr = null;
          if (this.a11y) this.a11y.announce(this.spec, { force: true });
        }
      }
    }

    const slow = this.reduced ? 0.35 : 1;
    for (const fl of this.flows) {
      const { idx, s0, s1, speed, path, jitter } = fl;
      for (let k = 0; k < idx.length; k++) {
        /* s 在 [s0,1] 之间循环：进度之前的段是沉积的（不参与），
           之后的段以 speed 流过，视觉上就是"还没到的地方在流"。 */
        const span = 1 - s0;
        if (span <= 0.001) continue;
        let s = s0 + (((k / idx.length) * span + t * speed * slow) % span);
        const p = path(s);
        const w = jitter * Math.sin(t * 3.1 + k * 2.7) * 4;
        const i = idx[k];
        f.drawX[i] = p.x + w - f.W * 0.5;
        f.drawY[i] = f.H * 0.5 - (p.y + Math.cos(t * 2.3 + k) * w);
      }
    }

    /* ── trace：扫掠头 + 逐点余晖 ──
       数据本身不动，动的只是"哪一段被照亮"。这一点很关键：
       DOM 里要让一条曲线持续活着，你得逐帧重算 path；这里只是改亮度。 */
    for (const tl of this.traces) {
      const { idx, xs, ys, N } = tl;
      const head = ((t * 0.13 * slow) % 1.35) - 0.18;    // 走出右边界再绕回来
      const boostR = 0.10;
      for (let k = 0; k < N; k++) {
        const s = k / (N - 1);
        const i = idx[k];
        const g = Math.exp(-((s - head) * (s - head)) / (2 * boostR * boostR));
        const drift = Math.sin(s * 9 + t * 1.1) * 1.4;
        f.drawX[i] = xs[k] - f.W * 0.5;
        f.drawY[i] = f.H * 0.5 - (ys[k] + drift - g * 3.5);
        /* 余晖：越靠右（越新）越亮；扫掠头再叠一层高光。
           于是"时间"这个维度没占任何额外槽位 —— 它就是亮度。 */
        /* 扫掠头不只是更亮，还被"抬起来"3.5px —— 于是它读作一个正在移动的东西，
           而不是一段碰巧更亮的点。 */
        f.drawA[i] = Math.min(1.35, 0.48 + 0.46 * Math.pow(s, 0.7) + 1.15 * g) * (tl.spec.fill ?? 1);
      }
    }
  }

  /* ───────────────────── 各种 kind ───────────────────── */

  _put(pts, color, scl = 1, base = null) {
    const f = this.field;
    const n = pts.length;
    const start = base ?? this.alloc.alloc(n, 'shape');
    f.slotPut(start, pts, rgb(color), scl);
    return { base: start, len: n, idx: Uint16Array.from(pts, (_, k) => ((start + k) * 7919 + 13) % 6400) };
  }

  /** 环形仪表：整圈点云，前 value 段亮，其余压暗 */
  _gauge(spec, i, count, a, reuse) {
    const R = 52;
    const gap = 250;
    const cx = a.x + a.w / 2 + (i - (count - 1) / 2) * gap;
    const cy = a.y + 150;
    const N = 180;
    const v = clamp(spec.value ?? 0, 0, 1);
    const lit = Math.max(0, Math.min(N, Math.round(v * N)));

    const layer = reuse || this.layers.get(spec.id) || {};
    layer.spec = spec;
    layer.i = i;
    layer.n = count;
    layer.anchor = { x: cx, y: cy };
    /* 纵向拖 = 调这个量。140px 走完整个量程，粗调；够用，也够稳。 */
    layer.hot = { type: 'circle', cx, cy, r: 88, gestures: ['adjust'], range: [0, 1] };
    this.layers.set(spec.id, layer);

    const f = this.field;
    if (layer.litBase == null) {
      layer.litBase = this.alloc.alloc(N, `g-lit-${spec.id}`);
      layer.dimBase = this.alloc.alloc(N, `g-dim-${spec.id}`);
    }
    /* 整圈重排一次坐标（值变了只改亮点数量，位置不动） */
    const ring = [];
    for (let k = 0; k < N; k++) {
      const p = arcPoint(cx, cy, R, -Math.PI / 2 + (TAU * k) / N);
      p.ink = 0.95;
      ring.push(p);
    }
    const litPts = ring.slice(0, lit);
    const dimPts = ring.slice(lit);
    /* 两段分开写：亮度差就是"多少"的主编码，不需要刻度线 */
    f.slotPut(layer.litBase, litPts, rgb(spec.color || COL.accent), 1);
    f.slotBlank(layer.litBase + litPts.length, N - litPts.length);
    f.slotPut(layer.dimBase, dimPts, rgb(COL.line), 0.5);
    f.slotBlank(layer.dimBase + dimPts.length, N - dimPts.length);

    /* 中心读数：场给"多少"，字给"几" —— 两种编码互为校验 */
    if (!layer.num) {
      layer.num = new ParticleText({
        field: f, alloc: this.alloc, x: cx, y: cy + 8, size: 26, max: 5,
        color: COL.ink, align: 'center', font: FONT_LAT, label: `gn-${spec.id}`,
      });
      layer.cap = new ParticleText({
        field: f, alloc: this.alloc, x: cx, y: cy + 33, size: 16, max: 4,
        color: '#93b8d8', align: 'center', font: FONT, label: `gc-${spec.id}`,
      });
    }
    /* 小于 0.5% 的不要写成 "0%"。
       真数据里这个情况很常见：n8n 占 2.4%，navidrome 占 0.17%。
       两个 0% 并排，看起来像"这两个应用没在跑"—— 而它们其实在跑，
       只是小。四舍五入到 0 是在用显示精度撒谎。 */
    layer.num.set(v > 0 && v < 0.005 ? '<1%' : `${Math.round(v * 100)}%`);
    layer.cap.set(spec.label || '');
    layer.detail = true;
    return layer;
  }

  /** 进度流：沉积段 + 流动段 */
  _stream(spec, i, a, reuse) {
    const x0 = a.x + 70;
    const x1 = a.x + a.w - 70;
    const y = a.y + 300 + i * 92;
    const N = 420;

    const layer = reuse || this.layers.get(spec.id) || { spec, i, anchor: { x: x0, y } };
    layer.spec = spec;
    layer.i = i;
    layer.anchor = { x: (x0 + x1) / 2, y };
    /* 整条带子可点，但**不可拖** —— 进度是一个事实（"跑了 62%"），
       拖它等于让界面说谎。想改进度得由模型确认。 */
    layer.hot = { type: 'box', x0, x1, y0: y - 30, y1: y + 28, gestures: ['tap'] };
    this.layers.set(spec.id, layer);

    const path = (s) => ({
      x: x0 + (x1 - x0) * s,
      y: y + Math.sin(s * Math.PI) * 12,
    });

    const prog = clamp(spec.progress ?? 0, 0, 1);
    const depN = Math.max(0, Math.round((N * 0.55) * prog));
    const flowN = N - depN;

    if (!layer.depBase) {
      layer.depBase = this.alloc.alloc(N, 'stream-dep');
      /* 必须按 N 预留：depN 变大时 flowN = N - depN 会超过 N*0.45，
         越界不会报错，只会静默覆盖后面元素（标签就是这么丢的）。 */
      layer.flowBase = this.alloc.alloc(N, 'stream-flow');
    }

    /* 沉积：均匀铺在 [0, prog] 上，静止、亮 */
    const depPts = [];
    for (let k = 0; k < depN; k++) {
      const s = ((k + 0.5) / Math.max(1, depN)) * prog;
      const p = path(s);
      depPts.push({ x: p.x, y: p.y, ink: 0.95 });
    }
    const f = this.field;
    f.slotPut(layer.depBase, depPts, rgb(COL.ok), 1);
    f.slotBlank(layer.depBase + depN, Math.round(N * 0.55) - depN);

    /* 流动：整条带子上跑，越接近沉积边界越亮（像水头） */
    if (layer.flowBase != null) {
      const arr = [];
      for (let k = 0; k < flowN; k++) {
        const p = path(0);
        arr.push({ x: p.x, y: p.y, ink: 0.45 });
      }
      f.slotPut(layer.flowBase, arr, rgb(COL.dim), 0.85);
      this.flows = this.flows.filter((x) => x.id !== spec.id);
      this.flows.push({
        id: spec.id,
        idx: Uint16Array.from(arr, (_, k) => ((layer.flowBase + k) * 7919 + 13) % 6400),
        s0: prog,
        path,
        speed: 0.22,
        jitter: 0.6,
      });
    }

    if (!layer.label) {
      layer.label = new ParticleText({
        field: f, alloc: this.alloc, x: x0, y: y - 22, size: 17, max: 12,
        color: '#93b8d8', font: FONT, label: `s-${spec.id}`,
      });
      layer.pct = new ParticleText({
        field: f, alloc: this.alloc, x: x1, y: y - 22, size: 16, max: 6,
        color: COL.ink, align: 'right', font: FONT_LAT, label: `sp-${spec.id}`,
      });
    }
    layer.label.set(spec.label || '');
    layer.pct.set(`${Math.round(prog * 100)}%`);
    layer.detail = true;
    return layer;
  }

  /**
   * 时间序列：一条曲线 + 一个扫掠头。
   *
   * 这个编码器是"历史免费"那句话的实证：曲线的形状就是数据，**时间维度用亮度编码**
   * （越靠右越新、越亮），没有刻度、没有网格、没有单独的"现在"标记 —— 却随时能看出
   * 哪段是刚才、哪段很久了。DOM 要表达同一件事得画折线 + 轴 + 高亮段。
   */
  _trace(spec, i, a) {
    const f = this.field;
    const N = 280;
    /* 曲线铺满整个区域的宽度（只留 30px 的边）。
       原来留 70，实测在 1600 宽的屏上曲线只占 680px，两边大片空着 ——
       而"一整小时的走势"本来就该横向拉满，它是时间的形状，
       横向的每一格都对应一分钟。 */
    const x0 = a.x + 30;
    const x1 = a.x + a.w - 30;
    /* 曲线区域从 244 下移到 276：仪表圆的底边在 a.y+202，圆里的
       "CPU / 内存" 那行字到 a.y+210 左右。原来 label 放在 a.y+214，
       实测正好压在仪表下面（"CPU 一小时" 贴着第一个圆的下沿）。
       留 40px 的呼吸，标签才不会看起来是属于某个仪表的。 */
    const yTop = a.y + 276;
    const yBase = a.y + 430;

    const layer = this.layers.get(spec.id) || {};
    layer.spec = spec;
    layer.N = N;
    layer.box = { x0, x1, yTop, yBase };
    layer.anchor = { x: (x0 + x1) / 2, y: yTop - 34 };
    /* 横向拖 = 平移观察窗口。**这是唯一一种本地就能执行的手势**：
       它改的是"看哪一段"，不是"事实是什么"。 */
    /* hot 区的上沿不能压到仪表的圆（圆的命中半径 88，圆心 a.y+150，底 a.y+238）。
       两个 hot 区重叠时，命中谁取决于遍历顺序 —— 那是不该由巧合决定的事。 */
    layer.hot = { type: 'box', x0, x1, y0: yTop - 34, y1: yBase + 26, gestures: ['pan'] };
    if (!layer.win) layer.win = Array.isArray(spec.win) ? spec.win.slice(0, 2) : [0, 1];
    this.layers.set(spec.id, layer);

    if (layer.base == null) {
      layer.base = this.alloc.alloc(N, `trace-${spec.id}`);
      layer.idx = Uint16Array.from({ length: N }, (_, k) => ((layer.base + k) * 7919 + 13) % 6400);
    }
    this._tracePoints(layer);

    /* 地平线：72 颗极暗的点标出"零"在哪。没有它，曲线是一条飘着的划痕，
       有它才读得出"离底多远"。这是整套设计里最便宜的一笔（72 槽位）。 */
    if (layer.axisBase == null) {
      layer.axisBase = this.alloc.alloc(72, `trace-axis-${spec.id}`);
      const ax = [];
      for (let k = 0; k < 72; k++) ax.push({ x: x0 + (x1 - x0) * (k / 71), y: yBase, ink: 0.5 });
      f.slotPut(layer.axisBase, ax, rgb(COL.line), 0.7);
    }

    if (!layer.label) {
      layer.label = new ParticleText({
        field: f, alloc: this.alloc, x: x0, y: yTop - 30, size: 17, max: 14,
        color: '#93b8d8', font: FONT, label: `tr-${spec.id}`,
      });
      layer.now = new ParticleText({
        field: f, alloc: this.alloc, x: x1, y: yTop - 30, size: 20, max: 6,
        color: COL.ink, align: 'right', font: FONT_LAT, label: `trn-${spec.id}`,
      });
      /* 峰值的标注。有真曲线之后它才成立 —— 之前 mock 的曲线是手写的，
         标"峰值"只是标在我自己编的那个数上。真数据里它是"这一小时最高到这"，
         是用户扫一眼就想知道的那个数。 */
      layer.peak = new ParticleText({
        field: f, alloc: this.alloc, x: x0, y: yTop, size: 16, max: 6,
        color: '#cfe4ff', align: 'center', font: FONT_LAT, label: `trp-${spec.id}`,
      });
    }
    layer.label.set(spec.label || '');
    this._refreshTraceText(layer);
    this.traces.push(layer);
    return layer;
  }

  /** 把数据重采样到 N 个点，写进槽位。patch 换数据时也走这里 —— 只改目标，弹簧负责滑过去。 */
  _tracePoints(layer) {
    const { x0, x1, yTop, yBase } = layer.box;
    const N = layer.N;
    const data = (layer.spec.data || []).map((v) => clamp(Number(v) || 0, 0, 1));
    const M = data.length;

    /* 纵向标度。缺省自适应（数据峰值的 1.2 倍，向上取到 0.1 的整数倍），
       否则 0~56% 的数据铺在 0~100% 的格子里，曲线永远贴着地平线。
       要绝对标度就传 axis:[0,1] —— 那是语义（"这是百分比负载"），该由模型说。 */
    let lo = 0;
    let hi = 1;
    if (Array.isArray(layer.spec.axis) && layer.spec.axis.length === 2) {
      lo = Number(layer.spec.axis[0]);
      hi = Number(layer.spec.axis[1]);
    } else if (M > 1) {
      /* 标度跟着窗口走：窗口内的峰值才是"这个尺度装不装得下"的答案 */
      const w0 = layer.win ? layer.win[0] : 0;
      const w1 = layer.win ? layer.win[1] : 1;
      const seg = data.slice(Math.floor(w0 * (M - 1)), Math.ceil(w1 * (M - 1)) + 1);
      hi = Math.max(0.3, Math.ceil(Math.max(...seg) * 12) / 10);
    }
    if (hi - lo < 1e-3) hi = lo + 1;
    if (!layer.xs) {
      layer.xs = new Float32Array(N);
      layer.ys = new Float32Array(N);
    }
    /* 观察窗口（0..1 的数据域）。默认全量；横向拖动改的是它。
       有了窗口，"看更早"就变成了本地操作 —— 不需要问模型。 */
    const w = layer.win || [0, 1];
    layer.range = rangeOf(data, w);
    const pts = [];
    for (let k = 0; k < N; k++) {
      const s = k / (N - 1);
      const ss = w[0] + (w[1] - w[0]) * s;
      let v = 0.5;
      if (M === 1) v = data[0];
      else if (M > 1) {
        const p = ss * (M - 1);
        const i0 = Math.floor(p);
        const i1 = Math.min(M - 1, i0 + 1);
        v = data[i0] + (data[i1] - data[i0]) * (p - i0);
      }
      const x = x0 + (x1 - x0) * s;
      const y = yBase - clamp((v - lo) / (hi - lo), 0, 1.06) * (yBase - yTop);
      layer.xs[k] = x;
      layer.ys[k] = y;
      /* ink 只用于首帧：之后 step() 每帧按余晖重算亮度 */
      pts.push({ x, y, ink: 0.35 + 0.6 * s });
    }
    this.field.slotPut(layer.base, pts, rgb(layer.spec.color || COL.accent), 1);
    return pts;
  }

  /** 分叉：两股流从一点分开，越靠外越散；光标是第三个吸引子 */
  _fork(spec, a) {
    const cx = a.x + a.w / 2;
    const cy = a.y + 470;
    const opts = (spec.options || []).slice(0, 2);
    const layer = { spec, anchor: { x: cx, y: cy }, branches: [] };
    layer.hot = { type: 'circle', cx, cy, r: 66, gestures: ['tap'] };
    /* 分支各自可点：两个选项共用一个锚点的话，永远分不出点了哪边。
       必须在 branches 填好之后再把它们挂上去（见函数末尾）。 */
    this.layers.set(spec.id, layer);

    const f = this.field;
    const title = new ParticleText({
      field: f, alloc: this.alloc, x: cx, y: cy - 30, size: 18, max: 14,
      color: '#93b8d8', align: 'center', font: FONT, label: `f-${spec.id}`,
    });
    title.set(fit(spec.label, 14));
    layer.title = title;

    opts.forEach((o, si) => {
      const dir = si === 0 ? -1 : 1;
      const N = 170;
      const path = (s) => ({
        x: cx + dir * (60 + s * 210) + Math.sin(s * 2.2) * 10,
        y: cy + 20 + s * 62,
      });
      const arr = [];
      for (let k = 0; k < N; k++) {
        const p = path((k + 0.5) / N);
        arr.push({ x: p.x, y: p.y, ink: 0.6 });
      }
      const base = this.alloc.alloc(N, `fork-${o.id}`);
      f.slotPut(base, arr, rgb(si === 0 ? COL.ok : COL.dim), 0.9);
      const idx = Uint16Array.from(arr, (_, k) => ((base + k) * 7919 + 13) % 6400);
      this.flows.push({ id: `${spec.id}:${o.id}`, idx, s0: 0, path, speed: 0.16, jitter: 0.4 });

      const txt = new ParticleText({
        field: f, alloc: this.alloc, x: cx + dir * 240, y: cy + 96, size: 16, max: 7,
        color: si === 0 ? COL.ok : '#93b8d8', align: 'center', font: FONT, label: `fo-${o.id}`,
      });
      txt.set(fit(o.label, 8));
      const bx = cx + dir * 240;
      const by = cy + 96;
      layer.branches.push({
        option: o, base, idx, path, text: txt, side: dir,
        hot: { type: 'circle', cx: bx, cy: by, r: 70, gestures: ['pick'], option: o.id },
      });
    });
    layer.hots = [layer.hot, ...layer.branches.map((b) => b.hot)];
    return layer;
  }

  /** 纯粹的一行读数（凝聚成字） */
  _condense(spec, i, a) {
    const f = this.field;
    /* 场上有分叉时，结论要躲到分叉上方去。
       不然它会正好压在两个选项中间 —— "Downloads 有 11 GB" 和 "归档 / 先不动"
       叠在一起，看着像写错行。分叉占了 a.y+470..+700 那一条带。 */
    const hasFork = [...this.layers.values()].some((l) => l.spec?.kind === 'fork');
    const y = hasFork ? a.y + 372 : a.y + 588 + i * 26;
    const t = new ParticleText({
      field: f, alloc: this.alloc, x: a.x + a.w / 2, y, size: 17, max: 20,
      color: hasFork ? '#93b8d8' : COL.dim, align: 'center', font: FONT, label: `c-${spec.id}`,
    });
    t.set(spec.text || '');
    this.texts.push(t);
    this.layers.set(spec.id, { spec, anchor: { x: a.x + a.w / 2, y: y - 28 }, text: t });
    return t;
  }

  /** 异常：一小团乱点，level 决定数量和抖动 */
  _turbulence(spec, a) {
    const cx = a.x + 74;
    const cy = a.y + 452;
    const lv = clamp(spec.level ?? 0.3, 0, 1);
    const N = Math.round(70 + 150 * lv);
    const pts = [];
    for (let k = 0; k < N; k++) {
      const ang = Math.random() * TAU;
      const rr = Math.random() * (20 + 30 * lv);
      pts.push({ x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr * 0.8, ink: 0.5 + Math.random() * 0.4 });
    }
    const base = this.alloc.alloc(N, `turb-${spec.id}`);
    this.field.slotPut(base, pts, rgb(COL.warn), 0.9);
    const idx = Uint16Array.from(pts, (_, k) => ((base + k) * 7919 + 13) % 6400);
    this.flows.push({ id: spec.id, idx, s0: 0, speed: 0, jitter: 2.4 * lv, path: (s) => ({ x: cx, y: cy }) });
    /* 一团乱点没有标签就没有意义 —— 看的人只会觉得"画面脏了"。
       标签挂在下方 46px，和乱团的抖动区域分开，不会跟着一起抖。 */
    const layer = { spec, anchor: { x: cx, y: cy } };
    if (spec.label && !layer.text) {
      layer.text = new ParticleText({
        field: this.field, alloc: this.alloc, x: cx, y: cy + 46, size: 16, max: 7,
        color: COL.warn, align: 'center', font: FONT, label: `tb-${spec.id}`,
      });
      layer.text.set(fit(spec.label, 8));
    }
    /* 点这团乱点 = "这是怎么回事" —— 最自然的下钻入口 */
    layer.hot = { type: 'circle', cx, cy, r: 74, gestures: ['tap'] };
    this.layers.set(spec.id, layer);
    return base;
  }

  /** focus 的细节读数（挂在锚点下方） */
  _detail(layer, a) {
    const f = this.field;
    const p = layer.anchor || { x: a.x + a.w / 2, y: a.y + 200 };
    const s = layer.spec;
    const live = s.kind === 'stream' && s.progress != null;
    const txt = live
      ? `${Math.round(s.progress * 100)}%${s.rate ? ` · ${s.rate}` : ''}`
      : (s.detail || '');
    /* 没东西可写就别占槽位：一行 16 字的预算够写三个仪表盘的标签 */
    if (!txt && !layer.detailText) return;
    if (!layer.detailText) {
      layer.detailText = new ParticleText({
        field: f, alloc: this.alloc, x: p.x, y: p.y + 40, size: 17, max: 14,
        color: COL.ink, align: 'center', font: FONT, label: `d-${s.id}`,
      });
    }
    layer.detailText.set(txt);
  }

  /** 命中测试：给指针用。返回最近的 layer id（半径 90 内）。 */
  /**
   * 命中测试：元素自己声明 `hot`（可交互区域 + 它接受哪些手势）。
   *
   * 不能靠"离锚点多远"来判 —— 折线的锚点在标题处，曲线上根本点不到；
   * 而分叉的两个分支共用一个锚点，就永远分不出用户点了哪边。
   * 所以每个编码器在布局时就写下自己的可交互范围，这是唯一可靠的做法。
   *
   * @returns {{id:string, layer:object, hot:object, option?:string}|null}
   */
  hit(x, y) {
    let best = null;
    let bestScore = Infinity;
    for (const [id, l] of this.layers) {
      for (const h of (l.hots || (l.hot ? [l.hot] : []))) {
        const score = hotDist(h, x, y);
        if (score == null || score >= bestScore) continue;
        bestScore = score;
        best = { id, layer: l, hot: h, option: h.option };
      }
    }
    return best;
  }

  /** 这个位置上有没有可交互的东西（给光标样式用） */
  at(x, y) {
    return this.hit(x, y);
  }

  /**
   * 折线的观察窗口平移。**本地执行，不经过模型。**
   *
   * 这是整个手势体系里唯一被允许"直接生效"的一种，理由是它改的是**看哪一段**
   * 而不是**事实是什么**。把 3 天前的数据拖到眼前，不改变任何真实状态，
   * 也不需要谁批准 —— 但"把内存降到 40%"是另一回事（那要模型确认）。
   *
   * @param {string} id
   * @param {number} dx 归一化位移：负 = 往回看（更早），正 = 往后
   * @returns {{win:number[], atEdge:string|null, moved:boolean}|null}
   */
  pan(id, dx) {
    const layer = this.layers.get(id);
    if (!layer || layer.spec?.kind !== 'trace') return null;
    const w = layer.win;
    const span = w[1] - w[0];
    let shift = dx * span;
    let atEdge = null;
    if (w[0] + shift < 0) { shift = -w[0]; atEdge = 'earlier'; }
    if (w[1] + shift > 1) { shift = 1 - w[1]; atEdge = 'later'; }
    const moved = Math.abs(shift) > 1e-4;
    layer.win = [w[0] + shift, w[1] + shift];
    this._tracePoints(layer);
    this._refreshTraceText(layer);
    return { win: layer.win.slice(), atEdge, moved };
  }

  /** 窗口复位。换数据、或用户双击时用。 */
  resetWin(id, win) {
    const layer = this.layers.get(id);
    if (!layer) return null;
    layer.win = win ? win.slice(0, 2) : [0, 1];
    this._tracePoints(layer);
    this._refreshTraceText(layer);
    return layer.win.slice();
  }

  /**
   * 把一层的文字淡下去（或恢复）。
   *
   * 用在哪：折线被平移之后，原来那条"周四 21:00 有一次尖峰"就**不再成立**了 ——
   * 屏幕上已经没有周四了。这时候不能本地改写结论（那是模型的话），
   * 也不该直接删掉（人会觉得刚才那条结论凭空消失）。
   * 正确处理是**把它淡成"这属于上一段视角"**，等模型给出新的结论再替换。
   */
  ghost(id, on = true) {
    const layer = this.layers.get(id);
    const txt = layer?.text || layer?.detailText || layer?.num;
    if (!txt || !layer.spec) return false;
    const s = layer.spec.text || layer.spec.detail || '';
    txt.set(s, { scl: on ? 0.3 : 1, force: true });
    layer.ghosted = on;
    return true;
  }

  /**
   * 折线的两处文字：标题 + 窗口末端的读数。
   *
   * 平移之后必须重算，否则标题还写着"7 天"、其实只看了 3 天 —— 那是**界面在说谎**，
   * 比手势没反应严重得多。
   */
  _refreshTraceText(layer) {
    const spec = layer.spec || {};
    const data = spec.data || [];
    const w = layer.win || [0, 1];
    const older = w[1] < 0.999;
    layer.label?.set(fit(`${spec.label || ''}${older ? ' ←' : ''}`, 14));
    const idx = Math.min(data.length - 1, Math.round(w[1] * (data.length - 1)));
    const now = data[idx] ?? 0;
    layer.now?.set(`${Math.round(now * 100)}%`);

    /* 峰值只在窗口里找。拖到某一段时，标的是**那一段**的最高点 ——
       否则用户看着一段平的曲线，旁边却写着别处的峰。 */
    if (!layer.peak) return;
    const M = data.length;
    if (M < 4 || !layer.xs) { layer.peak.set(''); return; }
    const i0 = Math.max(0, Math.floor(w[0] * (M - 1)));
    const i1 = Math.min(M - 1, Math.ceil(w[1] * (M - 1)));
    let mi = i0;
    for (let i = i0; i <= i1; i++) if (data[i] > data[mi]) mi = i;
    const peak = data[mi];
    /* 峰不高于当下 8% 就不标：那时"现在"本身已经是最高，标了只是重复。 */
    if (peak < now + 0.08) { layer.peak.set(''); return; }
    const s = w[1] > w[0] ? (mi / (M - 1) - w[0]) / (w[1] - w[0]) : 0;
    const k = Math.max(0, Math.min(layer.N - 1, Math.round(s * (layer.N - 1))));
    layer.peak.x = layer.xs[k];
    layer.peak.y = Math.max(layer.box.yTop + 2, layer.ys[k] - 20);
    /* "峰" 而不是 "↑"：点阵字里的箭头只有三个点，16px 下读起来像 "1"，
       于是 "↑68%" 被看成 "168%"。中文在这里反而更清楚。 */
    layer.peak.set(`峰${Math.round(peak * 100)}%`, { force: true });
  }
}

export { COL };
