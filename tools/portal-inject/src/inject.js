/**
 * Olares 粒子门 · 注入版（调试用外挂层）
 * ---------------------------------------------------------------------------
 * 由 Tampermonkey 脚本把本文件（连同 three）注入到 Olares Desktop 页面执行。
 * 不改官方仓库一行代码，即可验证「窗口从粒子流里长出来」的交互。
 *
 * 与 particle-sphere/src/portal.js 的区别：
 *   - 不创建 iframe：直接绑定页面上已存在的窗口元素（Olares 的 .iframe-box）
 *   - 不做 DOM 布局：每帧读 getBoundingClientRect()，窗口被拖动/缩放时粒子环跟着走
 *   - 只保留一条时间轴：聚点 → 缓慢扩环 → 窗口渐现 → 环流；scatter() 可炸开
 *
 * 依赖：外层作用域里的 THREE（由 bundle 注入），以及 API：
 *   window.__OP__ = { replay, scatter, dispose, stats, setTarget }
 * 深链（仅 mock 页用）：?op-at=1.6&op-freeze=1 定格、?op-n=4000 改粒子数
 */
(function () {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const qs = new URLSearchParams(location.search);
  const readNum = (k, d, lo, hi) => clamp(parseFloat(qs.get(k) || localStorage.getItem(k) || d), lo, hi);

  const CFG = {
    N: Math.round(readNum('op-n', 6000, 1200, 12000)),
    SEED: 0.70,          // 聚拢时长（秒）
    GROW: 4.60,          // 扩环时长（秒）
    REVEAL_A: 0.86,      // 窗口开始淡入的 pe
    REVEAL_B: 0.995,
    SCATTER_LIFE: 1.60,
    MIN_HALF: 0.019,     // 最小半径 = 视口高 × 0.019（"一个点"）
    IDLE_K: 90, IDLE_C: 17,      // 稳态：滞后 = v·C/K ≈ 47px
    BIRTH_K: 560, BIRTH_C: 64,   // 生长：更硬，避免"窗口跑在前面"
  };

  const PAL = [
    [0.62, 0.86, 1.00],
    [0.42, 0.72, 1.00],
    [0.30, 0.58, 0.98],
    [0.22, 0.42, 0.86],
  ];

  /* ============================ 渲染层 ============================ */
  const W = Math.max(320, innerWidth);
  const H = Math.max(240, innerHeight);
  let camera, renderer, points, geo;

  const canvas = document.createElement('canvas');
  canvas.id = 'op-scene';
  canvas.style.cssText =
    'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483000;' +
    'pointer-events:none;display:block;';
  document.body.appendChild(canvas);

  camera = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, -1000, 2000);
  camera.position.z = 1000;
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);

  /* 顶点/片元：点精灵按运动方向做椭圆拉伸 → 静止画面也能读出流向 */
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uDpr: { value: Math.min(devicePixelRatio || 1, 2) } },
    vertexShader: `
      attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
      attribute vec2 aDir; attribute float aStr;
      uniform float uDpr;
      varying vec3 vColor; varying float vAlpha; varying vec2 vDir; varying float vStr;
      void main() {
        vColor = aColor; vAlpha = aAlpha; vDir = aDir; vStr = aStr;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.0, aSize * uDpr);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vAlpha; varying vec2 vDir; varying float vStr;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        vec2 d = (length(vDir) > 1e-4) ? normalize(vDir) : vec2(1.0, 0.0);
        vec2 n = vec2(-d.y, d.x);
        vec2 q = vec2(dot(p, d) / (1.0 + vStr), dot(p, n) * (1.0 + vStr * 0.35));
        float r = length(q);
        if (r > 1.0) discard;
        float core = pow(1.0 - r, 3.0);
        gl_FragColor = vec4(vColor * core * vAlpha, 1.0);
      }`,
  });

  /* ============================ 粒子数据 ============================ */
  const N = CFG.N;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const aSize = new Float32Array(N);
  const aAlpha = new Float32Array(N);
  const aDir = new Float32Array(N * 2);
  const aStr = new Float32Array(N);
  const vel = new Float32Array(N * 2);

  const u = new Float32Array(N);      // 沿周长参数
  const spd = new Float32Array(N);    // px/s（正值=顺时针）
  const off = new Float32Array(N);    // 法向偏移（正=外）
  const kind = new Uint8Array(N);     // 0 rider 1 halo
  const jit = new Float32Array(N);
  const rnd = new Float32Array(N);
  const baseA = new Float32Array(N);
  const baseS = new Float32Array(N);
  const ks = new Float32Array(N);
  const tgtX = new Float32Array(N);
  const tgtY = new Float32Array(N);

  const W2 = W / 2, H2 = H / 2;
  for (let i = 0; i < N; i++) {
    // 初始散在屏幕各处，等待被收拢
    pos[i * 3] = (Math.random() - 0.5) * W * 1.15;
    pos[i * 3 + 1] = (Math.random() - 0.5) * H * 1.15;
    vel[i * 2] = 0; vel[i * 2 + 1] = 0;

    u[i] = Math.random();
    rnd[i] = Math.random();
    jit[i] = Math.random() * 100;
    off[i] = (Math.random() * 2 - 1) * (2 + Math.pow(Math.random(), 1.8) * 15);
    spd[i] = (150 + Math.random() * 210) * (Math.random() < 0.94 ? 1 : -1);
    baseS[i] = 2.0 + Math.random() * 2.2;
    ks[i] = 0.75 + Math.random() * 0.5;

    const r = Math.random();
    if (r < 0.84) {
      kind[i] = 0;
      baseA[i] = 0.78 + Math.random() * 0.52;
      aStr[i] = 0.55 + Math.random() * 0.55;
    } else {
      kind[i] = 1;
      baseA[i] = 0.26 + Math.random() * 0.30;
      baseS[i] = 1.3 + Math.random() * 1.9;
      aStr[i] = 0.2;
      off[i] = 10 + Math.pow(Math.random(), 1.6) * 46;
      spd[i] = (60 + Math.random() * 110) * (Math.random() < 0.85 ? 1 : -1);
    }
    const c = PAL[(Math.random() * PAL.length) | 0];
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    aAlpha[i] = 0;
    aDir[i * 2] = 1; aDir[i * 2 + 1] = 0;
  }

  geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aDir', new THREE.BufferAttribute(aDir, 2).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aStr', new THREE.BufferAttribute(aStr, 1).setUsage(THREE.DynamicDrawUsage));
  points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(points);

  /* ============================ 圆角矩形周长参数化 ============================ */
  /* 屏幕坐标系（y 向下）。out 复用以避免每帧分配。 */
  const rp = { L: 1, px: 0, py: 0, nx: 0, ny: -1, tx: 1, ty: 0 };
  function rectAt(uu, hw, hh, r) {
    r = Math.min(r, hw, hh);
    const w = 2 * (hw - r), h = 2 * (hh - r), arc = (Math.PI * r) / 2;
    const L = 2 * w + 2 * h + 4 * arc;
    let d = (((uu % 1) + 1) % 1) * L;
    const lens = [w, arc, h, arc, w, arc, h, arc];
    let i = 0;
    while (i < 7 && d > lens[i]) { d -= lens[i]; i++; }
    switch (i) {
      case 0: rp.px = -hw + r + d; rp.py = -hh; rp.nx = 0; rp.ny = -1; rp.tx = 1; rp.ty = 0; break;
      case 1: { const a = -Math.PI / 2 + d / r; rp.px = hw - r + Math.cos(a) * r; rp.py = -hh + r + Math.sin(a) * r; rp.nx = Math.cos(a); rp.ny = Math.sin(a); rp.tx = -Math.sin(a); rp.ty = Math.cos(a); break; }
      case 2: rp.px = hw; rp.py = -hh + r + d; rp.nx = 1; rp.ny = 0; rp.tx = 0; rp.ty = 1; break;
      case 3: { const a = d / r; rp.px = hw - r + Math.cos(a) * r; rp.py = hh - r + Math.sin(a) * r; rp.nx = Math.cos(a); rp.ny = Math.sin(a); rp.tx = -Math.sin(a); rp.ty = Math.cos(a); break; }
      case 4: rp.px = hw - r - d; rp.py = hh; rp.nx = 0; rp.ny = 1; rp.tx = -1; rp.ty = 0; break;
      case 5: { const a = Math.PI / 2 + d / r; rp.px = -hw + r + Math.cos(a) * r; rp.py = hh - r + Math.sin(a) * r; rp.nx = Math.cos(a); rp.ny = Math.sin(a); rp.tx = -Math.sin(a); rp.ty = Math.cos(a); break; }
      case 6: rp.px = -hw; rp.py = hh - r - d; rp.nx = -1; rp.ny = 0; rp.tx = 0; rp.ty = -1; break;
      default: { const a = Math.PI + d / r; rp.px = -hw + r + Math.cos(a) * r; rp.py = -hh + r + Math.sin(a) * r; rp.nx = Math.cos(a); rp.ny = Math.sin(a); rp.tx = -Math.sin(a); rp.ty = Math.cos(a); }
    }
    rp.L = L;
    return rp;
  }

  /* ============================ 窗口绑定 ============================ */
  const SEL = '.iframe-box';           // Olares Desktop 的窗口容器（BasicWindow.vue）
  let winEl = null;                    // 当前绑定的窗口
  let rect = null;                     // { cx, cy, hw, hh }（屏幕坐标）
  let bound = false;

  const rq = { cx: 0, cy: 0, hw: 10, hh: 10 };

  function measure() {
    if (!winEl || !winEl.isConnected) return null;
    const b = winEl.getBoundingClientRect();
    if (b.width < 8 || b.height < 8) return null;
    rq.cx = b.left + b.width / 2 - W2;     // 转世界坐标（中心为原点）
    rq.cy = H2 - (b.top + b.height / 2);
    rq.hw = b.width / 2;
    rq.hh = b.height / 2;
    return rq;
  }

  function bind(el) {
    if (!el || el === winEl) return;
    if (winEl) restoreWin();
    winEl = el;
    winEl.classList.add('op-bound');
    rect = measure();
    t = 0;
    lastRev = -1;
    scatterT = -1;
  }

  function restoreWin() {
    if (!winEl) return;
    winEl.style.opacity = '';
    winEl.style.filter = '';
    winEl.style.willChange = '';
    winEl.classList.remove('op-bound');
    winEl = null;
  }

  /* 注入的样式：窗口边缘做软遮罩，四角更虚（与粒子环的"渗化"一致） */
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .op-bound { will-change: opacity; }
    .op-bound .iframe-window, .op-bound > iframe {
      -webkit-mask-image:
        linear-gradient(to right, rgba(0,0,0,.35) 0, #000 60px, #000 calc(100% - 60px), rgba(0,0,0,.35) 100%),
        linear-gradient(to bottom, rgba(0,0,0,.35) 0, #000 44px, #000 calc(100% - 44px), rgba(0,0,0,.35) 100%);
      -webkit-mask-composite: source-in;
      mask-image:
        linear-gradient(to right, rgba(0,0,0,.35) 0, #000 60px, #000 calc(100% - 60px), rgba(0,0,0,.35) 100%),
        linear-gradient(to bottom, rgba(0,0,0,.35) 0, #000 44px, #000 calc(100% - 44px), rgba(0,0,0,.35) 100%);
      mask-composite: intersect;
    }`;
  document.head.appendChild(styleEl);

  /* ============================ 时间轴 ============================ */
  let t = 0;
  let animT = 0;
  let scatterT = -1;
  let lastRev = -1;
  let frameCount = 0, fpsAcc = 0, fps = 0;

  const peOf = (tt) => (tt <= CFG.SEED ? 0 : easeInOut(clamp((tt - CFG.SEED) / CFG.GROW, 0, 1)));

  function applyReveal(rev) {
    if (!winEl) return;
    if (Math.abs(rev - lastRev) < 0.008) return;
    lastRev = rev;
    winEl.style.opacity = rev.toFixed(3);
    winEl.style.filter = rev < 0.45 ? `blur(${((1 - rev) * 5).toFixed(1)}px)` : 'none';
  }

  /* ============================ 物理 ============================ */
  function simulate(dt, pe) {
    const m = measure();
    const collapsed = pe <= 0.002;
    const birthing = pe < 0.999;
    const K = birthing ? CFG.BIRTH_K : CFG.IDLE_K;
    const C = birthing ? CFG.BIRTH_C : CFG.IDLE_C;
    const scatter = scatterT >= 0;

    const minHalf = H * CFG.MIN_HALF;
    const hw = m ? Math.max(minHalf, m.hw * pe) : minHalf;
    const hh = m ? Math.max(minHalf, m.hh * pe) : minHalf;
    const rr = lerp(Math.min(hw, hh), 18, smoothstep(0.55, 0.98, pe));
    const cx = m ? m.cx : 0, cy = m ? m.cy : 0;
    lastGeom = { cx, cy, hw, hh, W, H };
    const fullPerim = m ? 2 * (m.hw + m.hh) * 2 : 1;

    let errSum = 0, errN = 0;

    for (let i = 0; i < N; i++) {
      const kd = kind[i];
      let tx = 0, ty = 0;

      if (scatter) {
        // 散开：速度在 scatter() 里一次性注入，这里只做阻尼与淡出
        tx = pos[i * 3]; ty = pos[i * 3 + 1];
      } else if (collapsed) {
        tx = cx + Math.sin(jit[i] * 7.1) * 2.5;
        ty = cy + Math.cos(jit[i] * 5.3) * 2.5;
      } else {
        // 小环上同样的 px/s 会转成频闪 → 速度按 sqrt(周长比) 降下来
        const p = rectAt(u[i], hw, hh, rr);
        const spdK = Math.sqrt(p.L / Math.max(1, fullPerim));
        u[i] += (spd[i] * spdK * dt) / p.L;

        const p2 = rectAt(u[i], hw, hh, rr);
        const wob = Math.sin(animT * 1.7 + jit[i]) * (kd === 1 ? 3.5 : 1.2);
        const o = off[i] * clamp(pe / 0.30, 0.10, 1);
        tx = cx + p2.px + p2.nx * (o + wob);
        ty = cy + p2.py + p2.ny * (o + wob);

        // 切线方向（世界 y 要取反）
        const sg = spd[i] > 0 ? 1 : -1;
        aDir[i * 2] = p2.tx * sg;
        aDir[i * 2 + 1] = -p2.ty * sg;
      }

      const kk = K * ks[i];
      let ax = (tx - pos[i * 3]) * kk;
      let ay = (ty - pos[i * 3 + 1]) * kk;

      if (scatter) {
        const damp = 1 / (1 + 0.9 * dt);
        vel[i * 2] *= damp; vel[i * 2 + 1] *= damp;
      } else {
        // 半隐式阻尼：c·dt 再大也不会发散
        vel[i * 2] = (vel[i * 2] + ax * dt) / (1 + C * dt);
        vel[i * 2 + 1] = (vel[i * 2 + 1] + ay * dt) / (1 + C * dt);
      }
      pos[i * 3] += vel[i * 2] * dt;
      pos[i * 3 + 1] += vel[i * 2 + 1] * dt;

      tgtX[i] = tx; tgtY[i] = ty;
      const dx = tx - pos[i * 3], dy = ty - pos[i * 3 + 1];
      errSum += Math.sqrt(dx * dx + dy * dy); errN++;

      /* 外观 */
      let a = baseA[i];
      if (kd === 1) a *= 0.38;
      a *= 0.55 + 0.45 * Math.pow(pe, 0.8);
      if (pe < 0.55) {
        // 小点阶段稀疏化：6000 点全亮挤在 30px 的圈上必然糊成一团白光，
        // 只留极少数承担可见性，其余压到 0.05 → 才看得见"每一颗在绕圈"
        const keep = 0.055 + 0.94 * Math.pow(smoothstep(0.02, 0.5, pe), 1.2);
        a *= rnd[i] < keep ? 1 : 0.015;
      }
      if (scatter) {
        a *= 1 - smoothstep(0.10, CFG.SCATTER_LIFE, scatterT);
      }
      aAlpha[i] = a;
      aSize[i] = baseS[i] * (0.62 + 0.38 * smoothstep(CFG.MIN_HALF, 0.45, pe));
    }

    if (errN) statErr = errSum / errN;
  }

  let statErr = 0;
  let lastGeom = null;

  function render() {
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aDir.needsUpdate = true;
    renderer.render(scene, camera);
  }

  function step(dt) {
    animT += dt;
    if (scatterT >= 0) scatterT += dt;
    else t += dt;
    const pe = peOf(t);
    simulate(dt, pe);
    applyReveal(scatterT >= 0 ? 0 : smoothstep(CFG.REVEAL_A, CFG.REVEAL_B, pe));
  }

  /* ============================ 主循环 ============================ */
  let raf = 0, prev = 0, frozen = false;

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = prev ? Math.min(0.05, (now - prev) / 1000) : 1 / 60;
    prev = now;
    fpsAcc += dt; frameCount++;
    if (fpsAcc >= 0.5) { fps = Math.round(frameCount / fpsAcc); fpsAcc = 0; frameCount = 0; }
    step(dt);
    render();
  }

  /* ============================ 发现窗口 ============================ */
  function findCandidate() {
    const all = document.querySelectorAll(SEL);
    return all.length ? all[all.length - 1] : null;
  }

  const mo = new MutationObserver(() => {
    if (frozen) return;
    const el = findCandidate();
    if (el && el !== winEl) bind(el);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  const first = findCandidate();
  if (first) bind(first);
  else {
    // 桌面还没渲染出窗口：先只在中心收成一个点
    rect = null;
  }

  /* 定格模式（无头截图复现）：必须在 bind 之后预热，否则 bind 会把 t 归零 */
  if (qs.get('op-freeze') === '1') {
    const target = parseFloat(qs.get('op-at') || '1.6') || 1.6;
    const steps = Math.round(target * 60);
    for (let i = 0; i < steps; i++) step(1 / 60);
    frozen = true;
    render();
  } else {
    raf = requestAnimationFrame(loop);
  }

  /* ============================ 对外 API ============================ */
  const api = {
    replay(el) {
      if (el) bind(el); else { if (winEl) restoreWin(); t = 0; scatterT = -1; lastRev = -1; }
    },
    scatter() {
      if (!winEl || scatterT >= 0) return;
      const b = winEl.getBoundingClientRect();
      const cx = b.left + b.width / 2 - W2, cy = H2 - (b.top + b.height / 2);
      for (let i = 0; i < N; i++) {
        const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const sgn = Math.random() < 0.5 ? 1 : -1;
        const ang = Math.atan2(dy * sgn, dx * sgn) + (Math.random() - 0.5) * 1.05;
        const sp = 170 + Math.min(d, 900) * 0.35 + Math.random() * 340;
        vel[i * 2] = Math.cos(ang) * sp;
        vel[i * 2 + 1] = Math.sin(ang) * sp;
      }
      scatterT = 0;
    },
    dispose() {
      cancelAnimationFrame(raf);
      mo.disconnect();
      restoreWin();
      if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      geo.dispose(); mat.dispose(); renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      delete window.__OP__;
    },
    stats() {
      const m = measure();
      return {
        n: N, fps, t: +t.toFixed(2), pe: +peOf(t).toFixed(3),
        rev: +Math.max(0, lastRev).toFixed(3), err: +statErr.toFixed(2),
        bound: !!winEl, rect: m ? { w: Math.round(m.hw * 2), h: Math.round(m.hh * 2) } : null,
      };
    },
    config: CFG,
    probe(k = 6) {
      const out = [];
      for (let i = 0; i < k; i++) {
        out.push({
          x: +pos[i * 3].toFixed(1), y: +pos[i * 3 + 1].toFixed(1),
          s: +aSize[i].toFixed(2), a: +aAlpha[i].toFixed(3), k: kind[i],
        });
      }
      let worst = 0, worstI = -1, far = 0, maxAbsX = 0;
      for (let i = 0; i < N; i++) {
        const dx = pos[i*3]-tgtX[i], dy = pos[i*3+1]-tgtY[i];
        const d = Math.hypot(dx, dy);
        if (d > worst) { worst = d; worstI = i; }
        if (d > 60) far++;
        maxAbsX = Math.max(maxAbsX, Math.abs(pos[i*3]));
      }
      let nan = 0, maxI = -1, mx = 0;
      for (let i = 0; i < N; i++) {
        if (!Number.isFinite(pos[i*3]) || !Number.isFinite(pos[i*3+1])) nan++;
        if (Math.abs(pos[i*3]) > mx) { mx = Math.abs(pos[i*3]); maxI = i; }
      }
      return { calls: renderer.info.render.calls, pts: renderer.info.render.points,
        geom: lastGeom, nan, worst: +worst.toFixed(1), worstI, far, maxAbsX: +maxAbsX.toFixed(0),
        maxI, maxPos: [ +pos[maxI*3].toFixed(1), +pos[maxI*3+1].toFixed(1) ],
        maxTgt: [ +tgtX[maxI].toFixed(1), +tgtY[maxI].toFixed(1) ], sample: out };
    },
  };
  window.__OP__ = api;
})();
