/**
 * 设置面板 —— 点状态条右端那个「设置」打开的玻璃。
 *
 * 三块，正好是"哪些东西本来只能改 .env 再重启"的那三块：
 *
 *   · **接口**：加一个新的 API 地址（任何 OpenAI 兼容的端点）。加完它就会出现在
 *     换模型那张表的「自定义」组里 —— 这两件事共用同一份数据（`settings.providers`），
 *     所以"加了但列表里没有"这种事不会发生。
 *   · **提示词**：默认**追加**在内置那套后面。内置那段不是自我介绍，是**场的说明书**
 *     （有哪些工具、`scene_show` 的字段、label 几个字、一轮说多少）—— 删了它，
 *     模型还会聊天，但再也铺不出一屏。所以"整段替换"收在一个开关后面，
 *     并且开关下面写清代价。
 *   · **行为**：温度、每轮步数。前者改"怎么说话"，后者是安全网。
 *
 * 几条从上一轮学来的、只有真浏览器才现形的规矩（都在这里落到了实处）：
 *
 *   1. **必须自己 `pointer-events: auto`**。祖先是 `.ag-layer { pointer-events: none }`，
 *      少了它就是"看得见、点不动"，而 DOM 的 click 不报错。
 *   2. **不要整块重渲染**。输入框在打字时被换掉 = 焦点丢失、光标跳走。
 *      所以结构只建一次，输入直接写进 `draft`；只有增删一条接口才重建列表。
 *   3. **保存要能看见结果**。底部那行必须在保存后说"存哪了、几个字、下一轮生效"，
 *      否则用户按一下按钮，屏幕上什么都没变 —— 和没按一样。
 */

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const clone = (o) => JSON.parse(JSON.stringify(o ?? null));

/** 两段字数：说清"你写的是加在 9745 字后面，还是替掉了它" */
const nfmt = (n) => `${n} 字`;

export function createSettings(o = {}) {
  const api = o.api || '/agent/api';

  const root = el('div', 'ag-set');
  root.hidden = true;

  const hd = el('div', 'as-hd');
  const title = el('b', 'as-title', '设置');
  const meta = el('em', 'as-meta');
  const x = el('button', 'as-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', '收起');
  hd.append(title, meta, x);

  const tabsEl = el('div', 'as-tabs');
  const TABS = [['api', '接口'], ['prompt', '提示词'], ['beh', '行为']];
  const tabBtn = new Map();
  for (const [k, label] of TABS) {
    const b = el('button', `as-tab${k === 'api' ? ' on' : ''}`, label);
    b.type = 'button';
    b.dataset.tab = k;
    b.addEventListener('click', (e) => { e.stopPropagation(); show(k); });
    tabBtn.set(k, b);
    tabsEl.appendChild(b);
  }

  const body = el('div', 'as-body');
  const foot = el('div', 'as-foot');
  const status = el('span', 'as-status');
  const saveBtn = el('button', 'as-save', '保存');
  saveBtn.type = 'button';
  foot.append(status, saveBtn);

  root.append(hd, tabsEl, body, foot);

  let data = null;        // 服务端给的那份（含 builtin 全文）
  let draft = null;       // 正在编辑的副本
  let dirty = false;
  let tab = 'api';
  let open = false;
  let busy = false;

  function setStatus(t, cls = '') {
    status.textContent = t || '';
    status.dataset.k = cls;
  }

  function markDirty() {
    dirty = true;
    if (!busy) setStatus('有改动没保存');
  }

  /* ───────────────────────── 接口 ───────────────────────── */

  function field(label, ph, val, onInput, opts = {}) {
    const wrap = el('label', 'as-f');
    wrap.appendChild(el('span', 'as-fl', label));
    const inp = el('input', 'as-in');
    inp.type = opts.type || 'text';
    inp.placeholder = ph || '';
    inp.value = val ?? '';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.addEventListener('input', () => onInput(inp.value));
    wrap.appendChild(inp);
    if (opts.after) wrap.appendChild(opts.after);
    return { wrap, inp };
  }

  function providerCard(p, i) {
    const card = el('div', 'as-card');

    const head = el('div', 'as-card-hd');
    const nm = el('input', 'as-in as-in-name');
    nm.placeholder = '给它的名字（比如「我的中转」）';
    nm.value = p.name || '';
    nm.autocomplete = 'off';
    nm.addEventListener('input', () => { p.name = nm.value; markDirty(); });
    const del = el('button', 'as-del', '删掉');
    del.type = 'button';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      draft.providers.splice(i, 1);
      markDirty();
      renderBody();          // 增删要重建，输入中的那一张已经不在列表里了
    });
    head.append(nm, del);
    card.appendChild(head);

    /* 地址 + 测一下。测是**单独**的一个动作：测通了不自动保存（见 probe 的说明）。 */
    const res = el('div', 'as-res');
    const { wrap: aw, inp: addr } = field('地址', 'https://your-gateway.example/v1', p.baseURL, (v) => {
      p.baseURL = v;
      markDirty();
    });
    const test = el('button', 'as-test', '测一下');
    test.type = 'button';
    test.addEventListener('click', async (e) => {
      e.stopPropagation();
      test.disabled = true;
      res.textContent = '正在问它有哪些模型…';
      res.dataset.k = '';
      try {
        const r = await fetch(`${api}/settings/probe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseURL: addr.value, id: p.id, apiKey: p.__key }),
        });
        const j = await r.json();
        if (j.ok) {
          const has = (j.models || []).length;
          res.textContent = has
            ? `通了（${j.base}.models 返回 ${has} 个）${j.note ? ` · ${j.note}` : ''}`
            : `通了 · ${j.note || '没拿到清单'}`;
          res.dataset.k = 'ok';
          /* 模型名还空着就把清单填进去 —— 用户点「测一下」往往正是为了这个 */
          if (has && !String(p.models || []).trim()) {
            p.models = j.models.slice(0, 12).join(', ');
            modelsIn.value = p.models;
            markDirty();
          }
        } else {
          res.textContent = j.error || '连不上';
          res.dataset.k = 'err';
        }
      } catch (err) {
        res.textContent = `测不了：${err.message || err}`;
        res.dataset.k = 'err';
      } finally {
        test.disabled = false;
      }
    });
    aw.appendChild(test);
    card.appendChild(aw);

    /* Key。**面板里显示的是"已保存 …abcd"，不是明文** —— 这块玻璃会被投到屏幕上、
       被截图，而 key 和一句提示词泄露的代价不是一回事。
       留空 = 不改（服务端按"字段没给"处理），要清掉点那个「清掉」。 */
    const clear = el('button', 'as-clear', '清掉');
    clear.type = 'button';
    clear.hidden = !p.hasKey;
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      p.__key = '';
      p.hasKey = false;
      p.keyTail = '';
      keyIn.value = '';
      keyIn.placeholder = '不填就是不校验 key';
      clear.hidden = true;
      markDirty();
    });
    const { wrap: kw, inp: keyIn } = field('Key', p.hasKey ? `已保存 …${p.keyTail}，留空不改` : 'sk-…（有些自建网关不需要）', '', (v) => {
      p.__key = v;
      markDirty();
    }, { type: 'password', after: clear });
    card.appendChild(kw);

    /* 模型名。一行逗号分隔 —— 这里不该逼用户点 12 次「加一行」 */
    const mw = el('label', 'as-f');
    mw.appendChild(el('span', 'as-fl', '模型'));
    const modelsIn = el('textarea', 'as-in as-ta-model');
    modelsIn.rows = 2;
    modelsIn.placeholder = 'gpt-4o-mini, openai/gpt-4o（逗号或换行分隔）';
    modelsIn.value = Array.isArray(p.models) ? p.models.join(', ') : (p.models || '');
    modelsIn.addEventListener('input', () => { p.models = modelsIn.value; markDirty(); });
    mw.appendChild(modelsIn);
    mw.appendChild(el('span', 'as-hint2', '这些名字会出现在换模型那张表的「自定义」组里；会不会思考、会不会调工具没测过，表里写 ?'));
    card.appendChild(mw);

    card.appendChild(res);
    return card;
  }

  function renderApi() {
    const wrap = el('div', 'as-sec');
    wrap.appendChild(el('p', 'as-intro',
      '任何 OpenAI 兼容的接口都能加进来（自己的中转、内网网关、别家的兼容层）。'
      + '存好之后，它会出现在左上角名字点开的「自定义」组里，可以直接切过去。'));

    const list = el('div', 'as-list');
    if (!draft.providers.length) {
      /* 空态那行要**短**：它居中显示，长了会断成两行、第二行只剩两三个字。 */
      list.appendChild(el('div', 'as-empty',
        '还没有自定义接口。点下面加一个 —— 地址填到 /v1 就行。'));
    }
    draft.providers.forEach((p, i) => list.appendChild(providerCard(p, i)));
    wrap.appendChild(list);

    const add = el('button', 'as-add', '+ 加一个接口');
    add.type = 'button';
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      draft.providers.push({ id: '', name: '', baseURL: '', models: '', hasKey: false, keyTail: '' });
      markDirty();
      renderBody();
      /* 新加的那张在最后，滚过去 —— 否则按了按钮屏幕上没变化（它在折叠线以下） */
      requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    });
    wrap.appendChild(add);
    return wrap;
  }

  /* ───────────────────────── 提示词 ───────────────────────── */

  function renderPrompt() {
    const wrap = el('div', 'as-sec');
    const p = draft.prompt;
    const isReplace = !!String(p.replace || '').trim();

    /* 模式：两个小按钮。**默认是追加** —— 理由写在 as-intro 里。 */
    const seg = el('div', 'as-seg');
    const bAdd = el('button', `as-sg${isReplace ? '' : ' on'}`, '追加在内置后面');
    const bRep = el('button', `as-sg${isReplace ? ' on' : ''}`, '整段替换');
    bAdd.type = 'button';
    bRep.type = 'button';
    bAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      /* 从"替换"切回"追加"：把替换那段搬到追加栏里，别让它凭空消失 */
      if (String(p.replace).trim()) {
        p.append = [p.append, p.replace].filter((s) => String(s || '').trim()).join('\n\n');
        p.replace = '';
      }
      dirty = true;
      renderBody();
    });
    bRep.addEventListener('click', () => {
      /* 切到"替换"时，把内置那套**预填**进去再让人改。
         不预填的话，用户面对一块空白，第一句话就写"你是一个AI助手" ——
         而真正要保留的是"你能铺一屏、工具怎么调"。预填是这里唯一负责任的做法。 */
      if (!String(p.replace).trim()) p.replace = String(data?.builtin || '');
      dirty = true;
      renderBody();
    });
    seg.append(bAdd, bRep);
    wrap.appendChild(seg);

    if (!isReplace) {
      wrap.appendChild(el('p', 'as-intro',
        `内置那套（${nfmt(data?.builtinChars || 0)}）一个字不动，你说的写在它后面。`
        + '那套不是自我介绍，是这块屏的说明书：能用哪些工具、一屏写多少字、什么必须调工具。'));
      const ta = el('textarea', 'as-in as-ta');
      ta.value = p.append || '';
      ta.placeholder = '比如：别叫我「您」；涉及重启这种操作先问我一句；回答尽量短。';
      ta.addEventListener('input', () => { p.append = ta.value; markDirty(); });
      wrap.appendChild(ta);
    } else {
      wrap.appendChild(el('p', 'as-warn',
        '整段替换：内置那套会被**完全**换掉。工具怎么调、一屏最多几个字、'
        + '哪些数字必须查过才能说 —— 那些都写在里面。删掉了它照样会聊天，'
        + '但多半再也铺不出一屏，而且看起来会像"它变笨了"。'));
      const ta = el('textarea', 'as-in as-ta as-ta-big');
      ta.value = p.replace || '';
      ta.addEventListener('input', () => { p.replace = ta.value; markDirty(); });
      wrap.appendChild(ta);
      const back = el('button', 'as-link', '还是用内置那套');
      back.type = 'button';
      back.addEventListener('click', (e) => {
        e.stopPropagation();
        p.replace = '';
        dirty = true;
        renderBody();
      });
      wrap.appendChild(back);
    }

    const chars = String(p.replace || '').trim()
      ? String(p.replace || '').trim().length
      : (data?.builtinChars || 0) + String(p.append || '').trim().length;
    wrap.appendChild(el('div', 'as-count', `下一次请求会发 ${nfmt(chars)}`));

    /* 内置那段可以看（折叠）。**要能看见**：用户改提示词时最常犯的错是
       "重复说一遍它已经知道的"，而只有让他读到原文才知道哪些说过了。 */
    const det = el('details', 'as-det');
    const sum = el('summary', 'as-sum', '看看内置那段到底写了什么');
    const pre = el('pre', 'as-pre');
    pre.textContent = String(data?.builtin || '（还没取到）');
    det.append(sum, pre);
    wrap.appendChild(det);
    return wrap;
  }

  /* ───────────────────────── 行为 ───────────────────────── */

  function slider(label, min, max, step, val, fmt, onInput, hint) {
    const wrap = el('div', 'as-f as-f-sl');
    const top = el('div', 'as-fl-row');
    const lb = el('span', 'as-fl', label);
    const num = el('b', 'as-num', fmt(val));
    top.append(lb, num);
    const inp = el('input', 'as-range');
    inp.type = 'range';
    inp.min = String(min);
    inp.max = String(max);
    inp.step = String(step);
    inp.value = String(val);
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      num.textContent = fmt(v);
      onInput(v);
      markDirty();
    });
    wrap.append(top, inp);
    if (hint) wrap.appendChild(el('span', 'as-hint2', hint));
    return wrap;
  }

  function renderBeh() {
    const wrap = el('div', 'as-sec');
    const b = draft.behavior;
    wrap.appendChild(slider('温度', 0, 1.2, 0.05, b.temp,
      (v) => v.toFixed(2),
      (v) => { b.temp = v; },
      '低一点更稳（推荐 0.2~0.4）。高过 1 之后它开始写错工具参数名，而那看起来像"模型坏了"。'));

    wrap.appendChild(slider('一轮最多几步', 3, 30, 1, b.maxSteps,
      (v) => String(v),
      (v) => { b.maxSteps = v; },
      '这是安全网，不是目标：撞上了也会先要一句结论（见 README「这一轮怎么结束」）。'
      + '调小省钱但容易查不完；调到 10 以上，一轮的上下文开销会明显上去。'));

    const ro = el('div', 'as-ro');
    const rows = [
      ['数据源', data?.sys || '—'],
      ['启动时的模型', data?.model || '—'],
      ['配置文件', data?.file || '—'],
    ];
    for (const [k, v] of rows) {
      const r = el('div', 'as-ro-row');
      r.append(el('span', '', k), el('em', '', v));
      ro.appendChild(r);
    }
    wrap.appendChild(ro);
    return wrap;
  }

  /* ───────────────────────── 骨架 ───────────────────────── */

  function renderBody() {
    body.innerHTML = '';
    if (!draft) return;
    body.appendChild(tab === 'api' ? renderApi() : tab === 'prompt' ? renderPrompt() : renderBeh());
    if (!dirty && !busy) {
      setStatus(tab === 'api'
        /* 空列表时**不重复**那句"还没有自定义接口" —— 上面那块空态已经说了，
           底部再说一遍会让人以为这是两个不同的意思。 */
        ? (draft.providers.length ? `${draft.providers.length} 个自定义接口` : '')
        : tab === 'prompt'
          ? (String(draft.prompt.replace || '').trim() ? '正在用你写的那段替换' : '内置那套 + 你的追加')
          : '温度和步数对下一轮生效');
    }
  }

  function show(k) {
    if (!draft || k === tab) return;
    tab = k;
    for (const [key, b] of tabBtn) b.classList.toggle('on', key === k);
    body.scrollTop = 0;
    renderBody();
  }

  async function load() {
    setStatus('正在读设置…');
    const r = await fetch(`${api}/settings`);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    data = j;
    /* 有未保存的改动就不覆盖 —— 用户可能只是关了一下面板，回来接着写 */
    if (!dirty || !draft) draft = clone({ providers: j.providers, prompt: j.prompt, behavior: j.behavior });
    meta.textContent = j.file ? j.file.replace(/^.*[\\/]/, '') : '';
    meta.title = j.file || '';
    /* 读完必须画一遍 —— 少了这一行，打开面板看到的是**只有头和脚的空玻璃**
       （底下那行还停在"正在读设置…"）。空玻璃是最容易让人以为"坏了"的样子，
       而它其实只是没人叫醒渲染。 */
    renderBody();
    /* 高度变了，外面那圈框要跟着（第一次量的时候 body 还是空的） */
    requestAnimationFrame(() => o.onResize?.());
  }

  async function save() {
    if (!draft || busy) return;
    busy = true;
    saveBtn.disabled = true;
    setStatus('保存中…');
    try {
      const r = await fetch(`${api}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providers: draft.providers.map((p) => ({
            id: p.id || undefined,
            name: p.name,
            baseURL: p.baseURL,
            models: p.models,
            /* `__key` 三态：undefined = 不改，'' = 清掉，其它 = 换掉 */
            apiKey: p.__key === undefined ? undefined : p.__key,
          })),
          prompt: draft.prompt,
          behavior: draft.behavior,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `保存失败（HTTP ${r.status}）`);
      data = { ...data, ...j.settings };
      draft = clone(j.settings);
      dirty = false;
      const bits = ['已保存'];
      if (j.applied?.swapped) bits.push(`${j.applied.swapped} 个正在聊的会话已换上新提示词`);
      if (j.applied?.rebound) bits.push(`${j.applied.rebound} 个会话的模型回退了`);
      if (j.notes?.length) bits.push(j.notes.join('；'));
      setStatus(bits.join(' · '), 'ok');
      o.onSaved?.(j);
      /* 保存会重建 draft（id 由服务端发）——列表里的卡片要跟着换掉，
         否则下一次改动带的是旧 id，服务端会当成"新加一条" */
      renderBody();
    } catch (e) {
      setStatus(e.message || String(e), 'err');
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', (e) => { e.stopPropagation(); save(); });

  x.addEventListener('click', (e) => {
    e.stopPropagation();
    o.onClose?.();
  });

  /* ───────────────────────── 开合 ───────────────────────── */

  function openAt(rect) {
    if (!rect) return;
    root.hidden = false;
    const w = Math.min(560, Math.max(320, innerWidth - 48));
    const left = Math.max(16, Math.min(rect.left, innerWidth - w - 16));
    root.style.width = `${w}px`;
    root.style.left = `${left}px`;
    /* 16 是给外面那圈粒子框留的（和换模型表同一条规矩） */
    root.style.top = `${Math.round(rect.bottom + 16)}px`;
    root.style.maxHeight = `${Math.max(260, innerHeight - rect.bottom - 56)}px`;
    open = true;
    root.classList.add('in');
    /* 立刻报一次几何：框要在玻璃出现的同时就在那儿，不能等数据回来才长出来 */
    requestAnimationFrame(() => o.onResize?.());
    /* 每次都现取：别的标签页可能刚改过，而这块面板上显示的是"真值" */
    load().catch((e) => setStatus(`读不到设置：${e.message || e}`, 'err'));
  }

  function close() {
    if (!open) return false;
    open = false;
    root.classList.remove('in');
    setTimeout(() => { if (!open) root.hidden = true; }, 180);
    return true;
  }

  function rect() {
    if (!open) return null;
    const r = root.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }

  return {
    el: root,
    openAt,
    close,
    isOpen: () => open,
    rect,
    /** 面板盖住的地方不产生任何意图 */
    hit(px, py) {
      if (!open) return false;
      const r = root.getBoundingClientRect();
      return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
    },
    /** 别的标签页改了设置：面板开着就重新读一次（没改动的前提下） */
    refresh() { if (open && !dirty) load().catch(() => {}); },
    /** 自测用 */
    debug() {
      return {
        open, tab, dirty, busy,
        providers: (draft?.providers || []).map((p) => ({ id: p.id, name: p.name, baseURL: p.baseURL, models: p.models })),
        promptMode: String(draft?.prompt?.replace || '').trim() ? 'replace' : 'append',
        status: status.textContent,
      };
    },
    _save: save,
    _setTab: show,
  };
}
