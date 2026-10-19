/**
 * 粒子场 —— 界面本身就是这些粒子，没有半透明卡片垫底。
 *
 * 这一版的物理是从原型（prototype/src/main.js）搬过来的，不是自己编的：
 *
 *   骨架层 skeleton —— 点阵。**不是**钉死在格点上：每帧被一个相干流场
 *      （fbm value noise，按屏幕坐标采样 → 邻域受力一致）推着走，
 *      弹簧阻尼跟随，因此整片字会像水面一样缓慢起伏 ±1px，永远在活着。
 *   云层 cloud —— 增援。指针在时围着指针公转（半径/相位/角速度逐粒子随机，
 *      内慢外快形成剪切），指针压到控件上时按「离控件中心由近及远」倾泻
 *      进该控件的细网格槽位，控件被粒子灌满 → 变亮变实（这就是"更清楚"），
 *      挤不进去的其余粒子把半径外扩成光晕。
 *   头像光晕 ava —— 贴着头像边缘的三层环流，顶点着色器里算（便宜）。
 *
 * 骨架的流场必须**相干**：如果每个点各抖各的（per-particle sin），看起来
 * 就是噪点闪烁；只有整片一起流动，才像"形"在呼吸。
 */
import * as THREE from 'three';
import { CELL, CELL_R } from './ui.js';

const TAU = Math.PI * 2;
const SKEL_MAX = 6000;   // 骨架点阵容量
const CLOUD_N = 2400;    // 增援云（围着指针转 / 倾泻进控件）
const AVA_N = 1100;      // 头像光晕

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* role → 基础亮度 / 点径系数（索引对齐 ui.js 的 ROLE） */
const ROLE_A = [0, 0.95, 0.66, 0.70, 0.88, 0.84, 0.54, 0.90, 0.60];
const ROLE_S = [0, 1.12, 0.92, 0.96, 1.1, 1.02, 0.9, 1.06, 0.88];

/* role → 所属控件（悬停时该控件的点阵要整体提亮） */
const ROLE_PART = [null, 'name', 'hint', 'input', 'input', 'button', 'input', 'input', 'error'];

/* ─────────────── 工况色谱（原型 TEMP_STOPS，逐字搬过来） ───────────────
 * 点阵的颜色不是固定的淡蓝：色相 = "温度"，冷 → 暖，亮度也跟着涨。
 * UI 模式取的是模拟遥测的均值，会缓慢漂移 —— 所以整片字在电青和洋青之间
 * 轻轻呼吸。写死一个 rgb 等于把这层信息全丢了。 */
const TEMP_STOPS = [
  { at: 0.00, c: [0x44, 0xaa, 0xff] },  // 冰蓝 · 低温
  { at: 0.25, c: [0x2e, 0xe4, 0xd8] },  // 电青
  { at: 0.50, c: [0x18, 0xe0, 0xb9] },  // 洋青
  { at: 0.75, c: [0xb2, 0x77, 0xff] },  // 淡紫
  { at: 1.00, c: [0xff, 0xb0, 0x40] },  // 琥珀 · 高温
];
const _rgb = [0, 0, 0];
function tempColor(temp) {
  const t = clamp(temp, 0, 1);
  let i = 0;
  while (i < TEMP_STOPS.length - 2 && t > TEMP_STOPS[i + 1].at) i++;
  const a = TEMP_STOPS[i], b = TEMP_STOPS[i + 1];
  const f = (t - a.at) / (b.at - a.at);
  for (let k = 0; k < 3; k++) _rgb[k] = (a.c[k] + (b.c[k] - a.c[k]) * f) / 255;
  return _rgb;
}

/* 骨架：弹簧刚度 / 阻尼（px 单位）。k 越大越"钉"，ω=sqrt(k)≈13rad/s，
 * 阻尼比 0.9 —— 略欠阻尼，跟随时有一点点回弹，不是生硬的直给。 */
const SKEL_K = 170;
const SKEL_C = 2 * Math.sqrt(SKEL_K) * 0.9;

/* 云层：进入槽位时紧（k 大），公转时松（k 小 → 会拖在指针后面甩） */
const SLOT_K = 240, SLOT_C = 2 * Math.sqrt(SLOT_K) * 0.85;
const ORB_K = 88, ORB_C = 2 * Math.sqrt(ORB_K) * 0.8;

/* 流场强度（px 振幅）：骨架只要轻微起伏，云层可以飘得大些 */
const FLOW_SKEL = 2.6;
const FLOW_SLOT = 1.1;
const FLOW_ORB = 9.0;

/* ---------------------------------------------------------------- 噪声 */
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
  const c000 = hash3(ix, iy, iz, seed), c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed), c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed), c101 = hash3(ix + 1, iy, iz + 1, seed);
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

/* ------------------------------------------------------- 点精灵 shader ---
 * 预乘 alpha + NormalBlending：这样画在头像上是"发光点"而不是黑点
 * （Additive 会要求 a=1 直接盖住头像；预乘再叠加会乘两次变全黑）。 */
const VERT = `
  attribute float aAlpha; attribute float aSize; attribute float aSeed; attribute float aHot;
  varying float vA;
  uniform float uDpr; uniform float uTime; uniform float uGain; uniform float uSizeMul;
  uniform vec3 uColor;
  void main(){
    /* 亮度呼吸：每个点自己的相位 → 星点闪烁（**位置**的呼吸在 CPU 流场里，
       那是整群相干的；这里的 alpha 抖动只是个高光，幅度很小） */
    float breathe = 0.82 + 0.18 * sin(uTime * (0.5 + aSeed * 0.8) + aSeed * 6.2831);
    /* aHot：这个点属于正在被悬停的控件 → 提亮 + 微微加粗，
       再叠上增援粒子灌进槽位的那份密度，控件就"活过来"了 */
    vA = clamp(aAlpha * breathe * uGain * (1.0 + aHot * 0.55), 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uDpr * uSizeMul * (1.0 + aHot * 0.10);
  }`;

/* 加色版：重叠的点会互相叠亮 —— 原型就是 Additive，所以每颗点的"热度"
   都不一样（簇上的点更白更亮），这是"不规整"的重要一半。 */
const FRAG_HARD = `
  varying float vA;
  uniform float uAdd; uniform vec3 uColor;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    float r = sqrt(dot(d, d)) * 2.0;
    /* 硬芯：点阵屏的一颗 LED —— 直径基本等于标称值，边缘只留 1px 抗锯齿。 */
    if (r > 1.0) discard;
    float a = vA * (1.0 - smoothstep(0.82, 1.0, r));
    /* uAdd=1 → 非预乘（加色混合按 SrcAlpha 计权）；
       uAdd=0 → 预乘（NormalBlending，叠在头像上不会变黑） */
    gl_FragColor = vec4(uColor * mix(a, 1.0, uAdd), a);
  }`;

const FRAG_SOFT = `
  varying float vA;
  uniform float uAdd; uniform vec3 uColor;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d) * 4.0;
    if (r2 > 1.0) discard;
    float core = pow(1.0 - r2, 1.7);
    float a = core * vA;
    gl_FragColor = vec4(uColor * mix(a, 1.0, uAdd), a);
  }`;

function makeMat(hard, additive, sizeMul = 1, gain = 1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uDpr: { value: 1 },
      uTime: { value: 0 },
      uGain: { value: gain },
      uAdd: { value: additive ? 1 : 0 },
      uSizeMul: { value: sizeMul },
      uColor: { value: new THREE.Color(0.18, 0.88, 0.85) },
    },
    vertexShader: VERT,
    fragmentShader: hard ? FRAG_HARD : FRAG_SOFT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

export class Field {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = 1;
    this.H = 1;
    this.time = 0;
    this.scale = 1;
    this.burstAt = -1;

    /* 指针（世界坐标） */
    this.ptr = { x: 0, y: 0, on: false };

    /* 悬停槽位状态 */
    this.slot = { id: null, fill: 0 };

    /* ───────────────── 骨架：点阵 ───────────────── */
    const n = SKEL_MAX;
    this.pos = new Float32Array(n * 2);
    this.vel = new Float32Array(n * 2);
    this.tgt = new Float32Array(n * 2);
    this.role = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.aScale = new Float32Array(n);
    this.sScale = new Float32Array(n);
    this.fade = new Float32Array(n);
    this.key = new Int32Array(n).fill(-1);
    this.byKey = new Map();
    this.top = 0;
    this.free = [];
    this.dying = [];

    for (let i = 0; i < n; i++) this.seed[i] = Math.random();

    this.geo = new THREE.BufferGeometry();
    this.geo.setDrawRange(0, 0);
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aScale, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.sScale, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    this.hot = new Float32Array(n);
    this.sJit = new Float32Array(n).fill(1);
    this.aJit = new Float32Array(n).fill(1);
    this.geo.setAttribute('aHot', new THREE.BufferAttribute(this.hot, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = makeMat(true, true);    // 骨架：硬芯 LED + 加色（重叠叠亮）
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.position.z = 1;

    /* 同一份 geometry 再用一个"大号、暗"的材质画一遍 = 廉价 bloom。
       原型的点周围有一圈明显的光晕（点阵屏在暗处的溢光），只画硬芯永远是干巴巴的圆。 */
    this.matGlow = makeMat(false, true, 2.4, 0.0);
    this.pointsGlow = new THREE.Points(this.geo, this.matGlow);
    this.pointsGlow.frustumCulled = false;
    this.pointsGlow.position.z = 0.9;

    /* ───────────────── 云层：增援 ───────────────── */
    this.cPos = new Float32Array(CLOUD_N * 2);
    this.cVel = new Float32Array(CLOUD_N * 2);
    this.cMode = new Uint8Array(CLOUD_N);      // 0 公转 / 1 槽位
    this.cOrbR = new Float32Array(CLOUD_N);
    this.cOrbPh = new Float32Array(CLOUD_N);
    this.cOrbS = new Float32Array(CLOUD_N);
    this.cSize = new Float32Array(CLOUD_N);
    this.cAmp = new Float32Array(CLOUD_N);
    this.slotX = new Float32Array(CLOUD_N);
    this.slotY = new Float32Array(CLOUD_N);
    this.cFade = new Float32Array(CLOUD_N);
    this.cAlpha = new Float32Array(CLOUD_N);
    this.cParkR = new Float32Array(CLOUD_N);
    this.cRole = new Float32Array(CLOUD_N);

    for (let i = 0; i < CLOUD_N; i++) {
      /* 公转半径 24~114 世界 px：填充率低时整体外扩成光晕（见 step）。
         别收得太紧 —— 几百颗挤在 20px 环里就是一坨糊斑，看不出"在转"；
         也别只给一小团，用户要的是"指针周围**大量**旋转的粒子"。 */
      this.cOrbR[i] = 24 + Math.pow(Math.random(), 0.6) * 90;
      /* 待机时沉成星尘用的独立半径，跟悬停参数解耦 */
      this.cParkR[i] = 110 + Math.pow(Math.random(), 0.72) * 190;
      this.cOrbPh[i] = Math.random() * TAU;
      this.cOrbS[i] = 0.75 + Math.random() * 0.65;
      this.cSize[i] = 2.0 + Math.random() * 2.2;
      this.cAmp[i] = 0.34 + Math.random() * 0.5;
      this.cFade[i] = 0;
      this.cAlpha[i] = 0;
      /* 初始就散在待机环上，避免第一帧从圆心炸开 */
      const a = Math.random() * TAU, rr = 120 + Math.random() * 260;
      this.cPos[i * 2] = Math.cos(a) * rr;
      this.cPos[i * 2 + 1] = Math.sin(a) * rr * 0.8;
    }

    this.cGeo = new THREE.BufferGeometry();
    this.cGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CLOUD_N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.cGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.cAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.cGeo.setAttribute('aSize', new THREE.BufferAttribute(this.cSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.cGeo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(CLOUD_N).map(() => Math.random()), 1));
    this.cGeo.setAttribute('aHot', new THREE.BufferAttribute(new Float32Array(CLOUD_N), 1));
    this.cMat = makeMat(false, true);  // 云层：软光尘 + 加色
    this.cPoints = new THREE.Points(this.cGeo, this.cMat);
    this.cPoints.frustumCulled = false;
    this.cPoints.position.z = 0;

    this.cMatGlow = makeMat(false, true, 2.2, 0.0);
    this.cPointsGlow = new THREE.Points(this.cGeo, this.cMatGlow);
    this.cPointsGlow.frustumCulled = false;
    this.cPointsGlow.position.z = -0.1;

    /* ───────────────── 头像光晕（顶点着色器算轨道） ───────────────── */
    this.oA = new Float32Array(AVA_N);
    this.oW = new Float32Array(AVA_N);
    this.oOff = new Float32Array(AVA_N);
    this.oS = new Float32Array(AVA_N);
    this.oAmp = new Float32Array(AVA_N);
    this.oPh = new Float32Array(AVA_N);

    for (let i = 0; i < AVA_N; i++) {
      this.oA[i] = Math.random() * TAU;
      /* 三层：贴身 / 中层 / 外雾 */
      const u = Math.random();
      if (u < 0.6) this.oOff[i] = -4.5 + Math.random() * 10;
      else if (u < 0.9) this.oOff[i] = 6 + Math.pow(Math.random(), 1.4) * 24;
      else this.oOff[i] = 28 + Math.pow(Math.random(), 1.6) * 32;
      const base = 0.62 / (1 + Math.max(0, this.oOff[i]) * 0.055);
      this.oW[i] = base * (0.75 + Math.random() * 0.5) * (Math.random() < 0.86 ? 1 : -1);
      this.oS[i] = 1.7 + Math.random() * 2.2;
      this.oAmp[i] = 0.44 + Math.random() * 0.55;
      this.oPh[i] = Math.random() * TAU;
    }

    this.oGeo = new THREE.BufferGeometry();
    this.oGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(AVA_N * 3), 3));
    this.oGeo.setAttribute('aA', new THREE.BufferAttribute(this.oA, 1));
    this.oGeo.setAttribute('aW', new THREE.BufferAttribute(this.oW, 1));
    this.oGeo.setAttribute('aOff', new THREE.BufferAttribute(this.oOff, 1));
    this.oGeo.setAttribute('aSize', new THREE.BufferAttribute(this.oS, 1));
    this.oGeo.setAttribute('aAmp', new THREE.BufferAttribute(this.oAmp, 1));
    this.oGeo.setAttribute('aPh', new THREE.BufferAttribute(this.oPh, 1));

    this.oMat = new THREE.ShaderMaterial({
      uniforms: {
        uDpr: { value: 1 },
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uR: { value: 80 },
        uPx: { value: 1 },
        uOpacity: { value: 1 },
        uColorA: { value: new THREE.Color(0.18, 0.88, 0.85) },
      },
      vertexShader: `
        attribute float aA; attribute float aW; attribute float aOff;
        attribute float aSize; attribute float aAmp; attribute float aPh;
        varying float vA;
        uniform float uDpr; uniform float uTime; uniform vec2 uCenter;
        uniform float uR; uniform float uPx; uniform float uOpacity;
        void main(){
          float ang = aA + uTime * aW;
          /* 半径本身也在呼吸：环流不是规整的圆，而是一圈一圈涨落的云 */
          float rr = uR + aOff * uPx + sin(uTime * 1.7 + aPh) * 2.4 * uPx
                   + sin(uTime * 0.43 + aPh * 2.1) * 3.2 * uPx;
          vec3 p = vec3(uCenter.x + cos(ang) * rr, uCenter.y + sin(ang) * rr, 0.0);
          float band = 0.58 + 0.42 * sin(ang * 2.0 - uTime * 1.35 + aPh);
          float falloff = 1.0 - clamp((aOff - 2.0) / 40.0, 0.0, 0.84);
          vA = aAmp * band * falloff * uOpacity;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPx * uDpr * (0.85 + band * 0.3);
        }`,
      fragmentShader: `
        varying float vA;
        uniform vec3 uColorA;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d) * 4.0;
          if (r2 > 1.0) discard;
          float core = pow(1.0 - r2, 1.5);
          float a = core * vA;
          gl_FragColor = vec4(uColorA * a, a);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.oPoints = new THREE.Points(this.oGeo, this.oMat);
    this.oPoints.frustumCulled = false;

    /* ───────────────── 连线层 ─────────────────
     * 原型 UI 模式的 links[0]：按目标近邻连成细神经网。
     * 这一层是"不规整"的另一半 —— 只点不连，边框就是一串孤立的珠子；
     * 连起来之后边缘变成连续发光的带，颗粒感仍在，机械感没了。
     * - 骨架：只连**线条类几何**（边框、箭头），文字绝不连（会糊）
     * - 增援·槽位：小阈值 → 槽内短网，文字/边框变"实心"
     * - 增援·公转：大阈值 → 彗光滑尾
     */
    this.lnkSkel = this.makeLinks(2600, 0.42);
    this.lnkSlot = this.makeLinks(4200, 0.34);
    this.lnkOrb = this.makeLinks(2600, 0.07);

    this.scene = new THREE.Scene();
    this.scene.add(this.lnkSkel.obj);
    this.scene.add(this.lnkSlot.obj);
    this.scene.add(this.lnkOrb.obj);
    this.scene.add(this.cPoints);
    this.scene.add(this.points);
    /* glow 层不挂进场景：原型 UI 模式是干净的点阵，没有 bloom */
    this.scene.add(this.oPoints);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
    this.cam.position.z = 10;

    /* 流场网格：每帧在粗网格上算一次 fbm，粒子做双线性采样
       —— 效果等价于逐粒子求 fbm（场本来就是连续的），但便宜两个数量级 */
    this.gw = 36;
    this.gh = 26;
    this.flow = new Float32Array((this.gw + 1) * (this.gh + 1) * 2);
    this.gainS = 1.35;
    this.gainC = 1.15;

    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = this.canvas.clientWidth || window.innerWidth;
    this.H = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.W, this.H, false);
    this.mat.uniforms.uDpr.value = dpr;
    this.cMat.uniforms.uDpr.value = dpr;
    this.matGlow.uniforms.uDpr.value = dpr;
    this.cMatGlow.uniforms.uDpr.value = dpr;
    this.oMat.uniforms.uDpr.value = dpr;
    this.cam.left = -this.W / 2;
    this.cam.right = this.W / 2;
    this.cam.top = this.H / 2;
    this.cam.bottom = -this.H / 2;
    this.cam.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------ 连线 */
  makeLinks(cap, opacity) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cap * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0x8fd8ff,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const obj = new THREE.LineSegments(geo, mat);
    obj.frustumCulled = false;
    obj.visible = false;
    obj.position.z = 0.5;
    return { geo, pos, pairs: new Int32Array(cap * 2), cap, n: 0, obj, mat };
  }

  /**
   * 在 ids 里找近邻对。cell = thresh，只看 3×3 桶，j>i 保证每对只连一次。
   * @param perMax 每颗粒子最多连几条（过大就织成一张网，反而糊）
   */
  buildPairs(link, xs, ids, thresh, perMax) {
    const cell = thresh;
    const buckets = new Map();
    const K = (cx, cy) => (cx + 8192) * 16384 + (cy + 8192);
    for (let a = 0; a < ids.length; a++) {
      const i = ids[a];
      const cx = Math.floor(xs[i * 2] / cell), cy = Math.floor(xs[i * 2 + 1] / cell);
      const k = K(cx, cy);
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(i);
    }
    let n = 0;
    const lim = link.cap;
    for (let a = 0; a < ids.length && n < lim; a++) {
      const i = ids[a];
      const xi = xs[i * 2], yi = xs[i * 2 + 1];
      const cx = Math.floor(xi / cell), cy = Math.floor(yi / cell);
      let made = 0;
      for (let dx = -1; dx <= 1 && made < perMax; dx++) {
        for (let dy = -1; dy <= 1 && made < perMax; dy++) {
          const b = buckets.get(K(cx + dx, cy + dy));
          if (!b) continue;
          for (let k = 0; k < b.length && made < perMax; k++) {
            const j = b[k];
            if (j <= i) continue;
            const ddx = xs[j * 2] - xi, ddy = xs[j * 2 + 1] - yi;
            if (ddx * ddx + ddy * ddy > cell * cell) continue;
            link.pairs[n * 2] = i;
            link.pairs[n * 2 + 1] = j;
            n++; made++;
            if (n >= lim) break;
          }
        }
      }
    }
    link.n = n;
    link.geo.setDrawRange(0, n * 2);
    link.obj.visible = n > 0;
  }

  /** 把粒子位置写进连线的顶点缓冲（每帧调，很便宜） */
  syncLinks(link, xs) {
    if (!link.n) return;
    const p = link.pos, pr = link.pairs;
    for (let k = 0; k < link.n; k++) {
      const a = pr[k * 2], b = pr[k * 2 + 1], o = k * 6;
      p[o] = xs[a * 2]; p[o + 1] = xs[a * 2 + 1]; p[o + 2] = 0;
      p[o + 3] = xs[b * 2]; p[o + 4] = xs[b * 2 + 1]; p[o + 5] = 0;
    }
    link.geo.attributes.position.needsUpdate = true;
  }

  /** 骨架连线：只连线条类几何（边框 3 / 箭头 5），文字一律不连 */
  rebuildSkelLinks() {
    const L = this.lnkSkel;
    const ids = [];
    for (let i = 0; i < this.top; i++) {
      const r = this.role[i];
      if (r === 3 || r === 5) ids.push(i);
    }
    if (!ids.length) { L.n = 0; L.obj.visible = false; return; }
    this.buildPairs(L, this.tgt, new Int32Array(ids), CELL * this.scale * 1.75, 3);
    this.syncLinks(L, this.tgt);
  }

  /** 槽位连线：槽内短网，让被灌满的控件看起来是"实心"的 */
  rebuildSlotLinks() {
    const L = this.lnkSlot;
    const ids = [];
    for (let i = 0; i < CLOUD_N; i++) if (this.cMode[i] === 1) ids.push(i);
    if (ids.length < 2) { L.n = 0; L.obj.visible = false; return; }
    /* 槽位目标暂时借用 cPos（此刻粒子可能还在飞的路上），用 slotX/slotY 更稳 */
    const sp = this.slotPos();
    this.buildPairs(L, sp, new Int32Array(ids), CELL_R * this.scale * 2.1, 2);
    this.syncLinks(L, sp);
  }

  slotPos() {
    if (!this._slot) this._slot = new Float32Array(CLOUD_N * 2);
    for (let i = 0; i < CLOUD_N; i++) {
      this._slot[i * 2] = this.cMode[i] === 1 ? this.slotX[i] : this.cPos[i * 2];
      this._slot[i * 2 + 1] = this.cMode[i] === 1 ? this.slotY[i] : this.cPos[i * 2 + 1];
    }
    return this._slot;
  }

  /** 公转连线：大阈值 → 彗光滑尾（隔几帧重建，拓扑不用每帧换） */
  rebuildOrbLinks() {
    const L = this.lnkOrb;
    if (!this.ptr.on || this.slot.fill > 0.98) { L.n = 0; L.obj.visible = false; return; }
    const ids = [];
    for (let i = 0; i < CLOUD_N; i++) if (this.cMode[i] === 0) ids.push(i);
    if (ids.length < 2) { L.n = 0; L.obj.visible = false; return; }
    /* 阈值不能大：公转云是一圈薄饼，阈值一大就连出横穿整团的乱线（像划痕）。
       18px 只连相邻粒子 → 短线随流动一起走，才是"彗光滑尾" */
    this.buildPairs(L, this.cPos, new Int32Array(ids), 10, 1);
  }

  /* --------------------------------------------------------- 头像光晕 */
  setAvatar(lx, ly, lr, scale, LW, LH) {
    this.ava = { x: (lx - LW / 2) * scale, y: (LH / 2 - ly) * scale, r: lr * scale, scale };
    this.oMat.uniforms.uCenter.value.set(this.ava.x, this.ava.y);
    this.oMat.uniforms.uR.value = this.ava.r;
    this.oMat.uniforms.uPx.value = scale;
  }

  /* --------------------------------------------------------- 骨架点阵 */
  /**
   * 点阵落位。
   *
   * **过采样 1.3x**：原型是 4400 颗粒子铺 ~3377 个槽位，所以每个槽平均 1.3 颗 ——
   * 多出来的那颗带着自己的弹簧/流场/相位，永远压不实，于是同一个格子上是一小簇
   * 微偏的复本（点径、亮度都不同）。这正是"不规整"的来源：1:1 铺满等于一张
   * 印刷网点图，每颗都一样大、一样亮、钉在同一点。这里按 key 的哈希决定
   * 34% 的格子多一颗，并给它一个 ±0.45 格的随机偏移（不是格心）。
   */
  setPoints(pts, scale, LW, LH) {
    this.scale = scale;
    /* 硬芯点直径 ≈ 点距 ×1.45：相邻点相切、笔画连成线，仍留一圈暗缝 */
    const pointSize = CELL * scale * 1.06;

    const M = pts.length / 4;
    const keep = new Set();
    const ox = LW / 2, oy = LH / 2;

    for (let k = 0; k < M; k++) {
      const lx = pts[k * 4], ly = pts[k * 4 + 1], role = pts[k * 4 + 2], slot = pts[k * 4 + 3];
      const wx0 = (lx - ox) * scale;
      const wy0 = (oy - ly) * scale;

      /* 该格子几颗：1 或 2（确定性哈希，重绘时不跳变） */
      const h = Math.imul(slot ^ 0x9e3779b9, 2654435761) >>> 0;
      const subs = (h % 100) < 46 ? 2 : 1;

      for (let sub = 0; sub < subs; sub++) {
        const key = slot * 4 + sub;
        keep.add(key);

        let wx = wx0, wy = wy0;
        if (sub > 0) {
          /* 复本不落格心：随机方向 ±0.45 格 —— 看起来是"两粒沙"，不是重影 */
          const a = (h % 6283) / 1000 + sub * 2.4;
          const r = (0.12 + ((h >>> 7) % 100) / 100 * 0.44) * CELL * scale;
          wx += Math.cos(a) * r;
          wy += Math.sin(a) * r;
        }

        let idx = this.byKey.get(key);
        if (idx === undefined) {
          if (this.free.length) idx = this.free.pop();
          else if (this.top < SKEL_MAX) idx = this.top++;
          else continue;
          this.byKey.set(key, idx);
          this.key[idx] = key;
          this.pos[idx * 2] = wx;
          this.pos[idx * 2 + 1] = wy;
          this.vel[idx * 2] = 0;
          this.vel[idx * 2 + 1] = 0;
          this.fade[idx] = 0;
          /* 逐粒子点径/亮度差异：印刷网点每颗都不同，模子刻出来的一眼就是假的 */
          this.sJit[idx] = 0.82 + ((h >>> 11) % 100) / 100 * 0.38;
          this.aJit[idx] = 0.78 + ((h >>> 17) % 100) / 100 * 0.28;
        }
        this.tgt[idx * 2] = wx;
        this.tgt[idx * 2 + 1] = wy;
        this.role[idx] = role;
        this.aScale[idx] = (ROLE_A[role] ?? 0.6) * this.aJit[idx];
        this.sScale[idx] = pointSize * (ROLE_S[role] ?? 1) * this.sJit[idx];
      }
    }

    for (const [key, idx] of this.byKey) {
      if (!keep.has(key)) {
        this.byKey.delete(key);
        this.dying.push(idx);
      }
    }
    this.geo.setDrawRange(0, this.top);
    this.rebuildSkelLinks();
  }

  /**
   * 把增援云倾泻进某个控件的槽位。
   * @param pts  [lx, ly, role] 三元组（逻辑坐标，行优先 → 已按 y,x 有序）
   * @param id   控件 id（只用于记录，容量系数由调用方算好后传入）
   * @param capK 容量系数：线条类接近 1（越灌越亮），大段文字要低（会糊）
   */
  setSlots(pts, id, capK, scale, LW, LH) {
    if (!pts || !pts.length) { this.clearSlots(); return; }
    this.slot.id = id;

    const M = pts.length / 3;
    const useCount = Math.min(CLOUD_N, Math.ceil(M * capK));
    const ox = LW / 2, oy = LH / 2;

    /* 槽位中心（世界坐标） */
    let cx = 0, cy = 0;
    for (let k = 0; k < M; k++) {
      cx += (pts[k * 3] - ox) * scale;
      cy += (oy - pts[k * 3 + 1]) * scale;
    }
    cx /= M; cy /= M;

    /* 按到控件中心的距离排序：近的先拿到槽位 → 看起来是"从指针这边灌进去" */
    const order = new Int32Array(CLOUD_N);
    for (let i = 0; i < CLOUD_N; i++) order[i] = i;
    const px = this.cPos;
    const arr = Array.from(order);
    arr.sort((a, b) => {
      const da = (px[a * 2] - cx) ** 2 + (px[a * 2 + 1] - cy) ** 2;
      const db = (px[b * 2] - cx) ** 2 + (px[b * 2 + 1] - cy) ** 2;
      return da - db;
    });

    this.cMode.fill(0);
    /* 半格交错只对**面状**控件（文字）有意义：让增援点落在骨架点之间，均匀加密。
       线条类（边框/箭头）绝不能交错 —— 骨架点是 5.96px 的圆点，再在旁边 3px 处
       压一个同样的点，视觉宽度直接撑到 9px，看起来就是"灌注后凭空描了一圈粗边"。
       所以 contour 类 off = 0，与骨架点重合，只叠亮度、不改粗细。 */
    const contour = id === 'input' || id === 'button';
    const off = contour ? 0 : CELL_R * scale * 0.5;
    for (let k = 0; k < useCount; k++) {
      const pi = arr[k];
      /* 槽位是等距抽样分配的：M 可能大于或小于 useCount，都均匀铺开 */
      const s = Math.min(M - 1, ((k + 0.5) * M / useCount) | 0);
      this.cMode[pi] = 1;
      this.cRole[pi] = pts[s * 3 + 2];
      this.slotX[pi] = (pts[s * 3] - ox) * scale + off;
      this.slotY[pi] = (oy - pts[s * 3 + 1]) * scale + off;
    }
    for (let k = useCount; k < CLOUD_N; k++) this.cRole[arr[k]] = 0;

    this.slot.fill = useCount / CLOUD_N;
    this.applyHot(id, scale);   // 骨架里属于该控件的点整体提亮
    this.rebuildSlotLinks();
  }

  /** 标记「哪些骨架点属于当前悬停的控件」 */
  applyHot(id, scale) {
    this.hotPart = id || null;
    for (let i = 0; i < this.top; i++) {
      this.hot[i] = id && ROLE_PART[this.role[i]] === id ? 1 : 0;
      if (scale) this.sScale[i] = CELL * scale * 1.38 * (ROLE_S[this.role[i]] ?? 1);
    }
    this.geo.attributes.aHot.needsUpdate = true;
    if (scale) this.geo.attributes.aSize.needsUpdate = true;
  }

  clearSlots() {
    this.slot.id = null;
    this.slot.fill = 0;
    this.cMode.fill(0);
    this.cRole.fill(0);
    this.lnkSlot.n = 0;
    this.lnkSlot.obj.visible = false;
    this.applyHot(null);
  }

  burst() {
    if (this.burstAt >= 0) return;
    this.burstAt = this.time;
    for (let i = 0; i < this.top; i++) {
      const px = this.pos[i * 2], py = this.pos[i * 2 + 1];
      const d = Math.hypot(px, py) || 1;
      const nx = px / d, ny = py / d;
      const ang = (Math.random() - 0.5) * 1.1;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const sp = 160 + Math.random() * 560;
      this.vel[i * 2] = (nx * ca - ny * sa) * sp;
      this.vel[i * 2 + 1] = (nx * sa + ny * ca) * sp;
    }
    for (let i = 0; i < CLOUD_N; i++) {
      const px = this.cPos[i * 2], py = this.cPos[i * 2 + 1];
      const d = Math.hypot(px, py) || 1;
      const sp = 200 + Math.random() * 700;
      this.cVel[i * 2] = px / d * sp;
      this.cVel[i * 2 + 1] = py / d * sp;
      this.cMode[i] = 0;
    }
  }

  burstAvatar() {
    if (this.avatarBurst === undefined) this.avatarBurst = this.time;
  }

  /** 指针（CSS 坐标） */
  setPointer(x, y, on) {
    this.ptr.on = on;
    this.ptr.x = x - this.W / 2;
    this.ptr.y = this.H / 2 - y;
  }

  /** 点击脉冲：从触点向外推一圈冲击波（骨架只吃 22%，文字不晃） */
  pulse(x, y) {
    const px = x - this.W / 2, py = this.H / 2 - y;
    for (let i = 0; i < this.top; i++) {
      const dx = this.pos[i * 2] - px, dy = this.pos[i * 2 + 1] - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1600 && d2 > 1) {
        const d = Math.sqrt(d2);
        const f = (1 - d / 40) * 260 * 0.22 / d;
        this.vel[i * 2] += dx * f;
        this.vel[i * 2 + 1] += dy * f;
      }
    }
    for (let i = 0; i < CLOUD_N; i++) {
      const dx = this.cPos[i * 2] - px, dy = this.cPos[i * 2 + 1] - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < 3600 && d2 > 1) {
        const d = Math.sqrt(d2);
        const f = (1 - d / 60) * 320 / d;
        this.cVel[i * 2] += dx * f;
        this.cVel[i * 2 + 1] += dy * f;
      }
    }
  }

  /* ------------------------------------------------------------- 流场 */
  updateFlow(t) {
    const { gw, gh, W, H, flow } = this;
    const S = 0.0065;                 // 采样频率：约 154px 一个噪声胞
    const ft = t * 0.21;              // 场本身缓慢推进 → 起伏不是原地跳
    let o = 0;
    for (let j = 0; j <= gh; j++) {
      const wy = (j / gh - 0.5) * H;
      for (let i = 0; i <= gw; i++) {
        const wx = (i / gw - 0.5) * W;
        flow[o++] = fbm(wx * S, wy * S, ft, 911);
        flow[o++] = fbm(wy * S + 31.7, wx * S, ft + 5.3, 433) * 0.85;
      }
    }
  }

  /** 双线性采样流场（世界坐标，返回写入 _fx/_fy） */
  flowAt(wx, wy) {
    const { gw, gh, W, H, flow } = this;
    const gx = clamp((wx / W + 0.5) * gw, 0, gw - 0.001);
    const gy = clamp((wy / H + 0.5) * gh, 0, gh - 0.001);
    const i = gx | 0, j = gy | 0;
    const fx = gx - i, fy = gy - j;
    const o0 = (j * (gw + 1) + i) * 2;
    const o1 = o0 + (gw + 1) * 2;
    const a = flow[o0] + (flow[o0 + 2] - flow[o0]) * fx;
    const b = flow[o1] + (flow[o1 + 2] - flow[o1]) * fx;
    this._fx = a + (b - a) * fy;
    const a2 = flow[o0 + 1] + (flow[o0 + 3] - flow[o0 + 1]) * fx;
    const b2 = flow[o1 + 1] + (flow[o1 + 3] - flow[o1 + 1]) * fx;
    this._fy = a2 + (b2 - a2) * fy;
  }

  /* ------------------------------------------------------------- 主步 */
  step(dt) {
    this.time += dt;
    const t = this.time;
    this.mat.uniforms.uTime.value = t;
    this.cMat.uniforms.uTime.value = t;
    this.matGlow.uniforms.uTime.value = t;
    this.cMatGlow.uniforms.uTime.value = t;
    this.oMat.uniforms.uTime.value = t;

    if (this.avatarBurst !== undefined) {
      const k = clamp(1 - (t - this.avatarBurst) / 0.9, 0, 1);
      this.oMat.uniforms.uOpacity.value = k;
      this.oMat.uniforms.uR.value += dt * 260;
    }

    this.updateFlow(t);

    /* 温度：缓慢漂移（原型 UI 模式取模拟遥测均值）→ 整片色相在电青~洋青之间呼吸 */
    const temp = 0.40 + 0.09 * Math.sin(t * 0.07) + 0.04 * Math.sin(t * 0.23 + 1.7);
    const col = tempColor(temp);
    const bright = 0.28 + temp * 0.55;              // 原型：亮度随温度涨
    const kCol = bright / 0.40;                     // 原型点色接近 #7FFFEE（亮青白）
    const cr = col[0] * kCol, cg = col[1] * kCol, cb = col[2] * kCol;
    for (const m of [this.mat, this.matGlow, this.cMat, this.cMatGlow]) {
      m.uniforms.uColor.value.setRGB(cr, cg, cb);
    }
    this.oMat.uniforms.uColorA.value.setRGB(col[0], col[1], col[2]);

    /* 呼吸包络：整群统一（不是逐粒子）→ 起伏有节奏，像呼吸而不是抖动 */
    const env = 0.5 + 0.5 * Math.sin(t * 1.36);   // 周期 4.6s：3 秒内能看清一个起落
    const breath = (0.35 + 0.65 * env) * 1.05;

    const burst = this.burstAt >= 0 ? clamp(1 - (t - this.burstAt) / 0.95, 0, 1) : 1;

    /* ───────── 骨架 ───────── */
    const posArr = this.geo.attributes.position.array;
    const sp = this.pos, sv = this.vel, st = this.tgt;
    let moved = false;

    for (let i = 0; i < this.top; i++) {
      const i2 = i * 2;
      const px = sp[i2], py = sp[i2 + 1];

      if (this.fade[i] < 1) this.fade[i] = Math.min(1, this.fade[i] + dt * 6.5);

      this.flowAt(px, py);
      /* 径向呼吸：从画布中心外推 —— 原型 UI 模式 calmS=0.07 时骨架的呼吸位移
         仍有 ~5 屏幕 px（4.6·kS·env·amp·calmS / kS ≈ 0.32·amp 世界单位）。
         我原来给 2.3 世界 px（屏幕 ±0.8px），肉眼等于静止 —— 这就是"粒子不会动"。
         这里用 scale 归一化，直接锁定屏幕量级。 */
      const rl = Math.hypot(px, py) || 1;
      const br = 4.2 * (breath - 0.7) * this.scale;
      /* 逐粒子微环：每颗绕自己的格心画一个独立相位的小圆。
         整片呼吸之外还要有**颗粒级**的活气，否则只像整体在缩放；
         这是点阵"沙沙在动"的来源（原型骨架 flowCalm=0.03，靠呼吸 + 逐粒子相位）。 */
      const ph = this.seed[i] * 6.2831;
      const aRot = t * 3.6 + ph;
      const ja = 2.4 / this.scale;          // 屏幕 ±2.4px（约点距 42%：能看出在扭，又不散字）
      const tx = st[i2] + this._fx * FLOW_SKEL + (px / rl) * br + Math.cos(aRot) * ja;
      const ty = st[i2 + 1] + this._fy * FLOW_SKEL + (py / rl) * br + Math.sin(aRot) * ja;

      const dx = tx - px, dy = ty - py;

      if (this.burstAt >= 0) {
        sv[i2] = sv[i2] * (1 - 1.1 * dt);
        sv[i2 + 1] = sv[i2 + 1] * (1 - 1.1 * dt);
        sp[i2] += sv[i2] * dt;
        sp[i2 + 1] += sv[i2 + 1] * dt;
        this.aScale[i] = (ROLE_A[this.role[i]] ?? 0.6) * this.aJit[i] * burst * 1.4;
        this.sScale[i] *= 1 + 0.9 * dt;
      } else {
        /* 半隐式弹簧：先积分速度再位移，任何 dt 都稳定。
           注意**没有**「近了就吸附归零」的死区 —— 那正是上一版看起来
           像贴图的原因：目标一擦到就把速度清零，粒子永远钉死在格心。 */
        sv[i2] = (sv[i2] + dx * SKEL_K * dt) / (1 + SKEL_C * dt);
        sv[i2 + 1] = (sv[i2 + 1] + dy * SKEL_K * dt) / (1 + SKEL_C * dt);
        sp[i2] += sv[i2] * dt;
        sp[i2 + 1] += sv[i2 + 1] * dt;
        this.aScale[i] = (ROLE_A[this.role[i]] ?? 0.6) * this.aJit[i] * this.fade[i] * this.gainS;
      }

      posArr[i * 3] = sp[i2];
      posArr[i * 3 + 1] = sp[i2 + 1];
      posArr[i * 3 + 2] = 0;
      moved = true;
    }

    if (moved) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
    }

    /* 回收淡完的点 */
    if (this.dying.length) {
      const rest = [];
      for (const i of this.dying) {
        this.fade[i] -= dt * 7;
        if (this.fade[i] <= 0) {
          this.fade[i] = 0;
          this.aScale[i] = 0;
          this.role[i] = 0;
          this.key[i] = -1;
          this.free.push(i);
        } else {
          this.aScale[i] = (ROLE_A[this.role[i]] ?? 0.6) * this.aJit[i] * this.fade[i];
          rest.push(i);
        }
      }
      this.dying = rest;
      this.geo.attributes.aAlpha.needsUpdate = true;
    }

    /* ───────── 云层 ───────── */
    const cPos = this.cPos, cVel = this.cVel;
    const cArr = this.cGeo.attributes.position.array;
    /* 指针在 → 围着指针（填充率越低越外扩）；指针不在 → 整片沉成一层
       缓慢漂移的星尘，半径放大 10 倍、角速度降到 1/5（不然外圈线速度太快） */
    const idle = !this.ptr.on;
    const orbitK = 1 + 0.9 * (1 - this.slot.fill);
    const cx0 = this.ptr.x;
    const cy0 = this.ptr.y;
    const spd = idle ? 0.16 : 0.78;

    for (let i = 0; i < CLOUD_N; i++) {
      const i2 = i * 2;
      const px = cPos[i2], py = cPos[i2 + 1];
      if (this.cFade[i] < 1) this.cFade[i] = Math.min(1, this.cFade[i] + dt * 2.2);

      this.flowAt(px, py);

      let tx, ty, k, c, flowAmp;
      if (this.cMode[i] === 1) {
        /* 槽位：微旋半径 0.9px —— 保持活性但不会把笔画糊掉 */
        const a = t * 0.8 + this.cOrbPh[i];
        tx = this.slotX[i] + Math.cos(a) * 0.9;
        ty = this.slotY[i] + Math.sin(a) * 0.9;
        k = SLOT_K; c = SLOT_C; flowAmp = FLOW_SLOT;
      } else {
        const a = t * spd * this.cOrbS[i] + this.cOrbPh[i];
        /* 半径再叠一层慢涨落：环带被揉开成云，不是几何圆 */
        const base = idle ? this.cParkR[i] : this.cOrbR[i] * orbitK;
        const rr = base * (0.84 + 0.3 * Math.sin(t * 0.37 + this.cOrbPh[i] * 1.7));
        tx = cx0 + Math.cos(a) * rr;
        ty = cy0 + Math.sin(a) * rr * 0.84;
        k = ORB_K; c = ORB_C; flowAmp = FLOW_ORB;
      }

      tx += this._fx * flowAmp;
      ty += this._fy * flowAmp;

      const dx = tx - px, dy = ty - py;
      if (this.burstAt >= 0) {
        cVel[i2] *= 1 - 1.1 * dt;
        cVel[i2 + 1] *= 1 - 1.1 * dt;
      } else {
        cVel[i2] = (cVel[i2] + dx * k * dt) / (1 + c * dt);
        cVel[i2 + 1] = (cVel[i2 + 1] + dy * k * dt) / (1 + c * dt);
      }

      /* 速度封顶，防炸 */
      const v2 = cVel[i2] * cVel[i2] + cVel[i2 + 1] * cVel[i2 + 1];
      if (v2 > 360000) {
        const s = 600 / Math.sqrt(v2);
        cVel[i2] *= s; cVel[i2 + 1] *= s;
      }

      cPos[i2] += cVel[i2] * dt;
      cPos[i2 + 1] += cVel[i2 + 1] * dt;

      cArr[i * 3] = cPos[i2];
      cArr[i * 3 + 1] = cPos[i2 + 1];
      cArr[i * 3 + 2] = 0;

      /* 槽位粒子更亮（正好压在笔画上，是"充能"）；公转粒子是光尘 */
      /* 槽位：压在笔画上 → 亮；公转：光尘。指针在时公转粒子收得很紧，
         太亮会糊成一团脏斑，压到 0.55；待机星尘散得开，0.72 才看得见 */
      /* 槽位粒子的亮度按角色分档：边框（role 3）本身在骨架里就比文字暗一级
         （ROLE_A 0.70 vs 0.88），灌注时不能一视同仁提到 1.15 —— 那会让边框
         比文字还亮，看起来像"把控件外框描了出来"。 */
      const slotA = this.cRole[i] === 3 ? 0.72 : 1.15;
      const base = this.cMode[i] === 1 ? slotA : (this.ptr.on ? 1.0 : 0.30);
      this.cAlpha[i] = this.cAmp[i] * base * this.cFade[i] * burst * this.gainC;
    }

    this.cGeo.attributes.position.needsUpdate = true;
    this.cGeo.attributes.aAlpha.needsUpdate = true;
    this.cGeo.attributes.aSize.needsUpdate = true;

    /* ───────── 连线 ─────────
       骨架/槽位：拓扑不用变（目标是静止的），只跟一遍位置；
       公转：云团在转，每 6 帧重建一次拓扑，中间靠 syncLinks 跟着走 */
    this.syncLinks(this.lnkSkel, this.pos);
    if (this.lnkSlot.n) this.syncLinks(this.lnkSlot, this.cPos);
    if (this.ptr.on) {
      if ((this._lnkTick = (this._lnkTick | 0) + 1) % 6 === 0) this.rebuildOrbLinks();
      this.syncLinks(this.lnkOrb, this.cPos);
    } else if (this.lnkOrb.n) {
      this.lnkOrb.n = 0;
      this.lnkOrb.obj.visible = false;
    }
  }

  render() {
    this.renderer.render(this.scene, this.cam);
  }
}
