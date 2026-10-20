/**
 * 场的可访问性镜像层。
 *
 * 场里没有一个字是真 DOM —— 全是粒子。对读屏软件来说，这一屏是空的。
 * 所以每个场景都要镜像一份语义摘要到 `aria-live` 节点上。
 *
 * 这件事不能"以后再说"，因为它反过来约束了接口设计：如果给模型的 spec 里只有
 * 几何（角度、半径、点数），这一层就没法生成文字。所以 spec 必须是语义的 ——
 * 能被翻译成一句人话，正是"模型只说语义"这条纪律的副产品。
 *
 * 三个细节：
 *   1. 节流。patch 可能每 400ms 来一次（进度推进），逐次播报会把读屏用户淹没。
 *      所以默认 2.4s 一次，并且**延后补播最后一次** —— 停在哪就是哪，不会漏。
 *   2. 同样的文字不会被重复播报（读屏软件只看内容是否变化），所以重复时要先清空再写。
 *   3. 瞬时事件（confirm / error）走 assertive 通道单独播，因为它们比状态更要紧。
 */

/** spec → 一句人话。纯函数，方便单测。 */
export function describe(spec) {
  if (!spec) return '';
  const parts = [];
  if (spec.title) parts.push(spec.title);

  for (const l of spec.layers || []) {
    if (!l || !l.kind) continue;
    const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
    switch (l.kind) {
      case 'gauge':
        parts.push(`${l.label || '指标'} ${pct(l.value)}`);
        break;
      case 'stream':
        parts.push(`${l.label || '任务'} 进度 ${pct(l.progress)}${l.rate ? `，速率 ${l.rate}` : ''}`);
        break;
      case 'trace': {
        const d = (l.data || []).map((v) => Number(v) || 0);
        if (d.length) {
          parts.push(`${l.label || '走势'}，当前 ${pct(d[d.length - 1])}，`
            + `区间 ${pct(Math.min(...d))} 到 ${pct(Math.max(...d))}`);
        } else {
          parts.push(`${l.label || '走势'}`);
        }
        break;
      }
      case 'fork':
        parts.push(`需要选择：${l.label || ''}。选项：${(l.options || []).map((o) => o.label).join('、')}`);
        break;
      case 'turbulence':
        parts.push(`${l.label || '异常'} 程度 ${pct(l.level)}`);
        break;
      case 'condense':
        if (l.text) parts.push(l.text);
        break;
      default:
        break;
    }
  }

  const mood = { calm: '一切平稳', working: '正在处理', alert: '需要注意' }[spec.mood];
  if (mood) parts.push(mood);
  return parts.filter(Boolean).join('。');
}

const EVENT_WORD = {
  confirm: '已确认',
  arrive: '已完成',
  error: '出错了',
  settle: '已结束',
};

export class FieldA11y {
  /**
   * @param {HTMLElement} el  live region 容器（会挂两个子节点：状态 / 事件）
   * @param {{minGap?:number}} [opt]
   */
  constructor(el, opt = {}) {
    this.el = el;
    this.minGap = opt.minGap ?? 2400;
    this.status = document.createElement('div');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-atomic', 'true');
    this.alert = document.createElement('div');
    this.alert.setAttribute('role', 'alert');
    this.alert.setAttribute('aria-live', 'assertive');
    if (el) el.append(this.status, this.alert);

    this.text = '';
    this.log = [];            // 供测试/截图看：最近播报了什么
    this._lastAt = -1e9;
    this._timer = 0;
  }

  /** 状态播报（节流 + 尾部补播） */
  announce(spec, opt = {}) {
    const txt = describe(spec);
    if (!txt) return;
    const now = performance.now();
    const wait = this.minGap - (now - this._lastAt);
    if (!opt.force && wait > 0) {
      /* 延后补播：连续 patch 时只在停止后播一次最终状态，而不是每次都播 */
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.announce(spec, { force: true }), wait + 20);
      return;
    }
    this._flush(txt);
  }

  /** 瞬时事件：单独走 assertive，且不占状态节流的额度 */
  event(kind, opt = {}) {
    const w = EVENT_WORD[kind];
    if (!w) return;
    this._write(this.alert, w);
    this.log.push({ at: Math.round(performance.now()), kind, text: w });
  }

  /* 同样的文字读屏不会重播，所以重复时先清空再写 */
  _flush(txt) {
    this._lastAt = performance.now();
    this.text = txt;
    this._write(this.status, txt);
    this.log.push({ at: Math.round(this._lastAt), kind: 'state', text: txt });
  }

  _write(node, txt) {
    if (node.textContent === txt) {
      node.textContent = '';
      setTimeout(() => { node.textContent = txt; }, 40);
    } else {
      node.textContent = txt;
    }
  }
}
