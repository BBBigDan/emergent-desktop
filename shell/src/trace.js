/**
 * 「思考过程」那一栏 —— 粒子框里面那块 HTML。
 *
 * 为什么是 HTML：这一栏要的是**一眼扫过去的几十个字**。点阵里 12px 汉字必然
 * 糊成一团（§2.1 的结论），而它跟答案不一样 —— 答案值得放大到 20px 慢慢长，
 * 经过不值得。所以它在**粒子画的框里面**，用宿主自己的字排：框是粒子的，
 * 字是清楚的。这就是"打开一个新的 app 窗口"那件事的缩小版。
 *
 * 三条约束：
 *   · **它自己不吃手势**。面板盖住的地方不产生任何意图（deskagent 的 pick
 *     会把它交出去），否则在面板上拖一下会把背后的仪表拖走。
 *   · **数据只活一轮**。换题就清空 —— 它回答的是"刚才那一下它在干什么"，
 *     不是"历史上都干过什么"（那是 ↑ 记录）。
 *   · **输出要快**。经过是用来对照"它到底卡在哪儿"的，逐字慢慢长会把
 *     十行内容拖成十秒 —— 打字速度按 14ms/字，而且新行一来就把上一行补完。
 */

const MARK = {
  step: '调',
  think: '想',
  scene: '画',
  gate: '挡',
  mem: '记',
  say: '答',
  note: '·',
};

/** 每行右侧的结局符号。文字是给"为什么"的，符号是给"成没成"的 */
const DONE = {
  ok: '✓',
  err: '✕',
  denied: '拒',
  timeout: '…',
  note: '·',
};

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/**
 * @param {{onClose?:()=>void, onToggle?:(open:boolean)=>void}} [o]
 */
export function createTrace(o = {}) {
  const root = el('div', 'ag-trace');
  root.hidden = true;

  const hd = el('div', 'ag-trace-hd');
  const pulse = el('i', 'ag-trace-pulse');
  const title = el('b', 'ag-trace-title', '思考过程');
  const meta = el('em', 'ag-trace-meta');
  const x = el('button', 'ag-trace-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '收起思考过程');
  hd.append(pulse, title, meta, x);

  const list = el('div', 'ag-trace-list');
  root.append(hd, list);

  let rect = { x: 0, y: 0, w: 430, h: 236 };
  let open = false;
  let startedAt = 0;
  let steps = 0;
  let timer = 0;
  let thinking = 0;
  let doneAt = 0;
  /* 行句柄：id → { row, text, detail }。id 来自服务端（工具调用 id），
     有了它"结局补到同一行"才不用猜是哪一行。 */
  const rows = new Map();
  /* 正在打字的那一行：新行一到就把它补完（否则十行会排成一条长队） */
  let typing = null;

  /* 取整再排版：performance.now() 的差会带出 806.7000000001 这种尾巴，
     面板头上一行小字最忌讳这个 —— 它看起来像没算完。 */
  const fmt = (ms0) => {
    const ms = Math.max(0, Math.round(ms0));
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  };

  function paintMeta() {
    const t = startedAt ? (doneAt || performance.now()) - startedAt : 0;
    const bits = [];
    if (steps) bits.push(`${steps} 步`);
    if (t > 300) bits.push(fmt(t));
    meta.textContent = bits.join(' · ');
  }

  function bottom() {
    /* 用户往上翻过就别抢他的位置 —— 他正在读，新行不该把内容顶走 */
    return list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  }

  function stick() {
    if (bottom()) list.scrollTop = list.scrollHeight;
  }

  /** 快速打字：14ms/字，长行封顶 420ms。上一行没打完就直接补完。 */
  function typeInto(span, text) {
    if (typing) typing.finish();
    const ch = Array.from(text);
    if (!open || ch.length <= 2) { span.textContent = text; return; }
    const per = Math.max(6, Math.min(14, 420 / ch.length));
    let i = 0;
    let h = 0;
    const state = {
      /* 被下一行打断时：直接显示全文，不留半句 */
      finish() {
        clearTimeout(h);
        span.textContent = text;
        if (typing === state) typing = null;
      },
    };
    typing = state;
    const tick = () => {
      i += 1;
      span.textContent = ch.slice(0, i).join('');
      stick();
      if (i >= ch.length) { if (typing === state) typing = null; return; }
      h = setTimeout(tick, per);
    };
    h = setTimeout(tick, per);
  }

  function makeRow(kind, textText, detailText, tone) {
    const row = el('div', 'tr');
    row.dataset.k = tone || kind;
    const m = el('i', 'tr-m', MARK[thinkKind(kind)] || MARK.note);
    const t = el('span', 'tr-t');
    const d = el('em', 'tr-d');
    const s = el('i', 'tr-s');
    row.append(m, t, d, s);
    typeInto(t, textText);
    if (detailText) d.textContent = detailText;
    /* 插入动画：从左边 4px 处滑进来，120ms。**只动一次**，
       反复动的话十行会一直晃 —— 那是"输出中"，不是"在抖"。 */
    row.classList.add('new');
    requestAnimationFrame(() => row.classList.remove('new'));
    list.appendChild(row);
    stick();
    return row;
  }

  function thinkKind(k) {
    return Object.hasOwn(MARK, k) ? k : 'note';
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(paintMeta, 200);
  }

  function stopTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = 0;
  }

  function show() {
    if (open) return;
    open = true;
    root.hidden = false;
    /* 一帧之后再上 in：同一帧里 hidden=false + class=in，transition 不会跑 */
    requestAnimationFrame(() => root.classList.add('in'));
    startedAt = startedAt || performance.now();
    doneAt = 0;
    startTimer();
    paintMeta();
    list.scrollTop = list.scrollHeight;
    o.onToggle?.(true);
  }

  function hide() {
    if (!open) return;
    open = false;
    root.classList.remove('in');
    stopTimer();
    doneAt = performance.now();
    paintMeta();
    setTimeout(() => { if (!open) root.hidden = true; }, 200);
    o.onToggle?.(false);
  }

  x.addEventListener('click', (e) => {
    e.stopPropagation();
    hide();
    o.onClose?.();
  });
  /* 面板上的点击不该穿透到场上（`pick` 也会挡一道，这里挡的是 DOM 冒泡：
     × 之外的地方点一下，不该让桌面的手势开始） */
  root.addEventListener('pointerdown', (e) => e.stopPropagation());

  return {
    el: root,
    get open() { return open; },
    get steps() { return steps; },
    get rows() { return rows.size; },

    layout(r) {
      rect = { ...rect, ...r };
      root.style.left = `${rect.x}px`;
      root.style.top = `${rect.y}px`;
      root.style.width = `${rect.w}px`;
      root.style.height = `${rect.h}px`;
    },

    hit(x2, y2) {
      if (!open || root.hidden) return false;
      return x2 >= rect.x && x2 <= rect.x + rect.w && y2 >= rect.y && y2 <= rect.y + rect.h;
    },

    geometry: () => ({ ...rect }),

    open: show,
    close: hide,
    toggle() { (open ? hide : show)(); },
    isOpen: () => open,

    /** 一轮开始：清空、重置计时。面板不在这里开（由 deskagent 决定时机） */
    begin() {
      rows.clear();
      list.textContent = '';
      steps = 0;
      thinking = 0;
      startedAt = performance.now();
      doneAt = 0;
      typing = null;
      root.classList.remove('done');
      paintMeta();
    },

    /** 一轮结束：计时停在这儿，头部换成"共用了几秒" */
    finish() {
      doneAt = performance.now();
      stopTimer();
      paintMeta();
      root.classList.add('done');
      pulse.classList.remove('on');
    },

    step({ id, text, detail, tool }) {
      steps += 1;
      paintMeta();
      const row = makeRow('step', text, detail, tool === 'olares_act' ? 'act' : 'step');
      if (id) rows.set(id, row);
      return row;
    },

    end({ id, status, ms, note }) {
      const row = id ? rows.get(id) : null;
      if (!row) {
        /* 没有对应的 step（比如服务端在审批超时后补一条）就单独冒一行 */
        if (note) makeRow('note', note, status === 'ok' ? '' : '这一下没成');
        return;
      }
      row.dataset.s = status || 'ok';
      row.querySelector('.tr-s').textContent = `${DONE[status] || ''}${ms != null ? ` ${fmt(ms)}` : ''}`;
      if (note) {
        const d = row.querySelector('.tr-d');
        d.textContent = note;
        d.title = note;
      }
    },

    /** 不属于任何 step 的一句话（压缩、空回复、记忆命中、系统代问…） */
    note({ text, detail, tone }) {
      if (!text) return;
      makeRow('note', text, detail, tone || 'note');
    },

    /** 「在想」这件事也要留痕：不然工具之间那几秒的空档看起来像卡住了 */
    think(on, step) {
      if (on) {
        thinking = step ?? 0;
        pulse.classList.add('on');
        const row = makeRow('think', step ? `想第 ${step + 1} 步` : '想一想', '', 'think');
        rows.set(`think:${step}`, row);
      } else {
        pulse.classList.remove('on');
        const row = rows.get(`think:${step}`);
        if (row) {
          row.dataset.s = 'ok';
          /* 这一行不写状态符号：它不是"一件事做完了"，是"这一段在等"。
             右边冒一个孤零零的点，读起来像加载失败。 */
          row.querySelector('.tr-s').textContent = '';
        }
      }
    },

    /** 场景落地也记一行：用户看到"画了一屏"，就知道右边的图是谁放的 */
    scene(op, layers) {
      if (!layers?.length) return;
      const names = layers.slice(0, 3).map((l) => l.label || l.kind).filter(Boolean).join(' · ');
      makeRow('scene', op === 'set' ? '铺了一屏' : op === 'patch' ? '改了场上的东西' : '换了一屏', names, 'scene');
    },

    /** 它开口了：那一栏收起来之前的最后一件事 —— 记下来，别像被删掉了 */
    said(len) {
      makeRow('say', '开始回答', len ? `${len} 字` : '', 'say');
    },
  };
}
