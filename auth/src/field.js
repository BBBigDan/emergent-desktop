/**
 * 点阵粒子场 —— 登录界面本身就是这些粒子，没有任何背景板。
 *
 * 两组粒子：
 *   dots  —— 由「墨稿」采样得到的点阵（用户名、提示、输入框、箭头）
 *   orbit —— 头像外圈的粒子流：不同半径不同角速度，形成剪切流动，
 *            把头像「包」起来；亮度带沿圆周扫过，看起来是活的
 *
 * 呼吸、鼠标高亮、环流全在 vertex shader 里算，CPU 每帧只更新点阵位置。
 */
import * as THREE from 'three';
import { CELL } from './ui.js';

const MAX = 7000;
const ORBIT_N = 900;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* role → 基础亮度 / 点径系数（索引对齐 ui.js 的 ROLE） */
const ROLE_A = [0, 1.00, 0.56, 0.62, 0.98, 0.78, 0.44, 0.95, 0.52];
const ROLE_S = [0, 1.12, 0.88, 0.92, 1.10, 1.00, 0.86, 1.06, 0.84];

export class Field {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = 1;
    this.H = 1;
    this.time = 0;
    this.scale = 1;
    this.burstAt = -1;

    /* ─────────── 点阵 ─────────── */
    const n = MAX;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 2);
    this.tgt = new Float32Array(n * 3);
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
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aScale, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.sScale, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uDpr: { value: 1 },
        uTime: { value: 0 },
        uMouse: { value: new THREE.Vector2(0, 0) },
        uMouseOn: { value: 0 },
        uMouseR: { value: 100 },
      },
      vertexShader: `
        attribute float aAlpha; attribute float aSize; attribute float aSeed;
        varying float vA;
        uniform float uDpr; uniform float uTime;
        uniform vec2 uMouse; uniform float uMouseOn; uniform float uMouseR;
        void main(){
          float breath = 0.88 + 0.12 * sin(uTime * (0.55 + aSeed * 0.75) + aSeed * 6.2831);
          float d = distance(position.xy, uMouse);
          float hover = uMouseOn * smoothstep(uMouseR, 0.0, d);
          vA = clamp(aAlpha * breath + hover * 0.85, 0.0, 1.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uDpr * (1.0 + hover * 0.42);
        }`,
      fragmentShader: `
        varying float vA;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d) * 4.0;
          if (r2 > 1.0) discard;
          float core = pow(1.0 - r2, 1.55);
          /* 预乘 alpha：a 必须等于亮度。写成 vec4(rgb, 1.0) 会变成「黑色不透明点」，
             在头像上方就是一圈黑污渍 —— 桌面页背景是黑的所以看不出来。 */
          float a = core * vA;
          gl_FragColor = vec4(vec3(0.62, 0.90, 1.0) * a, a);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      /* 标准 alpha 合成（预乘）：这样画在头像上方是「发光点」而不是「黑点」。
         Additive 要求 a=1，那会整块盖住头像；加色又会让预乘乘两次变全黑。 */
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;

    /* ─────────── 头像粒子流 ─────────── */
    const or = new Float32Array(ORBIT_N * 3);
    this.oA = new Float32Array(ORBIT_N);      // 初始角
    this.oW = new Float32Array(ORBIT_N);      // 角速度
    this.oOff = new Float32Array(ORBIT_N);    // 相对头像半径的偏移（逻辑 px，负值 = 压在头像上）
    this.oS = new Float32Array(ORBIT_N);      // 点径
    this.oAmp = new Float32Array(ORBIT_N);    // 亮度
    this.oPh = new Float32Array(ORBIT_N);     // 相位

    for (let i = 0; i < ORBIT_N; i++) {
      this.oA[i] = Math.random() * Math.PI * 2;
      /* 大部分贴着边缘，少数外散成雾；内圈相对慢一点，避免像齿轮 */
      const u = Math.random();
      if (u < 0.62) this.oOff[i] = -4.5 + Math.random() * 10;   // 贴身层：贴着头像边缘走
      else if (u < 0.90) this.oOff[i] = 6 + Math.pow(Math.random(), 1.4) * 24;
      else this.oOff[i] = 28 + Math.pow(Math.random(), 1.6) * 30; // 外雾
      /* 内快外慢 → 剪切层，看起来像被头像「拖着走」 */
      const base = 0.62 / (1 + Math.max(0, this.oOff[i]) * 0.055);
      this.oW[i] = base * (0.75 + Math.random() * 0.5) * (Math.random() < 0.86 ? 1 : -1);
      this.oS[i] = 1.7 + Math.random() * 2.2;
      this.oAmp[i] = 0.44 + Math.random() * 0.55;
      this.oPh[i] = Math.random() * Math.PI * 2;
    }

    this.oGeo = new THREE.BufferGeometry();
    this.oGeo.setAttribute('position', new THREE.BufferAttribute(or, 3).setUsage(THREE.DynamicDrawUsage));
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
      },
      vertexShader: `
        attribute float aA; attribute float aW; attribute float aOff;
        attribute float aSize; attribute float aAmp; attribute float aPh;
        varying float vA;
        uniform float uDpr; uniform float uTime; uniform vec2 uCenter;
        uniform float uR; uniform float uPx; uniform float uOpacity;
        void main(){
          float ang = aA + uTime * aW;
          float rr = uR + aOff * uPx + sin(uTime * 1.7 + aPh) * 2.4 * uPx;
          vec3 p = vec3(uCenter.x + cos(ang) * rr, uCenter.y + sin(ang) * rr, 0.0);
          /* 亮带沿圆周扫过，粒子像被光流过 */
          float band = 0.58 + 0.42 * sin(ang * 2.0 - uTime * 1.35 + aPh);
          /* 外圈更淡，避免喧宾夺主 */
          float falloff = 1.0 - clamp((aOff - 2.0) / 40.0, 0.0, 0.84);
          vA = aAmp * band * falloff * uOpacity;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPx * uDpr * (0.85 + band * 0.3);
        }`,
      fragmentShader: `
        varying float vA;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d) * 4.0;
          if (r2 > 1.0) discard;
          float core = pow(1.0 - r2, 1.5);
          float a = core * vA;
          gl_FragColor = vec4(vec3(0.56, 0.92, 1.0) * a, a);
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      /* 标准 alpha 合成（预乘）：这样画在头像上方是「发光点」而不是「黑点」。
         Additive 要求 a=1，那会整块盖住头像；加色又会让预乘乘两次变全黑。 */
      blending: THREE.NormalBlending,
    });

    this.oPoints = new THREE.Points(this.oGeo, this.oMat);
    this.oPoints.frustumCulled = false;

    this.scene = new THREE.Scene();
    this.scene.add(this.points);
    this.scene.add(this.oPoints);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
    this.cam.position.z = 10;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = this.canvas.clientWidth || window.innerWidth;
    this.H = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.W, this.H, false);
    this.mat.uniforms.uDpr.value = dpr;
    this.oMat.uniforms.uDpr.value = dpr;
    this.cam.left = -this.W / 2;
    this.cam.right = this.W / 2;
    this.cam.top = this.H / 2;
    this.cam.bottom = -this.H / 2;
    this.cam.updateProjectionMatrix();
  }

  /** 头像的位置与半径（逻辑坐标），用来摆粒子流 */
  setAvatar(lx, ly, lr, scale, LW, LH) {
    this.oMat.uniforms.uCenter.value.set((lx - LW / 2) * scale, (LH / 2 - ly) * scale);
    this.oMat.uniforms.uR.value = lr * scale;
    this.oMat.uniforms.uPx.value = scale;
  }

  setPoints(pts, scale, LW, LH) {
    this.scale = scale;
    const pointSize = CELL * scale * 1.18;

    const M = pts.length / 4;
    const keep = new Set();
    const ox = LW / 2, oy = LH / 2;

    for (let k = 0; k < M; k++) {
      const lx = pts[k * 4], ly = pts[k * 4 + 1], role = pts[k * 4 + 2], key = pts[k * 4 + 3];
      keep.add(key);
      const wx = (lx - ox) * scale;
      const wy = (oy - ly) * scale;

      let idx = this.byKey.get(key);
      if (idx === undefined) {
        if (this.free.length) idx = this.free.pop();
        else if (this.top < MAX) idx = this.top++;
        else continue;
        this.byKey.set(key, idx);
        this.key[idx] = key;
        /* 新点直接在目标位置淡入，不从别处飞 —— 打一个字不该整屏重排 */
        this.pos[idx * 3] = wx;
        this.pos[idx * 3 + 1] = wy;
        this.vel[idx * 2] = 0;
        this.vel[idx * 2 + 1] = 0;
        this.fade[idx] = 0;
      }
      this.tgt[idx * 3] = wx;
      this.tgt[idx * 3 + 1] = wy;
      this.role[idx] = role;
      this.aScale[idx] = ROLE_A[role] ?? 0.6;
      this.sScale[idx] = pointSize * (ROLE_S[role] ?? 1);
    }

    for (const [key, idx] of this.byKey) {
      if (!keep.has(key)) {
        this.byKey.delete(key);
        this.dying.push(idx);
      }
    }

    this.geo.setDrawRange(0, this.top);
  }

  burst() {
    if (this.burstAt >= 0) return;
    this.burstAt = this.time;
    for (let i = 0; i < this.top; i++) {
      const px = this.pos[i * 3], py = this.pos[i * 3 + 1];
      const d = Math.hypot(px, py) || 1;
      const nx = px / d, ny = py / d;
      const ang = (Math.random() - 0.5) * 1.1;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const sp = 160 + Math.random() * 560;
      this.vel[i * 2] = (nx * ca - ny * sa) * sp;
      this.vel[i * 2 + 1] = (nx * sa + ny * ca) * sp;
    }
  }

  /** 头像的粒子流也跟着散开 */
  burstAvatar() {
    if (this.avatarBurst === undefined) this.avatarBurst = this.time;
  }

  setMouse(x, y, on) {
    this.mat.uniforms.uMouse.value.set(x - this.W / 2, this.H / 2 - y);
    this.mat.uniforms.uMouseOn.value = on ? 1 : 0;
  }

  step(dt) {
    this.time += dt;
    const t = this.time;
    this.mat.uniforms.uTime.value = t;
    this.oMat.uniforms.uTime.value = t;

    /* 头像粒子流：成功时整体散开淡出 */
    if (this.avatarBurst !== undefined) {
      const k = clamp(1 - (t - this.avatarBurst) / 0.9, 0, 1);
      this.oMat.uniforms.uOpacity.value = k;
      this.oMat.uniforms.uR.value += dt * 260;
    }

    if (this.burstAt >= 0) {
      const fade = clamp(1 - (t - this.burstAt) / 0.95, 0, 1);
      for (let i = 0; i < this.top; i++) {
        this.pos[i * 3] += this.vel[i * 2] * dt;
        this.pos[i * 3 + 1] += this.vel[i * 2 + 1] * dt;
        this.vel[i * 2] *= 1 - 1.1 * dt;
        this.vel[i * 2 + 1] *= 1 - 1.1 * dt;
        this.aScale[i] = (ROLE_A[this.role[i]] ?? 0.6) * fade * 1.4;
        this.sScale[i] *= 1 + 0.9 * dt;
      }
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      return;
    }

    /* 弹簧跟随（半隐式阻尼，无条件稳定） */
    const K = 620, C = 40;
    let moved = false;

    for (let i = 0; i < this.top; i++) {
      if (this.fade[i] < 1) this.fade[i] = Math.min(1, this.fade[i] + dt * 6.5);

      const dx = this.tgt[i * 3] - this.pos[i * 3];
      const dy = this.tgt[i * 3 + 1] - this.pos[i * 3 + 1];
      if (dx * dx + dy * dy > 0.02) {
        this.vel[i * 2] = (this.vel[i * 2] + dx * K * dt) / (1 + C * dt);
        this.vel[i * 2 + 1] = (this.vel[i * 2 + 1] + dy * K * dt) / (1 + C * dt);
        this.pos[i * 3] += this.vel[i * 2] * dt;
        this.pos[i * 3 + 1] += this.vel[i * 2 + 1] * dt;
        moved = true;
      } else {
        this.pos[i * 3] = this.tgt[i * 3];
        this.pos[i * 3 + 1] = this.tgt[i * 3 + 1];
        this.vel[i * 2] = this.vel[i * 2 + 1] = 0;
      }
      this.aScale[i] = (ROLE_A[this.role[i]] ?? 0.6) * this.fade[i];
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
          this.aScale[i] = (ROLE_A[this.role[i]] ?? 0.6) * this.fade[i];
          rest.push(i);
        }
      }
      this.dying = rest;
    }

    if (moved || this.dying.length) this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  render() {
    this.renderer.render(this.scene, this.cam);
  }
}
