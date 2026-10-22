/**
 * 答案块 —— 屏幕上真正要"读"的那几行字。
 *
 * 为什么不是一行：原来整个回答挤成输入框上面的一行、19px、最多 20 字。
 * 结果是 1440×900 的屏上，最该被读的内容只占 380×24 的一小条，剩下全空着，
 * 而模型想多说一句就只能被截断。用户的说法很直接：看不清、挤、这么大这么空。
 *
 * 所以换成一个**块**：
 *   · 大：字高 32（原来 19），一行 12 字、最多 3 行
 *   · 清楚：行距 44px，底部贴着输入框往上长，不压输入框
 *   · 有层次：用户说的话用暗色先占位，模型的回答用亮色接过去
 *
 * 三件事得守住：
 *   1. **槽位有限**（场里 6400 颗）。字越大每字吃的点越多（glyphBudget ≈ 2×字号），
 *      所以一行装几个字是按预算算的，不是拍数字。
 *   2. **换行只在文本真变了时算一次**：每帧重排会让字在行间跳。
 *   3. **逐字生长保留**：一行行凝出来是这套界面的语法（DOM 里没有对应的东西），
 *      但必须按"已经算好的行"切，不能拿前缀去重新换行 —— 否则断行会来回变。
 */

import { ParticleText } from './pui.js';
import { FONT } from './draw.js';

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const BREAK = '，。、；：!?！？ ';

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

/**
 * @param {object} o
 * @param {import('./field.js').Field} o.field
 * @param {import('./pui.js').SlotAllocator} o.alloc   与场景共用的那条槽位直线
 * @param {number} o.reserve                            给答案块预留的槽位数
 */
export function createAnswer({ field, alloc, reserve }) {
  const start = alloc.alloc(reserve, 'answer');
  /* 自带一个"子分配器"：重建字块时从 start 重新排，不会把外面的直线越推越远。
     （共用外层 alloc 的话，每换一次字号就永久吃掉一段槽位，最后场景分不到。） */
  const sub = {
    next: start,
    total: start + reserve,
    alloc(n) { const b = this.next; this.next += n; return b; },
    get used() { return this.next; },
  };

  let size = 32;
  let lh = 44;
  let rows = 3;
  let maxChars = 12;
  let maxWidth = 420;
  let cx = 0;
  let baseY = 0;
  let color = '#eaf3ff';
  let full = '';
  let block = [];
  let typer = 0;
  let shown = 0;
  let total = 0;

  function dispose() {
    for (const t of block) t.set('', { force: true });
    block = [];
    sub.next = start;
  }

  /* 行数只会随着换行结果增减；字号变了会在 layout() 里整体重建。
     槽位不够时 ParticleText 自己会把 max 往下压，所以这里不用再判预算。 */
  function ensureRows(n) {
    while (block.length < n) {
      block.push(new ParticleText({
        field, alloc: sub, x: cx, y: baseY,
        size, max: maxChars, color, align: 'center', font: FONT, weight: 500, dot: Math.min(2.6, size * 0.085), label: `ans${block.length}`,
      }));
    }
  }

  function paint(ls, n) {
    ensureRows(Math.max(1, ls.length));
    let left = n == null ? Infinity : n;
    for (let i = 0; i < block.length; i++) {
      const t = block[i];
      t.x = cx;
      t.y = baseY - (ls.length - 1 - i) * lh;
      if (i >= ls.length) { t.set('', { force: true }); continue; }
      let chars = Array.from(ls[i] ?? '');
      /* 槽位不够时 ParticleText 会把自己的 max 压小（第二行常只剩十几格），
         于是一句话被**静默**截在半路 —— 读的人会以为它本来就在那儿结束。
         截断处补一个省略号，让"没说完"这件事看得见。 */
      if (chars.length > t.max) chars = chars.slice(0, Math.max(1, t.max - 1)).concat('…');
      const take = Math.max(0, Math.min(chars.length, left));
      t.set(chars.slice(0, take).join(''), { force: true, color, scl: 1.25 });
      left -= take;
    }
  }

  function lines() {
    return wrapText(full, { size, maxWidth, maxLines: rows, maxChars });
  }

  return {
    /**
     * 布局：窗口大小变了、有没有场景变了，都从这里进来。
     * 字号/每行字数变了要重建字块（槽位按字号算死了）。
     */
    layout(geom) {
      const reflow = geom.size !== size || geom.maxChars !== maxChars;
      size = geom.size;
      lh = geom.lh;
      rows = geom.lines;
      maxChars = geom.maxChars;
      maxWidth = geom.maxWidth;
      cx = geom.cx;
      baseY = geom.baseY;
      if (reflow) dispose();
      if (full) {
        clearInterval(typer);
        paint(lines(), null);
      }
    },

    /** @param {{instant?:boolean, color?:string}} [opt] */
    set(text, opt = {}) {
      const s = String(text ?? '');
      /* 换文本时先把**整段答案带**清一遍。逐字缓存（ch/x/y）能省掉重复采样，
         但它管不住"上一版占过、这一版不占"的格子 —— 那些点会原地留着，
         屏幕上浮出一截读不出来的残字（实测：回答出来后还有半句占位语贴在
         上面）。带子只有 1900 格，整段清一次的成本可以忽略。 */
      if (s !== full) field.slotBlank(start, reserve);
      full = s;
      color = opt.color || '#eaf3ff';
      clearInterval(typer);
      shown = 0;
      const ls = lines();
      total = ls.join('').length;
      if (opt.instant || !s) { paint(ls, null); shown = total; return; }
      paint(ls, 0);
      if (total <= 1) { paint(ls, null); shown = total; return; }
      /* 一行行凝出来。步长按总字数调：40 字的答案不该花 1.6 秒才说完 */
      const step = total > 30 ? 2 : 1;
      typer = setInterval(() => {
        shown += step;
        paint(ls, shown);
        if (shown >= total) { shown = total; clearInterval(typer); }
      }, 34);
    },

    clear() { clearInterval(typer); full = ''; shown = total = 0; paint([''], 0); },
    get text() { return full; },
    get typing() { return shown < total; },
    /** 块的上沿（屏幕坐标）。"在想"的转圈贴在它上面，不压在字上。 */
    get top() {
      const n = Math.max(1, block.length);
      return baseY - (n - 1) * lh - size;
    },
    get used() { return sub.next - start; },
    get capacity() { return reserve; },
  };
}
