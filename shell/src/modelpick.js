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
 * 它是 glass 面板（和「思考过程」同一套材质），外面围同一圈**粒子框** ----
 * 这一层里没有"边框"，一块区域要被圈出来只能是粒子自己围（traceframe.js）。
 * 框由 deskagent 管：它俩同时只开一块玻璃，所以框在两者之间挪，不是各开一个。
 *
 * 还有一条只有真浏览器才看得见的：**它必须自己 `pointer-events: auto`**
 * （`.ag-layer` 是 none，桌面要能从这一层下面拖球）。少了它就是"看得见、点不动"，
 * 而 DOM 的 click 不报错 —— 用 `el.click()` 做自测是绕过命中测试的，挡不住这个。
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
/* 看不看得见图。这一格**必须能显示"?"**：能力是向模型问出来的，
   没问过就不知道 —— 写成"不会"会让本来能用的模型被当成不能用，
   写成"会"会让它对着一张看不见的图编故事。 */
const VISION = { true: { v: '1', t: '图', d: '能看图（发过图，它认出来了）' }, false: { v: '0', t: '图', d: '看不了图：接口不收图片' }, null: { v: '?', t: '?', d: '还没测过（用一次 fs_view 就知道了）' } };

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
  let sig = '';             // 上一次画出来的那张表（判断"要不要重画"）
  let open = false;
  let pending = '';         // 正在换的那个 id（等 model 事件落定）
  const rowById = new Map();

  function currentModel() {
    return data?.groups?.flatMap((g) => g.models).find((m) => m.id === data.current) || null;
  }

  /* 一次"这张表长什么样"的指纹。打开面板时会先显示上次拿到的表、随即再去要一份新的
     （要紧的是"刚 pull 的模型立刻能看见"）。但那一次刷新**大多什么都没变** ——
     如果照样重建 DOM，正在按下、还没抬起的那一下就被丢了：
     按钮在 mousedown 和 mouseup 之间被换成了新节点，click 不成立。
     实测线上就是这么丢过一次点击（点下去什么都不发生）。所以内容一样就不重画。 */
  function fingerprint(d) {
    if (!d) return '';
    return JSON.stringify({
      c: d.current, b: !!d.busy,
      g: (d.groups || []).map((g) => [g.key, g.label, g.note, g.empty,
        (g.models || []).map((m) => [m.id, m.name, m.org, m.usable, m.why, m.think, m.tools, m.cost,
          m.price && [m.price.in, m.price.out, !!m.price.free], m.note, m.speed, m.vision])]),
    });
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
    const bits = [t.org, t.note, t.speed ? `实测 ${t.speed}` : '',
      t.vision === false ? '看不了图' : t.vision === true ? '能看图' : '',
      t.why || ''].filter(Boolean);
    foot.textContent = bits.join(' · ');
  }

  function render() {
    const hadRows = rowById.size;
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
        for (const [tbl, val] of [[THINK, m.think], [TOOLS, m.tools], [VISION, m.vision]]) {
          const d = tbl[val] || tbl.null;
          const tag = el('span', 'mt', d.t);
          tag.dataset.v = d.v;
          /* "图"这一格要说出来处：模型卡写的、Ollama 自报的、还是真发图撞出来的。
             "为什么说它能看图"必须能回答 —— 否则这个标签就是在替用户下结论。 */
          tag.title = tbl === VISION && m.visionWhy ? `${d.d}（${m.visionWhy}）` : d.d;
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
    /* 行数变了面板就长高了（比如表刚从服务端回来），外面那圈粒子框跟着走 ——
       否则框会停在"空玻璃"那个高度上，看起来像围错了地方。 */
    if (open && rowById.size !== hadRows) requestAnimationFrame(() => o.onResize?.());
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
    /* 16 而不是 8：外面还有一圈 8px 的粒子框，贴太近那圈会压在状态条那行字上 */
    root.style.top = `${Math.round(rect.bottom + 16)}px`;
    /* 高度上限按"到屏幕底部还剩多少"算，不写死 —— 短窗口里写死会顶出去 */
    root.style.maxHeight = `${Math.max(220, innerHeight - rect.bottom - 56)}px`;
    open = true;
    /* 先报一次几何：框要在玻璃出现的同时就在那儿，不能等第一行数据回来才长出来 */
    requestAnimationFrame(() => o.onResize?.());
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

  /** 面板现在占的那块地方（页面坐标）。粒子框照着它画，所以必须是**真实**盒子。 */
  function rect() {
    if (!open) return null;
    const r = root.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }

  return {
    el: root,
    rect,
    openAt,
    close,
    isOpen,
    hit,
    /** @param {object} d 服务端 `/api/models` 的返回 */
    setData(d) {
      data = d;
      if (pending && d.current === pending) pending = '';
      if (!open) return;
      const f = fingerprint(d);
      if (f === sig) return;      // 一模一样就不要再建一遍节点（会丢正在按下的那一下）
      sig = f;
      render();
    },
    /** 换模型的结果回来了：落定"当前"，把"换…"擦掉 */
    settle(id) {
      pending = '';
      if (data) data.current = id || data.current;
      if (open) { sig = fingerprint(data); render(); }
    },
    /** 打开着就重画（比如服务端说"这一轮还在跑"） */
    repaint() { if (open) render(); },
    rows: () => rowById.size,
    /** 自测用：当前渲染出来的行（id → 是否可选） */
    debugRows: () => [...rowById.keys()],
  };
}
