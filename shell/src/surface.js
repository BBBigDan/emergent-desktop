/**
 * 声明式渲染树 → DOM。
 *
 * 为什么不是 HTML：渲染发生在我们自己的 origin 里，一段 <script> 就等于
 * 把 cookie 交出去；而且模型产出的 HTML 不可能跟上这套桌面的排版。
 * 所以模型只描述「这是什么」（表 / 图 / 表单 / 进度），版式由这里决定。
 *
 * 三条硬规则（对应论证稿 §4.2）：
 *   1. 动作只能指向已注册工具（tool/args）或发一条新指令（prompt），**不接受 URL**
 *   2. 数据必须内联，渲染器不发起任何请求
 *   3. 节点预算 200，超了截断并明说截断了
 *
 * 动作的回灌是这套机制的核心：点击 → api.act()/api.ask() → 进主循环 → 工具结果
 * 或新指令回到对话。审批卡片只是它的第一个用例。
 */

const MAX_NODES = 200;

/* ───────────────────────── 小工具 ───────────────────────── */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Markdown 子集：**粗** `码` ~~删~~ 换行；只做行内，块级交给对应节点 */
function inlineMD(host, md) {
  const src = String(md ?? '');
  let i = 0;
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|~~([^~]+)~~/g;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > i) host.appendChild(document.createTextNode(src.slice(i, m.index)));
    if (m[1] != null) host.appendChild(el('strong', null, m[1]));
    else if (m[2] != null) host.appendChild(el('code', 'sf-code-inline', m[2]));
    else host.appendChild(el('del', null, m[3]));
    i = re.lastIndex;
  }
  if (i < src.length) host.appendChild(document.createTextNode(src.slice(i)));
}

/** 段落：按空行切，段内 \n 变 <br> */
function mdBlock(md) {
  const wrap = el('div', 'sf-text');
  String(md ?? '')
    .split(/\n{2,}/)
    .forEach((para) => {
      const p = el('p');
      para.split('\n').forEach((line, k) => {
        if (k) p.appendChild(document.createElement('br'));
        inlineMD(p, line);
      });
      wrap.appendChild(p);
    });
  return wrap;
}

/* ───────────────────────── 动作 ───────────────────────── */

/**
 * 动作描述 → 按钮。只认三种来源：tool / prompt / submit。
 * 任何 URL 形状（http:、//、javascript:）一律丢弃 —— 钓鱼防线在这里，不在提示词里。
 */
function actionButton(a, api, cls = 'sf-btn') {
  const label = a?.label ?? a?.title ?? '执行';
  const b = el('button', cls, label);
  if (a?.kind === 'danger') b.classList.add('sf-danger');
  if (a?.kind === 'primary' || a?.primary) b.classList.add('sf-primary');

  const tool = typeof a?.tool === 'string' && /^[a-z][a-z0-9_]{1,40}$/i.test(a.tool) ? a.tool : null;
  const prompt = typeof a?.prompt === 'string' ? a.prompt : null;

  if (!tool && !prompt) {
    b.disabled = true;
    b.title = '这个动作没有指向任何工具或指令';
    return b;
  }
  b.addEventListener('click', () => {
    if (b.dataset.busy) return;
    b.dataset.busy = '1';
    b.classList.add('sf-busy');
    /* 点完就还权给主循环：界面上不假装自己知道结果 */
    if (tool) api.act?.({ tool, args: a.args ?? {}, label });
    else api.ask?.(prompt, { label });
    setTimeout(() => {
      delete b.dataset.busy;
      b.classList.remove('sf-busy');
    }, 1200);
  });
  return b;
}

/* ───────────────────────── 图表 ───────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

const PALETTE = ['#6fc6ff', '#4ee0c8', '#b9a6ff', '#ffb257', '#ff7c93'];

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

/**
 * 折线 / 柱 / 饼。手写 SVG 而不是引图表库：这套界面只有 6400 个粒子在动，
 * 再来一个 200KB 的图表库只为画四根柱子不值当，而且样式对不齐。
 */
function chart(node) {
  const W = 720;
  const H = Math.max(96, Number(node.height) || 170);
  const kind = node.kind || 'line';
  const series = (Array.isArray(node.series) ? node.series : []).filter(isObj).slice(0, 4);
  const xs = Array.isArray(node.x) ? node.x : [];

  const root = svg('svg', {
    class: 'sf-svg',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    role: 'img',
  });

  const padL = 44, padR = 12, padT = 12, padB = xs.length ? 22 : 8;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const all = series.flatMap((s) => (Array.isArray(s.data) ? s.data.map(Number) : []));
  const vmax = niceMax(Math.max(1e-9, ...all));
  const n = Math.max(1, ...series.map((s) => (Array.isArray(s.data) ? s.data.length : 0)));

  if (kind === 'pie') {
    const d = (series[0]?.data || []).map((v) => Math.max(0, Number(v) || 0));
    const total = d.reduce((a, b) => a + b, 0) || 1;
    const R = Math.min(iw, ih) / 2 - 2;
    const cx = padL + iw / 2;
    const cy = padT + ih / 2;
    let acc = -Math.PI / 2;
    d.forEach((v, i) => {
      const a0 = acc;
      const a1 = acc + (v / total) * Math.PI * 2;
      acc = a1;
      if (a1 - a0 < 1e-4) return;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = [
        `M ${cx} ${cy}`,
        `L ${cx + Math.cos(a0) * R} ${cy + Math.sin(a0) * R}`,
        `A ${R} ${R} 0 ${large} 1 ${cx + Math.cos(a1) * R} ${cy + Math.sin(a1) * R}`,
        'Z',
      ].join(' ');
      root.appendChild(svg('path', { d: p, fill: PALETTE[i % PALETTE.length], opacity: 0.86 }));
    });
    return root;
  }

  /* 网格 + y 轴刻度（4 格） */
  for (let g = 0; g <= 4; g++) {
    const y = padT + (ih * g) / 4;
    root.appendChild(
      svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: 'rgba(148,178,255,.13)', 'stroke-width': 1 })
    );
    const t = svg('text', {
      x: padL - 8, y: y + 3.5, 'text-anchor': 'end',
      fill: 'rgba(228,238,255,.34)', 'font-size': 10,
    });
    const val = (vmax * (4 - g)) / 4;
    t.textContent = val >= 100 ? Math.round(val) : Number(val.toFixed(1));
    root.appendChild(t);
  }

  if (kind === 'bar') {
    const groupW = iw / n;
    const barW = Math.min(26, (groupW * 0.62) / series.length);
    series.forEach((s, si) => {
      (s.data || []).forEach((raw, i) => {
        const v = Math.max(0, Number(raw) || 0);
        const h = (v / vmax) * ih;
        const x = padL + groupW * i + groupW / 2 - (barW * series.length) / 2 + barW * si;
        const r = svg('rect', {
          x, y: padT + ih - h, width: barW, height: Math.max(1, h), rx: Math.min(3, barW / 3),
          fill: s.color || PALETTE[si % PALETTE.length], opacity: 0.82,
        });
        r.appendChild(svg('title')).textContent = `${xs[i] ?? i}: ${raw}`;
        root.appendChild(r);
      });
    });
  } else {
    series.forEach((s, si) => {
      const data = (s.data || []).map((v) => Math.max(0, Number(v) || 0));
      const X = (i) => padL + (data.length > 1 ? (iw * i) / (data.length - 1) : iw / 2);
      const Y = (v) => padT + ih - (v / vmax) * ih;
      const d = data.map((v, i) => `${i ? 'L' : 'M'} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
      const color = s.color || PALETTE[si % PALETTE.length];
      if (si === 0) {
        const area = `${d} L ${X(data.length - 1)} ${padT + ih} L ${X(0)} ${padT + ih} Z`;
        const grad = svg('linearGradient', { id: `sfg${si}`, x1: 0, y1: 0, x2: 0, y2: 1 });
        grad.appendChild(svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.24 }));
        grad.appendChild(svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
        const defs = svg('defs');
        defs.appendChild(grad);
        root.appendChild(defs);
        root.appendChild(svg('path', { d: area, fill: `url(#sfg${si})` }));
      }
      root.appendChild(
        svg('path', {
          d, fill: 'none', stroke: color, 'stroke-width': 1.8,
          'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke',
        })
      );
    });
  }

  if (xs.length) {
    const step = Math.ceil(xs.length / 7);
    xs.forEach((lab, i) => {
      if (i % step) return;
      const isBar = kind === 'bar';
      const x = isBar ? padL + (iw / n) * (i + 0.5) : padL + (xs.length > 1 ? (iw * i) / (xs.length - 1) : iw / 2);
      const t = svg('text', {
        x, y: H - 6, 'text-anchor': isBar ? 'middle' : 'middle',
        fill: 'rgba(228,238,255,.34)', 'font-size': 10,
      });
      t.textContent = lab;
      root.appendChild(t);
    });
  }
  return root;
}

/** 图表外部：标题 + 图例 + 结论句 */
function chartBox(node) {
  const box = el('div', 'sf-chart');
  if (node.title) box.appendChild(el('div', 'sf-chart-title', node.title));
  if (node.series?.length > 1 || node.legend) {
    const lg = el('div', 'sf-legend');
    node.series.forEach((s, i) => {
      const it = el('span', 'sf-legend-item');
      const dot = el('i');
      dot.style.background = s.color || PALETTE[i % PALETTE.length];
      it.append(dot, el('span', null, s.name ?? `序列 ${i + 1}`));
      lg.appendChild(it);
    });
    box.appendChild(lg);
  }
  box.appendChild(chart(node));
  if (node.note) box.appendChild(mdBlock(node.note)).classList.add('sf-note');
  return box;
}

/* ───────────────────────── 节点 ───────────────────────── */

const NODE = {
  text: (node) => mdBlock(node.md ?? node.text),

  code: (node) => {
    const box = el('div', 'sf-codebox');
    const head = el('div', 'sf-codehead');
    head.appendChild(el('span', 'sf-lang', node.lang || 'text'));
    const copy = el('button', 'sf-mini', '复制');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(node.code ?? ''));
        copy.textContent = '已复制';
      } catch {
        copy.textContent = '复制失败';
      }
      setTimeout(() => (copy.textContent = '复制'), 1400);
    });
    head.appendChild(copy);
    box.appendChild(head);
    const pre = el('pre', 'sf-pre');
    pre.textContent = String(node.code ?? '');
    box.appendChild(pre);
    return box;
  },

  table: (node, api) => {
    const box = el('div', 'sf-tablebox');
    /* 两种写法都收：
     *   正规：columns:[{key,label}] + rows:[{key:value}]
     *   简写：head:['名字','大小'] + rows:[['a','1']]
     * 简写是模型最常写的形状（"table 当然有表头"），而一个字段对不上就是整张空表 ——
     * 空表比"稍微丑一点的表"糟得多，所以这里认它。 */
    const short = !Array.isArray(node.columns) && Array.isArray(node.head);
    const cols = short
      ? node.head.map((h, i) => ({ key: `c${i}`, label: String(h) }))
      : (Array.isArray(node.columns) ? node.columns : []).filter(isObj);
    let rows = (Array.isArray(node.rows) ? node.rows : []);
    if (short) {
      rows = rows.map((r) => (Array.isArray(r)
        ? Object.fromEntries(r.map((v, i) => [`c${i}`, v]))
        : r));
    }
    rows = rows.filter(isObj);
    const table = el('table', 'sf-table');

    const thead = el('thead');
    const htr = el('tr');
    cols.forEach((c) => {
      const th = el('th', c.align === 'right' ? 'sf-right' : null, c.label ?? c.key ?? '');
      if (c.width) th.style.width = typeof c.width === 'number' ? `${c.width}px` : String(c.width);
      htr.appendChild(th);
    });
    if (node.rowActions || rows.some((r) => r.actions?.length)) htr.appendChild(el('th', 'sf-right', ''));
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    rows.slice(0, 80).forEach((r) => {
      const tr = el('tr');
      cols.forEach((c) => {
        const td = el('td', c.align === 'right' ? 'sf-right' : null);
        if (c.mono) td.classList.add('sf-mono');
        const v = r[c.key];
        if (c.bar && typeof v === 'number') {
          /* 列内条：面积表里"哪一行最占地方"扫一眼就出来 */
          const cell = el('div', 'sf-cellbar');
          const fill = el('i');
          fill.style.width = `${Math.min(100, (v / (c.barMax || Math.max(1, ...rows.map((x) => Number(x[c.key]) || 0)))) * 100)}%`;
          cell.append(fill, el('span', null, r[c.labelFallback || c.key]));
          td.appendChild(cell);
        } else if (c.badge) {
          /* 判断列：值可以是 "正常"，也可以是 {text,tone} —— 后者能精确控色 */
          const text = isObj(v) ? v.text ?? v.label : v;
          const tone = (isObj(v) ? v.tone : c.tone) || 'info';
          td.appendChild(el('span', `sf-badge t-${String(tone).replace(/[^a-z]/gi, '')}`, text ?? ''));
        } else {
          inlineMD(td, v ?? '');
        }
        tr.appendChild(td);
      });
      const acts = (r.actions || []).filter(isObj).slice(0, 3);
      if (node.rowActions || acts.length) {
        const td = el('td', 'sf-right sf-rowact');
        acts.forEach((a) => td.appendChild(actionButton(a, api, 'sf-mini')));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);

    if (node.footer) {
      const f = el('div', 'sf-tablefoot');
      mdBlock(node.footer).childNodes.forEach((x) => f.appendChild(x));
      box.appendChild(f);
    }
    if (rows.length > 80) box.appendChild(el('div', 'sf-trunc', `只显示前 80 行（共 ${rows.length} 行）`));
    return box;
  },

  list: (node, api) => {
    const ul = el('div', 'sf-list');
    (Array.isArray(node.items) ? node.items : []).slice(0, 60).forEach((it) => {
      const row = el('div', 'sf-li');
      const item = typeof it === 'string' ? { title: it } : it;
      if (item.icon) {
        const ic = el('span', 'sf-li-icon');
        inlineMD(ic, item.icon);
        row.appendChild(ic);
      }
      const body = el('div', 'sf-li-body');
      body.appendChild(el('div', 'sf-li-title', item.title ?? item.name ?? ''));
      if (item.sub || item.detail) body.appendChild(el('div', 'sf-li-sub', item.sub ?? item.detail));
      row.appendChild(body);
      if (item.value != null) row.appendChild(el('div', 'sf-li-val', item.value));
      (item.actions || []).slice(0, 2).forEach((a) => row.appendChild(actionButton(a, api, 'sf-mini')));
      ul.appendChild(row);
    });
    return ul;
  },

  chart: (node) => chartBox(node),

  progress: (node) => {
    const box = el('div', 'sf-prog');
    const v = Number(node.value ?? 0);
    const pct = Math.max(0, Math.min(1, node.percent != null ? v / 100 : v));
    const head = el('div', 'sf-prog-head');
    head.appendChild(el('span', 'sf-prog-label', node.label ?? '进行中'));
    head.appendChild(el('span', 'sf-prog-num', `${Math.round(pct * 100)}%`));
    box.appendChild(head);
    const track = el('div', 'sf-track');
    const fill = el('i');
    fill.style.width = `${pct * 100}%`;
    if (node.state === 'done') fill.classList.add('sf-done');
    if (node.state === 'error') fill.classList.add('sf-err');
    track.appendChild(fill);
    box.appendChild(track);
    if (node.detail) box.appendChild(el('div', 'sf-prog-detail', node.detail));
    if (Array.isArray(node.steps)) {
      const st = el('div', 'sf-steps');
      node.steps.slice(0, 12).forEach((s) => {
        const row = el('div', 'sf-step');
        const mark = s.state === 'done' ? '✓' : s.state === 'active' ? '●' : '○';
        row.appendChild(el('span', `sf-step-mark sf-${s.state || 'todo'}`, mark));
        row.appendChild(el('span', 'sf-step-text', typeof s === 'string' ? s : s.label ?? ''));
        st.appendChild(row);
      });
      box.appendChild(st);
    }
    return box;
  },

  approval: (node, api) => {
    const box = el('div', 'sf-approval');
    const head = el('div', 'sf-ap-head');
    head.appendChild(el('span', 'sf-ap-dot'));
    head.appendChild(el('span', 'sf-ap-title', node.title ?? '需要你确认'));
    box.appendChild(head);
    if (node.detail) box.appendChild(mdBlock(node.detail));
    if (node.diff) {
      const pre = el('pre', 'sf-pre sf-diff');
      String(node.diff)
        .split('\n')
        .forEach((line) => {
          const d = el('div', line.startsWith('+') ? 'sf-add' : line.startsWith('-') ? 'sf-del' : null, line || ' ');
          pre.appendChild(d);
        });
      box.appendChild(pre);
    }
    const acts = el('div', 'sf-actions');
    const allow = actionButton(
      { label: node.allowLabel ?? '允许', tool: node.tool, args: node.args, kind: 'primary' },
      api,
      'sf-btn'
    );
    allow.classList.add('sf-primary');
    const deny = actionButton({ label: node.denyLabel ?? '取消', prompt: node.denyPrompt ?? '取消这个操作' }, api);
    acts.append(allow, deny);
    box.appendChild(acts);
    return box;
  },

  actions: (node, api) => {
    const box = el('div', 'sf-actions');
    (Array.isArray(node.items) ? node.items : []).slice(0, 6).forEach((a) => {
      box.appendChild(actionButton(a, api, 'sf-btn'));
    });
    return box;
  },

  form: (node, api) => {
    const form = el('form', 'sf-form');
    const fields = (Array.isArray(node.fields) ? node.fields : []).filter(isObj).slice(0, 12);
    fields.forEach((f) => {
      const row = el('label', 'sf-field');
      const lab = el('span', 'sf-flabel', f.label ?? f.name ?? '');
      if (f.required) lab.appendChild(el('i', 'sf-req', '*'));
      row.appendChild(lab);

      let input;
      if (f.type === 'textarea') {
        input = el('textarea', 'sf-input');
        input.rows = f.rows || 3;
        input.value = f.value ?? '';
      } else if (f.type === 'select') {
        input = el('select', 'sf-input');
        (f.options || []).forEach((o) => {
          const opt = el('option', null, isObj(o) ? o.label : o);
          opt.value = isObj(o) ? o.value ?? o.label : o;
          input.appendChild(opt);
        });
        if (f.value != null) input.value = f.value;
      } else if (f.type === 'checkbox') {
        input = el('input', 'sf-check');
        input.type = 'checkbox';
        input.checked = !!f.value;
      } else {
        input = el('input', 'sf-input');
        input.type = f.type === 'number' ? 'number' : 'text';
        input.value = f.value ?? '';
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.name = f.name ?? f.label ?? `f${fields.indexOf(f)}`;
      if (f.required) input.required = true;
      row.appendChild(input);
      if (f.hint) row.appendChild(el('span', 'sf-hint', f.hint));
      form.appendChild(row);
    });

    const acts = el('div', 'sf-actions');
    const ok = el('button', 'sf-btn sf-primary', node.submitLabel ?? '提交');
    ok.type = 'submit';
    acts.appendChild(ok);
    form.appendChild(acts);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = {};
      fields.forEach((f) => {
        const input = form.elements[f.name ?? f.label];
        if (!input) return;
        data[f.name ?? f.label] = f.type === 'checkbox' ? input.checked : input.value;
      });
      /* 表单值的归宿：要么作为工具参数（tool），要么作为一句话指令（prompt） */
      if (node.tool) api.act?.({ tool: node.tool, args: { ...(node.args || {}), ...data }, label: node.submitLabel });
      else api.ask?.(node.promptTemplate ? fillTemplate(node.promptTemplate, data) : JSON.stringify(data), {
        label: node.submitLabel,
      });
      ok.textContent = '已提交';
      ok.disabled = true;
      setTimeout(() => {
        ok.textContent = node.submitLabel ?? '提交';
        ok.disabled = false;
      }, 1500);
    });
    return form;
  },

  image: (node) => {
    /* 只认壳层自己发的 blob: 或 /blob/ 路径，外链一律不加载（否则对方能统计"你看了这条消息"） */
    const src = String(node.src ?? '');
    const ok = /^blob:/.test(src) || src.startsWith('/blob/') || src.startsWith('/agent/blob/');
    if (!ok) return el('div', 'sf-blocked', `图片被拦下：只接受本地资源（${node.alt || '无说明'}）`);
    const fig = el('figure', 'sf-fig');
    const img = el('img');
    img.src = src;
    img.alt = node.alt || '';
    img.loading = 'lazy';
    fig.appendChild(img);
    if (node.caption) fig.appendChild(el('figcaption', null, node.caption));
    return fig;
  },

  file: (node) => {
    const row = el('div', 'sf-file');
    row.appendChild(el('span', 'sf-file-icon', '▤'));
    const body = el('div', 'sf-li-body');
    body.appendChild(el('div', 'sf-li-title', node.name ?? node.path ?? ''));
    body.appendChild(el('div', 'sf-li-sub', node.path ?? ''));
    row.appendChild(body);
    if (node.size) row.appendChild(el('div', 'sf-li-val', node.size));
    return row;
  },

  section: (node, api, depth) => {
    const box = el('section', 'sf-section');
    if (node.title) box.appendChild(el('h3', 'sf-h3', node.title));
    (node.children || []).forEach((c) => {
      const n = build(c, api, depth + 1);
      if (n) box.appendChild(n);
    });
    return box;
  },

  /* box = 无标题的 section。
     它存在的唯一理由是模型太爱写 "box"（实测第一次调 surface_render 就写了），
     而一个"未知节点"整块渲染失败，等于整屏白给。与其纠正它，不如认下这个词。 */
  box: (node, api, depth) => {
    const wrap = el('div', 'sf-box');
    (node.children || []).forEach((c) => {
      const n = build(c, api, depth + 1);
      if (n) wrap.appendChild(n);
    });
    return wrap;
  },

  tabs: (node, api) => {
    const box = el('div', 'sf-tabs');
    const bar = el('div', 'sf-tabbar');
    const panes = [];
    (node.children || []).slice(0, 6).forEach((child, i) => {
      const b = el('button', 'sf-tab', child.title ?? `标签 ${i + 1}`);
      b.addEventListener('click', () => {
        bar.querySelectorAll('.sf-tab').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        panes.forEach((p, k) => (p.hidden = k !== i));
      });
      if (!i) b.classList.add('on');
      bar.appendChild(b);
      const pane = el('div', 'sf-pane');
      (child.children || []).forEach((c) => {
        const n = build(c, api, 0);
        if (n) pane.appendChild(n);
      });
      pane.hidden = i > 0;
      panes.push(pane);
    });
    box.append(bar, ...panes);
    return box;
  },

  html: (node) => {
    const box = el('div', 'sf-html');
    const frame = el('iframe', 'sf-html-frame');
    /* 不给 allow-same-origin：这段 HTML 拿不到壳层的 cookie / DOM / storage */
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.srcdoc = String(node.srcdoc ?? '');
    box.appendChild(frame);
    return box;
  },
};

function fillTemplate(tpl, data) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (data[k] == null ? '' : String(data[k])));
}

/* ───────────────────────── 入口 ───────────────────────── */

let nodeCount = 0;

function build(node, api, depth = 0) {
  if (!isObj(node) || depth > 8) return null;
  if (++nodeCount > MAX_NODES) return null;
  const fn = NODE[node.type];
  if (!fn) {
    const box = el('div', 'sf-blocked', `未知节点：${String(node.type).slice(0, 24)}`);
    return box;
  }
  try {
    return fn(node, api, depth);
  } catch (err) {
    /* 一个坏节点不该让整棵树白屏 —— 模型写错字段是常态 */
    console.warn('[surface] node failed', node.type, err);
    return el('div', 'sf-blocked', `${node.type} 节点渲染失败`);
  }
}

/**
 * @param {{title?:string, subtitle?:string, root:object}} spec
 * @param {{act?:(a:{tool:string,args:object,label?:string})=>void, ask?:(p:string,o?:object)=>void}} api
 * @returns {HTMLElement}
 */
export function renderSurface(spec, api = {}) {
  nodeCount = 0;
  const root = el('div', 'surface');
  if (!isObj(spec)) {
    root.appendChild(el('div', 'sf-blocked', '渲染树格式不对'));
    return root;
  }
  const scroll = el('div', 'sf-scroll');
  if (spec.title) {
    const head = el('div', 'sf-head');
    head.appendChild(el('h2', 'sf-title', spec.title));
    if (spec.subtitle) head.appendChild(el('div', 'sf-sub', spec.subtitle));
    scroll.appendChild(head);
  }
  const body = build(spec.root ?? spec, api, 0);
  if (body) scroll.appendChild(body);
  root.appendChild(scroll);
  if (nodeCount >= MAX_NODES) {
    root.appendChild(el('div', 'sf-trunc', `内容超过 ${MAX_NODES} 个节点，已截断`));
  }
  return root;
}

/** 只算节点数，给 agent 侧做预算检查用 */
export function countNodes(node, depth = 0) {
  if (!isObj(node) || depth > 8) return 0;
  let n = 1;
  for (const k of ['children', 'items', 'fields', 'rows']) {
    if (Array.isArray(node[k])) n += node[k].length;
  }
  if (Array.isArray(node.children)) n += node.children.reduce((a, c) => a + countNodes(c, depth + 1), 0);
  return n;
}
