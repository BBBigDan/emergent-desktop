/**
 * 粒子门 · iframe 包裹试验
 * ---------------------------------------------------------------------------
 * 叙事（v0.16）：
 *   1. 收拢      0 – 700ms      散云 → 一个小粒子团，团里的粒子已经在绕圈流动
 *   2. 生长      700 – 5700ms   团缓缓扩大：正圆 → 圆角矩形，直到与窗口边界重合
 *   3. 浮现      pe ≥ 0.90      iframe 在原位淡入（不缩放、不裁切，字始终 1:1 锐利）
 *   4. 散开      Esc            粒子拿到径向外速当场炸开，iframe 同时淡出
 *
 * 几何：目标形状是**圆角矩形**，由 (半宽, 半高, 圆角半径) 三个量完全描述。
 *   - 小尺寸时取正方 + 圆角=半径 → 是一个正圆，所以"点"不扁
 *   - 大尺寸时渐变为窗口比例 + 18px 圆角 → 与 iframe 的 border-radius 严格对齐
 *   - 周长参数化按四直边 + 四圆弧解析求解，粒子沿弧长均匀分布，不会在角上堆积
 *
 * 为什么不用 transform:scale / clip-path 揭窗：
 *   scale 会把字跟着放大再缩回，中途一直糊；clip 只能从中心开洞，像窥视孔。
 *   opacity 淡入完全不碰内容的栅格化，是这三种里唯一"字始终清晰"的。
 *
 * 深链：?at=1.2&freeze=1  同步预热到 1.2s 并定格（无头截图复现用）
 *      ?url=...  ?n=5200  ?flow=1  ?selftest=1  ?play=1
 */
import * as THREE from 'three';

/* ============================ 小工具 ============================ */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const qs = new URLSearchParams(location.search);
const IF_URL = qs.get('url') || 'demo-dashboard.html';
const N = clamp(parseInt(qs.get('n') || '9000', 10) || 9000, 1200, 16000);
let FLOW = clamp(parseFloat(qs.get('flow') || '1') || 1, 0, 3);
const AT = parseFloat(qs.get('at') || '0') || 0;
const FREEZE = qs.get('freeze') === '1' || (AT > 0 && qs.get('play') !== '1');
const SELFTEST = qs.get('selftest') === '1';

const SEED_MS = 700;        // 收拢
const GROW_MS = 4600;       // 生长（要慢）
const T_END = SEED_MS + GROW_MS;
const PE_MIN = 0.019;       // 最小尺寸（半高 ≈ 视口高 × 0.019）
const REVEAL_A = 0.86;      // iframe 开始浮现的 pe
const REVEAL_B = 0.995;
const SCATTER_FADE = 0.48;  // iframe 淡出时长（秒）
const SCATTER_LIFE = 1.70;  // 粒子散尽时长（秒）
const VMAX = 9000;

/* ============================ 布局 ============================ */
const portal = $('portal');
const frame = $('frame');

let W = 0, H = 0, rw = 0, rh = 0, hw = 0, hh = 0;
let camera, renderer;

const canvas = $('scene');

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
  const mx = W < 900 ? 0.045 : 0.062;
  const my = H < 640 ? 0.055 : 0.078;
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

const rnd = new Float32Array(N);      // 固定随机数（小点阶段的稀疏化阈值）
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
    rnd[i] = Math.random();
    jit[i] = Math.random() * Math.PI * 2;
    jf[i] = 0.7 + Math.random() * 2.6;
    zN[i] = Math.random() * 2 - 1;

    if (k === KIND_RIDER) {
      off[i] = (Math.random() * 2 - 1) * (2 + Math.pow(Math.random(), 1.8) * 15);
      aStr[i] = 0.5 + Math.random() * 0.5;
      spd[i] = (150 + Math.random() * 210) * (Math.random() < 0.94 ? 1 : -1);
      ks[i] = 0.75 + Math.random() * 0.55;
      jamp[i] = 0.6 + Math.random() * 1.9;
      baseA[i] = 0.55 + Math.random() * 0.42;
      baseS[i] = 2.0 + Math.random() * 2.2;
      if (Math.random() < 0.08) { baseS[i] += 1.4; baseA[i] = Math.min(1, baseA[i] + 0.25); }
    } else if (k === KIND_HALO) {
      off[i] = 22 + Math.pow(Math.random(), 1.5) * 88;
      aStr[i] = 0;
      spd[i] = (60 + Math.random() * 110) * (Math.random() < 0.85 ? 1 : -1);
      ks[i] = 0.35 + Math.random() * 0.4;
      jamp[i] = 2 + Math.random() * 6;
      baseA[i] = 0.18 + Math.random() * 0.26;
      baseS[i] = 1.3 + Math.random() * 1.9;
    } else {
      off[i] = 1 + Math.random() * 8;
      aStr[i] = 0.6;
      spd[i] = 0;
      ks[i] = 1.1 + Math.random() * 0.5;
      jamp[i] = 0.8 + Math.random() * 1.6;
      baseA[i] = 0.45 + Math.random() * 0.4;
      baseS[i] = 1.3 + Math.random() * 1.5;
      inT[i] = Math.random();
      inRate[i] = 0.22 + Math.random() * 0.35;
      inDepth[i] = 70 + Math.random() * 190;
    }

    aDir[i * 2] = 1; aDir[i * 2 + 1] = 0;

    const c = pickPal();
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];

    seedPosition(i);
  }
}

// 开场散云：从屏幕四面八方向中心收拢
function seedPosition(i) {
  const th = Math.random() * Math.PI * 2;
  const cph = Math.random() * 2 - 1;
  const sph = Math.sqrt(Math.max(0, 1 - cph * cph));
  const R = Math.min(W, H) * (0.55 + Math.random() * 0.45);
  pos[i * 3] = Math.cos(th) * sph * R * (W / H) * 0.95;
  pos[i * 3 + 1] = Math.sin(th) * sph * R;
  pos[i * 3 + 2] = cph * R * 0.75;
  vel[i * 2] = 0; vel[i * 2 + 1] = 0;
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

/* ============================ 圆角矩形周长参数化 ============================ */
const SH = { x: 0, y: 0, nx: 0, ny: 0, tx: 0, ty: 0 };

function shapePerim(a, b, r) {
  r = clamp(r, 0, Math.min(a, b));
  return 4 * (a - r) + 4 * (b - r) + 2 * Math.PI * r;
}

/**
 * 沿圆角矩形边界按弧长取点。
 * u ∈ [0,1)，起点在顶边右端，顺时针（屏幕视角）绕行。
 * out.nx/ny 为**外法向**（世界坐标，y 向上），out.tx/ty 为沿 u 增大的**切线**。
 */
function shapeAt(uu, a, b, r, out) {
  r = clamp(r, 0, Math.min(a, b));
  const Lh = a - r, Lv = b - r;
  const Lt = 2 * Lh, Ls = 2 * Lv, Lc = Math.PI * 0.5 * r;
  const P = 2 * Lt + 2 * Ls + 4 * Lc;
  if (P < 1e-6) { out.x = 0; out.y = 0; out.nx = 0; out.ny = 1; out.tx = -1; out.ty = 0; return out; }
  const ir = r > 1e-6 ? 1 / r : 0;
  let s = ((uu % 1) + 1) % 1 * P;

  if (s < Lt) {                                   // 顶边：x 递减
    out.x = Lh - s; out.y = b;
    out.nx = 0; out.ny = 1; out.tx = -1; out.ty = 0; return out;
  }
  s -= Lt;
  if (s < Lc) {                                   // 左上角
    const th = Math.PI * 0.5 + s * ir, c = Math.cos(th), sn = Math.sin(th);
    out.x = -Lh + r * c; out.y = Lv + r * sn;
    out.nx = c; out.ny = sn; out.tx = -sn; out.ty = c; return out;
  }
  s -= Lc;
  if (s < Ls) {                                   // 左边：y 递减
    out.x = -a; out.y = Lv - s;
    out.nx = -1; out.ny = 0; out.tx = 0; out.ty = -1; return out;
  }
  s -= Ls;
  if (s < Lc) {                                   // 左下角
    const th = Math.PI + s * ir, c = Math.cos(th), sn = Math.sin(th);
    out.x = -Lh + r * c; out.y = -Lv + r * sn;
    out.nx = c; out.ny = sn; out.tx = -sn; out.ty = c; return out;
  }
  s -= Lc;
  if (s < Lt) {                                   // 底边：x 递增
    out.x = -Lh + s; out.y = -b;
    out.nx = 0; out.ny = -1; out.tx = 1; out.ty = 0; return out;
  }
  s -= Lt;
  if (s < Lc) {                                   // 右下角
    const th = Math.PI * 1.5 + s * ir, c = Math.cos(th), sn = Math.sin(th);
    out.x = Lh + r * c; out.y = -Lv + r * sn;
    out.nx = c; out.ny = sn; out.tx = -sn; out.ty = c; return out;
  }
  s -= Lc;
  if (s < Ls) {                                   // 右边：y 递增
    out.x = a; out.y = -Lv + s;
    out.nx = 1; out.ny = 0; out.tx = 0; out.ty = 1; return out;
  }
  s -= Ls;
  {                                               // 右上角
    const th = s * ir, c = Math.cos(th), sn = Math.sin(th);
    out.x = Lh + r * c; out.y = Lv + r * sn;
    out.nx = c; out.ny = sn; out.tx = -sn; out.ty = c; return out;
  }
}

/* 当前尺寸下的形状三件套 */
const shape = { ax: 0, ay: 0, r: 0, P: 0, vScale: 1, spread: 0 };
function computeShape(pe) {
  // 小尺寸用 1:1 正方（否则"点"会被拉成扁椭圆），随尺寸过渡到窗口比例
  const aspectT = smoothstep(PE_MIN, 0.50, pe);
  const base = Math.min(hw, hh) * pe;
  shape.ax = lerp(base, hw * pe, aspectT);
  shape.ay = lerp(base, hh * pe, aspectT);
  // 圆角：小尺寸 = 半径（正圆）→ 大尺寸 = 18px（与 iframe 的 border-radius 对齐）
  const cornerT = smoothstep(PE_MIN, 0.55, pe);
  shape.r = lerp(Math.min(shape.ax, shape.ay), 18, cornerT);
  shape.P = shapePerim(shape.ax, shape.ay, shape.r);
  // 周长越短，同样的 px/s 绕圈越快 → 按 sqrt(周长比) 降速，小点才不会转成频闪
  const Pfull = 2 * (2 * hw + 2 * hh);
  shape.vScale = clamp(Math.sqrt(shape.P / Math.max(Pfull, 1)), 0.05, 1);
  shape.spread = 1 - smoothstep(PE_MIN, 0.34, pe);   // 1 = 还是个小团
  return shape;
}

/* ============================ 时间轴 ============================ */
let now = 0;        // 出生时间轴（ms）
let animT = 0;      // 环流动画时间（秒），与 now 解耦
let mode = 'birth';
let paused = false;
let scattering = false;
let scatterT = 0;

const pointer = { x: 0, y: 0, on: false };

function peOf(t) {
  if (t <= SEED_MS) return PE_MIN;
  const u = clamp((t - SEED_MS) / GROW_MS, 0, 1);
  // 前 18% 只挪一点点：小团先自己流动一会儿，再开始"缓慢扩大"
  const f = u < 0.18
    ? 0.06 * smoothstep(0, 1, u / 0.18)
    : 0.06 + 0.94 * smoothstep(0, 1, (u - 0.18) / 0.82);
  return PE_MIN + (1 - PE_MIN) * f;
}

function revealOf(pe) {
  return smoothstep(REVEAL_A, REVEAL_B, pe);
}

/* ============================ 物理一帧 ============================ */
const PK = 3;               // 脉冲包数量
let statMeanErr = 0;

function simulate(dt, pe) {
  const t = animT;
  const sh = computeShape(pe);
  const { ax, ay, r: rr, P, vScale, spread } = sh;

  const birthing = pe < 0.9995;
  const seeding = now <= SEED_MS;
  // 收拢期要"拉得回来"（阻尼大，避免远处粒子被 clamp 卡住），
  // 生长期要"贴得紧"（刚度高，滞后 ≈ 前沿速度/C ≈ 6px）
  // 稳态滞后 = v·C/K：46/13 时环流 250px/s 会落后 70px，粒子整体飘在窗口外一层；
  // 90/17 压到 ~47px，既贴边又保留一点柔软（阻尼比 ≈0.9，接近临界）
  const K = birthing ? (seeding ? 620 : 560) : 90;
  const C = birthing ? (seeding ? 170 : 64) : 17;
  const haloScale = lerp(0.42, 1, smoothstep(PE_MIN, 0.42, pe));
  const penScale = smoothstep(0.22, 0.80, pe);

  let errSum = 0, errN = 0;

  for (let i = 0; i < N; i++) {
    const kd = kind[i];
    let tx = 0, ty = 0;
    let pen = 0; // 侵入深度（像素），用于在窗口内淡出

    if (kd === KIND_RIDER || kd === KIND_HALO) {
      // 环流：u 匀速推进，周长变化时用当前周长换算 du（小团降速）
      uPar[i] += (spd[i] * FLOW * vScale * dt) / Math.max(P, 6);
      shapeAt(uPar[i], ax, ay, rr, SH);

      // 小团阶段把法向厚度撑开：9000 个点挤在 30px 的圈上必然是死白一团，
      // 摊成直径 150~200px 的蓬松球，才看得出"里面在流动"
      const o = kd === KIND_HALO ? off[i] * haloScale : off[i] * (1 + 0.55 * spread);
      const wob = Math.sin(t * jf[i] + jit[i]) * jamp[i] * (0.30 + 0.70 * (1 - spread));
      tx = SH.x + SH.nx * (o + wob);
      ty = SH.y + SH.ny * (o + wob);

      if (kd === KIND_HALO) {
        tx += Math.cos(t * 0.7 + jit[i]) * 3.5;
        ty += Math.sin(t * 0.9 + jit[i] * 1.7) * 3.5;
      } else {
        // 切线 → 屏幕空间（屏幕 y 向下，取反）
        const sg = spd[i] > 0 ? 1 : -1;
        aDir[i * 2] = SH.tx * sg;
        aDir[i * 2 + 1] = -SH.ty * sg;
      }
    } else {
      // 侵入：从边框向内漂移，进入窗口后淡出 = 被页面"吸"进去
      inT[i] += inRate[i] * dt * FLOW;
      if (inT[i] > 1) {
        inT[i] = 0;
        uPar[i] = Math.random();
        shapeAt(uPar[i], ax, ay, rr, SH);
        pos[i * 3] = SH.x + SH.nx * (2 + Math.random() * 6);
        pos[i * 3 + 1] = SH.y + SH.ny * (2 + Math.random() * 6);
        vel[i * 2] = -SH.nx * 60;
        vel[i * 2 + 1] = -SH.ny * 60;
      }
      shapeAt(uPar[i], ax, ay, rr, SH);
      aDir[i * 2] = -SH.nx; aDir[i * 2 + 1] = SH.ny;
      pen = inT[i] * inDepth[i] * penScale;
      const o2 = off[i] * (1 + 0.55 * spread);
      tx = SH.x + SH.nx * (o2 - pen);
      ty = SH.y + SH.ny * (o2 - pen);
    }

    tgtX[i] = tx; tgtY[i] = ty;

    // 弹簧 + 半隐式阻尼
    const x = pos[i * 3], y = pos[i * 3 + 1];
    const kk = K * ks[i];
    let axl = (tx - x) * kk;
    let ayl = (ty - y) * kk;

    if (pointer.on) {
      const dx = x - pointer.x, dy = y - pointer.y;
      const d2 = dx * dx + dy * dy;
      const R = 170;
      if (d2 < R * R && d2 > 1) {
        const d = Math.sqrt(d2);
        const f = (1 - d / R) * 1500;
        axl += (dx / d) * f;
        ayl += (dy / d) * f;
      }
    }

    /* 半隐式阻尼 v ← (v + a·dt)/(1 + c·dt)：
       显式写法 v += (a - c·v)·dt 在 c·dt 接近 2 时会数值发散（本项目实测炸到 1e22）。
       速度超限时是 clamp 而不是清零——清零会让"从屏幕外拉回"的粒子永久卡死。 */
    const damp = 1 / (1 + C * dt);
    let vx = clamp((vel[i * 2] + axl * dt) * damp, -VMAX, VMAX);
    let vy = clamp((vel[i * 2 + 1] + ayl * dt) * damp, -VMAX, VMAX);
    if (!isFinite(vx)) vx = 0;
    if (!isFinite(vy)) vy = 0;
    vel[i * 2] = vx; vel[i * 2 + 1] = vy;

    let nxp = x + vx * dt, nyp = y + vy * dt;
    if (!isFinite(nxp) || Math.abs(nxp) > 20000) nxp = tx;
    if (!isFinite(nyp) || Math.abs(nyp) > 20000) nyp = ty;
    pos[i * 3] = nxp;
    pos[i * 3 + 1] = nyp;

    // ---- 亮度 / 尺寸 ----
    let a = baseA[i];
    // 周长越小，同样粒子数叠得越白 → 按 pe 压低总通量（小团阶段 ≈ 0.2 倍）
    a *= 0.45 + 0.55 * Math.pow(pe, 1.10);
    if (spread > 0.01) {
      const vis = rnd[i] < 0.42 ? 1 : 0.20;
      a *= lerp(1, vis, spread);
    }
    a *= 0.55 + 0.45 * (zN[i] * 0.5 + 0.5);
    let pk = 0;
    if (kd === KIND_RIDER && pe > 0.15) {
      for (let p = 0; p < PK; p++) {
        const pu = (t * 0.062 + p / PK) % 1;
        let du = Math.abs(uPar[i] - pu);
        if (du > 0.5) du = 1 - du;
        if (du < 0.09) pk = Math.max(pk, Math.exp(-(du / 0.03) * (du / 0.03)));
      }
      a *= 1 + 2.4 * pk;
    }
    if (kd === KIND_HALO) a *= 0.45 + 0.55 * smoothstep(0.25, 0.85, pe);
    if (kd === KIND_INTR) a *= 1 - smoothstep(1, 16, pen);
    if (pointer.on) {
      const dx = x - pointer.x, dy = y - pointer.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 190) a *= 1 + 1.1 * (1 - d / 190);
    }
    aAlpha[i] = clamp(a, 0, 2);

    let s = baseS[i] * (0.62 + 0.38 * smoothstep(PE_MIN, 0.45, pe));
    s *= 0.85 + 0.3 * (zN[i] * 0.5 + 0.5);
    s *= 1 + 0.55 * pk;
    aSize[i] = s;

    if (kd === KIND_RIDER && !birthing) { errSum += Math.hypot(x - tx, y - ty); errN++; }
  }
  statMeanErr = errN ? errSum / errN : 0;
}

/* ============================ 散开 ============================ */
function beginScatter() {
  if (scattering) return;
  scattering = true;
  scatterT = 0;
  mode = 'scatter';
  paused = false;
  clock.last = performance.now();

  for (let i = 0; i < N; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1];
    const d = Math.hypot(x, y);
    const bx = d > 1 ? x / d : Math.cos(jit[i]);
    const by = d > 1 ? y / d : Math.sin(jit[i]);
    // 严格径向会像机械的冲击波，掺一点角向扰动；
    // 速度随距离递增 → 整体像一圈被"炸开"的壳，而不是平行平移
    // 窗口占了 88% 的屏幕，边框离屏幕边只剩 ~45px —— 全往外飞的话 80ms 就全出界，
    // 看着像"啪"一下消失。所以一半粒子反向穿过窗口内部飞，屏幕才留得住这场爆炸。
    const sgn = Math.random() < 0.5 ? 1 : -1;
    const ang = Math.atan2(by * sgn, bx * sgn) + (Math.random() - 0.5) * 1.05;
    const sp = 170 + Math.min(d, 900) * 0.35 + Math.random() * 340;
    vel[i * 2] = Math.cos(ang) * sp;
    vel[i * 2 + 1] = Math.sin(ang) * sp;
  }
}

function scatterStep(dt) {
  const damp = 1 / (1 + 0.90 * dt);
  const fade = 1 - smoothstep(0.16, SCATTER_LIFE, scatterT);
  for (let i = 0; i < N; i++) {
    const vx = vel[i * 2] * damp;
    const vy = vel[i * 2 + 1] * damp;
    vel[i * 2] = vx; vel[i * 2 + 1] = vy;
    pos[i * 3] += vx * dt;
    pos[i * 3 + 1] += vy * dt;

    aAlpha[i] = baseA[i] * fade * 1.40;
    aSize[i] = baseS[i] * (0.70 + 0.50 * (1 - fade));
    aStr[i] *= 0.985;                       // 流线逐渐退回圆点
    const sp = Math.hypot(vx, vy);
    if (sp > 1) { aDir[i * 2] = vx / sp; aDir[i * 2 + 1] = -vy / sp; }
  }
}

/* ============================ 窗口揭示 ============================ */
let lastRev = -1;
function applyReveal(rev) {
  if (Math.abs(rev - lastRev) < 1.5e-3) return;
  lastRev = rev;
  portal.style.opacity = rev.toFixed(3);
  portal.style.visibility = rev < 0.003 ? 'hidden' : 'visible';
  // blur 只在很淡时给一次（每帧改 filter 会逼 GPU 反复重绘 iframe）
  portal.style.filter = rev < 0.55 ? 'blur(3px)' : 'none';
}

/* ============================ 主循环 ============================ */
const clock = { last: performance.now(), fps: 0, acc: 0, frames: 0 };

function tick(dt) {
  if (scattering) {
    scatterT += dt;
    scatterStep(dt);
    applyReveal(Math.max(0, 1 - smoothstep(0, SCATTER_FADE, scatterT)));
    return;
  }
  if (now < T_END) {
    now = Math.min(T_END, now + dt * 1000);
    if (now >= T_END) mode = 'live';
  }
  animT += dt;
  const pe = peOf(now);
  simulate(dt, pe);
  applyReveal(revealOf(pe));
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
  const a = $('stat');
  if (!a) return;
  if (scattering) { a.textContent = `${String(clock.fps).padStart(3, ' ')} fps · 散开`; return; }
  const pe = peOf(now);
  a.textContent = `${String(clock.fps).padStart(3, ' ')} fps · ${Math.round(pe * 100)}%`;
}

/* ============================ 交互 ============================ */
function replay() {
  scattering = false;
  scatterT = 0;
  now = 0; mode = 'birth'; paused = false;
  for (let i = 0; i < N; i++) { uPar[i] = Math.random(); seedPosition(i); }
  lastRev = -1;
  applyReveal(0);
  clock.last = performance.now();
}

const collapse = beginScatter;

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
  lastRev = -1;
  applyReveal(scattering ? Math.max(0, 1 - smoothstep(0, SCATTER_FADE, scatterT)) : revealOf(peOf(now)));
  render();
});

/* ============================ 启动 ============================ */
layout();
initParticles();
frame.src = IF_URL;
applyReveal(0);

// 无条件先算一帧，防止 freeze 时首帧空白
simulate(1 / 60, peOf(now));
applyReveal(revealOf(peOf(now)));
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
  const sh = computeShape(pe);
  const panel = $('selftest');
  panel.hidden = false;
  panel.innerHTML =
    `<b>粒子门自检</b>\n` +
    `粒子数 <b>${N}</b>　骨架环流 <b>${Math.round(N * 0.68)}</b>　光晕 <b>${Math.round(N * 0.24)}</b>　侵入 <b>${Math.round(N * 0.08)}</b>\n` +
    `时间轴 <b>${Math.round(now)}ms</b> / ${T_END}ms　pe <b>${pe.toFixed(3)}</b>　模式 <b>${mode}</b>\n` +
    `窗口 <b>${rw}×${rh}</b> @ ${Math.round((W - rw) / 2)},${Math.round((H - rh) / 2)}　视口 ${W}×${H}\n` +
    `形状 <b>${Math.round(sh.ax * 2)}×${Math.round(sh.ay * 2)}</b> r${sh.r.toFixed(1)}　周长 <b>${Math.round(sh.P)}</b>　环流速度 <b>${(sh.vScale * 100).toFixed(0)}%</b>\n` +
    `iframe 不透明度 <b>${revealOf(pe).toFixed(3)}</b>　环流偏差 <b>${statMeanErr.toFixed(2)}px</b>　${paused ? '定格' : '运行中'}`;
  // eslint-disable-next-line no-console
  console.log('[portal-selftest]', JSON.stringify({
    n: N, now: Math.round(now), pe: +pe.toFixed(3), rw, rh,
    ax: Math.round(sh.ax), ay: Math.round(sh.ay), r: +sh.r.toFixed(1),
    rev: +revealOf(pe).toFixed(3), err: +statMeanErr.toFixed(2),
  }));
}

$('loading').classList.add('hide');

window.PORTAL = {
  get now() { return now; },
  get pe() { return peOf(now); },
  get rev() { return revealOf(peOf(now)); },
  get err() { return statMeanErr; },
  get fps() { return clock.fps; },
  get scattering() { return scattering; },
  replay, collapse,
  setFlow: (v) => { FLOW = clamp(v, 0, 3); },
  shape: () => { const s = computeShape(peOf(now)); return { ax: +s.ax.toFixed(1), ay: +s.ay.toFixed(1), r: +s.r.toFixed(1), P: +s.P.toFixed(1) }; },
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
