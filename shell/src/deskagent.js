/**
 * 桌面里的 agent —— 它不是页面，是桌面的一层。
 *
 * 原来的 agent.html 自己 new 了一个 Field：同一块屏上两套粒子、两个 WebGL 上下文，
 * 用户得从桌面「跳」到另一个世界去。但设计里它是这个桌面的管家 —— 它说话用的
 * 必须是用户眼前那一批粒子。所以这里只接收桌面的 field，不建自己的：
 *
 *   open  → 接管那 6400 颗环境粒子（slotBegin），相干度先压低（溶解）再回升（凝聚）
 *   close → clearDraw，粒子按 1.6s 的回落散回球面，桌面接手
 *
 * 另有四样东西刻意不是粒子，因为它们本来就不该是：
 *   输入行（要真的 caret —— 中文输入法的候选框得挂在真实的光标上）、
 *   审批兜底带（审批是系统的 affordance，不受模型表达自由支配）、
 *   无障碍镜像（给读屏的 DOM）、
 *   底部边缘的唤起热区（它是"入口"，不是内容）。
 */

import { FieldScene } from './scene.js';
import { UI_ENV_DIM } from './field.js';
import { renderSurface } from './surface.js';
import { compileDraw } from './draw.js';
import { ParticleText, SlotAllocator } from './pui.js';
import { FONT } from './draw.js';
import { FieldA11y } from './aria.js';
import { GestureTracker, describe } from './gesture.js';
import { Pacer } from './timing.js';

const DEV = new URLSearchParams(location.search).has('dev');

/** 服务端的错误原文 → 一句人能读的短话（场里每行只有 20 格宽） */
function friendly(msg = '') {
  if (/402|balance|余额/i.test(msg)) return '模型账户没余额';
  if (/401|unauthor|invalid.*key/i.test(msg)) return '模型 key 不对';
  if (/超时|timeout/i.test(msg)) return '模型没响应';
  if (/连不上|ENOTFOUND|ECONN/i.test(msg)) return '连不上模型';
  return '模型出错了';
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/* 记录里的文字来自模型，别让它当 HTML 用（它偶尔会吐 `<` 或 `&`） */
function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * @param {object} o
 * @param {import('./field.js').Field} o.field   桌面自己的粒子场（唯一的）
 * @param {(open:boolean)=>void} [o.onOpenChange] 展开/收起时通知桌面（收拢元素、降权窗口）
 */
export function createDeskAgent({ field, onOpenChange } = {}) {
  /* ───────────────── DOM：只有四样不是粒子 ───────────────── */

  const layer = el('div', 'ag-layer');
  layer.hidden = true;

  const typeEl = el('input', 'ag-type');
  typeEl.type = 'text';
  typeEl.autocomplete = 'off';
  typeEl.spellcheck = false;
  typeEl.setAttribute('aria-label', '对 agent 说一句话');

  const inspEl = el('div', 'ag-insp');
  const statEl = el('div', 'ag-stat', '<span class="dot"></span><b>connecting</b>');
  const statTxt = statEl.querySelector('b');
  const gateEl = el('div', 'ag-gate');
  const a11yEl = el('div', 'ag-a11y');
  const hintEl = el('div', 'ag-hint', '回车发送 · 拖仪表 / 拖曲线 / 点元素 · Esc 收起');

  layer.append(typeEl, inspEl, statEl, gateEl, a11yEl, hintEl);
  if (!DEV) { inspEl.hidden = true; statEl.hidden = true; hintEl.hidden = true; }
  document.body.appendChild(layer);

  /* 唤起热区：桌面常驻，只有贴着底边才存在感 */
  const zone = el('div', 'ag-zone');
  zone.setAttribute('aria-hidden', 'true');
  document.body.appendChild(zone);

  const a11y = new FieldA11y(a11yEl);
  const pacer = new Pacer();

  /* ───────────────── 说过什么（记录） ─────────────────
   *
   * 场里只有一行，新的一句会顶掉旧的一句 —— 用户想翻回去看"刚才它到底怎么说"
   * 在界面上没有任何地方可看。这里留最近几条（服务端也存，刷新/换设备都在）。
   *
   * 它为什么是 DOM：点阵里中文要 ~30px 才认得出（见 auth 那一课的结论），
   * 12~13px 的汉字点阵必然糊成一团，而记录的全部价值就是"能读"。
   * 所以它是唯一有意不做成粒子的东西 —— 但仍然没有框、没有气泡，只是一段雾。 */

  let log = [];
  let histOpen = false;

  const histEl = el('div', 'ag-hist');
  const histIn = el('div', 'ag-hist-in');
  histEl.appendChild(histIn);
  histEl.hidden = true;

  const histBtn = el('button', 'ag-hist-btn', '↑ 记录');
  histBtn.type = 'button';
  histBtn.hidden = true;

  /* 跑着的时候，那个角上写的是"能做什么"，不是"记录"。
     两件事互斥，所以共用一个位置 —— 一秒里只能有一件事是对的。 */
  const stopBtn = el('button', 'ag-stop', '停 · Esc');
  stopBtn.type = 'button';
  stopBtn.hidden = true;

  layer.append(histEl, histBtn, stopBtn);

  /* ───────────────── 渲染树（DOM 内容） ─────────────────
   *
   * 场装不下"要读进去"的东西：表格、清单、代码、表单。它们走 DOM —— 这是
   * 论证稿 §4 的另一半，和粒子场是并列的两个输出通道，不是降级方案。
   *
   * 它和场的关系跟记录面板一样：打开时场退到后面（uiFade），因为这一屏
   * 要读，不是要"看个大概"。 */
  const surfEl = el('div', 'ag-surface');
  surfEl.hidden = true;
  const surfX = el('button', 'ag-surface-x', '×');
  surfX.type = 'button';
  surfX.setAttribute('aria-label', '收起');
  surfEl.appendChild(surfX);
  layer.appendChild(surfEl);

  let surfaceOpen = false;

  function closeSurface() {
    if (!surfaceOpen) return false;
    surfaceOpen = false;
    surfEl.classList.remove('in');
    field.uiFadeTo = 1;
    setTimeout(() => { if (!surfaceOpen) surfEl.hidden = true; }, 180);
    return true;
  }

  function showSurface(spec) {
    if (!spec) return;
    const node = renderSurface(spec, {
      /* 动作只能指向已注册工具（surface.js 的三条硬规则之一）——
         这里不执行任何东西，只把"点了什么"变成一条意图交回模型。 */
      act: (a) => {
        const label = a.label || a.tool || '操作';
        insp('act', `${a.tool || 'ask'} · ${label}`);
        closeSurface();
        send({ t: 'intent', intent: { kind: 'pick', target: 'surface', option: a.tool || 'ask', optionLabel: label, label } });
      },
      ask: (p) => {
        closeSurface();
        send({ t: 'ask', text: String(p).slice(0, 300) });
      },
    });
    for (const old of surfEl.querySelectorAll('.surface')) old.remove();
    surfEl.appendChild(node);
    surfEl.hidden = false;
    surfaceOpen = true;
    closeHist();
    requestAnimationFrame(() => surfEl.classList.add('in'));
    field.uiFadeTo = 0.18;
  }

  surfX.addEventListener('click', (e) => { e.stopPropagation(); closeSurface(); });

  function histPush(r, text) {
    const t = String(text || '').trim();
    if (!t) return;
    const last = log[log.length - 1];
    if (last && last.r === r && last.t === t) return;
    log.push({ r, t, ts: Date.now() });
    if (log.length > 40) log.splice(0, log.length - 40);
    if (histOpen) renderHist();
    histBtn.hidden = log.length < 2 || open === false;
  }

  const HHMM = (ts) => {
    const d = new Date(ts || Date.now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  function renderHist() {
    histIn.innerHTML = '';
    /* 只给最近几条：这不是聊天记录，是"刚才"。再往前翻也没有上下文了。 */
    const rows = log.slice(-10);
    for (const e of rows) {
      const row = el('div', `hrow ${e.r}`);
      row.append(el('span', 'hm', e.r === 'a' ? '场' : e.r === 'i' ? '手' : '我'),
        el('p', '', escapeHTML(e.t)),
        el('i', 'ht', HHMM(e.ts)));
      histIn.appendChild(row);
    }
    histIn.scrollTop = histIn.scrollHeight;
  }

  function openHist() {
    if (open === false || !log.length) return;
    histOpen = true;
    renderHist();
    histEl.hidden = false;
    histBtn.classList.add('on');
    requestAnimationFrame(() => histEl.classList.add('in'));
    /* 翻记录时把场推到后面（uiFade），而不是撤掉它。
       两样东西叠在一起时，谁都不该被另一个"关掉" —— 用户只是回头看一眼，
       不是离开这一屏。压到 0.1 之后字读得清，球还在动，回来也是原位。 */
    field.uiFadeTo = 0.1;
  }

  function closeHist() {
    if (!histOpen) return;
    histOpen = false;
    histEl.classList.remove('in');
    histBtn.classList.remove('on');
    field.uiFadeTo = 1;
    setTimeout(() => { if (!histOpen) histEl.hidden = true; }, 180);
  }

  histBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    histOpen ? closeHist() : openHist();
  });

  /* 停。给的是"停"而不是"取消"：这一轮已经产生的读数、已经铺开的那一屏
     都属于用户看过的内容，不该被撤回 —— 撤回是"什么都没发生"，
     而事实上发生了一半。 */
  function abortAsk() {
    if (!busy) return;
    insp('stop', '你按了停');
    send({ t: 'abort' });
    stopBtn.textContent = '停…';
    /* 服务端一般 100ms 内回 idle；万一没回，别让按钮永远卡在"停…" */
    setTimeout(() => { stopBtn.textContent = '停 · Esc'; }, 3000);
  }
  stopBtn.addEventListener('click', (e) => { e.stopPropagation(); abortAsk(); });
  /* 点在雾以外就收起：没有遮罩层，就不该有"点哪儿都关不掉"的感觉 */
  addEventListener('pointerdown', (e) => {
    if (!histOpen) return;
    if (e.target instanceof Element && e.target.closest('.ag-hist, .ag-hist-btn')) return;
    closeHist();
  });

  /* ───────────────── 场（桌面那一片，同一个） ───────────────── */

  let area = null;
  let lineY = 0;
  let head = null;
  let line = null;
  let scene = null;

  function measure() {
    const W = innerWidth;
    const H = innerHeight;
    const w = Math.min(840, Math.max(600, W - 140));
    const h = Math.min(560, Math.max(420, H - 250));
    /* 场的中心就是屏幕的中心偏上一点：底下要留出那一行字（H-116），
       场太高会显得"吊在上半屏"，太低又会被那行字顶住。 */
    area = { w, h, x: Math.round((W - w) / 2), y: Math.max(72, Math.round((H - h) / 2 - 8)) };
    lineY = H - 116;
    /* 记录入口贴在场的右下角外侧 —— 它属于"这一层"的控件，不悬在屏幕角落 */
    histBtn.style.top = `${lineY - 42}px`;
    histBtn.style.right = `${Math.max(26, W - area.x - area.w + 10)}px`;
    stopBtn.style.top = histBtn.style.top;
    stopBtn.style.right = histBtn.style.right;
  }

  function build() {
    measure();
    head = new SlotAllocator(6400, 0);
    line = new ParticleText({
      field, alloc: head, x: Math.round(innerWidth / 2), y: lineY,
      size: 19, max: 20, color: '#eaf3ff', align: 'center', font: FONT, label: 'line',
    });
    /* 场从常驻元素之后开始分配：槽位是一条直线，两个分配器各开一个必然互相覆盖 */
    scene = new FieldScene({ field, area, a11y, slotStart: head.used });
  }

  /* ───────────────── 那一行字 ───────────────── */

  let lineText = '';
  let typer = 0;

  function say(txt, opt = {}) {
    let s2 = String(txt ?? '');
    const ch = Array.from(s2);
    if (ch.length > 20) {
      /* 多取一个字符再找句读：句读常常正好落在第 20 位，少取一个就找不到 */
      const cut = ch.slice(0, 21);
      const at = cut.findLastIndex((c) => '，。、；：·'.includes(c));
      s2 = at > 6 ? cut.slice(0, at).join('') : ch.slice(0, 20).join('');
    }
    lineText = s2;
    clearInterval(typer);
    if (opt.instant || opt.silent || !s2) { line?.set(s2, opt); return; }
    /* 逐字生长：不是假装在流式输出 token，它就是场自己的编码方式 ——
       一行字由粒子凝成、一颗颗落位，比整句闪现更像"它刚想好"。 */
    const chars = Array.from(s2);
    let n = 0;
    line.set('', { force: true });
    typer = setInterval(() => {
      n++;
      line.set(chars.slice(0, n).join(''), { force: true });
      if (n >= chars.length) clearInterval(typer);
    }, 42);
  }

  function reassertLine() {
    if (lineText) line?.set(lineText, { force: true });
  }

  /* ───────────────── 观察窗（只有 ?dev=1 才有） ───────────────── */

  let t0 = performance.now();
  function insp(kind, detail, cls = '') {
    if (!DEV || inspEl.hidden) return;
    const d = el('div', 'ln',
      `<b class="${cls}">${kind}</b><span>${String(detail)}</span>`
      + `<i>${((performance.now() - t0) / 1000).toFixed(1)}s</i>`);
    inspEl.appendChild(d);
    requestAnimationFrame(() => d.classList.add('in'));
    while (inspEl.children.length > 9) inspEl.removeChild(inspEl.firstChild);
    [...inspEl.children].forEach((n, i, all) => n.classList.toggle('dim', i < all.length - 4));
  }

  /* ───────────────── 与服务端 ───────────────── */

  /* sid 存 localStorage：刷新、收起再展开都还是同一段会话。
     服务端把它落盘，于是每次唤出都先看到"刚才那一屏"，而不是一片空白。 */
  const sid = localStorage.getItem('sid')
    || (crypto.randomUUID?.() ?? String(Math.random()).slice(2));
  localStorage.setItem('sid', sid);

  let es = null;

  /* 接口一律走根绝对路径 `/agent/api/*`。
   *
   * 相对路径只在"页面正好挂在 /agent/ 下面"时才对（agent.html 就是）。
   * 但这一层是**桌面**：浏览器地址是 desktop.<id>.olares.com 的 `/`，
   * 相对的 `api/send` 会被解析成 `/api/send`，然后被壳层 nginx 原样反代回
   * 官方的 olares-app:91 —— 返回 404，EventSource 一直重连，
   * 表现就是"场展开了，但永远停在 connecting"。 */
  const API = '/agent/api';

  function send(msg) {
    return fetch(`${API}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, ...msg }),
    }).catch((e) => insp('net', String(e.message || e)));
  }

  function connect() {
    if (es) return;
    es = new EventSource(`${API}/events?sid=${sid}`);
    es.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onEvent(m);
    };
    es.onerror = () => {
      statEl.classList.add('off');
      statTxt.textContent = 'disconnected';
    };
    /* 服务端那份记录才是"真相"：刷新、换标签页、隔夜回来都还在。
       resume 只在有上一屏时才带 log，所以这里再补一次。 */
    fetch(`${API}/history?sid=${encodeURIComponent(sid)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!Array.isArray(j?.log)) return;
        log = j.log;
        histBtn.hidden = log.length < 2;
        if (histOpen) renderHist();
      })
      .catch(() => { /* 拿不到记录不影响说话 */ });
  }

  function disconnect() {
    if (!es) return;
    es.close();
    es = null;
  }

  let thinking = 0;
  let pendingApproval = null;
  let busy = false;

  /* 「在跑」是一件事，不是两个 flag。
     原来 busy 只管状态栏，现在它还要决定那个角上写"停"还是"记录" ——
     分开写迟早有一处忘了同步，而忘了同步的表现是"点了停没反应"或
     "跑着跑着记录按钮冒出来"。 */
  function setBusy(v) {
    busy = v;
    stopBtn.hidden = !v || open === false;
    histBtn.hidden = v || log.length < 2 || open === false;
  }

  function setThink(on) {
    thinking += on ? 1 : -1;
    if (thinking < 0) thinking = 0;
    /* 「在想」= 相干度下降。这不是加载动画，是同一批粒子在"还没成形"的状态 */
    if (!scene?.tr) field.setCoherence(thinking > 0 ? 0.58 : 1);
    /* 想的这几秒，场不能"糊着不动"。给一股很弱的涡让它慢慢旋 ——
       刚度 240 只够维持流动，不会把已经画好的东西转歪到看不清。 */
    if (on && thinking === 1) {
      field.vortex(innerWidth / 2, lineY - 80, { r: 1250, k: 240, swirl: 1.5, ms: 6000, ease: 1.1 });
    }
    statEl.classList.toggle('off', thinking > 0);
    statTxt.textContent = thinking > 0 ? 'thinking' : busy ? 'running' : 'ready';
  }

  function clearThink() {
    thinking = 0;
    if (!scene?.tr) field.setCoherence(1);
    statEl.classList.remove('off');
  }

  function onEvent(m) {
    switch (m.t) {
      case 'hello':
        t0 = performance.now();
        statEl.classList.remove('off');
        statTxt.textContent = 'ready';
        insp('hello', `${m.model} · sys=${m.sys} · ${m.tools.length} tools`);
        /* 提示语只在用户还没说话时出现 —— 它占的是"那一行"，不是额外一行 */
        if (!lineText) say('说点什么', { silent: true });
        break;

      case 'resume':
        /* 不是"重新长一遍"：用户没有发起任何事，画面应该已经在那儿 */
        if (m.log?.length) { log = m.log.slice(-40); histBtn.hidden = false; if (histOpen) renderHist(); }
        if (m.scene) {
          clearInterval(typer);
          scene.set(m.scene);
          if (m.ops) scene.patch(m.ops);
          /* 先清再写：新的一行比原来短时，旧字的残余点会留在原地 */
          line.set('', { force: true });
          if (m.line) { lineText = m.line; line.set(m.line, { force: true }); reassertLine(); }
          insp('resume', `恢复上一屏（${m.scene.layers?.length ?? 0} 层）`);
        }
        break;

      case 'turn':
        setBusy(true);
        insp(m.kind === 'intent' ? '→ 手势' : '→ 你问',
          m.kind === 'intent' ? describe(m.intent) : lineText);
        break;

      case 'think': setThink(m.on); break;

      case 'say':
        say(m.text);
        histPush('a', m.text);
        insp('say', m.text, 'say');
        break;

      case 'tool':
        if (m.state === 'run') {
          /* 参数只取一小截：完整 JSON 一排下去能横穿半个屏幕，
             而观察窗要的是"它在干什么"，不是它发了什么报文。 */
          insp('tool', `${m.name} ${JSON.stringify(m.args).slice(0, 46)}`, 'tool');
          statTxt.textContent = m.name;
        } else {
          insp('·', `${m.name} → ${m.note || m.state}${m.ms != null ? ` (${m.ms}ms)` : ''}`, 'tool');
        }
        break;

      case 'scene':
        /* 新的一屏来了 = 刚才那块 DOM 内容已经过时（它是"上一个问题的答案"） */
        closeSurface();
        /* 服务端的动作也走节拍器：mock 模型一秒钟能把四条指令全吐出来，
           但界面上必须有先后 —— 这就是"时序由前端强制"的意义。 */
        if (m.op === 'set') {
          /* 场上已经有东西时，"铺一屏"其实是换景。要不要有溶解重组，是**场的决定**，
             不是模型的参数 —— 它对用户说"再给我一屏"时不该还得分 set / transition。 */
          const full = (scene.spec?.layers?.length ?? 0) > 0;
          if (full) pacer.run('transition', () => { scene.transition(m.spec); reassertLine(); });
          else pacer.run('set', () => { scene.set(m.spec); reassertLine(); });
        } else if (m.op === 'transition') {
          pacer.run('transition', () => { scene.transition(m.spec); reassertLine(); });
        } else if (m.op === 'patch') {
          pacer.run('patch', () => { scene.patch(m.ops); reassertLine(); });
        } else if (m.op === 'pulse') {
          pacer.run('pulse', () => scene.pulse(m.kind, { at: m.at }));
        }
        break;

      case 'approval':
        pendingApproval = m.id;
        /* 场里正好有一个分叉 → 就地改成审批；没有 → 退回 DOM 带子。
           前者才是这套界面该有的样子，后者只是兜底。 */
        if (scene.layers.get('ask')) {
          scene.patch([{
            id: 'ask', label: m.label,
            options: [{ id: 'ok', label: '允许' }, { id: 'no', label: '拒绝' }],
          }]);
          scene.pulse('arrive', { at: 'ask' });
        } else {
          gateEl.classList.add('on');
          gateEl.innerHTML = `<span>${m.danger}</span>`;
          const ok = el('button', '', '允许');
          const no = el('button', 'no', '拒绝');
          ok.onclick = () => { gateEl.classList.remove('on'); send({ t: 'approve', ok: true }); };
          no.onclick = () => { gateEl.classList.remove('on'); send({ t: 'approve', ok: false }); };
          gateEl.append(ok, no);
        }
        insp('gate', `需要批准：${m.tool} — ${m.danger}`);
        break;

      case 'approval_done':
        pendingApproval = null;
        gateEl.classList.remove('on');
        insp('gate', m.ok ? '已允许' : '已拒绝');
        break;

      case 'idle':
        /* 兜底：即使 think:off 因为断线丢了，一轮结束也必须让场重新成形 */
        clearThink();
        setBusy(false);
        statTxt.textContent = 'ready';
        break;

      case 'note': insp('note', m.message); break;
      case 'busy': insp('busy', '上一轮还没结束，这一步先排队'); break;

      /* 两个新的输出通道 */
      case 'surface':
        if (m.op === 'close') closeSurface();
        else showSurface(m.spec);
        insp('surface', `${m.op}${m.spec?.title ? ' · ' + m.spec.title : ''}`);
        break;

      case 'draw':
        runDraw(m.spec);
        break;

      case 'error':
        /* 只在观察窗里写一行是不够的：用户眼前就这一片场。
           模型连不上是"这一轮没有任何反应"，必须在场里说出来。 */
        clearThink();
        say(friendly(m.message));
        insp('error', m.message);
        setBusy(false);
        statTxt.textContent = 'ready';
        break;

      default:
        insp(m.t, JSON.stringify(m).slice(0, 90));
    }
  }

  /* ───────────────── 粒子绘画 ─────────────────
   *
   * draw.js 的 compileDraw 把语义层（face / text / chart / arrow …）栅格化再采样成
   * 点云，field.setDraw 只负责"把点飞过去"。所以这里只有三件事：
   *   1. 画布多大（相对视口，留边）—— 尺寸由前端定，模型只给 0~1 的相对坐标
   *   2. 把画的中心对到屏幕中心
   *   3. 到时间散回桌面，并把刚才那一屏还回来
   */
  let drawTimer = 0;
  let drawLine = '';

  function stopDraw() {
    clearTimeout(drawTimer);
    drawTimer = 0;
    if (!field.drawOn) return;
    field.clearDraw();
    /* 画不是"换了一屏"，是"临时占用桌面"：散掉之后原来那一屏要回来。
       clearDraw 有 1.6s 的回落，等它落定再重铺，否则两套点会叠在半路。 */
    const spec = scene?.spec;
    const back = drawLine;
    drawLine = '';
    setTimeout(() => {
      if (spec?.layers?.length) scene.set(spec);
      if (back) { lineText = back; say(back, { instant: true }); }
    }, 1700);
  }

  /* 协议是 0~1 的相对坐标，painter 要的是画布像素。
   *
   * 这一层转换必须在客户端：模型**永远不知道画布多大**，这正是它不会算错像素的原因。
   * 顺带把缺省位置补上 —— "画个笑脸"这种事不该要求模型指定 at 和 size。 */
  /**
   * 把"模型的语言"翻成"painter 的语言"。
   *
   * 这里是整套绘画唯一一处翻译，所以它必须替 painter 兜住方言 —— 不能指望
   * 模型记住每种图元要哪个字段名。之前 circle 就是个反例：协议告诉它写
   * at/size，而 painter 读的是 c/r，于是**任何** circle 层都在编译时抛
   * `Cannot read properties of undefined`，画小狗就变成"它说画好了，屏幕上什么都没有"。
   * rect 更坏：它不抛，只是让 strokeRect 收到 undefined 宽度，安静地什么都不画。
   */
  function denorm(spec, w, h) {
    const S = Math.min(w, h);
    const P = (a) => (Array.isArray(a) ? [a[0] * w, a[1] * h] : a);
    /* 相对量：≤1.5 当"短边的比例"；更大的数视为已经是像素（留个后门） */
    const len = (s) => (Array.isArray(s) ? [s[0] * w, s[1] * h] : (Math.abs(s) <= 1.5 ? s * S : s));

    return {
      ...spec,
      layers: (spec.layers || []).map((L) => {
        const o = { ...L };
        /* face / text / circle 的 at 是中心，chart / rect 的 at 是左上角 ——
           这个差别由 painter 的几何决定，不强行统一（统一了文字就会偏半个字高）。 */
        const defaultAt = L.type === 'chart' || L.type === 'rect' ? [0.08, 0.16] : [0.5, 0.48];
        o.at = P(L.at || L.c || defaultAt);
        if (L.from) o.from = P(L.from);
        if (L.to) o.to = P(L.to);
        if (Array.isArray(L.points)) o.points = L.points.map(P);
        const ds = L.type === 'chart' ? [0.84, 0.62]
          : L.type === 'text' ? 0.2
            : L.type === 'stencil' ? 0.62 : 0.46;
        o.size = len(L.size != null ? L.size : ds);

        switch (L.type) {
          case 'circle': {
            /* painter 要圆心 c + 半径 r；协议给的是 at + size（size 是直径） */
            const dia = Array.isArray(o.size) ? o.size[0] : o.size;
            o.c = o.at;
            o.r = L.r != null
              ? (Array.isArray(L.r) ? L.r[0] : (Math.abs(L.r) <= 0.9 ? L.r * S : L.r))
              : dia / 2;
            break;
          }
          case 'rect': {
            /* painter 要 [x, y, w, h]；协议给 at（左上）+ size（宽，数字）或 [w,h] */
            let rw;
            let rh;
            if (Array.isArray(o.size)) { rw = o.size[0]; rh = o.size[1]; }
            else { rw = o.size; rh = L.h != null ? len(L.h) : rw * 0.62; }
            if (L.w != null) rw = len(L.w);
            o.r = [o.at[0], o.at[1], rw, rh];
            break;
          }
          case 'path': {
            /* d 里的数是 0~1 的话，交给 painter 等比缩到短边并居中。
               不在这里展开成像素：命令参数哪些是 x 哪些是 y，只有解析器分得清，
               而 0~1 的 path 是最省事的表达"任意形状"的方式。 */
            const nums = String(L.d || '').match(/-?\d*\.?\d+/g)?.map(Number) || [];
            const norm = nums.length && nums.every((n) => Math.abs(n) <= 1.8);
            if (norm) o.norm = true;
            break;
          }
          default:
            break;
        }
        return o;
      }),
    };
  }

  /* 画不出来必须让人看到，而不是只写进检查窗口。
     之前的失败全落在 insp 里（`?dev=1` 才显示），用户看到的是
     "它说画好了、屏幕上什么都没有" —— 这是最难受的一种失败：界面对人撒谎。
     说话行是这一层唯一能开口的地方，就在这里说一句。 */
  function drawBroken(reason) {
    insp('draw', reason);
    say('没画出来', { instant: true });
  }

  function runDraw(spec) {
    if (!spec || spec.stop) { stopDraw(); return; }
    const w = Math.min(980, Math.round(innerWidth - 180));
    const h = Math.min(600, Math.round(innerHeight - 300));
    let pack;
    try { pack = compileDraw(denorm(spec, w, h), { w, h, max: 5600 }); } catch (e) {
      drawBroken('编译失败：' + (e.message || e));
      return;
    }
    if (!pack.points.length) { drawBroken('没有点可画'); return; }

    /* 画之前把 DOM 内容收掉：它正好盖在画面正中，两套东西抢同一块地方 */
    closeSurface();
    field.slotBegin({ dim: 0.9, dot: 1 });
    field.setDraw(pack, {
      x: Math.round((innerWidth - w) / 2),
      y: Math.round((innerHeight - h) / 2),
      dot: 1, dim: 0.9,
      drawOnMs: 1400,       // 一道波沿着笔迹推过去，不是整幅图同时亮起来
    });
    /* 那一行字让位：画的点会写到同一批槽位上 */
    drawLine = lineText;
    line.set('', { force: true });
    lineText = '';
    insp('draw', `${spec.layers?.length || 0} 层 · ${pack.points.length} 点 · ${pack.spacing.toFixed(1)}px`);
    clearTimeout(drawTimer);
    /* 到点自己散 —— 画是"占用桌面"的行为，不能赖着不走 */
    drawTimer = setTimeout(() => { drawTimer = 0; stopDraw(); }, Math.min(20000, Math.max(2500, spec.hold || 8000)));
  }

  /* ───────────────── 输入 ───────────────── */

  /* ───────────────── 交给场：把这句话搅进去 ─────────────────
   *
   * 按下回车之后，屏幕上原本只是"字没了、相干度降下来"。可那两件事都是
   * **场自己的状态**，不是"它收到了"的动作：用户看到的是画面自己糊了，
   * 而不是自己的话被拿走。
   *
   * 所以这里给一个真的动作：在句子的位置上起一股涡（vortex）—— 点绕着它转、
   * 被甩出去；同时字从右往左被"吃掉"。方向感和"被处理"的因果都在这一下里。
   */
  let ingestTimer = 0;

  function ingest(txt) {
    clearInterval(typer);
    clearInterval(ingestTimer);
    const chars = Array.from(txt);
    if (!chars.length) return;
    /* 涡的半径跟着句子长度走：三个字的"嗯？"配 620 的涡会像在爆炸 */
    field.vortex(innerWidth / 2, lineY - 6, {
      r: Math.min(680, 300 + chars.length * 28),
      k: 2100, swirl: 2.9, ms: 950,
    });
    let n = chars.length;
    /* 从右往左吃：读的方向是左到右，最后消失的应该是最开头那个字 */
    ingestTimer = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(ingestTimer);
        line.set('', { force: true });
        return;
      }
      line.set(chars.slice(0, n).join(''), { force: true });
    }, Math.max(24, 300 / chars.length));
  }

  function submit() {
    const text = typeEl.value.trim();
    if (!text) return;
    say(text);
    insp('你', text);
    histPush('u', text);
    send({ t: 'ask', text });
    typeEl.value = '';
    ingest(text);
    /* 正在看记录时又问了一句：把记录收起来（但不把旧那一屏翻回来 —— 
       新的回合马上会重铺）。 */
    closeHist();
    /* 这句话已经被场吃掉了：别让下一次 reassertLine 把它写回来 */
    lineText = '';
  }

  typeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    /* ↑ 看刚才说过什么（输入框空着才让位：里面有字时 ↑ 是"我要改这句话"） */
    if (e.key === 'ArrowUp' && !typeEl.value && !e.isComposing) { e.preventDefault(); openHist(); }
    if (e.key === 'ArrowDown' && histOpen) { e.preventDefault(); closeHist(); }
  });
  typeEl.addEventListener('input', () => {
    /* 输入回显必须是瞬时的：逐字生长是"它刚想好"的语法，用在打字回显上就成了卡顿 */
    say(typeEl.value || '', { instant: true });
  });

  /* ───────────────── 手势 → 意图 ───────────────── */

  let panBase = null;
  let dragId = null;

  const gt = new GestureTracker({
    pick: (x, y) => scene.hit(x, y),

    onStart: (s) => {
      field.setWells([{ x: s.x, y: s.y, r: 180, k: 1200, swirl: 0.3 }]);
      if (s.id) field.impulse(s.x, s.y, { r: 120, power: 200 });
      if (s.hot?.gestures?.includes('pan') && s.layer?.win) {
        panBase = s.layer.win.slice();
        dragId = s.id;
      }
    },

    onMove: (s) => {
      field.setWells([{ x: s.x, y: s.y, r: 195, k: 1500, swirl: 0.34 }]);
      if (s.trail) field.impulse(s.x, s.y, { r: 76, power: 78 });
      if (s.id && panBase && dragId === s.id) {
        const span = panBase[1] - panBase[0];
        const frac = -s.dx / 780;
        const w0 = Math.min(1 - span, Math.max(0, panBase[0] + frac * span));
        scene.resetWin(s.id, [w0, w0 + span]);
      }
    },

    onEnd: (s) => {
      field.setWells([]);
      if (s.moved) field.impulse(s.x, s.y, { r: 210, power: 420 });
      panBase = null;
      dragId = null;
    },

    onIntent: (i) => {
      /* 分叉上的"允许/拒绝"是**审批**，不是普通选择 —— 但走的是同一条手势通道。
         审批不是特权通道，它只是"服务端此刻在等一个 pick"。 */
      if (pendingApproval && i.kind === 'pick' && i.target === 'ask') {
        send({ t: 'approve', ok: i.option === 'ok' });
        insp('gate', i.option === 'ok' ? '你点：允许' : '你点：拒绝');
        return;
      }
      if (i.target) insp('hand', describe(i));
      histPush('i', describe(i));
      send({ t: 'intent', intent: i });
    },
  });
  gt.attach(window);
  gt.enabled = false;          // 收起时不接管指针：桌面要能拖球、甩列表、点图标

  addEventListener('pointermove', (e) => {
    if (!open) return;
    if (gt.g?.moved) return;
    const h = scene.hit(e.clientX, e.clientY);
    document.body.style.cursor = !h ? 'default'
      : h.hot.gestures.includes('adjust') ? 'ns-resize'
      : h.hot.gestures.includes('pan') ? 'ew-resize'
      : 'pointer';
  });

  /* ───────────────── 开 / 关 ───────────────── */

  let open = false;
  let busyAnim = false;

  function openAgent() {
    if (open || busyAnim) return;
    open = true;

    if (!scene) build();

    /* 接管这 6400 颗粒子的绘制权。
     *
     * 少了这一步，场就是"往槽位里写了但没人画"：drawOn 还是 0，
     * drawMix 上不去，屏幕上只剩被压暗的环境球 —— 字一个都不出现，
     * 而且不报任何错。（agent.html 里这行写在初始化，我抽模块时漏了。）
     * dim/dot 是这套界面的基本观感：环境点 0.84 的暗度、UI 点 0.95 的径。
     *
     * dim 从 0.62 提到 0.84：0.62 只是把每颗点的 alpha 乘 0.38，但环境球是
     * 加法混合、中心叠着上千颗 —— 剩余的亮度依然盖在场上面，读数"45%"正好
     * 落在球心那片密点里，看着像透过一层星尘看字。0.84 之后球才真的退回
     * "桌面还在那儿"的底噪，而场是这屏唯一亮的东西。 */
    field.slotBegin({ dim: UI_ENV_DIM, dot: 0.95 });

    /* 从底部长出来：先让粒子"还没成形"，set 之后再把相干度拉回来。
       这不是入场动画 —— 是 §4.6 的相变语法，用户看到的是"桌面正在变成它"。 */
    field.setCoherence(0.34);
    field.setStiff(2.3);

    layer.hidden = false;
    document.body.classList.add('agent-open');
    /* 底边那条光已经完成了它的使命（用户就是点它进来的），
       场展开后它再亮着就成了"屏幕上多了一个控件"。 */
    zone.classList.remove('hot');
    zoneHover = false;
    field.uiLock = true;
    /* 窗口边缘那圈粒子也退掉：CSS 只能淡掉窗口的 DOM，
       而那圈边框是粒子画的，不跟着走的话 agent 就像被框在窗口里。 */
    field.rimTo = 0;
    gt.enabled = true;
    onOpenChange?.(true);
    setBusy(busy);

    connect();
    /* 相干度回升要跨过 set 那一帧，否则 set 里那次 slotBegin 会把它顶回去 */
    setTimeout(() => field.setCoherence(1), 90);
    setTimeout(() => field.setStiff(1), 760);

    /* 上一次说的那句话要重新写回槽位：slotBegin 清掉了绘制标记，
       不重写的话"收起再展开"看起来就像失忆了。 */
    if (lineText) line.set(lineText, { force: true });
    else say('说点什么', { silent: true });
    typeEl.style.top = `${lineY - 17}px`;
    setTimeout(() => typeEl.focus({ preventScroll: true }), 120);
    insp('open', '场已展开');
  }

  function closeAgent() {
    if (!open || busyAnim) return;
    open = false;
    busyAnim = true;

    typeEl.blur();
    gateEl.classList.remove('on');
    layer.hidden = true;
    document.body.classList.remove('agent-open');
    document.body.style.cursor = '';
    document.body.classList.remove('grabbing');

    /* 收起不是"关掉一个面板"，是**散回桌面**：clearDraw 让点按 1.6s 的回落
       回到球面环境形态。相干度先压低一点，散的过程才有"化开"而不是"淡出"。 */
    field.setCoherence(0.3);
    field.setWells([]);
    /* 涡必须清掉：它是"一次性的力"，留着就会在收起之后继续搅 —— 
       而用户已经离开这一层了，桌面球没有理由还在转。 */
    field.vorts.length = 0;
    field.clearDraw();
    closeSurface();
    clearTimeout(drawTimer);
    drawTimer = 0;
    drawLine = '';
    closeHist();
    histBtn.hidden = true;
    clearInterval(ingestTimer);
    field.setStiff(2.0);
    field.rimTo = 1;                    // 窗口边缘跟着场一起回来
    gt.enabled = false;
    gt.g = null;                        // 半途松手：别让下一次唤出继承一个旧手势
    disconnect();

    setTimeout(() => {
      field.setCoherence(1);
      field.uiLock = false;
      busyAnim = false;
      onOpenChange?.(false);
      insp('close', '散回桌面');
    }, 420);
    setTimeout(() => field.setStiff(1), 1300);
  }

  function toggle() { open ? closeAgent() : openAgent(); }

  /* ───────────────── 底部热区 ─────────────────
   * 鼠标贴到底边：粒子被一股弱井吸下去，底边亮起一条极淡的光。
   * 这是"可以拉上来"的暗示，不是按钮 —— 桌面上不出现按钮。
   * 再点一下、或者按住往上拖，场才真的展开（避免鼠标路过就弹出来）。
   */

  let zoneHover = false;

  function zoneGlow(on) {
    if (open) return;          // 展开后底边不再是入口，别再去碰场上的势阱
    if (on === zoneHover) return;
    zoneHover = on;
    zone.classList.toggle('hot', on);
    if (open) return;
    if (on) field.setWells([{ x: innerWidth / 2, y: innerHeight - 2, r: 320, k: 210, swirl: 0 }]);
    else field.setWells([]);
  }

  zone.addEventListener('pointerenter', () => zoneGlow(true));
  zone.addEventListener('pointerleave', () => zoneGlow(false));

  /* 点击展开。用 click 而不是"按下-抬起位移小于 N"：后者在指针一擦出元素
     （pointerleave 也会来）时就把起点清了，于是点击永远不成立 —— 我第一版就是这样，
     点了十下没反应，还以为是渲染的问题。 */
  zone.addEventListener('click', () => openAgent());

  /* 贴着底边往上拖，也是"拉出来"：它比点击更像"把场从下面拽上来"。
     拖过 44px 就展开，不等松手 —— 松手才动会像卡住。 */
  let pullY = null;
  zone.addEventListener('pointerdown', (e) => { pullY = e.clientY; });
  zone.addEventListener('pointerup', (e) => {
    /* 兜底：触摸 / 某些合成环境下 tap 不产 click，只有 pointerup。
       openAgent 是幂等的，所以和上面的 click 不会冲突。 */
    if (pullY != null && Math.abs(e.clientY - pullY) < 30) openAgent();
    pullY = null;
  });
  zone.addEventListener('pointermove', (e) => {
    if (pullY != null && pullY - e.clientY > 44) { pullY = null; openAgent(); }
  });

  /* 双击桌面空白：桌面上的"图形"都在 rail / 启动台里，双击它们在各自的处理里；
     落在空白上的双击没有别的含义，正好给 agent。 */
  addEventListener('dblclick', (e) => {
    if (open) return;
    if (e.target instanceof Element
      && e.target.closest('.win, .rail-zone, .stat-zone, .ag-layer, .ag-zone, .launch, .boot')) return;
    openAgent();
  });

  /* 视口变了：场要重新测量。开着的时候顺便把上一屏按新区域重排，
     否则收起再展开之前，所有东西都还按旧尺寸摆着。 */
  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!scene) return;
      const spec = scene.spec;
      measure();
      if (!open) { build(); return; }
      const keep = lineText;
      build();
      typeEl.style.top = `${lineY - 17}px`;
      if (spec) scene.set(spec);
      if (keep) { lineText = keep; say(keep, { instant: true }); }
    }, 260);
  });

  return {
    get field() { return field; },
    get scene() { return scene; },
    get open() { return open; },
    isOpen: () => open,
    isBusy: () => busy,
    abort: abortAsk,
    open: openAgent,
    close: closeAgent,
    /** Esc 的分级：先收记录，再收这一层。返回 true 表示"这一下被吃掉了" */
    closeHistory: () => {
      if (!histOpen) return false;
      closeHist();
      return true;
    },
    /** 渲染树内容优先于记录：它是屏幕正中最大的一块 */
    closeSurface: () => closeSurface(),
    stopDraw: () => stopDraw(),
    isDrawing: () => !!field.drawOn,
    history: () => (histOpen ? log.slice(-10) : null),
    /* 自测钩子（只有 ?dev=1 才有）：直接喂一条服务端事件，
       用来验新的输出通道，不必每次都等模型想起来调那个工具。 */
    ...(DEV ? { emit: (ev) => onEvent(ev) } : {}),
    toggle,
    ask: (t) => { typeEl.value = t; submit(); },
    /* 自测：走真实的手势通道（和用户按下去完全同一条路），不是直接调 scene */
    tap: (id, branch = 0) => {
      const l = scene?.layers.get(id);
      const h = (l?.branches?.[branch]?.hot) || l?.hot;
      if (!h) return false;
      const { cx, cy } = h.type === 'circle' ? h : { cx: (h.x0 + h.x1) / 2, cy: (h.y0 + h.y1) / 2 };
      gt.down(cx, cy);
      setTimeout(() => gt.up(cx, cy), 110);
      return true;
    },
    drag: (id, dx, dy) => {
      const h = scene?.layers.get(id)?.hot;
      if (!h) return false;
      const cx = h.cx ?? (h.x0 + h.x1) / 2;
      const cy = h.cy ?? (h.y0 + h.y1) / 2;
      gt.down(cx, cy);
      let k = 0;
      const step = () => {
        k++;
        gt.move(cx + (dx * k) / 12, cy + (dy * k) / 12);
        if (k < 12) setTimeout(step, 16);
        else setTimeout(() => gt.up(cx + dx, cy + dy), 40);
      };
      setTimeout(step, 30);
      return true;
    },
    state: () => ({
      open, thinking, busy, pendingApproval,
      slots: scene?.alloc.used ?? 0,
      line: lineText,
      layers: scene ? [...scene.layers.keys()] : [],
      spec: scene?.spec?.layers?.map((l) => l.kind + ':' + l.id).join(' ') || '',
    }),
  };
}
