/**
 * 答案块 —— 屏幕上真正要"读"的那几段字。
 *
 * 从"输入框上面一行 19px / 20 字"改过来，现在是一整块版面：
 *   20px、每行 33 字、14 行、**每页 400 字**，竖排在左半屏里居中。
 *
 * 为什么是 20px：一个字吃 `glyphBudget = size × 2` 颗粒子，32px 就是 64 颗，
 * 18000 颗槽位只够 281 字 —— 一页排不下三段。20px 是"能成篇"和"读得清"的交叉点。
 *
 * 四条要守住的：
 *   1. **按字数分页，不按行分页**。按行切会在句子中间断开。
 *   2. **分页点优先落在句读上**（。！？；换行），宁可这页短一点。
 *   3. **换行只在文本真变了时算一次**，每帧重排会让字在行间跳。
 *   4. **逐字生长保留**：一行行凝出来是这套界面的语法，DOM 里没有对应的东西。
 */

import { ParticleText } from './pui.js';
import { FONT } from './draw.js';

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const BREAK = '，。、；：!?！？ ';
const PAGE_BREAK = '。！？；\n';

/** 每页字数。400 是 33 字 × 14 行（=462）留出段落间距后的保守值。 */
export const PAGE_CHARS = 400;

/** 粗略字宽：汉字占一个字号，拉丁/数字约 0.56。够换行用，不用真量。 */
function widthOf(ch, size) {
  return CJK.test(ch) ? size : size * 0.56;
}

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
    const cw = widthOf(ch, size);
    if ((w + cw > maxWidth || cur.length >= maxChars) && cur.length) {
      let cut = -1;
      for (let k = cur.length - 1; k >= Math.floor(cur.length * 0.6); k--) {
        if (BREAK.includes(cur[k])) { cut = k + 1; break; }
      }
      if (cut > 0) {
        const rest = cur.slice(cut);
        lines.push(cur.slice(0, cut).join('').trimEnd());
        cur = rest;
        w = rest.reduce((a, c) => a + widthOf(c, size), 0);
      } else {
        flush();
      }
    }
    cur.push(ch);
    w += cw;
  }
  flush();

  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines);
    const tail = keep[maxLines - 1];
    keep[maxLines - 1] = (tail.length > 1 ? tail.slice(0, -1) : tail) + '…';
    return keep;
  }
  return lines.length ? lines : [''];
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
  let maxChars = 33;
  let maxWidth = 636;
  let cx = 0;
  let centerY = 0;
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

  function ensureRows(n) {
    while (block.length < n) {
      block.push(new ParticleText({
        field, alloc: sub, x: cx, y: centerY,
        size, max: maxChars, color, align: 'center', font: FONT,
        weight: 500,
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
