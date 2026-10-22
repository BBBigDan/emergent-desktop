/**
 * 答案块 —— 屏幕上真正要"读"的那几段字。
 *
 * 从"输入框上面一行 19px / 20 字"改过来，现在是一整块版面：
 *   20px、每行 29 字、14 行、**每页 400 字**，左对齐排在左半屏。
 *
 * 为什么是 20px / 400 字：一个汉字要 `glyphBudget(size, true)` ≈ 90 颗才读得出来
 * （这笔账见 pui.js），14 行 × 30 字 × 90 = 37800 是槽位上限，
 * 而一页 400 字实际只占 36000 —— 留出来的那一千多是"每行按上限预留"的浪费。
 * 字号再大不会更省 —— 可读密度下每个字的点数**与字号无关**。
 *
 * 四条要守住的：
 *   1. **按字数分页，不按行分页**。按行切会在句子中间断开。
 *   2. **分页点优先落在句读上**（。！？；换行），宁可这页短一点。
 *   3. **换行只在文本真变了时算一次**，每帧重排会让字在行间跳。
 *   4. **逐字生长保留**：一行行凝出来是这套界面的语法，DOM 里没有对应的东西。
 */

import { ParticleText, glyphBudget } from './pui.js';
import { FONT } from './draw.js';

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const BREAK = '，。、；：!?！？ ';
const PAGE_BREAK = '。！？；\n';

/** 每页字数。400 × 90 颗 = 36000，行预留按 14 行 × 30 字算（见 ensureRows）。
    为什么是 400 而不是 300：一页 300 字时，一段正常长度的回答就要翻三页，
    用户读到第一页就没有下文了 —— 那和"没说完"是同一件事。 */
export const PAGE_CHARS = 400;

/** 字距系数，必须和 ParticleText.spacing 一致（0.06em）—— 量宽比排版窄就会压过中线。 */
const SPACING = 0.06;

/** 粗略字宽：汉字占一个字号，拉丁/数字约 0.56。够换行用，不用真量。 */
function widthOf(ch, size) {
  return (CJK.test(ch) ? size : size * 0.56) + size * SPACING;
}

/** 行首禁则：这些字符**不能出现在行首**（中文排版的硬规矩）。 */
const NO_START = '，。、；：！？）】》」』”,.!?;:)]}%';

/**
 * 按宽度换行，最多 maxLines 行。
 * 断行优先落在句读上（宁可这行短一点，也别把"重启"切成"重/启"）。
 */
export function wrapText(text, { size, maxWidth, maxLines, maxChars = 99 }) {
  const chars = Array.from(String(text ?? ''));
  const lines = [];
  let cur = [];
  let w = 0;
  const flush = () => { if (cur.length) { lines.push(cur.join('').trimEnd()); cur = []; w = 0; } };

  for (const ch of chars) {
    /* 换行就是换行：模型写的段落是内容的一部分。
       以前 \n 被当成普通字符算宽度（约 0.56 字），屏幕上既不断行、
       又白占一格 —— 段落那里就凭空多出一个空位。 */
    if (ch === '\n') { flush(); continue; }
    const cw = widthOf(ch, size);
    if ((w + cw > maxWidth || cur.length >= maxChars) && cur.length) {
      /* 回退找标点：只为"别把词从中间切开"，最多退一个词（3~6 个字符）。
         **窗口不能按行长的百分比开** —— 以前是 `cur.length * 0.6`，29 字的一行
         会一路退到第 20 字那个"、"，一行白丢 9 个字：
         屏幕上 20 字只占 345px，而可用宽度是 636px，每行都短一截，
         一段 66 字的话被排成 4 行（实测 2026-10-22）。
         标点回退和"排满"是两个目标，前者只该有最后几个字符的话语权。 */
      let cut = -1;
      for (let k = cur.length - 1; k >= Math.max(0, cur.length - 6); k--) {
        if (BREAK.includes(cur[k])) { cut = k + 1; break; }
      }
      if (cut > 0) {
        /* rest 要 trimStart：回退点落在一个空格上时，下一行会以空格开头 ——
           左对齐下看起来像"这一行缩进了一格"，而它只是把空格算进了一个字的位置。 */
        const rest = cur.slice(cut);
        while (rest.length && rest[0] === ' ') rest.shift();
        lines.push(cur.slice(0, cut).join('').trimEnd());
        cur = rest;
        w = rest.reduce((a, c) => a + widthOf(c, size), 0);
      } else {
        flush();
      }
    }
    /* 行首不排空格：断行恰好落在词间空格上时，那个空格会成为新行的第一个字符，
       左对齐下看起来像"这一行缩进了一格"。它本来只是词间距，不该占一个字的位置。
       **必须放在断行之后** —— 断行发生在"处理这个空格"的时候，那时 cur 还是满的，
       在断行前判断 `!cur.length` 永远为假（踩过一次）。 */
    if (ch === ' ' && !cur.length) continue;
    cur.push(ch);
    w += cw;
  }
  flush();

  /* 行首禁则：满宽切行时，"。"常常正好落在下一行的第一个字上 ——
     屏幕上就是"…关注的位置 / 。整体负载不高"，读起来像排错了版。
     改法是把那个标点**拉回上一行**（宁可那行超出一格），而不是硬留个孤零零的句号。
     注意不能要求"这一行至少两个字"：句末的"。"正好是**整行的唯一内容**时，
     那个条件会让它留在下一行 —— 实测屏幕上第二行只有一个句号。 */
  for (let i = 1; i < lines.length; i++) {
    const head = Array.from(lines[i]);
    while (head.length && NO_START.includes(head[0])) {
      lines[i - 1] += head.shift();
    }
    lines[i] = head.join('');
  }
  /* 整行都是标点时会被搬空 —— 空行不参与排版，否则中间会多出一行空白 */
  const kept = lines.filter((l) => l.length);

  if (kept.length > maxLines) {
    const keep = kept.slice(0, maxLines);
    const tail = keep[maxLines - 1];
    keep[maxLines - 1] = (tail.length > 1 ? tail.slice(0, -1) : tail) + '…';
    return keep;
  }
  return kept.length ? kept : [''];
}

/** 按 400 字切页，切点优先落在句读上 */
export function paginate(text) {
  const ch = Array.from(String(text ?? ''));
  if (ch.length <= PAGE_CHARS) return [ch.join('')];
  const out = [];
  let i = 0;
  while (i < ch.length) {
    let end = Math.min(ch.length, i + PAGE_CHARS);
    if (end < ch.length) {
      for (let k = end; k > i + PAGE_CHARS * 0.6; k--) {
        if (PAGE_BREAK.includes(ch[k - 1])) { end = k; break; }
      }
    }
    out.push(ch.slice(i, end).join(''));
    i = end;
  }
  return out;
}

/**
 * @param {object} o
 * @param {import('./field.js').Field} o.field
 * @param {import('./pui.js').SlotAllocator} o.alloc   与场景共用的那条槽位直线
 * @param {number} o.reserve                            给答案块预留的槽位数
 */
export function createAnswer({ field, alloc, reserve }) {
  const start = alloc.alloc(reserve, 'answer');
  /* 自带一个"子分配器"：重建字块时从 start 重新排，不会把外面的直线越推越远。 */
  const sub = {
    next: start,
    total: start + reserve,
    alloc(n) { const b = this.next; this.next += n; return b; },
    get used() { return this.next; },
  };

  let size = 20;
  let lh = 26;
  let rows = 14;
  let maxChars = 29;
  let maxWidth = 636;
  let cx = 0;
  let centerY = 0;
  let align = 'left';
  let color = '#eaf3ff';
  let full = '';
  let pages = [''];
  let page = 0;
  let block = [];
  let typer = 0;
  let shown = 0;
  let total = 0;

  function dispose() {
    for (const t of block) t.set('', { force: true });
    block = [];
    sub.next = start;
  }

  /**
   * 建行。
   *
   * 行宽取 `maxChars + 1`：多出来的那一个字是**行首禁则**回拉标点用的
   * （见 wrapText）。不留这一格，那行会被 ParticleText 截成 "…"，
   * 屏幕上就是"这句话怎么少了个句号"。
   *
   * 预留是按 max 算的（ParticleText 在构造时定死每字槽位），所以
   * `行数 × (maxChars+1) × 90` 必须 ≤ reserve —— 14 × 30 × 90 = 37800，
   * 这就是 deskagent 里 ANS_SLOTS 的来处。行数不能随手加。
   */
  function ensureRows(n) {
    while (block.length < n) {
      block.push(new ParticleText({
        field, alloc: sub, x: cx, y: centerY,
        size, max: maxChars + 1, color, align, font: FONT,
        weight: 400,
        /* 可读密度：90 颗/字。用小字号省槽位、用大字号省不了 —— 见 pui.js */
        budget: glyphBudget(size, true),
        /* 和 pui 那条公式同源：1.0 + size × 0.05（20px → 2.0）。
           之前写 size × 0.085 只有 1.7，比默认还小 —— 笔画被切成两排点，远看发灰。 */
        dot: Math.min(2.8, 1.0 + size * 0.05), label: `ans${block.length}`,
      }));
    }
  }

  function paint(ls, n) {
    ensureRows(Math.max(1, ls.length));
    /* 整块以 centerY 为中线：行数少的时候不会贴底，行数多的时候也不会顶到状态区 */
    const firstY = centerY - ((ls.length - 1) * lh) / 2;
    let left = n == null ? Infinity : n;
    for (let i = 0; i < block.length; i++) {
      const t = block[i];
      t.x = cx;
      t.y = firstY + i * lh;
      if (i >= ls.length) { t.set('', { force: true }); continue; }
      let chars = Array.from(ls[i] ?? '');
      /* 槽位不够时 ParticleText 会把自己的 max 压小，一句话被**静默**截在半路。
         截断处补一个省略号，让"没说完"这件事看得见。 */
      if (chars.length > t.max) chars = chars.slice(0, Math.max(1, t.max - 1)).concat('…');
      const take = Math.max(0, Math.min(chars.length, left));
      t.set(chars.slice(0, take).join(''), { force: true, color, scl: 1.25 });
      left -= take;
    }
  }

  function lines() {
    return wrapText(pages[page] ?? '', { size, maxWidth, maxLines: rows, maxChars });
  }

  function startTyping(opt) {
    clearInterval(typer);
    const ls = lines();
    total = ls.join('').length;
    shown = 0;
    if (opt.instant || !total) { paint(ls, null); shown = total; return; }
    paint(ls, 0);
    /* 步长按总字数调：400 字一页不该花十秒才说完 */
    const step = total > 200 ? 6 : total > 60 ? 3 : total > 20 ? 2 : 1;
    typer = setInterval(() => {
      shown += step;
      paint(ls, shown);
      if (shown >= total) { shown = total; clearInterval(typer); }
    }, 26);
  }

  return {
    /**
     * 布局：窗口大小变了、有没有场景变了，都从这里进来。
     * 字号/每行字数变了要重建字块（槽位按字号算死了）。
     */
    layout(geom) {
      const reflow = geom.size !== size || geom.maxChars !== maxChars || geom.lines !== rows;
      size = geom.size;
      lh = geom.lh;
      rows = geom.lines;
      maxChars = geom.maxChars;
      maxWidth = geom.maxWidth;
      cx = geom.cx;
      align = geom.align || align;
      centerY = geom.centerY ?? geom.baseY ?? centerY;
      if (reflow) {
        dispose();
        if (full) startTyping({ instant: true });
      } else if (full) {
        /* 几何变了但字块没重建（比如从满宽切到分栏）：只按新中点重绘，
           不要再打一遍字 —— 那会让已经读完的答案重新逐字生长一遍。 */
        clearInterval(typer);
        const ls = lines();
        paint(ls, null);
        shown = total = ls.join('').length;
      }
    },

    /** @param {{instant?:boolean, color?:string}} [opt] */
    set(text, opt = {}) {
      const s = String(text ?? '');
      /* 换文本时先把**整段答案带**清一遍：逐字缓存（ch/x/y）管不住
         "上一版占过、这一版不占"的格子，那些点会原地留着，屏幕上浮出一截残字。 */
      if (s !== full) field.slotBlank(start, reserve);
      full = s;
      pages = paginate(s);
      page = 0;
      color = opt.color || '#eaf3ff';
      startTyping(opt);
    },

    /** 翻页。返回 false 表示到头了（页脚据此不再吃键）。 */
    goPage(d) {
      const n = page + d;
      if (n < 0 || n >= pages.length) return false;
      page = n;
      field.slotBlank(start, reserve);
      startTyping({ instant: true });
      return true;
    },

    /**
     * 调试：这一页实际排出来的行 + 排版参数。
     *
     * `answerGeom()` 是**外面算的**，这里是**里面记的** —— 两者不一致时
     * （外面 636、里面按 337 排），看截图永远查不出来，只有把两份摆在一起才行。
     */
    debugLines: () => {
      const ls = lines();
      return {
        maxWidth, maxChars, size, rows,
        lines: ls.map((l) => `${Array.from(l).length}|${l.slice(0, 6)}`),
        block: block.slice(0, 2).map((t) => ({ size: t.size, max: t.max, dead: t.dead })),
      };
    },

    clear() { clearInterval(typer); full = ''; pages = ['']; page = 0; shown = total = 0; paint([''], 0); },
    get text() { return full; },
    get page() { return page; },
    get pageCount() { return pages.length; },
    get typing() { return shown < total; },
    /** 块的上沿（屏幕坐标）。收尾冲量用它定位。 */
    get top() {
      const n = Math.max(1, block.length);
      const firstY = centerY - ((n - 1) * lh) / 2;
      return firstY - size;
    },
    get used() { return sub.next - start; },
    get capacity() { return reserve; },
  };
}
