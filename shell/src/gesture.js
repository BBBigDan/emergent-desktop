/**
 * 手势 → 意图。
 *
 * 这是把"鼠标被粒子吸引"升级成"鼠标在表达意思"的那一层。核心分界线：
 *
 *   **手势从不执行动作，只产生意图。**
 *
 * 拖内存往下，不代表"把内存清掉"，而代表"我想让内存低一点"。中间那一步
 * （要不要做、能不能做、怎么做）必须由模型接住 —— 于是它天然会反问、
 * 会解释代价、会给出两个选项。这条分界线同时是三件事：
 *   - 安全：拖拽永远不能直接等于一次破坏性操作
 *   - 语义：模型有上下文（现在 60%、下面是 n8n 占的），它才知道拖到 42% 可行不可行
 *   - 观感：反转确认（模型反问）比"拖了就变"更像在和一个懂你的东西打交道
 *
 * 三种手势，靠**方向和施力对象**区分（同一个 layer 声明的 `gestures` 决定候选）：
 *
 *   纵向拖（拖离/拖向锚点）  → adjust  我想把这个量改成 X
 *   横向拖（沿时间轴）        → pan/seek 我想看别的时段 / 我想跳到这个位置
 *   几乎不动就松手            → tap/pick 我想看这个 / 我选这个
 *
 * 锚点在自己身上，所以"哪个方向"不需要额外 UI —— 拖离 = 改值，拖过 = 改窗口。
 */

import { GESTURE } from './timing.js';

const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

/**
 * @typedef {object} Intent
 * @property {'tap'|'pick'|'adjust'|'seek'|'pan'} kind
 * @property {string} target      layer id
 * @property {object} [at]        发生位置（场坐标）
 * @property {number} [from]      手势开始时的值
 * @property {number} [to]        手势结束时的值（已折算成 0..1）
 * @property {number} [delta]     to - from
 * @property {string} [option]    pick 的选项 id
 * @property {string} [dir]       pan 的方向：earlier / later
 * @property {boolean} [flick]    是否带甩动（松手速度超过阈值）
 */

export class GestureTracker {
  /**
   * @param {object} o
   * @param {(x:number,y:number)=>{id:string,layer:object,option?:string}|null} o.pick
   * @param {(i:Intent)=>void} o.onIntent      松手后给出最终意图
   * @param {(s:object)=>void} [o.onStart]     按下并确认命中（用于建立势阱）
   * @param {(s:object)=>void} [o.onMove]      拖动中每帧（用于让井跟着走）
   * @param {(s:object)=>void} [o.onEnd]       松手（无论是否产生意图）
   * @param {()=>number} [o.now]
   */
  constructor(o) {
    this.pick = o.pick;
    this.onIntent = o.onIntent;
    this.onStart = o.onStart || (() => {});
    this.onMove = o.onMove || (() => {});
    this.onEnd = o.onEnd || (() => {});
    this.now = o.now || (() => performance.now());
    this.g = null;
  }

  attach(target = window) {
    target.addEventListener('pointerdown', (e) => this.down(e.clientX, e.clientY, e));
    target.addEventListener('pointermove', (e) => this.move(e.clientX, e.clientY));
    target.addEventListener('pointerup', (e) => this.up(e.clientX, e.clientY));
    target.addEventListener('pointercancel', () => this.cancel());
    return this;
  }

  down(x, y) {
    const hit = this.pick(x, y);
    this.g = {
      x0: x, y0: y, x, y, t0: this.now(),
      hit,
      axis: null,       // 'x' | 'y' | null（还没判定）
      moved: false,
      trailAt: 0,
    };
    if (hit) this.onStart(this._snap());
    return this;
  }

  move(x, y) {
    const g = this.g;
    if (!g) return;
    g.x = x;
    g.y = y;
    const d = dist(g.x0, g.y0, x, y);
    const dt = this.now() - g.t0;

    /* 位移够了才算拖动。`minDragMs` 是防"快速点一下时手滑了 12px"——
       这种会被误判成拖拽，于是用户想点按钮却触发了"调整数值"。 */
    if (!g.moved && d >= GESTURE.minDrag && dt >= GESTURE.minDragMs) {
      g.moved = true;
      g.axis = this._axis(g, x, y);
    }
    if (!g.moved) return;

    this.onMove(this._snap());

    /* 拖动过程中周期性给一个极小冲量：场被打散又被弹簧收回，
       连续起来就是"一路拉出一道拖尾"。这是纯观感，不产生任何意图。 */
    if (this.now() - g.trailAt > GESTURE.trailMs) {
      g.trailAt = this.now();
      this.onMove({ ...this._snap(), trail: true });
    }
    return this;
  }

  up(x, y) {
    const g = this.g;
    if (!g) return;
    const dt = Math.max(1, this.now() - g.t0);
    const v = dist(g.x0, g.y0, x, y) / dt * 1000;
    const flick = g.moved && v > GESTURE.flickV;
    /* 快照必须在清空 this.g **之前**算：_snap 读的是 this.g，
       先清空的话 axis 恒为 null，所有拖拽意图都会在下面那个 if 处被吞掉，
       而且不报错 —— 表现就是"拖了有反应、松手什么都没发生"。 */
    const snap = { ...this._snap(x, y), flick, dt };
    this.g = null;
    this.onEnd(snap);

    if (!g.hit) {
      /* 空白处的点击仍然是"一次触碰" —— 让场响一下，但不产生意图 */
      if (!g.moved) this.onIntent({ kind: 'tap', target: null, at: { x, y } });
      return;
    }

    if (!g.moved) {
      /* 抖动够小 → 点击。fork 的某个分支上松手就是一次选择。 */
      const nm = g.hit.layer?.spec?.label || g.hit.id;
      this.onIntent(g.hit.option
        ? { kind: 'pick', target: g.hit.id, label: nm, option: g.hit.option, optionLabel: g.hit.layer?.branches?.find((b) => b.option.id === g.hit.option)?.option?.label, at: { x, y } }
        : { kind: 'tap', target: g.hit.id, label: nm, at: { x, y } });
      return;
    }

    const intent = this._dragIntent(g, x, y, snap);
    if (intent) this.onIntent(intent);
  }

  cancel() {
    if (this.g) this.onEnd(this._snap());
    this.g = null;
  }

  /* ───────────────── 内部 ───────────────── */

  _snap(x, y) {
    const g = this.g;
    const px = x ?? g?.x ?? 0;
    const py = y ?? g?.y ?? 0;
    return {
      id: g?.hit?.id ?? null,
      layer: g?.hit?.layer ?? null,
      hot: g?.hit?.hot ?? null,
      x: px, y: py,
      dx: g ? px - g.x0 : 0,
      dy: g ? py - g.y0 : 0,
      axis: g?.axis ?? null,
      moved: !!g?.moved,
    };
  }

  /**
   * 判定主轴。这一条决定后面所有语义：纵向 = 改值，横向 = 改窗口。
   * 1.35 的不对称系数是故意的 —— 斜着拖的时候人心里想的通常是纵向
   * （"把它拉下来"），横向要多明显才算数。
   */
  _axis(g, x, y) {
    const dx = Math.abs(x - g.x0);
    const dy = Math.abs(y - g.y0);
    return dx > dy * 1.35 ? 'x' : 'y';
  }

  _dragIntent(g, x, y, snap) {
    const { layer, hot, id } = g.hit;
    if (!hot) return null;
    const can = hot.gestures || [];

    const name = layer.spec?.label || id;

    if (snap.axis === 'x' && (can.includes('pan') || can.includes('seek'))) {
      const span = Math.max(40, (hot.x1 ?? hot.cx + 300) - (hot.x0 ?? hot.cx - 300));
      const frac = (x - g.x0) / span;          // 正 = 往右拖
      if (can.includes('seek')) {
        const from = layer.spec?.progress ?? 0;
        /* 拖动方向和进度方向一致：往右拖 = 往后走 */
        const to = Math.min(1, Math.max(0, from + frac));
        return { kind: 'seek', target: id, label: name, from, to, delta: to - from, at: { x, y }, flick: snap.flick };
      }
      return {
        kind: 'pan', target: id, label: name,
        /* 往右拖 = 把曲线往右推 = 看更早的 */
        dir: frac > 0 ? 'earlier' : 'later',
        dx: -frac,                              // 归一化：负 = 往回看
        at: { x, y }, flick: snap.flick,
      };
    }

    if (can.includes('adjust')) {
      /* 纵向：向上拖 = 增大。140px 走完整个量程，粗调；按住 Shift 精调留给以后。
         两处容易错：① range 只该出现一次（第一版写成 (dy/(range×140))×range，
         等于把量程乘了两遍）；② 分母不能用控件尺寸，用 `adjustSpan`（2~3 倍直径）。 */
      const from = layer.spec?.value ?? layer.spec?.progress ?? 0;
      const range = hot.range || [0, 1];
      const lo = range[0];
      const hi = range[1];
      const to = Math.min(hi, Math.max(lo, from - ((y - g.y0) / GESTURE.adjustSpan) * (hi - lo)));
      /* 位移太小的拖动只是"摸了一下"，别当成意图 */
      if (Math.abs(to - from) < 0.02) return null;
      return { kind: 'adjust', target: id, label: name, from, to, delta: to - from, at: { x, y }, flick: snap.flick };
    }

    return null;
  }
}

/**
 * 把意图翻译成一句人话 —— 给日志、给读屏、也给审计。
 *
 * 这看起来是小事，其实是"手势必须可解释"的兜底：任何一次拖拽都应该能
 * 被复述成一句用户看得懂的话。复述不出来，说明设计错了。
 */
export function describe(i) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  const n = i.label || i.target || '';
  switch (i.kind) {
    case 'adjust': return `把「${n}」从 ${pct(i.from)} 拖到 ${pct(i.to)}`;
    case 'seek': return `把「${n}」跳到 ${pct(i.to)}`;
    case 'pan': return `把「${n}」${i.dir === 'earlier' ? '往回' : '往前'}翻页`;
    case 'pick': return `在「${n}」选了「${i.optionLabel || i.option}」`;
    case 'tap': return i.target ? `点了「${n}」` : '空处一点';
    default: return '手势';
  }
}
