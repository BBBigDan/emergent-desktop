/**
 * 换模型的那张表 —— 点一下左上角那个名字弹出来。
 *
 * 三件事必须在这里说清楚，因为**这张表是用户唯一能看见"它现在是谁"的地方**：
 *
 *   · **分组**：本地 / 平台。它们不是"两个供应商"，是两种成本结构 ——
 *     本地跑在这台机器上、不走网络、不产生 API 账；平台按量计费。
 *     混成一列的话，"为什么这个免费"就没有答案。
 *   · **会不会想**：不会想的模型，左上那栏「思考过程」里从此只有动作。
 *     用户换过去之后如果不知道为什么变安静了，那就是这张表的错。
 *   · **会不会调工具**：不会调的模型**能看见但不能选** —— 它连一屏都铺不出来
 *     （`scene_show` 本身就是工具）。灰着不说原因等于让用户猜。
 *
 * 它是 glass 面板（和「思考过程」同一套材质），因为它要读、要被点；
 * 但**面板本身不吃背后的手势**（deskagent 的 pick 会在这里让路）。
 */

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/** 价格的人话。`null` 不是 0 —— "单价未配置"和"免费"在屏幕上必须长得不一样。 */
function priceText(p) {
  if (!p) return '未定价';
  if (p.free) return '¥0';
  /* 有单价就按"元 / 百万 token"写成一行：`¥2/8` 是入/出两个价，
     展开写会让这一列吃掉半个面板。 */
  const f = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(3)));
  return `¥${f(p.in)}/${f(p.out)}`;
}

const THINK = { true: { v: '1', t: '想', d: '会思考（有 reasoning_content）' }, false: { v: '0', t: '想', d: '不会思考：那栏里只剩动作' }, null: { v: '?', t: '?', d: '没测过' } };
const TOOLS = { true: { v: '1', t: '工', d: '会调工具' }, false: { v: '0', t: '工', d: '不会调工具 —— agent 用不了它' }, null: { v: '?', t: '?', d: '没测过' } };

/**
 * @param {{onPick?:(id:string)=>void, onClose?:()=>void}} [o]
 *   `onClose` 只在**用户主动收**时调（点 ×、点了当前那个），不是每次收起都调。
 */
export function createModelPicker(o = {}) {
  const root = el('div', 'ag-mp');
  root.hidden = true;

  const hd = el('div', 'ag-mp-hd');
  const title = el('b', 'ag-mp-title', '换模型');
  const meta = el('em', 'ag-mp-meta');
  const x = el('button', 'ag-mp-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '收起');
  hd.append(title, meta, x);

  const list = el('div', 'ag-mp-list');
  const foot = el('div', 'ag-mp-foot');
  root.append(hd, list, foot);

  let data = null;          // 服务端给的那张表
  let open = false;
  let pending = '';         // 正在换的那个 id（等 model 事件落定）
  const rowById = new Map();

  function currentModel() {
    return data?.groups?.flatMap((g) => g.models).find((m) => m.id === data.current) || null;
  }

  /* 底部那行说明：默认说当前这个，鼠标移到哪一行就说哪一行。
     为什么不把它放进每一行：那会把行高翻倍（九行就装不下了），
     而"这一条有什么毛病"只在你要选它的时候才需要读。 */
  function say(m) {
    /* 跑着的时候先说这一句：这时候点哪一行都不会生效（服务端会拒），
       不说的话用户会以为"点了没反应"。 */
    if (data?.busy) { foot.textContent = '这一轮还在跑 —— 等它说完再换'; return; }
    const t = m || currentModel();
    if (!t) { foot.textContent = ''; return; }
    const bits = [t.org, t.note, t.speed ? `实测 ${t.speed}` : '', t.why || ''].filter(Boolean);
    foot.textContent = bits.join(' · ');
  }

  function render() {
    list.innerHTML = '';
    rowById.clear();
    if (!data) return;
    for (const g of data.groups || []) {
      const gh = el('div', 'mg');
      gh.append(el('b', '', g.label), el('em', '', g.note || ''));
      list.appendChild(gh);
      if (g.empty) list.appendChild(el('div', 'mp-empty', g.empty));
      for (const m of g.models || []) {
        const isCur = m.id === data.current;
        const row = el('button', `mrow${isCur ? ' cur' : ''}${m.usable ? '' : ' off'}`);
        row.type = 'button';
        row.dataset.id = m.id;
        /* 完整 id 挂在 title 上：短名是为了扫，全名是为了对账 */
        row.title = m.id + (m.why ? `\n${m.why}` : '');
        if (!m.usable) row.disabled = true;
        /* 跑着的时候不许换：一轮里可能有五次模型往返，换到一半就变成
           前半轮想的是 A、后半轮是 B，而屏幕上完全看不出来。 */
        if (data.busy && !isCur) row.disabled = true;

        const mk = el('i', 'mk');
        const nm = el('span', 'mn', m.name);
        const org = el('span', 'mo', m.org || '');
        const tags = el('span', 'mtags');
        for (const [tbl, val] of [[THINK, m.think], [TOOLS, m.tools]]) {
          const d = tbl[val] || tbl.null;
          const tag = el('span', 'mt', d.t);
          tag.dataset.v = d.v;
          tag.title = d.d;
          tags.appendChild(tag);
        }
        const pr = el('span', 'mpr', priceText(m.price));
        if (!m.price) pr.dataset.un = '1';
        if (m.cost === 'paid' && m.price) pr.dataset.paid = '1';

        const left = el('span', 'ml');
        left.append(mk, nm, org, tags);
        row.append(left, pr);
        /* 换着的那个：写"换…"，因为服务器回执到达之前不该假装已经换好 */
        if (pending === m.id) { row.classList.add('pending'); pr.textContent = '换…'; }

        row.addEventListener('mouseenter', () => say(m));
        row.addEventListener('focus', () => say(m));
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!m.usable || pending) return;
          /* 点的就是当前那个：什么都不用做，但**要收起来** ——
             点了一下什么都不发生，用户会以为这行坏了。 */
          if (m.id === data.current) { o.onClose?.(); close(); return; }
          pending = m.id;
          render();
          o.onPick?.(m.id);
        });
        list.appendChild(row);
        rowById.set(m.id, row);
      }
    }
    const cur = currentModel();
    meta.textContent = cur ? cur.name : '';
    say(null);
  }

  x.addEventListener('click', (e) => { e.stopPropagation(); o.onClose?.(); close(); });

  function openAt(rect) {
    if (!rect) return;
    root.hidden = false;
    /* 贴着名字下面开，右边界不够就往左挪 —— 它比状态条那一行宽得多，
       窄窗口里会顶出屏幕（顶出去的表现是"点了一下，什么都没出来"）。 */
    const w = Math.min(410, Math.max(300, innerWidth - 48));
    const left = Math.max(16, Math.min(rect.left, innerWidth - w - 16));
    root.style.width = `${w}px`;
    root.style.left = `${left}px`;
    root.style.top = `${Math.round(rect.bottom + 8)}px`;
    /* 高度上限按"到屏幕底部还剩多少"算，不写死 —— 短窗口里写死会顶出去 */
    root.style.maxHeight = `${Math.max(220, innerHeight - rect.bottom - 48)}px`;
    open = true;
    /* 表是现取的（本地要探测）。这一两百毫秒里**不能是一块空玻璃**——
       看起来像"点了没反应"。底下那行先说一句它在干什么。 */
    if (!data) { list.innerHTML = ''; foot.textContent = '正在看有哪些模型…'; }
    root.classList.add('in');
  }

  /* 收起。`onClose` **不在这里调**：它是"用户主动收起来了"的回执，
     由 × 和"点了当前那个"两条路各自触发。写在 close() 里的话，
     程序自己收（换完模型、收整层）也会被当成用户收，焦点就乱跳了。 */
  function close() {
    if (!open) return false;
    open = false;
    root.classList.remove('in');
    setTimeout(() => { if (!open) root.hidden = true; }, 180);
    return true;
  }

  function isOpen() { return open; }

  /** 面板盖住的地方不产生任何意图（deskagent 的 pick 会问这一句） */
  function hit(px, py) {
    if (!open) return false;
    const r = root.getBoundingClientRect();
    return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  }

  return {
    el: root,
    openAt,
    close,
    isOpen,
    hit,
    /** @param {object} d 服务端 `/api/models` 的返回 */
    setData(d) {
      data = d;
      if (pending && d.current === pending) pending = '';
      if (!open) return;
      render();
    },
    /** 换模型的结果回来了：落定"当前"，把"换…"擦掉 */
    settle(id) {
      pending = '';
      if (data) data.current = id || data.current;
      if (open) render();
    },
    /** 打开着就重画（比如服务端说"这一轮还在跑"） */
    repaint() { if (open) render(); },
    rows: () => rowById.size,
    /** 自测用：当前渲染出来的行（id → 是否可选） */
    debugRows: () => [...rowById.keys()],
  };
}
