/**
 * 登录页逻辑。
 *
 * 界面完全由粒子构成：2D 画布画「墨稿」→ 采样成点阵 → 粒子排成字形。
 * DOM 里只有一个透明 input 负责收键盘（移动端要靠它唤起输入法），
 * 视觉上它不存在。
 *
 * 协议完全照抄官方前端，因为后端是 Authelia 的 Olares 定制版：
 *   GET  /bfl/info/v1/olares-info   实例信息（olaresId / osVersion / avatar）
 *   GET  /api/state                 已登录时为 authentication_level === 2
 *   POST /api/firstfactor           { username, password, keepMeLoggedIn, targetURL }
 *
 * 两个必须照抄的细节：
 *   1. osVersion >= 1.12.0 时，密码要变成 md5(password + "@Olares2025")
 *   2. targetURL 默认是 https://desktop.<olaresId 的 @ 换成 .>，有 ?rd= 时以它为准
 */
import { Field } from './field.js';
import { paint, scan, scanPart, partAt, CAPK, LW, LH, HIT, AVA } from './ui.js';

/* 官方登录页的头像来自 CDN；实例信息里 avatar 为空时就用这张默认图 */
const DEFAULT_AVA = 'https://app.cdn.olares.com/avatar3/30.png';

const SALT = '@Olares2025';
const SALT_MIN_VERSION = '1.12.0-0';

/* ------------------------------- md5 ---------------------------------- */
function md5(str) {
  const bytes = new TextEncoder().encode(str);
  const words = [];
  const len = bytes.length;
  const bitLen = len * 8;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const total = (((len + 8) >>> 6) + 1) * 16;
  for (let i = 0; i < total; i++) words[i] = 0;
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[len >> 2] |= 0x80 << ((len % 4) * 8);
  words[total - 2] = bitLen >>> 0;
  words[total - 1] = Math.floor(bitLen / 4294967296);

  const rotl = (x, n) => (x << n) | (x >>> (32 - n));

  for (let i = 0; i < total; i += 16) {
    const [oa, ob, oc, od] = [a, b, c, d];
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const tmp = d;
      d = c; c = b;
      const sum = (a + f + K[j] + words[i + g]) | 0;
      b = (b + rotl(sum, S[j])) | 0;
      a = tmp;
    }
    a = (a + oa) | 0; b = (b + ob) | 0; c = (c + oc) | 0; d = (d + od) | 0;
  }

  const hex = (n) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return hex(a) + hex(b) + hex(c) + hex(d);
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const $ = (sel) => document.querySelector(sel);

async function getJSON(url, opts) {
  const res = await fetch(url, { credentials: 'include', ...opts });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { res, body };
}

const MESSAGES = [
  [/invalid credentials/i, '密码不对'],
  [/unmatched with ctxuser/i, '账号不匹配，刷新一下'],
  [/cannot get user name from header/i, '网关没认出用户，刷新一下'],
  [/too many requests/i, '试得太频繁了'],
  [/banned/i, '这个 IP 被临时限制'],
];

function humanize(msg) {
  if (!msg) return '登录失败';
  for (const [re, zh] of MESSAGES) if (re.test(msg)) return zh;
  return String(msg).slice(0, 42);
}

/* ------------------------------- 状态 -------------------------------- */
const S = {
  olaresId: '',
  username: '',
  osVersion: '',
  targetURL: '',
  password: '',
  focused: false,
  busy: false,
  error: '',
  scale: 1,
};

let field = null;
let uiCtx = null;

function desktopURL() {
  if (S.olaresId.includes('@')) {
    const [name, domain] = S.olaresId.split('@');
    return `${location.protocol}//desktop.${name}.${domain}`;
  }
  return `${location.protocol}//desktop.${S.olaresId}`;
}

function resolveTarget() {
  const q = new URLSearchParams(location.search);
  let t = q.get('redirect') || q.get('rd') || '';
  if (t) {
    try { t = decodeURIComponent(t); } catch { /* 原样使用 */ }
    return t;
  }
  return desktopURL();
}

/* --------------------------- 逻辑坐标 → CSS --------------------------- */
function calcScale() {
  const W = window.innerWidth, H = window.innerHeight;
  return Math.min(W / LW, H / LH);
}

function toCSS(lx, ly) {
  return {
    x: window.innerWidth / 2 + (lx - LW / 2) * S.scale,
    y: window.innerHeight / 2 + (ly - LH / 2) * S.scale,
  };
}

/** CSS 坐标 → 逻辑坐标（悬停命中用） */
function toLogical(px, py) {
  return {
    x: (px - window.innerWidth / 2) / S.scale + LW / 2,
    y: (py - window.innerHeight / 2) / S.scale + LH / 2,
  };
}

/** 把透明 input 摆到密码框的位置上，让点击/输入法都落在正确的地方 */
function placeInput() {
  const inp = $('#pw');
  const a = toCSS(HIT.input.x, HIT.input.y);
  /* 右边留出箭头的宽度，否则透明 input 会把箭头盖住，点不到 */
  const b = toCSS(HIT.input.x + HIT.input.w - 34, HIT.input.y + HIT.input.h);
  inp.style.left = `${a.x}px`;
  inp.style.top = `${a.y}px`;
  inp.style.width = `${b.x - a.x}px`;
  inp.style.height = `${b.y - a.y}px`;
}

/** 头像按同一个坐标系摆好，粒子流的圆心/半径与之对齐 */
function placeAvatar() {
  const wrap = $('#ava-wrap');
  const a = toCSS(AVA.cx - AVA.r, AVA.cy - AVA.r);
  const b = toCSS(AVA.cx + AVA.r, AVA.cy + AVA.r);
  wrap.style.left = `${a.x}px`;
  wrap.style.top = `${a.y}px`;
  wrap.style.width = `${b.x - a.x}px`;
  wrap.style.height = `${b.y - a.y}px`;
  wrap.style.fontSize = `${(b.x - a.x) * 0.34}px`;
  field?.setAvatar(AVA.cx, AVA.cy, AVA.r, S.scale, LW, LH);
}

/* ------------------------------- 重绘 -------------------------------- */
let lastSig = '';
let hover = null;

/** 把增援粒子灌进当前悬停控件的槽位（细网格 → 控件变密变亮） */
function refreshSlots() {
  if (!field) return;
  if (!hover) { field.clearSlots(); return; }
  const pts = scanPart(uiCtx, S, hover, S.scale);
  paint(uiCtx, S);            // scanPart 是破坏性的，把墨稿画回来
  field.setSlots(pts, hover, CAPK[hover] ?? 0.5, S.scale, LW, LH);
}

function repaint(force = false) {
  if (!field || !uiCtx) return;   // resize 事件可能早于启动完成
  const sig = `${S.olaresId}|${S.password.length}|${S.focused}|${S.busy}|${S.error}`;
  if (!force && sig === lastSig) return;
  lastSig = sig;

  paint(uiCtx, S);
  const pts = scan(uiCtx);
  field.setPoints(pts, S.scale, LW, LH);
  /* 打字时槽位也跟着变（密码点、光标都是新位置） */
  if (hover) refreshSlots();
}

/* ------------------------------- 提交 -------------------------------- */
async function submit() {
  if (S.busy) return;
  if (!S.password) {
    S.error = '先输密码';
    repaint(true);
    return;
  }

  S.error = '';
  S.busy = true;
  repaint(true);

  const useSalt = S.osVersion && cmpVersion(S.osVersion, SALT_MIN_VERSION) >= 0;
  const payload = {
    username: S.username,
    password: useSalt ? md5(S.password + SALT) : S.password,
    keepMeLoggedIn: false,
    targetURL: S.targetURL,
  };

  try {
    let { res, body } = await getJSON('/api/firstfactor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const msg = typeof body === 'string' ? body : body?.message || '';
    if (res.status >= 400 && /cannot get user name from header/i.test(msg)) {
      ({ res, body } = await getJSON('/api/firstfactor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bfl-User': S.username },
        body: JSON.stringify(payload),
      }));
    }

    const ok = res.ok && (typeof body === 'string' ? true : body?.status !== 'KO');
    if (!ok) {
      const text = typeof body === 'string' ? body : body?.message;
      throw new Error(humanize(text) || `登录失败（${res.status}）`);
    }

    /* 二次验证还开着的话，交给官方页面收尾 */
    if (body?.status === 'OK' && body?.authentication_level && body.authentication_level < 2) {
      location.replace(S.targetURL);
      return;
    }

    /* 成功：点阵与头像外的粒子流一起炸开，画面交给桌面 */
    field.burst();
    field.burstAvatar();
    document.body.classList.add('leaving');
    setTimeout(() => location.replace(S.targetURL), 760);
  } catch (err) {
    S.busy = false;
    S.error = err.message || '登录失败';
    repaint(true);
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 420);
    $('#pw').select();
  }
}

/* ------------------------------- 启动 -------------------------------- */
async function boot() {
  S.scale = calcScale();

  /* 实例信息 */
  let avatarUrl = DEFAULT_AVA;
  try {
    const { body } = await getJSON('/bfl/info/v1/olares-info');
    const info = body?.data || body || {};
    S.olaresId = info.olaresId || '';
    S.osVersion = info.osVersion || '';
    S.username = S.olaresId.split('@')[0] || 'owner';
    if (info.avatar) avatarUrl = info.avatar;
  } catch {
    S.username = 'owner';
  }
  S.targetURL = resolveTarget();

  /* 头像：拿到就显示；CDN 不通时退回首字母（不阻塞登录） */
  const wrap = $('#ava-wrap');
  const ava = $('#ava');
  ava.referrerPolicy = 'no-referrer';
  ava.addEventListener('error', () => {
    wrap.classList.add('no-img');
    $('#ava-letter').textContent = (S.username || 'O').slice(0, 1).toUpperCase();
  });
  ava.src = avatarUrl;

  /* 已登录就不该再让输密码 */
  try {
    const { body } = await getJSON('/api/state');
    if (body && body.authentication_level === 2) {
      location.replace(S.targetURL);
      return;
    }
  } catch { /* 未登录时接口会报错，忽略 */ }

  /* 离屏「墨稿」画布 */
  const off = document.createElement('canvas');
  off.width = LW;
  off.height = LH;
  uiCtx = off.getContext('2d', { willReadFrequently: true });

  field = new Field($('#scene'));
  window.__field = field;

  const relayout = () => {
    S.scale = calcScale();
    field.resize();
    placeInput();
    placeAvatar();
    repaint(true);
  };
  relayout();
  window.addEventListener('resize', relayout);

  /* 主循环 */
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    field.step(dt);
    field.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  document.body.classList.add('ready');
}

/* ------------------------------- 交互 -------------------------------- */
/** 指针下是哪个控件（用墨稿实测出来的矩形，不是另外编一套坐标） */
function hitPart(x, y) {
  const l = toLogical(x, y);
  return partAt(l.x, l.y);
}

window.addEventListener('DOMContentLoaded', () => {
  boot();

  const inp = $('#pw');

  inp.addEventListener('input', () => {
    S.password = inp.value;
    S.error = '';
    repaint();
  });
  inp.addEventListener('focus', () => { S.focused = true; repaint(); });
  inp.addEventListener('blur', () => { S.focused = false; repaint(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  /* 点哪儿都算聚焦 —— 这页只有一个输入 */
  window.addEventListener('pointerdown', (e) => {
    field?.pulse(e.clientX, e.clientY);
    /* 先判箭头：它在输入框右端，不能先被 input 吃掉 */
    if (hitPart(e.clientX, e.clientY) === 'button') {
      submit();
      return;
    }
    if (e.target === inp) return;
    inp.focus();
  });

  window.addEventListener('pointermove', (e) => {
    field?.setPointer(e.clientX, e.clientY, true);
    const p = hitPart(e.clientX, e.clientY);
    if (p !== hover) {
      hover = p;
      refreshSlots();
      document.body.classList.toggle('on-btn', p === 'button');
    }
  });

  window.addEventListener('pointerleave', () => {
    field?.setPointer(0, 0, false);
    hover = null;
    refreshSlots();
    document.body.classList.remove('on-btn');
  });

  /* 移动端键盘弹起时视口变了，重新算一次 */
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      S.scale = calcScale();
      field?.resize();
      placeInput();
      repaint(true);
    });
  }
});
