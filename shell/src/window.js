/**
 * 窗口 DOM 层。
 *
 * 关键取舍：iframe 的显现只动 opacity，不做 transform:scale ——
 * 缩放会让内容跟着重新栅格化，整个生长过程都是糊的；
 * clip-path 又像从中心开窥视孔。opacity 完全不碰内容像素，字从第一帧就是锐利的。
 */
const DREAM_EDGE = 64;

export class ShellWindow {
  /**
   * @param {{id:string,title:string,icon:string,host:string}} app
   * @param {number} g 粒子组号（与 Field.groups 对应）
   * @param {() => void} onClosed
   */
  constructor(app, g, onClosed) {
    this.app = app;
    this.g = g;
    this.onClosed = onClosed;
    this.rev = 0;

    const el = document.createElement('div');
    /* void：还没显形（rev≈0）时 visibility:hidden，见 setReveal 的注释 */
    el.className = 'win void';
    el.innerHTML = `
      <iframe class="win-frame" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      <div class="win-frost"></div>
      <div class="win-tint"></div>
      <div class="win-veil"></div>
      <div class="win-rim"></div>
      <div class="win-glow"></div>
      <div class="win-bar">
        <img class="win-icon" alt="" />
        <span class="win-title"></span>
        <span class="win-spacer"></span>
        <button class="win-btn" data-act="min" title="最小化">–</button>
        <button class="win-btn" data-act="max" title="最大化">□</button>
        <button class="win-btn win-close" data-act="close" title="关闭">×</button>
      </div>`;
    this.el = el;
    this.frame = el.querySelector('.win-frame');
    this.bar = el.querySelector('.win-bar');
    el.querySelector('.win-title').textContent = app.title;
    const icon = el.querySelector('.win-icon');
    if (app.icon) icon.src = app.icon; else icon.style.display = 'none';

    // 默认尺寸：视口的 78% × 76%，居中
    const w = Math.round(Math.min(window.innerWidth * 0.78, 1440));
    const h = Math.round(Math.min(window.innerHeight * 0.76, 920));
    this.rect = {
      x: Math.round((window.innerWidth - w) / 2),
      y: Math.round((window.innerHeight - h) / 2),
      w,
      h,
    };
    this.applyRect();
    this.computeEdge();

    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') this.requestClose();
      if (act === 'max') this.toggleMax();
      if (act === 'min') this.minimize();
    });
    // 标题栏拖动
    this.bar.addEventListener('pointerdown', (e) => this.startDrag(e));

    document.getElementById('windows').appendChild(el);
    this.frame.src = `https://${app.host}`;
  }

  computeEdge() {
    const edge = Math.max(44, Math.min(94, Math.min(this.rect.w, this.rect.h) * 0.098));
    this.el.style.setProperty('--edge', `${edge.toFixed(0)}px`);
    this.el.style.setProperty('--edge-y', `${(edge * 0.72).toFixed(0)}px`);
    this.el.style.setProperty('--corner', `${(edge * 2.34).toFixed(0)}px`);
  }

  applyRect() {
    const { x, y, w, h } = this.rect;
    Object.assign(this.el.style, {
      left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
    });
  }

  toggleMax() {
    if (this._normal) {
      this.rect = this._normal;
      this._normal = null;
    } else {
      this._normal = { ...this.rect };
      this.rect = { x: 8, y: 8, w: window.innerWidth - 16, h: window.innerHeight - 96 };
    }
    this.applyRect();
    this.computeEdge();
    this.onResize?.(this.g, this.rect);
  }

  startDrag(e) {
    if (e.target.closest('[data-act]')) return;
    const sx = e.clientX, sy = e.clientY;
    const ox = this.rect.x, oy = this.rect.y;
    const move = (ev) => {
      this.rect.x = Math.max(-this.rect.w + 120, Math.min(window.innerWidth - 120, ox + ev.clientX - sx));
      this.rect.y = Math.max(0, Math.min(window.innerHeight - 80, oy + ev.clientY - sy));
      this.applyRect();
      this.onResize?.(this.g, this.rect);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** 由主循环每帧调用，把粒子场的揭示进度同步到 DOM */
  setReveal(rev) {
    if (Math.abs(rev - this.rev) < 0.002) return;
    this.rev = rev;
    this.el.style.setProperty('--rev', rev.toFixed(3));
    this.el.classList.toggle('revealed', rev > 0.995);
    /* rev≈0 时彻底停止绘制。opacity:0 不够：Chrome 的 backdrop-filter 不跟
       祖先 opacity 走，窗口"淡到 0"之后屏幕上还会留一块模糊的板（关窗时实测可见）。 */
    this.el.classList.toggle('void', rev < 0.002);
  }

  requestClose() {
    this.el.classList.add('closing');
    this.frame.style.pointerEvents = 'none';
    this.onClose?.();
  }

  minimize() {
    this.minimized = true;
    this.el.classList.add('minimized');
    this.onMinimize?.();
  }

  restore() {
    this.minimized = false;
    this.el.classList.remove('minimized');
  }

  destroy() {
    this.el.remove();
    this.onClosed?.();
  }
}
