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
import { ParticleText, SlotAllocator, glyphBudget } from './pui.js';
import { createAnswer } from './answer.js';
import { createFace } from './face.js';
import { FONT } from './draw.js';
import { FieldA11y } from './aria.js';
import { GestureTracker, describe } from './gesture.js';
import { Pacer } from './timing.js';

const DEV = new URLSearchParams(location.search).has('dev');

/* 用户的话是暗的，模型的回答是亮的。这套界面里"谁在说"只靠这一件事区分，
   所以它只能有一个出处。 */
const ASK_COLOR = '#6f93b8';
const SAY_COLOR = '#eaf3ff';

/** 服务端的错误原文 → 一句人能读的短话（场里每行只有 20 格宽） */
function friendly(msg = '') {
  /* 429 要在"模型出错了"之前判：它看起来像故障，其实是"问太快了"，
     而且用户唯一该做的事就是等 —— 说清楚比说"出错了"有用得多。 */
  if (/429|限流|太多请求|rate.?limit/i.test(msg)) return '模型那边限流了，等会儿再问';
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

  /* ── 状态区（§3）：它是谁、还剩多少上下文、记得多少 ──
   *
   * 一行，36px，常驻。为什么是 DOM 而不是粒子：11px 汉字在点阵里的格距最小 1.5px，
   * 而 11px 字的笔画只有 0.8px —— 笔画比格子还细，采样必然丢一半。这一行的全部
   * 价值是"扫一眼就知道"，所以它和记录、页码一样，是有意不做成粒子的第三样东西。
   *
   * 三样数字各有各的来历，别混：
   *   模型 → hello 的 model（启动常量，本期不可切）
   *   上下文 → usage 的 ctx.tokens / limit（`?` 表示上限是猜的）
   *   记忆 → hello 与每轮 idle 前的 {t:'mem'}（facts = 条数）
   */
  const barEl = el('div', 'ag-bar');
  const barDot = el('i', 'ag-dot');
  const barModel = el('b', 'ag-model', 'connecting');
  const barCtx = el('span', 'ag-ctx');
  const barCtxTrack = el('i', 'ag-ctx-track');
  const barCtxFill = el('i', 'ag-ctx-fill');
  const barCtxNum = el('b', 'ag-ctx-num');
  barCtxTrack.appendChild(barCtxFill);
  barCtx.append(barCtxTrack, barCtxNum);
  const barMem = el('span', 'ag-mem');
  /* 正在跑的工具名。它只在"那一下"出现 —— 常驻的话，用户会以为界面卡在那个工具上 */
  const barTool = el('span', 'ag-tool');
  barEl.append(barDot, barModel, barCtx, barMem, barTool);

  const gateEl = el('div', 'ag-gate');
  const a11yEl = el('div', 'ag-a11y');
  const hintEl = el('div', 'ag-hint', '回车发送 · 拖仪表 / 拖曲线 / 点元素 · Esc 收起');

  layer.append(barEl, typeEl, inspEl, gateEl, a11yEl, hintEl);
  /* 状态区常驻（§3 的第一句）。观察窗和提示行仍旧只在 ?dev=1 出现 */
  if (!DEV) { inspEl.hidden = true; hintEl.hidden = true; }
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
  let ask = null;   // 用户那一行（输入行）
  let ans = null;   // 模型那一块（上面的大字）
  let face = null;   // loading 区：小表情 / 在想
  let scene = null;

  /* 槽位总账（池子 56000，见 field.js 的 UI_POOL，账在 docs/interaction-spec.md §9）：
       问           22 字 × 81 = 1782   —— 先拿，它在输入行、位置固定
       loading 区    300
       答案         32400                —— 12 行 × 30 字 × 90 颗（§2.1 的可读密度）
       场景         余下 ~21500           —— 仪表 / 曲线 / 分叉环
       余量         ~500                 —— 某一层超配时不至于整屏不铺
     "问"必须先拿：被场景挤掉就等于用户看不到自己刚问过什么。 */

  /* 背景那 6400 颗还留多亮。这个数是**压暗比例**，越大越暗（见 field.js 的 drawDim）：
       0.84 → 背景剩 16%，桌面态的数（球面还在、但不抢戏）
       0.94 → 剩 6%，agent 展开、屏幕上要读字的时候用这个
     写成 0.30 是第一次的错：我以为它读作"留三成"，实测反而是把背景**提亮**到 70%，
     字直接陷进点阵里。（用户原话："背景里的粒子也可以使用或者消失掉"。） */
  const ENV_DIM_AGENT = 0.94;
  /* 「在想」时背景回到多亮（35%）。状态必须看得出来不是一回事：
     输出时背景剩 6%，字是屏幕上唯一亮的东西；在想的时候背景回到三成多、
     整片云慢慢转 —— 那是"它还没成形"，不是"它在说话"。 */
  const ENV_DIM_THINK = 0.62;
  /* 屏幕上有内容时，"在想"只把背景抬到这个亮度（18%）：抬太多，球面的点会
     从字缝里冒出来，读起来比输出时更糊 —— 那正是用户说的"什么都看不出来"。
     空屏才需要明显的云（38%），因为那时屏幕上没有别的东西可看。 */
  const ENV_DIM_THINK_BUSY = 0.82;
  /* loading 区的槽位。300 够 260 颗的螺旋 + 一圈光尘；
     它和答案块抢的是同一段槽位，所以数字要记在总账里（见 ANS_SLOTS）。 */
  const FACE_SLOTS = 300;
  /* 用户那一行（"问"）：18px、暗色、单行。
     它是和答案块分开的第二块字，不是答案块的降级版。 */
  const ASK_SIZE = 18;
  const ASK_CHARS = 22;

  /* 答案块的槽位：20px 在**可读密度**下一个字 90 颗（§2.1）。
     12 行 × (29 字 + 1 格行首禁则) × 90 = 32400 —— 正好是一页 300 字的家。
     行数与每行字数一变，这个数就得跟着变，否则最后两行会申请不到槽位。 */
  const ANS_SLOTS = 32400;

  let areaA = null;   // 态 A：场景满宽
  let areaB = null;   // 态 B：场景只占右半

  /* 内容区：1440 基准下 1360 x 692。
     上边 68 留给状态区（36 + 12 间距），下边留到输入行上方。 */
  function contentArea() {
    const W = innerWidth;
    const H = innerHeight;
    const w = Math.min(1360, W - 80);
    return {
      x: Math.round((W - w) / 2),
      y: 68,
      w,
      h: Math.max(360, H - 140 - 68),
    };
  }

  /* loading 区：场景区左上角，200 x 88 里的一小块。表情 48 摆在里面偏左。 */
  function faceGeom() {
    return { x: area.x + 52, y: area.y + 44, size: 48, slots: FACE_SLOTS };
  }

  /* 答案块：左半屏、左对齐，20px / 26 行高 / 29 字一行 / 12 行 / 300 字一页 */
  function ansGeom() {
    const a = contentArea();
    const half = (a.w - 24) / 2;
    return {
      size: 20, lh: 26, lines: 12,
      /* 每行字数要按"字宽 + 字距"算，不能只除字号：汉字之间有一格字距（0.06em），
         33 字 × 20 看着是 660，实际排出来 726 —— 会直接压过中线进到场景区。 */
      maxChars: Math.max(8, Math.floor((half - 40) / (20 * 1.06))),
      maxWidth: half - 32,
      /* **左对齐**。这一块是"读一段话"，不是"念一句字幕"：
         居中的多行文字每行起点都在动，眼睛每换一行都要重新找头，
         读三百字就是三百次重新找头。左边留 20px，和问句行同一个起点。 */
      align: 'left',
      cx: Math.round(a.x + 20),
      centerY: Math.round(a.y + a.h / 2),
    };
  }

  function measure() {
    const W = innerWidth;
    const H = innerHeight;
    lineY = H - 116;
    const a = contentArea();
    const half = (a.w - 24) / 2;
    areaA = { ...a };
    areaB = { x: a.x + half + 24, y: a.y, w: half, h: a.h };
    /* 态由"有没有答案"决定 —— 不是由场景有没有内容。
       用场景判断的话，模型只说话不出图时整屏会一直停在满宽，答案块没地方站。 */
    area = ans && ans.text ? areaB : areaA;

    /* 状态区（§1）：和内容区左右对齐，36px 高，贴顶 20px */
    barEl.style.left = `${a.x}px`;
    barEl.style.top = '20px';
    barEl.style.width = `${a.w}px`;
    barEl.style.paddingRight = '128px';   // 右端让出记录/停止两个图标位

    /* 记录 / 停止：状态区右端，不再挂在场角 —— 那里在答案铺开后会被字压住 */
    histBtn.style.top = '24px';
    histBtn.style.right = '40px';
    stopBtn.style.top = histBtn.style.top;
    stopBtn.style.right = histBtn.style.right;
  }

  function build() {
    measure();
    /* 旧块必须先停手：它可能还在逐字生长（setInterval），换了 allocator 之后
       它继续往**同一段槽号**里写旧坐标 —— 屏幕上出现一块永不消失的残字
       （实测：回答出来之后，占位语那半句一直浮在上面）。 */
    if (ans) ans.clear();
    if (ask) ask.clear();
    head = new SlotAllocator(field.poolN, 0);
    /* 问在前：它在最下面、位置固定、只占一行。槽位是一条直线，谁先拿谁拿全额 */
    ask = new ParticleText({
      field, alloc: head, x: Math.round(innerWidth / 2), y: lineY,
      size: ASK_SIZE, max: ASK_CHARS, color: ASK_COLOR, align: 'center',
      font: FONT, weight: 300, label: 'ask',
      /* 你刚说的那句必须是**要读**的：它和答案同一档密度，只是更暗更小。
         22 字 × 81 = 1782，池子里这点钱不能省。 */
      budget: glyphBudget(ASK_SIZE, true),
    });
    /* loading 区先于答案块分配：位置固定、只占 300 格。
       被答案挤掉就等于"它不在了"，而这张小脸是屏幕上唯一的在场信号。 */
    if (face) face.dispose();
    face = createFace({ field, alloc: head, slots: FACE_SLOTS });
    face.layout(faceGeom());
    ans = createAnswer({ field, alloc: head, reserve: ANS_SLOTS });
    ans.layout(ansGeom());

    /* 场从常驻元素之后开始分配：槽位是一条直线，两个分配器各开一个必然互相覆盖 */
    scene = new FieldScene({ field, area, a11y, slotStart: head.used, envDim: ENV_DIM_AGENT });
  }

  /* 场景出现/消失时，答案块要换档（big ⇄ compact）。换档只动字块，不动场景。
     只在档位**真的变了**时重排：每次 patch 都重排会让字闪一下，而 patch 是
     读数在跳的时候每秒都会来的东西。 */
  /* 态切换（满宽 ⇄ 分栏）：不是"换字号档"，是**场景让出半边**。
     场景要按新 area 重铺一次，答案块也跟着换到左半的中点。 */
  function applyMode() {
    if (!ans) return;
    const want = ans.text ? areaB : areaA;
    if (!want) return;
    /* 比的是**场景当前用的** area，不是全局那个 —— 全局 area 在 measure 里早已
       被改成新值，拿它比较会永远得出"没变"，场景就一直按旧的满宽铺着不收缩。 */
    const changed = !scene || !scene.area || scene.area.w !== want.w || scene.area.x !== want.x;
    area = want;
    if (scene) {
      scene.area = area;
      if (changed && scene.spec) scene.set(scene.spec);
    }
    face?.layout(faceGeom());
    ans.layout(ansGeom());
  }

  /* 场景铺完：先换档，再把这句字幕写回去（换档会重建字块，字是新长出来的） */
  function afterScene() {
    applyMode();
    reassertLine();
    /* 场景铺出来了：加载圈收掉（它只在空屏时代表"在想"），背景也降回
       有内容时的亮度 —— 内容一出现，屏幕上的主角就换成它 */
    if (thinking > 0) { ringOff(); ambientTo(ENV_DIM_THINK_BUSY); }
  }

  /* ───────────────── "在想"的那一圈 ─────────────────
   *
   * 用户的原话：「输入完内容之后就是消失了，在模型给回复之前什么都没有，
   * 你好歹让粒子云在屏幕中央转一转」。
   *
   * 所以这不是一个加载图标，是同一种粒子在"还没成形"的状态：一颗带尾巴的头，
   * 绕着一个偏心圆转，转速约 1.6 rad/s（约 4 秒一圈 —— 比 spinner 慢，
   * 因为它在等的是模型，不是磁盘 IO）。尾巴靠 ink 衰减做出来，不是画一条线。
   *
   * 它在答案块的位置上转，所以"回答出现"这件事就是圆心那圈收束成字 ——
   * 同一个位置，同一批粒子，不需要额外的过场动画。
   */
  /* ───────────────── "在想" ─────────────────
   *
   * 它不再是一圈环，而是 loading 区那张小表情散开、重组成三种形态的叠加：
   * 螺旋给结构、云给厚度、流给方向（见 face.js）。只有一圈的话，读起来是
   * "加载图标"；三层叠起来才像"一团粒子在动"。
   *
   * ringOn / ringOff 这两个名字留着，因为 setThink 里已经有一串引用点；
   * 现在它们只是 face 的开关 + 一次收尾冲量。
   */
  function ringOn() {
    face?.setLoading(true);
  }

  function ringOff() {
    if (!face?.loading) return;
    face.setLoading(false);
    /* 收的时候补一次向外的小冲量：转过的点会挤在中心附近，
       没有东西再把它们推回去，屏幕上就是一块"不该在那儿的雾"。 */
    const g = faceGeom();
    field.impulse(g.x, g.y, { r: 180, power: 240 });
  }

  /* ───────────────── 两句话：问在下面，答在上面 ─────────────────
   *
   * 这一屏只有一条"谁在说"的语法，所以它只能有一个出处：
   *   问 → 输入框那一行（18px、暗色、单行）。话停在嘴边上，就是刚打出来的位置。
   *   答 → 输入框上面那块空地（32px、亮色、最多三行）。
   *
   * 之前两块是同一个：在输入框打字，字直接长到上面那块；提交之后自己那句话
   * 和模型的回答又叠在同一个位置 —— 读的人分不清哪句是谁说的。
   * 分开之后各自有地方，亮/暗只是第二层提示。
   */
  let askText = '';    // 用户最近一句（下面）
  let sayText = '';    // 模型最近一句（上面）
  let sayColor = SAY_COLOR;

  /** 问：写进输入行。这里绝不用逐字生长 —— 人自己打的字再长一遍就是卡顿 */
  function echo(txt) {
    askText = String(txt ?? '');
    if (!ask) return;
    /* 输入行只放得下 ASK_CHARS 个字（18px × 22 ≈ 400px，输入框宽 620）。
       超了要**显式画一个省略号**：直接截断的话，人打着打着字就不见了，
       而屏幕上没有任何东西说明"后面还有"。 */
    const ch = Array.from(askText);
    const show = ch.length > ASK_CHARS
      ? ch.slice(0, ASK_CHARS - 1).join('') + '…'
      : askText;
    ask.set(show || '说点什么', {
      instant: true,
      color: askText ? ASK_COLOR : '#4d6884',
    });
  }

  /** 答：写进上面那块。整屏唯一会逐字生长的地方 */
  function speak(txt, opt = {}) {
    let s2 = String(txt ?? '');
    /* 上限交给服务端（1200 字 = 三页）。这里只兜住极端情况：
       分页之后一屏能读 400 字，再长就是"读不完"，而不是"排不下"。 */
    if (Array.from(s2).length > 2000) s2 = Array.from(s2).slice(0, 2000).join('');
    sayText = s2;
    sayColor = opt.color || SAY_COLOR;
    if (!ans) return;
    if (opt.instant) ans.set(s2, { instant: true, color: sayColor });
    else ans.set(s2, { color: sayColor });
    updateFooter();
  }

  /** 槽位重开/换档之后两块字都要写回去（否则"收起再展开"像失忆） */
  function reassertLine() {
    if (askText) ask?.set(askText, { instant: true, color: ASK_COLOR });
    if (sayText) ans?.set(sayText, { force: true, instant: true, color: sayColor });
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

  /* ───────────────── token 账本 ─────────────────
   *
   * 三行，各回答一个问题：**上下文还有多少余量**（涨到 80% 之后模型开始丢前文，
   * 而那看起来像"模型变笨"）、**刚才那一轮花了多少**、**今天一共多少**。
   *
   * 两个数字上的讲究：
   *   · 数字一律走同一个缩写函数 —— "3598" 和 "32.0k" 并排会让人误判比例；
   *   · 估算值前面加 `~`。服务端回了真实 usage 才是账单上的数，
   *     按字数推出来的数长得一样是这个功能最坏的失败方式。
   *
   * 位置换了：以前是右下角一块三行角标（?dev=1 才有），现在是状态区里的
   * 「水位条 + 数字」，细账进 tooltip。理由有两条：屏幕上那一条本来就是
   * "它现在怎么样"；而右下角在答案铺开之后正好压在字上。
   */
  const tokNum = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M`
    : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));

  function renderTok(u) {
    if (!u) return;
    const pct = Math.max(0, Math.min(100, u.ctx?.pct ?? 0));
    const est = u.turn?.est || u.session?.est;
    const tilde = est ? '~' : '';
    /* 上限后面加 `?` = 这个窗口大小是**缺省值猜的**，不是查到的。
       水位百分比全靠它当分母，猜错的话那个百分比就是假的 —— 必须看得出来。 */
    const lim = `${tokNum(u.limit || 0)}${u.limitSrc === 'default' ? '?' : ''}`;
    const used = tokNum(u.ctx?.tokens || 0);
    barCtxNum.textContent = `${tilde}${used} / ${lim}`;
    barCtxFill.style.width = `${pct}%`;
    /* 颜色是第二信号，数字永远同时在场。三档：够用 / 要留意 / 快满了 */
    barCtxFill.dataset.lv = pct >= 85 ? 'hot' : pct >= 60 ? 'warm' : '';

    const money = u.price
      ? (u.price.free ? '免费' : `¥${(u.day?.cost ?? 0).toFixed(4)}`)
      : '单价未配置';
    const p = u.ctx?.parts;
    /* 构成那一行是给"想省 token"的人看的：12k 里 9k 是系统提示词，
       那裁历史一点用都没有 —— 不知道这件事，优化就会做在最没用的地方。 */
    barCtx.title = [
      `上下文 ${pct}%（${tilde}${used} / ${lim}）`,
      p ? `系统 ${tokNum(p.sys)} · 工具 ${tokNum(p.tools)} · 历史 ${tokNum(p.hist)}` : '',
      `本轮 ↑${tilde}${tokNum(u.turn?.in || 0)} ↓${tilde}${tokNum(u.turn?.out || 0)}`
        + ` · ${u.turn?.calls || 0} 步` + (u.turn?.cached ? ` · 缓存 ${tokNum(u.turn.cached)}` : ''),
      `今日 ↑${tokNum(u.day?.in || 0)} ↓${tokNum(u.day?.out || 0)} · ${money}`,
    ].filter(Boolean).join('\n');
  }

  /* 记忆：条数常驻、内容进 tooltip。它不是模型上下文的一部分，
     是"我记得多少事"这样一个给人看的数字。 */
  function renderMem(m) {
    if (!m) { barMem.textContent = ''; return; }
    if (!m.on) {
      barMem.textContent = '记忆关';
      barMem.title = '记忆侧车没连上';
      return;
    }
    barMem.textContent = `${m.facts ?? 0} 条`;
    barMem.title = m.recent ? `${m.recent}\n（${m.last || ''}）` : '还没有记住什么';
  }

  /** 连接点：青=通、琥珀=在想、红=断。它是这一行里唯一的状态，所以不用文字 */
  function setLink(kind) {
    barDot.classList.toggle('off', kind === 'off');
    barDot.classList.toggle('on', kind === 'busy');
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
      setLink('off');
      barTool.textContent = '断线了';
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
    /* 表情跟着一轮走：跑起来是"说话"（嘴随字开合），停下来才轮换。
       §7.3 那条"思考与输出期间不换表情"就落在这里 —— 不通知它，它会在
       模型说话的十几秒里自己换三次脸。 */
    face?.setBusy(v);
  }

  let spinTimer = 0;

  function setThink(on) {
    thinking += on ? 1 : -1;
    if (thinking < 0) thinking = 0;
    /* 「在想」不动相干度。这一条是被用户指着屏幕说的 bug：
       coh 0.58 时每颗 UI 点都被随机推开 (1-coh)×40 ≈ 17px，而 22px 的字总共
       才 22px 高 —— 字、仪表、曲线一起散成一团雾，"什么都看不出来"。
       相干度是"溶解"的语法（画散场时才该动），不是"加载中"。
       加载中和输出中靠三件事区分，各管一层：
         在想 → 青色三臂涡环（形状）+ 环境球回到 35%（亮度）+ 内容清空
         输出 → 白字块 / 场景自己的配色，背景压回 6%（只有内容在发光） */
    if (thinking > 0) {
      ringOn();
      ambientTo(thinkDim());
      if (!spinTimer) {
        /* 涡要"一直有"：单次涡 2.6 秒就衰减完了，而模型想 8 秒的时候
           屏幕会重新变成死水。所以按 2.4 秒补一次，转速比刚才那次更慢一点，
           连起来看是一股持续的环流。 */
        /* 涡的刚度不能压过弹簧。600 时点被甩开的速度远大于回位，那圈"正在想"的环
           直接散成一片雾（截图里根本找不到环）；320 还是一片糊；180 才是
           "云在慢慢转、环还立得住"的位置。再小就看不出来了。 */
        const kick = () => field.vortex(innerWidth / 2, Math.max(area.y + 64, (ans?.top ?? lineY - 120) - 92), {
          r: 760, k: 180, swirl: 1.6, ms: 3000, ease: 1.1,
        });
        kick();
        spinTimer = setInterval(kick, 2400);
      }
    } else {
      ringOff();
      ambientTo(ENV_DIM_AGENT);
      clearInterval(spinTimer);
      spinTimer = 0;
    }
    /* 状态区只表达两件事：连着没有、是不是在等。工具名由下面单独写 */
    setLink(thinking > 0 ? 'busy' : 'ok');
    if (!thinking) barTool.textContent = '';
  }

  /** 「在想」时背景该多亮：空屏亮一点（云才看得见），有内容时只轻轻抬一下 */
  function thinkDim() {
    return scene && scene.layers.size > 0 ? ENV_DIM_THINK_BUSY : ENV_DIM_THINK;
  }

  function clearThink() {
    thinking = 0;
    ringOff();
    ambientTo(ENV_DIM_AGENT);
    clearInterval(spinTimer);
    spinTimer = 0;
    field.setCoherence(1);
    setLink('ok');
    barTool.textContent = '';
  }

  /* 背景亮度要渐变：0.65 → 0.94 一帧跳过去，整个球面会闪一下，像屏幕抖了 */
  let ambRAF = 0;
  let ambTo = ENV_DIM_AGENT;
  function ambientTo(v) {
    ambTo = v;
    if (ambRAF) return;
    const step = () => {
      const d = ambTo - field.drawDim;
      if (Math.abs(d) < 0.004) { field.drawDim = ambTo; ambRAF = 0; return; }
      field.drawDim += d * 0.10;
      ambRAF = requestAnimationFrame(step);
    };
    ambRAF = requestAnimationFrame(step);
  }

  function onEvent(m) {
    switch (m.t) {
      case 'hello':
        t0 = performance.now();
        setLink('ok');
        barTool.textContent = '';
        if (m.model) barModel.textContent = m.model;
        insp('hello', `${m.model} · sys=${m.sys} · ${m.tools.length} tools`);
        renderTok(m.usage);
        renderMem(m.mem);
        /* 提示语只在用户还没说话时出现 —— 它占的是"那一行"，不是额外一行 */
        if (!askText) echo('');
        break;

      case 'resume':
        /* 不是"重新长一遍"：用户没有发起任何事，画面应该已经在那儿 */
        if (m.log?.length) { log = m.log.slice(-40); histBtn.hidden = false; if (histOpen) renderHist(); }
        if (m.scene) {
          scene.set(m.scene);
          if (m.ops) scene.patch(m.ops);
          /* 场景回来了，答案块要重新挑规格（big ⇄ compact） */
          applyMode();
          /* 先清再写：新的一句比原来短时，旧字的残余点会留在原地 */
          ans.set('', { instant: true });
          /* 上一轮"问"从记录里捞回来：只恢复模型的回答，重连后就像
             自己没说过话（记录里 r === 'u' 那条就是） */
          const lastAsk = [...(m.log || [])].reverse().find((e) => e.r === 'u');
          if (lastAsk?.t) { askText = lastAsk.t; ask?.set(askText, { instant: true, color: ASK_COLOR }); }
          if (m.line) { sayText = m.line; sayColor = SAY_COLOR; ans.set(m.line, { instant: true, color: SAY_COLOR }); }
          insp('resume', `恢复上一屏（${m.scene.layers?.length ?? 0} 层）`);
        }
        break;

      case 'turn':
        setBusy(true);
        insp(m.kind === 'intent' ? '→ 手势' : '→ 你问',
          m.kind === 'intent' ? describe(m.intent) : askText);
        break;

      case 'think': setThink(m.on); break;

      case 'say':
        /* 它一开口，"在想"那圈就该收了：圆心要腾出来给字 */
        ringOff();
        speak(m.text);
        /* 第一次有答案 → 内容区从满宽切成左右分栏。以前这一步只在"场景落地"时做，
           模型只说话不出图时整屏会一直停在满宽，答案块没地方站。 */
        applyMode();
        histPush('a', m.text);
        insp('say', m.text, 'say');
        break;

      case 'tool':
        if (m.state === 'run') {
          /* 参数只取一小截：完整 JSON 一排下去能横穿半个屏幕，
             而观察窗要的是"它在干什么"，不是它发了什么报文。 */
          insp('tool', `${m.name} ${JSON.stringify(m.args).slice(0, 46)}`, 'tool');
          barTool.textContent = m.name;
        } else {
          insp('·', `${m.name} → ${m.note || m.state}${m.ms != null ? ` (${m.ms}ms)` : ''}`, 'tool');
          /* 跑完就撤：常驻的话，用户会以为界面卡在那个工具上 */
          if (barTool.textContent === m.name) barTool.textContent = '';
          /* 工具失败 / 被拒：脸红一下（§7.2 的「警觉」）。其余状态不打扰 */
          if (m.state === 'err' || m.state === 'denied') face?.alert();
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
          if (full) pacer.run('transition', () => { scene.transition(m.spec); afterScene(); });
          else pacer.run('set', () => { scene.set(m.spec); afterScene(); });
        } else if (m.op === 'transition') {
          pacer.run('transition', () => { scene.transition(m.spec); afterScene(); });
        } else if (m.op === 'patch') {
          pacer.run('patch', () => { scene.patch(m.ops); afterScene(); });
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
        barTool.textContent = '';
        break;

      /* 记忆条数：每轮结束后服务端会重数一遍（可能刚抽出一条新的） */
      case 'mem': renderMem(m); break;

      case 'note': insp('note', m.message); break;
      case 'busy': insp('busy', '上一轮还没结束，这一步先排队'); break;

      /* 人格层注入了旧事。这一行是验收用的：屏幕上它说「重启过 n8n（#41）」，
         这里就得看得见 #41 确实是被注入的，而不是它编的编号。 */
      case 'persona':
        if (m.items?.length) {
          insp('persona', m.items.map((x) => `#${String(x.id).replace(/^i/, '')} ${x.text}`).join(' · '), 'persona');
        } else if (m.trace) {
          insp('persona', `它提到了 ${m.trace.ids.map((x) => `#${String(x).replace(/^i/, '')}`).join(' ')}`, 'persona');
        }
        break;

      /* 每步一次、轮末再一次。角标常驻，观察窗里只留最后一条当"过程"——
         每步都往观察窗里加会把工具调用挤出去，而工具调用才是排障的主线。 */
      case 'usage':
        renderTok(m);
        if (m.turn?.calls && !m.final) {
          insp('tok', `↑${m.turn.in} ↓${m.turn.out} · ctx ${m.ctx?.pct ?? 0}%`, 'tok');
        }
        break;

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
        speak(friendly(m.message));
        insp('error', m.message);
        setBusy(false);
        barTool.textContent = '';
        /* 出错了它自己也该变脸（§7.2 的「警觉」）：屏幕上一句话说清原因，
           角落那张脸同时红一下 —— 两条通道说的是同一件事，但不重复。 */
        face?.alert();
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
  let drawAsk = '';   // 画占屏期间被收起来的两块字，散场后要还回去

  function stopDraw() {
    clearTimeout(drawTimer);
    drawTimer = 0;
    if (!field.drawOn) return;
    field.clearDraw();
    /* 画不是"换了一屏"，是"临时占用桌面"：散掉之后原来那一屏要回来。
       clearDraw 有 1.6s 的回落，等它落定再重铺，否则两套点会叠在半路。 */
    const spec = scene?.spec;
    const back = drawLine;
    const backAsk = drawAsk;
    drawLine = '';
    drawAsk = '';
    setTimeout(() => {
      if (spec?.layers?.length) scene.set(spec);
      if (backAsk) { askText = backAsk; ask?.set(backAsk, { instant: true, color: ASK_COLOR }); }
      if (back) speak(back, { instant: true });
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
    speak('没画出来', { instant: true });
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
    /* 两块字都让位：画的点会写到同一批槽位上（画完再还回来，见 stopDraw） */
    drawSay = sayText;
    drawAsk = askText;
    ans.set('', { instant: true });
    ask?.set('', { instant: true });
    sayText = '';
    askText = '';
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
  /* 按下回车这一下：给一股涡，表示"话被拿走了"。
   *
   * 原来这里还会把句子从右往左吃掉 —— 但吃掉之后屏幕就空了，直到模型回话为止
   * 什么都没有，那一段是纯空白（用户原话："输入完内容之后就是消失了"）。
   * 现在句子留着（暗色），涡只是"收到"的动作，转圈的粒子云是"在想"的状态。 */
  function ingest(txt) {
    const n = Array.from(String(txt || '')).length;
    if (!n) return;
    field.vortex(innerWidth / 2, lineY - 150, {
      r: Math.min(680, 300 + n * 28),
      k: 2100, swirl: 2.9, ms: 950,
    });
  }

  function submit() {
    const text = typeEl.value.trim();
    if (!text) return;
    /* 自己说的话留在**输入行**（暗色、一行），不进上面那块 —— 那块留给回答。
       同时把上一轮的回答收掉：这一屏进入"在想"，屏幕上只该有"问 + 环"。 */
    echo(text);
    sayText = '';
    ans?.set('', { instant: true });
    insp('你', text);
    histPush('u', text);
    send({ t: 'ask', text });
    typeEl.value = '';
    ingest(text);
    closeHist();
  }

  typeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    /* 空格翻页（§8）。只在输入框**空着**时接管：里面有字时空格就是空格，
       抢了就会出现"打着打着突然翻页"。 */
    if (e.key === ' ' && !typeEl.value && !e.isComposing && !histOpen) {
      if (ans?.goPage(1)) { e.preventDefault(); updateFooter(); return; }
    }
    if (e.key === 'ArrowDown' && histOpen) { e.preventDefault(); closeHist(); return; }
    /* ↓/↑ 翻答案的页；输入框里有字时这两个键属于"我要改这句话"，不去抢。
       ↑ 还有一个身份是"看记录" —— 顺序是**先翻页、翻到头再看记录**：
       有上一页时 ↑ 的语义是"往上翻"，那时候弹记录面板等于把正文盖掉。 */
    if (e.key === 'ArrowDown' && !typeEl.value && !e.isComposing) {
      if (ans?.goPage(1)) { e.preventDefault(); updateFooter(); }
    }
    if (e.key === 'ArrowUp' && !typeEl.value && !e.isComposing) {
      if (ans && ans.goPage(-1)) { e.preventDefault(); updateFooter(); return; }
      e.preventDefault();
      openHist();
    }
  });
  typeEl.addEventListener('input', () => {
    /* 输入回显只进输入行，绝不进上面那块（那正是"用户的输入跑到上面去了"）。
       回显必须瞬时：逐字生长是"它刚想好"的语法，用在打字上就是卡顿。 */
    echo(typeEl.value);
  });

  /* ───────────────── 翻页 ─────────────────
   * 页码是**导航信息**，不是内容：用 DOM 一行小字，不占粒子槽位。
   * 画成粒子的话它会和正文抢同一段槽位，而且"还有几页"不需要长在点阵里。
   *
   * 它在**答案块**的底边（左半、左对齐页码、右对齐提示），不是屏幕底边 ——
   * 挂屏幕底边时它离正文有两百多像素，读的人不知道那个「1 / 3」是谁的页。
   */
  let pageEl = null;
  function updateFooter() {
    if (!pageEl) {
      pageEl = el('div', 'ag-page', '<b></b><span>空格翻页</span>');
      document.body.appendChild(pageEl);
    }
    const a = contentArea();
    const half = (a.w - 24) / 2;
    const n = ans?.pageCount ?? 1;
    /* 只有一页时不出现：页脚唯一的意义是"还有没有下一页" */
    pageEl.classList.toggle('on', n > 1);
    pageEl.querySelector('b').textContent = `${(ans?.page ?? 0) + 1} / ${n}`;
    pageEl.style.left = `${a.x + 16}px`;
    pageEl.style.top = `${a.y + a.h - 24}px`;
    pageEl.style.width = `${half - 32}px`;
  }

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
      /* 点选项 = 又说了一句话（§10）：上一轮的答案已经过时，这一屏要回到"在想"。
         和回车走同一段清理，只是"问句行"里放的是选项的标签 —— 屏幕上看得出
         你刚才挑了哪一条，而不是凭空消失。 */
      if (i.kind === 'pick') {
        if (i.optionLabel) echo(i.optionLabel);
        sayText = '';
        ans?.set('', { instant: true });
        updateFooter();
        applyMode();
      }
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

    /* 先扩池、再 build。allocator 的容量在构造那一刻定死，晚一步就还是旧上限
       —— 表现是"池子扩到 32000 了，但这一屏还是只写得下 6400 的字"。 */
    field.setAgentMode(true);
    if (!scene) build();

    /* 接管这 6400 颗粒子的绘制权。
     *
     * 少了这一步，场就是"往槽位里写了但没人画"：drawOn 还是 0，
     * drawMix 上不去，屏幕上只剩被压暗的环境球 —— 字一个都不出现，
     * 而且不报任何错。（agent.html 里这行写在初始化，我抽模块时漏了。）
     * dim/dot 是这套界面的基本观感：环境点 0.84 的暗度、UI 点 0.95 的径。
     *
     * dim 的来历：0.62 只把每颗点的 alpha 乘 0.38，可环境球是加法混合、中心叠着
     * 上千颗 —— 剩下的亮度依然盖在场上面，读数"45%"正好落在球心那片密点里，
     * 看着像透过一层星尘看字。0.84 把球压回"桌面还在那儿"的底噪；
     * 现在要读的是三行 32px 的字，用 ENV_DIM_AGENT（0.94，剩 6%）——
     * 用户的原话："背景里的粒子也可以使用或者消失掉"。 */
    /* 先退球面、再接管：球面那 6400 颗在 agent 模式下整批让给界面，
       不绘制、也不跑球面弹簧（field.setAgentMode 两件事一起做）。 */
    field.slotBegin({ dim: ENV_DIM_AGENT, dot: 0.95 });

    /* 从底部长出来：先让粒子"还没成形"，set 之后再把相干度拉回来。
       这不是入场动画 —— 是 §4.6 的相变语法，用户看到的是"桌面正在变成它"。 */
    field.setCoherence(0.34);
    field.setStiff(2.3);

    layer.hidden = false;
    face?.start();
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
    if (askText || sayText) reassertLine();
    else echo('');
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
    face?.stop();
    /* 球面在 700ms 里回来；池子同步缩回，那一万多个槽位不该继续挂在界面上 */
    field.setAgentMode(false);
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
      const keepAsk = askText;
      const keepSay = sayText;
      build();
      typeEl.style.top = `${lineY - 17}px`;
      if (spec) scene.set(spec);
      if (keepAsk) { askText = keepAsk; ask?.set(keepAsk, { instant: true, color: ASK_COLOR }); }
      if (keepSay) { sayText = keepSay; speak(keepSay, { instant: true }); }
    }, 260);
  });

  return {
    get field() { return field; },
    get scene() { return scene; },
    /* 两块字的句柄：自测要能看见它们的槽位与坐标（双影这类问题只能在坐标上找）。
       不能叫 ask —— 下面那个同名的测试钩子会把它盖掉（第一版就踩了）。 */
    get askLine() { return ask; },
    get answerBlock() { return ans; },
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
      ask: askText, say: sayText,
      answer: ans ? { mode: ans.text ? 'split' : 'wide', page: ans.page, pages: ans.pageCount, used: ans.used, cap: ans.capacity, typing: ans.typing } : null,
      ring: !!face?.loading,
      mood: face?.mood,
      layers: scene ? [...scene.layers.keys()] : [],
      spec: scene?.spec?.layers?.map((l) => l.kind + ':' + l.id).join(' ') || '',
    }),
  };
}
