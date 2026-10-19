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

const AMBIENT_N = 3200;
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

    for (let i = 0; i < n; i++) {
      const c = pickColor();
      this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
      this.phase[i] = Math.random() * Math.PI * 2;
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
    this.scene = new THREE.Scene();
    this.scene.add(this.points);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
    this.cam.position.z = 10;
    this.resize();
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

    /* ---- ambient：缓慢漂移 + 边界环绕 ---- */
    const hw = this.W / 2 + 60, hh = this.H / 2 + 60;
    for (let i = 0; i < AMBIENT_N; i++) {
      const ph = this.phase[i];
      this.vel[i * 2] += Math.cos(t * 0.23 + ph) * 3.2 * dt;
      this.vel[i * 2 + 1] += Math.sin(t * 0.19 + ph * 1.3) * 3.2 * dt;
      this.vel[i * 2] *= 1 - 0.55 * dt;
      this.vel[i * 2 + 1] *= 1 - 0.55 * dt;
      let x = this.pos[i * 3] + this.vel[i * 2] * dt;
      let y = this.pos[i * 3 + 1] + this.vel[i * 2 + 1] * dt;
      if (x > hw) x = -hw; else if (x < -hw) x = hw;
      if (y > hh) y = -hh; else if (y < -hh) y = hh;
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.alpha[i] = this.baseA[i] * (0.78 + 0.22 * Math.sin(t * 0.7 + ph));
    }

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
