/**
 * Olares 协议层 —— 只做三件事：确认有登录态、拿应用列表、登出。
 * 故意不引任何框架，整个文件依赖的只是 fetch。
 */

const TOKEN_KEY = 'ed_token';

export function terminusBase() {
  // desktop.bbigdan.olares.com -> bbbigdan.olares.com
  const h = location.host;
  return h.startsWith('desktop.') ? h.slice('desktop.'.length) : h;
}

export function authUrl() {
  return `https://auth.${terminusBase()}/?rd=${encodeURIComponent(location.href)}`;
}

export function devToken() {
  const q = new URLSearchParams(location.search);
  const t = q.get('token');
  if (t) {
    sessionStorage.setItem(TOKEN_KEY, t);
    // 把 token 从地址栏抹掉，避免被截图/录屏带出去
    q.delete('token');
    const s = q.toString();
    history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  const t = devToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** 统一请求：401/303 一律当作「没登录」，交给调用方跳转 auth */
async function req(path, opts = {}) {
  const r = await fetch(path, {
    credentials: 'include',
    ...opts,
    headers: { ...headers(), ...(opts.headers || {}) },
  });
  const ct = r.headers.get('content-type') || '';
  if (r.redirected || !ct.includes('json')) {
    const err = new Error('unauthenticated');
    err.code = 'NO_SESSION';
    throw err;
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** 系统应用的图标不在接口里，官方是按名字取 CDN 上的固定资源 */
const SYS_ICON = {
  files: 'https://app.cdn.olares.com/appstore/files/icon.png',
  vault: 'https://app.cdn.olares.com/appstore/vault/icon.png',
  market: 'https://app.cdn.olares.com/appstore/appstore/icon.png',
  settings: 'https://app.cdn.olares.com/appstore/settings/icon.png',
  profile: 'https://app.cdn.olares.com/appstore/profile/icon.png',
  dashboard: 'https://app.cdn.olares.com/appstore/dashboard/icon.png',
  'control-hub': 'https://app.cdn.olares.com/appstore/control-hub/icon.png',
};

function stripHost(u) {
  return String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export async function myApps() {
  // 后端统一包了一层 { code, message, data }，且成功时可能返回 200 或 201
  const res = await req('/server/myApps', { method: 'POST', body: '{}' });
  const list = Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : []);

  // 系统应用是一个聚合条目（olares-app），真正的「图标」在 entrances 里：
  // files / vault / market / settings / profile / dashboard / control-hub …
  const out = [];
  for (const app of list) {
    if (app.state && app.state !== 'running') continue;
    const ents = (app.entrances || []).filter((e) => e && e.url && !e.invisible);
    if (!ents.length) {
      if (!app.url) continue;
      out.push({
        id: app.id || app.name,
        title: app.title || app.name,
        icon: app.icon || '',
        host: stripHost(app.url),
        openMethod: 'default',
      });
      continue;
    }
    for (const e of ents) {
      out.push({
        id: `${app.id || app.name}:${e.name}`,
        title: e.title || e.name,
        icon: e.icon || SYS_ICON[e.name] || app.icon || '',
        host: stripHost(e.url),
        openMethod: e.openMethod || 'default',
      });
    }
  }
  return out;
}

export async function logout() {
  try { await req('/api/logout', { method: 'POST', body: '{}' }); } catch (_) {}
  sessionStorage.removeItem(TOKEN_KEY);
  location.href = authUrl();
}

export function gotoLogin() {
  location.href = authUrl();
}
