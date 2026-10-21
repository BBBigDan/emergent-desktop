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

  function send(msg) {
    return fetch('api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, ...msg }),
    }).catch((e) => insp('net', String(e.message || e)));
  }

  function connect() {
    if (es) return;
    es = new EventSource(`api/events?sid=${sid}`);
    es.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onEvent(m);
    };
    es.onerror = () => {
      statEl.classList.add('off');
      statTxt.textContent = 'disconnected';
    };
  }

  function disconnect() {
    if (!es) return;
    es.close();
    es = null;
  }

  let thinking = 0;
  let pendingApproval = null;
  let busy = false;

  function setThink(on) {
    thinking += on ? 1 : -1;
    if (thinking < 0) thinking = 0;
    /* 「在想」= 相干度下降。这不是加载动画，是同一批粒子在"还没成形"的状态 */
    if (!scene?.tr) field.setCoherence(thinking > 0 ? 0.58 : 1);
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
        busy = true;
        insp(m.kind === 'intent' ? '→ 手势' : '→ 你问',
          m.kind === 'intent' ? describe(m.intent) : lineText);
        break;

      case 'think': setThink(m.on); break;

      case 'say':
        say(m.text);
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
        busy = false;
        statTxt.textContent = 'ready';
        break;

      case 'note': insp('note', m.message); break;
      case 'busy': insp('busy', '上一轮还没结束，这一步先排队'); break;

      case 'error':
        /* 只在观察窗里写一行是不够的：用户眼前就这一片场。
           模型连不上是"这一轮没有任何反应"，必须在场里说出来。 */
        clearThink();
        say(friendly(m.message));
        insp('error', m.message);
        busy = false;
        statTxt.textContent = 'ready';
        break;

      default:
        insp(m.t, JSON.stringify(m).slice(0, 90));
    }
  }

  /* ───────────────── 输入 ───────────────── */

  function submit() {
    const text = typeEl.value.trim();
    if (!text) return;
    say(text);
    insp('你', text);
    send({ t: 'ask', text });
    typeEl.value = '';
  }

  typeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
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
     * dim/dot 是这套界面的基本观感：环境点 0.96 的暗度、UI 点 0.95 的径。 */
    field.slotBegin({ dim: 0.62, dot: 0.95 });

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
    field.clearDraw();
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
    open: openAgent,
    close: closeAgent,
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
