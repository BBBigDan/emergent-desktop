import * as THREE from 'three';

/* ============================================================
 * 涌现式粒子原型 v0.14
 * 变更（用户：「能不能看清主要取决于笔画之间的空隙、粒子坐标的偏移和
 * 光晕大小，所以需要找一个很瘦的字」——这条诊断把问题从「堆粒子/调点距」
 * 引到真正的三个变量上，是本版全部改动的出发点）：
 *      · 变量 1｜笔画宽度（字重）：做 .tmp/fontprobe.html 用**生产同款采样
 *        算法**把候选字体点阵化实测——微软雅黑 400 / SimHei 笔画 3.0 UI px
 *        ÷ 点距 2.5 = 1.2 格，横截面恒占 2 格 → 字怀被吃掉、糊成块；
 *        等线 Light (DengXian Light) 笔画 2.0 ÷ 2.5 = 0.8 格、4 邻域连通度
 *        2.1~2.3 → 笔画恰 1 格、字怀留 1 格暗缝。故中文换等线 Light，
 *        西文换 Bahnschrift Light；**去掉全部文字描边**（v0.11 为对抗大光斑
 *        加的 2.5~3px 描边会把笔画变成 5px ≈ 2 格，正是「糊」的另一半）。
 *      · 变量 2｜字间空隙：汉字全角紧贴，字与字之间默认 0 空隙（两个字的
 *        笔画在点阵上并成一片）→ 新增 UI_TRACK=2.5px 字距（= 1 格）。
 *      · 变量 3｜粒子坐标的偏移：v0.13 的「2 倍过采样 + 半格交错」把晶格
 *        搅成 1.25px 伪网格（点距 1.76 ≈ 光斑 1.75 相切 = 实心亮带）——
 *        改为 **1:1 一格一点、格心对齐**（骨架 6800→3500 = M）。
 *      · 栅格化规则：采样从「格内任一像素有墨」改为 **格覆盖率阈值化**
 *        （alpha 二值掩膜积分图，TH=0.45），2.0px 笔画中心格覆盖率 0.80
 *        （亮）、相邻格 0.20（灭）→ 每个笔画横截面恒 1 格。
 *      · 字号上调（可读性 = 每字占多少格，汉字点阵下限 16×16）：
 *        勾选标签 32→44px（12.8→17.6 格）、输入 38→46px（18.4 格）、
 *        按钮 30→44px、副标 24→38px、标题 64→72px；版面重排进可见区。
 *      · 连带修掉三个真 bug：
 *        ① 角色解码错：alpha 加权用了 0~255 原值（未除 255）→ 全部 3500 粒
 *           被判成「关闭按钮」→ 全屏连线（3x 截图里字上的那张网）。改为取
 *           格内最高 alpha 像素的 R 值（笔画核心，R=role×30 精确）。
 *        ② 连线判定用了 P.pos（采样时粒子还在球面）→ 边框全判成文字；
 *           改用 P.target（落位槽位）。
 *        ③ 连线过滤按 role 做，漏了「图框+标签」「按钮环+按钮文字」同 role
 *           的情况 → 改为几何判定：只连距矩形边 ≤9px 的环带 / 34×34 图框；
 *           阈值 0.75→0.20 世界（0.2 世界² = 仅 1 格正交邻）→ 边框成连续
 *           点线，文字零连线。
 *      · 总粒子 10600→7300（骨架 3500 + 增援 3800）；深链新增
 *        ?fnt=deng|yahei|simhei / ?th= / ?track= / ?nolink=1 对照实验。
 * v0.13 变更（用户：「还是断的；鼠标周围大量粒子没有去支援，说明你的点位
 * 不足，而不是粒子不够」——两条诊断都成立，v0.12 只改了粒子没改点位）：
 *      · 根因：v0.12 把骨架 1000→2500，但**槽位网格一动没动**（cell
 *        4.5 → 全画面仅 2633 槽）。于是两个比例同时错——
 *        ① 骨架被槽位数量卡住，有效点距只能到 4.6 UI px > 光斑 4.03
 *           → 点间有缝 = 「断」；
 *        ② 悬停控件只有 ~812 槽，capK 0.75 → 3500 增援里仅 609 粒
 *           能落位，~2900 粒在鼠标周围空转 = 「不支援」；
 *      · 修复（点位数才是密度上限，粒子只是填充）：
 *        - 骨架槽位网格 cell 4.5→2.5（2633→~6500 槽，笔画横截面
 *          1.4→2.6 点）+ 骨架 2500→6800（≈1:1 填满槽位）→ 点距 2.5）；
 *        - 增援层**独立**细网格 SCAN_CELL_R=1.4（悬停控件槽位 ×10，
 *          input 812→4500）+ 容量 0.95 → 倾泻 609→3800（**全部**增援，
 *          环绕 0：鼠标周围不再有粒子空转）；
 *        - 点精灵渲染根治：Three 点尺寸不含 fov 修正（少算一半）×
 *          软光晕可见芯仅 43% → 实测光斑只有 ~1.6 UI px。改硬芯圆点
 *          贴图（可见芯 88%）+ 尺寸按实测校正 + opacity 0.5 防叠加过曝；
 *        - 骨架**对齐格心、零抖动**（同相位 → 均匀点阵，不再是噪点）；
 *        - 字号：标题 64 / 输入 38 / 勾选 32 / 按钮 30 / 副标题 24，
 *          笔画描边从 v0.11 的「对抗大光斑」值减半（光斑不再溢出）；
 *        - 布局重排：可交互元素收进可见区 y∈[81,409]，修掉「确认」压
 *          「静默模式」的重叠；
 *      · 总量 6000→10600（骨架 6800 + 增援 3800）；深链上限
 *        ?n=→16000、?static=→12000；诊断输出「点距/光斑比」。
 * v0.11 点阵字清晰度工程：CELL 抽稀 + 光斑 0.58<点距 4.5 + 笔画
 *      加粗 ≥17 屏px + 文字区断连线，根治「体感糊」（详见下）。
 * v0.10 整体放大：UI_S 0.072→0.144 + 机位 55→48（屏幕文字 ×2.62）。
 * v0.9 变更（用户反馈「文字太小 + 粒子近似位置干扰显示」）：
 *      · 全面大字化：UI 逻辑画布 760×490，字体 ×~1.7
 *        （标题 46→76px / 输入框文字 17→26px / 按钮 16→24px /
 *         勾选框标签 15→20px），世界缩放 UI_S 0.062→0.072、
 *        机位 58→55 —— 屏幕上文字笔画粗细/整体尺寸 ×~2.7；
 *        同样 1000 个骨架粒子，字越大每个字分到的粒子越多；
 *      · 位置近似收紧（抖动不再糊笔画）：采样抖动 ±0.9·STEP→±0.35·STEP；
 *        增援槽位微旋半径 0.30→0.10；UI 模式骨架呼吸 0.25→0.07、
 *        流场 0.06→0.03、弹簧 ×3→×3.6（近静置，文字钉住）；
 *        骨架粒子 1.02→1.15（笔画更实）、增援 0.62→0.55（光尘更细）；
 *        环绕光晕 z 偏负（沉到文字后方，不干扰阅读）。
 *      · 修复两个 v0.8 真实 bug：
 *        ① pointermove 在 UI 模式直接写 ui.hover，与帧内"hover 变化检测"
 *           互相抵消 → 真实鼠标划过控件时增援层永不倾泻/释放（只有深链能触发）；
 *           现改为 hover 完全由 updateDynamicTargets 驱动，深链 forceHover
 *           在首次真实移动时交权；
 *        ② 环绕态物理过软（k×0.5 / 流场 0.55）：粒子被流场吹离槽位 ~38px，
 *           在文字区拖出"全宽暗带"（无头截图实拍确认）→ k×0.9 / 流场 0.30 /
 *           呼吸 0.6；另修复 UI 模式连线 drawRange 从未设置（神经网实际不可见）。
 * v0.8 双层结构：1000 骨架粒子钉住面板 + 2000 增援粒子随鼠标
 *      倾泻到光标处控件（不靠堆总量）。
 * v0.5 起配色映射：颜色只代表温度（色相冷→暖 / 亮度暗→亮 /
 *       超温暗红闪烁）；负载只驱动运动；硬件类型仅由位置分区表达。
 *
 * - 每个粒子受弹簧引力指向形态目标点，整群作为统一体流动
 * - 呼吸：全局径向逆引力（与向心引力对抗），包络顶点停留；
 *   负载低 → 深而慢（休眠呼吸），负载高 → 浅而快（活跃）
 * - 形态重组：球体 / 环面 / 星系 / 涟漪 / 引力雕塑，自动巡航或手动切换
 * - 全局平滑流场（fBm）代替逐粒子布朗运动 —— 相邻粒子受力一致，整体起伏
 * - 指针 = 引力井（整群被吸引变形），点击 = 冲击脉冲（整群波纹）
 * - 粒子 UI：离屏 canvas 采样 → 保序配对 → 引力组成可交互面板（Enter 唤出）
 * ============================================================ */

/* ---------- 配置 ---------- */
const TYPES = [
  { name: 'CPU',  color: 0x44aaff, css: '#44aaff', factor: 1.05 },
  { name: 'GPU',  color: 0x2ee4d8, css: '#2ee4d8', factor: 0.92 },
  { name: '内存', color: 0xb277ff, css: '#b277ff', factor: 1.00 },
  { name: '显存', color: 0x18e0b9, css: '#18e0b9', factor: 0.95 },
  { name: '硬盘', color: 0xffb040, css: '#ffb040', factor: 0.82 },
];
const R = 26;
/* 粒子总数与双层结构：UI 涌现模式下骨架粒子（STATIC_N 个）钉住整个
 * 面板，其余为增援粒子（跟随光标、倾泻到悬停控件）。自由形态下
 * 7300 粒子仍是一个整体云群。
 *
 * v0.14 点阵屏对齐（关键认识）：骨架粒子数不再「越多越清」。改格覆盖率
 * 采样后全画面候选槽位 M≈3400，骨架取 3500（≈1:1）→ **一个槽位一个点**，
 * 点阵格心一一对应；v0.13 的 6800 是 2 倍过采样（每个槽位 2 粒、半格交错），
 * 相当于把网格再细分一半 → 点距 1.76 ≈ 光斑 1.75 相切，笔画糊成实心亮带
 * （截图实测：字能认出但「体感糊」）。多余的粒子不如留给增援层。
 * 可用 ?n=<200~16000> 覆盖总数、?static=<int> 覆盖骨架数；
 * 帧率不足时自动降级（优先压缩增援层，保住骨架可读性）。
 *
 * v0.13 密度工程·决定性修正（用户：「鼠标周围有大量的粒子没有去支援，
 * 说明你的点位不足，而不是粒子不够」——诊断正确）：
 *   「放大字号」在这个介质里就是放大点阵显示屏的字模，点阵密度必须按
 *   **面积**同比放大（v0.10 字号 ×2.6 → 笔画面积 ×6.9），否则每个笔画
 *   摊到的点越来越少 = 字越大越散。v0.12 只把粒子 1000→2500（×2.5）而
 *   槽位网格一格没动（cell 4.5 → 全画面仅 2633 槽），于是两处比例都错：
 *     ① 骨架有效点距被卡在 4.6 UI px > 光斑 4.03 → 点间有缝 = 「断」；
 *     ② 悬停控件只有 ~812 槽，capK 0.75 下仅 609 粒能落位，3500 增援中
 *        ~2900 粒只能在鼠标周围空转 = 「不支援」。
 *   v0.13 一次性把两个比例做对（不再加补偿性旋钮）：
 *     - 槽位网格 cell 4.5→3.5（全画面 2633→~4350 槽，笔画横截面 1.4→1.9
 *       点）+ 骨架 2500→4400（≈1:1 填满槽位，抽样比 ≈1 无各向异性拉伸）
 *       → 有效点距 4.6→3.5 UI px = 光斑的 0.87 倍 → 点相切重叠、笔画连续；
 *     - 增援层**独立**扫描网格 SCAN_CELL_R=2.0（悬停控件槽位 ×5：input
 *       812→~4100）+ 容量 0.75→0.95 / 0.30→0.60 → 倾泻 609→~3800 粒。 */
let COUNT = 7300;
let STATIC_N = 3500;
const TAU = Math.PI * 2;

const SHAPE_ORDER = ['sphere', 'torus', 'galaxy', 'wave', 'sculpture'];
const SHAPE_NAMES = {
  sphere: '神经球体', torus: '引力环面', galaxy: '螺旋星系',
  wave: '涟漪曲面', sculpture: '引力雕塑',
};
/* 每种形态的最佳俯仰角（机位建议） */
const SHAPE_PHI = { sphere: 1.32, torus: 1.12, galaxy: 0.55, wave: 0.88, sculpture: 1.22 };

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const $ = (id) => document.getElementById(id);

/* ---------- 噪声（value noise + fbm：形变参数 / 全局流场） ---------- */
function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1274126177) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const c000 = hash3(ix, iy, iz, seed),         c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed),     c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed),     c101 = hash3(ix + 1, iy, iz + 1, seed);
  const c011 = hash3(ix, iy + 1, iz + 1, seed), c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
  const x00 = c000 + (c100 - c000) * ux, x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux, x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy, y1 = x01 + (x11 - x01) * uy;
  return (y0 + (y1 - y0) * uz) * 2 - 1;
}
function fbm(x, y, z, seed) {
  return vnoise(x, y, z, seed) * 0.6
       + vnoise(x * 2.1, y * 2.1, z * 2.1, seed + 71) * 0.3
       + vnoise(x * 4.3, y * 4.3, z * 4.3, seed + 131) * 0.1;
}

/* ---------- 渲染器 / 场景 ---------- */
const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  $('fallback').hidden = false;
  $('loading').classList.add('hide');
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x04060c, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
const group = new THREE.Group();
scene.add(group);

/* 两种点精灵贴图：
 * - glowTex（软光晕）：中心→边缘 alpha 1→0.85→0.28→0，用于自由形态的星云
 *   质感。**注意它的可见芯径只有标称尺寸的 ~43%**（alpha 半峰在 0.43 半径），
 *   v0.13 实测：标称 4.03 UI px 的光斑在屏幕上只有 ~1.7 UI px 的实心芯，
 *   而点距 3.5 UI px → 视觉点距是光斑的 2 倍 = 无论加多少粒子都显「断」。
 * - glowTexHard（硬芯圆点）：0.55 半径内满 alpha + 0.72 处 0.55 软边，
 *   可见芯径 ≈ 0.86 标称，专供 UI 模式骨架层 —— 点阵字要的是**清晰的点**
 *   而不是雾团（v0.11 的「糊」= 软光晕在点距 < 光斑时互相渗透），硬芯圆点
 *   在 点距 ≈ 光斑 时正好相切成连续笔画，且字怀保持干净。
 */
function makeGlowTexture(hard) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  if (hard) {
    // 硬芯圆点：0~0.82 半径满 alpha（实心盘），0.82→1.0 仅作抗锯齿软边
    // → 可见芯径 ≈ 0.88 标称，几乎不向外溢出（不会糊字怀）
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.82, 'rgba(255,255,255,1)');
    grad.addColorStop(0.9, 'rgba(255,255,255,0.62)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  } else {
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const glowTex = makeGlowTexture(false);
const glowTexHard = makeGlowTexture(true);

/* ---------- 工况色谱（颜色不区分硬件类型，只表达工况） ----------
 * 用户定义的视觉映射：色相 = 温度（低温冷色 → 高温暖色 → 超温暗红告警）；
 * 负载不参与着色，只驱动运动（弹簧刚度 / 流场强度 / 呼吸速率，见 step()）。
 * 亮度随温度升高（文档 §2.2「温度 → 发光参数」）。
 * 硬件类型仅由位置分区表达（文档 §2.3 聚类逻辑）。
 */
const TEMP_STOPS = [
  { at: 0.00, c: [0x44, 0xaa, 0xff] }, // 冰蓝 · 低温
  { at: 0.25, c: [0x2e, 0xe4, 0xd8] }, // 电青
  { at: 0.50, c: [0x18, 0xe0, 0xb9] }, // 洋青
  { at: 0.75, c: [0xb2, 0x77, 0xff] }, // 淡紫
  { at: 1.00, c: [0xff, 0xb0, 0x40] }, // 琥珀 · 高温
];
const ALERT_RGB = [0xff, 0x4c, 0x5c]; // 暗红 · 超温告警
const _rgb = [0, 0, 0];

function sampleTempColor(temp, out) {
  let i = 0;
  while (i < TEMP_STOPS.length - 2 && temp > TEMP_STOPS[i + 1].at) i++;
  const a = TEMP_STOPS[i], b = TEMP_STOPS[i + 1];
  const f = clamp((temp - a.at) / (b.at - a.at), 0, 1);
  for (let k = 0; k < 3; k++) out[k] = (a.c[k] + (b.c[k] - a.c[k]) * f) / 255;
  return out;
}

/* 单粒子着色：色相/亮度 = 温度（冷→暖、暗→亮）；超温 → 暗红 + 低频闪烁；呼吸顶点微提亮 */
function particleColor(temp, time, ph, breathEnv, breathAmp, out) {
  sampleTempColor(temp, out);
  // 温度 → 亮度：低温暗、高温亮
  let b = 0.28 + temp * 0.55;
  // 高温 → 叠加白色提亮（文档：辉光强度拉满，叠加白色提亮）
  if (temp > 0.75) {
    const w = (temp - 0.75) / 0.25 * 0.35;
    for (let k = 0; k < 3; k++) out[k] += (1 - out[k]) * w;
  }
  // 超温 → 暗红告警 + 低频柔和呼吸闪烁（无高频爆闪）
  if (temp > 0.85) {
    const a = (temp - 0.85) / 0.15;
    for (let k = 0; k < 3; k++) out[k] += (ALERT_RGB[k] / 255 - out[k]) * a;
    b *= 1 + Math.sin(time * 2.6 + ph) * 0.18 * a;
  }
  // 呼吸吸气顶点整群微提亮
  if (breathEnv > 0) b *= 1 + 0.10 * breathEnv * breathAmp;
  for (let k = 0; k < 3; k++) out[k] = Math.min(out[k] * b, 1);
  return out;
}

/* ---------- 星野 ---------- */
function buildStars() {
  const n = 340;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 260 + Math.random() * 240;
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = Math.cos(th) * s * r;
    pos[i * 3 + 1] = u * r;
    pos[i * 3 + 2] = Math.sin(th) * s * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ size: 0.55, color: 0x9db4dd, transparent: true, opacity: 0.5, depthWrite: false });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
}
const stars = buildStars();

/* ---------- 粒子系统（双层：静态骨架 + 光标增援） ----------
 * 物理仍在 master 数组（pos/vel/target/dynTarget…）上统一积分，
 * 渲染拆成两个 Points：骨架层用 subarray 视图 [0, nS*3)，
 * 增援层用 [nS*3, n*3) —— 视图共享同一块 ArrayBuffer，
 * 逐帧只需对两个 geometry 各置一次 needsUpdate。
 * 两层可用不同粒子尺寸：UI 模式下骨架 1.02（大而实）、增援 0.62（细密光尘）。
 */
let P = null;

function buildSystem(count, nStatic) {
  if (P) {
    group.remove(P.ptsS); group.remove(P.ptsD);
    P.geoS.dispose(); P.geoD.dispose();
    P.matS.dispose(); P.matD.dispose();
    for (const L of P.links) { group.remove(L.obj); L.geo.dispose(); L.mat.dispose(); }
  }
  const n = count;
  const nS = Math.max(200, Math.min(nStatic, n - 200)); // 骨架数
  const nD = n - nS;                                     // 增援数
  const baseDir = new Float32Array(n * 3);
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const target = new Float32Array(n * 3);
  const dynTarget = new Float32Array(n * 3); // 增援层目标（UI 模式：环绕/槽位）
  const phase = new Float32Array(n);
  const ptype = new Uint8Array(n);
  const uiRole = new Uint8Array(n); // UI 涌现模式下的角色（标题/输入框/按钮…）
  const pu = new Float32Array(n);
  const pv = new Float32Array(n);
  const pr1 = new Float32Array(n);
  const pr2 = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  // —— 双层标记与增援层私有参数 ——
  const isDyn = new Uint8Array(n);   // 1 = 增援粒子
  const dynMode = new Uint8Array(n); // 增援态：0 = 环绕光标 / 1 = 槽位增援
  const orbR = new Float32Array(n);  // 环绕半径（世界单位）
  const orbPh = new Float32Array(n); // 环绕初相
  const orbS = new Float32Array(n);  // 环绕角速度系数

  // 球面 Fibonacci 分布，按类型切分 5 个纬度带（五色分区）
  // 索引重排：纬度带填充序中 i%3===0 的粒子 → 静态骨架段 [0, nS)，
  // 其余 → 增援段 [nS, n)。静态粒子因此仍散布于全部类型带
  // （UI 涌现时从四面八方飞入面板），但索引连续 —— 两个渲染层可用
  // subarray 视图直接切分，增援循环也可按 [nS, n) 遍历。
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const newIdx = new Int32Array(n).fill(-1);
  let sc = 0, dc = 0;
  for (let i = 0; i < n; i++) if (i % 3 === 0 && sc < nS) newIdx[i] = sc++;
  for (let i = 0; i < n && sc < nS; i++) if (i % 3 === 1 && newIdx[i] === -1) newIdx[i] = sc++;
  for (let i = 0; i < n; i++) if (newIdx[i] === -1) newIdx[i] = nS + dc++;
  let idx = 0;
  for (let t = 0; t < TYPES.length; t++) {
    const cnt = (t === TYPES.length - 1) ? (n - idx) : Math.floor(n / TYPES.length);
    if (cnt <= 0) continue;
    const bandH = 0.168, gap = 0.030;
    const y0 = 1 - t * (bandH + gap) - 0.006;
    const y1 = y0 - bandH;
    for (let j = 0; j < cnt; j++) {
      const y = y1 + (y0 - y1) * (cnt === 1 ? 0.5 : j / (cnt - 1));
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = GOLDEN * j + t * 2.399;
      const i = newIdx[idx], i3 = i * 3;
      idx++;
      baseDir[i3] = Math.cos(th) * rr;
      baseDir[i3 + 1] = y;
      baseDir[i3 + 2] = Math.sin(th) * rr;
      phase[i] = Math.random() * Math.PI * 2;
      ptype[i] = t;
      pu[i] = Math.random();
      pv[i] = Math.random();
      pr1[i] = Math.random();
      pr2[i] = Math.random();
      pos[i3] = baseDir[i3] * R;
      pos[i3 + 1] = baseDir[i3 + 1] * R;
      pos[i3 + 2] = baseDir[i3 + 2] * R;
    }
  }

  // 骨架段 [0, nS) / 增援段 [nS, n)（索引重排后严格连续）
  for (let i = 0; i < n; i++) isDyn[i] = i < nS ? 0 : 1;
  const staticIds = new Int32Array(nS);
  const dynIds = new Int32Array(nD);
  let si = 0, di = 0;
  for (let i = 0; i < n; i++) {
    if (isDyn[i]) dynIds[di++] = i; else staticIds[si++] = i;
  }
  // 增援层环绕参数：半径 2.2~4.6 世界单位（≈35~74px），相位/速度随机
  for (let i = 0; i < n; i++) {
    if (!isDyn[i]) continue;
    orbR[i] = 2.2 + Math.random() * 2.4;
    orbPh[i] = Math.random() * TAU;
    orbS[i] = 0.75 + Math.random() * 0.65;
  }

  const sphereTargets = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) sphereTargets[i] = baseDir[i] * R;
  target.set(sphereTargets);
  dynTarget.set(sphereTargets);

  // —— 两个 Points：subarray 视图共享 master buffer ——
  function makeLayer(off, len) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(off * 3, (off + len) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(colors.subarray(off * 3, (off + len) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({
      size: 0.55, map: glowTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: true,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    group.add(pts);
    return { geo: g, mat: m, pts };
  }
  const LS = makeLayer(0, nS);      // 骨架层
  const LD = makeLayer(nS, nD);     // 增援层

  // 同类型连线（拓扑按形态目标重建，位置每帧跟随）
  // links[0] 专供 UI 涌现模式（骨架近邻 + 增援近邻），容量 ×2.5；links[1..4] 为类型内连线
  const typeIds = TYPES.map(() => []);
  for (let i = 0; i < n; i++) typeIds[ptype[i]].push(i);
  const allIds = new Int32Array(n);
  for (let i = 0; i < n; i++) allIds[i] = i;
  const links = [];
  for (let t = 0; t < TYPES.length; t++) {
    const maxCap = t === 0 ? Math.ceil(n * 2.5) : n;
    const pairs = new Int32Array(maxCap * 2);
    const lpos = new Float32Array(maxCap * 6);
    const lcol = new Float32Array(maxCap * 6);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lpos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(lcol, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    const lm = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.15,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const lo = new THREE.LineSegments(lg, lm);
    lo.frustumCulled = false;
    group.add(lo);
    links.push({ pairs, maxCap, cap: 0, geo: lg, mat: lm, obj: lo });
  }

  P = { n, nS, nD, baseDir, pos, vel, target, dynTarget, phase, ptype, uiRole, pu, pv, pr1, pr2, colors, geo: null,
        isDyn, dynMode, orbR, orbPh, orbS, staticIds, dynIds, sphereTargets,
        ptsS: LS.pts, matS: LS.mat, geoS: LS.geo, ptsD: LD.pts, matD: LD.mat, geoD: LD.geo,
        links, typeIds, allIds,
        dissolveFrom: new Float32Array(n * 3), dissolveTo: new Float32Array(n * 3) };
  rebuildLinks();
}

/* 两个 geometry 的位置/颜色标记为待上传 */
function markGeoDirty() {
  P.geoS.attributes.position.needsUpdate = true;
  P.geoS.attributes.color.needsUpdate = true;
  P.geoD.attributes.position.needsUpdate = true;
  P.geoD.attributes.color.needsUpdate = true;
}

/* 网格分桶收集近邻候选对：cell 边长 = 阈值半径，每个点只查自身及相邻 26 个 cell，
 * 把 O(n²) 全比较降为 ~O(n·k)（3000 粒子下 UI 模式从 450 万对降至 ~15 万次距离计算）。
 * 无向对只收一次（j > i）。 */
function gridCandidates(src, ids, threshold) {
  const inv = 1 / Math.sqrt(threshold);
  const grid = new Map();
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k], i3 = i * 3;
    const key = (Math.floor(src[i3] * inv) + 256)
              + (Math.floor(src[i3 + 1] * inv) + 256) * 512
              + (Math.floor(src[i3 + 2] * inv) + 256) * 262144;
    let b = grid.get(key);
    if (!b) grid.set(key, b = []);
    b.push(i);
  }
  const cand = [];
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k], i3 = i * 3;
    const px = src[i3], py = src[i3 + 1], pz = src[i3 + 2];
    const bx = Math.floor(px * inv), by = Math.floor(py * inv), bz = Math.floor(pz * inv);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = grid.get((bx + dx + 256) + (by + dy + 256) * 512 + (bz + dz + 256) * 262144);
      if (!b) continue;
      for (let m = 0; m < b.length; m++) {
        const j = b[m];
        if (j <= i) continue;
        const j3 = j * 3;
        const ex = px - src[j3], ey = py - src[j3 + 1], ez = pz - src[j3 + 2];
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < threshold) cand.push([d2, i, j]);
      }
    }
  }
  return cand;
}

/* 依据当前形态的目标位置，重建近邻连线拓扑（网格分桶收集候选，按距离升序填满 maxCap）
 * threshold：连线距离阈值（世界单位，平方）；UI 涌现模式用 rebuildUiLinks() */
function rebuildLinks(threshold = 62) {
  const src = P.target;
  for (let t = 0; t < TYPES.length; t++) {
    const L = P.links[t];
    const cand = gridCandidates(src, P.typeIds[t], threshold);
    cand.sort((p, q) => p[0] - q[0]);
    const cap = (typeof SCAN_NOLINK !== 'undefined' && SCAN_NOLINK) ? 0 : Math.min(cand.length, L.maxCap);
    for (let k = 0; k < cap; k++) { L.pairs[k * 2] = cand[k][1]; L.pairs[k * 2 + 1] = cand[k][2]; }
    L.cap = cap;
  }
}

/* UI 涌现模式连线（links[0]）：
 * - 骨架层：按静态目标近邻（网格分桶 + 排序 → 最近优先），细神经网；
 * - 增援层：按当前位置近邻（不排序、限额填充）—— 槽位态用小阈值
 *   （槽点密集，连成"实心文字"质感），环绕态用较大阈值（彗光滑尾） */
function rebuildUiLinks() {
  const L = P.links[0];
  /* v0.14：连线只保留**线条类几何**（边框环 / 图框 / 关闭 ×），文字一律不连。
   * v0.13 按 role 过滤漏了两个：ROLE.check 同时包含图框和标签文字、
   * ROLE.btn 同时包含按钮环和按钮文字 → 标签/文字的点被近邻线织成网，
   * 3x 放大截图里「静默模式」四个字上覆盖着一层网 = 用户说的「糊」。
   * 几何判定：input/btn 取「距矩形边 ≤9 UI px 的环带」，check 只取 34×34
   * 图框本身，文字（框外/框内中心）dEdge 远大于 9 → 自然被排除。 */
  const nearEdge = (ux, uy, r, pad) => Math.min(
    Math.abs(ux - r.x), Math.abs(ux - r.x - r.w),
    Math.abs(uy - r.y), Math.abs(uy - r.y - r.h)) <= pad;
  const skel = [];
  for (let k = 0; k < P.staticIds.length; k++) {
    const i = P.staticIds[k], role = P.uiRole[i];
    if (!role || role === ROLE.title || role === ROLE.sub || role === ROLE.caret || role === ROLE.mark) continue;
    const i3 = i * 3;
    // 用**目标位置**（面板落位后的槽位）判定几何：uiSample 在 "converging"
    // 阶段就建连线，此刻 P.pos 还在球面上 → 按 pos 判定会把边框全判成文字
    // （v0.13 的 19/3500 命中就是这么来的）。
    const ux = P.target[i3] / UI_S + UI_W / 2, uy = -P.target[i3 + 1] / UI_S + UI_H / 2;
    let keep = false;
    if (role === ROLE.input) keep = nearEdge(ux, uy, UI_RECTS[0], 9);
    else if (role === ROLE.btn) keep = nearEdge(ux, uy, UI_RECTS[3], 9) || nearEdge(ux, uy, UI_RECTS[4], 9);
    else if (role === ROLE.close) keep = true;
    else if (role === ROLE.check) {         // 只连 34×34 图框
      for (let ci = 0; ci < 2; ci++) {
        const cr = UI_RECTS[1 + ci];
        const bx = cr.x + 16, by = cr.y + (cr.h - 34) / 2;
        if (ux > bx - 3 && ux < bx + 37 && uy > by - 3 && uy < by + 37) { keep = true; break; }
      }
    }
    if (keep) skel.push(i);
  }
  const cand = gridCandidates(P.target, new Int32Array(skel), 0.20);
  cand.sort((p, q) => p[0] - q[0]);
  const cap = (typeof SCAN_NOLINK !== 'undefined' && SCAN_NOLINK) ? 0 : Math.min(cand.length, L.maxCap);
  for (let k = 0; k < cap; k++) { L.pairs[k * 2] = cand[k][1]; L.pairs[k * 2 + 1] = cand[k][2]; }
  // 增援层阈值：有粒子处于槽位态 → 密网；纯环绕 → 滑尾
  let anySlot = false;
  for (let i = P.nS; i < P.n; i++) if (P.dynMode[i] === 1) { anySlot = true; break; }
  /* v0.13 修复：槽位态按**目标位置**（dynTarget）建连线拓扑，且只连槽位粒子。
   * 之前用当前 pos 建拓扑 —— 那一刻粒子还在环绕环上，拓扑是按"云团"连的；
   * 随后粒子飞进槽位，配对被拉成贯穿全屏的长直线（悬停截图实拍）。
   * 槽位目标静止 → 拓扑一次建立长期有效，连线始终是槽内短网。 */
  let cand2;
  if (anySlot) {
    const ids = [];
    for (let i = P.nS; i < P.n; i++) if (P.dynMode[i] === 1) ids.push(i);
    cand2 = gridCandidates(P.dynTarget, new Int32Array(ids), 0.45);
  } else {
    cand2 = gridCandidates(P.pos, P.dynIds, 16);
  }
  const room = L.maxCap - cap;
  const cap2 = Math.min(cand2.length, room);
  for (let k = 0; k < cap2; k++) { L.pairs[(cap + k) * 2] = cand2[k][1]; L.pairs[(cap + k) * 2 + 1] = cand2[k][2]; }
  L.cap = cap + cap2;
  for (let t = 1; t < TYPES.length; t++) P.links[t].cap = 0;
}

/* ---------- 形态目标计算（每次重组随机形变参数 → 动态差异化） ---------- */
const shapeState = { cur: 'sphere', morphT: 99, seed: Math.random(), autoMorph: true, timer: 0, interval: 9 };

/* ---------- 呼吸感：周期性逆引力脉冲 ----------
 * 所有粒子作为整体：相位驱动一个全局径向外推力，与弹簧向心引力对抗，
 * 整群像肺一样膨胀-收缩。包络用 |sin|^0.72 整形 —— 顶点/谷底停留
 * （吸气末、呼气末柔和），中段切换快，接近真实呼吸节律。
 */
const breath = { level: 0.65, phase: 0, env: 0, rate: 0.55, _last: 0.65 };
function breathEnvelope(p) {
  const s = Math.sin(p);
  return Math.sign(s) * Math.pow(Math.abs(s), 0.72);
}

function computeTargets(time) {
  const n = P.n, T = P.target, id = shapeState.cur;
  const seed = shapeState.seed;

  if (id === 'sphere') {
    T.set(P.sphereTargets);
  } else if (id === 'torus') {
    // 五色分段沿管长分布；主/次半径、倾角随重组 seed 变化
    const R1 = 15 + seed * 4, R2 = 5.0 + (seed * 7.71 % 1) * 1.6;
    const ct = Math.cos(0.45 + seed * 0.5), st = Math.sin(0.45 + seed * 0.5);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const u = (P.ptype[i] * 0.2 + P.pu[i] * 0.2) * TAU * 3 + seed * 0.4;
      const v = P.pv[i] * TAU + seed * TAU;
      const cx = (R1 + R2 * Math.cos(v)) * Math.cos(u);
      const cz = (R1 + R2 * Math.cos(v)) * Math.sin(u);
      const cy = R2 * Math.sin(v);
      T[i3] = cx;
      T[i3 + 1] = cy * ct - cz * st;
      T[i3 + 2] = cy * st + cz * ct;
    }
  } else if (id === 'galaxy') {
    // 五条旋臂 = 五种硬件类型；旋向/缠绕度随 seed 变化
    const dir = seed > 0.5 ? 1 : -1;
    const spin = 1.6 + (seed * 3.31 % 1) * 1.3;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const t01 = P.pu[i];
      const r = 2.5 + t01 * 20.5;
      const arm = P.ptype[i];
      const ang = arm * TAU / 5 + dir * t01 * spin * Math.PI + (P.pr1[i] - 0.5) * 0.55;
      const y = (P.pr2[i] - 0.5) * 2.4 * (1.25 - t01);
      T[i3] = r * Math.cos(ang);
      T[i3 + 1] = y;
      T[i3 + 2] = r * Math.sin(ang);
    }
  } else if (id === 'wave') {
    // 五列分区网格；频率/振幅随 seed，整体随时间涟漪
    const cols = Math.max(10, Math.ceil(Math.sqrt(n * 1.7)));
    const rows = Math.max(2, Math.ceil(n / cols));
    const cols5 = Math.max(1, Math.floor(cols / 5));
    const f = 0.30 + seed * 0.22;
    const amp = 2.0 + (seed * 5.17 % 1) * 1.2;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const col = P.ptype[i] * cols5 + Math.floor(P.pu[i] * cols5);
      const row = Math.floor(P.pv[i] * rows);
      const gx = col / (cols - 1) - 0.5;
      const gz = row / (rows - 1) - 0.5;
      const x = gx * 36, z = gz * 36;
      const y = Math.sin(x * f + time * 1.25) * amp + Math.cos(z * f * 1.15 + time * 1.0) * amp * 0.8;
      T[i3] = x;
      T[i3 + 1] = y;
      T[i3 + 2] = z;
    }
  } else {
    // sculpture：无固定目标，纯引力雕塑（目标跟随当前位置，仅用于连线拓扑）
    T.set(P.pos);
  }
}

function morphTo(id, silent) {
  shapeState.cur = id;
  shapeState.seed = Math.random();
  shapeState.morphT = 0;
  if (SHAPE_PHI[id] !== undefined) cam.tPhi = SHAPE_PHI[id];
  computeTargets(time);
  rebuildLinks();
  updateShapeUI();
  if (!silent) toast('形态重组 → ' + SHAPE_NAMES[id]);
}
function nextShape(silent) {
  const i = SHAPE_ORDER.indexOf(shapeState.cur);
  morphTo(SHAPE_ORDER[(i + 1) % SHAPE_ORDER.length], silent);
}

/* ============================================================
 * 粒子 UI 组件系统 —— UI 从粒子中涌现（文档 §1 世界观 + §3 状态机）
 *
 * 原理：离屏 Canvas 2D 绘制 UI 组件（R 通道编码角色）→ 像素采样
 *      得到目标点云 → 保序配对分配给粒子 → 弹簧引力把粒子拉到
 *      目标点，视觉上即「粒子组成了 UI」。
 *
 * 状态机：idle → converging（向核心收拢再展开到 UI）→ active
 *         （可交互）→ dissolving（化回粒子）→ idle
 *
 * 交互：点击输入框聚焦后可直接打字（粒子实时重组文字）；
 *       点击 checkbox 切换勾选；按钮有 hover/press 反馈；
 *       Enter 唤出面板，Esc/取消/关闭 化回粒子。
 * ============================================================ */
const UI_W = 760, UI_H = 490, UI_S = 0.144; // 逻辑分辨率（y 向下）+ 世界/像素缩放
/* v0.10 整体放大（用户："至少还得加一倍的尺寸"）的实现方式：
 * 世界坐标 ×2（UI_S 0.072→0.144）+ 相机距离 55→48 ——
 * 屏幕上文字尺寸 ×2.62、粒子笔画粗细 ×2.29、1000 骨架粒子的密度
 * 基本不变；代价是面板占屏 ~137%（上下左右边缘少量裁切），
 * 故布局元素同步收进可见区（UI x∈[103,657] / y∈[71,418]）。 */
/* v0.14 字体工程（用户诊断：「能不能看清主要取决于笔画之间的空隙和粒子
 * 坐标的偏移以及光晕大小，所以需要找一个很瘦的字」——诊断正确）。
 * 量化依据（.tmp/fontprobe.html：用生产同款采样算法把候选字体点阵化）：
 *   · 微软雅黑 400 / SimHei：笔画 3.0 UI px ÷ 点距 2.5 = 1.2 格，且 4 邻域
 *     连通度 2.6~3.0 → 每个笔画横截面占 2 格 = 字怀被吃掉，「糊成块」；
 *   · 等线 Light (DengXian Light)：笔画 2.0 ÷ 2.5 = 0.8 格，连通度 2.1~2.3
 *     → 笔画恰 1 格、字怀留 1 格暗缝 = 能分辨的 16~20 格点阵汉字。
 * 故中文用等线 Light，西文用 Bahnschrift Light（可变字重 + 窄字宽）。
 * 另加字距 UI_TRACK：汉字是全角紧贴，字与字之间默认 0 空隙，视觉上
 * 两个字的笔画会并成一团；插入 1 格间距后字独立可辨（LED 点阵屏做法）。 */
let UI_FONT = '"DengXian Light","Microsoft YaHei Light","Microsoft YaHei","PingFang SC",sans-serif';
let UI_FONT_LAT = 'Bahnschrift Light,Bahnschrift,Candara,"Segoe UI",sans-serif';
let UI_TRACK = 2.5;   // UI px 字距（= 1 格）：汉字之间留一格暗缝
const uiCanvas = document.createElement('canvas');
uiCanvas.width = UI_W; uiCanvas.height = UI_H;
const uiCtx = uiCanvas.getContext('2d', { willReadFrequently: true });

/* 角色编码：绘制时写入 R 通道（role*30），采样时读回 */
const ROLE = { title: 1, input: 2, check: 3, mark: 4, btn: 5, sub: 6, caret: 7, close: 8 };
const ROLE_NAMES = ['', '标题', '输入框', '勾选框', '勾', '按钮', '辅助文字', '光标', '关闭'];

/* hit 区域（UI 坐标）。前 6 项为可交互组件；title/sub 仅作增援热区。
 * v0.10 特大字版：世界 ×2 + 机位 48 → 面板占屏 137%，元素收进可见区
 * （UI x∈[103,657] / y∈[71,418]）：标题/副标题下移，输入框与勾选右收，
 * 按钮上移，关闭钮从屏外 x692 移入 x596，底部提示删除（出画） */
/* v0.13 布局：面板 137% 出画是全出血构图，但**可交互元素必须完整落在
 * 可见区** x∈[119,641] / y∈[81,409]（v0.12 的「确认」压在「静默模式」
 * 上、按钮被下边缘切掉都是因为这个区太挤）。重排：标题下移露出字头，
 * 两个勾选各占 44px 行，按钮下移到 352 且宽 240（不再贴边被裁）。 */
/* v0.14 布局：字号全面上调（点阵可读性 = 每个字占多少格）——
 *   标题 72 / 输入 46 / 勾选标签 44 / 按钮 44 / 副标 26（UI px）
 * 换算成点阵格数（cell 2.5）：46px→18 格、44px→17.6 格、32px 时代仅 12.8 格。
 * 汉字点阵的行业下限是 16×16，12 格必然糊成一团（这正是 v0.13 的症结）。
 * 竖向预算（可见区 y∈[81,409]）：标题 84~147 / 副标 154~178 /
 *   输入框 184~246 / 勾选 252~344 / 按钮 350~404。 */
const UI_RECTS = [
  { id: 'input',  x: 130, y: 184, w: 500, h: 62 },
  { id: 'check0', x: 130, y: 252, w: 250, h: 46 },
  { id: 'check1', x: 130, y: 298, w: 250, h: 46 },
  { id: 'ok',     x: 130, y: 350, w: 240, h: 54 },
  { id: 'cancel', x: 390, y: 350, w: 240, h: 54 },
  { id: 'close',  x: 596, y: 84,  w: 44,  h: 44 },
  { id: 'title',  x: 130, y: 76,  w: 500, h: 76 },
  { id: 'sub',    x: 200, y: 152, w: 360, h: 28 },
];

const ui = {
  mode: 'idle',        // idle | converging | active | dissolving
  t: 0,
  text: '',            // 输入框文字
  checks: [false, false],
  focus: null,         // 'input' | null
  hover: null,         // 组件 id（增援目标）
  press: null, pressT: 0,
  preShape: 'sphere',  // 进入 UI 前的形态（ dissolving 回到它）
  forceHover: null,    // 强制悬停（自检/深链用；null = 跟随真实指针）
  reinforceFill: 0,    // 增援填充率（0~1）：槽位粒子数 / 增援总数
};

function uiFill(role, a) { uiCtx.fillStyle = 'rgba(' + (role * 30) + ',255,255,' + (a === undefined ? 1 : a) + ')'; }
function uiStroke(role, a) { uiCtx.strokeStyle = 'rgba(' + (role * 30) + ',255,255,' + (a === undefined ? 1 : a) + ')'; }
function uiRoundRect(x, y, w, h, r) {
  const c = uiCtx;
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* —— 单组件绘制（可单独采样：增援粒子倾泻到某个控件时用） ——
 * v0.10 特大字版：标题 76px / 输入框文字 26px / 按钮 24px / 勾选标签 20px。
 * 屏幕上文字尺寸 = 字号 × UI_S(0.144) × (屏高/可见世界高)，笔画粗细 ×~2.3。
 * v0.11 清晰度工程（用户诊断「字号与粒子漂移的比例关系才是根本，体感糊」）：
 * 实测糊的根源不是漂移（骨架偏差仅 1.1px）而是**粒子光斑远大于笔画宽度**
 * （v0.10：输入框边框 6.2 屏px vs 骨架光斑 41.4 屏px = 6.7 倍溢出，相邻
 * 笔画的光斑互相渗透成团）。解决：以粒子尺寸为设计基准反推笔画宽度——
 * 骨架粒子 2.3→1.4 世界（41→25 屏px），所有 canvas 线宽/文字描边加粗到
 * ≥0.85× 光斑（≥21 屏px）：边框 2.4→6.5、文字加同色描边（霓虹字做法，
 * 笔画向两侧扩宽描边半宽，采样角色不变——stroke 与 fill 同 R 通道）。 */
/* v0.14：字距（letterSpacing）—— 汉字全角紧贴，字与字之间默认没有暗缝，
 * 相邻两字的笔画在点阵上会连成一片。插入 1 格字距后每个字成为独立点阵块。
 * 注意 textAlign='center' 时 Chrome 会把尾随字距算进宽度 → 视觉左偏半格，
 * 故 x 补偿 -UI_TRACK/2。绘制后重置，避免影响后续 measureText（光标位置）。 */
function uiText(role, alpha, font, text, x, y, align, strokeW) {
  const c = uiCtx;
  const hasTrack = 'letterSpacing' in c;
  c.textAlign = align;
  c.textBaseline = 'middle';   // v0.14：竖向按字形中心对齐，行内排版不用猜 ascent
  c.font = font;
  if (hasTrack) c.letterSpacing = UI_TRACK + 'px';
  const dx = (hasTrack && align === 'center') ? -UI_TRACK / 2 : 0;
  if (strokeW) { // 先描边后填充：同色同 alpha，仅把笔画加宽（R 通道角色不变）
    uiStroke(role, alpha);
    c.lineWidth = strokeW;
    c.lineJoin = 'round';
    c.strokeText(text, x + dx, y);
  }
  uiFill(role, alpha);
  c.fillText(text, x + dx, y);
  if (hasTrack) c.letterSpacing = '0px';
}
/* v0.14 全部文字 **不加描边**（strokeW=0）：等线 Light 在 44~46px 时笔画
 * 恰好 2.0 UI px（=0.8 格），是「笔画占 1 格」的最优宽度；v0.11 时代为了
 * 对抗 41 屏px 的大光斑加过 2.5~3px 描边，那会让笔画变成 5px ≈ 2 格 →
 * 直接把字怀填死（这是「糊」的另一半）。 */
function drawTitle() {
  uiText(ROLE.title, 1, '300 72px ' + UI_FONT_LAT, 'Olares', UI_W / 2, 114, 'center', 0);
}
function drawSub() {
  uiText(ROLE.sub, 0.85, '38px ' + UI_FONT, '社区版·涌现式控制台', UI_W / 2, 164, 'center', 0);
}
function drawInput() {
  const c = uiCtx;
  const inp = UI_RECTS[0];
  const focusIn = ui.focus === 'input';
  uiRoundRect(inp.x, inp.y, inp.w, inp.h, 16);
  uiStroke(ROLE.input, focusIn ? 1 : 0.72);
  c.lineWidth = focusIn ? 3.4 : 2.2; // 0.88~1.36 格：普通 1 排点，聚焦 1.4 排（加亮不加粗）
  c.stroke();
  uiText(ROLE.input, ui.text ? 0.95 : 0.5, '46px ' + UI_FONT,
         ui.text || '输入指令…', inp.x + 26, inp.y + inp.h / 2, 'left', 0);
  // 光标（闪烁由粒子侧亮度实现，canvas 内常驻锚定）
  if (focusIn) {
    const cw = c.measureText(ui.text).width;
    uiFill(ROLE.caret, 0.95);
    c.fillRect(inp.x + 27 + cw, inp.y + 11, 5, inp.h - 22);
  }
}
function drawCheck(i) {
  const c = uiCtx;
  const r = UI_RECTS[1 + i];
  const bx = r.x + 16, by = r.y + (r.h - 34) / 2;
  uiRoundRect(bx, by, 34, 34, 8);
  uiStroke(ROLE.check, 0.85);
  c.lineWidth = 2.2; // 0.88 格：图框恰 1 排点（3.2 会跨 2 格 = 重影）
  c.stroke();
  uiText(ROLE.check, 0.85, '44px ' + UI_FONT,
         i === 0 ? '开机自启' : '静默模式', bx + 48, r.y + r.h / 2, 'left', 0);
  if (ui.checks[i]) {
    uiStroke(ROLE.mark, 1);
    c.lineWidth = 3.2;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(bx + 7, by + 18);
    c.lineTo(bx + 14, by + 27);
    c.lineTo(bx + 28, by + 8);
    c.stroke();
    c.lineCap = 'butt';
  }
}
function drawBtn(i) {
  const c = uiCtx;
  const b = UI_RECTS[3 + i];
  const hot = ui.hover === b.id || ui.press === b.id;
  uiRoundRect(b.x, b.y, b.w, b.h, b.h / 2);
  if (i === 0) { uiFill(ROLE.btn, hot ? 0.5 : 0.28); c.fill(); } // 主按钮微填充
  uiStroke(ROLE.btn, hot ? 1 : 0.68);
  c.lineWidth = hot ? 3.4 : 2.2;
  c.stroke();
  uiText(ROLE.btn, hot ? 1 : 0.82, '44px ' + UI_FONT,
         i === 0 ? '确认' : '取消', b.x + b.w / 2, b.y + b.h / 2, 'center', 0);
}
function drawClose() {
  const c = uiCtx;
  const cl = UI_RECTS[5];
  uiStroke(ROLE.close, ui.hover === 'close' ? 1 : 0.68);
  c.lineWidth = 3.0; // 斜线按面积折算偏细，比边框略粗
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(cl.x + 12, cl.y + 12); c.lineTo(cl.x + 34, cl.y + 34);
  c.moveTo(cl.x + 34, cl.y + 12); c.lineTo(cl.x + 12, cl.y + 34);
  c.stroke();
  c.lineCap = 'butt';
}
/* 组件 id → 单组件绘制函数（增援倾泻采样用） */
const UI_DRAW = {
  title: drawTitle, sub: drawSub, input: drawInput,
  check0: () => drawCheck(0), check1: () => drawCheck(1),
  ok: () => drawBtn(0), cancel: () => drawBtn(1), close: drawClose,
};

/* 把当前 UI 状态画到离屏 canvas */
function uiDraw() {
  const c = uiCtx;
  c.clearRect(0, 0, UI_W, UI_H);
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  drawTitle(); drawSub(); drawInput();
  drawCheck(0); drawCheck(1);
  drawBtn(0); drawBtn(1);
  drawClose();
}

/* 采样当前离屏画面 → 候选点云（返回 [x, y, role] 三元组数组）。
 * v0.11 清晰度工程（根治「糊」）：笔画加粗后，细步长扫描会在笔画**横截面**上
 * 采到多个点（8.5 UI px 宽的笔画 × STEP 1.0 → 每横截面 8-9 个点），而粒子
 * 光斑只需每横截面 1 个点——横截面冗余叠加即"亮浆糊团"（v0.11 截图实拍：
 * demo 糊成无结构亮斑）。故按 CELL 网格抽稀：每个 CELL×CELL 网格只保留
 * 第一个命中点 → 粒子间距 ≈ CELL ≈ 光斑直径（单层排列，无横截面冗余）。
 * v0.11d：cell 5 + 光斑 13px 时文字区"相切实心化"——点距=光斑的点阵填满
 * 字母 = 实心亮块（park 态截图实拍：占位符/demo 均成亮团，而边框/标题因
 * 是一维线条依然干净）。故文字可辨的条件是**点间距 > 光斑**（点间有暗缝，
 * 字形由点的空间 pattern 决定）：cell 5→4.5、骨架光斑 13→9 屏px；增援容量
 * 按控件类型差异化（线条类 0.75 加密连续 / 文字类 0.30 只轻补、其余外扩
 * 成光晕——悬停强调外形，文字保持单层点阵始终清晰）。
 * v0.13：把「点距必须 > 光斑」这条 v0.11 的结论修正为「点距 ≈ 光斑
 * 的 0.85~0.9 倍」——v0.11 要留暗缝是因为当时光斑 13 屏px 相对笔画过粗，
 * 点阵填满就把字母内部（字怀）也糊掉了；v0.10 字号 ×2.6 后光斑只占笔画
 * 一小部分，而采样只取**笔画像素**（字怀/字间距本来就不产点），所以点
 * 相切只会把笔画连成亮线，字怀依旧是暗的 → 既连续又可辨（截图实测）。
 * 反之点距 > 光斑（v0.12 的 4.6 vs 4.03）在 2.6 倍大的字上就表现为
 * 「笔画断成虚线」= 用户看到的「断」。 */
let SCAN_CELL = 2.5;     // 骨架抽稀网格（UI px）≈ 有效点距；< 光斑 2.4 → 相切连续
let SCAN_CELL_R = 1.4;   // 增援抽稀网格（UI px）：悬停控件槽位密度（(2.5/1.4)² ≈ 3 倍于骨架）
/* v0.14 格覆盖率阈值（取代 v0.13 的「格内任一像素 alpha>130」）。
 * 旧规则下 2.0~3.0 px 宽的笔画会同时点亮 2 个相邻格（横向 1.2 格 ≈ 2 格），
 * 字怀（笔画之间的空隙）被吃掉 —— 这就是「糊」的几何来源；而某些格又因
 * 抗锯齿边缘不到 130 而不亮，笔画随机断点。改用**覆盖率阈值化**（LED 点阵屏
 * 的栅格化规则）：格内 alpha 面积占比 ≥ SCAN_TH 才点亮。0.45 时
 *   等线 Light 48px：笔画 2.0px → 中心格覆盖率 0.80（亮）、相邻格 0.20（灭）
 *   → 每个笔画横截面恒为 1 格，笔画之间恒留 1 格暗缝（点阵字可辨的定义）。 */
let SCAN_TH = 0.45;
let SCAN_NOLINK = false;   // 调试：?nolink=1 关闭连线（对照实验）
function uiScanPixels(cell = SCAN_CELL) {
  const d = uiCtx.getImageData(0, 0, UI_W, UI_H).data;
  const W = UI_W, H = UI_H, S = W + 1;
  // alpha（及 alpha×R 角色）积分图：一次 O(W·H) 建表，之后每格覆盖率 O(1)
  // 几何用**二值掩膜**积分图（alpha>90 记为墨），亮度不参与判定：
  // 否则占位符（alpha 0.42）的覆盖率会被亮度压低到阈值以下 → 整片消失。
  // 角色仍用 alpha 加权（区分同格内不同控件）。
  const A_MIN = 90;
  const sat = new Float32Array(S * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0;
    const cur = (y + 1) * S, prev = y * S, row = y * W;
    for (let x = 0; x < W; x++) {
      if (d[(row + x) * 4 + 3] > A_MIN) rs += 1;
      sat[cur + x + 1] = sat[prev + x + 1] + rs;
    }
  }
  const pts = [];
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.min(H, Math.round(cy * cell)), yy1 = Math.min(H, Math.round((cy + 1) * cell));
    if (yy1 <= y0) continue;
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.min(W, Math.round(cx * cell)), xx1 = Math.min(W, Math.round((cx + 1) * cell));
      if (xx1 <= x0) continue;
      const s00 = sat[y0 * S + x0], s10 = sat[y0 * S + xx1];
      const s11 = sat[yy1 * S + xx1], s01 = sat[yy1 * S + x0];
      const sum = s11 - s10 - s01 + s00;
      const area = (xx1 - x0) * (yy1 - y0);
      if (sum / area < SCAN_TH) continue;   // 覆盖率不足 → 该格不亮
      /* 角色取格内**最不透明的那个像素**的 R 值（=role×30）。
       * 不能用均值：早先版本「除以墨点数、却按 alpha 加权」→ 读成 R·mean(α)，
       * 90 读成 77、240 读成 204，角色整体错位（全部粒子被判成「关闭」，
       * 于是全屏连线）。笔画核心像素的 alpha 是满的、R 必然精确。 */
      let bestA = -1, role = 1;
      for (let y = y0; y < yy1; y++) {
        for (let x = x0; x < xx1; x++) {
          const o = (y * W + x) * 4, a = d[o + 3];
          if (a > bestA) { bestA = a; role = Math.round(d[o] / 30); }
        }
      }
      role = Math.max(1, Math.min(8, role));
      pts.push((cx + 0.5) * cell, (cy + 0.5) * cell, role); // 格心落位、零抖动
    }
  }
  return pts;
}

/* 采样 UI 像素 → 目标点云 → 保序配对写入静态骨架层的 P.target / P.uiRole */
function uiSample() {
  uiDraw();
  const pts = uiScanPixels();
  const n = P.nS, M = pts.length / 3;
  // 诊断：候选槽位 vs 骨架粒子数 + 实际可见光斑（UI px）
  // v0.14 修正：Three 的 gl_PointSize = size×(屏高/2)/距，而透视投影下
  // 世界 1 单位 = (屏高/2)/(距·tan(fov/2)) 像素 → 点直径(UI px)
  // = size·tan(fov/2)/UI_S。旧式 (size/UI_S)×2 把 tan(fov/2)=0.52 当成 0.5
  // 再乘 2，实际高估 3.8 倍（之前一直用错的「光斑」在调参）。
  const spotUI = (s) => s * Math.tan(55 * Math.PI / 360) / UI_S;
  ui.lastScan = { M, n, cell: SCAN_CELL, spot: spotUI(P.matS.size) * 0.88 };
  // 等距抽样到 n 个目标点（保持扫描顺序 → 空间覆盖均匀）。
  // n > M 时（候选点比粒子还少，如 ?static= 设得很大）：轮转分摊，
  // 每个候选点分到 floor/ceil(n/M) 粒，第 2 层起加半格对角偏移 →
  // 均匀加密点阵；若直接重叠在同一点则只会变更亮、密度不涨。
  const picked = new Float32Array(n * 3);
  const per = n / M;
  /* v0.14：per < 1.6 时**不再**加半格对角偏移。v0.13 无条件分层（6800 对
   * 3377 槽 = 2 倍过采样）→ 一半粒子落在格间的半格位置，晶格被搅成 1.25px
   * 的伪网格：字能认出但「体感糊」。1:1 点阵屏的前提是**一格一点、格心对齐**；
   * 轻微过采样（3~20%）让多余粒子叠在格心（只是略亮），不再破坏晶格。 */
  for (let k = 0; k < n; k++) {
    const s = Math.min(M - 1, Math.floor(k / per));
    const layer = per >= 1.6 ? Math.min(3, Math.floor(k - s * per)) : 0;
    const o = layer * SCAN_CELL * 0.5; // UI px 对角偏移（仅真过采样时启用）
    picked[k * 3] = pts[s * 3] + o;
    picked[k * 3 + 1] = pts[s * 3 + 1] + o;
    picked[k * 3 + 2] = pts[s * 3 + 2];
  }
  // 保序配对：目标点按 (y,x) 排序，骨架粒子按 (-y,x) 排序（世界 y 向上）→ 顺序配对，
  // 粒子沿屏幕纵向“对号入座”，飞行交叉最少
  const tIdx = new Array(n);
  for (let k = 0; k < n; k++) tIdx[k] = k;
  tIdx.sort((a, b) => picked[a * 3 + 1] - picked[b * 3 + 1] || picked[a * 3] - picked[b * 3]);
  const pIdx = new Array(n);
  for (let k = 0; k < n; k++) pIdx[k] = k;
  pIdx.sort((a, b) => -P.pos[a * 3 + 1] + P.pos[b * 3 + 1] || P.pos[a * 3] - P.pos[b * 3]);
  for (let k = 0; k < n; k++) {
    const ti = tIdx[k], pi = pIdx[k], i3 = pi * 3;
    P.target[i3] = (picked[ti * 3] - UI_W / 2) * UI_S;
    P.target[i3 + 1] = -(picked[ti * 3 + 1] - UI_H / 2) * UI_S;
    P.target[i3 + 2] = picked[ti * 3 + 2] === ROLE.caret ? 0.6 : (Math.random() - 0.5) * 0.3;
    P.uiRole[pi] = picked[ti * 3 + 2];
  }
  // 增援层角色/模式清空（随后按悬停状态重新分配）
  for (let i = P.nS; i < P.n; i++) { P.uiRole[i] = 0; P.dynMode[i] = 0; }
  if (ui.mode === 'active' && ui.hover) assignReinforce(ui.hover);
  else rebuildUiLinks();
}

/* ---------- 增援粒子：倾泻到悬停控件 / 环绕光标 ---------- */

/* 增援粒子全部释放回环绕态 */
function releaseToOrbit() {
  for (let i = P.nS; i < P.n; i++) { P.dynMode[i] = 0; P.uiRole[i] = 0; }
  ui.reinforceFill = 0;
  rebuildUiLinks();
}

/* 增援粒子保序倾泻到指定控件的像素槽位。
 * 选取距控件中心最近的 useCount 个增援粒子获得槽位（云团内芯先固化），
 * 其余按填充率外扩成光晕；槽位点与粒子同按 (y,x) 排序 → 飞行交叉最少。 */
function assignReinforce(id) {
  const draw = UI_DRAW[id];
  if (!draw) { releaseToOrbit(); return; }
  uiCtx.clearRect(0, 0, UI_W, UI_H);
  draw();
  // 增援用**更细**的网格扫描（SCAN_CELL_R=2.0 vs 骨架 3.5）：悬停控件的
  // 槽位数 ×(3.5/2)²≈3 —— v0.12 用同一网格时 input 只有 ~812 槽，3500 增援
  // 里 2900 粒无处可去只能在鼠标周围空转（用户实拍）。槽位够了，粒子才
  // 真的"倾泻进去"而不是"绕着飞"。
  const pts = uiScanPixels(SCAN_CELL_R);
  uiDraw(); // 采样是破坏性的，恢复完整画面
  const M = pts.length / 3;
  if (M === 0) { releaseToOrbit(); return; }
  const nD = P.nD;
  /* v0.13 容量差异化：倾泻密度决定"悬停充能"的观感 ——
   * 线条类控件（input/check/btn/close，以边框+标签线为主）系数 0.95：
   *   增援加密笔画让边框连成实心亮带（线条是一维结构，越密越像"框"）；
   * 纯文字控件（title/sub）系数 0.60：大字号（76px）字怀足够宽，加密只把
   *   笔画加粗、字怀仍暗 → 悬停"充能"但不糊（0.30 时代太保守，鼠标周围
   *   仍留大片空转粒子）。 */
  /* v0.14 充能强度按「该控件以线条为主还是以文字为主」分档：
   *   纯线条（close）0.95 —— 加密就变成连续亮线，只会更"充电"；
   *   边框主导（input）0.95 —— 框大、字少，加密加在框上；
   *   图形+短标签（button）0.62 —— 2 个字，翻倍会变粗；
   *   图形+长标签（check 行）0.55 —— 4 个汉字占绝大多数点位，0.95 会把
   *     标签灌成 2 倍密度 = 又糊回去（悬停截图实测）；
   *   纯文字（title/sub）0.45 —— 只轻微提亮 + 其余外扩成光晕。 */
  const capK = id === 'close' ? 0.95 : id === 'input' ? 0.95
    : (id === 'ok' || id === 'cancel') ? 0.62
    : (id === 'check0' || id === 'check1') ? 0.55 : 0.45;
  const useCount = Math.min(nD, Math.ceil(M * capK));
  ui.lastAssign = { id, M, useCount, nD }; // 诊断（自检/调试用）
  const rect = UI_RECTS.find((r) => r.id === id);
  const cx = (rect.x + rect.w / 2 - UI_W / 2) * UI_S;
  const cy = -(rect.y + rect.h / 2 - UI_H / 2) * UI_S;
  // 槽位点按 (y,x) 排序
  const tIdx = new Array(M);
  for (let k = 0; k < M; k++) tIdx[k] = k;
  tIdx.sort((a, b) => pts[a * 3 + 1] - pts[b * 3 + 1] || pts[a * 3] - pts[b * 3]);
  // 增援粒子按到控件中心的距离升序（近者先获得槽位）
  const dynIdx = new Array(nD);
  for (let k = 0; k < nD; k++) dynIdx[k] = k;
  const dpos = P.pos;
  dynIdx.sort((a, b) => {
    const ia = P.nS + a, ib = P.nS + b;
    const da = (dpos[ia * 3] - cx) ** 2 + (dpos[ia * 3 + 1] - cy) ** 2;
    const db = (dpos[ib * 3] - cx) ** 2 + (dpos[ib * 3 + 1] - cy) ** 2;
    return da - db;
  });
  for (let k = 0; k < useCount; k++) {
    const pi = P.nS + dynIdx[k], i3 = pi * 3;
    // 半格交错：增援落在骨架槽位之间的对角位 → 双层位置错开，
    // 不重叠成"双倍亮点"，而是均匀加密（点阵更实但仍可辨）
    const s = Math.min(M - 1, ((k + 0.5) * M / useCount) | 0);
    const t = tIdx[s] * 3;
    P.dynTarget[i3] = (pts[t] - UI_W / 2) * UI_S + SCAN_CELL_R * UI_S * 0.5;
    P.dynTarget[i3 + 1] = -(pts[t + 1] - UI_H / 2) * UI_S + SCAN_CELL_R * UI_S * 0.5;
    P.dynTarget[i3 + 2] = pts[t + 2] === ROLE.caret ? 0.6 : (Math.random() - 0.5) * 0.5;
    P.uiRole[pi] = pts[t + 2];
    P.dynMode[pi] = 1;
  }
  for (let k = useCount; k < nD; k++) {
    const pi = P.nS + dynIdx[k];
    P.dynMode[pi] = 0;
    P.uiRole[pi] = 0;
  }
  ui.reinforceFill = useCount / nD;
  rebuildUiLinks();
}

const PARK_CENTER = new THREE.Vector3(0, -42, 0); // 待机环中心（面板下方，不遮挡文字；随世界 ×2 等比下移）
const _v3 = new THREE.Vector3();
let loadAvg = 0.45; // 由 step() 每帧刷新（增援环绕速度用）

/* 增援层环绕态目标：绕 center 的公环（半径/初相/速度逐粒子随机 → 环带云团）。
 * rScale：填充率越低光晕越外扩（小控件只固化内芯，外围留出空间） */
function orbitAround(center, time, rScale) {
  const dynMode = P.dynMode, dynTarget = P.dynTarget, orbR = P.orbR, orbPh = P.orbPh, orbS = P.orbS;
  const spd = 0.65 + loadAvg * 0.45;
  for (let i = P.nS; i < P.n; i++) {
    if (dynMode[i] === 1) continue; // 槽位粒子目标已固定
    const i3 = i * 3;
    const a = time * spd * orbS[i] + orbPh[i];
    const rr = orbR[i] * rScale;
    dynTarget[i3] = center.x + Math.cos(a) * rr;
    dynTarget[i3 + 1] = center.y + Math.sin(a) * rr * 0.82;
    // z 偏负：光晕沉到面板（文字）后方，不干扰阅读（叠加混合下仅略变小）
    // z 偏负：光晕沉到面板（文字）后方，不干扰阅读（叠加混合下仅略变小）
    // v0.11：世界 ×2 后加深（-1.8→-3.5），确保拖尾彗光不掠过文字平面
    dynTarget[i3 + 2] = center.z - 3.5 + Math.sin(orbPh[i] * 2.9 + time * 0.45) * 1.2;
  }
}

/* 射线与 z=0 平面交点（UI 模式光标世界坐标） */
function uiMousePoint() {
  raycaster.setFromCamera(ndc, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  if (Math.abs(d.z) < 1e-6) return null;
  const tt = -o.z / d.z;
  if (tt <= 0) return null;
  return _v3.copy(o).addScaledVector(d, tt);
}

/* 每帧维护增援层目标（step 内调用）：
 * converging → 待机环；dissolving → 由溶解插值维护；
 * active → 悬停判定（变化时切换倾泻/释放）+ 环绕态跟随光标 */
function updateDynamicTargets(time) {
  if (ui.mode === 'dissolving') return;
  if (ui.mode === 'converging') { orbitAround(PARK_CENTER, time, 1.6); return; }
  const hov = ui.forceHover !== null ? ui.forceHover : (pointerActive ? uiPointer() : null);
  if (hov !== ui.hover) {
    ui.hover = hov;
    if (hov) assignReinforce(hov); else releaseToOrbit();
  }
  if (pointerActive) {
    const m = uiMousePoint();
    // 填充率越低 → 光晕越外扩（1 → 2.3）；射线平行面板时退回待机环
    orbitAround(m || PARK_CENTER, time, 1 + 1.3 * (1 - ui.reinforceFill));
  } else {
    orbitAround(PARK_CENTER, time, 1.4); // 指针离窗：缓慢待机环
  }
}

/* UI 坐标下的指针命中（射线与 z=0 平面求交 → UI 坐标 → rect 命中） */
function uiPointer() {
  raycaster.setFromCamera(ndc, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  if (Math.abs(d.z) < 1e-6) return null;
  const tt = -o.z / d.z;
  if (tt <= 0) return null;
  const p = o.clone().addScaledVector(d, tt);
  const ux = p.x / UI_S + UI_W / 2, uy = -p.y / UI_S + UI_H / 2;
  for (const r of UI_RECTS) {
    if (ux >= r.x && ux <= r.x + r.w && uy >= r.y && uy <= r.y + r.h) return r.id;
  }
  return null;
}

/* ---------- 状态机 ---------- */
function enterUI(silent) {
  if (ui.mode !== 'idle') return;
  ui.preShape = shapeState.cur;
  ui.mode = 'converging';
  ui.t = 0;
  shapeState.autoMorph = false; $('morphAuto').checked = false;
  shapeState.morphT = 0;      // 触发 flourish：先向核心收拢
  shapeState.timer = time;
  uiSample();                 // 静态骨架采样 + 增援层清空 + 双层连线
  /* UI 模式渲染调校（v0.13）：骨架光斑 0.58 世界（4.03 UI px）与点距
 * SCAN_CELL 3.5 UI px 互为基准 → 点距/光斑 = 0.87，点与点相切重叠
 * （笔画连续可辨），光斑仍远小于笔画宽（边框 6.5 / 文字描边 4-6 UI px）
 * 与字怀宽度 → 不溢出成糊块；增援 0.45（更细光尘，叠加充能）。 */
  cam.tRadius = 48; cam.tPhi = 1.52; cam.tTheta = 0.05;
  /* v0.13 关键（「断」的物理根因）：Three.js 点精灵的像素尺寸是
   * gl_PointSize = size × (屏高/2) / 距机位距离 —— **不含 fov 修正**，
   * 所以同样"世界尺寸"的点实际只有透视四边形的一半。之前按世界单位
   * 推算的"光斑 4.03 UI px"其实只有 ~2.1 UI px 实芯，而点距 3.36 →
   * 视觉点距是光斑 1.6 倍 = 无论粒子加到多少都显"虚线"。故尺寸按
   * 实测校正 ×1.8 并配硬芯贴图：可见芯径 ≈3.4 UI px ≈ 点距 3.36 →
   * 相切连续；opacity 下调抵消叠加增亮。 */
  P.matS.size = UI_SIZE;    // 可见芯 ≈ 2.4 UI px（点距 2.4 → 相切）
  P.matD.size = UI_SIZE_D;  // 悬停槽位点距 ~1.4 UI px → 增援芯 ≈1.4，刚好填缝
  P.matS.map = glowTexHard; P.matS.needsUpdate = true;
  P.matD.map = glowTexHard; P.matD.needsUpdate = true;
  P.matS.opacity = UI_OPS;
  P.matD.opacity = UI_OPS_D;
  document.body.classList.add('ui-mode');
  if (!silent) toast('Converging · 粒子凝聚中');
}
function exitUI(silent) {
  if (ui.mode === 'idle') return;
  P.matS.size = 0.55; P.matD.size = 0.55; // 还原自由形态的粒子尺寸
  P.matS.map = glowTex; P.matD.map = glowTex;   // 还原软光晕（星云质感）
  P.matS.opacity = 1; P.matD.opacity = 1;
  P.matS.needsUpdate = true; P.matD.needsUpdate = true;
  // 溶解起点：骨架从 UI 目标出发；增援从当前位置出发（它们可能正在环绕/槽位上）
  P.dissolveFrom.set(P.target);
  for (let i = P.nS * 3; i < P.n * 3; i++) P.dissolveFrom[i] = P.pos[i];
  shapeState.cur = ui.preShape;
  shapeState.seed = Math.random();
  computeTargets(time);
  P.dissolveTo.set(P.target);
  ui.mode = 'dissolving';
  ui.t = 0;
  ui.focus = null; ui.hover = null; ui.press = null;
  document.body.classList.remove('ui-mode');
  if (!silent) toast('Dissolving · 粒子化回收');
}
function uiConfirm() {
  const txt = ui.text.trim();
  toast(txt ? '已确认 · 「' + txt + '」' : '已确认 · 粒子化回收');
  exitUI(true);
}
function uiHit(id) {
  ui.press = id; ui.pressT = 0.35;
  pulse = { p: pointerShellPoint(), power: 55, life: 0.4 };
  if (id === 'input') { ui.focus = 'input'; }
  else if (id === 'check0') { ui.checks[0] = !ui.checks[0]; uiSample(); toast('开机自启 · ' + (ui.checks[0] ? '开' : '关')); }
  else if (id === 'check1') { ui.checks[1] = !ui.checks[1]; uiSample(); toast('静默模式 · ' + (ui.checks[1] ? '开' : '关')); }
  else if (id === 'ok') { uiConfirm(); }
  else if (id === 'cancel' || id === 'close') { exitUI(); }
  markInput();
}

/* ---------- 模拟遥测 ---------- */
const tel = { auto: true, load: 0.45, temp: 0.35 };
const typeState = TYPES.map((_, i) => ({ load: 0.4, temp: 0.35, ph: i * 1.37 + 0.5 }));

function updateTelemetry(time) {
  if (tel.auto) {
    for (let t = 0; t < TYPES.length; t++) {
      const s = typeState[t];
      s.load = clamp(0.5 + 0.38 * Math.sin(time * 0.21 + s.ph) + 0.16 * Math.sin(time * 0.57 + s.ph * 2.3), 0.04, 0.96);
      s.temp = clamp(0.20 + s.load * 0.60 + 0.12 * Math.sin(time * 0.08 + s.ph * 1.7), 0.05, 1.0);
    }
  } else {
    for (let t = 0; t < TYPES.length; t++) {
      const s = typeState[t];
      s.load = clamp(tel.load * TYPES[t].factor, 0.02, 1);
      s.temp = clamp(tel.temp, 0.02, 1);
    }
  }
}

/* ---------- 指针交互（引力井 / 脉冲） ---------- */
const ndc = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();
let pointerActive = false, dragging = false, lastX = 0, lastY = 0, pulse = null;
const cam = { theta: 0.7, phi: 1.32, radius: 80, tTheta: 0.7, tPhi: 1.32, tRadius: 80 };
let linksOn = true;

function pointerShellPoint() {
  raycaster.setFromCamera(ndc, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  const tt = -o.dot(d) / d.dot(d);
  const p = o.clone().addScaledVector(d, tt);
  if (p.lengthSq() < 1e-6) p.set(0, 0, 1);
  return p.normalize().multiplyScalar(R * 1.02);
}

canvas.addEventListener('pointermove', (e) => {
  ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  pointerActive = true;
  markInput();
  if (ui.mode === 'active') {
    /* UI 模式：hover 的"变化检测 → 倾泻/释放"由 updateDynamicTargets 统一驱动。
     * 这里若直接写 ui.hover，会与帧内的变化检测互相抵消 → 增援层永不倾泻
     * （v0.8 真实交互 bug：鼠标划过控件无任何增援反应）。
     * 深链的 forceHover 在首次真实移动时交权给指针。 */
    if (ui.forceHover !== null) ui.forceHover = null;
    canvas.style.cursor = uiPointer() ? 'pointer' : 'default';
    return;
  }
  canvas.style.cursor = '';
  if (dragging) {
    cam.tTheta -= (e.clientX - lastX) * 0.005;
    cam.tPhi = clamp(cam.tPhi - (e.clientY - lastY) * 0.005, 0.3, Math.PI - 0.3);
    lastX = e.clientX; lastY = e.clientY;
  }
});
canvas.addEventListener('pointerdown', (e) => {
  lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  pointerActive = true;
  ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  if (ui.mode === 'active') {
    const hit = uiPointer();
    if (hit) { uiHit(hit); return; }   // 命中组件：走组件行为，不旋转/不强脉冲
  }
  dragging = true;
  pulse = { p: pointerShellPoint(), power: 150, life: 0.5 };
  markInput();
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointerleave', () => { pointerActive = false; dragging = false; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.tRadius = clamp(cam.tRadius * (1 + e.deltaY * 0.001), 42, 170);
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function updateCamera(dt) {
  const k = Math.min(1, dt * 6);
  cam.theta += (cam.tTheta - cam.theta) * k;
  cam.phi += (cam.tPhi - cam.phi) * k;
  cam.radius += (cam.tRadius - cam.radius) * k;
  const sp = Math.sin(cam.phi);
  camera.position.set(
    cam.radius * sp * Math.sin(cam.theta),
    cam.radius * Math.cos(cam.phi),
    cam.radius * sp * Math.cos(cam.theta)
  );
  camera.lookAt(0, 0, 0);
}

/* ---------- 每帧步进：引力 / 流场 / 形态 / UI 涌现 ---------- */
function step(dt, time) {
  updateTelemetry(time);
  shapeState.morphT += dt;
  if (shapeState.autoMorph && time - shapeState.timer > shapeState.interval) {
    shapeState.timer = time;
    nextShape(true);
  }

  // —— UI 状态机推进 ——
  if (ui.mode === 'converging') {
    ui.t += dt;
    if (ui.t > 1.25) { ui.mode = 'active'; toast('Active · 可交互'); }
  } else if (ui.mode === 'dissolving') {
    ui.t += dt;
    const e = ui.t / 1.1;
    const ev = e < 0.5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2; // easeInOutCubic
    for (let i = 0; i < P.n * 3; i++) {
      P.target[i] = P.dissolveFrom[i] + (P.dissolveTo[i] - P.dissolveFrom[i]) * ev;
      P.dynTarget[i] = P.target[i]; // 增援层跟随同一插值化回自由形态
    }
    if (ui.t >= 1.1) { ui.mode = 'idle'; morphTo(ui.preShape, true); }
  }
  if (ui.pressT > 0) { ui.pressT -= dt; if (ui.pressT <= 0) ui.press = null; }
  const uiMode = ui.mode !== 'idle';
  // UI 模式下 P.target 由采样/插值维护，跳过形态目标计算
  if (!uiMode) computeTargets(time);
  // 增援层目标（环绕光标 / 倾泻槽位 / 待机环）—— 每帧维护
  if (uiMode) updateDynamicTargets(time);

  // UI 模式基准温度（所有 UI 粒子共用；颜色=温度）
  let uiTempRef = tel.temp;
  if (tel.auto) {
    let s = 0;
    for (let t = 0; t < TYPES.length; t++) s += typeState[t].temp;
    uiTempRef = s / TYPES.length;
  }
  // UI 模式 calm 系数：骨架文字要稳定可读（呼吸/流场强衰减）；
  // 增援层保留更多活性（环绕流光 / 槽位微旋）
  // v0.9：骨架呼吸 0.25→0.07（文字几乎静置，抖动不再糊笔画）；
  //      增援槽位 0.45→0.12（槽位微旋同步减小，见 step 内 0.30→0.10）；
  //      环绕态也压小（0.85→0.6）：释放瞬间粒子不被呼吸/流场抛离文字区
  const calmS = ui.mode === 'active' ? 0.07 : (ui.mode === 'converging' ? 0.6 : 1); // 骨架
  const calmR = ui.mode === 'active' ? 0.12 : (ui.mode === 'converging' ? 0.85 : 1); // 增援·槽位
  const calmO = ui.mode === 'active' ? 0.6 : (ui.mode === 'converging' ? 1.0 : 1);  // 增援·环绕

  const n = P.n;
  const pos = P.pos, vel = P.vel, target = P.target;
  const phase = P.phase, ptype = P.ptype, colors = P.colors;
  const isDyn = P.isDyn, dynTarget = P.dynTarget, dynMode = P.dynMode;

  let loadSum = 0;
  for (let t = 0; t < TYPES.length; t++) loadSum += typeState[t].load;
  loadAvg = loadSum / TYPES.length;

  // 弹簧引力参数：负载 → 运动速度（高负载整群被更快、更紧地拉向目标）
  // UI 模式分层刚度：骨架 ×3.6（钉住不动，v0.9 从 ×3 提高）> 增援槽位 ×1.15 >
  // 增援环绕 ×0.9（v0.9 从 ×0.5 提高：环绕态也不能被流场吹散，否则粒子
  // 掠过文字区形成"暗带"干扰阅读——v0.9 实测 ×0.5 时流场可把粒子吹离 38px）
  const kBase = 5.0 + loadAvg * 8.0;
  let kS = kBase, cS = 2 * Math.sqrt(kBase) * 0.85;
  let kR = kS, cR = cS, kO = kS, cO = cS;
  if (uiMode) {
    kS = kBase * 3.6;  cS = 2 * Math.sqrt(kS) * 0.9;
    kR = kBase * 1.15; cR = 2 * Math.sqrt(kR) * 0.85;
    kO = kBase * 0.9;  cO = 2 * Math.sqrt(kO) * 0.85;
  }
  // 重组前 0.9s：向核心收拢（凝聚感）
  const flourish = Math.max(0, 1 - shapeState.morphT / 0.9);
  const sculpture = shapeState.cur === 'sculpture';

  // —— 呼吸：周期性逆引力脉冲（整群统一膨胀-收缩）——
  // 相位推进：负载低 → 深而慢（休眠呼吸）；负载高 → 浅而快（活跃）
  breath.phase += dt * (breath.rate + loadAvg * 0.5);
  breath.env = breathEnvelope(breath.phase);
  // 凝聚期间自动减弱，保证「向核心收拢」的可读性；UI 模式再按层衰减
  const breathAmp = breath.level * (1 - 0.45 * loadAvg) * (1 - 0.6 * flourish);
  breath.amp = breathAmp * calmS; // 供 HUD 着色复用（骨架层幅度）
  // 逆引力 = 沿径向（粒子→核心）外推，与向心引力对抗；分层幅度
  // 峰值位移 ≈ 4.6 * 幅度 单位（球体 R=26 时约 10% 半径膨胀）
  const antiGS = 4.6 * kS * breath.env * breathAmp * calmS;
  const antiGR = 4.6 * kR * breath.env * breathAmp * calmR;
  const antiGO = 4.6 * kO * breath.env * breathAmp * calmO;

  // 引力雕塑：两个环绕引力井
  const w1 = time * 0.22 + shapeState.seed * 6.28;
  const g1x = Math.cos(w1) * 11, g1y = Math.sin(w1 * 0.73) * 4.5, g1z = Math.sin(w1) * 11;
  const g2x = -g1x, g2y = -g1y, g2z = -g1z;

  camera.updateMatrixWorld();
  const pPoint = pointerActive ? pointerShellPoint() : null;

  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const t = ptype[i];
    const s = typeState[t];
    const dyn = isDyn[i] === 1;
    const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
    let fx = 0, fy = 0, fz = 0;

    // —— 分层参数选择：UI 模式骨架/增援分化；自由形态全体一致 ——
    let kk = kBase, cc = 2 * Math.sqrt(kBase) * 0.85, ag = antiGS, flowCalm = 1;
    if (uiMode) {
      if (!dyn) { kk = kS; cc = cS; ag = antiGS; flowCalm = 0.03; }              // 骨架：钉住（v0.9 流场再减半）
      else if (dynMode[i] === 1) { kk = kR; cc = cR; ag = antiGR; flowCalm = 0.12; } // 增援·槽位（v0.9 0.22→0.12）
      else { kk = kO; cc = cO; ag = antiGO; flowCalm = 0.30; }                   // 增援·环绕（v0.9 0.55→0.30）
    }

    // 呼吸逆引力：先于两个分支的积分施加，径向外推（整群统一，非逐粒子）
    if (ag !== 0) {
      const pr2v = px * px + py * py + pz * pz;
      if (pr2v > 0.6) {
        const pr = Math.sqrt(pr2v);
        fx += px / pr * ag;
        fy += py / pr * ag;
        fz += pz / pr * ag;
      }
    }

    if (sculpture) {
      // —— 引力雕塑：被更近的引力井捕获 + 中心斥力 + 绕 Y  swirl ——
      const d1x = g1x - px, d1y = g1y - py, d1z = g1z - pz;
      const d2x = g2x - px, d2y = g2y - py, d2z = g2z - pz;
      const dd1 = Math.sqrt(d1x * d1x + d1y * d1y + d1z * d1z) + 0.001;
      const dd2 = Math.sqrt(d2x * d2x + d2y * d2y + d2z * d2z) + 0.001;
      const g = (34 + s.load * 30) / (1 + Math.min(dd1, dd2) * 0.10);
      if (dd1 <= dd2) { fx += d1x / dd1 * g; fy += d1y / dd1 * g; fz += d1z / dd1 * g; }
      else { fx += d2x / dd2 * g; fy += d2y / dd2 * g; fz += d2z / dd2 * g; }
      const pr = Math.sqrt(px * px + py * py + pz * pz) + 0.001;
      const rep = 6.0 / (1 + pr * 0.18);
      fx += px / pr * rep; fy += py / pr * rep; fz += pz / pr * rep;
      fx += -pz * 0.055; fz += px * 0.055;
      const fr = Math.exp(-1.15 * dt);
      vel[i3] = vel[i3] * fr + fx * dt;
      vel[i3 + 1] = vel[i3 + 1] * fr + fy * dt;
      vel[i3 + 2] = vel[i3 + 2] * fr + fz * dt;
    } else {
      // —— 弹簧引力指向目标点（手写引力+阻尼）——
      // 目标源：UI 模式下骨架用 P.target（面板像素）、增援用 dynTarget
      // （环绕光标 / 控件槽位）；自由形态统一用 P.target
      // 注意用 += 累加：呼吸逆引力已在分支前施加，赋值会将其覆盖
      let tx, ty, tz;
      if (uiMode && dyn) { tx = dynTarget[i3]; ty = dynTarget[i3 + 1]; tz = dynTarget[i3 + 2]; }
      else { tx = target[i3]; ty = target[i3 + 1]; tz = target[i3 + 2]; }
      // 增援槽位微旋：绕槽位小半径公旋，保持"活性"又不糊（骨架不微旋 → 钉住）
      // v0.9：半径 0.30→0.10（文字清晰度优先），速度略降
      if (uiMode && dyn && dynMode[i] === 1) {
        const a = time * 0.8 + phase[i];
        tx += Math.cos(a) * 0.10;
        ty += Math.sin(a) * 0.10;
        tz += Math.sin(a * 0.73 + 1.3) * 0.08;
      }
      fx += kk * (tx - px) - cc * vel[i3];
      fy += kk * (ty - py) - cc * vel[i3 + 1];
      fz += kk * (tz - pz) - cc * vel[i3 + 2];
      if (flourish > 0) {
        fx -= px * 0.8 * flourish;
        fy -= py * 0.8 * flourish;
        fz -= pz * 0.8 * flourish;
      }
      // —— 全局平滑流场：相邻粒子受力一致，整群 coherent 起伏 ——
      // 负载 → 运动：强度与推进速率都随负载提高（高负载整群流动更急）
      // UI 模式分层衰减：骨架文字不能糊；增援保留流光活性
      const ff = (8 + loadAvg * 30) * flowCalm;
      const flowT = time * (0.10 + loadAvg * 0.16);
      fx += fbm(px * 0.045 + flowT, py * 0.045, pz * 0.045, 911) * ff;
      fy += fbm(py * 0.045 + 31.7, pz * 0.045, px * 0.045 + flowT, 433) * 0.7 * ff;
      fz += fbm(pz * 0.045 + 71.3, px * 0.045, py * 0.045 + flowT, 177) * ff;
      const fr = Math.exp(-0.22 * dt);
      vel[i3] = (vel[i3] + fx * dt) * fr;
      vel[i3 + 1] = (vel[i3 + 1] + fy * dt) * fr;
      vel[i3 + 2] = (vel[i3 + 2] + fz * dt) * fr;
    }

    // 速度封顶，防炸
    const v2 = vel[i3] * vel[i3] + vel[i3 + 1] * vel[i3 + 1] + vel[i3 + 2] * vel[i3 + 2];
    if (v2 > 3600) {
      const sc = 60 / Math.sqrt(v2);
      vel[i3] *= sc; vel[i3 + 1] *= sc; vel[i3 + 2] *= sc;
    }
    pos[i3] += vel[i3] * dt;
    pos[i3 + 1] += vel[i3 + 1] * dt;
    pos[i3 + 2] += vel[i3 + 2] * dt;

    // 颜色：温度驱动（色相冷→暖 / 亮度暗→亮 / 超温暗红闪烁），与负载、硬件类型均无关
    if (uiMode) {
      // UI 涌现模式：温度基色 × 角色亮度修正（标题/按钮/焦点提亮，辅助文字压暗）
      const role = P.uiRole[i];
      particleColor(uiTempRef, time, phase[i], breath.env, breath.amp || 0, _rgb);
      let m = 1;
      if (dyn && dynMode[i] === 0) {
        // 增援环绕态：备用能量光尘（微提亮 + 混白，与骨架区分）
        m = 0.92;
        for (let k2 = 0; k2 < 3; k2++) _rgb[k2] += (1 - _rgb[k2]) * 0.10;
      }
      else if (role === ROLE.title) m = 1.35;
      else if (role === ROLE.input) m = ui.focus === 'input' ? 1.30 : 0.85;
      else if (role === ROLE.mark) m = 1.25;
      else if (role === ROLE.btn) {
        // 确认在左（UI x<380）、取消在右（按该粒子实际目标源判断）
        const bx = (uiMode && dyn) ? dynTarget[i3] : target[i3];
        const isOk = bx < 0;
        const hot = ui.press ? ui.press === (isOk ? 'ok' : 'cancel')
                             : ui.hover === (isOk ? 'ok' : 'cancel');
        m = hot ? 1.45 : 1.0;
      }
      else if (role === ROLE.sub) m = 0.68;
      else if (role === ROLE.caret) m = 0.35 + 1.15 * (Math.sin(time * 5) > -0.2 ? 1 : 0.12);
      else if (role === ROLE.close) m = ui.hover === 'close' ? 1.4 : 0.9;
      for (let k = 0; k < 3; k++) colors[i3 + k] = Math.min(_rgb[k] * m, 1);
    } else {
      particleColor(s.temp, time, phase[i], breath.env, breathAmp, _rgb);
      colors[i3] = _rgb[0]; colors[i3 + 1] = _rgb[1]; colors[i3 + 2] = _rgb[2];
    }
  }

  // 指针引力井：整群被吸向指针（UI 模式关闭 —— 骨架钉住、增援由光标目标驱动）
  if (pPoint && !uiMode) {
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const dx = pPoint.x - pos[i3], dy = pPoint.y - pos[i3 + 1], dz = pPoint.z - pos[i3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 900 && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const f = (1 - d / 30) * (55 / (1 + d * 0.12)) * dt / d;
        vel[i3] += dx * f; vel[i3 + 1] += dy * f; vel[i3 + 2] += dz * f;
      }
    }
  }
  // 点击脉冲：从触点向外的冲击波（UI 模式仅增援层响应，骨架文字不晃）
  if (pulse) {
    const pp = pulse.p;
    const pw = pulse.power * (pulse.life / 0.5);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const w = uiMode ? (isDyn[i] ? 1 : 0.22) : 1;
      if (w === 0) continue;
      const dx = pos[i3] - pp.x, dy = pos[i3 + 1] - pp.y, dz = pos[i3 + 2] - pp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1600 && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const f = (1 - d / 40) * pw * w * dt / d;
        vel[i3] += dx * f; vel[i3 + 1] += dy * f; vel[i3 + 2] += dz * f;
      }
    }
    pulse.life -= dt;
    if (pulse.life <= 0) pulse = null;
  }

  markGeoDirty();

  // 连线：负载 → 密度 / 亮度
  if (uiMode) {
    // UI 涌现模式：全部粒子作为一组（links[0]），按目标近邻连成细神经网；
    // 颜色跟随 UI 基准温度色，亮度随负载
    const L = P.links[0];
    for (let t = 1; t < TYPES.length; t++) P.links[t].obj.visible = false;
    if (!linksOn || L.cap === 0) { L.obj.visible = false; return; }
    L.obj.visible = true;
    L.geo.setDrawRange(0, L.cap * 2); // v0.9 修复：此前 UI 分支从未设置 drawRange（停在 build 时的 0），连线实际不可见
    const lp = L.geo.attributes.position.array;
    for (let k = 0; k < L.cap; k++) {
      const a = L.pairs[k * 2] * 3, b = L.pairs[k * 2 + 1] * 3;
      const o6 = k * 6;
      lp[o6] = pos[a];         lp[o6 + 1] = pos[a + 1]; lp[o6 + 2] = pos[a + 2];
      lp[o6 + 3] = pos[b];     lp[o6 + 4] = pos[b + 1]; lp[o6 + 5] = pos[b + 2];
    }
    L.geo.attributes.position.needsUpdate = true;
    sampleTempColor(uiTempRef, _rgb);
    const lc = L.geo.attributes.color.array;
    for (let k = 0; k < L.cap; k++) {
      const o6 = k * 6;
      for (let m = 0; m < 2; m++) {
        lc[o6 + m * 3] = _rgb[0] * 0.40;
        lc[o6 + m * 3 + 1] = _rgb[1] * 0.40;
        lc[o6 + m * 3 + 2] = _rgb[2] * 0.40;
      }
    }
    L.geo.attributes.color.needsUpdate = true;
    L.mat.opacity = 0.07 + loadAvg * 0.13;
    return;
  }
  for (let t = 0; t < TYPES.length; t++) {
    const L = P.links[t];
    const s = typeState[t];
    L.obj.visible = linksOn;
    if (!linksOn || L.cap === 0) continue;
    const active = Math.min(L.cap, Math.floor(L.cap * (0.20 + s.load * 0.80)));
    L.geo.setDrawRange(0, active * 2);
    const lp = L.geo.attributes.position.array;
    for (let k = 0; k < active; k++) {
      const a = L.pairs[k * 2] * 3, b = L.pairs[k * 2 + 1] * 3;
      const o6 = k * 6;
      lp[o6] = pos[a];         lp[o6 + 1] = pos[a + 1]; lp[o6 + 2] = pos[a + 2];
      lp[o6 + 3] = pos[b];     lp[o6 + 4] = pos[b + 1]; lp[o6 + 5] = pos[b + 2];
    }
    L.geo.attributes.position.needsUpdate = true;
    // 连线色跟随该类型温度色（色相 = 温度，暗化 40% 避免抢戏）
    sampleTempColor(s.temp, _rgb);
    const lc = L.geo.attributes.color.array;
    for (let k = 0; k < active; k++) {
      const o6 = k * 6;
      for (let m = 0; m < 2; m++) {
        lc[o6 + m * 3] = _rgb[0] * 0.40;
        lc[o6 + m * 3 + 1] = _rgb[1] * 0.40;
        lc[o6 + m * 3 + 2] = _rgb[2] * 0.40;
      }
    }
    L.geo.attributes.color.needsUpdate = true;
    L.mat.opacity = 0.05 + s.load * 0.20;
  }
}

/* ---------- HUD ---------- */
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
let lastInput = performance.now();
function markInput() {
  lastInput = performance.now();
  document.body.classList.remove('dimmed');
}

TYPES.forEach((t, i) => {
  const div = document.createElement('div');
  div.className = 'bar';
  div.innerHTML = '<i id="swatch' + i + '"></i><span class="name">' + t.name +
    '</span><div class="track"><div class="fill" id="fill' + i + '"></div></div><span class="pv" id="pv' + i + '">0%</span>';
  $('bars').appendChild(div);
});

function setAuto(v) { tel.auto = v; $('auto').checked = v; }
function setAutoMorph(v) { shapeState.autoMorph = v; $('morphAuto').checked = v; }
$('load').addEventListener('input', (e) => { setAuto(false); tel.load = e.target.value / 100; $('loadV').textContent = e.target.value + '%'; });
$('temp').addEventListener('input', (e) => { setAuto(false); tel.temp = e.target.value / 100; $('tempV').textContent = e.target.value + '%'; });
$('breath').addEventListener('input', (e) => { breath.level = e.target.value / 100; $('breathV').textContent = e.target.value + '%'; });
$('auto').addEventListener('change', (e) => setAuto(e.target.checked));
$('morphAuto').addEventListener('change', (e) => setAutoMorph(e.target.checked));
$('links').addEventListener('change', (e) => { linksOn = e.target.checked; });
$('stars').addEventListener('change', (e) => { stars.visible = e.target.checked; });
document.querySelectorAll('.shapes button').forEach((b) => {
  b.addEventListener('click', () => { setAutoMorph(false); morphTo(b.dataset.s, false); });
});
$('uiBtn').addEventListener('click', () => enterUI());
let paused = false;
function togglePause() {
  paused = !paused;
  $('pause').textContent = paused ? '继续' : '暂停';
}
$('pause').addEventListener('click', togglePause);
window.addEventListener('keydown', (e) => {
  if (ui.mode !== 'idle') {
    // UI 涌现模式：只响应 UI 相关按键（打字时空格/数字不再触发全局快捷键）
    if (e.code === 'Escape') { exitUI(); }
    else if (e.code === 'Enter' && ui.mode === 'active') { uiConfirm(); }
    else if (ui.focus === 'input' && ui.mode === 'active') {
      if (e.code === 'Backspace') {
        if (ui.text) { ui.text = ui.text.slice(0, -1); uiSample(); }
        e.preventDefault();
      } else if (e.key.length === 1 && ui.text.length < 24) {
        ui.text += e.key;
        uiSample();
        e.preventDefault();
      }
    }
    markInput();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.code === 'Enter') { enterUI(); }
  else if (e.code === 'KeyN') { setAutoMorph(false); nextShape(false); }
  else if (e.code === 'KeyL') { linksOn = !linksOn; $('links').checked = linksOn; }
  else if (e.code === 'KeyB') {
    if (breath.level > 0) { breath._last = breath.level; breath.level = 0; toast('呼吸 · 关'); }
    else { breath.level = breath._last || 0.65; toast('呼吸 · ' + ((breath.level * 100) | 0) + '%'); }
    $('breath').value = breath.level * 100;
    $('breathV').textContent = ((breath.level * 100) | 0) + '%';
  }
  else if (e.code.startsWith('Digit')) {
    const d = parseInt(e.code.slice(5), 10);
    if (d >= 1 && d <= SHAPE_ORDER.length) { setAutoMorph(false); morphTo(SHAPE_ORDER[d - 1], false); }
  }
  markInput();
});

function updateShapeUI() {
  $('shapeName').innerHTML = '当前形态 · <b>' + SHAPE_NAMES[shapeState.cur] + '</b>';
  document.querySelectorAll('.shapes button').forEach((b) => {
    b.classList.toggle('active', b.dataset.s === shapeState.cur);
  });
}

function updateHUD() {
  $('fps').textContent = (fpsEMA | 0) + ' fps';
  $('pcount').textContent = '粒子 ' + P.n + '（骨架 ' + P.nS + ' + 增援 ' + P.nD + '）';
  $('breathV').textContent = ((breath.level * 100) | 0) + '%';
  $('breathFill').style.width = ((0.5 + 0.5 * breath.env) * 100).toFixed(1) + '%';
  let sumL = 0, sumT = 0;
  for (let t = 0; t < TYPES.length; t++) {
    const s = typeState[t];
    sumL += s.load; sumT += s.temp;
    $('fill' + t).style.width = (s.load * 100).toFixed(1) + '%';
    $('pv' + t).textContent = ((s.load * 100) | 0) + '%';
    // 色块/进度条颜色 = 该硬件当前温度色（色相=温度）
    particleColor(s.temp, time, t * 1.7, breath.env, breath.amp || 0, _rgb);
    const css = 'rgb(' + ((_rgb[0] * 255) | 0) + ',' + ((_rgb[1] * 255) | 0) + ',' + ((_rgb[2] * 255) | 0) + ')';
    $('swatch' + t).style.background = css;
    $('fill' + t).style.background = css;
  }
  if (tel.auto) {
    const al = (sumL / TYPES.length * 100) | 0;
    const at = (sumT / TYPES.length * 100) | 0;
    $('load').value = al; $('loadV').textContent = al + '%';
    $('temp').value = at; $('tempV').textContent = at + '%';
  }
}

/* ---------- 内置自检（?selftest=1） ----------
 * 无头环境下 rAF 不随虚拟时间推进（截图只捕获首帧），
 * 故用同步模拟验证物理正确性：固定条件（球体 / 遥测关 / 负载 45%）
 * 跑多个呼吸场景，测量云群平均半径的 最小/最大/静息/峰值一致性。
 * 一致性 = 峰值帧各粒子半径的标准差：整群统一运动时应保持很小；
 * 若是逐粒子随机扰动则会显著放大。
 */
function radiusStdDev(mean) {
  let s = 0;
  for (let i = 0; i < P.n; i++) {
    const i3 = i * 3;
    const r = Math.sqrt(P.pos[i3] * P.pos[i3] + P.pos[i3 + 1] * P.pos[i3 + 1] + P.pos[i3 + 2] * P.pos[i3 + 2]) - mean;
    s += r * r;
  }
  return Math.sqrt(s / P.n);
}
function runSelfTest() {
  const DT = 1 / 60, DUR = 12, SKIP = 120; // 12s > 1 个呼吸周期（≈8.2s）；跳过前 2s 瞬态
  const scenarios = [
    { name: '呼吸关', level: 0 },
    { name: '呼吸 65%', level: 0.65 },
    { name: '呼吸 100%', level: 1 },
  ];
  const curShape = shapeState.cur;
  const savedAuto = tel.auto, savedMorph = shapeState.autoMorph;
  tel.auto = false; shapeState.autoMorph = false;
  const lines = [];
  for (const sc of scenarios) {
    shapeState.cur = 'sphere';
    shapeState.seed = 0.5;
    shapeState.morphT = 99;
    tel.load = 0.45; tel.temp = 0.35;
    breath.level = sc.level;
    breath.phase = 0;
    computeTargets(0);
    P.pos.set(P.target);
    P.vel.fill(0);
    let rMin = 1e9, rMax = -1e9, rSum = 0, rN = 0, stdPeak = 0, stdRest = 0;
    for (let f = 0; f < DUR * 60; f++) {
      step(DT, f * DT);
      if (f < SKIP) continue;
      let rs = 0;
      for (let i = 0; i < P.n; i++) {
        const i3 = i * 3;
        rs += Math.sqrt(P.pos[i3] * P.pos[i3] + P.pos[i3 + 1] * P.pos[i3 + 1] + P.pos[i3 + 2] * P.pos[i3 + 2]);
      }
      const rAvg = rs / P.n;
      if (rAvg < rMin) { rMin = rAvg; stdPeak = radiusStdDev(rAvg); }
      if (rAvg > rMax) rMax = rAvg;
      if (f === SKIP) stdRest = radiusStdDev(rAvg);
      rSum += rAvg; rN++;
    }
    const swing = (rMax - rMin) / 26 * 100;
    lines.push(sc.name + '   min ' + rMin.toFixed(2) + '   max ' + rMax.toFixed(2) +
      '   振幅 ' + swing.toFixed(1) + '%   峰值σ ' + stdPeak.toFixed(2) + '（静息σ ' + stdRest.toFixed(2) + '）');
  }
  // 颜色用例：色相/亮度 = 温度；负载不参与着色（对照组：同温不同负载 → 同色）
  const cc = [];
  const cases = [
    ['温度 0.10（冷）', 0.10], ['温度 0.35', 0.35], ['温度 0.60', 0.60],
    ['温度 0.90（热）', 0.90], ['温度 0.95 高温', 0.95], ['温度 0.98 超温', 0.98],
  ];
  for (const [name, tp] of cases) {
    particleColor(tp, 3.0, 0.5, 0, 0, _rgb);
    cc.push(name + '  →  #' + _rgb.map((v) => Math.round(Math.min(v, 1) * 255).toString(16).padStart(2, '0')).join(''));
  }
  cc.push('—— 对照：负载不影响颜色（温度固定 0.5）——');
  for (const ld of [0.1, 0.5, 0.95]) {
    particleColor(0.5, 3.0, 0.5, 0, 0, _rgb);
    cc.push('负载 ' + ld.toFixed(2) + ' @温度0.5  →  #' + _rgb.map((v) => Math.round(Math.min(v, 1) * 255).toString(16).padStart(2, '0')).join(''));
  }
  // 双层 UI 涌现测试：从球面出发，同步模拟 enterUI 后 3s
  // （converging 1.25s → active → 增援层倾泻到输入框），分层测量
  const savedUiMode = ui.mode, savedUiText = ui.text, savedChecks = ui.checks.slice(), savedFocus = ui.focus;
  const savedHover = ui.hover, savedForce = ui.forceHover, savedFill = ui.reinforceFill;
  const uiLines = [];
  ui.text = 'demo'; ui.checks = [true, false]; ui.focus = 'input';
  ui.mode = 'converging'; ui.t = 0;
  ui.forceHover = 'input';        // 模拟鼠标悬停输入框（无指针环境下驱动倾泻）
  breath.level = 0.65; breath.phase = 0;
  shapeState.cur = 'sphere'; shapeState.seed = 0.5; shapeState.morphT = 99;
  computeTargets(0);
  P.pos.set(P.target); // 从球面出发（模拟真实涌现）
  P.vel.fill(0);
  uiSample();
  // 记录骨架初始位置，用于测"钉住"程度
  const skel0 = P.pos.slice(0, P.nS * 3);
  for (let f = 0; f < 180; f++) step(DT, f * DT); // 3s
  // —— 骨架层：到 UI 目标的偏差 + 3s 总漂移（应接近钉住）——
  let sum = 0, max = 0, drift = 0;
  for (let i = 0; i < P.nS; i++) {
    const i3 = i * 3;
    const d = Math.sqrt((P.pos[i3] - P.target[i3]) ** 2 + (P.pos[i3 + 1] - P.target[i3 + 1]) ** 2 + (P.pos[i3 + 2] - P.target[i3 + 2]) ** 2);
    sum += d; if (d > max) max = d;
    drift += Math.sqrt((P.pos[i3] - skel0[i3]) ** 2 + (P.pos[i3 + 1] - skel0[i3 + 1]) ** 2 + (P.pos[i3 + 2] - skel0[i3 + 2]) ** 2);
  }
  const avg = sum / P.nS;
  // —— 增援层：倾泻计数 / 槽位偏差 / 环绕计数 / 是否在输入框范围内 ——
  // 输入框世界范围由 UI_RECTS[0] 动态推导（UI 坐标 y 向下 → 世界 y 向上）
  const ir = UI_RECTS[0];
  const ibx0 = (ir.x - UI_W / 2) * UI_S, ibx1 = (ir.x + ir.w - UI_W / 2) * UI_S;
  const iby0 = -(ir.y + ir.h - UI_H / 2) * UI_S, iby1 = -(ir.y - UI_H / 2) * UI_S;
  let dSum = 0, dN = 0, oN = 0, inBox = 0;
  for (let i = P.nS; i < P.n; i++) {
    const i3 = i * 3;
    if (P.dynMode[i] === 1) {
      const d = Math.sqrt((P.pos[i3] - P.dynTarget[i3]) ** 2 + (P.pos[i3 + 1] - P.dynTarget[i3 + 1]) ** 2 + (P.pos[i3 + 2] - P.dynTarget[i3 + 2]) ** 2);
      dSum += d; dN++;
      if (P.pos[i3] > ibx0 && P.pos[i3] < ibx1 && P.pos[i3 + 1] > iby0 && P.pos[i3 + 1] < iby1) inBox++;
    } else oN++;
  }
  const roleCount = {};
  for (let i = 0; i < P.nS; i++) roleCount[P.uiRole[i]] = (roleCount[P.uiRole[i]] || 0) + 1;
  uiLines.push('双层结构 · 骨架 ' + P.nS + '（钉住面板）+ 增援 ' + P.nD + '（悬停输入框时倾泻）');
  uiLines.push('骨架层 · 3s 收敛后平均偏差 ' + (avg / UI_S).toFixed(1) + ' px（最大 ' + (max / UI_S).toFixed(1) + ' px），总漂移 ' + (drift / P.nS / UI_S).toFixed(1) + ' px/粒子');
  uiLines.push('判读：骨架偏差 < 10px 且漂移 ≈ 收敛位移 → 文字稳定可读（不随鼠标/呼吸晃动）');
  uiLines.push('增援层 · 倾泻 ' + dN + ' 粒子到输入框（' + inBox + ' 在框内），环绕 ' + oN + '；槽位偏差 ' + (dN ? (dSum / dN / UI_S).toFixed(1) : '0') + ' px');
  const la = ui.lastAssign;
  if (la) uiLines.push('倾泻诊断 · ' + la.id + ' 候选槽位 ' + la.M + ' → 投入 ' + la.useCount + '/' + la.nD + '（每槽位 ' + (la.useCount / Math.max(1, la.M)).toFixed(2) + ' 粒）');
  const ls = ui.lastScan;
  if (ls) {
    // 点阵可读性 = 三个比例（v0.14）：
    //   ① 有效点距/光斑：1.0~1.35 = 点阵屏标准观感（点间有细暗缝，眼可积分成线）；
    //      >1.5 = 稀疏成散点；<0.9 = 点相切糊成实心；
    //   ② 笔画格数（SCAN_TH 决定，恒为 1 格）；
    //   ③ 字内格数（字号/cell，汉字需 ≥16 格）。
    const pitch = ls.cell * Math.sqrt(ls.M / Math.max(1, ls.n));
    const spot = ls.spot;
    const r = pitch / spot;
    // 1:1 点阵屏的标准观感就是「点径≈0.7 点距」（真 LED 屏也是点间留缝，
    // 眼睛会积分成笔画），所以 1.1~1.6 属于正常；>1.6 才是散点。
    const verdict = r <= 1.1 ? '相切连续' : r <= 1.6 ? '点阵屏标准观感（暗缝 ' + ((1 - spot / pitch) * 100).toFixed(0) + '%）'
      : '稀疏 → 显"断"（暗缝 ' + ((1 - spot / pitch) * 100).toFixed(0) + '%）';
    uiLines.push('密度诊断 · 全画面候选槽位 ' + ls.M + '（cell ' + ls.cell + ' UI px）→ 骨架 ' + ls.n + ' 粒' +
      '：有效点距 ' + pitch.toFixed(2) + ' / 光斑 ' + spot.toFixed(2) + ' = ' + r.toFixed(2) + '（' + verdict + '）');
  }
  uiLines.push('判读：悬停控件时绝大多数增援粒子进入该控件区域 → "光标给控件充能"；小控件时环绕数上升（光晕）');
  uiLines.push('骨架角色分布 ' + Object.keys(roleCount).sort((a, b) => a - b).map((r) => ROLE_NAMES[r] + ':' + roleCount[r]).join('  '));
  // 还原演示状态
  ui.mode = savedUiMode; ui.text = savedUiText; ui.checks = savedChecks; ui.focus = savedFocus;
  ui.hover = savedHover; ui.forceHover = savedForce; ui.reinforceFill = savedFill;
  tel.auto = savedAuto; shapeState.autoMorph = savedMorph;
  shapeState.cur = curShape;
  shapeState.morphT = 99;
  computeTargets(time);
  P.pos.set(P.target);
  P.vel.fill(0);
  breath.phase = 0;
  markGeoDirty();
  updateHUD();
  const el = $('selftest');
  el.hidden = false;
  el.textContent = '呼吸自检 · 同步模拟 ' + DUR + 's × 3 场景（球体 / 遥测关 / 负载 45%）\n' +
    lines.join('\n') + '\n判读：呼吸关 → 振幅≈0 且半径稳定；幅度 65% → 双相振幅可见；峰值σ 不放大 → 整群统一运动' +
    '\n\n配色自检 · 温度色样（时间/相位固定）\n' + cc.join('\n') +
    '\n判读：温度↑ → 冰蓝#44aaff→琥珀#ffb040 且亮度↑（暗→亮）；超温 → 暗红#ff4c5c；对照组三行同色 → 负载不影响颜色（负载只驱动运动）' +
    '\n\n' + uiLines.join('\n');
  console.log('[selftest] ' + JSON.stringify({ breath: lines, color: cc, ui: uiLines }));
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ---------- 主循环 ---------- */
let last = performance.now(), time = 0;
let fpsEMA = 60, frames = 0, fpsT = 0, hudT = 0, degradeStep = 0, firstFrame = true;

/* ---------- URL 参数（深链分享 / 调试） ----------
 *  #sphere|#torus|#galaxy|#wave|#sculpture  直接打开指定形态
 *  ?t=<秒>   设定初始时间（遥测状态）
 *  ?auto=0   关闭遥测自动演示   ?morph=0  关闭形态自动巡航
 *  ?breathe=0~1  呼吸幅度（0=关闭）   ?bp=<弧度>  呼吸初始相位
 *  ?load=0~1 ?temp=0~1  手动设定全局负载/温度（自动关闭遥测演示）
 *  ?n=<200~16000>  覆盖粒子总数（默认 8200）  ?static=<int>  覆盖骨架粒子数（默认 4400）
 *  ?selftest=1  同步模拟自检（无头环境验证呼吸物理/配色/双层 UI 涌现，结果见左上层面板）
 *  ?pose=inhale|exhale  静态落位到吸气/呼气姿态（跳过流动过程）
 *  ?ui=1  直接呈现粒子 UI 面板（落位，跳过凝聚过程）  ?uitext=<文字>  预设输入框文字
 *  ?uihover=<input|check0|check1|ok|cancel|close|title|sub>  增援层直接倾泻到指定控件
 *  ?uipose=1  连同相机机位一起直接落位（无头截图用，跳过相机平滑过渡）
 */
const params = new URLSearchParams(location.search);
const t0 = parseFloat(params.get('t') || '0');
if (t0 > 0) time = t0;
/* ?n=<200~12000> 覆盖粒子总数 */
const nParam = parseInt(params.get('n'), 10);
if (nParam >= 200 && nParam <= 16000) COUNT = nParam;
/* ?static=<int> 覆盖骨架粒子数（UI 模式下钉住面板的那一层） */
const sParam = parseInt(params.get('static'), 10);
if (sParam >= 100 && sParam <= 12000) STATIC_N = sParam;
if (params.get('auto') === '0') { tel.auto = false; $('auto').checked = false; }
if (params.get('morph') === '0') { shapeState.autoMorph = false; $('morphAuto').checked = false; }
const bl = parseFloat(params.get('breathe'));
if (!isNaN(bl)) breath.level = clamp(bl, 0, 1);
const bp = parseFloat(params.get('bp'));
if (!isNaN(bp)) breath.phase = bp;
/* 临时调参深链（点阵可读性对照实验用）：?ops=骨架不透明度 ?opsd=增援不透明度
 * ?dotsz=骨架光斑尺寸 ?dotszd=增援光斑尺寸 */
let UI_OPS = 0.68, UI_OPS_D = 0.60, UI_SIZE = 0.68, UI_SIZE_D = 0.46;
const _ops = parseFloat(params.get('ops')); if (!isNaN(_ops)) UI_OPS = clamp(_ops, 0.05, 1);
const _opsd = parseFloat(params.get('opsd')); if (!isNaN(_opsd)) UI_OPS_D = clamp(_opsd, 0.05, 1);
const _dsz = parseFloat(params.get('dotsz')); if (!isNaN(_dsz)) UI_SIZE = clamp(_dsz, 0.2, 3);
const _dszd = parseFloat(params.get('dotszd')); if (!isNaN(_dszd)) UI_SIZE_D = clamp(_dszd, 0.2, 3);
/* 字体对照实验深链：?fnt=deng|yahei|simhei ?th=<0.1~0.9 格覆盖率阈值> ?track=<字距 UI px> */
const _fnt = params.get('fnt');
if (_fnt === 'yahei') UI_FONT = '"Microsoft YaHei Light","Microsoft YaHei",sans-serif';
else if (_fnt === 'simhei') UI_FONT = 'SimHei,sans-serif';
else if (_fnt === 'deng') UI_FONT = '"DengXian Light","Microsoft YaHei Light",sans-serif';
const _th = parseFloat(params.get('th')); if (!isNaN(_th)) SCAN_TH = clamp(_th, 0.1, 0.9);
const _trk = parseFloat(params.get('track')); if (!isNaN(_trk)) UI_TRACK = clamp(_trk, 0, 8);
if (params.get('nolink') === '1') SCAN_NOLINK = true;
const lp = parseFloat(params.get('load'));
if (!isNaN(lp)) { tel.auto = false; tel.load = clamp(lp, 0, 1); $('auto').checked = false; }
const tpv = parseFloat(params.get('temp'));
if (!isNaN(tpv)) { tel.auto = false; tel.temp = clamp(tpv, 0, 1); }
$('breath').value = breath.level * 100;
$('load').value = tel.load * 100;
$('loadV').textContent = Math.round(tel.load * 100) + '%';
$('temp').value = tel.temp * 100;
$('tempV').textContent = Math.round(tel.temp * 100) + '%';
shapeState.timer = time;
const hashShape = location.hash.replace('#', '');
if (SHAPE_NAMES[hashShape]) shapeState.cur = hashShape;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.05) dt = 0.05;
  frames++; fpsT += dt; hudT += dt;

  if (!paused) { time += dt; step(dt, time); }
  if (ui.mode === 'idle') {
    if (!dragging) cam.tTheta += dt * 0.012;
    group.rotation.y += dt * 0.035;
    group.rotation.z = Math.sin(time * 0.10) * 0.04;
  } else {
    // UI 涌现模式：整组与相机平滑归正，保证文字正面可读
    const gk = Math.min(1, dt * 5);
    group.rotation.y += (0 - group.rotation.y) * gk;
    group.rotation.z += (0 - group.rotation.z) * gk;
  }
  updateCamera(dt);
  stars.rotation.y -= dt * 0.006;
  renderer.render(scene, camera);
  if (firstFrame) { firstFrame = false; $('loading').classList.add('hide'); }

  if (fpsT >= 0.5) {
    const fps = frames / fpsT;
    frames = 0; fpsT = 0;    fpsEMA = fpsEMA * 0.6 + fps * 0.4;
    if (degradeStep < 2 && time > 5 && fpsEMA < 27) {
      degradeStep++;
      // 优先压缩增援层（骨架 6800 不动，保住面板可读性）
      const nc = STATIC_N + Math.max(300, Math.floor((COUNT - STATIC_N) * 0.6));
      COUNT = nc;
      buildSystem(nc, STATIC_N);
      if (ui.mode !== 'idle') {
        // UI 涌现模式下降级：重新采样并直接落位，保持界面完整
        uiSample();
        for (let i = 0; i < P.n; i++) {
          const i3 = i * 3;
          P.pos[i3] = i < P.nS ? P.target[i3] : P.dynTarget[i3];
          P.pos[i3 + 1] = i < P.nS ? P.target[i3 + 1] : P.dynTarget[i3 + 1];
          P.pos[i3 + 2] = i < P.nS ? P.target[i3 + 2] : P.dynTarget[i3 + 2];
        }
        P.vel.fill(0);
      } else {
        computeTargets(time);
        rebuildLinks();
      }
      toast('帧率不足，粒子数降至 ' + nc + '（骨架 ' + P.nS + ' + 增援 ' + P.nD + '）');
    }
  }
  if (hudT >= 0.12) { hudT = 0; updateHUD(); }

  if (now - lastInput > 12000) document.body.classList.add('dimmed');
}

buildSystem(COUNT, STATIC_N);

/* —— 临时调试：?hide=S|D|* 隐藏骨架/增援/两层（排除法定位渲染异常）—— */
if (params.get('hide') === 'S') P.ptsS.visible = false;
if (params.get('hide') === 'D') P.ptsD.visible = false;
if (params.get('hide') === '*') { P.ptsS.visible = false; P.ptsD.visible = false; }

/* 指定了形态深链：直接落位到该形态（跳过流动过程，即时呈现） */
if (hashShape && SHAPE_NAMES[hashShape]) {
  if (SHAPE_PHI[hashShape] !== undefined) cam.tPhi = SHAPE_PHI[hashShape];
  if (hashShape === 'sculpture') {
    // 引力雕塑：预置于两个引力井周围的团簇
    const w1 = time * 0.22 + shapeState.seed * 6.28;
    const gx = Math.cos(w1) * 11, gy = Math.sin(w1 * 0.73) * 4.5, gz = Math.sin(w1) * 11;
    for (let i = 0; i < P.n; i++) {
      const i3 = i * 3;
      const sx = (i % 2 === 0) ? gx : -gx, sy = (i % 2 === 0) ? gy : -gy, sz = (i % 2 === 0) ? gz : -gz;
      const u = Math.random() * 2 - 1, th = Math.random() * TAU, s = Math.sqrt(1 - u * u);
      const rr = 2.5 + Math.random() * 2.0;
      P.pos[i3] = sx + Math.cos(th) * s * rr;
      P.pos[i3 + 1] = sy + u * rr;
      P.pos[i3 + 2] = sz + Math.sin(th) * s * rr;
    }
  } else {
    computeTargets(time);
    P.pos.set(P.target);
  }
  P.vel.fill(0);
  markGeoDirty();
  rebuildLinks();
  updateShapeUI();
}

/* 呼吸相位静态落位：?pose=inhale|exhale（直接呈现膨胀/收缩态，跳过流动过程） */
const pose = params.get('pose');
if (pose === 'inhale' || pose === 'exhale') {
  const d = 3.0 * (pose === 'inhale' ? 1 : -1);
  for (let i = 0; i < P.n; i++) {
    const i3 = i * 3;
    const r = Math.sqrt(P.target[i3] * P.target[i3] + P.target[i3 + 1] * P.target[i3 + 1] + P.target[i3 + 2] * P.target[i3 + 2]);
    if (r > 0.5) {
      const s = 1 + d / r;
      P.pos[i3] = P.target[i3] * s;
      P.pos[i3 + 1] = P.target[i3 + 1] * s;
      P.pos[i3 + 2] = P.target[i3 + 2] * s;
    }
  }
  P.vel.fill(0);
  markGeoDirty();
  rebuildLinks();
}

updateShapeUI();
updateHUD();

/* 粒子 UI 深链：?ui=1 直接落位呈现面板（无头截图 / 分享特定状态）
 * ?uihover=<input|check0|check1|ok|cancel|close|title|sub>  强制增援层
 * 倾泻到指定控件（截图用；真实鼠标移动后会按实际悬停切换） */
if (params.get('ui') === '1') {
  const ut = params.get('uitext');
  if (ut) ui.text = ut;
  const uh = params.get('uihover');
  enterUI(true);                        // 采样骨架 + 增援清空 + 尺寸/机位/body class
  if (uh && UI_DRAW[uh]) {
    ui.mode = 'active';                 // 跳过凝聚动画，直接呈现增援态
    ui.hover = uh;
    /* forceHover：无指针环境（无头截图）下第一帧就会把 hover 判空 →
     * 增援层被释放回环绕态、粒子被流场吹离槽位（曾导致"全宽暗带"干扰文字）。
     * 强制悬停可保持倾泻态；用户真实移动鼠标后由 pointermove 清除。 */
    ui.forceHover = uh;
    assignReinforce(uh);                // 增援层倾泻到指定控件
  }
  /* 非槽位增援粒子落位到待机环：assignReinforce 只写槽位粒子的 dynTarget，
   * 其余的若不清掉会残留 buildSystem 时的球面 dynTarget（深链落位后粒子会
   * 从球体飞向待机环，途中形成罩住面板的大云团——v0.9 截图实拍发现）。 */
  orbitAround(PARK_CENTER, time, 1.6);
  // 落位：骨架 → UI 目标；增援 → 当前 dynTarget（倾泻槽位 / 待机环）
  for (let i = 0; i < P.n; i++) {
    const i3 = i * 3;
    P.pos[i3] = i < P.nS ? P.target[i3] : P.dynTarget[i3];
    P.pos[i3 + 1] = i < P.nS ? P.target[i3 + 1] : P.dynTarget[i3 + 1];
    P.pos[i3 + 2] = i < P.nS ? P.target[i3 + 2] : P.dynTarget[i3 + 2];
  }
  P.vel.fill(0);
  markGeoDirty();
  /* ?uipose=1：相机也直接落位（跳过平滑过渡；无头截图只渲染首帧，
   * 平滑过渡来不及完成，粒子会因相机未到位而显小） */
  if (params.get('uipose') === '1') {
    cam.radius = cam.tRadius; cam.phi = cam.tPhi; cam.theta = cam.tTheta;
    updateCamera(0);
  }
}
if (params.get('selftest') === '1') runSelfTest();
requestAnimationFrame(frame);
