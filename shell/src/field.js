/**
 * 连续粒子场 —— 整屏一层 WebGL，窗口的「粒子门」是这层场的一部分。
 *
 * 坐标系：世界 = CSS 像素，原点在屏幕中心，y 向上（正交相机，1 单位 = 1px），
 * 所以 gl_PointSize 可以当成像素直径直接写。
 *
 * 两类粒子：
 *   ambient —— 背景底噪，缓慢漂移，数量恒定，构成「桌面本身是一团粒子」的地基
 *   rim     —— 绑定到某个窗口的圆角矩形轮廓，负责凝聚 → 撑开 → 贴边环流；关闭时四散
 */
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 粒子流路径：A（团里）→ B（目标），中段张开成**螺旋管**、两端收束。
 * u = 0 在团里，u = 1 到位；sw 是绕几圈，ph 是这一颗的相位。
 *
 * 不直接走直线：直线看不出"流"。管径 ∝ 距离 + 一点固定值，
 * 所以近处的图标（离团近）管也细，不会糊成一团。
 * ampK 收细/放粗整根管：应用栏图标用 1（宽一点像从团里抽一束），
 * 窗口的门用 0.45（要的是"一股拧着的绳"，宽了就成一片雾）。
 * 注意这不是"每颗粒子各飞各的"，同一图标的所有点共用同一族相位（差在 delay），
 * 远看才是一条拧着的流，而不是一团乱飞的点。
 */
const STREAM = { x: 0, y: 0 };
function streamXY(ax, ay, bx, by, u, ph, sw, out = STREAM, ampK = 1) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  /* 速度要"看得清"：基本匀速（不要 ease，ease 会让中段一闪而过）。
     只在最后 12% 收一下，免得糊到目标点上。 */
  const e = u * 0.94 + u * u * 0.06;
  const amp = Math.sin(Math.PI * u) * (len * 0.068 + 10) * ampK;
  const th = sw * Math.PI * 2 * u + ph;
  out.x = ax + dx * e + nx * Math.cos(th) * amp;
  out.y = ay + dy * e + ny * Math.sin(th) * amp;
  return out;
}

const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const PAL = [
  [0.50, 0.89, 1.00],
  [0.37, 0.85, 1.00],
  [0.44, 0.98, 0.90],
  [0.60, 0.83, 1.00],
  [0.70, 0.47, 1.00],
  [1.00, 0.69, 0.25],
];
const PW = [0.26, 0.34, 0.22, 0.12, 0.04, 0.02];
function pickColor() {
  let r = Math.random(), acc = 0;
  for (let i = 0; i < PAL.length; i++) {
    acc += PW[i];
    if (r <= acc) return PAL[i];
  }
  return PAL[0];
}

/* ---------------------- 空闲态形态（照原型 SHAPE_ORDER） ----------------------
 * 桌面没有窗口时，ambient 粒子不是散着漂，而是聚成形态并自动重组：
 *   sphere 球 / torus 环面 / galaxy 五臂星系 / wave 网格涟漪
 * 原型的 5 种里 sculpture（纯引力井）依赖 3D 引力场，正交投影下看不出结构，
 * 这里先不做；其余四种按原型的参数逐条搬过来。
 */
/* 球面：**均匀** Fibonacci 分布，铺满整个球（y 从 +1 到 -1）。
 *
 * 原型是 5 条纬度带（bandH 0.168 / gap 0.030，另有类型分区），两个问题：
 *   1. y 从 1 只铺到 0.04 —— 只有北半球，是个"穹顶"，不是球；
 *   2. 带与带之间留空 → 那不是一个连续球面，而是十来个**纬度环**。
 *      静止时看不出，一旦拖动视角，每个环都投影成一个椭圆，
 *      整个球就被压成一张扁盘（实测平均投影半径 0.79R → 0.60R）。
 *
 * 所以位置改成均匀球面（球面面积均匀 ⇔ y 均匀），任何角度看轮廓都是正圆；
 * 配色仍然按 5 条纬度带分（南北各 2.5 带），保留那层横向色带的信息。 */
const BANDS = 5;                                    // 配色带数（原型 TYPES 数）
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/* 甩动识别阈值（flick）：见 detectFlick。事件间隔会被合并到 30ms 左右，
 * 所以单帧速度要按"px/实际间隔"算，700 已经能滤掉正常拖视角。 */
const FLICK_V = 700;      // px/s

const SHAPES = ['sphere', 'torus', 'galaxy', 'wave'];
const SHAPE_MS = 9000;    // 原型 shapeState.interval = 9
const FLOURISH_S = 0.9;   // 重组后 0.9s 内先向核心收拢再展开

/* 心跳：每秒多来一次"猛跳"。呼吸是 0.9rad/s 的慢起伏，心跳是叠在上面的
 * 一记短促的抽搐 —— 快速缩放 + 对半撕开（一半粒子被拽向一侧、另一半拽向另一侧，
 * 就是老电视花屏那种一帧的错位），0.35s 内收回去。 */
const HB_RISE = 0.05;     // 起跳（0.05s，两三帧就到顶）
const HB_FALL = 0.30;     // 回落

/* 有窗口时：粒子只在窗口**外面**活动（中央一块留给窗口内容）。
 * 那一圈"日冕"的厚度范围（px，贴着窗口外缘往外量）。 */
const AURA_MIN = 8;
const AURA_MAX = 84;

const AMBIENT_N = 6400;   // 整球表面积是半球 2 倍，按密度补足
/* 每个窗口的边框粒子数。760 时边框是一条细点线 —— 看得出"是点"，看不出"在流"；
   原型的门是 9000 颗一个窗口，但壳层里边框只是"一层尘"，太密会变成霓虹圈。
   1200 是两者之间：周长 3600px 上约 3px 一颗，收细后是一条能看出流动的边。 */
const RIM_PER_WIN = 1200;
const MAX_WIN = 3;
const RIM_END = AMBIENT_N + RIM_PER_WIN * MAX_WIN;

/* 左边缘应用栏：每个图标一块固定槽位。
 * 前面是图标点阵，剩下的做**悬停增援**（平时停在外圈、透明度 0，
 * 一悬停就被吸进来绕着图形浮 —— 和登录页悬停时补粒子是同一套读法）。
 *
 * 它**单独一层**（自己的 Points + 材质），不跟背景粒子共用加法混合：
 * 图标要还原官方配色，加法会把密集点叠成一团白 —— 图标必须走普通透明混合。 */
/* 左边缘应用栏：官方 dock 默认就 4 项（files/launchpad/market/settings）+ 登出，
 * 所以留 6 个槽位（多一个余量，以后要支持"用户 pin 的应用"也不用改这里）。 */
const RAIL_MAX = 6;
const RAIL_DOTS = 1080;
/* 流的"起飞时差"上限：0.32 表示最后一颗点比第一颗晚 0.32×1.7s ≈ 0.54s 出发。
   太小 = 整片平移（看不出是流）；太大 = 拖成一条细线，图形迟迟不完整。 */
const RAIL_DELAY = 0.32;
const RAIL_N = RAIL_MAX * RAIL_DOTS;

/* 右下角设备状态：和左边缘应用栏是同一套"流"，但只有一块（不是每图标一槽）。
 * 两种点：
 *   fix  —— 目标固定（环形表刻度 / 点阵数字 / 走势线），只有亮度和位置会被数据改
 *   flow —— 沿面板边框环流（u 一直推进），面板才有"是粒子拼的、还在流"的读法
 */
const STAT_MAX = 1400;
const STAT_DELAY = 0.30;
/* 面板的展开是**全局**的（不是逐粒跟自己的 delay 走）：
 * 先把点流到面板中心那一点，再从这一点整体摊开成面板。
 * 逐粒摊开的话，同一时刻有的点已经就位、有的还在路上，看到的就是一团星云。 */
const STAT_OPEN = 0.56;   // 到这个进度开始摊
const STAT_DONE = 0.98;   // 摊完
const N = RIM_END;

/* 应用列表（launchpad）：每个应用一个图标，图标也是粒子。
 *
 * 这里**不是**把图标塞进同一份 buffer，而是每个图标一个 Points 对象：
 * 圆环模式下图标有前后之分，必须按深度排序绘制（前面的挡住后面的），
 * 同一个 geometry 做不到这一点（renderOrder 只能整层设）。
 * 每个图标的局部坐标 = 该图标的点阵坐标，靠 object.scale 换大小、靠 uniform 换点径。 */
const LP_MAX = 11;
const LP_TAU = Math.PI * 2;


/* ---------------------------- 圆角矩形周长取样 ---------------------------- */
/* u ∈ [0,1) 从顶边右端起顺时针；out 带外法向 (nx,ny) 与切线 (tx,ty)，切线用于让粒子沿边流动 */
const SH = { x: 0, y: 0, nx: 0, ny: 1, tx: -1, ty: 0 };
function shapeAt(uu, a, b, r, out) {
  r = clamp(r, 0, Math.min(a, b));
  const Lh = a - r, Lv = b - r;
  const Lt = 2 * Lh, Ls = 2 * Lv, Lc = Math.PI * 0.5 * r;
  const P = 2 * Lt + 2 * Ls + 4 * Lc;
  if (P < 1e-6) { out.x = 0; out.y = 0; out.nx = 0; out.ny = 1; out.tx = -1; out.ty = 0; return P; }
  const ir = r > 1e-6 ? 1 / r : 0;
  let s = ((uu % 1) + 1) % 1 * P;

  if (s < Lt) { out.x = Lh - s; out.y = b; out.nx = 0; out.ny = 1; out.tx = -1; out.ty = 0; return P; }
  s -= Lt;
  if (s < Lc) { const t = Math.PI * 0.5 + s * ir, c = Math.cos(t), n = Math.sin(t); out.x = -Lh + r * c; out.y = Lv + r * n; out.nx = c; out.ny = n; out.tx = -n; out.ty = c; return P; }
  s -= Lc;
  if (s < Ls) { out.x = -a; out.y = Lv - s; out.nx = -1; out.ny = 0; out.tx = 0; out.ty = -1; return P; }
  s -= Ls;
  if (s < Lc) { const t = Math.PI + s * ir, c = Math.cos(t), n = Math.sin(t); out.x = -Lh + r * c; out.y = -Lv + r * n; out.nx = c; out.ny = n; out.tx = -n; out.ty = c; return P; }
  s -= Lc;
  if (s < Lt) { out.x = -Lh + s; out.y = -b; out.nx = 0; out.ny = -1; out.tx = 1; out.ty = 0; return P; }
  s -= Lt;
  if (s < Lc) { const t = Math.PI * 1.5 + s * ir, c = Math.cos(t), n = Math.sin(t); out.x = Lh + r * c; out.y = -Lv + r * n; out.nx = c; out.ny = n; out.tx = -n; out.ty = c; return P; }
  s -= Lc;
  if (s < Ls) { out.x = a; out.y = -Lv + s; out.nx = 1; out.ny = 0; out.tx = 0; out.ty = 1; return P; }
  s -= Ls;
  { const t = s * ir, c = Math.cos(t), n = Math.sin(t); out.x = Lh + r * c; out.y = Lv + r * n; out.nx = c; out.ny = n; out.tx = -n; out.ty = c; return P; }
}

/* ------------------------------- 时间轴 --------------------------------
 * 开窗（粒子门）照原型的做法，**不是"窗口在转"**：
 *   FLOW_MS  团 → 窗口中心的一点：每颗点起飞时刻错开，看到的是一束被吸过去的流
 *   SEED_MS  收成一团后，粒子就在那一点上**绕着自己流**（蓬松的一小团）
 *   GROW_MS  一边环流一边慢慢放大：小尺寸是正圆，长大过程里被拉成窗口比例的圆角矩形
 * 全程没有旋转的刚体，只有"粒子沿周长不断流动"，加上沿周长跑的亮波（脉冲包）。
 */
const PE_MIN = 0.019;   // 最小尺度（半宽 ≈ 窗口半宽 × 0.019）—— 和原型一致
const FLOW_MS = 800;
const SEED_MS = 450;
const GROW_MS = 1500;
const REVEAL_A = 0.72;  // 撑到这个比例才开始让 iframe 析出
/* 关窗：散 → 就近 6 条小流 → 小流汇成一条大流 → 被中心的团吸收 */
const CLOSE_MS = 2400;

/* 场作为界面时，未被占用的环境点还留多亮。
 *
 * 这个数只能有一个出处：deskagent 唤出时用它，scene 每铺一屏也会用它 ——
 * 原来两处各写一个（0.84 / 0.62），于是"唤出时球退下去了，模型一画屏又亮回来"，
 * 看起来像画面自己闪了一下。 */
export const UI_ENV_DIM = 0.84;

export class Field {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = 1;
    this.H = 1;
    this.time = 0;
    this.groups = [];
    for (let g = 0; g < MAX_WIN; g++) {
      /* src/p0/sc/dst/hubOf 是一次开门/关门里每颗点的端点（见 open/close）。
         存进 group 而不是临时数组：动画半路被打断（再开一次 / 再关一次）
         也还是同一份端点，不会错位。 */
      this.groups.push({
        active: false, closing: false, t: 0, closeT: 0, pe: 0.019, rect: null,
        src: new Float32Array(RIM_PER_WIN * 2),
        p0: new Float32Array(RIM_PER_WIN * 2),
        sc: new Float32Array(RIM_PER_WIN * 2),
        dst: new Float32Array(RIM_PER_WIN * 2),
        hubOf: new Uint8Array(RIM_PER_WIN),
        hubs: [],
      });
    }

    /* --- 粒子状态 --- */
    const n = N;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 2);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.kind = new Uint8Array(n);      // 0 ambient / 1 rim
    this.halo = new Uint8Array(n);      // rim 里的"晕"（法向散布大、更暗，负责蓬松感）
    /* 沿运动方向的拉伸：圆点被拉成流线，静止画面也读得出"在往哪边流"
       （原型 portal.js 的 aDir/aStr，是"看得出在流动"的关键之一） */
    this.aDir = new Float32Array(n * 2);
    this.aStr = new Float32Array(n);
    this.group = new Uint8Array(n);
    this.u = new Float32Array(n);       // 轮廓参数
    this.off = new Float32Array(n);     // 法向偏移
    this.spd = new Float32Array(n);     // 沿边流速
    this.baseA = new Float32Array(n);
    this.baseS = new Float32Array(n);
    this.phase = new Float32Array(n);

    /* --- 绘画层 ---
     * 把「画布上采出来的点云」当成 ambience 的**另一组目标位置**：
     *   drawX/Y 屏幕坐标（stepShape 里直接减视口中心，绕过 ry/tilt 的旋转）
     *   drawA/S 亮度与尺寸（墨越厚越亮）
     *   drawCol 每点颜色（画是彩色的，而 ambient 只有 5 条纬度色带）
     *   drawMix 0→1 的混合量，负责"散→聚成画→散回去"，不靠瞬切
     * 点云只编译一次，之后每帧只是读缓冲 —— 每帧重采样会变成噪点。 */
    this.drawN = 0;
    this.drawX = new Float32Array(n);
    this.drawY = new Float32Array(n);
    this.drawA = new Float32Array(n);
    this.drawS = new Float32Array(n);
    this.drawD = new Float32Array(n);       // 逐点出场延迟（0..1，drawOn 用）
    /* 窗口边缘粒子的整体亮度（agent 展开时退到 0，见 step） */
    this.rimDim = 1;
    this.rimTo = 1;
    this.drawUse = new Uint8Array(n);       // 哪几颗点被这幅画借走了
    this.drawCol = new Float32Array(n * 3);
    this.drawMix = 0;                        // 当前混合量
    this.drawOn = 0;                         // 目标混合量
    this.drawSeen = false;                   // 画过一次就一直要做颜色还原
    this.drawStart = 0;                      // drawOn 起始时间（秒）
    this.drawOnMs = 0;                       // drawOn 总时长（ms），0 = 立刻
    this.col0 = null;                        // ambient 原色快照（退出绘画时还原）
    this.wells = [];                         // 引力井（光标、被悬停的目标）—— 见 setWells

    /* 全局压暗：0 = 场退到看不见，1 = 正常。它是一条连续的线而不是开关，
       因为"退到后面"必须能半路停住（记录面板半透明时场要还能看见一点）。 */
    this.uiFade = 1;
    this.uiFadeTo = 1;

    /* 涡：一次性的切向力，按时间衰减后自己消失。
     *
     * 为什么不能复用 wells：wells 每帧被 setWells 整表重写（光标一动就换一批），
     * 涡要的是"我起的这一下，谁也別擦掉，它自己烧完"。两套寿命不同的力混在
     * 一张表里，必然有一个被另一个覆盖 —— 实测就是"鼠标一划过，涡就没了"。
     * 涡给的是切向加速度：点会绕着它转，而不是被吸过去。 */
    this.vorts = [];

    /* --- 相干度 ---
     * 0 = 完全溶解：点还在这里、还在动，但失去了"该在哪"这件事，摊成一团噪雾。
     * 1 = 完全成形：每颗点都精确落在它该在的位置上。
     *
     * 这是"相变换页"的唯一开关 —— 换景时不叠两套状态层，而是把相干度压到 0、
     * 重新布景、再拉回 1。同一批粒子，中途没有一刻是"两个界面同时在屏幕上"。
     * jit 是每点固定方向的噪声向量（不是每帧随机，否则是闪屏不是溶解）。 */
    this.coh = 1;
    this.stiff = 1;                          // 弹簧刚度倍率（相变重组时临时抬高）
    this.jit = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.55 + Math.random() * 0.65;
      this.jit[i * 2] = Math.cos(a) * r;
      this.jit[i * 2 + 1] = Math.sin(a) * r;
    }

    /* --- rail（左边缘应用栏）---
     * 每颗点记着自己属于哪个图标、在图标里的局部偏移、是不是"增援"余量。
     * 目标位置每帧由「图标中心 + 局部偏移 × 悬停缩放 + 微环/漂移」算出，
     * 再用弹簧拉过去 —— 所以拼出来的图形永远是轻微活着的，不是钉死的点阵。 */
    const m = RAIL_N;
    this.rPos = new Float32Array(m * 3);
    this.rVel = new Float32Array(m * 2);
    this.rCol = new Float32Array(m * 3);
    this.rSize = new Float32Array(m);
    this.rAlpha = new Float32Array(m);
    this.rLx = new Float32Array(m);
    this.rLy = new Float32Array(m);
    this.rRes = new Uint8Array(m);     // 1 = 悬停增援
    this.rK = new Float32Array(m);     // 弹簧刚度（逐粒不同 → 收敛有先有后）
    this.rW = new Float32Array(m);     // 漂移频率
    this.rPhase = new Float32Array(m);
    this.rA = new Float32Array(m);     // 基础亮度
    this.rS = new Float32Array(m);     // 基础点径
    this.rIcon = new Int16Array(m);
    /* 粒子流：每颗点从"团里"沿一条螺旋管飞到图标上的位置。
       delay = 起飞时刻错开（先飞的先进、后飞的后进 → 是一条流，不是整片平移）；
       src = 出发点（团内部、朝图标那一侧的一小片）；sw/ph = 螺旋圈数/相位。 */
    this.rDelay = new Float32Array(m);
    this.rSrc = new Float32Array(m * 2);
    this.rSw = new Float32Array(m);
    this.rPh2 = new Float32Array(m);
    this.railIcons = [];               // { cx, cy, h, ht }
    this.railGoal = 0;                 // 0 散 / 1 聚
    this.railOn = 0;                   // 粒子流的进度（0 全在团里 / 1 全到位）
    this.railSig = '';                 // 图标列表指纹（变了才重建槽位）
    this.railActive = -1;              // 已打开应用对应的图标
    this.railDirty = false;

    /* --- 设备状态面板（右下角）---
     * 和 rail 同构：每颗点记着"从团里哪出发、目标在哪、什么时候出发"，
     * 位置由流的进度决定。区别是这里的目标会**被数据改**
     * （环形表填到哪 → 亮度；走势线 → y 坐标），所以权重单独一组 sW。 */
    const q = STAT_MAX;
    this.sPos = new Float32Array(q * 3);
    this.sVel = new Float32Array(q * 2);
    this.sCol = new Float32Array(q * 3);
    this.sSize = new Float32Array(q);
    this.sAlpha = new Float32Array(q);
    this.sLx = new Float32Array(q);
    this.sLy = new Float32Array(q);
    this.sW = new Float32Array(q);      // 数据权重（0 灭 / 1 亮 / >1 高亮）
    this.sA = new Float32Array(q);
    this.sS = new Float32Array(q);
    this.sPh = new Float32Array(q);
    this.sDelay = new Float32Array(q);
    this.sSrc = new Float32Array(q * 2);
    this.sSw = new Float32Array(q);
    this.sPh2 = new Float32Array(q);
    this.sU = new Float32Array(q);      // flow 点的周长参数
    this.sSpd = new Float32Array(q);
    this.sOff = new Float32Array(q);    // flow 点的法向偏移
    this.sFlow = new Uint8Array(q);
    this.sPq = new Float32Array(q);     // 表盘刻度在这一圈上的相位（-1 = 不是刻度）
    this.sN = 0;
    this.statDots = null;
    this.statPanel = null;              // { cx, cy, hw, hh } CSS 像素（左上角原点）
    this.statGoal = 0;
    this.statOn = 0;
    this.statSig = '';
    this.statDirty = false;

    /* --- 应用列表（launchpad）---
     * mode: 0 桌面 / 1 3D 圆环画廊 / 2 2D 平铺
     * 每个图标一个 Points（见 LP_MAX 的注释），cx/cy/ck/ca 是弹簧中的当前值，
     * 目标值每帧按 mode 算 —— 所以 ring ↔ grid 的切换只是"换目标"，不需要重建。 */
    this.launchMode = 0;
    this.launchItems = [];
    this.launch = [];
    this.launchCount = 0;
    this.lpScreen = [];                // 给 DOM 层的投影结果（CSS px，左上角原点）
    this.ringAngle = 0;                // 圆环当前转角
    this.ringV = 0;                    // 拖动角速度
    this.gridX = 0;                    // 平铺模式的横向橡皮筋位移
    this.gridV = 0;
    this.launchHover = -1;
    this.launchProg = 0;               // 应用列表的"流"进度（0 全在团里 / 1 全部到位）
    this.onFlick = null;               // 甩动回调（main.js 用它数"两下"）
    /* 甩动识别是**按住过程中**连续做的（见 detectFlick）：没人会"甩一下、松手、再甩一下"。 */
    this.flickDir = 0;                 // 当前这一段的水平方向（±1），0 = 还没起段
    this.flickDist = 0;                // 这一段已累计的同向位移（px）
    this.flickT0 = 0;
    this.flickMoveAt = 0;              // 上一次 pointermove 的时刻（用来判"停手"）
    this.flickUsed = false;            // 这一段已经记过一次，要减速/反向才能开新的

    /* --- 空闲态形态 --- */
    this.sd = new Float32Array(n * 3);   // 单位球方向（sphere 直接复用）
    this.ta = new Float32Array(n * 3);   // 当前形态目标（3D，归一化半径 1）
    this.pu = new Float32Array(n);
    this.pv = new Float32Array(n);
    this.pr1 = new Float32Array(n);
    this.pr2 = new Float32Array(n);
    this.tp = new Uint8Array(n);         // 0..4 分区（环面分段 / 星系旋臂）
    this.form = 0;                       // 0 = 自由漂移，1 = 完全成形态
    this.occ = 0;                        // 1 = 有窗口占着屏幕（压暗底噪，别糊在内容上）
    this.shapeId = 0;
    this.shapeSeed = Math.random();
    this.shapeT = 0;                     // 距上次重组的毫秒数
    this.shapeAt = -99;                  // 上次重组时刻（flourish 用）
    this.waveF = 2.6;                    // wave 的频率/振幅（重组时按 seed 变）
    this.waveA = 0.10;

    /* --- 视角（拖动旋转）---
     * 形态是 3D 的，之前只有自动自转，用户没法自己看背面。这里给一套
     * 拖拽相机：yaw 绕 Y、pitch 绕 X，松手留角速度做惯性衰减。 */
    this.spin = 0;        // 自动自转累积角（拖动时暂停）
    this.yaw = 0;         // 用户水平旋转
    this.pitch = 0;       // 用户俯仰（+ = 更往下看）
    this.yawV = 0;
    this.pitchV = 0;
    this.dragging = false;

    /* 心跳 */
    this.beat = 0;           // 当前包络 0..1
    this.beatT = 0;          // 距这一跳开始的秒数
    this.beatNext = 1.3;     // 下一次心跳的间隔（1.05~1.9s 随机）
    this.beatAx = 1;         // 这一跳"撕开"的方向（每次随机）
    this.beatAy = 0;

    /* 窗口占位矩形（世界坐标）：有窗口时粒子绕它外缘流，中央不画。
     * step() 每帧算一次，stepShape 用它。 */
    this.auraRect = null;
    this._grid = null;
    this.gridFade = 0;       // 平铺的每个图标外圈那层流的淡入淡出       // 平铺布局缓存（stepShape 和 stepLaunch 共用，别算两遍）

    for (let i = 0; i < n; i++) {
      /* 球面坐标：y 在 [-1,1] 均匀（球面上面积均匀）+ 黄金角方位 */
      const sy0 = 1 - 2 * (i + 0.5) / AMBIENT_N;
      const srr = Math.sqrt(Math.max(0, 1 - sy0 * sy0));
      const sth = GOLDEN * i;
      /* ambient 按纬度分 5 个配色带（与原型一致的横向色带）；rim 走加权随机 */
      const colBand = Math.min(BANDS - 1, Math.floor((1 - sy0) * 0.5 * BANDS));
      const c = i < AMBIENT_N ? PAL[colBand] : pickColor();
      this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
      this.phase[i] = Math.random() * Math.PI * 2;
      this.sd[i * 3] = Math.cos(sth) * srr;
      this.sd[i * 3 + 1] = sy0;
      this.sd[i * 3 + 2] = Math.sin(sth) * srr;
      this.pu[i] = Math.random();
      this.pv[i] = Math.random();
      this.pr1[i] = Math.random();
      this.pr2[i] = Math.random();
      this.tp[i] = i % 5;   // 分区号：环面 5 段 / 星系 5 臂 / wave 5 列
      if (i < AMBIENT_N) {
        this.kind[i] = 0;
        this.size[i] = this.baseS[i] = 1.1 + Math.random() * 2.1;
        this.alpha[i] = this.baseA[i] = 0.20 + Math.random() * 0.34;
        this.pos[i * 3] = (Math.random() - 0.5) * 2400;
        this.pos[i * 3 + 1] = (Math.random() - 0.5) * 1600;
        this.pos[i * 3 + 2] = Math.random() * 2 - 1;
        this.vel[i * 2] = (Math.random() - 0.5) * 16;
        this.vel[i * 2 + 1] = (Math.random() - 0.5) * 16;
      } else if (i < RIM_END) {
        const k = i - AMBIENT_N;
        this.kind[i] = 1;
        this.group[i] = Math.floor(k / RIM_PER_WIN);
        this.u[i] = Math.random();
        const r = Math.random();
        /* 分布照原型 portal.js initParticles：
           流子 68%（法向 ±2~17px、快），晕 28%（22~110px、慢而暗）—— 边框是一层有厚度的尘，
           不是一条线；这也是"把法向厚度撑开成蓬松球"能成立的前提。 */
        const halo = r > 0.72;
        this.halo[i] = halo ? 1 : 0;
        this.off[i] = halo
          ? 22 + Math.pow(Math.random(), 1.5) * 88
          : (Math.random() * 2 - 1) * (2 + Math.pow(Math.random(), 1.8) * 15);
        this.spd[i] = (halo ? 60 + Math.random() * 110 : 150 + Math.random() * 210)
          * (Math.random() < 0.9 ? 1 : -1);
        this.baseS[i] = halo ? 1.3 + Math.random() * 1.9 : 2.0 + Math.random() * 2.2;
        this.baseA[i] = halo ? 0.18 + Math.random() * 0.26 : 0.55 + Math.random() * 0.42;
        this.size[i] = this.baseS[i];
        this.alpha[i] = 0;
        this.pos[i * 3] = 0; this.pos[i * 3 + 1] = 0; this.pos[i * 3 + 2] = 0;
      }
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aDir', new THREE.BufferAttribute(this.aDir, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aStr', new THREE.BufferAttribute(this.aStr, 1).setUsage(THREE.DynamicDrawUsage));

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: 1 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        attribute vec2 aDir; attribute float aStr;
        varying vec3 vColor; varying float vAlpha; varying vec2 vDir; varying float vStr;
        uniform float uDpr;
        void main(){
          vColor = aColor; vAlpha = aAlpha;
          vDir = aDir; vStr = aStr;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          /* 流线：长轴要更长，点精灵得跟着放大，不然椭圆会被方形精灵裁掉 */
          gl_PointSize = aSize * uDpr * (1.0 + aStr * 1.1);
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha; varying vec2 vDir; varying float vStr;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2;
          if (vStr > 0.01) {
            /* 转到运动方向、把垂直方向压窄 —— 圆点变流线 */
            vec2 p = d * 2.0;
            vec2 perp = vec2(-vDir.y, vDir.x);
            vec2 q = vec2(dot(p, vDir), dot(p, perp) * (1.0 + vStr * 1.5));
            r2 = dot(q, q);
          } else {
            r2 = dot(d, d) * 4.0;
          }
          if (r2 > 1.0) discard;
          float core = pow(1.0 - r2, 1.6);          // 中心实、边缘柔
          /* 颜色预先乘好（源因子 = ONE），alpha 只跟着 core*亮度走，
             真正的累积交给 blend*Alpha = ZERO/ONE —— 这样画布不会在
             有粒子的地方变成"不透明黑"，叠在白底 iframe 上才不会出现黑点 */
          gl_FragColor = vec4(vColor * core * vAlpha, core * vAlpha);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      /* 纯加法发光，但 **alpha 也要跟着累加**。
       *
       * 早先这里写的是 blendSrcAlpha: Zero —— 画布的 alpha 永远是 0，颜色全靠 RGB 累加。
       * 那等于把"能不能看见"寄托在浏览器对「预乘 alpha 且 alpha=0」的宽容处理上：
       * Chrome（D3D11）会直接把 RGB 加到底色上，所以看着正常；
       * macOS 上的 ANGLE/Metal 走的是规范路径 —— alpha=0 就是完全透明，整张画布消失。
       * 现在让 alpha 和 RGB 一起累加，任何后端都能正确合成（越亮越实）。 */
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;

    /* ---- 应用栏图标：单独一层，普通透明混合 ---- */
    this.railGeo = new THREE.BufferGeometry();
    this.railGeo.setAttribute('position', new THREE.BufferAttribute(this.rPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.railGeo.setAttribute('aColor', new THREE.BufferAttribute(this.rCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.railGeo.setAttribute('aSize', new THREE.BufferAttribute(this.rSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.railGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.rAlpha, 1).setUsage(THREE.DynamicDrawUsage));

    this.railMat = new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: 1 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        varying vec3 vColor; varying float vAlpha;
        uniform float uDpr;
        void main(){
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uDpr;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main(){
          /* 圆角方块的点：密铺时彼此咬合、不留"菱形黑缝"，
             远看是那个官方图标，近看仍是一颗颗点 */
          vec2 d = abs(gl_PointCoord - 0.5) * 2.0;
          float m = mix(max(d.x, d.y), length(d), 0.42);
          if (m > 1.0) discard;
          float a = smoothstep(1.0, 0.45, m);
          gl_FragColor = vec4(vColor, a * vAlpha);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      /* 普通 alpha 混合：颜色就是官方图标的颜色，不去"叠光" */
      blending: THREE.NormalBlending,
    });

    this.railPoints = new THREE.Points(this.railGeo, this.railMat);
    this.railPoints.frustumCulled = false;
    this.railPoints.renderOrder = 3;   // 盖在背景粒子之上

    /* ---- 设备状态面板：和 rail 共用材质（同一种点、同一种混合）---- */
    this.statGeo = new THREE.BufferGeometry();
    this.statGeo.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.statGeo.setAttribute('aColor', new THREE.BufferAttribute(this.sCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.statGeo.setAttribute('aSize', new THREE.BufferAttribute(this.sSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.statGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.sAlpha, 1).setUsage(THREE.DynamicDrawUsage));

    this.statPoints = new THREE.Points(this.statGeo, this.railMat);
    this.statPoints.frustumCulled = false;
    this.statPoints.renderOrder = 3;

    this.scene = new THREE.Scene();
    this.scene.add(this.points);
    this.scene.add(this.railPoints);
    this.scene.add(this.statPoints);

    /* 有些驱动（macOS 双显卡 / 虚拟机）在显式要"高性能"时反而拿不到上下文，
       直接退回默认配置再试一次 —— 页面完全起不来比掉几帧严重得多。 */
    const opts = { canvas, antialias: false, alpha: true };
    try {
      this.renderer = new THREE.WebGLRenderer({ ...opts, powerPreference: 'high-performance' });
    } catch (e) {
      console.warn('[field] high-performance 上下文创建失败，退回默认', e);
      this.renderer = new THREE.WebGLRenderer(opts);
    }
    this.renderer.setClearColor(0x000000, 0);

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
    this.cam.position.z = 10;
    this.resize();
    this.computeShape();   // 先算一次，否则 ta 全 0，第一帧粒子会全飞向原点
    this.bindDrag();
  }

  /**
   * 拖动旋转视角（像 3D 环境里抓住物体转）。
   *
   * 画布是 `pointer-events: none`（它盖在窗口上面），所以事件挂在 window 上，
   * 并且排除应用栏 / HUD / 窗口这几种目标；iframe 内部的事件本来就不会冒泡到
   * 父文档，所以在窗口内容上拖动不会误触。
   * 按下时 setPointerCapture，指针划过 iframe 也仍然由本文档收事件。
   */
  bindDrag() {
    let id = null, lx = 0, ly = 0, lt = 0;
    /* 应用列表的图标**不**排除：在图标上拖也要能转圆环 / 甩动。
       点击（位移很小）另外按投影位置判定，见 up()。 */
    const UI = '#boot, .win, .win-glow, .rail-zone, .stat-zone';

    const down = (e) => {
      /* uiLock：场被 agent 接管期间，桌面不许抢指针。
         不只是"转了球不好看" —— agent 拖仪表的那一下会被这里当成拖动，
         球跟着转、仪表跟着动，两个东西同时在响应同一只手。 */
      if (this.uiLock) return;
      if (id !== null || e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest(UI)) return;
      id = e.pointerId;
      this.dragging = true;
      lx = e.clientX; ly = e.clientY; lt = performance.now();
      this.yawV = this.pitchV = 0;
      this.flickDir = 0;
      this.flickDist = 0;
      this.flickMoveAt = 0;
      this.flickUsed = false;
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.moved = 0;
      try { document.body.setPointerCapture(id); } catch { /* 某些环境下不支持 */ }
    };

    const move = (e) => {
      if (e.pointerId !== id) return;
      const now = performance.now();
      const dt = Math.max(8, now - lt) / 1000;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY; lt = now;
      if (!dx && !dy) return;

      /* 甩动识别：位移一进来就判，**不等松手** —— 按住来回甩两下才是这个手势的自然做法 */
      this.detectFlick(dx, dy, dt, now);
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.moved > 4) document.body.classList.add('grabbing');

      if (this.launchMode === 1) {
        /* 圆环画廊：横向拖动 = 转动展示环（不是转相机） */
        this.ringAngle += dx * 0.0062;
        this.ringV = clamp(dx * 0.0062 / dt, -3.2, 3.2);
        return;
      }
      if (this.launchMode === 2) {
        /* 平铺：只给一点橡皮筋位移，让"甩"有实物反馈 */
        this.gridX = clamp(this.gridX + dx * 0.42, -120, 120);
        this.gridV = clamp(dx * 0.42 / dt, -900, 900);
        return;
      }

      /* 直接吃位移，拖起来"抓住球在转"；0.0062 rad/px ≈ 1px→0.36° */
      this.yaw += dx * 0.0062;
      this.pitch = clamp(this.pitch + dy * 0.0062, -1.30, 1.30);
      /* 记角速度，松手后顺着方向继续滑一段。
         夹到 ±3.2 rad/s：20px/16ms 的快甩会算出 8 rad/s，松手后自己再转两圈半，
         观感是"球飞出去了"。 */
      const cap = 3.2;
      this.yawV = clamp(dx * 0.0062 / dt, -cap, cap);
      this.pitchV = clamp(dy * 0.0062 / dt, -cap, cap);
    };

    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      this.dragging = false;
      /* 松手时把角速度收一点，否则会一直打转 */
      this.yawV *= 0.55;
      this.pitchV *= 0.55;
      document.body.classList.remove('grabbing');

      /* 点击（按下-抬起几乎没位移）：按投影位置找图标。
         甩动**不在这里判**，见 detectFlick（按住过程中连续判）。 */
      if ((this.moved || 0) < 8) {
        const hit = this.iconAt(e.clientX, e.clientY);
        if (hit >= 0) { this.onIcon?.(hit); return; }
      }
      this.flickDir = 0;
      this.flickDist = 0;
      this.flickUsed = false;
    };

    window.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

  }

  /**
   * 甩动（flick）识别 —— 按住不放就能连续甩，不需要松手。
   *
   * 一次"甩"= 方向明确、够快、够长的一段横向位移。判据：
   *   ① 横向主导（|dx| ≥ |dy|×0.9）：竖着拖是调俯仰，不该算；
   *   ② 瞬时水平速度 > FLICK_V(700px/s) 才起段（慢慢拖不会起段）；
   *   ③ 这一段累计同向位移 ≥ 88px，且从起段到现在 < 460ms
   *      （"慢慢拖过去再猛地一甩"不算：位移早被算进慢速阶段了）。
   *
   * 一次长拖只记一次：记完把 flickUsed 立起来，必须**反向**、速度掉到 240px/s 以下、
   * 或者手停过一会儿（>220ms 没有 move 事件）才能开新的一段
   * —— 否则匀速拖 400px 会被算成两次甩。
   */
  detectFlick(dx, dy, dt, now) {
    if (!dx) return;
    if (Math.abs(dx) < Math.abs(dy) * 0.9) return;
    const vx = dx / dt;                        // px/s，带符号
    const dir = Math.sign(vx);
    if (!dir) return;
    const speed = Math.abs(vx);

    /* 停手时指针不动、根本不产生 move 事件，只能靠"上一次移动有多久以前"判断。
       注意这里不能用"上一次记甩动的时刻"：那样手一直在动也会被判成停手。 */
    const idle = now - (this.flickMoveAt || 0) > 220;
    this.flickMoveAt = now;

    if (idle || (this.flickDir && dir !== this.flickDir) || speed < 240) {
      this.flickDir = 0;
      this.flickDist = 0;
      this.flickUsed = false;
    }
    if (this.flickUsed || speed < FLICK_V) return;

    if (!this.flickDir) {
      this.flickDir = dir;
      this.flickDist = 0;
      this.flickT0 = now;
    }
    this.flickDist += Math.abs(dx);
    if (this.flickDist < 88) return;

    if (now - this.flickT0 < 460) {
      this.flickUsed = true;
      this.flickDist = 0;
      this.onFlick?.(vx);
    } else {
      /* 攒得太久：是慢拖，不是甩，重新起段 */
      this.flickDir = 0;
      this.flickDist = 0;
    }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.renderer.setPixelRatio(dpr);
    /* 第三个参数必须是 true：canvas 是替换元素，`inset:0` 在 width 为 auto 时
       **不会**把它拉伸到视口大小，而是用属性里的缓冲区尺寸当 CSS 尺寸。
       dpr=2 时缓冲区 2880×1800 就成了 CSS 2880×1800 —— 画面整体跑到右下角去
       （正交相机中心在缓冲区中心）。所以 CSS 尺寸要显式写死。 */
    this.renderer.setSize(this.W, this.H, true);
    this.mat.uniforms.uDpr.value = dpr;
    this.railMat.uniforms.uDpr.value = dpr;
    this.cam.left = -this.W / 2;
    this.cam.right = this.W / 2;
    this.cam.top = this.H / 2;
    this.cam.bottom = -this.H / 2;
    this.cam.updateProjectionMatrix();
  }

  /* 窗口矩形用 CSS 像素描述（左上角 + 宽高），这里转成世界坐标 */
  setRect(g, rect) {
    const grp = this.groups[g];
    grp.rect = rect
      ? {
          cx: rect.x + rect.w / 2 - this.W / 2,
          cy: this.H / 2 - (rect.y + rect.h / 2),
          hw: rect.w / 2,
          hh: rect.h / 2,
          r: Math.min(18, rect.w * 0.06, rect.h * 0.06),
        }
      : null;
  }

  /**
   * 开窗：把时间轴归零，并给每颗点定一个**团里的出发点**。
   *
   * 出发点集中在一锥（而不是撒满整个团）：760 颗点从一片里被抽出来，
   * 才看得出是"一条流"；撒满整团只会看到"整体缩小"。
   *
   * @param {{x:number,y:number}} [at] 被点的图标中心（CSS px）。给了就让流从那一侧流进来
   *   —— 点完图标它正往回散，同一段时间里窗口从那一侧游到中心，因果就接上了。
   */
  open(g, rect, at) {
    this.setRect(g, rect);
    const grp = this.groups[g];
    grp.active = true;
    grp.closing = false;
    grp.t = 0;
    grp.closeT = 0;
    grp.pe = PE_MIN;

    const Rc = Math.min(this.W, this.H) * 0.33;
    const R = grp.rect;
    /* 锥的方向：团心 → 被点的图标；没有位置信息时退到"团心 → 窗口中心"，
       窗口基本就在屏幕中央、方向退化，再退到随机方向。整组共用同一个方向，
       流才是拧在一起的一束，而不是四面八方向里灌。 */
    let a0;
    if (at) a0 = Math.atan2(this.H / 2 - at.y, at.x - this.W / 2);
    else if (R && Math.hypot(R.cx, R.cy) >= 40) a0 = Math.atan2(R.cy, R.cx);
    else a0 = this.time * 0.7 + Math.random() * 6.2832;

    for (let i = AMBIENT_N; i < RIM_END; i++) {
      if (this.group[i] !== g) continue;
      const k = i - AMBIENT_N - g * RIM_PER_WIN;
      const a = a0 + (Math.random() - 0.5) * 0.20;
      let sx, sy;
      const AR = this.auraRect;
      if (AR && this.occ > 0.35) {
        /* 已经有一个窗口开着：粒子全在它的外缘流，所以这一束要从**那一圈里**抽。
           否则会从空掉的中央凭空冒出来（中央现在一块粒子都没有）。 */
        const dxa = Math.cos(a), dya = Math.sin(a);
        const edge = Math.min(
          Math.abs(dxa) > 1e-3 ? (AR.hw + 46) / Math.abs(dxa) : 1e9,
          Math.abs(dya) > 1e-3 ? (AR.hh + 46) / Math.abs(dya) : 1e9,
        ) * (0.92 + Math.random() * 0.16);
        sx = AR.cx + dxa * edge;
        sy = AR.cy + dya * edge;
      } else {
        const r = Rc * (0.80 + Math.random() * 0.28);
        sx = Math.cos(a) * r;
        sy = Math.sin(a) * r;
      }
      grp.src[k * 2] = sx;
      grp.src[k * 2 + 1] = sy;
      /* 位置也搬到出发点：否则第一帧会从上一处（关窗散掉的落点）跳过来 */
      this.pos[i * 3] = sx;
      this.pos[i * 3 + 1] = sy;
      this.pos[i * 3 + 2] = 0;
      this.vel[i * 2] = 0;
      this.vel[i * 2 + 1] = 0;
      this.alpha[i] = 0;
      this.size[i] = this.baseS[i];
    }
  }

  /**
   * 关窗：只做三件事 —— 记下每颗点**现在**在哪、往哪散、最后落到哪。
   * 剩下的交给 stepRimClose 沿四段流算位置。
   */
  close(g) {
    const grp = this.groups[g];
    if (!grp.active || grp.closing) return;
    grp.closing = true;
    grp.closeT = 0;
    const R = grp.rect;
    const Rc = Math.min(this.W, this.H) * 0.33;

    /* 6 条小流的汇合点：沿周长每 1/6 段一个，落在"框 → 团心"的 58% 处。
       贴着框放的话小流只有几十 px，看不出是流；放到团心又等于直接汇合了。
       58% 让每段有 150~250px 的行程，6 条流看得清、又确实在往中心收。 */
    const NC = 6;
    grp.hubs.length = 0;
    for (let n = 0; n < NC; n++) {
      if (!R) { grp.hubs.push({ x: 0, y: 0 }); continue; }
      shapeAt((n + 0.5) / NC, R.hw, R.hh, R.r, SH);
      grp.hubs.push({
        x: (R.cx + SH.x) * 0.58,
        y: (R.cy + SH.y) * 0.58,
      });
    }

    for (let i = AMBIENT_N; i < RIM_END; i++) {
      if (this.group[i] !== g) continue;
      const k = i - AMBIENT_N - g * RIM_PER_WIN;
      const px = this.pos[i * 3], py = this.pos[i * 3 + 1];
      grp.p0[k * 2] = px;
      grp.p0[k * 2 + 1] = py;

      /* 散开：以窗口中心为轴，向外 + 一点切向，18~64px。
         要"就近散"——散到框外一小圈，就近的粒子才凑得成小流；飞太远就成烟花了。 */
      let dx = px - (R ? R.cx : 0), dy = py - (R ? R.cy : 0);
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      const ang = (Math.random() - 0.5) * 0.8;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const sp = 18 + Math.random() * 46;
      grp.sc[k * 2] = (dx * ca - dy * sa) * sp;
      grp.sc[k * 2 + 1] = (dx * sa + dy * ca) * sp;

      /* 被团吸收的落点：团内半径 0.15~0.6Rc 的一点 */
      const a2 = Math.random() * 6.2832;
      const r2 = Rc * (0.15 + Math.random() * 0.45);
      grp.dst[k * 2] = Math.cos(a2) * r2;
      grp.dst[k * 2 + 1] = Math.sin(a2) * r2;

      /* 就近：按周长参数 u 分 6 段，同一段的粒子进同一条小流 */
      grp.hubOf[k] = Math.min(NC - 1, Math.floor(this.u[i] * NC));
    }
  }

  /* ===================== 左边缘应用栏（rail） ===================== */

  /**
   * 装载图标点阵 + 屏幕坐标中心。
   * @param {Array<{id:string,title:string,dots:Array<{dx:number,dy:number,cov:number,c:number[]}>}>} items
   * @param {Array<{x:number,y:number}>} centers  CSS 像素（左上角原点）
   */
  setRail(items, centers) {
    const sig = items.map((it) => `${it.id}#${it.rev || 0}`).join('|');
    this.railItems = items;
    if (sig !== this.railSig) {
      this.railSig = sig;
      this.buildRailSlots(items);
    }
    if (this.railIcons.length !== items.length) {
      this.railIcons = items.map(() => ({ cx: 0, cy: 0, h: 0, ht: 0 }));
    }
    this.setRailCenters(centers);
  }

  setRailCenters(centers) {
    for (let i = 0; i < this.railIcons.length; i++) {
      const c = centers[i];
      if (!c) continue;
      const ic = this.railIcons[i];
      ic.cx = c.x - this.W / 2;
      ic.cy = this.H / 2 - c.y;
    }
  }

  /** 图标变了（换账号/换应用/官方图标加载完）才重建槽位 */
  buildRailSlots(items) {
    for (let k = 0; k < RAIL_N; k++) {
      const p = k;
      const ii = Math.floor(k / RAIL_DOTS);
      const j = k - ii * RAIL_DOTS;
      const it = items[ii];
      if (!it) { this.rA[p] = 0; this.rAlpha[p] = 0; continue; }

      this.rIcon[p] = ii;
      this.rPhase[p] = Math.random() * Math.PI * 2;
      this.rW[p] = 0.65 + Math.random() * 1.05;
      this.rVel[p * 2] = 0; this.rVel[p * 2 + 1] = 0;
      /* 起飞时刻错开一点点：整体是一条流，但流头流尾有先后（全同时刻出发就像整片平移） */
      this.rDelay[p] = Math.random() * 0.20 + ii * 0.035;
      // 同一图标共用一套螺旋参数（只留一点抖动）：管壁的亮带才连成一根螺旋线
      this.rSw[p] = 1.45 + (ii % 2) * 0.22;
      this.rPh2[p] = (ii * 1.9) % (Math.PI * 2) + Math.random() * 0.22;

      const d = it.dots[j];
      if (d) {
        this.rRes[p] = 0;
        this.rLx[p] = d.dx;
        /* canvas 的 y 向下、世界坐标 y 向上：不取反图标就是上下颠倒的（电源符号最明显） */
        this.rLy[p] = -d.dy;
        this.rA[p] = d.a != null ? d.a : 0.68 + 0.52 * (d.cov || 0);
        this.rS[p] = d.s != null ? d.s : 2.15 + 0.60 * (d.cov || 0);
        this.rK[p] = 150 + Math.random() * 90;
        this.rCol[p * 3] = d.c[0] / 255;
        this.rCol[p * 3 + 1] = d.c[1] / 255;
        this.rCol[p * 3 + 2] = d.c[2] / 255;
      } else {
        /* 悬停增援：沿黄金角绕图标一圈，平时停在外圈且不可见 */
        this.rRes[p] = 1;
        const ang = j * 2.39996;
        const rad = 74 + (((j * 0.618) % 1)) * 30;   // 落在图标方框之外（半对角 ~54）
        this.rLx[p] = Math.cos(ang) * rad;
        this.rLy[p] = Math.sin(ang) * rad * 0.88;
        this.rA[p] = 0.45 + Math.random() * 0.45;
        this.rS[p] = 1.9 + Math.random() * 0.9;
        this.rK[p] = 90 + Math.random() * 80;
        /* 增援点是"光尘"：取图标平均色的亮版（同色系），
           直接搬图标的暗色在深底上根本看不见 */
        let r = 0, g = 0, b = 0;
        for (const q of it.dots) { r += q.c[0]; g += q.c[1]; b += q.c[2]; }
        const n = it.dots.length || 1;
        this.rCol[p * 3] = Math.min(255, (r / n) * 0.62 + 120) / 255;
        this.rCol[p * 3 + 1] = Math.min(255, (g / n) * 0.62 + 120) / 255;
        this.rCol[p * 3 + 2] = Math.min(255, (b / n) * 0.62 + 130) / 255;
      }
      this.rSize[p] = this.rS[p];
      this.rAlpha[p] = 0;
    }
    this.railGeo.attributes.aColor.needsUpdate = true;
  }

  setRailHover(i, v) {
    const ic = this.railIcons[i];
    if (ic) ic.ht = v ? 1 : 0;
  }

  setRailActive(i) {
    this.railActive = i;
  }

  /**
   * 聚拢：从**整个界面唯一那团粒子**里抽出一条流，螺旋着飞到屏幕左边，收紧成图标。
   *
   * 每颗粒子的出发点定在团内部朝图标的一小片区域（不是图标附近），
   * 飞行路径见 streamXY。所以看到的是"团被抽出一束、拧着飞到左边"，
   * 而不是"图标周围凭空冒出粒子"。
   */
  openRail(at) {
    this.railGoal = 1;
    this.railDirty = true;
    const R = Math.min(this.W, this.H) * 0.33;

    for (let k = 0; k < RAIL_N; k++) {
      const p = k;
      if (!this.rA[p]) continue;
      const ic = this.railIcons[this.rIcon[p]];
      if (!ic) continue;

      /* 出发点：朝图标方向、贴着球面（0.62~0.95 R）的一小片 —— 一束，不是一个点。
         从球心出发的话，前半秒看到的是"球里面被染成彩色"，很脏。 */
      const base = Math.atan2(ic.cy, ic.cx || -1);
      const a = base + (Math.random() - 0.5) * 0.32;
      const r = R * (0.42 + Math.random() * 0.24);
      this.rSrc[p * 2] = Math.cos(a) * r;
      this.rSrc[p * 2 + 1] = Math.sin(a) * r;

      /* 只在"刚开始打开"时把位置挪进团里；
         半路重开（流还在收）就让它就地继续，否则会闪一下 */
      if (this.railOn < 0.02) {
        this.rPos[p * 3] = this.rSrc[p * 2];
        this.rPos[p * 3 + 1] = this.rSrc[p * 2 + 1];
        this.rPos[p * 3 + 2] = 0;
      }
      this.rVel[p * 2] = 0;
      this.rVel[p * 2 + 1] = 0;
      this.rAlpha[p] = 0;
      this.rSize[p] = this.rS[p];
    }
  }

  /**
   * 收回：沿原路**逆流**回团里。
   * 不做"炸开"了 —— 用户要的是"交互物消失后以粒子流的形式回到这一团"，
   * 炸开是散的，逆流是收的。
   */
  closeRail(burstIdx = -1) {
    this.railGoal = 0;
    this.railDirty = true;
    this.railActive = -1;
    /* 被点的那个图标给一点额外的亮度冲击，作为"点到了"的反馈 */
    if (burstIdx >= 0) {
      for (let k = 0; k < RAIL_N; k++) {
        if (this.rIcon[k] === burstIdx && this.rA[k]) this.rS[k] *= 1.12;
      }
    }
  }

  /** 每帧：位置由「流」的进度决定（不是弹簧）—— 速度才可控、才看得清 */
  stepRail(dt) {
    const t = this.time;
    const d0 = this.railGoal - this.railOn;
    if (d0) {
      /* 2.1s 飞完：用户明确要求"不能太快，要能看清这个特效" */
      const sp = 1 / 2.1;
      this.railOn += Math.sign(d0) * Math.min(Math.abs(d0), dt * sp);
    }

    for (const ic of this.railIcons) {
      ic.h += (ic.ht - ic.h) * Math.min(1, dt * 9);
    }

    const on = this.railOn;
    if (on <= 0.001 && this.railGoal <= 0) {
      if (this.railDirty) {
        for (let k = 0; k < RAIL_N; k++) this.rAlpha[k] = 0;
        this.railGeo.attributes.aAlpha.needsUpdate = true;
        this.railDirty = false;
      }
      return;
    }

    for (let k = 0; k < RAIL_N; k++) {
      const p = k;
      if (!this.rA[p]) continue;
      const ii = this.rIcon[p];
      const ic = this.railIcons[ii];
      if (!ic) { this.rAlpha[p] = 0; continue; }

      const h = ic.h;
      const res = this.rRes[p];
      const ph = this.rPhase[p];
      const sc = 1 + 0.12 * h;
      /* 增援点：没悬停时停在外圈（2.35 倍），一悬停就被吸到环上，并慢慢绕轴转 */
      const rk = res ? 1 + (1 - h) * 1.35 : 1;
      let lx = this.rLx[p], ly = this.rLy[p];
      if (res) {
        const sp = t * 0.4 + ph * 0.3;
        const ca = Math.cos(sp), sa = Math.sin(sp);
        const x0 = lx, y0 = ly;
        lx = x0 * ca - y0 * sa;
        ly = x0 * sa + y0 * ca;
      }

      /* 亚像素的"呼吸"：位移必须**远小于**格距（76px/32 格 ≈ 2.4px/格）。
         早先给到 ±1.6px（≈0.7 格），每颗点的相位各不同 → 点阵被搅成噪点，
         远看那几张图标就像"歪的/糊的"。0.3px 只是让它看起来活着，不动结构。 */
      const tx = ic.cx + lx * sc * rk
        + Math.cos(t * this.rW[p] + ph) * 0.18
        + Math.sin(t * 0.37 + ph * 1.7) * 0.14;
      const ty = ic.cy + ly * sc * rk
        + Math.sin(t * this.rW[p] * 1.13 + ph) * 0.18
        + Math.cos(t * 0.33 + ph * 1.3) * 0.14;

      /* 流：u 从 0（在团里）走到 1（到位）。每颗点起飞时刻不同 → 看得出是一束在流，
         而不是整片同时平移。u=1 之后才用"图标上的目标 + 微环"，所以到位后仍不是钉死的。 */
      const u = clamp((on - this.rDelay[p]) / (1 - RAIL_DELAY), 0, 1);
      /* 飞行中：管壁朝向观众的那一侧更亮更大 —— 平面点阵靠这个才读得出"管子是立体的" */
      let tubeLit = 0;
      if (u < 1) {
        streamXY(this.rSrc[p * 2], this.rSrc[p * 2 + 1], tx, ty, u, this.rPh2[p], this.rSw[p]);
        this.rPos[p * 3] = STREAM.x;
        this.rPos[p * 3 + 1] = STREAM.y;
        tubeLit = 0.5 + 0.5 * Math.cos(this.rSw[p] * Math.PI * 2 * u + this.rPh2[p]);
        /* 出团和入位都收一下：起点/终点在轴上，不该有突兀的一坨 */
        tubeLit *= Math.sin(Math.PI * Math.min(1, u * 1.15));
      } else {
        this.rPos[p * 3] = tx;
        this.rPos[p * 3 + 1] = ty;
      }
      this.rPos[p * 3 + 2] = 0;

      const act = ii === this.railActive ? 1.12 + 0.06 * Math.sin(t * 1.7) : 1;
      /* 图标点不逐粒闪：那是"背景粒子"的读法，色块一闪就斑驳了。
         进出都是"流"，所以亮度按 u 淡入淡出，而不是跟着全局进度一刀切。 */
      this.rAlpha[p] = this.rA[p] * smooth(0, 0.10, u) * (res ? h : 1) * act
        * (u < 1 ? 0.45 + 0.75 * tubeLit : 1);
      this.rSize[p] = this.rS[p] * (1 + 0.16 * h + (ii === this.railActive ? 0.06 : 0))
        * (u < 1 ? 0.72 + 0.55 * tubeLit : 1);
    }

    this.railGeo.attributes.position.needsUpdate = true;
    this.railGeo.attributes.aSize.needsUpdate = true;
    this.railGeo.attributes.aAlpha.needsUpdate = true;
  }

  /* ===================== 右下角设备状态 ===================== */

  /**
   * 装载面板点阵。`dots` 由 status.js 生成，坐标以面板中心为原点、y 向下。
   *
   * 每次采样（1s）都会重调一次：读数变了 → 刻度权重变、走势线的 y 变。
   * 点阵的**结构**（位置/角色）只在点数或尺寸变化时重建；否则只刷新目标，
   * 这样流已经到位之后再改数据，看到的是"面板在自己更新"，不会重新流一遍。
   */
  setStat(dots, panel) {
    if (!dots || !dots.length) return;
    this.statDots = dots;
    if (panel) this.statPanel = panel;

    const cnt = Math.min(dots.length, STAT_MAX);
    const sig = `${dots.length}|${panel ? panel.hw + 'x' + panel.hh : 0}`;
    if (sig !== this.statSig) {
      this.statSig = sig;
      this.sN = cnt;
      for (let k = 0; k < cnt; k++) {
        const d = dots[k];
        this.sFlow[k] = d.k ? 1 : 0;
        this.sU[k] = d.u0 || 0;
        this.sOff[k] = d.off || 0;
        this.sSpd[k] = d.spd || 52;
        this.sPq[k] = d.role === 1 ? d.p : -1;
        this.sA[k] = d.a != null ? d.a : 0.95;
        this.sS[k] = d.s || 2.1;
        this.sPh[k] = Math.random() * Math.PI * 2;
        /* 起飞错开一点：整块面板是一条流，但流头流尾有先后 */
        this.sDelay[k] = Math.random() * 0.22;
        this.sSw[k] = 1.35 + (k % 3) * 0.14;
        this.sPh2[k] = (k * 0.37) % (Math.PI * 2);
        this.sPos[k * 3 + 2] = 0;
      }
      /* 多出来的槽位彻底静音（点数变少时靠这个收尾） */
      for (let k = cnt; k < STAT_MAX; k++) { this.sA[k] = 0; this.sAlpha[k] = 0; }
    }

    for (let k = 0; k < cnt; k++) {
      const d = dots[k];
      this.sLx[k] = d.x;
      this.sLy[k] = -d.y;          // CSS y 向下 → 世界 y 向上
      this.sW[k] = d.w == null ? 1 : d.w;
      if (d.c) {
        this.sCol[k * 3] = d.c[0] / 255;
        this.sCol[k * 3 + 1] = d.c[1] / 255;
        this.sCol[k * 3 + 2] = d.c[2] / 255;
      }
    }
    this.statGeo.attributes.aColor.needsUpdate = true;
  }

  /** 聚拢：从团里朝右下角抽一条流，螺旋着流到面板上拼成仪表盘 */
  openStat() {
    this.statGoal = 1;
    this.statDirty = true;
    const R = Math.min(this.W, this.H) * 0.33;
    const P = this.statPanel;
    const tx = P ? P.cx - this.W / 2 : 0;
    const ty = P ? this.H / 2 - P.cy : 0;
    /* 方向：团心 → 面板中心（右下）。整组共用同一个方向、只抖 ±0.3rad，
       所以是一条拧在一起的束，不是四面八方向里灌 */
    const base = Math.atan2(ty, tx || 1);

    for (let k = 0; k < this.sN; k++) {
      if (!this.sA[k]) continue;
      const a = base + (Math.random() - 0.5) * 0.30;
      const r = R * (0.42 + Math.random() * 0.24);
      this.sSrc[k * 2] = Math.cos(a) * r;
      this.sSrc[k * 2 + 1] = Math.sin(a) * r;
      if (this.statOn < 0.02) {
        this.sPos[k * 3] = this.sSrc[k * 2];
        this.sPos[k * 3 + 1] = this.sSrc[k * 2 + 1];
      }
      this.sVel[k * 2] = 0;
      this.sVel[k * 2 + 1] = 0;
      this.sAlpha[k] = 0;
      this.sSize[k] = this.sS[k];
    }
  }

  /** 收回：沿原路逆流回团里（和应用栏同一套读法：收，不是炸） */
  closeStat() {
    this.statGoal = 0;
    this.statDirty = true;
  }

  /** 面板显形进度（给 DOM 的文字用：粒子到位后字才浮出来）。
   *  起点要晚：表名的位置是**最终位置**，面板还在 40% 大小的时候就浮出来，
   *  字会挂在缩小的面板外面。等摊到 ~85% 再让字上来，和窗口的 iframe 析出同一个道理。 */
  statReveal() {
    return smooth(0.84, 0.99, this.statOn);
  }

  stepStat(dt) {
    const d0 = this.statGoal - this.statOn;
    if (d0) {
      /* 和应用栏同速：2.1s 流完，慢到看得清螺旋 */
      const sp = 1 / 2.1;
      this.statOn += Math.sign(d0) * Math.min(Math.abs(d0), dt * sp);
    }
    const on = this.statOn;

    if (on <= 0.001 && this.statGoal <= 0) {
      if (this.statDirty) {
        for (let k = 0; k < this.sN; k++) this.sAlpha[k] = 0;
        this.statGeo.attributes.aAlpha.needsUpdate = true;
        this.statDirty = false;
      }
      return;
    }

    const P = this.statPanel;
    if (!P || !this.sN) return;
    const cx = P.cx - this.W / 2;
    const cy = this.H / 2 - P.cy;
    const hw = P.hw, hh = P.hh;
    const per = shapeAt(0, hw, hh, P.r, SH);   // 顺带把周长算出来
    const t = this.time;
    /* 展开度：0 = 还收在中心那一点，1 = 全部就位。
       （别用 k：循环变量就叫 k，会被遮住 —— 曾经写成 (1-k) 拿到的是下标） */
    const sp = smooth(STAT_OPEN, STAT_DONE, on);

    for (let k = 0; k < this.sN; k++) {
      const i3 = k * 3, i2 = k * 2;
      let tx, ty;

      if (this.sFlow[k]) {
        /* 沿边框环流：u 一直往前推 —— 这就是"面板本身在流" */
        this.sU[k] += (this.sSpd[k] * dt) / Math.max(per, 12);
        if (this.sU[k] > 1) this.sU[k] -= 1;
        shapeAt(this.sU[k], hw, hh, P.r, SH);
        tx = cx + SH.x + SH.nx * this.sOff[k];
        ty = cy + SH.y + SH.ny * this.sOff[k];
      } else {
        tx = cx + this.sLx[k];
        ty = cy + this.sLy[k];
      }

      const u = clamp((on - this.sDelay[k]) / (1 - STAT_DELAY), 0, 1);
      let tubeLit = 0;
      /* 汇合点（面板中心）+ 一点抖动：900 颗点挤在一个点上就是一坨死白，
         散成 14px 的一小团才好读成"聚成了一点还在流动" */
      const jr = 14 * (1 - sp);
      const jx = Math.cos(this.sPh[k]) * jr;
      const jy = Math.sin(this.sPh[k]) * jr;
      let bx, by;
      if (u < 1) {
        streamXY(this.sSrc[i2], this.sSrc[i2 + 1], cx + jx, cy + jy, u,
          this.sPh2[k], this.sSw[k], STREAM, 0.40);
        bx = STREAM.x;
        by = STREAM.y;
        tubeLit = 0.5 + 0.5 * Math.cos(this.sSw[k] * Math.PI * 2 * u + this.sPh2[k]);
        /* 只压**起点**。rail 那边是 sin(πu) 两头收（它到位就换目标、不影响），
           这里 u=0.87 之后会被压到 0 —— 正好是"快摊成面板"的那一段，
           结果面板成型时整块是灰的。 */
        tubeLit *= clamp(u * 7, 0, 1);
      } else {
        bx = cx + jx;
        by = cy + jy;
      }
      /* 从汇合点整体摊到自己的位置 */
      this.sPos[i3] = bx + (tx - bx) * sp;
      this.sPos[i3 + 1] = by + (ty - by) * sp;
      this.sPos[i3 + 2] = 0;

      /* 表盘上跑一粒"亮珠"：沿弧长绕，静止画面也看得出这块在动 */
      let pk = 0;
      const pq = this.sPq[k];
      if (pq >= 0) {
        const pu = (t * 0.22) % 1;
        let du = Math.abs(pq - pu);
        if (du > 0.5) du = 1 - du;
        if (du < 0.07) pk = Math.exp(-((du / 0.028) ** 2));
      }

      const w = this.sW[k];
      this.sAlpha[k] = this.sA[k] * w * smooth(0, 0.10, u)
        * (u < 1 ? 0.62 + 0.72 * tubeLit : 0.70 + 0.30 * sp) * (1 + 1.1 * pk);
      this.sSize[k] = this.sS[k]
        * (u < 1 ? 0.75 + 0.5 * tubeLit : 1 + 0.45 * pk);
    }

    this.statGeo.attributes.position.needsUpdate = true;
    this.statGeo.attributes.aSize.needsUpdate = true;
    this.statGeo.attributes.aAlpha.needsUpdate = true;
  }

  /* ===================== 应用列表（launchpad） ===================== */

  /**
   * 装载应用图标点阵。`dots` 的坐标以图标方框为基准（box），
   * 这里原样搬进几何体，尺寸留给 object.scale 去调。
   */
  setLaunch(items) {
    this.launchItems = items || [];
    const n = Math.min(this.launchItems.length, LP_MAX);
    this.launchCount = n;
    if (this.lpScreen.length !== n) this.lpScreen = this.launchItems.slice(0, n).map(() => null);

    for (let k = 0; k < LP_MAX; k++) {
      const it = this.launchItems[k];
      if (!it) {
        const cur = this.launch[k];
        if (cur) cur.obj.visible = false;
        continue;
      }
      const sig = `${it.id || k}#${it.rev || 0}#${(it.dots || []).length}`;
      this.launch[k] = this.buildLaunchIcon(it, sig, this.launch[k]);
    }
  }

  buildLaunchIcon(it, sig, old) {
    /* 点阵没变就复用：几何 + 当前动画状态都留着，重建会让图标"跳"一下 */
    if (old && old.sig === sig) return old;
    if (old) {
      this.scene.remove(old.obj);
      old.geo.dispose();
      old.mat.dispose();
    }

    const dots = it.dots || [];
    const m = dots.length;
    const pos = new Float32Array(m * 3);
    const col = new Float32Array(m * 3);
    const sz = new Float32Array(m);
    const al = new Float32Array(m);
    /* 散开方向：飞行中这些点要"化成一团雾"，到位才收紧成图标。
       没有这层，图标飞行时是一个清晰的方块在平移 —— 那就不是粒子流了。 */
    const aAng = new Float32Array(m);
    const aJit = new Float32Array(m);
    const box = it.box || 132;
    for (let j = 0; j < m; j++) {
      aAng[j] = Math.random() * Math.PI * 2;
      aJit[j] = 0.35 + Math.random() * 0.65;
      const d = dots[j];
      pos[j * 3] = d.dx;
      pos[j * 3 + 1] = -d.dy;        // canvas y 向下、世界 y 向上（不翻图标就是倒的）
      pos[j * 3 + 2] = 0;
      const c = d.c || [150, 210, 255];
      col[j * 3] = c[0] / 255;
      col[j * 3 + 1] = c[1] / 255;
      col[j * 3 + 2] = c[2] / 255;
      sz[j] = (d.s != null ? d.s : box / 40) * 1.24;   // 咬合：圆点四角不留洞
      al[j] = d.a != null ? d.a : 1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(al, 1));
    geo.setAttribute('aAng', new THREE.BufferAttribute(aAng, 1));
    geo.setAttribute('aJit', new THREE.BufferAttribute(aJit, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: 1 }, uAlpha: { value: 0 }, uScatter: { value: 0 }, uTwist: { value: 0 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        attribute float aAng; attribute float aJit;
        varying vec3 vColor; varying float vAlpha;
        uniform float uDpr; uniform float uAlpha; uniform float uScatter; uniform float uTwist;
        void main(){
          vColor = aColor; vAlpha = aAlpha * uAlpha;
          vec3 p = position;
          /* 拧成涡旋：越靠外的点转得越多，飞行中整个图标是"拧着"的（缠绕感） */
          float tw = aJit * uTwist;
          p.xy = mat2(cos(tw), -sin(tw), sin(tw), cos(tw)) * p.xy;
          /* 再散成雾：每颗点沿自己的方向飘出去，到位时 uScatter→0 收紧成图标 */
          p.xy += vec2(cos(aAng), sin(aAng)) * aJit * uScatter;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uDpr;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main(){
          vec2 d = abs(gl_PointCoord - 0.5) * 2.0;
          float m = mix(max(d.x, d.y), length(d), 0.42);
          if (m > 1.0) discard;
          float a = smoothstep(1.0, 0.45, m);
          gl_FragColor = vec4(vColor, a * vAlpha);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,   // 图标要还原官方配色，不能走加法
    });

    const obj = new THREE.Points(geo, mat);
    obj.frustumCulled = false;
    obj.visible = false;
    obj.renderOrder = 100;
    this.scene.add(obj);

    /* 重建时保留当前位置/缩放，只有全新图标才从 0 开始 */
    /* 每图标一套"流"参数：ph/sw 决定它在螺旋管上的相位和圈数，spin 是飞行中的自转方向 */
    return {
      obj, geo, mat, sig, box,
      cx: old ? old.cx : 0, cy: old ? old.cy : 0,
      ck: old ? old.ck : 0.02, ca: old ? old.ca : 0,
      vx: 0, vy: 0, hov: 0, depth: 0,
      ph: Math.random() * Math.PI * 2,
      sw: 1.3 + Math.random() * 0.7,
      spin: (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 0.7),
    };
  }

  setLaunchMode(m) {
    const prev = this.launchMode;
    if (prev === m) return;
    this.launchMode = m;
    this.launchHover = -1;
    this.ringV = 0;
    this.gridV = 0;
    if (m && !prev) {
      /* 从桌面进入：拉到 0，由 stepLaunch 的"流"把它从团里送出去 */
      this.launchProg = 0;
      for (const ic of this.launch) {
        if (!ic) continue;
        ic.ck = 0.10; ic.ca = 0; ic.vx = 0; ic.vy = 0;
        ic.ph = Math.random() * Math.PI * 2;
        ic.sw = 1.3 + Math.random() * 0.7;
      }
      this.ringAngle = 0;
      this.gridX = 0;
    }
  }

  setLaunchHover(i) {
    this.launchHover = i;
  }

  /**
   * 屏幕上这个点落在哪个图标上（应用列表）。
   * 命中的里取最靠前的（圆环上前后图标会重叠，DOM 命中区没法表达这一层）。
   */
  iconAt(sx, sy) {
    if (!this.launchMode) return -1;
    let best = -1, bestDepth = -2;
    for (let i = 0; i < this.launchCount; i++) {
      const p = this.lpScreen[i];
      const ic = this.launch[i];
      if (!p || !ic || p.a < 0.5) continue;
      const half = (ic.box * p.k) / 2;
      if (Math.abs(sx - p.x) > half || Math.abs(sy - p.y) > half) continue;
      if (ic.depth > bestDepth) { bestDepth = ic.depth; best = i; }
    }
    return best;
  }

  /** 平铺布局：选列数让"空格最少"，并且不超过 6 列（再多就不像启动台了） */
  gridLayout(cnt) {
    const S = 132;
    const stepX = S * 1.04;
    const stepY = S * 1.14;
    const maxCols = Math.max(3, Math.min(6, Math.floor((this.W * 0.84) / stepX)));
    let cols = 1, best = Infinity;
    for (let c = 3; c <= maxCols; c++) {
      const rows = Math.ceil(cnt / c);
      const score = (rows * c - cnt) * 2 + (rows - 1) * 0.35 - c * 0.05;
      if (score < best) { best = score; cols = c; }
    }
    const rows = Math.ceil(cnt / cols);
    const cells = [];
    for (let i = 0; i < cnt; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const inRow = Math.min(cols, cnt - row * cols);
      cells.push({
        x: (col - (inRow - 1) / 2) * stepX,
        y: -(row - (rows - 1) / 2) * stepY + 26,
      });
    }
    /* 图标要留出外面那圈粒子流的位置：k 比以前小一点（圆圈半径 ≈ 0.8 个图标宽，
       还得分给邻居），否则相邻两圈会糊成一片 */
    return { cells, k: cnt > 8 ? 0.62 : 0.68 };
  }

  /**
   * 一个图标的"流"进度（0 = 在团里 / 1 = 到位）。第 i 个图标晚一点出发。
   *
   * 关键：**最后一个图标也必须在 launchProg=1 时正好到 1**。
   * 早先写成 `prog*1.16 - i*0.055`，第 3 个之后的 p 永远到不了 1：
   *   · uTwist 残留 → 每颗点被拧了不同的角度，图标看起来是"斜的"；
   *   · uScatter 残留 → 点阵还散着，糊一圈；
   *   · rotation.z 残留 → 整个图标带几度自转。
   * 现在按图标数把错峰总量归一化到 ≤0.42，跨度乘上去，谁都能走到 1。
   */
  launchPath(i) {
    const cnt = this.launchCount;
    const stag = cnt > 1 ? Math.min(0.055, 0.42 / (cnt - 1)) : 0;
    const span = 1 + stag * (cnt - 1);
    return clamp(this.launchProg * span - i * stag, 0, 1);
  }

  stepLaunch(dt) {
    const cnt = this.launchCount;
    if (!cnt) return;
    const mode = this.launchMode;

    /* 流的进度：进出都是 2.1s（跟应用栏一个速度，整套动画才有同一个"手感"） */
    const want = mode === 0 ? 0 : 1;
    const dp = want - this.launchProg;
    if (dp) this.launchProg = clamp(this.launchProg + Math.sign(dp) * Math.min(Math.abs(dp), dt / 2.1), 0, 1);

    if (mode === 0) {
      /* 已退出：等图标淡完就彻底停手（隐藏），别每帧空转 */
      let live = false;
      for (const ic of this.launch) if (ic && ic.ca > 0.004) live = true;
      if (!live) return;
    }

    if (mode === 1) {
      /* 拖动角速度衰减 + 一点点自转：完全不动就看不出这是个 3D 环 */
      this.ringV *= Math.exp(-2.2 * dt);
      this.ringAngle += (this.ringV + 0.085) * dt;
    } else if (mode === 2) {
      /* 平铺：橡皮筋回中（甩动时能被"拽"一下，松手弹回） */
      this.gridV += -this.gridX * 30 * dt;
      this.gridV *= Math.exp(-7 * dt);
      this.gridX += this.gridV * dt;
    }

    const Rr = Math.min(this.W, this.H) * 0.375;
    const TILT = 0.185;
    const grid = mode === 2 ? (this._grid || this.gridLayout(cnt)) : null;
    const k = mode === 1 ? 120 : mode === 2 ? 170 : 90;
    const c = 2 * Math.sqrt(k) * 0.88;

    for (let i = 0; i < cnt; i++) {
      const ic = this.launch[i];
      if (!ic) continue;

      let tx = 0, ty = 0, tk = 0.12, ta = 0, lab = 0, depth = 0;
      if (mode === 1) {
        const ang = (i / cnt) * LP_TAU + this.ringAngle;
        const sn = Math.sin(ang), cs = Math.cos(ang);
        tx = sn * Rr;
        depth = cs;                       // +1 最前，-1 最后
        ty = -cs * Rr * Math.sin(TILT);
        tk = 0.60 + 0.54 * (cs + 1) / 2;
        ta = 0.34 + 0.66 * smooth(-1, 1, cs);
        lab = smooth(-0.10, 0.80, cs);
      } else if (mode === 2) {
        const cell = grid.cells[i];
        tx = cell.x + this.gridX;
        ty = cell.y;
        tk = grid.k;
        ta = 1;
        lab = 1;
      }

      /* 悬停：略微抬起变大 */
      const hv = i === this.launchHover ? 1 : 0;
      ic.hov += (hv - ic.hov) * Math.min(1, dt * 12);
      tk *= 1 + 0.09 * ic.hov;
      ta = Math.min(1, ta * (1 + 0.3 * ic.hov));

      /* ---- 粒子流：从团里飞出来 ---- */
      if (mode) { ic.tx = tx; ic.ty = ty; }      // 记住最后的目标（退出时要用它当终点）
      else if (ic.tx != null) { tx = ic.tx; ty = ic.ty; }

      const p = this.launchPath(i);
      if (p < 1) {
        /* 沿螺旋管飞：起点在团里朝目标那一侧，路径参数（ph/sw）逐图标固定 */
        const ang = Math.atan2(ty, tx) || (ic.spin > 0 ? 0.7 : -0.7);
        const Rl = Math.min(this.W, this.H) * 0.33;
        /* 起点压到团心附近（0.12~0.38R）并按目标方向散开一点：
           所有图标都是"从这一团里涌出来、再分头飞走"，而不是各自从身边长出来。 */
        const r0 = Rl * (0.12 + (ic.ph / LP_TAU) * 0.26);
        const a0 = ang + ((ic.ph % 0.9) - 0.45);
        const sx = Math.cos(a0) * r0;
        const sy = Math.sin(a0) * r0;
        streamXY(sx, sy, tx, ty, p, ic.ph, ic.sw);
        ic.cx = STREAM.x;
        ic.cy = STREAM.y;
        ic.vx = 0; ic.vy = 0;
        /* 飞行中是一小团雾、慢慢收紧；alpha 跟着 p 走，退出时自然逆流收回去 */
        ic.ck = tk * (0.30 + 0.70 * p);
        ic.ca = ta * smooth(0, 0.34, p);
        ic.obj.rotation.z = ic.spin * (1 - p) * 0.30;   // 只轻轻转一点，转多了图标会斜成菱形
        ic.mat.uniforms.uScatter.value = (1 - p) * (1 - p) * 46;
        ic.mat.uniforms.uTwist.value = (1 - p) * 2.6;
      } else {
        ic.vx = (ic.vx + (tx - ic.cx) * k * dt) / (1 + c * dt);
        ic.vy = (ic.vy + (ty - ic.cy) * k * dt) / (1 + c * dt);
        ic.cx += ic.vx * dt;
        ic.cy += ic.vy * dt;
        ic.ck += (tk - ic.ck) * Math.min(1, dt * 9);
        ic.ca += (ta - ic.ca) * Math.min(1, dt * 8);
        /* 到位后把飞行态的"余数"清干净：指数衰减永远留一点，
           那一点残留就是图上看到的"这张图标有点斜" */
        ic.obj.rotation.z *= Math.exp(-6 * dt);
        if (Math.abs(ic.obj.rotation.z) < 0.004) ic.obj.rotation.z = 0;
        ic.mat.uniforms.uScatter.value *= Math.exp(-7 * dt);
        ic.mat.uniforms.uTwist.value *= Math.exp(-7 * dt);
        if (ic.mat.uniforms.uScatter.value < 0.02) ic.mat.uniforms.uScatter.value = 0;
        if (ic.mat.uniforms.uTwist.value < 0.004) ic.mat.uniforms.uTwist.value = 0;
      }
      ic.depth = depth;

      ic.obj.visible = ic.ca > 0.004;
      ic.obj.position.set(ic.cx, ic.cy, 0);
      ic.obj.scale.setScalar(ic.ck);
      /* 点径不跟着 object.scale 走（gl_PointSize 在着色器里），所以乘进 uDpr */
      ic.mat.uniforms.uDpr.value = this.dpr * ic.ck;
      ic.mat.uniforms.uAlpha.value = ic.ca;
      /* 画家算法：深度大的后画（盖住后面的图标） */
      ic.obj.renderOrder = 100 + Math.round(depth * 90);

      const s = this.lpScreen[i] || (this.lpScreen[i] = {});
      s.x = this.W / 2 + ic.cx;
      s.y = this.H / 2 - ic.cy;
      s.k = ic.ck;
      s.a = ic.ca;
      s.lab = ic.ca * lab;
    }
  }

  /* ------------------- 空闲态：聚成形态并自动重组 -------------------
   * 坐标一律归一化到半径 1，最后乘一个和屏幕相关的 scale，
   * 这样换分辨率/窗口尺寸时形态大小自动跟着变。
   */
  computeShape() {
    const n = AMBIENT_N;
    const T = this.ta, seed = this.shapeSeed;
    const S = SHAPES[this.shapeId];

    if (S === 'sphere') {
      for (let i = 0; i < n; i++) {
        T[i * 3] = this.sd[i * 3];
        T[i * 3 + 1] = this.sd[i * 3 + 1];
        T[i * 3 + 2] = this.sd[i * 3 + 2];
      }
    } else if (S === 'torus') {
      /* 主/次半径随 seed 变；tp 把环按 5 段分色（原型是 5 种硬件类型沿管长分布） */
      const R1 = 0.62 + seed * 0.10;
      const R2 = 0.19 + ((seed * 7.71) % 1) * 0.07;
      for (let i = 0; i < n; i++) {
        const u = (this.tp[i] * 0.2 + this.pu[i] * 0.2) * Math.PI * 2 * 3 + seed * 0.4;
        const v = this.pv[i] * Math.PI * 2 + seed * Math.PI * 2;
        const rr = R1 + R2 * Math.cos(v);
        T[i * 3] = rr * Math.cos(u);
        T[i * 3 + 1] = R2 * Math.sin(v);
        T[i * 3 + 2] = rr * Math.sin(u);
      }
    } else if (S === 'galaxy') {
      /* 五条旋臂；旋向/缠绕度随 seed，盘面厚度向外递减 */
      const dir = seed > 0.5 ? 1 : -1;
      /* 每条臂的缠绕量（单位：半圈）。1.6~2.9 半圈 = 0.8~1.45 圈，
         臂会和邻臂叠在一起，看起来是一圈圈同心环而不是旋臂 —— 收到
         0.55~1.05 半圈，五条臂才分得开。 */
      const spin = 0.55 + ((seed * 3.31) % 1) * 0.5;
      for (let i = 0; i < n; i++) {
        const t01 = this.pu[i];
        const r = 0.10 + t01 * 0.90;
        const ang = this.tp[i] * Math.PI * 2 / 5 + dir * t01 * spin * Math.PI
          + (this.pr1[i] - 0.5) * 0.55;
        T[i * 3] = r * Math.cos(ang);
        T[i * 3 + 1] = (this.pr2[i] - 0.5) * 0.09 * (1.25 - t01);
        T[i * 3 + 2] = r * Math.sin(ang);
      }
    } else {
      /* wave：五列分区网格，y 在 step 里按时间算涟漪 */
      const cols = Math.max(10, Math.ceil(Math.sqrt(n * 1.7)));
      const rows = Math.max(2, Math.ceil(n / cols));
      const cols5 = Math.max(1, Math.floor(cols / 5));
      for (let i = 0; i < n; i++) {
        const col = this.tp[i] * cols5 + Math.floor(this.pu[i] * cols5);
        const row = Math.floor(this.pv[i] * rows);
        T[i * 3] = (col / (cols - 1) - 0.5) * 1.28;
        T[i * 3 + 1] = 0;
        T[i * 3 + 2] = (row / (rows - 1) - 0.5) * 1.28;
      }
      /* 频率要换算：原型 x 跨度 36 世界单位、f=0.30~0.52 → 横跨 1.7 个波长。
         这里跨度是 1.28（归一化），所以 f 要乘 36/1.28 ≈ 28 → 8.4~14.6。
         原来写 2.2，波长 2.85 比整张网格还宽，看到的是"整块倾斜"而不是涟漪。 */
      this.waveF = 8.4 + seed * 4.2;
      this.waveA = 0.075 + ((seed * 5.17) % 1) * 0.05;
    }
  }

  /** 每帧：投影 + 弹簧。正交相机没有透视，深度得手工换成大小/亮度 */
  /* ------------------------------- 绘画 -------------------------------
   * 输入是 draw.js 编译出来的点云（画布坐标）。这里只做三件事：
   *   1. 映射到场的屏幕坐标系（视口中心为原点）
   *   2. 决定每颗点用哪个粒子 —— 打散分配，否则会出现"从左上角开始填"
   *   3. 打开混合量，让弹簧把粒子拉过去（飞的过程本身就是动画，不用额外做过渡）
   *
   * 为什么点云要"编译一次、之后只读"：每帧重采样会让每颗点的落点微微变化，
   * 整幅画会一直处于噪点状态（这个坑在点阵图标上踩过）。
   */
  setDraw(pack, geo = {}) {
    const pts = pack.points || [];
    const n = AMBIENT_N;
    const cnt = Math.min(pts.length, n);
    if (!cnt) { this.clearDraw(); return { used: 0, spacing: pack.spacing || 0 }; }

    if (!this.col0) this.col0 = this.col.slice();

    /* 画布坐标 → 场坐标。场是正交投影、原点在视口中心，所以减一半即可。 */
    const ox = geo.x ?? 0;
    const oy = geo.y ?? 0;
    const cx = this.W * 0.5;
    const cy = this.H * 0.5;

    this.drawUse.fill(0);

    /* 打散分配：点云按"层 + 纵坐标"排序，粒子按球面黄金角分布。
       若 i→i 直配，粒子球上某一侧会整片跑去做画的同一块，导致局部挤、局部空。 */
    const stride = pts.length / cnt;
    for (let k = 0; k < cnt; k++) {
      const p = pts[Math.floor(k * stride)];
      const i = Math.floor((k * n) / cnt);
      const ink = p.ink || 0.6;
      this.drawUse[i] = 1;
      this.drawX[i] = p.x + ox - cx;
      /* canvas 的 y 向下、场（正交投影）的 y 向上 —— 这里必须取反，
         否则整幅画上下颠倒（字会翻过来、柱状图会从顶边往下挂）。 */
      this.drawY[i] = cy - (p.y + oy);
      this.drawA[i] = 0.55 + 0.45 * ink;      // 墨越厚越亮
      /* dot：点径缩放。绘画要"笔触"（默认 1），UI 文字要"点"——
         点径大于字距时笔画会糊成一坨墨，20px 的汉字尤其明显。 */
      this.drawS[i] = (1.9 + 0.8 * ink) * (geo.dot ?? 1);
      this.drawD[i] = k / cnt;
      this.drawCol[i * 3] = p.c[0];
      this.drawCol[i * 3 + 1] = p.c[1];
      this.drawCol[i * 3 + 2] = p.c[2];
    }
    this.drawN = cnt;
    this.drawSeen = true;
    this.drawOn = 1;
    this.drawStart = this.time;
    this.drawOnMs = geo.drawOnMs ?? 0;
    this.drawDim = geo.dim ?? 0.78;   // 未进画/未占位的 ambient 压暗比例（UI 用 0.96+）
    return { used: cnt, spacing: pack.spacing || 0 };
  }

  /** 散回环境形态。给 1.6s 的回落，比聚上去慢 —— 散开太快会像"闪没了"。 */
  clearDraw() {
    this.drawOn = 0;
  }

  /**
   * 相干度。0 = 溶解成噪雾，1 = 精确成形。
   *
   * 不写成"过渡动画"，因为这里根本没有"从 A 到 B 的补间"这回事：
   * 每颗点一直是"朝目标飞 + 弹簧阻尼"，相干度只是决定目标有多可信。
   * 相干度低 → 目标被一股固定的噪声推开 → 结构自己塌掉；
   * 拉回 1 → 目标重新可信 → 结构自己长回来。补间曲线是算出来的，不是画出来的。
   */
  setCoherence(k) {
    this.coh = clamp(k, 0, 1);
  }

  /**
   * 弹簧刚度倍率。默认 1；相变的"重组"阶段抬到 2~3。
   *
   * 为什么要这个：换几何之后，点要走的路程比平时大得多（从一个元素的位置到另一个元素），
   * 用平时的刚度要 1.2s 才稳住，而相干度 0.8s 就回到 1 了 —— 结果是"已经宣布成形，
   * 但字形还在抖"。刚度抬上去，相干度回升和位置落定就同时完成。
   * 阻尼比不变（c 和 k 一起放大），所以不会变成弹来弹去。
   */
  setStiff(k) {
    this.stiff = k;
  }

  /* ───────────── 槽位写入（粒子界面用，见 pui.js） ─────────────
   * 和 setDraw 的区别：setDraw 收一整幅点云、按 stride 打散分配，一次全量；
   * 这里是"往指定的槽位段里写" —— 同一槽位永远对应同一颗粒子，
   * 所以界面上一个字变了，不会带动别的字重排。
   */

  slotBegin(opt = {}) {
    if (!this.col0) this.col0 = this.col.slice();
    /* 先把上一轮占用过的点交还给环境。
     *
     * 只 `drawUse.fill(0)` 是不够的：那只是"这张工牌作废"，而点的 alpha
     * 还停在旧值上。换场之后没有任何人再负责把它们写回去 —— 它们就原地亮着，
     * 亮成了上一屏的化石。实测症状：开着窗口唤出 agent，窗口边缘残留一圈旧点，
     * 看起来像"agent 被关在窗口里"。
     *
     * 交还的方式不是置 0（那会让桌面球面凹掉一块），而是恢复成环境点的
     * 基础亮度与大小 —— 它们重新成为背景的一部分，位置由球面目标拉回去。 */
    for (let i = 0; i < AMBIENT_N; i++) {
      if (this.drawUse[i] !== 1) continue;
      this.alpha[i] = this.baseA[i];
      this.size[i] = this.baseS[i];
    }
    this.drawUse.fill(0);
    this.drawN = 0;
    this.drawSeen = true;
    this.drawOn = 1;
    this.drawStart = this.time;
    this.drawOnMs = 0;                    // 槽位模式不做出场波，谁写谁立刻显形
    this.drawDim = opt.dim ?? 0.96;
    this.drawDot = opt.dot ?? 0.9;
  }

  /**
   * @param {number} base 起始槽位
   * @param {{x:number,y:number,ink:number}[]} pts 屏幕坐标（相对视口左上）
   * @param {number[]} col [r,g,b] 0..1
   */
  slotPut(base, pts, col, scl = 1, spawn = null, dotScale = 1) {
    const n = AMBIENT_N;
    const cx = this.W * 0.5;
    const cy = this.H * 0.5;
    const dot = this.drawDot ?? 0.9;
    const P = this.pos;
    const V = this.vel;
    for (let k = 0; k < pts.length; k++) {
      const slot = base + k;
      if (slot >= n) break;
      /* 槽位 → 粒子：与 6400 互质的乘法，双射且把连续槽位打散到球面各处 */
      const i = (slot * 7919 + 13) % n;
      const p = pts[k];
      const ink = p.ink ?? 0.6;
      this.drawUse[i] = 1;
      this.drawX[i] = p.x - cx;
      this.drawY[i] = cy - p.y;           // canvas 的 y 向下、场的 y 向上
      this.drawA[i] = (0.55 + 0.45 * ink) * scl;
      /* dotScale：给大字用的点径倍数。32px 的汉字点格约 3.2px，而默认点径只有
         2.2 —— 笔画是"一串珠子"，远看发灰。放大到点和格相接（约 1.5 倍）才成线。
         这条只对调用方显式传的生效，场景里的读数/标签保持原样。 */
      this.drawS[i] = (1.9 + 0.8 * ink) * dot * dotScale;
      this.drawD[i] = 0;
      this.drawCol[i * 3] = col[0];
      this.drawCol[i * 3 + 1] = col[1];
      this.drawCol[i * 3 + 2] = col[2];
      /* spawn：给新写进来的点一个"出生位置"（屏幕坐标 + 半径）。
         打字时新字从插入符那里长出来，而不是从球面上随便某处飞过来 ——
         这是这套界面"有笔触感"的关键，DOM 里做不到。 */
      if (spawn) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * (spawn.r ?? 24);
        P[i * 3] = spawn.x - cx + Math.cos(a) * rr;
        P[i * 3 + 1] = cy - spawn.y + Math.sin(a) * rr;
        V[i * 2] = 0;
        V[i * 2 + 1] = 0;
      }
      if (slot + 1 > this.drawN) this.drawN = slot + 1;
    }
  }

  /** 清空一段槽位：点留在原地但亮度归零（下次输入直接复用，不飞回球面） */
  slotBlank(base, len) {
    const n = AMBIENT_N;
    for (let k = 0; k < len; k++) {
      const slot = base + k;
      if (slot >= n) break;
      const i = (slot * 7919 + 13) % n;
      this.drawA[i] = 0;
      this.drawS[i] = 0;
    }
  }

  /* ───────────── 场：引力井与冲量 ─────────────
   * 这两个原语是"粒子交互"和"DOM 交互"的分水岭。
   *
   * DOM 的悬停是**换一个样式**：hover 一进，颜色立刻变，没有过程。
   * 这里是**施一个力**：点被拉过去，弹簧再把它拽回来 —— 有速度、有过冲、
   * 有余韵，而且同一个"井"作用在背景上时，整片场都会跟着弯腰。
   *
   * 所以界面状态不该描述成 "hover: true"，而该描述成
   * "这里有一个 r=170、k=2400 的势阱" —— 状态本身就是几何。
   */

  /**
   * @param {{x:number,y:number,r:number,k:number,swirl?:number}[]} list 屏幕坐标
   */
  setWells(list) {
    const cx = this.W * 0.5;
    const cy = this.H * 0.5;
    this.wells.length = 0;
    for (const w of list || []) {
      this.wells.push({
        x: w.x - cx,
        y: cy - w.y,          // 转成场坐标（y 向上）
        r: w.r || 150,
        r2: (w.r || 150) * (w.r || 150),
        k: w.k || 2400,
        swirl: w.swirl || 0,
      });
    }
  }

  /**
   * 一次性冲量：把半径内的点朝外推一下。点击/确认用它 —— 手一按，场炸开，
   * 然后弹簧把它们收回去，形成"按下去有回响"的手感。
   */
  impulse(x, y, opt = {}) {
    const cx = this.W * 0.5;
    const cy = this.H * 0.5;
    const wx = x - cx;
    const wy = cy - y;
    const r = opt.r || 170;
    const r2 = r * r;
    const pw = opt.power || 520;
    const P = this.pos;
    const V = this.vel;
    for (let i = 0; i < AMBIENT_N; i++) {
      const i3 = i * 3;
      const dx = P[i3] - wx;
      const dy = P[i3 + 1] - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) + 0.001;
      const f = pw * (1 - d / r);
      V[i * 2] += (dx / d) * f;
      V[i * 2 + 1] += (dy / d) * f;
    }
  }

  /* ───────────── 涡（一次性切向力） ─────────────
   *
   * 用途：把"刚刚发生的动作"变成一股看得见的风。用户按下回车时，那句话
   * 不该只是淡出 —— 它应该被**搅散**：点绕着它转、被甩出去，然后再被弹簧
   * 收拾回来。这是这套界面唯一能表达"它把你的话拿走了"的方式，
   * 因为这里没有气泡、没有"正在输入…"这种东西。
   *
   * @param {number} x 屏幕坐标
   * @param {number} y
   * @param {{r?:number,k?:number,swirl?:number,ms?:number,ease?:number}} [opt]
   */
  vortex(x, y, opt = {}) {
    const cx = this.W * 0.5;
    const cy = this.H * 0.5;
    const r = opt.r || 520;
    this.vorts.push({
      x: x - cx,
      y: cy - y,
      r, r2: r * r,
      k: opt.k ?? 1500,
      swirl: opt.swirl ?? 2.6,
      t0: this.time,
      ms: opt.ms ?? 900,
      ease: opt.ease ?? 1.7,          // >1 时前段更猛，收得更快
      env: 1,
    });
    /* 同时打散一下相干度：纯切向力只会让点绕圈，"被搅开"还需要它自己散。
       这一步不走 setCoherence —— 那个由"在想"状态管，会被下一帧覆盖。 */
    if (opt.loose) this.coh = Math.min(this.coh, opt.loose);
  }

  /** 涡是否还在起作用（前端用它决定要不要恢复"在想"的相干度） */
  get vortexing() {
    return this.vorts.length > 0;
  }

  stepShape(dt) {
    const t = this.time;
    const n = AMBIENT_N;
    const T = this.ta, P = this.pos, V = this.vel;

    /* 涡的时间包络。env 乘在**力**上而不是位移上：力退到 0 之后点还带着速度
       继续走一段，再被弹簧拉回来 —— 余韵来自这里，硬切就没有。 */
    /* 全局压暗的趋近：6 是手感值 —— 约 0.3s 退到位，和记录面板的淡入同拍 */
    if (Math.abs(this.uiFade - this.uiFadeTo) > 0.002) {
      this.uiFade += (this.uiFadeTo - this.uiFade) * Math.min(1, dt * 6);
    } else if (this.uiFade !== this.uiFadeTo) {
      this.uiFade = this.uiFadeTo;
    }

    if (this.vorts.length) {
      let w = 0;
      for (let i = 0; i < this.vorts.length; i++) {
        const v = this.vorts[i];
        const u = (t - v.t0) / (v.ms * 0.001);
        if (u >= 1) continue;
        v.env = Math.pow(1 - u, v.ease);
        this.vorts[w++] = v;
      }
      this.vorts.length = w;
    }

    /* 绘画混合量：聚上去 0.9s，散回来 1.6s。
       指数逼近而不是线性 —— 快到目标时自然减速，不会有"啪一下到位"的硬边。 */
    {
      const rate = dt / (this.drawOn > this.drawMix ? 0.9 : 1.6);
      this.drawMix += (this.drawOn - this.drawMix) * Math.min(1, rate * 2.4);
      if (this.drawMix < 0.0015) this.drawMix = 0;
    }
    const drawMix = this.drawMix;
    const drawLive = drawMix > 0.002 && this.drawN > 0;
    /* 作画进度：drawOnMs 内，点云按自己在画上的顺序依次"轮到"。
       轮到的点才把目标换成画布位置，所以看起来是一道波沿着笔迹推过去，
       不是整幅图同时从球里塌下来。 */
    const drawProg = this.drawOnMs > 0
      ? clamp(((t - this.drawStart) * 1000) / this.drawOnMs, 0, 1)
      : 1;
    /* 作画期间按住形态轮换：画到一半背景突然重组成星系，画会被撕开 */
    if (drawLive) this.shapeT = Math.min(this.shapeT, SHAPE_MS * 0.45);

    /* 三种"背景粒子"的用法，同一批点切换：
     *   ring（launchMode 1）—— 绕着 3D 展示环流动的尘埃带，把图标整圈包住
     *   grid（launchMode 2）—— **每个图标外面一圈**粒子流（沿椭圆环绕 + 三道亮波）
     *   shape（桌面）       —— 原来的球/环/星系/波浪形态
     * 有窗口时（占桌面状态）还会整体改道成"绕窗口外缘的日冕"，见下面的 auraW。 */
    const halo = this.launchMode === 1;
    const grid = this.launchMode === 2 ? this._grid : null;
    const S = halo ? 'halo' : SHAPES[this.shapeId];

    /* 重组节奏：9s 一次；切换后 0.9s 内向核心收拢再展开（原型 flourish + 呼吸包络）。
       用户正在拖动/惯性旋转时把计时按住 —— 不然球会在手里突然变成星系盘。
       进应用列表时也不换形态：这时候背景是光环，换了会看到光环被撕开。 */
    this.shapeT += dt * 1000;
    if (this.launchMode === 0 && (this.dragging || Math.abs(this.yawV) + Math.abs(this.pitchV) > 0.22)) {
      this.shapeT = Math.min(this.shapeT, SHAPE_MS * 0.45);
    }
    if (!this.launchMode && this.shapeT >= SHAPE_MS) {
      this.shapeT = 0;
      this.shapeId = (this.shapeId + 1) % SHAPES.length;
      this.shapeSeed = Math.random();
      this.computeShape();
      this.shapeAt = t;
    }
    const flour = Math.max(0, 1 - (t - this.shapeAt) / FLOURISH_S);
    const breath = 0.5 + 0.5 * Math.sin(t * 0.9);
    const R = Math.min(this.W, this.H) * 0.33;
    /* 心跳叠在呼吸上：整体快速放大一点（scale），另一半效果在下面的"撕开"里 */
    const beat = this.launchMode ? 0 : this.beat;
    const scale = R * (1 - 0.62 * flour) * (0.95 + 0.10 * breath) * (1 + 0.075 * beat);

    /* 缓慢自转 + 固定俯角 —— 把 3D 形态压成 2D 投影。
       拖动时自转暂停：否则你抓住球往右拖，它自己还在往左转，手感是"打滑"。
       应用列表里相机归零：环和网格要正对着看，光环的转角由 ringAngle 自己管。 */
    this.spin += (this.dragging || this.launchMode ? 0 : 0.20) * dt;
    const ry = this.launchMode ? 0 : this.spin + this.shapeSeed * 6.28 + this.yaw;
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const tiltBase = halo ? 0.155 : S === 'wave' ? 0.92 : S === 'galaxy' ? 0.62 : 0.36;
    const tilt = this.launchMode ? 0.155 : clamp(tiltBase + this.pitch, -1.35, 1.35);
    const cx = Math.cos(tilt), sx = Math.sin(tilt);

    /* 平铺时的亮度由每个点自己的 em 控制（要画出图标外圈的流），底噪不再是 5% */
    const dim = this.launchMode === 2 ? 1 : this.launchMode === 1 ? 0.58 : 1;

    /* ---- 有窗口：粒子全部改道到窗口外缘（中央一块留给窗口内容） ----
       auraW 由 occ 驱动，所以开窗时粒子是"流着过去"变道的，不是瞬移。
       余量太小时（窗口最大化）bandMax 自动收窄，粒子贴着边缘走，不会压到内容上。 */
    const A = halo || grid ? null : this.auraRect;
    const auraW = A ? smooth(0.10, 0.78, this.occ) : 0;
    let bandMax = AURA_MAX;
    if (A) {
      const room = Math.min(
        this.W / 2 - Math.abs(A.cx) - A.hw,
        this.H / 2 - Math.abs(A.cy) - A.hh,
      );
      bandMax = clamp(room * 0.94, 6, AURA_MAX);
    }
    /* 拖动（或松手后还在惯性转）时把弹簧压紧：
       目标位置每帧都在跳，弹簧软了粒子就追不上——球会被拖成椭圆（实测横向掉 10%）。
       停稳后回落到 46，保留粒子自己那点呼吸。 */
    const moving = this.dragging || Math.abs(this.yawV) + Math.abs(this.pitchV) > 0.22;
    const kB = (moving ? 250 : 46) * this.stiff;
    const k = kB * this.form;
    const c = 2 * Math.sqrt(kB * this.form) * (moving ? 0.98 : 0.9);
    const f = this.form;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3, i2 = i * 2;
      let tx, ty, z2 = 0, em = 1, szm = 1;
      /* 流线：沿"流动方向"把圆点拉长，静止画面也读得出在往哪边流（和窗口门同一套） */
      let dirX = 0, dirY = 0, strK = 0;

      if (halo) {
        /* 绕环的尘埃带：u 沿环转、v 绕管壁拧 → 看着是"一条粒子流裹住图标" */
        const u = this.pu[i] * LP_TAU + t * (0.35 + 1.15 * this.pr1[i]) + this.ringAngle * 1.3;
        const v = this.pv[i] * LP_TAU + t * (0.55 + 1.0 * this.pr1[i]);
        const tube = 0.10 + 0.15 * this.pr2[i];
        const rr = 1.12 + Math.cos(v) * tube * 0.5;
        const x3 = Math.cos(u) * rr;
        const y3 = Math.sin(v) * tube;
        const z3 = Math.sin(u) * rr;
        const x1 = x3 * cy + z3 * sy;
        const z1 = -x3 * sy + z3 * cy;
        const y2 = y3 * cx - z1 * sx;
        z2 = y3 * sx + z1 * cx;
        tx = x1 * scale;
        ty = y2 * scale;
      } else if (grid) {
        /* ---- 平铺：每个图标外面一圈粒子流 ----
           椭圆（0.80 / 0.72 个图标宽）刚好绕过图标的四个角；角速度逐粒不同，
           环就"拧"起来像流而不是一个整体在转。亮波沿周长跑 = 流动的读数。 */
        const cnt = this.launchCount;
        const ic = i % cnt;
        const cell = grid.cells[ic];
        const per = Math.max(1, Math.floor(n / cnt));
        const kk = (i / cnt) | 0;
        const u = (kk + this.pr1[i]) / per;
        const box = 132 * grid.k;
        const ang = u * LP_TAU + t * (0.30 + this.pr2[i] * 0.45) + ic * 1.7;
        const band = 1 + (this.pr2[i] - 0.5) * 0.065
          + 0.030 * Math.sin(u * LP_TAU * 3 + t * 1.3 + ic);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        tx = cell.x + this.gridX + ca * box * 0.80 * band;
        ty = cell.y + sa * box * 0.74 * band;
        /* 三个"彗头"沿周长跑：头部亮、尾巴在后面拖 —— 这才是"流"，
           整圈一样亮就只是个发光圆环。 */
        let tail = 0;
        for (let q = 0; q < 3; q++) {
          let df = u - ((t * 0.075 + q / 3 + ic * 0.11) % 1);
          if (df < 0) df += 1;
          if (df < 0.3) tail = Math.max(tail, Math.exp(-df * 8));
        }
        const tdx = -sa * box * 0.80, tdy = ca * box * 0.74;
        const tdl = Math.hypot(tdx, tdy) || 1;
        dirX = tdx / tdl; dirY = tdy / tdl;
        strK = 0.16 + 0.50 * tail;
        /* 6400 颗全摊在图上，每圈 4~6 百颗 → 亮度得比球形态低不少才不糊成霓虹圈 */
        em = (0.10 + 2.20 * tail) * this.gridFade;
        szm = 0.58 + 0.62 * tail;
      } else {
        const x3 = T[i3];
        let y3 = T[i3 + 1];
        const z3 = T[i3 + 2];
        if (S === 'wave') {
          y3 = Math.sin(x3 * this.waveF + t * 1.25) * this.waveA
            + Math.cos(z3 * this.waveF * 1.15 + t) * this.waveA * 0.8;
        }
        /* 先绕 Y 再绕 X */
        const x1 = x3 * cy + z3 * sy;
        const z1 = -x3 * sy + z3 * cy;
        const y2 = y3 * cx - z1 * sx;
        z2 = y3 * sx + z1 * cx;
        tx = x1 * scale;
        ty = y2 * scale;

        /* ---- 心跳的"撕开" ----
           相邻编号的粒子往相反方向甩出去（幅度随 heartbeat 包络），
           看上去就是整团被两股力拽了一下、随即弹回原状 —— 老电视花屏那一帧的错位。 */
        if (beat > 0.01) {
          const sgn = (i & 1) ? 1 : -1;
          const amp = scale * 0.075 * beat;
          tx += sgn * amp * this.beatAx;
          ty += sgn * amp * this.beatAy;
        }
      }

      /* ---- 有窗口：改道到窗口外缘的"日冕" ---- */
      if (auraW > 0.002) {
        /* 沿周长慢慢漂（逐粒速度不同 → 剪切感），贴着窗口的那层亮、外圈暗 */
        const u = (this.pu[i] + t * (0.010 + this.pr1[i] * 0.014)) % 1;
        /* 大部分贴着窗口边（近处亮、像一层被吸住的尘），少数飘到远一点的余量里。
           指数 2.2 让 3/4 的点落在内侧 30px 内，外圈只剩零星 —— 不然满屏都是雾。 */
        const band = AURA_MIN
          + Math.pow(this.pr2[i], 2.2) * bandMax * (1 + 0.6 * beat)
          + 3.5 * Math.sin(u * LP_TAU * 2 + t * 0.45);
        shapeAt(u, A.hw + band, A.hh + band, A.r + band, SH);
        const jit = (this.pr1[i] - 0.5) * 12;
        let ax = A.cx + SH.x + SH.nx * jit;
        let ay = A.cy + SH.y + SH.ny * jit;
        /* 别飞出屏幕（窗口最大化时余量很小，飞出去的点会贴在屏幕边上排成一条线） */
        ax = clamp(ax, -this.W / 2 + 6, this.W / 2 - 6);
        ay = clamp(ay, -this.H / 2 + 6, this.H / 2 - 6);
        let pk = 0;
        for (let q = 0; q < 3; q++) {
          let du = Math.abs(u - ((t * 0.05 + q / 3) % 1));
          if (du > 0.5) du = 1 - du;
          if (du < 0.12) pk = Math.max(pk, Math.exp(-((du / 0.04) ** 2)));
        }
        const emA = (0.92 - 0.42 * Math.min(1, band / 60)) * (1 + 1.9 * pk);
        dirX = SH.tx; dirY = SH.ty;
        strK = (0.22 + 0.30 * pk) * auraW;
        tx = lerp(tx, ax, auraW);
        ty = lerp(ty, ay, auraW);
        em = lerp(em, emA, auraW);
      }

      /* ---- 绘画：轮到自己的点改用画布点云当目标 ----
         `drawD[i] <= drawProg` 就是"这支笔写到这里了"。没轮到的点仍在环境形态里，
         等轮到才飞过去 —— 所以看到的是一道波沿着笔迹推过去，而不是整幅图一起塌下来。
         坐标已是屏幕系，必须绕开上面的 ry/tilt，否则画会被球体拖着转。 */
      const isDraw = drawLive && this.drawUse[i] === 1 && this.drawD[i] <= drawProg + 0.001;
      if (isDraw) {
        /* 相干度：目标按每点固定的噪声方向被推开，位移 ∝ (1-coh)。
           线性而不是平方 —— 平方在 coh 0.8 时只推 1.5px，看上去像"有点糊"，
           要到 0.2 才突然炸开；线性是"一开口就散"，让溶解的前半段也有信息。 */
        const loose = 1 - this.coh;
        if (loose > 0.001) {
          const push = loose * 40;
          tx = this.drawX[i] + this.jit[i * 2] * push;
          ty = this.drawY[i] + this.jit[i * 2 + 1] * push;
        } else {
          tx = this.drawX[i];
          ty = this.drawY[i];
        }
        z2 = 0;
        strK = 0;
        dirX = 0;
        dirY = 0;
      }

      V[i2] = (V[i2] + (tx - P[i3]) * k * dt) / (1 + c * dt);
      V[i2 + 1] = (V[i2 + 1] + (ty - P[i3 + 1]) * k * dt) / (1 + c * dt);

      /* ---- 场：引力井 ----
         弹簧负责"回到该在的位置"，井负责"此刻被谁吸引"。
         两者叠加就得到了惯性、过冲和余韵 —— 这正是静态排版给不了的东西：
         光标扫过一行字，字会被带歪一点再弹回，背景那一层也会跟着弯。
         力在弹簧之后、积分之前施加，所以是"先归位，再被拨动"。 */
      for (let wi = 0; wi < this.wells.length; wi++) {
        const W = this.wells[wi];
        const dx = W.x - P[i3];
        const dy = W.y - P[i3 + 1];
        const d2 = dx * dx + dy * dy;
        if (d2 > W.r2) continue;
        const d = Math.sqrt(d2) + 0.001;
        const pull = W.k * (1 - d / W.r) * dt;
        V[i2] += (dx / d) * pull;
        V[i2 + 1] += (dy / d) * pull;
        if (W.swirl) {
          V[i2] += (-dy / d) * pull * W.swirl;
          V[i2 + 1] += (dx / d) * pull * W.swirl;
        }
      }

      /* ---- 涡 ----
         切向为主、径向为辅。纯径向是"吸"，点会径直飞向中心、像被吸尘器吸走；
         加一个切向分量，它们才会绕着中心卷 —— 用户看到的是"这句话被搅进去了"。
         swirl 2.6、径向 0.25 是实测手感：再大就成漩涡贴图，再小只是"晃一下"。

         但**已经落在画上的点不吃这股风**。这一条是实测补的：模型画完小狗之后
         这一轮还在继续（还要说一句话、可能再调一次工具），"在想"的涡一直吹，
         弹簧的平衡点被切向力顶偏，狗就被卷成几条螺旋臂 —— 8 秒的展示期里
         有 6 秒是糊的。涡是给"还在球里"的点用的。 */
      if (!isDraw) {
        for (let vi = 0; vi < this.vorts.length; vi++) {
          const O = this.vorts[vi];
          const dx = O.x - P[i3];
          const dy = O.y - P[i3 + 1];
          const d2 = dx * dx + dy * dy;
          if (d2 > O.r2) continue;
          const d = Math.sqrt(d2) + 0.001;
          const pull = O.k * O.env * (1 - d / O.r) * dt;
          V[i2] += (-dy / d) * pull * O.swirl + (dx / d) * pull * 0.25;
          V[i2 + 1] += (dx / d) * pull * O.swirl + (dy / d) * pull * 0.25;
        }
      }

      P[i3] += V[i2] * dt;
      P[i3 + 1] += V[i2 + 1] * dt;

      /* 远侧更小更暗：正交投影里唯一的立体线索（ambient 的 baseA 只有 0.2~0.54，
         形态态要提上去才看得清，否则整团是灰的）。
         深处的点更小更暗：球面投影在轮廓处会挤成一道亮弧（看着像盘子边），
         用"前大后小"把这个堆积压掉，球体感也更明确。 */
      const dzk = grid ? 1 : clamp(0.52 + z2 * 0.50, 0.22, 1.18);
      let sa;
      let ss;
      if (isDraw) {
        /* 画上的点：亮度按墨厚，尺寸固定。
           不能走下面的 dzk —— 那是"前大后小"，用在笔画上会让粗细不匀。 */
        /* 淡入比飞行慢一点（450ms）：太快就成了"瞬间出现"，看不到粒子流过去；
           太慢又像蒙了一层雾。450ms 时能看见一串半透明的点从球里飞向笔迹。 */
        let rev = 1;
        if (this.drawOnMs > 0) {
          const el = (t - this.drawStart) * 1000 - this.drawD[i] * this.drawOnMs;
          rev = clamp(el / 450, 0, 1);
        }
        sa = this.drawA[i] * drawMix * rev;
        /* 溶解时亮度也掉：点摊开了，密度本来就在降，亮度不跟着降就只是"变模糊"，
           不是"失去结构"。0.35 是保底 —— 场不能空，空的瞬间看起来像断了。 */
        if (this.coh < 0.999) sa *= 0.35 + 0.65 * this.coh;
        ss = this.drawS[i];
      } else {
        /* occ：有窗口时压暗 —— 但改道到日冕之后（auraW→1）就不压了，
           否则窗口外面那圈会灰得看不见 */
        sa = this.baseA[i] * dzk * 2.9 * dim * em
          * (1 - 0.62 * this.occ * (1 - auraW))
          * (1 + 0.45 * beat);
        ss = this.baseS[i] * (0.45 + 1.5 * dzk) * szm;
        /* 作画时其余粒子压到很暗 —— 留着是"画长在粒子海里"的层次，
           但亮度必须低到不跟画面抢注意力（0.22 时只剩一层若有若无的底噪）。
           UI 模式要更狠（geo.dim→0.97）：一屏粒子界面背后若还浮着球体的经纬弧，
           那些弧会从字缝里穿过去，读起来像脏屏幕。 */
        if (drawMix > 0.002) sa *= 1 - (this.drawDim ?? 0.78) * drawMix;
      }
      /* 全局压暗：场被"推到后面"的时候用（翻记录、模态确认）。
         它压的是**所有**点 —— 画上的字和背景的球一起退，不能只退背景：
         只退背景的话，画面上的字会浮在雾上，反而更抢眼。 */
      if (this.uiFade < 0.999) {
        sa *= this.uiFade;
        ss *= 0.86 + 0.14 * this.uiFade;
      }
      this.alpha[i] += (sa - this.alpha[i]) * f;
      this.size[i] += (ss - this.size[i]) * f;
      /* 颜色：画是彩色的，ambient 只有 5 条纬度色带。
         退出作画后再缓慢褪回原色（用 col0 快照，不要重算调色板）。 */
      if (this.drawSeen) {
        const t3 = i * 3;
        const mr = (isDraw ? this.drawCol[t3] : this.col0[t3]) - this.col[t3];
        const mg = (isDraw ? this.drawCol[t3 + 1] : this.col0[t3 + 1]) - this.col[t3 + 1];
        const mb = (isDraw ? this.drawCol[t3 + 2] : this.col0[t3 + 2]) - this.col[t3 + 2];
        const km = Math.min(1, f * 1.6);
        this.col[t3] += mr * km;
        this.col[t3 + 1] += mg * km;
        this.col[t3 + 2] += mb * km;
      }

      /* 精灵的 y 轴向下，所以方向要取反（和窗口门一样） */
      this.aStr[i] = strK;
      if (strK > 0.001) { this.aDir[i2] = dirX; this.aDir[i2 + 1] = -dirY; }
    }

    this.geo.attributes.aDir.needsUpdate = true;
    this.geo.attributes.aStr.needsUpdate = true;
  }

  /**
   * 返回给 DOM 层用的揭示进度（0..1），由 window.js 拿去做 iframe 淡入。
   * 关窗时反过来：粒子一散，内容就跟着淡掉 —— 不然会看到"粒子都飞走了，
   * 窗口还亮着，然后啪一下消失"（早先就是这毛病：scatter 早就不递增了）。
   */
  revealOf(g) {
    const grp = this.groups[g];
    if (!grp.active) return 0;
    if (grp.closing) return clamp(1 - grp.closeT / 0.18, 0, 1);
    return smooth(REVEAL_A, 0.985, grp.pe);
  }

  /* ------------------------ 窗口的粒子门（rim） ------------------------ */

  /**
   * 开窗：团 → 中心一点 → **粒子绕着这一点不断环流** → 一边流一边放大成窗口。
   *
   * 关键：不是"窗口在转"。原型 portal.js 的做法是
   *   · 形状由 `pe` 决定：小尺寸是**正圆**（ax=ay、圆角=半径），
   *     长到一半时被拉成窗口长宽比、圆角收到 18px —— 所以看到的是
   *     "一个圆被慢慢拉成圆角矩形"，不是一块板在转；
   *   · 每颗点沿周长匀速环流（`u` 一直推进），所以任何时刻边上都有粒子在流动；
   *   · 三道亮波沿周长跑（脉冲包 pk），这是"在流动"最直接的读数；
   *   · 沿运动方向把圆点拉成流线（aDir/aStr），静止画面也看得出流向；
   *   · 小团阶段把法向厚度撑开：几百颗点挤在 13px 的圈上必然是死白一团，
   *     摊成一颗蓬松的小球，才看得出"里面在流"。
   */
  stepRimOpen(g, dt) {
    const grp = this.groups[g];
    const R = grp.rect;
    if (!R) return;
    grp.t += dt * 1000;
    const tms = grp.t;
    const t = this.time;

    /* ---- 时间轴：先在中心收成一小团流着，再慢慢长大（前 18% 只挪 6%）---- */
    const gT = clamp((tms - FLOW_MS - SEED_MS) / GROW_MS, 0, 1);
    let pe = PE_MIN;
    if (gT > 0) {
      const f = gT < 0.18
        ? 0.06 * smooth(0, 1, gT / 0.18)
        : 0.06 + 0.94 * smooth(0, 1, (gT - 0.18) / 0.82);
      pe = PE_MIN + (1 - PE_MIN) * f;
    }
    grp.pe = pe;

    /* ---- 当前尺度下的形状：小=正圆 → 大=窗口比例的圆角矩形 ---- */
    const aspectT = smooth(PE_MIN, 0.50, pe);
    const base = Math.min(R.hw, R.hh) * pe;
    const ax = lerp(base, R.hw * pe, aspectT);
    const ay = lerp(base, R.hh * pe, aspectT);
    const cornerT = smooth(PE_MIN, 0.55, pe);
    const rr = lerp(Math.min(ax, ay), Math.max(1, R.r), cornerT);
    const P = shapeAt(0, ax, ay, rr, SH) || 1;
    /* 周长越短，同样的 px/s 绕圈越快：按 sqrt(周长比) 降速，小点才不会转成频闪 */
    const Pfull = 2 * (2 * R.hw + 2 * R.hh);
    const vScale = clamp(Math.sqrt(P / Math.max(Pfull, 1)), 0.05, 1);
    const spread = 1 - smooth(PE_MIN, 0.34, pe);   // 1 = 还是个小团
    const thinT = smooth(PE_MIN, 0.55, pe);        // 0 = 小团（撑开）/ 1 = 定型（收细）

    const reveal = smooth(REVEAL_A, 0.985, pe);
    const birthing = pe < 0.9995;
    const flying = tms < FLOW_MS;
    const src = grp.src;
    /* 小团阶段压总通量（否则叠成死白）；团外层也要比背景那团亮才读得出来 */
    const dimK = 0.45 + 0.55 * Math.pow(pe, 1.10);
    const heat = 1 + 1.1 * (1 - reveal);
    /* 弹簧：收拢期要贴得紧（刚度高），到位后软一点，拖窗口才平滑 */
    const K = birthing ? 560 : 90;
    const C = birthing ? 64 : 17;

    for (let i = AMBIENT_N; i < RIM_END; i++) {
      if (this.group[i] !== g) continue;
      const k = i - AMBIENT_N - g * RIM_PER_WIN;
      const i3 = i * 3, i2 = i * 2;
      const halo = this.halo[i];
      const jit = this.phase[i];

      /* 环流：u 一直往前推（这就是"不断流动"本身），速度按当前周长换算 */
      this.u[i] += (this.spd[i] * vScale * dt) / Math.max(P, 6);
      if (this.u[i] > 1) this.u[i] -= 1; else if (this.u[i] < 0) this.u[i] += 1;
      shapeAt(this.u[i], ax, ay, rr, SH);

      /* 法向厚度：小团阶段撑开（蓬松球），晕层额外放大；
         再叠一层抖动（小团时抖得厉害，撑开后收住） */
      /* 法向厚度随阶段变：小团时撑开成蓬松球（几百颗点挤在 13px 的圈上是死白一团），
         定型后收到一条细边（3600px 周长上，34px 厚的带子会散成"一层灰"，
         收成 ±7 才是一条看得出在流的边） */
      const o = this.off[i] * (halo ? lerp(2.8, 1, thinT) : lerp(2.2, 0.30, thinT));
      const jAmp = halo ? 2 + this.pu[i] * 6 : 0.6 + this.pv[i] * 1.9;
      const wob = Math.sin(t * (0.7 + this.pu[i] * 2.6) + jit) * jAmp
        * (0.30 + 0.70 * spread);
      let tx = R.cx + SH.x + SH.nx * (o + wob);
      let ty = R.cy + SH.y + SH.ny * (o + wob);
      if (halo) {
        tx += Math.cos(t * 0.7 + jit) * 3.5;
        ty += Math.sin(t * 0.9 + jit * 1.7) * 3.5;
      }

      /* 流线只在"环流"时拉：飞行段的切线跟飞行方向无关，拉出来是横杠。
         切线方向（屏幕上 y 向下，所以 ty 取反）；晕层不拉长 */
      const sg = this.spd[i] > 0 ? 1 : -1;
      const strK = !flying && !halo ? 0.45 + this.pv[i] * 0.45 : 0;
      this.aStr[i] = strK;
      this.aDir[i2] = SH.tx * sg;
      this.aDir[i2 + 1] = -SH.ty * sg;

      if (flying) {
        /* 团 → 一点：起飞错开 0.45 个 FLOW_MS、单颗走 0.55 个 → 任何时刻
           这群点都摊满整条路，看到的是一根完整的绳在流，而不是"一坨点快速平移" */
        const dly = (jit / 6.2832) * 0.45;
        const uf = clamp((tms / FLOW_MS - dly) / 0.55, 0, 1);
        streamXY(src[k * 2], src[k * 2 + 1], tx, ty, uf, this.pv[i] * 6.2832, 2.3, STREAM, 0.45);
        this.pos[i3] = STREAM.x;
        this.pos[i3 + 1] = STREAM.y;
        this.vel[i2] = 0;
        this.vel[i2 + 1] = 0;
        /* 飞的时候要整束看得见；快落进核心时按 spread 稀疏（不然核心是死白） */
        const thin = lerp(1, this.pu[i] < 0.42 ? 1 : 0.20, smooth(0.84, 1, uf));
        this.alpha[i] = this.baseA[i] * heat * smooth(0, 0.14, uf) * thin * this.rimDim;
        this.size[i] = this.baseS[i] * 1.05;
      } else {
        /* 环流 + 长大：弹簧追目标（原型用 560/64，滞后几 px，柔软但不散） */
        const kk = K * (0.75 + this.pv[i] * 0.55);
        this.vel[i2] = (this.vel[i2] + (tx - this.pos[i3]) * kk * dt) / (1 + C * dt);
        this.vel[i2 + 1] = (this.vel[i2 + 1] + (ty - this.pos[i3 + 1]) * kk * dt) / (1 + C * dt);
        this.pos[i3] += this.vel[i2] * dt;
        this.pos[i3 + 1] += this.vel[i2 + 1] * dt;

        /* 脉冲包：三道亮波沿周长跑 —— 比"逐粒闪烁"更像一条在流的边 */
        let pk = 0;
        if (!halo && pe > 0.15) {
          for (let q = 0; q < 3; q++) {
            const pu = (t * 0.062 + q / 3) % 1;
            let du = Math.abs(this.u[i] - pu);
            if (du > 0.5) du = 1 - du;
            if (du < 0.09) pk = Math.max(pk, Math.exp(-((du / 0.03) ** 2)));
          }
        }
        let a = this.baseA[i] * dimK * heat * this.rimDim;
        if (spread > 0.01) a *= lerp(1, this.pu[i] < 0.42 ? 1 : 0.20, spread);
        /* 晕在小团阶段要**更亮**：它是"这一团在流动"的观感来源（壳层背景本来就很亮，
           照原型那样把它压到 0.45 就直接看不见了），撑开后再压回原型的比例 */
        if (halo) a *= (0.45 + 0.55 * smooth(0.25, 0.85, pe)) * (1 + 1.6 * spread);
        this.alpha[i] = a * (1 + 1.8 * pk);
        this.size[i] = this.baseS[i]
          * (0.62 + 0.38 * smooth(PE_MIN, 0.45, pe))
          * (1 + 0.55 * pk);
      }
      this.pos[i3 + 2] = 0;
    }

    this.geo.attributes.aDir.needsUpdate = true;
    this.geo.attributes.aStr.needsUpdate = true;
  }

  /**
   * 关窗：散 → 就近 6 条小流 → 小流汇成一条大流 → 被中心的团吸收。
   *
   * 结构：整框先**一起**散开（0~0.14），然后每颗点沿着同一条"复合路径"往下走：
   *     散开点 → 本段的汇合点 → 团心 → 团里
   * 但不是所有点同时走 —— 每颗点有自己的出发时刻（sb），所以任何时刻这群点
   * 都摊满整条路径，看到的是 6 条**连续的流**在往中心拧，而不是"一坨点同时到达"。
   * 每段的终点就是下一段的起点（streamXY 在 u=0/1 正好落在端点上），接缝处不跳。
   */
  stepRimClose(g, dt) {
    const grp = this.groups[g];
    grp.closeT = Math.min(1, grp.closeT + (dt * 1000) / CLOSE_MS);
    const T = grp.closeT;
    if (T >= 1) { grp.active = false; grp.closing = false; grp.pe = 0; return; }
    if (!grp.rect) return;
    grp.pe = 1;

    const uA = smooth(0, 0.14, T);        // 整框一起散开
    const scat = T < 0.14;                // 还在散
    const hubs = grp.hubs;

    for (let i = AMBIENT_N; i < RIM_END; i++) {
      if (this.group[i] !== g) continue;
      const k = i - AMBIENT_N - g * RIM_PER_WIN;
      const i3 = i * 3, i2 = i * 2;
      const x0 = grp.p0[k * 2], y0 = grp.p0[k * 2 + 1];
      const x1 = x0 + grp.sc[k * 2], y1 = y0 + grp.sc[k * 2 + 1];
      const h = hubs[grp.hubOf[k]] || hubs[0] || { x: 0, y: 0 };
      const ph = this.pv[i] * 6.2832;

      /* 黄金角散开的两个小圆：汇合点周围、团心周围（不会叠成一个死点） */
      const ja = k * 2.39996;
      const hj = 9 + (k % 5) * 2.2;
      const hx = h.x + Math.cos(ja) * hj, hy = h.y + Math.sin(ja) * hj;
      const cj = 12 + (k % 6) * 1.8;
      const qx = Math.cos(ja + 2.1) * cj, qy = Math.sin(ja + 2.1) * cj;

      let px, py, fade;
      if (scat) {
        px = lerp(x0, x1, uA);
        py = lerp(y0, y1, uA);
        fade = 1;
      } else {
        const sb = (k * 0.618) % 1;       // 出发时刻错开 0.26，单颗走 0.60
        const ss = clamp((T - 0.14 - 0.26 * sb) / 0.60, 0, 1);
        if (ss < 0.44) {
          /* 就近 → 本段的汇合点：6 条小流 */
          streamXY(x1, y1, hx, hy, ss / 0.44, ph, 1.2, STREAM, 0.5);
        } else if (ss < 0.78) {
          /* 小流 → 团心：6 条在这里拧成一条大的 */
          streamXY(hx, hy, qx, qy, (ss - 0.44) / 0.34, ph * 1.3, 1.6, STREAM, 0.45);
        } else {
          /* 沉进团里（越走越淡，最后化在团里） */
          streamXY(qx, qy, grp.dst[k * 2], grp.dst[k * 2 + 1], (ss - 0.78) / 0.22, ph, 1.4, STREAM, 0.6);
        }
        px = STREAM.x; py = STREAM.y;
        fade = 1 - smooth(0.82, 1, ss);
      }

      this.pos[i3] = px;
      this.pos[i3 + 1] = py;
      this.pos[i3 + 2] = 0;
      this.vel[i2] = 0;
      this.vel[i2 + 1] = 0;
      this.alpha[i] = this.baseA[i] * 1.3 * fade;
      this.size[i] = this.baseS[i] * (0.70 + 0.40 * fade);
    }
  }

  step(dt) {
    this.time += dt;
    const t = this.time;

    /* 桌面让位系数：agent 展开时，窗口边缘那圈粒子要跟着 DOM 一起退掉。
     *
     * 只靠 CSS 淡 out 窗口是不够的 —— 边框是**粒子**画的，CSS 碰不到它。
     * 结果就是"agent 被框在窗口里"：DOM 淡了，框还亮着。
     * 平滑过渡而不是直接置 0：窗口边上是一股一直在流的粒子，硬切会像断了电。 */
    this.rimDim += (this.rimTo - this.rimDim) * Math.min(1, dt * 3.4);
    /* 指数收敛永远差最后一口气：0.002 的 alpha 单颗看不见，
       但窗口四角挤着几百颗，加法混合叠起来就是一道看得见的框。
       所以贴近目标时直接吸附 —— 这一层要么在，要么彻底不在。 */
    if (Math.abs(this.rimDim - this.rimTo) < 0.01) this.rimDim = this.rimTo;

    /* ---- 空闲态判定：所有窗口都关了 → 粒子聚成形态 ---- */
    const busy = this.groups.some((g) => g.active || g.closing);
    const idle = !busy;
    /* 有窗口时团**不散光**，缩到 0.55 留在外面 —— 交互物是从这一团里出来的，
       团要是没了，观感就变成"窗口凭空出现在空屏上"。 */
    this.form = clamp(this.form + (idle ? 1 : -1) * dt * 1.15, busy ? 0.55 : 0, 1);
    /* 有窗口时底噪压下去：形态散开后会剩一层"球壳"，正对着窗口内容很碍眼 */
    this.occ += ((busy ? 1 : 0) - this.occ) * Math.min(1, dt * 1.8);

    /* ---- 心跳 ---- */
    if (this.launchMode) {
      /* 应用列表里不做心跳：那里背景是环/网格，跳一下会跟图标抢注意力 */
      this.beat = 0;
      this.beatT = 0;
    } else {
      this.beatT += dt;
      if (this.beatT >= this.beatNext) {
        this.beatT = 0;
        this.beatNext = 1.05 + Math.random() * 0.85;
        const a = Math.random() * 6.2832;
        this.beatAx = Math.cos(a);
        this.beatAy = Math.sin(a);
      }
      const bt = this.beatT;
      let e = 0;
      if (bt < HB_RISE) e = bt / HB_RISE;                        // 起跳
      else if (bt < HB_RISE + HB_FALL) e = 1 - (bt - HB_RISE) / HB_FALL;  // 回落
      this.beat = e > 0 ? Math.pow(e, 1.7) : 0;
    }

    /* ---- 窗口占位矩形：粒子绕它外缘流，中央一块不画 ---- */
    this.auraRect = null;
    let bestArea = 0;
    for (let g = 0; g < MAX_WIN; g++) {
      const grp = this.groups[g];
      /* 关窗过程中（closing）也算：窗口还在淡出，粒子不该这时候就往中央冲 */
      if (!grp.active || !grp.rect) continue;
      const area = grp.rect.hw * grp.rect.hh;
      if (area > bestArea) { bestArea = area; this.auraRect = grp.rect; }
    }

    /* ---- ambient：自由漂移，强度按 (1-form) 衰减 ---- */
    const free = (1 - this.form) * (1 - 0.85 * this.occ);
    const hw = this.W / 2 + 60, hh = this.H / 2 + 60;
    for (let i = 0; i < AMBIENT_N; i++) {
      if (free <= 0.02) break;
      const ph = this.phase[i];
      this.vel[i * 2] += Math.cos(t * 0.23 + ph) * 3.2 * free * dt;
      this.vel[i * 2 + 1] += Math.sin(t * 0.19 + ph * 1.3) * 3.2 * free * dt;
      this.vel[i * 2] *= 1 - 0.55 * free * dt;
      this.vel[i * 2 + 1] *= 1 - 0.55 * free * dt;
      let x = this.pos[i * 3] + this.vel[i * 2] * dt;
      let y = this.pos[i * 3 + 1] + this.vel[i * 2 + 1] * dt;
      /* 只在基本自由时才做边界环绕；形态期间粒子本来就该待在屏幕内 */
      if (free > 0.4) {
        if (x > hw) x = -hw; else if (x < -hw) x = hw;
        if (y > hh) y = -hh; else if (y < -hh) y = hh;
      }
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.alpha[i] = this.baseA[i] * (0.78 + 0.22 * Math.sin(t * 0.7 + ph)) * (1 - 0.72 * this.occ);
    }

    /* ---- 拖动惯性：松手后角速度指数衰减（约 1s 停住） ---- */
    if (!this.dragging && (this.yawV || this.pitchV)) {
      this.yaw += this.yawV * dt;
      this.pitch = clamp(this.pitch + this.pitchV * dt, -1.30, 1.30);
      const damp = Math.exp(-3.4 * dt);
      this.yawV *= damp;
      this.pitchV *= damp;
      if (Math.abs(this.yawV) < 0.02) this.yawV = 0;
      if (Math.abs(this.pitchV) < 0.02) this.pitchV = 0;
    }
    /* 应用列表里把相机视角慢慢归零，环和网格才是正对着看的 */
    if (this.launchMode) {
      const back = Math.exp(-3.2 * dt);
      this.yaw *= back;
      this.pitch *= back;
      this.yawV = 0;
      this.pitchV = 0;
    }

    /* ---- 形态：弹簧把粒子拉向投影后的目标 ---- */
    /* 平铺布局先算好：stepShape 要拿它摆"每个图标一圈流"，stepLaunch 也要用 */
    this._grid = this.launchMode === 2 && this.launchCount
      ? this.gridLayout(this.launchCount)
      : null;
    /* 环和网格之间切换时 launchProg 一直是 1，所以那圈流要自己淡入淡出，
       否则图标还在半路上飞，环已经"啪"地亮起来了 */
    this.gridFade += ((this._grid ? 1 : 0) - this.gridFade) * Math.min(1, dt * 4.5);
    if (this.form > 0.01) this.stepShape(dt);

    /* ---- rim：每个窗口一组 ----
       开 = 团 → 中心一点 → 转 → 撑开；关 = 散 → 6 条小流 → 汇成一条 → 被团吸收。
       两段都走 streamXY，所以进出的"手感"是同一套，不会一个长一个炸。 */
    for (let g = 0; g < MAX_WIN; g++) {
      const grp = this.groups[g];
      if (!grp.active) continue;
      if (grp.closing) this.stepRimClose(g, dt);
      else this.stepRimOpen(g, dt);
    }

    /* ---- 左边缘应用栏 ---- */
    this.stepRail(dt);
    /* ---- 右下角设备状态 ---- */
    this.stepStat(dt);

    /* ---- 应用列表（ring / grid） ----
       退出时也要继续跑，让图标自己淡到 0，不能停在半透明状态 */
    this.stepLaunch(dt);

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    /* 颜色平时是静态的（只按纬度带分过色），只有作过画、正在混色时才需要每帧上传 */
    if (this.drawSeen) this.geo.attributes.aColor.needsUpdate = true;
  }

  render() {
    this.renderer.render(this.scene, this.cam);
  }
}
