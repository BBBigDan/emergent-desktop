/**
 * 极简静态服务（开发用）
 *
 * 为什么不用 `python -m http.server`：它不发 Cache-Control，ES Module 会被浏览器
 * 启发式缓存，改完源码刷新还是旧文件 —— 调粒子这种高频改动会很浪费时间。
 * 这里一律 no-store，改一个字节刷新即生效。
 *
 * 用法：node serve-dir.mjs <root> [port=8766]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';

const ROOT = normalize(process.argv[2] || '.');
const PORT = Number(process.argv[3] || 8766);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && file !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + p);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serve ${ROOT} -> http://127.0.0.1:${PORT}/`);
});
