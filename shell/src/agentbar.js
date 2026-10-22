/**
 * agent 状态条 —— 左上角那一行，也从粒子里长出来。
 *
 * 用户的原话：「你能不能顺便把左上角的状态也改成粒子的」。
 *
 * 它原来是一行 DOM（11px 的灰蓝小字）。改成粒子的前提是**字要能读**：
 * 清不清只看"笔画 ÷ 点距"，与字号无关（这笔账见 pui.js 的 glyphBudget）。
 * 所以这里走可读密度（`glyphBudget(size, true)`），13px → 58 颗/字。
 *
 * 但 13px 的汉字是这套点阵的下限：`cell` 约 1.7px，而汉字笔画只有 0.9px ——
 * 比值 0.53，落在"勉强"那档。所以这一行刻意只留**一个**汉字（"条"），
 * 其余全是拉丁和数字：`Qwen2.5-7B`、`12.4k/32.8k`、`16 条`。
 * 汉字更多的方案（"上下文 12.4k"）实测糊成一片 —— 不是字号问题，是笔画问题。
 *
 * 三样东西各用各的语汇：
 *   · 连接状态 = **一个会呼吸的点**（青=通 / 琥珀=在想 / 红=断），不用文字；
 *   · 上下文 = **一条点阵水位线**（左亮右暗，头上有三颗更亮的点），比数字更像"水位"；
 *   · 记忆 = 一个数字 + "条"。
 *
 * DOM 那一层没有删：它变成**透明的可悬停区域**，tooltip（系统/工具/历史、
 * 本轮、今日花费）还挂在上面 —— 那些细账不适合常驻，但排查时要看。
 */

import { ParticleText, glyphBudget } from './pui.js';
import { FONT_LAT } from './draw.js';

const SIZE = 13;

/** 水位线的点数与长度（px）。60 颗 / 120px → 点距 2.03，正好是"线"，不是"虚线" */
const WATER_N = 48;
const WATER_W = 96;

/** 连接点的点数与半径 */
const DOT_N = 14;
const DOT_R = 1.8;

function hexRgb(hex) {
  const h = String(hex).replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

const COL = {
  ink: '#adc9e2',
  dim: '#8aa9c6',
  water: '#5fc9a8',
  hot: '#ffb257',
  on: '#7fd3b0',
  busy: '#ffcf6b',
  off: '#ff7c93',
};

export function createAgentBar({ field, alloc, slots = 2200 }) {
  const start = alloc.alloc(slots, 'status');
  /* 前 128 个槽位留给连接点（12）和水位线（两段各 48），字块从 +128 往后排 */
  const sub = {
    next: start + 128,
    total: start + slots,
    alloc(n) { const b = this.next; this.next += n; return b; },
    get used() { return this.next; },
  };

  let g = { x: 0, y: 38 };
  let link = 'off';
  let pct = 0;
  let warn = false;
  let t = 0;
  let dirty = true;

  const mk = (max, label, color) => new ParticleText({
    field, alloc: sub, x: g.x, y: g.y, size: SIZE, max, color, align: 'left',
    font: FONT_LAT, weight: 300,
    budget: glyphBudget(SIZE, true),
    /* 和 pui 那条公式同源：1.0 + size × 0.05（13px → 1.65）。
       状态条比正文暗一档，点径也小一点 —— 它是背景信息，不该和回答抢注意力。 */
    dot: 1.0 + SIZE * 0.05,
    label,
  });

  const tModel = mk(18, 'st-model', COL.ink);
  const tCtx = mk(13, 'st-ctx', COL.dim);
  const tMem = mk(4, 'st-mem', COL.dim);

  let model = '';
  let ctxText = '';
  let memText = '';

  /* 水位线的位置跟着模型名的长度走：模型名短（qwen 而不是 Qwen2.5-7B-Instruct）时
     整条往左收一截，右边空出来的地方看得见 —— 固定列宽会白留一大块。 */
  let wx = 0;

  function ctxW() {
    return Math.max(88, Math.min(140, ctxText.length * SIZE * 0.62 + 24));
  }

  function relayout() {
    tModel.x = g.x + 20;
    tModel.y = g.y;
    tCtx.x = wx + WATER_W + 12;
    tCtx.y = g.y;
    tMem.x = tCtx.x + Math.round(ctxW());
    tMem.y = g.y;
    dirty = true;
  }

  /* force 是必须的：ParticleText 有逐字缓存（ch/x/y 没变就不重写），
     而**换屏会清空整块绘制区**（scene.set 里的 slotBegin）——
     缓存还以为"这些字已经写过了"，屏幕上就是一片空白。
     实测：场景一铺，状态条的字整行消失，只剩连接点和水位线
     （那两个是每帧重写的，所以还在）。 */
  function paint() {
    tModel.set(model, { instant: true, force: true });
    tCtx.set(ctxText, { instant: true, force: true });
    tMem.set(memText, { instant: true, force: true });
    dirty = false;
  }

  /* ── 这两层每帧写：它们不是文字，是"活的" ── */

  const dotPts = Array.from({ length: DOT_N }, (_, i) => {
    const a = (i / DOT_N) * Math.PI * 2;
    return { x: Math.cos(a) * DOT_R, y: Math.sin(a) * DOT_R };
  });

  function drawDot() {
    /* 呼吸：0.55~1.0。断线时不呼吸（0.45 定住）—— 不动本身就是"它不在了" */
    const k = link === 'off' ? 0.45 : 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.6));
    const c = hexRgb(COL[link] || COL.off);
    const pts = dotPts.map((p) => ({ x: g.x + 6 + p.x, y: g.y + p.y, ink: k }));
    field.slotPut(start, pts, c, 1);
  }

  function drawWater() {
    const lit = Math.round((WATER_N * Math.max(0, Math.min(100, pct))) / 100);
    const c = hexRgb(warn ? COL.hot : COL.water);
    /* 已用 / 未用**分两批写**：slotPut 的亮度是整批一个 scl，
       同一批里只能靠 ink 区分，而 ink 的映射是 0.55+0.45×ink ——
       就算 ink=0 也还有 0.55 的亮度，"未用"那段会亮成一条完整的线，
       看起来像水位是满的（实测就是这个观感）。
       两批各自固定 48 个槽位，写不满的部分用 scl=0 清掉，
       否则上一次的水位会留在原地，读数一变就叠出两层。 */
    const on = [];
    const off = [];
    for (let i = 0; i < WATER_N; i++) {
      const p = { x: wx + (i * WATER_W) / (WATER_N - 1), y: g.y, ink: 1 };
      (i < lit ? on : off).push(p);
    }
    const blank = (n) => Array.from({ length: n }, (_, k) => ({ x: wx + (k * WATER_W) / (WATER_N - 1), y: g.y, ink: 0 }));

    field.slotPut(start + 16, on, c, 1);
    if (on.length < WATER_N) field.slotPut(start + 16 + on.length, blank(WATER_N - on.length), c, 0);
    field.slotPut(start + 16 + WATER_N, off, c, 0.4);
    if (off.length < WATER_N) {
      field.slotPut(start + 16 + WATER_N + off.length, blank(WATER_N - off.length), c, 0);
    }
  }

  /* ── 帧循环不在这里 ──
   * agent 有自己的 rAF（deskagent 的 tick）。同一个屏幕上开两条 rAF，
   * "谁先跑"就变成运气：状态条先写、场景后清，那一下字会闪。
   * 所以这里只暴露 step，由那一处统一驱动。 */
  function step(dt) {
    t += dt;
    if (dirty) paint();
    drawDot();
    drawWater();
  }

  return {
    start() { paint(); },
    stop() {},

    /** @param {{x:number, y:number}} nav */
    layout(nav) {
      g = { x: Math.round(nav.x), y: Math.round(nav.y) };
      if (!wx) wx = g.x + 168;
      relayout();
      paint();
    },

    setModel(name) {
      const v = String(name || '').replace(/^.*\//, '');   // 去掉 org 前缀
      if (v === model) return;
      /* 超过 18 个字符就截断并留一个省略号：`Qwen2.5-7B-Instruc` 看着像模型名打错了，
         而 `Qwen2.5-7B-Inst…` 一眼就知道是被截的。 */
      model = v.length > 18 ? `${v.slice(0, 17)}…` : v;
      /* 拉丁字宽约 0.62 字号：18 字 ≈ 145px，再留 36 的空 */
      wx = g.x + Math.max(140, Math.min(240, model.length * SIZE * 0.62 + 36));
      relayout();
      paint();
    },

    /** @param {{text?:string, pct?:number}} c */
    setCtx(c) {
      pct = Math.max(0, Math.min(100, c.pct ?? 0));
      warn = pct >= 75;
      const s = String(c.text || '');
      if (s !== ctxText) {
        ctxText = s;
        relayout();
      }
    },

    setMem(s) {
      const v = String(s || '');
      if (v !== memText) {
        memText = v;
        relayout();
      }
    },

    /** 换屏之后把字重新写一遍（ParticleText 的缓存挡不住 slotBegin 的清零） */
    repaint() { paint(); },

    setLink(kind) {
      if (kind !== link) link = kind;
    },

    /** 每帧：连接点呼吸 + 水位线。字不重写（ParticleText 自己缓存） */
    step,

    dispose() {
      this.stop();
      tModel.set('', { force: true });
      tCtx.set('', { force: true });
      tMem.set('', { force: true });
    },

    get used() { return sub.next - start; },
  };
}
