/**
 * 本地壳层联调服务：静态文件 + 一个假的 /server/myApps。
 *
 * 为什么要假接口：main.js 启动第一件事就是 myApps()，本地没登录态会被踢去 auth。
 * 有了这个 mock 就能在本地把「应用栏 → 点图标 → 粒子门开窗 → 关窗」整条链跑通，
 * 而不用去碰线上的 Olares（那边还要 hosts + 隧道）。
 *
 *   node tools/dev/mock-shell.mjs [port=8778] [静态根目录=shell/]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8778);
/* 默认就指向仓库里的 shell/，所以在哪儿执行都行 */
const ROOT = path.resolve(process.argv[3] || path.join(HERE, '../../shell'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const ENT = [
  ['files', 'Files', 'files'],
  ['vault', 'Vault', 'vault'],
  ['market', 'Market', 'appstore'],
  ['settings', 'Settings', 'settings'],
  ['profile', 'Profile', 'profile'],
  ['dashboard', 'Dashboard', 'dashboard'],
  ['control-hub', 'Control Hub', 'control-hub'],
];

const APPS = [
  {
    id: 'olares-app',
    name: 'olares-app',
    title: 'Olares',
    state: 'running',
    entrances: ENT.map(([name, title, icon]) => ({
      name,
      title,
      url: `mock-${name}.local`,
      icon: `https://app.cdn.olares.com/appstore/${icon}/icon.png`,
    })),
  },
];

http.createServer((rq, rs) => {
  if (rq.method === 'POST' && rq.url === '/server/myApps') {
    rs.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    rs.end(JSON.stringify({ code: 0, message: 'ok', data: APPS }));
    return;
  }
  let p = decodeURIComponent(rq.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { rs.writeHead(403); rs.end(); return; }
  fs.readFile(f, (e, b) => {
    if (e) { rs.writeHead(404); rs.end('404'); return; }
    rs.writeHead(200, {
      'content-type': MIME[path.extname(f)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    rs.end(b);
  });
}).listen(PORT, '127.0.0.1', () => console.log('mock shell on http://127.0.0.1:' + PORT));
