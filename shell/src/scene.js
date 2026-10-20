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
 *   trace      历史 → 尾迹（未实现）
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
    this.t = 0;
    this.rev = 0;
  }

  /** 布局：整场重建。幂等，可以反复调用。 */
  set(spec) {
    const f = this.field;
    const a = this.area;
    this.alloc = new SlotAllocator(6400);
    this.layers.clear();
    this.texts.length = 0;
    this.flows.length = 0;
    this.rev = spec.rev ?? this.rev + 1;

    /* 全局相干度基调：calm 静一点，alert 抖一点。抖动在后面逐帧加，
       这里先记住幅度（0 = 完全不抖）。 */
    this.jitter = spec.mood === 'alert' ? 1.1 : spec.mood === 'working' ? 0.55 : 0.3;

    f.slotBegin({ dim: 0.97, dot: 0.95 });

    const list = (spec.layers || []).filter((x) => x && x.kind);
    /* 只有 focus 那一个进 L2（凝聚成字），其余只给形状 —— 这是注意力分层，
       不是省事：同时展开三个细节，场就变成了低分辨率的表格。 */
    const focus = spec.focus || list[0]?.id;

    const gauges = list.filter((l) => l.kind === 'gauge');
    gauges.forEach((l, i) => this._gauge(l, i, gauges.length, a));

    list.filter((l) => l.kind === 'stream').forEach((l, i) => this._stream(l, i, a));

    const forks = list.filter((l) => l.kind === 'fork');
    forks.forEach((l) => this._fork(l, a));

    list.filter((l) => l.kind === 'condense').forEach((l, i) => this._condense(l, i, a));

    list.filter((l) => l.kind === 'turbulence').forEach((l) => this._turbulence(l, a));

    /* focus 的细节：任何 kind 都可以有一个 valueText，挂在它的锚点上 */
    const fl = list.find((l) => l.id === focus);
    if (fl) this._detail(this.layers.get(fl.id) || { spec: fl, anchor: null }, a);

    this.spec = spec;
    this.focus = focus;
    return this;
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
    }
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
    return this;
  }

  /** 每帧：让"流"真的在流。这是 DOM 给不了的部分。 */
  step(dt) {
    this.t += dt;
    const f = this.field;
    const t = this.t;
    for (const fl of this.flows) {
      const { idx, s0, s1, speed, path, jitter } = fl;
      for (let k = 0; k < idx.length; k++) {
        /* s 在 [s0,1] 之间循环：进度之前的段是沉积的（不参与），
           之后的段以 speed 流过，视觉上就是"还没到的地方在流"。 */
        const span = 1 - s0;
        if (span <= 0.001) continue;
        let s = s0 + (((k / idx.length) * span + t * speed) % span);
        const p = path(s);
        const w = jitter * Math.sin(t * 3.1 + k * 2.7) * 4;
        const i = idx[k];
        f.drawX[i] = p.x + w - f.W * 0.5;
        f.drawY[i] = f.H * 0.5 - (p.y + Math.cos(t * 2.3 + k) * w);
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
    if (!layer.detailText) {
      layer.detailText = new ParticleText({
        field: f, alloc: this.alloc, x: p.x, y: p.y + 40, size: 17, max: 16,
        color: COL.ink, align: 'center', font: FONT, label: `d-${layer.spec.id}`,
      });
    }
    const s = layer.spec;
    const txt = s.detail || (s.kind === 'stream'
      ? `${Math.round((s.progress ?? 0) * 100)}% · ${s.rate || ''}`
      : '');
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
