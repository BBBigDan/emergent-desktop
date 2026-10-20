/**
 * 时序：动效该多长，以及两步之间至少空多久。
 *
 * 这个文件有三个身份，刻意合成一份：
 *   1. 代码的常数表（scene.js / demo / agent 前端都读它）
 *   2. 给模型的规范（`brief()` 输出的那段文本直接进系统提示词）
 *   3. 前端强制的节拍器（`Pacer`）
 *
 * 第三点是关键。时序**不能只用提示词约束**：模型（尤其便宜模型）不会数
 * "上一个动作之后过了 400ms"，它看不到时钟。给它规范是为了让它有正确直觉
 * （一次只推进一件事、别把三个 pulse 挤在一起），真正的间隔必须由前端保证 ——
 * 就像几何不能交给模型一样。
 *
 * 数值来自三件事：人眼的感知阈值、场的弹簧落定时间、以及"读一行字要多久"。
 */

/** 单次动效的持续时间（ms）。 */
export const TIMING = {
  /* 触碰反馈。超过 100ms 就会被感知为"卡"，60 是安全值。 */
  tap: 60,

  /*
   * 场的物理下界。弹簧刚度 46 时，一个跨屏位移要 ~1.2s 才落定；
   * 抬到 2.4 倍（相变重组时）约 0.5s。**任何动效都不可能比这更短** ——
   * 想快只能提刚度，不能"把时间轴调短"，因为位置是积分出来的。
   */
  settle: 1200,
  settleStiff: 500,

  /* 势阱建立。悬停要"立刻有反应"，但完全瞬时反而像抖动。 */
  hover: 140,

  /* 数值推进：一格里能看清"变了多少"的最短时间。 */
  tick: 240,

  /* 单元素状态变化：一个仪表换色、一行结论替换。 */
  step: 380,

  /* 新内容登台：文字凝结、新元素入场。短于 700 会像"闪现"，看不出成形过程。 */
  enter: 900,

  /* 换景：溶解 + 重组。两段分开给，因为它们的观感是两件事。 */
  out: 360,
  in: 780,

  /* 空闲的呼吸与扫掠。慢于注意力节律，才不抢戏。 */
  loop: 2600,
};

/**
 * 叙事动作之间的最小间隔（ms）—— 也就是"上一步做完，人需要多久才准备好接受下一步"。
 *
 * 这是 `TIMING` 之外的另一半，也是上一版演示"每步都太短"的根因：
 * 我当时只想着每个动效本身多长，没算**两个动作之间要留多少时间给人**。
 */
export const GAP = {
  /* 数值推进可以连着来，但要留出"看清这一格"的时间 */
  patch: 200,
  /* 一次物理事件之后，要让人先注意到它发生过 */
  pulse: 560,
  /* 一整屏新内容铺开之后，至少给一秒扫一眼 */
  set: 900,
  /* 换景之后要呼吸：人还在确认"刚才那屏没了"，别马上又换 */
  transition: 1100,
  /* 一行结论出现后，留够读完它的时间（按 20 字 / 4 字每秒） */
  condense: 1600,
};

/** 手势判定阈值。 */
export const GESTURE = {
  /** 小于这个位移算点击（手指/鼠标的抖动） */
  minDrag: 9,
  /** 小于这个时长、但位移够大的，算"甩"而不是"拖" */
  minDragMs: 110,
  /** 甩的速度阈值（px/s） */
  flickV: 900,
  /** 拖拽时轮询脉冲的间隔，形成"拉动拖尾" */
  trailMs: 92,
  /**
   * 纵向拖多少像素走完一个量程。
   *
   * 240 ≈ 仪表直径（104）的 2.3 倍。第一版给 140，结果"往下拖一点点就到底"——
   * 因为 140px 也就是仪表直径的 1.3 倍，人手的一个自然下拉就 80px 以上。
   * 粗调判据：**走完整量程的物理距离应该在控件尺寸的 2~3 倍**。
   */
  adjustSpan: 240,
};

const CAP = {
  tap: '一次触碰的反馈。冲量、按下、松手的回弹。',
  hover: '悬停。势阱建立，粒子开始被吸。',
  tick: '数值推进。进度条多沉积几颗、曲线滑到新位置。',
  step: '单元素状态变化。一个仪表从正常变成注意、一个标签替换。',
  enter: '新内容登台。文字在插入符处凝结、新元素入场。',
  swap: '换景。旧的一屏溶解、新的一屏重组。',
  loop: '空闲呼吸、扫掠头来回。不携带新信息，只维持"它是活的"。',
};

/**
 * 给模型看的规范。直接拼进系统提示词即可。
 *
 * 写成"什么时候用哪一档"而不是只给数字：模型需要的不是毫秒，是判断力。
 */
export function brief() {
  return `## 动效时序

你不需要指定时长，前端有固定的节奏。你要做的是**选对档位**，并且**一次只推进一件事**。

| 你要做的事 | 档位 | 时长 | 之后至少停 |
|---|---|---|---|
| 触碰反馈（按钮被按下） | tap | ${TIMING.tap}ms | — |
| 数值推进（进度、指标刷新） | tick | ${TIMING.tick}ms | ${GAP.patch}ms |
| 一个元素换状态（正常→警告） | step | ${TIMING.step}ms | ${GAP.pulse}ms |
| 新内容出现（一行结论、一个新元素） | enter | ${TIMING.enter}ms | ${GAP.set}ms |
| 换一整屏（scene_transition） | swap | ${TIMING.out + TIMING.in}ms | ${GAP.transition}ms |

四条规矩：

1. **一次只推进一件事。** 不要在一条回复里同时发 set 和三个 pulse —— 那不是"信息量大",
   那是"什么都没看清"。用户读完一屏需要约 1 秒,你的下一步不该早于这个时间发生。
2. **数值可以连续推,状态不能。** progress 每 200ms 一次没问题(tick 就是干这个的);
   但 pulse 之间要隔半秒以上,否则两次扰动糊成一次。
3. **换景是承诺。** 一次 scene_transition 之后至少停 1.1 秒,让人确认"刚才那屏没了"。
   连续换景是最容易让人放弃 watching 的行为。
4. **想快只有一条路:提刚度,不是缩时间。** 位置是物理积分出来的,把时长调短只会
   让点"没走到位就被宣布成形"——看起来是毛边,不是快。

${Object.entries(CAP).map(([k, v]) => `- \`${k}\` — ${v}`).join('\n')}`;
}

/**
 * 叙事动作的节拍器。
 *
 * 用法：把"模型发起的叙事动作"交给它，把"用户手势引起的反馈"直接执行。
 * 这个区分很重要 —— 用户的手必须立刻有回响，延迟 300ms 就不是直接操作了；
 * 而模型的动作本来就该按节拍来。
 *
 * ```js
 * pacer.run('transition', () => scene.transition(spec));
 * pacer.run('patch', () => scene.patch(ops));   // 会在上一个动作的间隔结束后执行
 * ```
 */
export class Pacer {
  /**
   * @param {{now?:() => number, speed?: number}} [o] speed 是整体倍率（调试/紧张时用 0.5）
   */
  constructor(o = {}) {
    this.now = o.now || (() => performance.now());
    this.speed = o.speed ?? 1;
    this.lastAt = -Infinity;
    this.lastKind = '';
    this.queue = [];
    this.timer = null;
  }

  /** 距上一次动作还需要等多久（ms，0 表示可以立刻执行）。 */
  wait(kind) {
    if (!this.lastKind) return 0;
    /* 取两者的较大值：既要够这次的 interval，也要够上一次动作的 gap。
       例如刚 transition 完，紧接着的 patch 也要等 transition 的 1100ms ——
       因为那 1100ms 是"让人看清新的一屏"。 */
    const mine = GAP[kind] ?? 200;
    const prev = GAP[this.lastKind] ?? 200;
    const need = Math.max(mine, prev);
    return Math.max(0, this.lastAt + need * this.speed - this.now());
  }

  /** 排进队列。同一个 kind 已经在排队的会合并（只保留最后一个）。 */
  run(kind, fn) {
    const at = this.queue.findIndex((q) => q.kind === kind);
    if (at >= 0) this.queue[at] = { kind, fn };
    else this.queue.push({ kind, fn });
    this._drain();
    return this;
  }

  /** 立即执行并重置节拍（用户手势、暂停恢复时用）。 */
  immediate(kind, fn) {
    this.queue.length = 0;
    fn();
    this.lastAt = this.now();
    this.lastKind = kind;
    return this;
  }

  _drain() {
    if (this.timer || !this.queue.length) return;
    const w = this.wait(this.queue[0].kind);
    if (w > 0) {
      this.timer = setTimeout(() => { this.timer = null; this._drain(); }, w);
      return;
    }
    const { kind, fn } = this.queue.shift();
    fn();
    this.lastAt = this.now();
    this.lastKind = kind;
    /* 队列里还有就继续排下一个 */
    if (this.queue.length) this._drain();
  }
}
