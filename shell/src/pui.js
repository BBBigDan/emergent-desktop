/**
 * 粒子排版层：字模缓存 + 固定槽位。
 *
 * 为什么不能沿用 compileDraw：
 *   它是「整幅点云 → 按 stride 打散分配给 6400 颗粒子」。加一个字，点云长度变了，
 *   所有粒子的目标位都跟着重算 —— 实测每次 ~90ms，而且整块界面像被搅了一下
 *   （docs/images/agent-pui-reflow.png 拍到的就是那一瞬）。
 *
 * 这里换成两层固定的映射：
 *   字 → 点云（字形缓存，key = 字符|字号|字重|预算）
 *   槽位 → 粒子（互质乘法双射，见 SLOT_MUL）
 *
 * 于是同一个字永远落在同一批粒子上，打字只重写新增那一段；已有的字一个像素都不动。
 * 双射为什么要互质乘法：连续槽位若直配连续粒子索引，元素会从球面上的一小块飞出来
 * （球面黄金角分布里相邻索引是挨着的）；乘一个与 6400 互质的数打散，观感才和
 * compileDraw 的打散分配一致。
 */

const TOTAL = 6400;      // 槽位总数 = ambient 粒子数，一一对应
const SLOT_MUL = 7919;   // gcd(7919, 6400) = 1 → 双射
const SLOT_ADD = 13;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ───────────────────────── 字形缓存 ───────────────────────── */

const cache = new Map();
let cv = null;
let g2 = null;

function ctx2d() {
  if (g2) return g2;
  cv = document.createElement('canvas');
  g2 = cv.getContext('2d', { willReadFrequently: true });
  return g2;
}

/**
 * 每字点数预算。
 *
 * 这个系数是实测出来的：1.6 时每个 24px 汉字只有 36 颗点，字被打成一团碎渣；
 * 2.0 时约 48 颗、点距落到 2.2~2.5px，笔画才连得上。
 * 上限受 6400 槽位约束 —— 一屏约 95 个字 + 框线，平均每字 50 上下就是天花板。
 */
export function glyphBudget(size) {
  return Math.round(clamp(size * 2.0, 26, 240));
}

/**
 * 格内按 alpha 加权取质心。
 *
 * ink 的算法必须和 draw.js 的 sampleInk 一致：`sw / (n² * 0.55)`。
 * 我第一版用了 `a > 64` + 另一个归一化，结果 ink 只有 0.15~0.4，
 * 于是每颗点又小又暗，加法混合填不满笔画 —— 字看起来是被打碎的、
 * 一笔还裂成两条平行点列（笔画两侧各落一排）。同一套公式就好了。
 */
function sampleGlyph(data, W, H, step) {
  const pts = [];
  const n = Math.max(1, Math.round(step));
  for (let gy = 0; gy < H; gy += n) {
    const y1 = Math.min(H, gy + n);
    for (let gx = 0; gx < W; gx += n) {
      const x1 = Math.min(gx + n, W);
      let sw = 0;
      let sx = 0;
      let sy = 0;
      for (let y = gy; y < y1; y++) {
        const row = y * W;
        for (let x = gx; x < x1; x++) {
          const a = data[(row + x) * 4 + 3];
          if (a > 24) {
            const w = a / 255;
            sw += w;
            sx += x * w;
            sy += y * w;
          }
        }
      }
      if (sw > 0.2) {
        pts.push({
          x: sx / sw,
          y: sy / sw,
          ink: Math.min(1, sw / (n * n * 0.55)),
        });
      }
    }
  }
  return pts;
}

/**
 * 单个字形 → 相对基线原点的点云。
 * @returns {{pts:{x:number,y:number,ink:number}[], advance:number, cell:number, budget:number}}
 */
export function glyph(ch, size, opt = {}) {
  const weight = opt.weight ?? 300;
  const font = opt.font || '';
  const budget = opt.budget ?? glyphBudget(size);
  const key = `${ch}|${size}|${weight}|${budget}|${font}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const g = ctx2d();
  const PAD = 4;
  const W = Math.ceil(size * 1.3) + PAD * 2;
  const H = Math.ceil(size * 1.5) + PAD * 2;
  cv.width = W;                      // 改尺寸即清空，省一次 clearRect
  cv.height = H;
  g.font = `${weight} ${size}px ${font || 'sans-serif'}`;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#fff';

  const advance = g.measureText(ch).width;
  const asc = Math.round(size * 1.02);
  if (ch.trim()) g.fillText(ch, PAD, PAD + asc);

  const data = g.getImageData(0, 0, W, H).data;

  /* 收密：先用小格子，超预算就放大；没到 85% 就再收。
     这一步和 draw.js 的预算控制同一套逻辑 —— 稀疏的字会显得"珠子串"，宁可密一点。 */
  let step = Math.max(1.5, size / 10);
  let pts = [];
  for (let pass = 0; pass < 7; pass++) {
    pts = sampleGlyph(data, W, H, step);
    if (pts.length <= budget) {
      if (pts.length >= budget * 0.90 || step <= 1.5) break;
      step *= 0.85;
    } else {
      step *= 1.12;
    }
    step = clamp(step, 1.5, size / 2);
  }
  if (pts.length > budget) {
    const stride = pts.length / budget;
    const cut = [];
    for (let k = 0; k < budget; k++) cut.push(pts[Math.floor(k * stride)]);
    pts = cut;
  }

  const out = {
    pts: pts.map((p) => ({ x: p.x - PAD, y: p.y - PAD - asc, ink: p.ink })),
    advance,
    cell: step,
    budget,
  };
  cache.set(key, out);
  return out;
}

/* ───────────────────────── 槽位分配 ───────────────────────── */

const toParticle = (slot) => (slot * SLOT_MUL + SLOT_ADD) % TOTAL;

export class SlotAllocator {
  constructor(total = TOTAL) {
    this.next = 0;
    this.total = total;
  }

  /** 预留 n 个连续槽位，返回起始槽号 */
  alloc(n, label = '') {
    if (this.next + n > this.total) {
      throw new Error(`槽位不足：${label} 需要 ${n}，剩余 ${this.total - this.next}`);
    }
    const base = this.next;
    this.next += n;
    this.label = label;
    return base;
  }

  get used() {
    return this.next;
  }
}

/* ───────────────────────── 文本块 ───────────────────────── */

/**
 * 一行粒子文字。
 *
 * set() 是增量的：内容没变的字直接跳过（连点云都不重算），只有新增/改变的字
 * 会被重新采样并写进它自己那段槽位。所以"打字"只会多出最后一个字。
 */
export class ParticleText {
  /**
   * @param {object} o
   * @param {import('./field.js').Field} o.field
   * @param {SlotAllocator} o.alloc
   * @param {number} o.x 左端（align=left 时）
   * @param {number} o.y 基线
   * @param {number} o.size
   * @param {string} o.color '#rrggbb'
   * @param {number} [o.max] 最大字数（决定槽位预留）
   * @param {'left'|'center'|'right'} [o.align]
   * @param {string} [o.font]
   * @param {number} [o.weight]
   * @param {number} [o.dot] 点径缩放
   */
  constructor(o) {
    this.field = o.field;
    this.x = o.x;
    this.y = o.y;
    this.size = o.size;
    this.color = o.color;
    this.max = o.max ?? 32;
    this.align = o.align ?? 'left';
    this.font = o.font || '';
    this.weight = o.weight ?? 300;
    this.dot = o.dot ?? 1;
    this.budget = glyphBudget(o.size);
    this.base = o.alloc.alloc(this.max * this.budget, o.label || 'text');
    this._slots = new Array(this.max).fill(null);   // 每格记 {ch, x}，用于跳过
    this._last = 0;
    this._wrote = 0;
  }

  clear() {
    this.set('');
  }

  /**
   * @param {string} text
   * @param {{color?:string, scl?:number}} [opt]
   * @returns {{wrote:number, ms:number, px:number, chars:number}}
   */
  set(text, opt = {}) {
    const t0 = performance.now();
    const color = opt.color || this.color;
    const rgb = hexToRgb(color);
    let chars = Array.from(String(text ?? ''));
    if (chars.length > this.max) chars = chars.slice(0, this.max);

    /* 先量宽：按字符 advance 累加，用来做居中/右对齐 */
    const metrics = chars.map((ch) => glyph(ch, this.size, { weight: this.weight, font: this.font, budget: this.budget }));
    const total = metrics.reduce((a, m) => a + m.advance, 0);
    let cx = this.x;
    if (this.align === 'center') cx = this.x - total / 2;
    else if (this.align === 'right') cx = this.x - total;

    let wrote = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const gx = cx;
      cx += metrics[i].advance;
      const prev = this._slots[i];
      /* 同一个字、同一个位置 → 那段槽位早就对了，直接跳过。
         这是"打字不整屏重排"的全部秘密：跳过的字连采样都不做。 */
      if (!opt.force && prev && prev.ch === ch && Math.abs(prev.x - gx) < 0.01) continue;
      const pts = metrics[i].pts.map((p) => ({ x: gx + p.x, y: this.y + p.y, ink: p.ink }));
      /* spawn：新字在这一格附近凝结，而不是从球面某处飞过来 ——
         观感上是"笔尖落墨、墨自己收成字"，DOM 里没有对应的东西。
         只有内容真的变了才给出生点；因排版位移而重算的字不该重新出生。 */
      const spawn = opt.spawn
        ? { x: gx + metrics[i].advance * 0.5, y: this.y - this.size * 0.34, r: this.size * 0.55 }
        : null;
      this.field.slotPut(this.base + i * this.budget, pts, rgb, opt.scl ?? 1, spawn);
      this._slots[i] = { ch, x: gx };
      wrote++;
    }

    /* 变短了：多出来的槽位清掉（保持 drawUse=1 + 亮度 0，
       粒子停在原地隐身，下次输入直接复用，不会飞回球面再飞回来） */
    for (let i = chars.length; i < this._last; i++) {
      if (this._slots[i]) {
        this.field.slotBlank(this.base + i * this.budget, this.budget);
        this._slots[i] = null;
      }
    }
    this._last = chars.length;
    this._wrote += wrote;
    return { wrote, ms: performance.now() - t0, px: total, chars: chars.length };
  }
}

function hexToRgb(hex) {
  const s = String(hex || '#ffffff').replace('#', '');
  const v = s.length === 3
    ? s.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  return [(v[0] || 0) / 255, (v[1] || 0) / 255, (v[2] || 0) / 255];
}

export { toParticle, TOTAL };
