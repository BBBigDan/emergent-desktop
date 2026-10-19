/**
 * 本地预览服务（开发用）。
 *
 * 为什么不用 `python -m http.server`：
 *   1. 它不发 Cache-Control，浏览器对 ES Module 会做启发式缓存 —— 改完代码刷新仍然是旧文件；
 *   2. 更麻烦的是**同源 Service Worker**：只要这个 origin 以前注册过 scope=/ 的 SW，
 *      它会把 `src/*.js` 从自己的 cache 里吐出来，改多少遍都没用。
 * 这里统一发 `no-store`，并给 HTML 塞一个构建戳，方便一眼看出跑的是哪一版。
 *
 *   node serve.mjs [port=8822]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8822);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const URL_RAW = (req) => decodeURIComponent(req.url || '/');
const BUILD = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '');  // 20261019T1622

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  /* 打一行访问日志：用来确认「浏览器到底有没有打到我这个进程」 */
  const ua = (req.headers['user-agent'] || '').slice(0, 40);
  console.log(`${new Date().toISOString().slice(11, 19)}  ${req.method} ${URL_RAW(req)}  ${ua}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);

  /* 路径穿越保护 */
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) {
      /* 本地没有 /bfl、/api 这些后端接口 → 直接 404，前端会走降级分支 */
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('404');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      /* 关键：一个字节都不许缓存 */
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'pragma': 'no-cache',
      'expires': '0',
    };
    if (ext === '.html') {
      buf = Buffer.from(buf.toString('utf8').replaceAll('__BUILD__', BUILD));
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`emergent-auth dev  →  http://127.0.0.1:${PORT}/   (build ${BUILD})`);
});
