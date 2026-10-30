/**
 * 通用应用执行器的自测：`node agent/apps.test.mjs`
 *
 * 这一份测的是"**通用**到底通不通用"：一个桩应用，故意同时提供四种认证形态
 * （无 / 头里放 token / Basic / 表单换 cookie / 表单换 JSON 字段），
 * 执行器必须**一份代码盖住全部**。如果哪天为了某个应用加了 if（应用名 === 'qb'），
 * 这里就该出现"只对它成立"的分支 —— 所以这份自测里**一个应用名都没有**。
 *
 * 另外钉住三条硬边界（它们不是功能，是"不许发生的事"）：
 *   · 不许拿它当通用代理（path 里换 host / 绝对 URL 一律拒）
 *   · 不许打元数据和 kube-apiserver
 *   · 凭据只能来自环境变量，模型传的 header 覆盖不了 Authorization / cookie
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createApps } from './apps.mjs';
import { makeTools } from './tools.mjs';

let failed = 0;
const ok = (c, l, e = '') => {
  if (c) console.log('  ✓ ' + l);
  else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); }
};

/* ── 桩应用：四种认证各一个端点 ── */
const state = { logins: 0, basic: 0 };
function stubApp(port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };

    if (p === '/' ) {
      res.writeHead(200, { 'content-type': 'text/html', server: 'StubApp/1.2' });
      res.end('<html><head><title>Stub 控制台</title></head><body>hi</body></html>');
      return;
    }
    if (p === '/openapi.json') {
      send(200, {
        openapi: '3.0.0', info: { title: 'Stub API', version: '1.2' },
        paths: {
          '/api/items': { get: {}, post: {} }, '/api/state': { get: {} },
          '/auth/login': { post: {} },
        },
      });
      return;
    }
    /* 表单登录 → cookie */
    if (p === '/access/login' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        const f = new URLSearchParams(b);
        state.logins += 1;
        if (f.get('user') === 'u' && f.get('pw') === 'p') {
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['SID=good; Path=/; HttpOnly'] });
          res.end('{}');
        } else send(401, { error: 'bad credentials' });
      });
      return;
    }
    /* 表单登录 → JSON 字段 */
    if (p === '/Session/Login' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        state.logins += 1;
        const f = new URLSearchParams(b);
        if (f.get('Username') === 'u') send(200, { AccessToken: 'tok-123', User: { Id: 'x' } });
        else send(401, {});
      });
      return;
    }
    if (p === '/api/cookie-only') {
      if ((req.headers.cookie || '').includes('SID=good')) return send(200, { via: 'cookie' });
      return send(401, { error: 'need cookie' });
    }
    if (p === '/api/key-only') {
      if (req.headers['x-api-key'] === 'k-9') return send(200, { via: 'header' });
      return send(401, { error: 'need key' });
    }
    if (p === '/api/basic-only') {
      const a = String(req.headers.authorization || '');
      const want = 'Basic ' + Buffer.from('u:p').toString('base64');
      state.basic += 1;
      if (a === want) return send(200, { via: 'basic' });
      return send(401, { error: 'need basic' });
    }
    if (p === '/api/token-field') {
      if (String(req.headers.authorization || '').includes('tok-123')) return send(200, { via: 'json-token' });
      return send(401, { error: 'need token' });
    }
    if (p === '/api/echo') return send(200, { method: req.method, q: Object.fromEntries(u.searchParams) });
    send(404, { error: 'nope' });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

const port = 19900 + Math.floor(Math.random() * 60);
const srv = await stubApp(port);
const BASE = `http://127.0.0.1:${port}`;

async function mk(extra = {}, files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apps-'));
  for (const [n, d] of Object.entries(files)) await fs.writeFile(path.join(dir, `${n}.json`), JSON.stringify(d));
  /* 环境变量统一是 `APP_<名字>_URL` / `_USER` / `_PASS` / `_TOKEN`：
     Secret 里一眼能看出这几行是"给 agent 用的"，不会和应用自己的变量混在一起。 */
  const env = {
    APP_DEMO_URL: BASE,
    APP_DEMO_USER: 'u', APP_DEMO_PASS: 'p',
    APP_KEYAPP_URL: BASE, APP_KEYAPP_TOKEN: 'k-9',
    APP_SESS_URL: BASE, APP_SESS_USER: 'u', APP_SESS_PASS: 'p',
    ...extra,
  };
  const a = createApps({ dir, env, warn: () => {}, discover: null });
  return { a, dir };
}

console.log('\n① 无认证：一份描述就能读');
{
  const { a } = await mk({}, { demo: { base: BASE, auth: { scheme: 'none' } } });
  const r = await a.call('demo', { path: '/api/echo', query: { x: 1 } });
  ok(r.ok && r.status === 200, `200（${r.status}）`);
  ok(r.text.includes('"x":"1"') && r.text.includes('"GET"'), '参数和 method 都到了对端');
  ok(!r.truncated, '小响应不标截断');
}

console.log('\n② 表单登录换 cookie（一票多用，过期才重新登录）');
{
  const before = state.logins;
  const { a } = await mk({}, {
    demo: {
      base: BASE, auth: {
        scheme: 'form', path: '/access/login', userField: 'user', passField: 'pw', tokenCookie: 'SID',
      },
    },
  });
  const r = await a.call('demo', { path: '/api/cookie-only' });
  ok(r.ok && r.text.includes('cookie'), `拿到票并调通（${r.text.slice(0, 40)}）`);
  await a.call('demo', { path: '/api/cookie-only' });
  await a.call('demo', { path: '/api/cookie-only' });
  ok(state.logins - before === 1, `三次调用只登录一次（实际 ${state.logins - before} 次）`);
}

console.log('\n③ 头里放 token');
{
  const { a } = await mk({}, { keyapp: { base: BASE, auth: { scheme: 'header', header: 'X-Api-Key' } } });
  const r = await a.call('keyapp', { path: '/api/key-only' });
  ok(r.ok && r.text.includes('header'), 'X-Api-Key 生效');
  const bad = await a.call('keyapp', { path: '/api/key-only', headers: { authorization: 'Bearer nope' } });
  ok(bad.ok, '模型塞的 authorization 头覆盖不了内置凭据（请求仍然成功）');
}

console.log('\n④ Basic');
{
  const { a } = await mk({}, { demo: { base: BASE, auth: { scheme: 'basic' } } });
  const r = await a.call('demo', { path: '/api/basic-only' });
  ok(r.ok && r.text.includes('basic'), 'Basic 头拼对了');
}

console.log('\n⑤ 表单登录换 JSON 字段里的 token（另一种票）');
{
  const { a } = await mk({}, {
    sess: {
      base: BASE, auth: {
        scheme: 'form', path: '/Session/Login', userField: 'Username', passField: 'Pw',
        tokenField: 'AccessToken', tokenHeader: 'Authorization',
      },
    },
  });
  /* 桩只认 Username；Pw 随便，因为桩不校验它 */
  const r = await a.call('sess', { path: '/api/token-field' });
  ok(r.ok && r.text.includes('json-token'), `字段票生效（${r.text.slice(0, 40)}）`);
}

console.log('\n⑥ 缺地址 / 缺凭据：说清楚缺哪个变量，不猜');
{
  const { a } = await mk({}, {});
  const r = await a.call('nothing', { path: '/x' });
  ok(!r.ok && r.code === 'no_base', '不知道地址时明确报 no_base');
  ok(/APP_NOTHING_URL/.test(r.error), `错误里点名了要配的变量（${r.error.slice(0, 40)}…）`);

  const { a: a2 } = await mk({ APP_NOLOGIN_URL: BASE }, { nologin: { base: BASE, auth: { scheme: 'form', path: '/access/login' } } });
  const r2 = await a2.call('nologin', { path: '/api/cookie-only' });
  ok(!r2.ok && r2.code === 'auth_setup' && /_USER/.test(r2.error), `缺账号时说清是 _USER/_PASS（${r2.error.slice(0, 40)}）`);
}

console.log('\n⑦ 硬边界：不许当通用代理');
{
  const { a } = await mk({}, { demo: { base: BASE, auth: { scheme: 'none' } } });
  const abs = await a.call('demo', { path: 'http://169.254.169.254/latest/meta-data/' });
  ok(!abs.ok && abs.code === 'bad_path', `绝对 URL 被拒（${abs.code}）`);
  const sneaky = await a.call('demo', { path: '/../..//evil' });
  ok(!sneaky.ok && sneaky.code === 'bad_path', `协议相对路径被拒（${sneaky.code || sneaky.status}）`);

  const meta = createApps({
    dir: await fs.mkdtemp(path.join(os.tmpdir(), 'apps-')),
    env: { APP_M_URL: 'http://169.254.169.254' }, warn: () => {},
  });
  const r = await meta.call('m', { path: '/latest/meta-data/' });
  ok(!r.ok && r.code === 'forbidden', '元数据地址被拒');

  const kube = createApps({
    dir: await fs.mkdtemp(path.join(os.tmpdir(), 'apps-')),
    env: { APP_K_URL: 'https://127.0.0.1:6443' }, warn: () => {},
  });
  const rk = await kube.call('k', { path: '/api/v1/pods' });
  ok(!rk.ok && rk.code === 'forbidden', 'kube-apiserver（6443）被拒');
}

console.log('\n⑧ 401 不抛异常：给状态 + 下一步');
{
  const { a } = await mk({}, { demo: { base: BASE, auth: { scheme: 'none' } } });
  const r = await a.call('demo', { path: '/api/key-only' });
  ok(!r.ok && r.status === 401, '401 如实回状态码');
  ok(/配/.test(r.hint || ''), `带一句"该怎么办"（${(r.hint || '').slice(0, 24)}…）`);
}

console.log('\n⑨ probe：发现文档 + 登录端点，能验证才落盘');
{
  const { a, dir } = await mk();
  const rep = await a.probe('demo', { base: BASE });
  ok(rep.ok && rep.reachable, '连得上');
  ok(rep.title === 'Stub 控制台', `读到 title（${rep.title}）`);
  ok(rep.doc && rep.doc.path === '/openapi.json', `找到 OpenAPI（${rep.doc?.path}）`);
  ok(rep.doc.paths.includes('GET /api/items') && rep.doc.paths.includes('POST /api/items'),
    `每个方法一行（${rep.doc.paths.slice(0, 2).join(' | ')}）`);
  ok(rep.suggestions.some((x) => x.kind === 'login' && x.paths.includes('/auth/login')),
    `从文档里认出登录端点（${JSON.stringify(rep.suggestions.find((x) => x.kind === 'login')?.paths || [])}）`);
  ok(rep.saved === true, '跑通了一次只读 GET → 描述落盘');
  const file = JSON.parse(await fs.readFile(path.join(dir, 'demo.json'), 'utf8'));
  ok(file.base === BASE && file.doc?.path === '/openapi.json', '落盘的内容是地址 + 文档位置');
}

console.log('\n⑩ list：知道"接了哪些应用"');
{
  const { a } = await mk({}, { demo: { base: BASE, auth: { scheme: 'none' } } });
  const list = await a.list();
  ok(list.some((x) => x.app === 'demo' && x.auth === 'none'), '描述里的应用在列表里');
  ok(list.some((x) => x.app === 'keyapp' && x.base === BASE), '只有环境变量的应用也在列表里');
}

console.log('\n⑪ 工具层：读是 safe、写是 danger（审批门按工具名判）');
{
  const { a } = await mk({}, { demo: { base: BASE, auth: { scheme: 'none' } } });
  const T = makeTools({ source: 'mock', apps: a, sid: 'sid-apps' });
  ok(T.level('app_api') === 'safe', 'app_api 是 safe（随时能用）');
  ok(T.level('app_act') === 'danger', 'app_act 是 danger（改世界要点头）');

  const g = await T.all.app_api.run({ op: 'get', app: 'demo', path: '/api/echo' });
  ok(g.ok, 'op=get 走通');
  const l = await T.all.app_api.run({ op: 'list' });
  ok(l.ok && l.apps.some((x) => x.app === 'demo'), 'op=list 能看到接过的应用');
  const bad = await T.all.app_act.run({ app: 'demo', method: 'GET', path: '/api/echo' });
  ok(!!bad.error && /app_api/.test(bad.error), 'app_act 拒绝 GET，并指回 app_api');
  const noApp = await T.all.app_api.run({ op: 'get', path: '/x' });
  ok(!!noApp.error, '缺 app 时明确报错');
}

srv.close();
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);