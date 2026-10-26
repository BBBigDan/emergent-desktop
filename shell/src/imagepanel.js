/**
 * 生成的图 —— 原图居中，外面围一圈**粒子流**。
 *
 * 为什么不是"把图当一层铺进场景"：场景层（`scene.schema`）是**模型能画的东西**，
 * 而图是工具的产物。给场景加一个 image kind，等于让模型能往屏幕上放任意 URL ——
 * 那是新的口子。所以它和换模型表、设置页一样，是 DOM 面板 + 粒子框，
 * 由服务端的事件开，不由模型的表达欲开。
 *
 * 为什么不是"采样成粒子"：问过用户，要**原图**（细节和质感才看得见），
 * 但**不能直接贴一张图在屏幕上** —— 这一层里没有"边框"和"卡片"，
 * 一块区域要被圈出来只能是粒子自己围（traceframe.js）。
 * 于是：图是真的图，边界是真的粒子。
 *
 * 三条从换模型表继承的规矩（每一条都踩过）：
 *   · `pointer-events: auto` —— 祖先是 none，少了它就是"看得见、点不动"；
 *   · 框由 deskagent 管，**同时只开一块玻璃**，开之前先让别的让位；
 *   · 尺寸/位置用**真实盒子**报给框，且框在 setOpen(true) 之前挪。
 */

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

export function createImagePanel(o = {}) {
  const root = el('div', 'ag-img');
  root.hidden = true;

  const box = el('div', 'ag-img-box');
  const img = el('img', 'ag-img-pic');
  img.alt = '';
  img.decoding = 'async';
  box.appendChild(img);

  const cap = el('div', 'ag-img-cap');
  const meta = el('em', 'ag-img-meta');
  const x = el('button', 'ag-img-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '收起这张图');
  cap.append(meta, x);

  root.append(box, cap);

  let open = false;
  let data = null;

  x.addEventListener('click', (e) => { e.stopPropagation(); o.onClose?.(); close(); });
  /* 点图本身不收 —— 用户的下一步多半是"看看这张"。
     但点在图外面（deskagent 判 hit 之后）要收，那条路在 deskagent 里。 */

  function fmt(ms) {
    if (!(ms > 0)) return '';
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  /**
   * @param {{url:string, width?:number, height?:number, seed?:number, ms?:number,
   *          bounds?:{x:number,y:number,w:number,h:number}}} d
   */
  function openAt(d) {
    data = d;
    /* **由调用方给一块地方**（`bounds`），面板只负责"在里面放到最大"。
       为什么要这样分：这块屏的左边是答案、中间是球，图片能占的只有右边那一溜 ——
       而"右边那一溜"多宽，只有 deskagent 知道（它攥着答案栏和内容区的几何）。
       自己按 innerWidth 一半去猜，就会压在答案上（第一版就是这么重叠的）。 */
    const B = d.bounds || { x: 16, y: 56, w: innerWidth - 32, h: innerHeight - 140 };
    const natW = Number(d.width) || 512;
    const natH = Number(d.height) || 512;
    const maxW = Math.max(180, Math.min(B.w, 560));
    /* 高度上限 520：不只是"放得下"，还为了让外面那圈 900 颗点**连得起来** ——
       周长越长点距越大，超过 ~1800px 就开始看得出是虚线（和换模型表同一个数）。 */
    const maxH = Math.max(160, Math.min(B.h, 520));
    const k = Math.min(maxW / natW, maxH / natH, 1.6);   // 小图允许放大到 1.6，再大就糊
    const w = Math.round(natW * k);
    const h = Math.round(natH * k);

    const left = Math.round(B.x + Math.max(0, (B.w - w) / 2));
    const top = Math.round(B.y + Math.max(0, (B.h - h - 26) / 2));

    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    img.width = natW;
    img.height = natH;
    if (img.getAttribute('src') !== d.url) img.src = d.url;

    const bits = [`${natW}×${natH}`];
    if (d.seed) bits.push(`种子 ${d.seed}`);
    if (d.ms) bits.push(fmt(d.ms));
    meta.textContent = bits.join(' · ');

    root.hidden = false;
    open = true;
    /* 先报一次几何（框要在图出现的同时就在那儿），图加载完再报一次 ——
       图没加载时盒子高度是 0，框会围成一条线。 */
    requestAnimationFrame(() => o.onResize?.());
    if (!img.complete) img.addEventListener('load', () => o.onResize?.(), { once: true });
    root.classList.add('in');
  }

  function close() {
    if (!open) return false;
    open = false;
    root.classList.remove('in');
    setTimeout(() => { if (!open) { root.hidden = true; img.removeAttribute('src'); } }, 200);
    return true;
  }

  function isOpen() { return open; }

  /** 盖住的地方不产生任何意图（deskagent 的拖球会问这一句） */
  function hit(px, py) {
    if (!open) return false;
    const r = root.getBoundingClientRect();
    return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  }

  /** 粒子框照着它画 —— 必须是真实盒子（含标题那一行） */
  function rect() {
    if (!open) return null;
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }

  return {
    el: root,
    openAt,
    close,
    isOpen,
    hit,
    rect,
    data: () => data,
    /** 自测用：现在这张图的地址（没有就是 null） */
    src: () => (open ? img.getAttribute('src') : null),
  };
}
