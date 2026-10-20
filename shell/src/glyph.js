/**
 * 图标字形库 —— 用白色墨迹在 100×100 的逻辑画布上画出「图形」，
 * 由 rail.js 按格子统计覆盖率 → 排成粒子（左边缘应用栏）。
 *
 * 为什么不用官方那张 PNG 直接降采样：
 *   Olares 的图标是满幅插画（橙色文件夹铺满整张 256×256），
 *   降到 20×20 的格子上，亮度取点会得到一个实心方块，边缘取点只剩一圈很淡的线；
 *   它们靠**颜色 + 细节**辨认，而点阵只有几十颗点，细节全丢。
 * 所以这里按每张图的**题材**重画字形（文件夹 / 提包 / 齿轮 / 钥匙孔 / 气泡 /
 * 表盘 / 推子），配色取官方图标的主色 —— 远看是「那个橙色的文件」，近看是粒子。
 */

/* 统一用 path 描述，最后 fill()。逻辑坐标 100×100，中心 (50,50)。 */
const TAU = Math.PI * 2;

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

function circle(c, cx, cy, r) {
  c.moveTo(cx + r, cy);
  c.arc(cx, cy, r, 0, TAU);
}

/* ───────────────────────────── 各图标 ─────────────────────────────
 * 这组字形是给"22~28 格点阵"画的，不是给矢量图标画的：
 *   - 笔画 ≥ 7 单位（≈2 格），否则栅格化后整条丢失
 *   - 只保留一个主体 + 一个识别细节，细节多了就糊成一团
 *   - 实心 + 挖洞 > 描边：点阵里描边容易被当成"两排点"
 */

/** 文件：文件夹 —— 页签 + 主体 + 一条"盖子"缝（官方是橙色文件夹） */
function files(c) {
  c.beginPath();
  roundRect(c, 10, 18, 38, 28, 8);      // 页签
  c.fill();
  c.beginPath();
  roundRect(c, 10, 30, 80, 58, 11);     // 主体
  c.fill();
  /* 盖子缝：横贯的一条 5 单位空隙，上下两块的读法就是"文件夹" */
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  c.moveTo(8, 56);
  c.lineTo(92, 56);
  c.lineTo(92, 61);
  c.lineTo(8, 61);
  c.closePath();
  c.fill();
  c.globalCompositeOperation = 'source-over';
}

/** 应用市场：购物提包（官方是蓝色提包 + 圆标） */
function appstore(c) {
  c.beginPath();
  c.moveTo(14, 36);
  c.lineTo(86, 36);
  c.lineTo(79, 88);
  c.lineTo(21, 88);
  c.closePath();
  c.fill();
  c.lineWidth = 12;
  c.beginPath();
  c.moveTo(34, 40);
  c.quadraticCurveTo(34, 12, 50, 12);
  c.quadraticCurveTo(66, 12, 66, 40);
  c.stroke();
  /* 包扣：一个小圆洞 */
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  circle(c, 50, 62, 8);
  c.fill();
  c.globalCompositeOperation = 'source-over';
}

/** 设置：齿轮 —— 实心盘挖 6 个齿隙 + 轴孔（官方是金属齿轮） */
function settings(c) {
  const cx = 50, cy = 50;
  /* 实心盘 + 挖洞：25 格的栅格下，"描边+齿"会糊成一圈雪花，
     实心块挖缺口才能读出"齿轮"的外形 */
  c.beginPath();
  circle(c, cx, cy, 32);
  c.fill();

  c.globalCompositeOperation = 'destination-out';
  /* 轴孔 */
  c.beginPath();
  circle(c, cx, cy, 12);
  c.fill();
  /* 6 个齿隙：从外缘往里切，剩下的弧就是齿 */
  c.lineWidth = 11;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + Math.PI / 6;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * 37, cy + Math.sin(a) * 37);
    c.lineTo(cx + Math.cos(a) * 23, cy + Math.sin(a) * 23);
    c.stroke();
  }
  c.globalCompositeOperation = 'source-over';
}

/** 保险库：环 + 钥匙孔（官方是黄底黑钥匙孔） */
function vault(c) {
  c.lineWidth = 13;
  c.beginPath();
  circle(c, 50, 50, 33);
  c.stroke();
  c.beginPath();
  circle(c, 50, 43, 13);      // 锁孔上圆
  c.fill();
  c.beginPath();
  c.moveTo(43, 48);
  c.lineTo(57, 48);
  c.lineTo(60, 76);
  c.lineTo(40, 76);
  c.closePath();
  c.fill();
}

/** 个人资料：实心对话气泡 + 挖空的「人」——官方是绿底气泡 + 链接 */
function profile(c) {
  c.beginPath();
  c.moveTo(50, 10);
  c.bezierCurveTo(73, 10, 90, 26, 90, 44);
  c.bezierCurveTo(90, 62, 73, 78, 50, 78);
  c.bezierCurveTo(42, 78, 35, 76, 29, 72);
  c.lineTo(14, 84);
  c.lineTo(19, 63);
  c.bezierCurveTo(13, 58, 10, 51, 10, 44);
  c.bezierCurveTo(10, 26, 27, 10, 50, 10);
  c.closePath();
  c.fill();
  /* 挖一个头 + 一条肩，读法就是"气泡里坐着个人" */
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  circle(c, 50, 36, 12);
  c.fill();
  c.beginPath();
  c.moveTo(30, 70);
  c.quadraticCurveTo(32, 52, 50, 52);
  c.quadraticCurveTo(68, 52, 70, 70);
  c.closePath();
  c.fill();
  c.globalCompositeOperation = 'source-over';
}

/** 仪表盘：表盘弧 + 指针 —— 官方是蓝色速度表 */
function dashboard(c) {
  c.lineWidth = 12;
  c.beginPath();
  c.arc(50, 62, 33, Math.PI * 1.02, Math.PI * 1.98);
  c.stroke();
  c.lineWidth = 10;
  c.beginPath();
  c.moveTo(50, 62);
  c.lineTo(74, 36);
  c.stroke();
  c.beginPath();
  circle(c, 50, 62, 11);
  c.fill();
}

/** 控制面板：拼图（官方图标里最显眼的就是那块拼图 + 螺丝刀） */
function controlHub(c) {
  c.beginPath();
  roundRect(c, 16, 24, 68, 62, 8);       // 主体
  c.fill();
  c.beginPath();
  circle(c, 50, 24, 12);                 // 上凸
  c.fill();
  /* 右侧凹口 */
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  circle(c, 84, 55, 11);
  c.fill();
  c.globalCompositeOperation = 'source-over';
  /* 内部斜线：暗示"工具"（螺丝刀），同时把大块实心打散 */
  c.globalCompositeOperation = 'destination-out';
  c.lineWidth = 9;
  c.beginPath();
  c.moveTo(32, 76);
  c.lineTo(72, 40);
  c.stroke();
  c.globalCompositeOperation = 'source-over';
}

/** 登出：电源符号（顶部留缺口的圆 + 一根竖线） */
function power(c) {
  c.lineWidth = 10;
  c.beginPath();
  c.arc(50, 54, 30, -Math.PI * 0.42, Math.PI * 1.42);
  c.stroke();
  c.lineWidth = 11;
  c.beginPath();
  c.moveTo(50, 12);
  c.lineTo(50, 44);
  c.stroke();
}

/* ───────────────────────────── 注册表 ───────────────────────────── */

/* 官方图标主色（取自 icon.png 的主色调）：远看靠颜色认，近看靠形状认 */
export const TINT = {
  files: ['#ffc061', '#f08a1e'],
  appstore: ['#8fc6ff', '#2a6ee0'],
  settings: ['#eef3fa', '#a9b4c4'],
  vault: ['#ffe07a', '#e8a91c'],
  profile: ['#8ef0a8', '#28b455'],
  dashboard: ['#9fd0ff', '#1f6fd6'],
  'control-hub': ['#a8e2ff', '#2f8fd8'],
  power: ['#ffb4b4', '#e05555'],
};

export const GLYPH = {
  files,
  appstore,
  settings,
  vault,
  profile,
  dashboard,
  'control-hub': controlHub,
  power,
};

/** 入口名 → 字形。系统应用的 entrance.name 就是 files / market / settings … */
export function glyphOf(name, title) {
  const n = String(name || '').toLowerCase();
  if (GLYPH[n]) return n;
  if (n === 'market') return 'appstore';
  if (n === 'dashboard' || n === 'controlhub') return 'dashboard';
  const t = String(title || '').toLowerCase();
  if (/file|文件|drive|网盘/.test(t)) return 'files';
  if (/market|store|市场|商店/.test(t)) return 'appstore';
  if (/setting|设置/.test(t)) return 'settings';
  if (/vault|密码|key|保险/.test(t)) return 'vault';
  if (/profile|个人|account|账号/.test(t)) return 'profile';
  if (/dashboard|仪表|监控/.test(t)) return 'dashboard';
  if (/control|控制|hub/.test(t)) return 'control-hub';
  return null;
}

/** 画字形：白色墨迹，调用方自己决定画布大小（内部一律按 100 单位缩放） */
export function paintGlyph(ctx, name, size) {
  const fn = GLYPH[name];
  if (!fn) return false;
  ctx.save();
  /* 放 6%：点阵在 52px 里本来就小，留白太多会更认不出 */
  const k = size * 1.06 / 100;
  ctx.translate(-size * 0.03, -size * 0.03);
  ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  fn(ctx);
  ctx.restore();
  return true;
}
