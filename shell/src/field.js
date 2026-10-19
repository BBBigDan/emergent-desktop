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
/* 球面纬度带（原型：5 带、带高 0.168、间隔 0.030，从 y≈1 铺到赤道） */
const BANDS = 5;
const BAND_H = 0.168;
const BAND_GAP = 0.030;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

const SHAPES = ['sphere', 'torus', 'galaxy', 'wave'];
const SHAPE_MS = 9000;    // 原型 shapeState.interval = 9
const FLOURISH_S = 0.9;   // 重组后 0.9s 内先向核心收拢再展开

const AMBIENT_N = 4600;
const PER_BAND = Math.ceil(AMBIENT_N / BANDS);
const LINK_CAP = 5200;   // 形态连线容量
const RIM_PER_WIN = 760;
const MAX_WIN = 3;
const N = AMBIENT_N + RIM_PER_WIN * MAX_WIN;

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

/* ------------------------------- 时间轴 -------------------------------- */
const SEED_MS = 420;    // 先聚成一个小点，在点上自己流动一会儿
const GROW_MS = 1900;   // 缓慢撑开
const REVEAL_A = 0.72;  // 涨到这个比例才开始让 iframe 析出
const SCATTER_FADE = 0.42;
const SCATTER_LIFE = 1.35;

export class Field {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = 1;
    this.H = 1;
    this.time = 0;
    this.groups = [];
    for (let g = 0; g < MAX_WIN; g++) {
      this.groups.push({ active: false, closing: false, t: 0, pe: 0.019, rect: null, scatter: 0 });
    }

    /* --- 粒子状态 --- */
    const n = N;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 2);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.kind = new Uint8Array(n);      // 0 ambient / 1 rim
    this.group = new Uint8Array(n);
    this.u = new Float32Array(n);       // 轮廓参数
    this.off = new Float32Array(n);     // 法向偏移
    this.spd = new Float32Array(n);     // 沿边流速
    this.baseA = new Float32Array(n);
    this.baseS = new Float32Array(n);
    this.phase = new Float32Array(n);

    /* --- 空闲态形态 --- */
    this.sd = new Float32Array(n * 3);   // 单位球方向（sphere 直接复用）
    this.ta = new Float32Array(n * 3);   // 当前形态目标（3D，归一化半径 1）
    this.pu = new Float32Array(n);
    this.pv = new Float32Array(n);
    this.pr1 = new Float32Array(n);
    this.pr2 = new Float32Array(n);
    this.tp = new Uint8Array(n);         // 0..4 分区（环面分段 / 星系旋臂）
    this.form = 0;                       // 0 = 自由漂移，1 = 完全成形态
    this.shapeId = 0;
    this.shapeSeed = Math.random();
    this.shapeT = 0;                     // 距上次重组的毫秒数
    this.shapeAt = -99;                  // 上次重组时刻（flourish 用）
    this.waveF = 2.6;                    // wave 的频率/振幅（重组时按 seed 变）
    this.waveA = 0.10;

    for (let i = 0; i < n; i++) {
      /* ambient 按纬度带取色（五色分区）；rim 仍用加权随机 */
      const c = i < AMBIENT_N ? PAL[Math.min(BANDS - 1, Math.floor(i / PER_BAND))] : pickColor();
      this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
      this.phase[i] = Math.random() * Math.PI * 2;
      /* 球面：Fibonacci 分布 + 按 5 条纬度带切分（照原型 baseDir）。
         均匀球面出来只是一团散点；纬度带才有原型那种横条纹和分区配色。 */
      const b = Math.min(BANDS - 1, Math.floor(i / PER_BAND));
      const j = i - b * PER_BAND;
      const cnt = Math.min(PER_BAND, AMBIENT_N - b * PER_BAND);
      const y0 = 1 - b * (BAND_H + BAND_GAP) - 0.006;
      const y1 = y0 - BAND_H;
      const by = y1 + (y0 - y1) * (cnt === 1 ? 0.5 : j / (cnt - 1));
      const brr = Math.sqrt(Math.max(0, 1 - by * by));
      const bth = GOLDEN * j + b * 2.399;
      this.sd[i * 3] = Math.cos(bth) * brr;
      this.sd[i * 3 + 1] = by;
      this.sd[i * 3 + 2] = Math.sin(bth) * brr;
      this.pu[i] = Math.random();
      this.pv[i] = Math.random();
      this.pr1[i] = Math.random();
      this.pr2[i] = Math.random();
      this.tp[i] = i < AMBIENT_N ? Math.min(BANDS - 1, Math.floor(i / PER_BAND)) : i % 5;
      if (i < AMBIENT_N) {
        this.kind[i] = 0;
        this.size[i] = this.baseS[i] = 1.1 + Math.random() * 2.1;
        this.alpha[i] = this.baseA[i] = 0.20 + Math.random() * 0.34;
        this.pos[i * 3] = (Math.random() - 0.5) * 2400;
        this.pos[i * 3 + 1] = (Math.random() - 0.5) * 1600;
        this.pos[i * 3 + 2] = Math.random() * 2 - 1;
        this.vel[i * 2] = (Math.random() - 0.5) * 16;
        this.vel[i * 2 + 1] = (Math.random() - 0.5) * 16;
      } else {
        const k = i - AMBIENT_N;
        this.kind[i] = 1;
        this.group[i] = Math.floor(k / RIM_PER_WIN);
        this.u[i] = Math.random();
        const r = Math.random();
        const halo = r > 0.72;
        this.off[i] = halo ? 12 + Math.pow(Math.random(), 1.5) * 54 : (Math.random() * 2 - 1) * 9;
        this.spd[i] = (halo ? 40 + Math.random() * 90 : 130 + Math.random() * 190) * (Math.random() < 0.9 ? 1 : -1);
        this.baseS[i] = halo ? 1.2 + Math.random() * 1.6 : 1.9 + Math.random() * 2.0;
        this.baseA[i] = halo ? 0.16 + Math.random() * 0.22 : 0.52 + Math.random() * 0.40;
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

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: 1 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        varying vec3 vColor; varying float vAlpha; uniform float uDpr;
        void main(){
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uDpr;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d) * 4.0;
          if (r2 > 1.0) discard;
          float core = pow(1.0 - r2, 1.6);          // 中心实、边缘柔
          gl_FragColor = vec4(vColor * core * vAlpha, 1.0);  // 加色混合需预乘
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;

    /* ---- 形态连线：只点亮不连，出来是一团散沙；连起来才是原型那种"神经网" ---- */
    this.linkPairs = new Int32Array(LINK_CAP * 2);
    this.linkPos = new Float32Array(LINK_CAP * 6);
    this.linkN = 0;
    this.linkGeo = new THREE.BufferGeometry();
    this.linkGeo.setAttribute('position', new THREE.BufferAttribute(this.linkPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.linkGeo.setDrawRange(0, 0);
    this.linkMat = new THREE.LineBasicMaterial({
      color: 0x49c8e8,
      transparent: true,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.links = new THREE.LineSegments(this.linkGeo, this.linkMat);
    this.links.frustumCulled = false;

    this.scene = new THREE.Scene();
    this.scene.add(this.links);
    this.scene.add(this.points);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
    this.cam.position.z = 10;
    this.resize();
    this.computeShape();   // 先算一次，否则 ta 全 0，第一帧粒子会全飞向原点
    this.buildLinks();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.W, this.H, false);
    this.mat.uniforms.uDpr.value = dpr;
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

  open(g, rect) {
    this.setRect(g, rect);
    const grp = this.groups[g];
    grp.active = true;
    grp.closing = false;
    grp.t = 0;
    grp.scatter = 0;
  }

  close(g) {
    const grp = this.groups[g];
    if (!grp.active || grp.closing) return;
    grp.closing = true;
    grp.scatter = 0;
    // 给每个 rim 粒子一个向外+切向的初速，避免「啪」地全朝一个方向走
    for (let i = AMBIENT_N; i < N; i++) {
      if (this.group[i] !== g) continue;
      const px = this.pos[i * 3], py = this.pos[i * 3 + 1];
      const cx = grp.rect ? grp.rect.cx : 0, cy = grp.rect ? grp.rect.cy : 0;
      let dx = px - cx, dy = py - cy;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      const ang = (Math.random() - 0.5) * 0.9;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
      const sp = 130 + Math.random() * 320;
      this.vel[i * 2] = rx * sp;
      this.vel[i * 2 + 1] = ry * sp;
    }
  }

  /* ------------------- 空闲态：聚成形态并自动重组 -------------------
   * 坐标一律归一化到半径 1，最后乘一个和屏幕相关的 scale，
   * 这样换分辨率/窗口尺寸时形态大小自动跟着变。
   */
  /** 在形态目标（归一化 3D）上按近邻建连，每点最多 2 条 */
  buildLinks() {
    const n = AMBIENT_N, T = this.ta;
    const cell = 0.085;
    const off = 2048;
    const K = (cx, cy, cz) => ((cx + off) * 4096 + (cy + off)) * 4096 + (cz + off);
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const k = K(Math.floor(T[i * 3] / cell), Math.floor(T[i * 3 + 1] / cell), Math.floor(T[i * 3 + 2] / cell));
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(i);
    }
    const pr = this.linkPairs, cap = LINK_CAP;
    let cnt = 0;
    for (let i = 0; i < n && cnt < cap; i++) {
      const x = T[i * 3], y = T[i * 3 + 1], z = T[i * 3 + 2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let made = 0;
      for (let dx = -1; dx <= 1 && made < 2; dx++)
        for (let dy = -1; dy <= 1 && made < 2; dy++)
          for (let dz = -1; dz <= 1 && made < 2; dz++) {
            const b = buckets.get(K(cx + dx, cy + dy, cz + dz));
            if (!b) continue;
            for (let k = 0; k < b.length && made < 2; k++) {
              const j = b[k];
              if (j <= i) continue;
              const ax = T[j * 3] - x, ay = T[j * 3 + 1] - y, az = T[j * 3 + 2] - z;
              if (ax * ax + ay * ay + az * az > cell * cell * 2.2) continue;
              pr[cnt * 2] = i; pr[cnt * 2 + 1] = j;
              cnt++; made++;
            }
          }
    }
    this.linkN = cnt;
    this.linkGeo.setDrawRange(0, cnt * 2);
    this.syncLinks();
  }

  /** 每帧把粒子当前位置写进线段端点（连的是粒子，不是目标点） */
  syncLinks() {
    const n = this.linkN;
    if (!n) return;
    const p = this.linkPos, pr = this.linkPairs, P = this.pos;
    for (let k = 0; k < n; k++) {
      const a = pr[k * 2], b = pr[k * 2 + 1], o = k * 6;
      p[o] = P[a * 3]; p[o + 1] = P[a * 3 + 1]; p[o + 2] = 0;
      p[o + 3] = P[b * 3]; p[o + 4] = P[b * 3 + 1]; p[o + 5] = 0;
    }
    this.linkGeo.attributes.position.needsUpdate = true;
  }

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
      const spin = 1.6 + ((seed * 3.31) % 1) * 1.3;
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
      this.waveF = 2.2 + seed * 1.4;
      this.waveA = 0.07 + ((seed * 5.17) % 1) * 0.05;
    }
  }

  /** 每帧：投影 + 弹簧。正交相机没有透视，深度得手工换成大小/亮度 */
  stepShape(dt) {
    const t = this.time;
    const n = AMBIENT_N;
    const T = this.ta, P = this.pos, V = this.vel;
    const S = SHAPES[this.shapeId];

    /* 重组节奏：9s 一次；切换后 0.9s 内向核心收拢再展开（原型 flourish + 呼吸包络） */
    this.shapeT += dt * 1000;
    if (this.shapeT >= SHAPE_MS) {
      this.shapeT = 0;
      this.shapeId = (this.shapeId + 1) % SHAPES.length;
      this.shapeSeed = Math.random();
      this.computeShape();
      this.buildLinks();
      this.shapeAt = t;
    }
    const flour = Math.max(0, 1 - (t - this.shapeAt) / FLOURISH_S);
    const breath = 0.5 + 0.5 * Math.sin(t * 0.9);
    const R = Math.min(this.W, this.H) * 0.33;
    const scale = R * (1 - 0.62 * flour) * (0.95 + 0.10 * breath);

    /* 缓慢自转 + 固定俯角 —— 把 3D 形态压成 2D 投影 */
    const ry = t * 0.20 + this.shapeSeed * 6.28;
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const tilt = S === 'wave' ? 0.92 : S === 'galaxy' ? 0.62 : 0.36;
    const cx = Math.cos(tilt), sx = Math.sin(tilt);

    const k = 46 * this.form;
    const c = 2 * Math.sqrt(46 * this.form) * 0.9;
    const f = this.form;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3, i2 = i * 2;
      let x3 = T[i3], y3 = T[i3 + 1], z3 = T[i3 + 2];
      if (S === 'wave') {
        y3 = Math.sin(x3 * this.waveF + t * 1.25) * this.waveA
          + Math.cos(z3 * this.waveF * 1.15 + t) * this.waveA * 0.8;
      }
      /* 先绕 Y 再绕 X */
      const x1 = x3 * cy + z3 * sy;
      const z1 = -x3 * sy + z3 * cy;
      const y2 = y3 * cx - z1 * sx;
      const z2 = y3 * sx + z1 * cx;

      const tx = x1 * scale, ty = y2 * scale;

      V[i2] = (V[i2] + (tx - P[i3]) * k * dt) / (1 + c * dt);
      V[i2 + 1] = (V[i2 + 1] + (ty - P[i3 + 1]) * k * dt) / (1 + c * dt);
      P[i3] += V[i2] * dt;
      P[i3 + 1] += V[i2 + 1] * dt;

      /* 远侧更小更暗：正交投影里唯一的立体线索（ambient 的 baseA 只有 0.2~0.54，
         形态态要提上去才看得清，否则整团是灰的） */
      const dzk = clamp(0.62 + z2 * 0.45, 0.30, 1.20);
      const sa = this.baseA[i] * dzk * 2.6;
      const ss = this.baseS[i] * (1.05 + 0.75 * dzk);
      this.alpha[i] += (sa - this.alpha[i]) * f;
      this.size[i] += (ss - this.size[i]) * f;
    }
  }

  peOf(t) {
    if (t <= SEED_MS) return 0.019;
    const u = clamp((t - SEED_MS) / GROW_MS, 0, 1);
    const f = u < 0.18 ? 0.05 * smooth(0, 1, u / 0.18) : 0.05 + 0.95 * smooth(0, 1, (u - 0.18) / 0.82);
    return 0.019 + (1 - 0.019) * f;
  }

  /* 返回给 DOM 层用的揭示进度（0..1），由 window.js 拿去做 iframe 淡入 */
  revealOf(g) {
    const grp = this.groups[g];
    if (!grp.active) return 0;
    if (grp.closing) return clamp(1 - grp.scatter / SCATTER_FADE, 0, 1);
    return smooth(REVEAL_A, 0.985, grp.pe);
  }

  step(dt) {
    this.time += dt;
    const t = this.time;

    /* ---- 空闲态判定：所有窗口都关了 → 粒子聚成形态 ---- */
    const idle = !this.groups.some((g) => g.active || g.closing);
    this.form = clamp(this.form + (idle ? 1 : -1) * dt * 1.3, 0, 1);

    /* ---- ambient：自由漂移，强度按 (1-form) 衰减 ---- */
    const free = 1 - this.form;
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
      this.alpha[i] = this.baseA[i] * (0.78 + 0.22 * Math.sin(t * 0.7 + ph));
    }

    /* ---- 形态：弹簧把粒子拉向投影后的目标 ---- */
    if (this.form > 0.01) this.stepShape(dt);
    /* 连线跟着粒子走；形态退场时一起淡出 */
    this.links.visible = this.form > 0.04;
    this.linkMat.opacity = 0.24 * this.form;
    if (this.links.visible) this.syncLinks();

    /* ---- rim：每个窗口一组 ---- */
    for (let g = 0; g < MAX_WIN; g++) {
      const grp = this.groups[g];
      if (!grp.active) continue;

      if (grp.closing) {
        grp.scatter += dt;
        const fade = clamp(1 - grp.scatter / SCATTER_LIFE, 0, 1);
        if (grp.scatter > SCATTER_LIFE) { grp.active = false; grp.closing = false; }
        for (let i = AMBIENT_N; i < N; i++) {
          if (this.group[i] !== g) continue;
          this.vel[i * 2] *= 1 - 1.6 * dt;
          this.vel[i * 2 + 1] *= 1 - 1.6 * dt;
          this.pos[i * 3] += this.vel[i * 2] * dt;
          this.pos[i * 3 + 1] += this.vel[i * 2 + 1] * dt;
          this.alpha[i] = this.baseA[i] * fade;
          this.size[i] = this.baseS[i] * (0.6 + 0.4 * fade);
        }
        grp.pe = 1;
        continue;
      }

      grp.t += dt * 1000;
      grp.pe = this.peOf(grp.t);
      const pe = grp.pe;
      const R = grp.rect;
      if (!R) continue;

      const ax = Math.max(R.hw * pe, 3), ay = Math.max(R.hh * pe, 3);
      const rr = Math.max(R.r * pe, 1);
      const P = shapeAt(0, ax, ay, rr, SH) || 1;
      const seeding = grp.t <= SEED_MS;
      const birthing = pe < 0.9995;
      const K = birthing ? (seeding ? 620 : 560) : 90;
      const C = birthing ? (seeding ? 170 : 64) : 17;
      const vScale = clamp(Math.sqrt(P / Math.max(2 * (2 * R.hw + 2 * R.hh), 1)), 0.06, 1);
      const reveal = smooth(REVEAL_A, 0.985, pe);

      for (let i = AMBIENT_N; i < N; i++) {
        if (this.group[i] !== g) continue;
        const P2 = shapeAt(this.u[i], ax, ay, rr, SH);
        this.u[i] += (this.spd[i] * vScale * dt) / Math.max(P2, 1);
        if (this.u[i] > 1) this.u[i] -= 1; else if (this.u[i] < 0) this.u[i] += 1;

        const nx = SH.nx, ny = SH.ny;
        const off = this.off[i] * (seeding ? 0.35 : 1);
        const tx = R.cx + SH.x + nx * off;
        const ty = R.cy + SH.y + ny * off;

        const k = K, c = C;
        this.vel[i * 2] = (this.vel[i * 2] + (tx - this.pos[i * 3]) * k * dt) / (1 + c * dt);
        this.vel[i * 2 + 1] = (this.vel[i * 2 + 1] + (ty - this.pos[i * 3 + 1]) * k * dt) / (1 + c * dt);
        this.pos[i * 3] += this.vel[i * 2] * dt;
        this.pos[i * 3 + 1] += this.vel[i * 2 + 1] * dt;
        this.pos[i * 3 + 2] = R.rect ? 0 : 0;

        // 小点阶段稀疏化：全挤在一点会糊成一团死白
        const keep = 0.06 + 0.94 * Math.pow(smooth(0.02, 0.46, pe), 1.2);
        const vis = this.phase[i] < keep * 6.283 ? 1 : 0.02;
        this.alpha[i] = this.baseA[i] * vis * (0.55 + 0.45 * reveal);
        this.size[i] = this.baseS[i] * (0.75 + 0.25 * reveal);
      }
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  render() {
    this.renderer.render(this.scene, this.cam);
  }
}
