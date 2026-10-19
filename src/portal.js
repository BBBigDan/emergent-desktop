/**
 * 粒子门 · iframe 包裹试验
 * ---------------------------------------------------------------------------
 * 目标：一个真实网页（iframe）从「一个粒子点」里长出来，最终被粒子流包裹。
 *
 * 几何做法（关键）：
 *   1. iframe 元素**始终是最终尺寸**，只用 clip-path: inset() 从中心一点撑开。
 *      → 页面内容不重排、不缩放，字始终清晰；「变大」的只是可见窗口。
 *   2. 粒子跑在屏幕像素坐标的正交相机里，粒子的目标点 = 当前 pe 对应的矩形周长，
 *      所以粒子的外扩前沿天然与 clip 前沿重合：窗口边缘到哪，粒子流就到哪。
 *   3. 画布压在 iframe **下面**（z-index 1 < 2）。粒子越过窗口边缘就被遮住 =
 *      被"吸进"页面里，不需要做任何淡出。
 *
 * 时间轴：
 *   0 – 720ms      聚点：散在屏幕深处的粒子全部向中心收拢成一个亮核
 *   720 – 3320ms   生长：矩形从点开始外扩，粒子被拖到新生长的边框上；iframe 由
 *                  一个点被撑开（含轻微失焦→合焦）
 *   3320ms+        稳定：粒子沿四边环流，3 个脉冲包沿周长跑动，少量粒子从边框向内
 *                  漂移被窗口吸走
 *
 * 深链：?at=1.2&freeze=1  同步预热到 1.2s 并定格（无头截图复现用）
 *      ?url=...  ?n=5200  ?flow=1  ?selftest=1  ?play=1
 */
import * as THREE from 'three';

/* ============================ 小工具 ============================ */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const qs = new URLSearchParams(location.search);
const IF_URL = qs.get('url') || 'demo-dashboard.html';
const N = clamp(parseInt(qs.get('n') || '9000', 10) || 9000, 1200, 16000);
let FLOW = clamp(parseFloat(qs.get('flow') || '1') || 1, 0, 3);
const AT = parseFloat(qs.get('at') || '0') || 0;
const FREEZE = qs.get('freeze') === '1' || (AT > 0 && qs.get('play') !== '1');
const SELFTEST = qs.get('selftest') === '1';

const SEED_MS = 720;     // 聚点
const BIRTH_MS = 2600;   // 生长
const T_END = SEED_MS + BIRTH_MS;
const COL_SPEED = 2.6;   // 收回速度倍率

/* ============================ 布局 ============================ */
const portal = $('portal');
const frame = $('frame');

let W = 0, H = 0, rw = 0, rh = 0, hw = 0, hh = 0;
let camera, renderer;

const canvas = $('scene');
const bgEl = $('bg');

function fail(msg) {
  $('fallback').hidden = false;
  $('fallback').textContent = msg;
  $('loading').classList.add('hide');
}

try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
} catch (e) {
  fail('当前环境不支持 WebGL，无法渲染粒子流。');
  throw e;
}

const scene = new THREE.Scene();
camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
camera.position.z = 1600;

function layout() {
  W = Math.max(320, window.innerWidth);
  H = Math.max(240, window.innerHeight);
  // 留出足够的余量给粒子流包裹（窗口贴边会把粒子挤到屏幕外）
  const mx = W < 900 ? 0.04 : 0.058;
  const my = H < 640 ? 0.05 : 0.072;
  rw = Math.round(W * (1 - 2 * mx));
  rh = Math.round(H * (1 - 2 * my));
  hw = rw / 2;
  hh = rh / 2;

  camera.left = -W / 2; camera.right = W / 2;
  camera.top = H / 2; camera.bottom = -H / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(W, H, false);

  portal.style.width = rw + 'px';
  portal.style.height = rh + 'px';
  portal.style.left = Math.round((W - rw) / 2) + 'px';
  portal.style.top = Math.round((H - rh) / 2) + 'px';
}

/* ============================ 粒子数据 ============================ */
const KIND_RIDER = 0, KIND_HALO = 1, KIND_INTR = 2;

const pos = new Float32Array(N * 3);
const col = new Float32Array(N * 3);
const aSize = new Float32Array(N);
const aAlpha = new Float32Array(N);
const vel = new Float32Array(N * 2);
const aDir = new Float32Array(N * 2);   // 屏幕空间运动方向（单位向量）
const aStr = new Float32Array(N);       // 拉伸系数：0=圆点，越大越像流线

const uPar = new Float32Array(N);     // 周长参数 0..1
const off = new Float32Array(N);      // 法向偏移（正=向窗外）
const spd = new Float32Array(N);      // 环流速度 px/s
const ks = new Float32Array(N);       // 弹簧刚度系数
const jit = new Float32Array(N);      // 抖动相位
const jf = new Float32Array(N);       // 抖动频率
const jamp = new Float32Array(N);     // 抖动幅度
const zN = new Float32Array(N);       // 归一化深度 -1..1
const baseA = new Float32Array(N);
const baseS = new Float32Array(N);
const kind = new Uint8Array(N);
const inT = new Float32Array(N);      // 侵入进度 0..1
const inRate = new Float32Array(N);
const inDepth = new Float32Array(N);

const tgtX = new Float32Array(N);     // 诊断用：上一帧目标
const tgtY = new Float32Array(N);

const PAL = [
  [0.50, 0.89, 1.00],  // 浅青
  [0.37, 0.85, 1.00],  // 电青
  [0.44, 0.98, 0.90],  // 青绿
  [0.60, 0.83, 1.00],  // 天蓝
  [0.70, 0.47, 1.00],  // 紫（少）
  [1.00, 0.69, 0.25],  // 琥珀（少）
];
const PAL_W = [0.26, 0.34, 0.22, 0.12, 0.04, 0.02];

function pickPal() {
  let r = Math.random(), acc = 0;
  for (let i = 0; i < PAL.length; i++) { acc += PAL_W[i]; if (r <= acc) return PAL[i]; }
  return PAL[0];
}

function initParticles() {
  for (let i = 0; i < N; i++) {
    const r = Math.random();
    let k;
    if (r < 0.68) k = KIND_RIDER;
    else if (r < 0.96) k = KIND_HALO;
    else k = KIND_INTR;
    kind[i] = k;

    uPar[i] = Math.random();
    jit[i] = Math.random() * Math.PI * 2;
    jf[i] = 0.7 + Math.random() * 2.6;
    zN[i] = Math.random() * 2 - 1;

    if (k === KIND_RIDER) {
      off[i] = 2 + Math.pow(Math.random(), 2.0) * 16;
      aStr[i] = 0.55 + Math.random() * 0.55;
      spd[i] = (150 + Math.random() * 210) * (Math.random() < 0.94 ? 1 : -1);
      ks[i] = 0.75 + Math.random() * 0.55;
      jamp[i] = 0.6 + Math.random() * 1.9;
      baseA[i] = 0.55 + Math.random() * 0.42;
      baseS[i] = 2.0 + Math.random() * 2.2;
      // 8% 的粒子偏大偏亮 = 数据包/节点
      if (Math.random() < 0.08) { baseS[i] += 1.4; baseA[i] = Math.min(1, baseA[i] + 0.25); }
    } else if (k === KIND_HALO) {
      off[i] = 22 + Math.pow(Math.random(), 1.5) * 88;
      spd[i] = (60 + Math.random() * 110) * (Math.random() < 0.85 ? 1 : -1);
      ks[i] = 0.35 + Math.random() * 0.4;
      jamp[i] = 2 + Math.random() * 6;
      baseA[i] = 0.18 + Math.random() * 0.26;
      baseS[i] = 1.3 + Math.random() * 1.9;
    } else {
      off[i] = 1 + Math.random() * 8;
      spd[i] = 0;
      ks[i] = 1.1 + Math.random() * 0.5;
      jamp[i] = 0.8 + Math.random() * 1.6;
      baseA[i] = 0.45 + Math.random() * 0.4;
      baseS[i] = 1.3 + Math.random() * 1.5;
      inT[i] = Math.random();
      inRate[i] = 0.22 + Math.random() * 0.35;
      inDepth[i] = 70 + Math.random() * 190;
      aStr[i] = 0.6;
    }

    aDir[i * 2] = 1; aDir[i * 2 + 1] = 0; aStr[i] = 0;

    const c = pickPal();
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];

    // 初始位置：铺满屏幕的一个椭球云（聚点阶段从四面八方向中心收拢）
    const th = Math.random() * Math.PI * 2;
    const cph = Math.random() * 2 - 1;
    const sph = Math.sqrt(Math.max(0, 1 - cph * cph));
    const R = Math.min(W, H) * (0.55 + Math.random() * 0.45);
    pos[i * 3] = Math.cos(th) * sph * R * (W / H) * 0.95;
    pos[i * 3 + 1] = Math.sin(th) * sph * R;
    pos[i * 3 + 2] = cph * R * 0.75;
    vel[i * 2] = 0; vel[i * 2 + 1] = 0;
  }
}

/* ============================ 渲染对象 ============================ */
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1).setUsage(THREE.DynamicDrawUsage));
geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
 geo.setAttribute('aDir', new THREE.BufferAttribute(aDir, 2).setUsage(THREE.DynamicDrawUsage));
 geo.setAttribute('aStr', new THREE.BufferAttribute(aStr, 1).setUsage(THREE.DynamicDrawUsage));

const mat = new THREE.ShaderMaterial({
  uniforms: { uDpr: { value: renderer.getPixelRatio() } },
  vertexShader: /* glsl */`
    attribute float aSize;
    attribute float aAlpha;
    attribute vec3 aColor;
    attribute vec2 aDir;
    attribute float aStr;
    uniform float uDpr;
    varying vec3 vColor;
    varying float vAlpha;
    varying vec2 vDir;
    varying float vStr;
    void main() {
      vColor = aColor;
      vAlpha = aAlpha;
      vDir = aDir;
      vStr = aStr;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float depthScale = 1.0 - position.z * 0.0011;
      // 拉长流线时点精灵要相应放大，否则椭圆会被方形精灵裁掉
      gl_PointSize = max(1.0, aSize * uDpr * depthScale * (1.0 + aStr * 1.9));
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vColor;
    varying float vAlpha;
    varying vec2 vDir;
    varying float vStr;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      // 旋转到运动方向，并把垂直方向压窄 → 圆点变流线（静止画面也能看出流向）
      vec2 perp = vec2(-vDir.y, vDir.x);
      vec2 q = vec2(dot(p, vDir), dot(p, perp) * (1.0 + vStr * 3.4));
      float d = length(q);
      if (d > 1.0) discard;
      float core = pow(1.0 - d, 2.6);
      float halo = pow(1.0 - d, 1.1) * 0.20;
      float g = core + halo;
      gl_FragColor = vec4(vColor * g * vAlpha, 1.0);
    }`,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

const points = new THREE.Points(geo, mat);
points.frustumCulled = false;
scene.add(points);

// 窗口前沿高光线（4 个角，随 pe 外扩）——粒子和 clip 的对齐基准
const fg = new Float32Array(12);
const fgGeo = new THREE.BufferGeometry();
fgGeo.setAttribute('position', new THREE.BufferAttribute(fg, 3).setUsage(THREE.DynamicDrawUsage));
const fgMat = new THREE.LineBasicMaterial({
  color: 0x9fe6ff, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending,
});
const frontier = new THREE.LineLoop(fgGeo, fgMat);
frontier.frustumCulled = false;
scene.add(frontier);

/* ============================ 时间轴 ============================ */
let now = 0;        // 出生时间轴（ms）
let animT = 0;      // 环流动画时间（秒），与 now 解耦
let dir = 1;        // +1 生长 / -1 收回 / 0 停
let mode = 'birth';
let paused = false;

const pointer = { x: 0, y: 0, on: false, t: 0 };

function peOf(t) {
  if (t <= SEED_MS) return 0;
  // smoothstep 而不是 easeInOutCubic：后者在起步段是 t³，窗口会在"点"上滞留一秒多
  return smoothstep(0, 1, clamp((t - SEED_MS) / BIRTH_MS, 0, 1));
}

/* ============================ 矩形周长 ============================ */
const rp = { x: 0, y: 0, nx: 0, ny: 0 };
function rectAt(uu, hw2, hh2, out) {
  const w = hw2 * 2, h = hh2 * 2, P = 2 * (w + h);
  if (P <= 1e-6) { out.x = 0; out.y = 0; out.nx = 0; out.ny = 1; return out; }
  let s = (uu % 1 + 1) % 1 * P;
  if (s < w) { out.x = -hw2 + s; out.y = hh2; out.nx = 0; out.ny = 1; }
  else if (s < w + h) { s -= w; out.x = hw2; out.y = hh2 - s; out.nx = 1; out.ny = 0; }
  else if (s < 2 * w + h) { s -= w + h; out.x = hw2 - s; out.y = -hh2; out.nx = 0; out.ny = -1; }
  else { s -= 2 * w + h; out.x = -hw2; out.y = -hh2 + s; out.nx = -1; out.ny = 0; }
  return out;
}

/* ============================ 物理一帧 ============================ */
const PK = 3;               // 脉冲包数量
let statMeanErr = 0;

function simulate(dt, pe) {
  const hw2 = hw * pe, hh2 = hh * pe;
  const P = 2 * (2 * hw2 + 2 * hh2);
  const birthing = pe < 0.999;
  const collapsed = pe <= 0.002;
  // 生长阶段刚度极高：响应时间常数 ≈ K/C ≈ 0.1s、速度滞后 ≈ 前沿速度/C ≈ 6px，
  // 粒子才真正"贴"在可见边缘上；否则会被拖到窗口里面几十像素，像窗口自己在跑。
  const K = collapsed ? 1500 : birthing ? 680 : 46;
  const C = collapsed ? 190 : birthing ? 72 : 13;
  const t = animT;
  // 环流只在框架基本成形后启动
  const flowOn = smoothstep(0.55, 0.98, pe) * FLOW;
  // 法向偏移随 pe 展开：聚点阶段所有粒子必须真的挤在一点
  const oScale = 0.12 + 0.88 * pe;

  let errSum = 0, errN = 0;

  for (let i = 0; i < N; i++) {
    const kd = kind[i];
    let tx = 0, ty = 0;
    let pen = 0; // 侵入深度（像素），用于在窗口内淡出

    if (collapsed) {
      // 聚点：所有粒子向中心收拢（带一点随机半径，避免数学上的奇点）
      tx = Math.sin(jit[i] * 7.1) * 2.5;
      ty = Math.cos(jit[i] * 5.3) * 2.5;
    } else if (kd === KIND_RIDER || kd === KIND_HALO) {
      // 环流：u 匀速推进，周长随 pe 变化 → 用当前周长换算 du
      if (P > 4) uPar[i] += (spd[i] * flowOn * dt) / P;
      const wob = Math.sin(t * jf[i] + jit[i]) * jamp[i] * oScale;
      rectAt(uPar[i], hw2, hh2, rp);
      tx = rp.x + rp.nx * (off[i] * oScale + wob);
      ty = rp.y + rp.ny * (off[i] * oScale + wob);
      if (kd === KIND_HALO) {
        tx += Math.cos(t * 0.7 + jit[i]) * 3.5;
        ty += Math.sin(t * 0.9 + jit[i] * 1.7) * 3.5;
      } else {
        // 切线方向（u 增大方向）= (ny, -nx)，再按粒子自身的环流方向取反
        const sg = spd[i] > 0 ? 1 : -1;
        aDir[i * 2] = rp.ny * sg;
        aDir[i * 2 + 1] = rp.nx * sg;   // 屏幕 y 向下，世界切线 y 要取反
      }
    } else {
      // 侵入：从边框向内漂移，进入窗口后淡出 = 被页面"吸"进去
      inT[i] += inRate[i] * dt * FLOW;
      if (inT[i] > 1) {
        // 循环重置：位置直接放回边框（重置点落在窗口内部，看不见）
        inT[i] = 0;
        uPar[i] = Math.random();
        rectAt(uPar[i], hw2, hh2, rp);
        pos[i * 3] = rp.x + rp.nx * (2 + Math.random() * 6);
        pos[i * 3 + 1] = rp.y + rp.ny * (2 + Math.random() * 6);
        vel[i * 2] = -rp.nx * 60;
        vel[i * 2 + 1] = -rp.ny * 60;
      }
      rectAt(uPar[i], hw2, hh2, rp);
      aDir[i * 2] = -rp.nx; aDir[i * 2 + 1] = rp.ny;
      pen = inT[i] * inDepth[i] * Math.min(1, pe * 1.2);
      tx = rp.x + rp.nx * (off[i] * oScale - pen);
      ty = rp.y + rp.ny * (off[i] * oScale - pen);
    }

    tgtX[i] = tx; tgtY[i] = ty;

    // 弹簧 + 阻尼
    const x = pos[i * 3], y = pos[i * 3 + 1];
    const kk = K * ks[i];
    let ax = (tx - x) * kk;
    let ay = (ty - y) * kk;

    // 鼠标扰动（只在窗口外的余量区 / 同源 iframe 内可捕获）
    if (pointer.on) {
      const dx = x - pointer.x, dy = y - pointer.y;
      const d2 = dx * dx + dy * dy;
      const R = 170;
      if (d2 < R * R && d2 > 1) {
        const d = Math.sqrt(d2);
        const f = (1 - d / R) * 1500;
        ax += (dx / d) * f;
        ay += (dy / d) * f;
      }
    }

    /* 半隐式阻尼 v ← (v + a·dt)/(1 + c·dt)：
       显式写法 v += (a - c·v)·dt 在 c·dt 接近 2 时会数值发散（本项目实测炸到 1e22），
       隐式写法无条件稳定，且稳态滞后仍 ≈ 目标速度/c，可直接用 c 调"拖尾长度"。 */
    const damp = 1 / (1 + C * dt);
    let vx = (vel[i * 2] + ax * dt) * damp;
    let vy = (vel[i * 2 + 1] + ay * dt) * damp;
    if (!isFinite(vx) || Math.abs(vx) > 8000) vx = 0;
    if (!isFinite(vy) || Math.abs(vy) > 8000) vy = 0;
    vel[i * 2] = vx; vel[i * 2 + 1] = vy;

    let nxp = x + vx * dt, nyp = y + vy * dt;
    if (!isFinite(nxp) || Math.abs(nxp) > 20000) nxp = tx;
    if (!isFinite(nyp) || Math.abs(nyp) > 20000) nyp = ty;
    pos[i * 3] = nxp;
    pos[i * 3 + 1] = nyp;

    // ---- 亮度 / 尺寸 ----
    let a = baseA[i];
    // 聚点期总通量受控，避免 5200 粒叠成死白
    // 窗口越小周长越短，同样粒子数叠起来就越白 → 亮度按 pe² 补偿，控制屏幕总通量
    a *= 0.16 + 0.84 * pe * pe;
    // 深度衰减
    a *= 0.55 + 0.45 * (zN[i] * 0.5 + 0.5);
    // 环流脉冲包
    let pk = 0;
    if (kd === KIND_RIDER && pe > 0.2) {
      for (let p = 0; p < PK; p++) {
        const pu = (t * 0.062 + p / PK) % 1;
        let du = Math.abs(uPar[i] - pu);
        if (du > 0.5) du = 1 - du;
        if (du < 0.09) pk = Math.max(pk, Math.exp(-(du / 0.03) * (du / 0.03)));
      }
      a *= 1 + 2.4 * pk;
    }
    if (kd === KIND_HALO) a *= 0.35 + 0.65 * smoothstep(0.3, 0.9, pe);
    // 侵入粒子进入窗口后淡出（画布在 iframe 之上，没有遮挡可依赖）
    if (kd === KIND_INTR) a *= 1 - smoothstep(1, 16, pen);
    if (pointer.on) {
      const dx = x - pointer.x, dy = y - pointer.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 190) a *= 1 + 1.1 * (1 - d / 190);
    }
    aAlpha[i] = clamp(a, 0, 2);

    let s = baseS[i] * (0.55 + 0.45 * smoothstep(0, 0.45, pe));
    s *= 0.85 + 0.3 * (zN[i] * 0.5 + 0.5);
    s *= 1 + 0.55 * pk;
    aSize[i] = s;

    if (kd === KIND_RIDER && !birthing) { errSum += Math.hypot(x - tx, y - ty); errN++; }
  }
  statMeanErr = errN ? errSum / errN : 0;
}

/* ============================ 窗口揭示 ============================ */
let lastPe = -1, lastPeC = -1;
function applyReveal(peClip, peLine) {
  const hw2 = hw * peLine, hh2 = hh * peLine;

  if (Math.abs(peLine - lastPe) > 2e-4 || Math.abs(peClip - lastPeC) > 2e-4) {
    lastPe = peLine; lastPeC = peClip;

    // 窗口 = 直接等比放大到 pe（内容跟着窗口一起长，像一扇窗从点里撑开）
    // 到位后去掉 transform：让 iframe 回到 1:1 光栅化，文字最锐
    if (peClip > 0.9985) {
      portal.style.transform = '';
      portal.style.willChange = 'auto';
    } else {
      portal.style.transform = `scale(${Math.max(peClip, 0.0001).toFixed(4)})`;
      portal.style.willChange = 'transform';
    }
    portal.style.visibility = peClip < 0.004 ? 'hidden' : 'visible';
    frame.style.opacity = (0.05 + 0.95 * smoothstep(0.01, 0.3, peClip)).toFixed(3);
    const blur = (1 - smoothstep(0.06, 0.62, peClip)) * 5.5;
    frame.style.filter = blur > 0.12 ? `blur(${blur.toFixed(2)}px)` : 'none';
  }

  // 前沿高光线：跟着**粒子**走（略前于 clip，形成一圈在窗口外侧的亮边）
  fg[0] = -hw2; fg[1] = -hh2;
  fg[3] = hw2; fg[4] = -hh2;
  fg[6] = hw2; fg[7] = hh2;
  fg[9] = -hw2; fg[10] = hh2;
  fgGeo.attributes.position.needsUpdate = true;
  fgMat.opacity = peLine <= 0.002 ? 0 : 0.18 + 0.34 * smoothstep(0, 0.5, peLine);
}

/* ============================ 主循环 ============================ */
const clock = { last: performance.now(), fps: 0, acc: 0, frames: 0 };

function tick(dt) {
  if (dir > 0) {
    now = Math.min(T_END, now + dt * 1000);
    if (now >= T_END) mode = 'live';
  } else if (dir < 0) {
    now = Math.max(0, now - dt * 1000 * COL_SPEED);
    if (now <= 0) { dir = 0; mode = 'seed'; }
  }
  animT += dt;
  const pe = peOf(now);
  simulate(dt, pe);
  // 窗口比粒子前沿晚 30ms 揭开：让粒子始终"贴着/略领先"可见边缘
  applyReveal(peOf(Math.max(0, now - 30)), pe);
}

function render() {
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.attributes.aSize.needsUpdate = true;
  points.geometry.attributes.aAlpha.needsUpdate = true;
  points.geometry.attributes.aDir.needsUpdate = true;
  points.geometry.attributes.aStr.needsUpdate = true;
  renderer.render(scene, camera);
}

function loop(ts) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, Math.max(0, (ts - clock.last) / 1000));
  clock.last = ts;
  if (!paused) {
    // 大 dt（切后台回来）拆成若干小步，保证弹簧稳定
    let left = dt;
    while (left > 1e-4) { const h = Math.min(left, 1 / 60); tick(h); left -= h; }
  }
  render();
  clock.acc += dt; clock.frames++;
  if (clock.acc > 0.5) {
    clock.fps = Math.round(clock.frames / clock.acc);
    clock.acc = 0; clock.frames = 0;
    updateStat();
  }
}

function updateStat() {
  const pe = peOf(now);
  const a = $('stat');
  if (a) a.textContent = `${String(clock.fps).padStart(3, ' ')} fps · ${Math.round(pe * 100)}%`;
}

/* ============================ 交互 ============================ */
function replay() {
  now = 0; dir = 1; mode = 'birth'; paused = false;
  clock.last = performance.now();
}

function collapse() {
  if (now <= 0) return;
  dir = -1; mode = 'collapse'; paused = false;
  clock.last = performance.now();
}

addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') replay();
  else if (e.key === 'Escape') collapse();
});

$('replay').addEventListener('click', replay);
$('collapse').addEventListener('click', collapse);
$('flow').addEventListener('input', (e) => { FLOW = clamp(parseInt(e.target.value, 10) / 100, 0, 3); });
$('load').addEventListener('click', () => {
  const v = $('url').value.trim();
  if (!v) return;
  frame.src = /^https?:\/\//i.test(v) ? v : './' + v.replace(/^\.?\//, '');
  replay();
});
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('load').click(); });

addEventListener('mousemove', (e) => {
  pointer.x = e.clientX - W / 2;
  pointer.y = H / 2 - e.clientY;
  pointer.on = true;
});
addEventListener('mouseleave', () => { pointer.on = false; });

// 同源 iframe 内的鼠标也能驱动（跨域会被浏览器拦住，忽略即可）
frame.addEventListener('load', () => {
  try {
    const doc = frame.contentWindow.document;
    doc.addEventListener('mousemove', (e) => {
      const r = portal.getBoundingClientRect();
      pointer.x = r.left + e.clientX - W / 2;
      pointer.y = H / 2 - (r.top + e.clientY);
      pointer.on = true;
    });
  } catch (err) { /* 跨域：只保留余量区的鼠标响应 */ }
});

addEventListener('resize', () => {
  layout();
  camera.updateProjectionMatrix();
  lastPe = -1; lastPeC = -1;
  applyReveal(peOf(now), peOf(now));
  render();
});

/* ============================ 启动 ============================ */
layout();
initParticles();
frame.src = IF_URL;
applyReveal(0, 0);

// 无条件先算一帧，防止 freeze 时首帧空白
simulate(1 / 60, peOf(now));
applyReveal(peOf(now), peOf(now));
render();

if (AT > 0) {
  // 同步预热：以固定步长把物理推进到目标时刻（无头环境不依赖 rAF）
  const steps = Math.round((AT * 1000) / (1000 / 60));
  for (let i = 0; i < steps; i++) tick(1 / 60);
  paused = FREEZE;
  render();
}

if (SELFTEST) {
  const pe = peOf(now);
  const panel = $('selftest');
  panel.hidden = false;
  panel.innerHTML =
    `<b>粒子门自检</b>\n` +
    `粒子数 <b>${N}</b>　骨架环流 <b>${Math.round(N * 0.68)}</b>　光晕 <b>${Math.round(N * 0.24)}</b>　侵入 <b>${Math.round(N * 0.08)}</b>\n` +
    `时间轴 <b>${Math.round(now)}ms</b> / ${T_END}ms　pe <b>${pe.toFixed(3)}</b>\n` +
    `窗口 <b>${rw}×${rh}</b> @ ${Math.round((W - rw) / 2)},${Math.round((H - rh) / 2)}　视口 ${W}×${H}\n` +
    `前沿矩形 <b>${Math.round(hw * pe * 2)}×${Math.round(hh * pe * 2)}</b>　窗口 scale <b>${pe.toFixed(3)}</b>\n` +
    `环流平均偏差 <b>${statMeanErr.toFixed(2)}px</b>　${paused ? '定格' : '运行中'}`;
  // eslint-disable-next-line no-console
  console.log('[portal-selftest]', JSON.stringify({
    n: N, now: Math.round(now), pe: +pe.toFixed(3), rw, rh, err: +statMeanErr.toFixed(2),
  }));
}

$('loading').classList.add('hide');

window.PORTAL = {
  get now() { return now; },
  get pe() { return peOf(now); },
  get err() { return statMeanErr; },
  get fps() { return clock.fps; },
  replay, collapse,
  setFlow: (v) => { FLOW = clamp(v, 0, 3); },
  // 诊断：抽样若干粒子的位置/目标/透明度/尺寸
  dump(k = 4) {
    const out = [];
    for (let i = 0; i < N && out.length < k; i += Math.floor(N / k)) {
      out.push({
        k: kind[i],
        p: [+pos[i * 3].toFixed(1), +pos[i * 3 + 1].toFixed(1)],
        t: [+tgtX[i].toFixed(1), +tgtY[i].toFixed(1)],
        a: +aAlpha[i].toFixed(3),
        s: +aSize[i].toFixed(2),
      });
    }
    return out;
  },
};

requestAnimationFrame(loop);
