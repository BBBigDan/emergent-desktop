/**
 * 右下角设备状态 —— 和左边缘应用栏**同一套逻辑**：
 * 不常驻。鼠标贴到右下角，粒子从中间那团里抽出一条流、螺旋着流过来拼成仪表盘；
 * 移开就沿原路逆流回团里。
 *
 * 这个文件只做三件事：
 *   1. 把仪表盘**画成点阵**（边框 / 四个环形表 / 点阵数字 / 流量走势），
 *      输出 [{x, y, w, c, s}] 交给 field.js 去流、去画；
 *   2. 建一层 DOM，只放**文字**（表名、设备信息），跟点阵严格对位 ——
 *      和左边的图标+名字是同一套分工：图形归粒子，字归 DOM；
 *   3. 采样数据。见 createSource()：**目前是模拟源**，理由与替换点写在那儿。
 *
 * 为什么数字也是粒子而不是 DOM 文本：仪表盘的核心读数如果换成 DOM，
 * 一眼就能看出"这是张贴图"；点阵数字（3×5 点阵字形）跟着边框一起流出来，
 * 才是"粒子拼成的仪表"。代价是只能显示 0~99 的整数 —— 对这四个指标够用。
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* 面板尺寸（CSS px）。原点在面板中心，y 向下（和点阵坐标同一套，field 里再取反）。 */
const PW = 360;
const PH = 168;
const PAD_R = 20;      // 距屏幕右边
const PAD_B = 22;      // 距屏幕下边
const PAD_R_CORNER = 18;
const HX = PW / 2;
const HY = PH / 2;

/* 配色照需求文档：CPU #44aaff / 内存 #b277ff / 硬盘 #ffb040 / 告警 #ff4c5c。
 * NET 用文档里的 GPU 电青 #2ee4d8 顶上（同一条青绿，做"流量"很合适）。 */
const C = {
  frame: [148, 202, 255],
  cpu: [68, 170, 255],
  mem: [178, 119, 255],
  disk: [255, 176, 64],
  net: [46, 228, 216],
  warn: [255, 76, 92],
};

const COLS = [
  { key: 'cpu', label: 'CPU', c: C.cpu, x: -132 },
  { key: 'mem', label: 'MEM', c: C.mem, x: -44 },
  { key: 'disk', label: 'DISK', c: C.disk, x: 44 },
  { key: 'net', label: 'NET', c: C.net, x: 132, unit: ' MB/s' },
];
const GY = -14;        // 环心 y
const GR = 31;         // 环半径
const ARC0 = Math.PI * 0.75;      // 135° 起（屏幕坐标 y 向下 → 左下）
const ARC = Math.PI * 1.5;        // 270° 扫过去，缺口留在下方
const N_ARC = 44;      // 每个环（每圈）的点数

/* 3×5 点阵字形。数字必须是"点阵"，因为它会跟着边框一起被流出来 */
const GLYPH = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

const SPN = 60;        // 走势线点数
const SPY = 60;        // 走势线基线 y
const SPA = 18;        // 走势线振幅（低值也按 sqrt 抬起来，不然平时是一条直线）

/* ------------------------------ 数据源 ------------------------------
 * **直接用官方桌面自己的那个接口**（`/www/desktop/js/app.js` 里 getMonitorInfo）：
 *
 *     GET /bfl/monitor/v1alpha1/cluster   →  { code:0, data:{ cpu, memory, disk, net } }
 *     cpu/memory/disk = { total, usage, ratio }   （ratio 是百分数，官方 QKnob 直接显示 `${ratio}%`）
 *     net             = { received, transmitted } （字节/秒）
 *
 * 官方两个前端（桌面外壳 / Dashboard 应用）都是这个调用，所以这里抄的是同一份，
 * 没有自己造指标：同源 + 带 cookie 就行（桌面自己也是这么拿的）。
 *
 * 拿不到的时候（本地 `127.0.0.1` 联调没有登录态、或接口变了）自动退回**模拟值**，
 * 否则本地根本没法调样式。`src.mode` 会标出当前用的是哪一种：
 *   live = 官方接口 / sim = 模拟。控制台只会提示一次，不刷屏。
 */
const LIVE_PATHS = [
  /* 官方 1.12.3+ 走的是这条（settings 域的 /api/users/monitor/cluster，
     我们这里是同域，直接命中） */
  '/api/users/monitor/cluster',
  /* 老路径 / 兜底：bfl 网关。壳层的 nginx 专门给 /bfl/ 开了口子 */
  '/bfl/monitor/v1alpha1/cluster',
];
const NET_FULL = 25;     // 网速满量程（MB/s）：25 MB/s ≈ 200 Mbps，家用/小集群够用

/** 兜底：拿不到 /api/system/status 时用浏览器报的核心数/内存（只对客户端准确） */
export function deviceCap() {
  const c = navigator.hardwareConcurrency || 0;
  const g = navigator.deviceMemory || 0;   // GB，Chrome 有；且是量化值（可能是 8/16）
  const parts = [];
  if (c) parts.push(`${c}C`);
  if (g) parts.push(`${Math.round(g)}G`);
  return parts.join(' · ') || 'unknown';
}

/**
 * 设备信息（面板右上角那行）：`/api/system/status` 是**不需要登录**的，
 * 里面就有真实的核心数 / 内存 / 磁盘。浏览器的 navigator 报的是**客户端**的
 * 硬件，装在服务器上的桌面会把它显成自己——所以这里以接口为准。
 */
export async function readCap() {
  try {
    const r = await fetch('/api/system/status', { credentials: 'include', cache: 'no-store' });
    const j = await r.json();
    const d = j && j.data;
    if (!d) return null;
    const cores = (String(d.cpu_info || '').match(/(\d+)[-\s]?core/i) || [])[1];
    const mem = String(d.memory || '').replace(/\s+/g, '');     // "15 G" → "15G"
    const parts = [];
    if (cores) parts.push(cores + 'C');
    if (mem) parts.push(mem);
    return parts.length ? parts.join(' · ') : null;
  } catch { return null; }
}

/** 官方返回的 {total, usage, ratio} → 0..1。优先用 usage/total（最准），没有再退 ratio */
function pct(m) {
  if (m == null) return null;
  if (typeof m === 'number') return m > 1.5 ? m / 100 : m;
  if (typeof m.usage === 'number' && typeof m.total === 'number' && m.total > 0) {
    return m.usage / m.total;
  }
  if (typeof m.ratio === 'number') return m.ratio > 1.5 ? m.ratio / 100 : m.ratio;
  return null;
}

async function once(path) {
  const r = await fetch(path, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error('not json');
  const j = await r.json();
  if (!j || j.code !== 0 || !j.data) throw new Error('code ' + (j && j.code));
  return j.data;
}

/** 两条路径都试；哪条成了就记住（下次先试它，省一次 404） */
async function pull() {
  let err;
  for (let i = 0; i < LIVE_PATHS.length; i++) {
    const idx = (pathIdx + i) % LIVE_PATHS.length;
    try {
      const d = await once(LIVE_PATHS[idx]);
      pathIdx = idx;
      return d;
    } catch (e) { err = e; }
  }
  throw err;
}

let pathIdx = 0;   // 上次成功的那条

function createSource() {
  /* net 用 MB/s 存（官方给的是字节/秒），另外三个是 0..1 */
  const values = { cpu: 0.34, mem: 0.58, disk: 0.71, net: 0 };
  /* 初始历史给一段"起伏过"的形状：全填同一个值的话，第一条走势线是一条直线，
     看起来像进度条而不是流量曲线 */
  const hist = [];
  for (let i = 0; i < SPN; i++) {
    hist.push(clamp(0.05 + Math.pow(Math.random(), 2.4) * 0.55, 0.03, 0.7));
  }
  let burst = 0;
  let mode = 'sim';
  let warned = false;
  const rnd = () => Math.random() - 0.5;

  function simStep() {
    /* cpu：往 0.32 回归 + 噪声，偶尔来一下尖峰（不然像死了一样） */
    values.cpu = clamp(values.cpu + (0.32 - values.cpu) * 0.22 + rnd() * 0.30, 0.04, 0.97);
    if (Math.random() < 0.06) values.cpu = clamp(values.cpu + 0.35, 0.05, 0.99);
    /* mem：慢得多 —— 内存是真慢变量 */
    values.mem = clamp(values.mem + (0.60 - values.mem) * 0.10 + rnd() * 0.05, 0.28, 0.93);
    /* disk：几乎不动 */
    values.disk = clamp(values.disk + rnd() * 0.012, 0.5, 0.93);
    /* net：平时很低，偶尔一段突发（突发期间走势线才好看） */
    if (burst > 0) {
      burst--;
      values.net = 6 + Math.random() * 14;
    } else {
      values.net = Math.max(0.05, values.net * 0.5 + Math.random() * 0.9);
      if (Math.random() < 0.07) burst = 1 + ((Math.random() * 3) | 0);
    }
  }

  function pushHist() {
    hist.push(clamp(values.net / NET_FULL, 0, 1));
    if (hist.length > SPN) hist.shift();
  }

  return {
    values,
    hist,
    get mode() { return mode; },
    /**
     * 拉一次数据。成功 → live；失败 → 保留上一次的值；一次都没成功过 → 模拟。
     * 已经在 live 状态时偶发失败**不清零**（网络抖一下不该让面板跳成 0）。
     */
    async poll() {
      try {
        const d = await pull();
        const c = pct(d.cpu), m = pct(d.memory), k = pct(d.disk);
        if (c != null) values.cpu = clamp(c, 0, 1);
        if (m != null) values.mem = clamp(m, 0, 1);
        if (k != null) values.disk = clamp(k, 0, 1);
        if (d.net) {
          const rx = Number(d.net.received) || 0;
          const tx = Number(d.net.transmitted) || 0;
          values.net = (rx + tx) / 1e6;
        }
        mode = 'live';
        pushHist();
        return true;
      } catch (e) {
        if (mode !== 'live') {
          if (!warned) {
            warned = true;
            console.info('[status] 取不到官方监控接口，先用模拟数据：' + e.message);
          }
          simStep();
        }
        pushHist();
        return false;
      }
    },
  };
}

/* ---------------------------- 点阵布局 ---------------------------- */

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 过载着色：82% 起过渡、94% 到满，免得半途是发脏的紫 */
function tint(base, val) {
  if (val <= 0.82) return base;
  return mix(base, C.warn, Math.min(1, (val - 0.82) / 0.12));
}

function buildDots() {
  const dots = [];

  /* ---- 边框：flow 点，沿圆角矩形周长慢慢环流（面板才有"活着"的读法）---- */
  const per = 2 * (PW - 2 * PAD_R_CORNER) + 2 * (PH - 2 * PAD_R_CORNER)
    + 2 * Math.PI * PAD_R_CORNER;
  const nf = Math.round(per / 2.5);
  for (let i = 0; i < nf; i++) {
    dots.push({
      k: 1, u0: i / nf, off: (Math.random() * 2 - 1) * 0.9, spd: 52 + Math.random() * 26,
      w: 0.72, c: C.frame, s: 2.05 + Math.random() * 0.45, a: 0.85,
    });
  }
  /* 外圈一层"尘"：更暗更慢，让边框不是一条硬线，而是一层厚度 */
  for (let i = 0; i < 84; i++) {
    dots.push({
      k: 1, u0: Math.random(), off: 3.5 + Math.pow(Math.random(), 1.6) * 11, spd: 14 + Math.random() * 12,
      w: 0.10, c: C.frame, s: 1.4 + Math.random() * 1.0, a: 0.7,
    });
  }

  /* ---- 四个环形表：轨道点固定，亮度表示"填到哪" ---- */
  for (const col of COLS) {
    for (let ring = 0; ring < 2; ring++) {
      const rad = GR - ring * 4.6;
      for (let j = 0; j < N_ARC; j++) {
        const p = j / (N_ARC - 1);
        const a = ARC0 + ARC * p;
        dots.push({
          role: 1, key: col.key, p, w: 0.15, c: col.c, base: col.c, s: ring ? 1.85 : 2.2,
          x: col.x + Math.cos(a) * rad,
          y: GY + Math.sin(a) * rad,
        });
      }
    }
  }

  /* ---- 点阵数字：每个环里两位整数（0~99）----
   * 位间距必须**明显大于**点间距：两者都用 sp 的话，"44" 会连成一片 6 列的方格阵，
   * 根本分不出是哪两位（第一版就是这个坑）。位间留 1.6 格。 */
  const sp = 5.6;
  const GAPX = 1.55 * sp;
  for (const col of COLS) {
    const left = col.x - (5.6 * sp) / 2;
    for (let g = 0; g < 2; g++) {
      const gl = left + g * (2 * sp + GAPX);
      for (let r = 0; r < 5; r++) {
        for (let c2 = 0; c2 < 3; c2++) {
          dots.push({
            role: 2, key: col.key, g, bit: r * 3 + c2, w: 0, c: col.c, s: 1.85,
            x: gl + c2 * sp, y: GY + (r - 2) * sp,
          });
        }
      }
    }
  }

  /* ---- 流量走势线：点本身不动，是 y 跟着数据走（每秒重排一次）---- */
  for (let i = 0; i < SPN; i++) {
    dots.push({
      role: 3, i, w: 0.2, c: C.net, s: 1.75,
      x: -162 + (324 * i) / (SPN - 1), y: SPY,
    });
  }

  return dots;
}

/* ------------------------------- 主件 ------------------------------- */

/**
 * @param {{
 *   onOpen?: () => void,
 *   onClose?: () => void,
 *   onDots?: (dots:Array, panel:object) => void,
 * }} opt
 */
export function createStatus({ onOpen, onClose, onDots } = {}) {
  const dots = buildDots();
  const src = createSource();
  const panel = {
    cx: 0, cy: 0, hw: HX, hh: HY, r: PAD_R_CORNER,
    w: PW, h: PH,
  };

  /* ------------------------------- DOM ------------------------------- */
  const zone = document.createElement('div');
  zone.className = 'stat-zone';

  const box = document.createElement('div');
  box.className = 'stat void';
  box.style.width = PW + 'px';
  box.style.height = PH + 'px';
  zone.appendChild(box);

  const head = document.createElement('div');
  head.className = 'stat-head';
  /* 只留设备信息。标题"设备状态"是句废话 —— 四个表盘摆在这儿，不用说也知道是什么 */
  head.innerHTML = `<span class="stat-cap">${deviceCap()}</span>`;
  const capEl = head.firstChild;
  /* 启动时拉一次真实设备信息（免登录）；拿不到就留着 navigator 的兜底值 */
  readCap().then((t) => { if (t) capEl.textContent = t; });
  box.appendChild(head);

  /* 表名：位置和点阵里的环心对齐（左 = HX + col.x，上 = HY + 标签 y） */
  const LAB_Y = 30;
  for (const col of COLS) {
    const el = document.createElement('div');
    el.className = 'stat-lab';
    el.textContent = col.label;
    /* NET 读数是 MB/s，另外三个是百分比：不标单位的话那两位数没有意义 */
    if (col.unit) {
      const u = document.createElement('i');
      u.textContent = col.unit;
      el.appendChild(u);
    }
    el.style.left = HX + col.x + 'px';
    el.style.top = HY + LAB_Y + 'px';
    box.appendChild(el);
  }

  document.body.appendChild(zone);

  /* ------------------------------ 绘制 ------------------------------ */
  function paint() {
    const v = src.values;
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      if (d.role === 1) {
        /* NET 没有"百分比"这个概念，满量程按 NET_FULL 折算，读数用 MB/s */
        const val = d.key === 'net' ? clamp(v.net / NET_FULL, 0, 1) : v[d.key];
        const on = d.p <= val;
        d.w = on ? 1.1 : 0.22;
        /* 最靠近读数的那一个点亮一档：像指针，也标出"填到哪" */
        if (on && d.p > val - 0.045) d.w = 2.3;
        /* 过载（>82%）往告警色过渡，和文档的配色规则一致。
           过渡区间给窄一点（82→94 就走完），否则蓝色混到一半是发脏的紫红。 */
        d.c = tint(d.base, val);
      } else if (d.role === 2) {
        const n = d.key === 'net'
          ? Math.min(99, Math.round(v.net))
          : Math.min(99, Math.round(v[d.key] * 100));
        const ch = d.g === 0 ? Math.floor(n / 10) : n % 10;
        /* 数字跟着环一起报警（只让环变红、数字还是蓝的，看着像两块东西） */
        d.c = tint(d.base2 || (d.base2 = d.c),
          d.key === 'net' ? clamp(v.net / NET_FULL, 0, 1) : v[d.key]);
        /* 灭掉的点留一点点余光：整块 3×5 矩阵淡淡的在那儿，才像"点阵屏" */
        d.w = GLYPH[ch][(d.bit / 3) | 0][d.bit % 3] === '1' ? 1.5 : 0.02;
      } else if (d.role === 3) {
        /* 开方抬低值：流量平时都只有 10% 上下，线性映射会是一条死平线 */
        d.y = SPY - Math.sqrt(src.hist[d.i]) * SPA;
        /* 越靠右越新、越亮：走势的方向一眼能看出来 */
        d.w = 0.34 + 0.75 * (d.i / (SPN - 1));
      }
    }
    onDots?.(dots, panel);
  }

  /* ------------------------------ 开合 ------------------------------ */
  let open = false;
  let closeTimer = 0;
  let timer = 0;

  /** 拉一次数据再重画（异步：官方接口要登录态，本地联调会退回模拟） */
  function tick() {
    if (!open) return;
    src.poll().then(() => { if (open) paint(); });
  }

  function openStat() {
    clearTimeout(closeTimer);
    closeTimer = 0;
    if (open) return;
    open = true;
    zone.classList.add('open');
    paint();                       // 先按手里的值画一版，别让面板空着流出来
    onOpen?.();
    tick();
    /* 官方桌面是 5s 一次；这里 3s，面板是小件，刷新快一点也不会压到后端 */
    timer = setInterval(tick, 3000);
  }

  function closeStat() {
    if (!open) return;
    open = false;
    zone.classList.remove('open');
    clearInterval(timer);
    timer = 0;
    onClose?.();
  }

  zone.addEventListener('pointerenter', openStat);
  zone.addEventListener('pointerleave', () => {
    clearTimeout(closeTimer);
    /* 比应用栏宽一点：这块面板大，从边上擦过去不该闪 */
    closeTimer = setTimeout(closeStat, 420);
  });
  zone.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') openStat(); });

  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    panel.cx = W - PAD_R - PW / 2;
    panel.cy = H - PAD_B - PH / 2;
    onDots?.(dots, panel);
    return panel;
  }
  layout();

  return {
    el: zone,
    dots,
    panel,
    /* 数据源也挂出来：接真接口时替换的入口，调试时也能直接改值看告警配色 */
    src,
    layout,
    open: openStat,
    close: closeStat,
    isOpen: () => open,
    /** 由主循环每帧调用：粒子到位后才让文字浮现（和窗口的 --rev 一个套路） */
    sync(rev) {
      box.style.setProperty('--rev', rev.toFixed(3));
      box.classList.toggle('void', rev < 0.02);
    },
  };
}
