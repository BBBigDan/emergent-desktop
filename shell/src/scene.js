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

export class FieldScene {
  /**
   * @param {object} o
   * @param {import('./field.js').Field} o.field
   * @param {{x:number,y:number,w:number,h:number}} o.area
   */
  constructor(o) {
    this.field = o.field;
    this.area = o.area;
    this.alloc = new SlotAllocator(6400);
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
    this.alloc = new SlotAllocator(6400);
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
      outMs: Math.max(80, (opt.outMs ?? 380) * from),
      inMs: opt.inMs ?? 760,
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
        if (layer.detail) this._detail(layer.spec, this.area, layer);
      }
      if (op.value != null && layer.spec.kind === 'gauge') {
        layer.spec.value = clamp(op.value, 0, 1);
        this._gauge(layer.spec, layer.i, layer.n, this.area, layer);
        if (layer.detail) this._detail(layer.spec, this.area, layer);
      }
      if (op.data != null && layer.spec.kind === 'trace') {
        /* 换一批数据 = 每条曲线的目标高度变了。**不重画**，只改目标：
           弹簧自己会把整条曲线滑过去（DOM 里要逐点 FLIP 才做得到）。 */
        layer.spec.data = op.data;
        this._tracePoints(layer);
        if (layer.now) layer.now.set(`${Math.round((op.data[op.data.length - 1] ?? 0) * 100)}%`);
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
        field: f, alloc: this.alloc, x: cx, y: cy + 32, size: 15, max: 4,
        color: COL.dim, align: 'center', font: FONT, label: `gc-${spec.id}`,
      });
    }
    layer.num.set(`${Math.round(v * 100)}%`);
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
    const x0 = a.x + 70;
    const x1 = a.x + a.w - 70;
    const yTop = a.y + 244;
    const yBase = a.y + 408;

    const layer = this.layers.get(spec.id) || {};
    layer.spec = spec;
    layer.N = N;
    layer.box = { x0, x1, yTop, yBase };
    layer.anchor = { x: (x0 + x1) / 2, y: yTop - 34 };
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
        field: f, alloc: this.alloc, x: x0, y: yTop - 30, size: 17, max: 12,
        color: '#93b8d8', font: FONT, label: `tr-${spec.id}`,
      });
      layer.now = new ParticleText({
        field: f, alloc: this.alloc, x: x1, y: yTop - 30, size: 20, max: 6,
        color: COL.ink, align: 'right', font: FONT_LAT, label: `trn-${spec.id}`,
      });
    }
    layer.label.set(spec.label || '');
    const d = spec.data || [];
    layer.now.set(`${Math.round((d[d.length - 1] ?? 0) * 100)}%`);
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
      hi = Math.max(0.3, Math.ceil(Math.max(...data) * 12) / 10);
    }
    if (hi - lo < 1e-3) hi = lo + 1;
    if (!layer.xs) {
      layer.xs = new Float32Array(N);
      layer.ys = new Float32Array(N);
    }
    const pts = [];
    for (let k = 0; k < N; k++) {
      const s = k / (N - 1);
      let v = 0.5;
      if (M === 1) v = data[0];
      else if (M > 1) {
        const p = s * (M - 1);
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
    this.layers.set(spec.id, layer);

    const f = this.field;
    const title = new ParticleText({
      field: f, alloc: this.alloc, x: cx, y: cy - 30, size: 18, max: 10,
      color: '#93b8d8', align: 'center', font: FONT, label: `f-${spec.id}`,
    });
    title.set(spec.label || '');
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
      txt.set(o.label || '');
      layer.branches.push({ option: o, base, idx, path, text: txt, side: dir });
    });
    return layer;
  }

  /** 纯粹的一行读数（凝聚成字） */
  _condense(spec, i, a) {
    const f = this.field;
    const t = new ParticleText({
      field: f, alloc: this.alloc, x: a.x + a.w / 2, y: a.y + 588 + i * 26, size: 17, max: 20,
      color: COL.dim, align: 'center', font: FONT, label: `c-${spec.id}`,
    });
    t.set(spec.text || '');
    this.texts.push(t);
    this.layers.set(spec.id, { spec, anchor: { x: a.x + a.w / 2, y: a.y + 560 }, text: t });
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
    this.layers.set(spec.id, { spec, anchor: { x: cx, y: cy } });
    return base;
  }

  /** focus 的细节读数（挂在锚点下方） */
  _detail(layer, a) {
    const f = this.field;
    const p = layer.anchor || { x: a.x + a.w / 2, y: a.y + 200 };
    const s = layer.spec;
    const txt = s.detail || (s.kind === 'stream'
      ? `${Math.round((s.progress ?? 0) * 100)}% · ${s.rate || ''}`
      : '');
    /* 没东西可写就别占槽位：一行 16 字的预算够写三个仪表盘的标签 */
    if (!txt && !layer.detailText) return;
    if (!layer.detailText) {
      layer.detailText = new ParticleText({
        field: f, alloc: this.alloc, x: p.x, y: p.y + 40, size: 17, max: 16,
        color: COL.ink, align: 'center', font: FONT, label: `d-${s.id}`,
      });
    }
    layer.detailText.set(txt);
  }

  /** 命中测试：给指针用。返回最近的 layer id（半径 90 内）。 */
  hit(x, y) {
    let best = null;
    let bestD = 90 * 90;
    for (const [id, l] of this.layers) {
      if (!l.anchor) continue;
      const dx = x - l.anchor.x;
      const dy = y - l.anchor.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }
}

export { COL };
