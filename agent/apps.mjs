/**
 * 应用层写操作（roadmap ③）——**一个通用执行器，不是 N 个适配器**
 *
 * 用户的判断（2026-10-30）：
 *
 * > 「能做通用的吗？如果给每个应用都单独写的话这个需求就爆炸了」
 *
 * 他是对的，而这个结论和 roadmap 原来写的"按应用接 API"并不矛盾 ——
 * 原方案错在**把"通用"理解成"通用到网页点点点"**。真正该通用的是三件事，
 * 而它们和应用无关：
 *
 *   ① 地址：应用在哪（集群里一个 Service / 一个环境变量 / 一份描述）
 *   ② 认证：四种形态盖住几乎全部自建应用（无 / 头里放 token / Basic / 表单换票）
 *   ③ 发请求：拼 URL、限时、限体积、把返回切成模型读得下的形状
 *
 * 于是"接一个新应用"不是写一个 .mjs，而是**跑一次发现、留一份 5 行的描述**
 * （`apps/<name>.json`），或者干脆只在 Secret 里加两个环境变量。
 * 应用升级换了路径也不会坏掉整个适配器 —— 坏掉的是那一行描述，改一行就行。
 *
 * ── 为什么仍然不做"通用网页操作"（浏览器驱动）──
 *
 * 这条路在 roadmap 里已经否过一次，理由没有变：这台机器**没有桌面**，
 * 每个应用一套登录，而 UI 的 DOM 一改就全废。而且它带来的收益是"能点按钮"，
 * 代价是"每次点都得看一眼它在点什么" —— 那和"能改"是两件事。
 * 应用自己都有 HTTP API（哪怕没文档），走 API 的稳定性高一个数量级。
 *
 * ── 边界（这几条是硬的，不是建议）──
 *
 *   · **凭据不进模型**：token/密码只从环境变量（Secret）读，模型只能选"用哪种方案"。
 *   · **读和写分两个工具**：`app_api` 只 GET（safe），`app_act` 改世界（danger，走审批门）。
 *   · **不许拿它当通用代理**：path 只能是相对路径，不能指向别的 host；
 *     元数据地址和 kube API 一律拒（这台机器的内网是目标，但不是任意内网）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** 一次响应的最大字节数。应用列表可能很长，但进上下文的部分必须有上限。 */
const MAX_BYTES = 256 * 1024;
/** 进上下文的最大字符数（JSON 会先压缩再截断） */
const MAX_TEXT = 8000;
const TIMEOUT_MS = 15_000;

/** 绝对不许打的地址：云厂商元数据、k8s API、本机管理口 */
function forbidden(hostname, port) {
  const h = String(hostname || '').toLowerCase();
  if (h === '169.254.169.254' || h === 'metadata' || h.endsWith('.internal')) return true;
  if (h === 'kubernetes.default' || h === 'kubernetes.default.svc') return true;
  /* 6443 是 kube-apiserver。集群里任何 pod 都能到它，而它有 cluster-admin 的可能 ——
     这个工具是"操作应用"，不是"操作集群"（那件事由 k8s_* / olares_act 管，走审批）。 */
  if (String(port) === '6443') return true;
  return false;
}

const enc = encodeURIComponent;

/**
 * 一份描述长这样（`apps/<name>.json`）：
 *
 * ```json
 * { "base": "http://qbittorrent:8080",
 *   "auth": { "scheme": "form", "path": "/api/v2/auth/login",
 *             "userField": "username", "passField": "password",
 *             "tokenCookie": "SID" },
 *   "doc": { "path": "/api/v2", "note": "Web API v2" } }
 * ```
 *
 * 认证四种：
 *   none   什么都不带
 *   header { header, tokenEnv }          —— X-Api-Key / X-Emby-Token 这一类
 *   basic  { userEnv, passEnv }          —— Authorization: Basic
 *   form   { path, userField, passField, tokenCookie | tokenField | tokenHeader }
 *                                        —— 表单登录换 cookie / JSON 里的 token
 *
 * `*Env` 一律可省：省了就按 `<APP>_TOKEN` / `<APP>_USER` / `<APP>_PASS` 找
 * （APP 名大写、非字母数字换下划线）。
 */
export function createApps({ dir, env = process.env, fetchImpl = fetch, discover = null, warn = console.warn } = {}) {
  const descs = new Map();      // name -> 描述（含 base/auth），懒加载
  const tickets = new Map();    // name -> { value, until, header, cookie }
  let loaded = false;

  const envName = (app) => String(app).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const fileOf = (app) => path.join(dir, `${app}.json`);

  async function loadAll() {
    if (loaded) return;
    loaded = true;
    try {
      const list = await fs.readdir(dir);
      for (const f of list) {
        if (!f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
          if (d && (d.base || d.auth)) descs.set(f.replace(/\.json$/, ''), d);
        } catch { /* 单份坏了不影响别的 */ }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') warn('[apps] 描述目录读不出来：' + e.message);
    }
  }

  /**
   * 应用在哪。三级解析，越靠前越硬：
   *   ① 描述文件里的 base（probe 写的，或用户手写的）
   *   ② `APP_<NAME>_URL` 环境变量（Secret 里配的，install 时写进去）
   *   ③ 集群里同名的 Service（同命名空间，取第一个端口）—— 由 server 注入 `discover`
   *
   * 第 ③ 条是这台机器上最省事的一条：装了什么应用，Service 就在那儿，
   * 用户不用再抄一遍地址。
   */
  async function baseOf(app, { fresh = false } = {}) {
    await loadAll();
    if (fresh) descs.delete(app);
    const d = descs.get(app);
    if (d?.base) return d.base;
    const e = env[`APP_${envName(app)}_URL`];
    if (e) return String(e).replace(/\/+$/, '');
    if (discover) {
      const hit = await discover(app).catch(() => null);
      if (hit) return hit;
    }
    return '';
  }

  async function descOf(app) {
    await loadAll();
    return descs.get(app) || {};
  }

  async function writeDesc(app, d) {
    await loadAll();
    descs.set(app, d);
    try {
      await fs.mkdir(dir, { recursive: true });
      const tmp = fileOf(app) + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(d, null, 1), { mode: 0o600 });
      await fs.rename(tmp, fileOf(app));
    } catch (e) {
      warn('[apps] 描述写不进去：' + e.message);
    }
  }

  function credOf(app, d) {
    const n = envName(app);
    const auth = d.auth || {};
    const tok = auth.tokenEnv ? env[auth.tokenEnv] : env[`APP_${n}_TOKEN`];
    const user = auth.userEnv ? env[auth.userEnv] : env[`APP_${n}_USER`];
    const pass = auth.passEnv ? env[auth.passEnv] : env[`APP_${n}_PASS`];
    return { tok, user, pass };
  }

  /** 把 path 拼到 base 上。**只允许相对路径** —— 见文件头的"不许当通用代理" */
  function joinURL(base, p, query) {
    const b = new URL(base);
    const clean = String(p || '/').trim();
    if (/^[a-z]+:\/\//i.test(clean)) throw new Error('path 只能是相对路径（不许换 host）');
    /* `//evil` 在浏览器语义里是**协议相对地址**，会跳到另一个 host。
       我们这里是字符串拼接，拼出来还是自己家 —— 但那种"看起来能跳"的写法
       迟早被谁当成跳转用，直接从入口拒掉，省得以后有人在这里加个 resolve。 */
    if (clean.startsWith('//')) throw new Error('path 不许以 // 开头（那是协议相对地址）');
    const u = new URL(base.replace(/\/+$/, '') + (clean.startsWith('/') ? clean : '/' + clean));
    if (u.host !== b.host) throw new Error('path 跳到了别的主机，不许');
    /* `..` 归一化之后也可能变成 `//evil`（`/../..//evil`），这里对结果再判一次 */
    if (u.pathname.startsWith('//')) throw new Error('path 归一化之后成了协议相对地址，不许');
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    }
    return u;
  }

  /** 换票：结果按 app 缓存，过期时间取响应里的 max-age，拿不到就给 30 分钟 */
  async function ticket(app, d) {
    const auth = d.auth || {};
    const key = `${app}:${auth.scheme}`;
    const hit = tickets.get(key);
    if (hit && hit.until > Date.now()) return hit;

    const base = await baseOf(app);
    if (!base) throw new Error(`不知道 ${app} 在哪：配 APP_${envName(app)}_URL，或先 probe 一次`);
    const { tok, user, pass } = credOf(app, d);

    if (auth.scheme === 'none') return null;
    if (auth.scheme === 'header') {
      if (!tok) throw new Error(`缺少 ${auth.tokenEnv || `APP_${envName(app)}_TOKEN`}`);
      return { value: tok, header: auth.header || 'Authorization', cookie: '', until: Date.now() + 86_400_000 };
    }
    if (auth.scheme === 'basic') {
      if (!user || !pass) throw new Error(`缺少 APP_${envName(app)}_USER / _PASS`);
      return {
        value: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
        header: 'authorization', cookie: '', until: Date.now() + 86_400_000,
      };
    }
    if (auth.scheme === 'form') {
      if (!user || !pass) throw new Error(`缺少 APP_${envName(app)}_USER / _PASS（表单登录用）`);
      const u = joinURL(base, auth.path || '/login');
      const body = new URLSearchParams();
      body.set(auth.userField || 'username', user);
      body.set(auth.passField || 'password', pass);
      const r = await fetchImpl(u, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await r.text();
      /* cookie 票（qb 的 SID、n8n 的 n8n-auth）：从 set-cookie 里挑名字对得上的 */
      const jar = r.headers.getSetCookie?.() || [];
      let cookie = '';
      if (auth.tokenCookie) {
        for (const c of jar) {
          const m = String(c).match(new RegExp(`(?:^|,\\s*)${auth.tokenCookie}=([^;]+)`));
          if (m) { cookie = `${auth.tokenCookie}=${m[1]}`; break; }
        }
      }
      /* 字段票（Jellyfin 的 AccessToken、*arr 的 apiKey） */
      let value = '';
      if (auth.tokenField) {
        try {
          const j = JSON.parse(text);
          value = String(j?.[auth.tokenField] || j?.user?.[auth.tokenField] || '');
        } catch { /* 不是 JSON 就当拿不到 */ }
      }
      if (!cookie && !value) {
        /* 说不出成功还是失败是最糟的：这里把原始返回带上（截断），
           模型才能判断"是账号错了"还是"这个应用根本不是这套登录"。 */
        throw new Error(`登录没换成票（HTTP ${r.status}）：${text.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      const t = {
        value: value || '',
        header: value ? (auth.tokenHeader || 'Authorization') : '',
        cookie,
        until: Date.now() + 30 * 60_000,
      };
      tickets.set(key, t);
      return t;
    }
    return null;
  }

  /** 发一次请求。`write` 只影响调用方（工具层）的审批，这里不区分。 */
  async function call(app, { method = 'GET', path: p = '/', query = null, body = null, headers = null } = {}) {
    const d = await descOf(app);
    const base = await baseOf(app);
    if (!base) {
      return {
        ok: false, code: 'no_base',
        error: `不知道 ${app} 在哪。三种办法：配 APP_${envName(app)}_URL（Secret 里），`
          + '或者用 app_probe 探一次，或者告诉我它的内网地址（Service 名 + 端口）。',
      };
    }
    let u;
    try { u = joinURL(base, p, query); } catch (e) { return { ok: false, code: 'bad_path', error: e.message }; }
    if (forbidden(u.hostname, u.port)) return { ok: false, code: 'forbidden', error: '这个地址不让打' };

    const h = { 'user-agent': 'emergent-agent/1.0 (+olares)', accept: 'application/json, text/plain;q=0.8' };
    let t = null;
    try { t = await ticket(app, d); } catch (e) { return { ok: false, code: 'auth_setup', error: e.message }; }
    /* 凭据由服务端注入。`header` 方案里 value 就是整个头的值
       （X-Api-Key 是裸 token，Basic 是 "Basic base64(...)"）—— 不在调用方拼。 */
    if (t?.header) h[t.header] = t.value;
    if (t?.cookie) h.cookie = t.cookie;
    if (headers && typeof headers === 'object') {
      /* 模型可以补自己的头（某些应用要 X-Requested-With 才认），但**不许覆盖凭据**：
         Authorization / cookie 由服务端注入，模型没有资格改它。 */
      for (const [k, v] of Object.entries(headers)) {
        if (/^(authorization|cookie)$/i.test(k)) continue;
        h[k] = String(v).slice(0, 200);
      }
    }

    const init = { method: String(method || 'GET').toUpperCase(), headers: h, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (body != null) {
      if (typeof body === 'string') { init.body = body; }
      else { init.body = JSON.stringify(body); h['content-type'] = h['content-type'] || 'application/json'; }
    }

    let r;
    try {
      r = await fetchImpl(u, init);
    } catch (e) {
      const msg = String(e?.message || e);
      return {
        ok: false, code: 'offline',
        error: /timeout|abort/i.test(msg) ? `${app} 15 秒没回话` : `连不上 ${app}：${msg.slice(0, 120)}`,
      };
    }

    const raw = await readCapped(r);
    const ct = r.headers.get('content-type') || '';
    const text = shape(raw, ct);
    const out = {
      ok: r.ok, status: r.status, type: ct.split(';')[0] || '(未知)',
      path: u.pathname + (u.search || ''), chars: text.length, text: text.slice(0, MAX_TEXT),
    };
    if (text.length > MAX_TEXT) out.truncated = true;
    if (r.status === 401 || r.status === 403) {
      out.hint = '401/403：要么没配凭据，要么凭据过期了。读应用文档确认认证方式，'
        + '再让用户在 Secret 里配 APP_<名字>_TOKEN / _USER / _PASS。不要反复重试同一组凭据。';
    }
    return out;
  }

  async function readCapped(r) {
    const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
    return new Uint8Array(buf.slice(0, MAX_BYTES));
  }

  /**
   * 把响应切成模型读得下的样子。
   * JSON 先压缩（去掉缩进）再截断 —— 缩进在 8000 字的预算里纯属浪费；
   * HTML 剥标签（和 web_get 一样的规矩：留字，不留结构）。
   */
  function shape(bytes, ct) {
    const raw = Buffer.from(bytes).toString('utf8');
    if (/json/i.test(ct)) {
      try { return JSON.stringify(JSON.parse(raw)); } catch { /* 半截 JSON，原样给 */ }
    }
    if (/html/i.test(ct)) {
      return raw.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');
    }
    return raw;
  }

  /* ── 发现：把"读文档 + 猜登录"变成一次调用 ── */

  const DOC_PATHS = ['/openapi.json', '/api-docs/openapi.json', '/swagger.json', '/api/openapi.json', '/v3/api-docs', '/api-doc'];
  /** 常见登录端点。**只用来看"有没有"，不试账号** —— 试错会把账号锁掉。 */
  const LOGIN_PATHS = ['/api/v2/auth/login', '/api/auth/login', '/rest/login', '/login', '/Users/AuthenticateByName'];

  /**
   * 探一个应用：先找 base，再看它有没有 OpenAPI，最后看登录端点在不在。
   *
   * 返回的是**建议**，不是结论：写进描述之前必须能"验一下"（这里会跑一次只读 GET），
   * 验不过就不落盘 —— 一份错的描述比没有描述更坏，它会让下一次调用莫名其妙地 404。
   */
  async function probe(app, { base: given } = {}) {
    const base = given ? String(given).replace(/\/+$/, '') : await baseOf(app, { fresh: true });
    if (!base) {
      return {
        ok: false, code: 'no_base',
        error: `不知道 ${app} 在哪。给一个内网地址（http://服务名:端口），或者先把 APP_${envName(app)}_URL 配上。`,
      };
    }
    let u;
    try { u = new URL(base); } catch { return { ok: false, code: 'bad_base', error: `地址不成立：${base}` }; }
    if (forbidden(u.hostname, u.port)) return { ok: false, code: 'forbidden', error: '这个地址不让打' };

    const report = { ok: true, app, base, reachable: false, doc: null, suggestions: [] };
    /* ① 能不能连上、是不是 HTTP 服务 */
    try {
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'emergent-agent/1.0' } });
      report.reachable = true;
      report.status = r.status;
      report.server = r.headers.get('server') || '';
      const html = await r.text().catch(() => '');
      const title = (html.match(/<title[^>]*>([^<]{1,60})<\/title>/i) || [])[1];
      if (title) report.title = title.trim();
      report.needsAuth = r.status === 401 || r.status === 403;
    } catch (e) {
      return { ok: false, code: 'offline', error: `连不上 ${base}：${String(e?.message || e).slice(0, 120)}` };
    }

    /* ② OpenAPI / Swagger：有的话就是最好的"应用说明书" */
    for (const p of DOC_PATHS) {
      try {
        const r = await fetchImpl(new URL(base + p), { signal: AbortSignal.timeout(6000) });
        if (!r.ok) continue;
        const j = JSON.parse(await r.text());
        if (!j || (!j.paths && !j.openapi && !j.swagger)) continue;
        const paths = [];
        for (const k of Object.keys(j.paths || {})) {
          for (const m of Object.keys(j.paths[k] || {})) {
            if (/^(get|post|put|patch|delete)$/i.test(m)) paths.push(`${m.toUpperCase()} ${k}`);
            if (paths.length >= 60) break;
          }
          if (paths.length >= 60) break;
        }
        report.doc = { path: p, title: j.info?.title || '', version: j.info?.version || '', count: Object.keys(j.paths || {}).length, paths };
        break;
      } catch { /* 下一个 */ }
    }

    /* ③ 登录端点：只问"在不在"。200/401/405 都算在（405 = 存在但不吃 GET）。
       这里**不提交账号密码** —— 猜错密码会把账号锁掉，而锁账号的用户体验是最差的。
       两条路：先在 OpenAPI 里找（有文档时最准），没有文档才用常见路径猜。 */
    const logins = new Set();
    for (const line of report.doc?.paths || []) {
      const [, p] = line.split(' ');
      if (/login|authenticate|session|token|auth\//i.test(p)) logins.add(p);
    }
    for (const p of LOGIN_PATHS) {
      if (logins.has(p)) continue;
      try {
        const r = await fetchImpl(new URL(base + p), { method: 'GET', signal: AbortSignal.timeout(4000) });
        if ([200, 401, 403, 405].includes(r.status)) logins.add(p);
      } catch { /* 超时就跳过 */ }
    }
    if (logins.size) report.suggestions.push({ kind: 'login', paths: [...logins].slice(0, 6) });
    if (report.doc) report.suggestions.push({ kind: 'doc', path: report.doc.path, note: '把 doc.path 写进描述，模型就能直接选 op' });
    if (report.needsAuth) report.suggestions.push({ kind: 'auth', note: '根路径要认证：先确认是 header token、Basic，还是表单登录换 cookie' });

    /* ④ 落盘之前验一次：能不能真的用这份描述调到东西 */
    if (report.doc) {
      const d = { base, auth: { scheme: report.needsAuth ? 'header' : 'none' }, doc: { path: report.doc.path, note: report.doc.title } };
      const test = await call(app, { method: 'GET', path: '/' });
      if (test.ok) {
        await writeDesc(app, d);
        report.saved = true;
      } else {
        /* 验不过就只给建议、不落盘：错的描述比没有描述更坏 */
        report.saved = false;
        report.why = `描述没落盘：拿它试了一次 ${test.status || ''} ${test.error || ''}`.trim();
      }
    }
    return report;
  }

  return {
    call, probe, baseOf, descOf,
    /** 给工具层：现在知道哪些应用（名字 → 有没有描述、有没有地址） */
    async list() {
      await loadAll();
      const names = new Set([...descs.keys()]);
      for (const k of Object.keys(env)) {
        const m = k.match(/^APP_(.+)_URL$/);
        if (m) names.add(m[1].toLowerCase());
      }
      const out = [];
      for (const n of [...names].sort()) {
        const d = descs.get(n) || {};
        out.push({
          app: n,
          base: d.base || env[`APP_${envName(n)}_URL`] || '',
          auth: d.auth?.scheme || '?',
          doc: d.doc?.path || '',
        });
      }
      return out;
    },
    _reset() { descs.clear(); tickets.clear(); loaded = false; },
  };
}
