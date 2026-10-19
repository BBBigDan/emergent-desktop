/**
 * 本地注入服务（开发用）
 * ---------------------------------------------------------------------------
 * 三个端点：
 *   GET /bundle.js   动态构建的注入包（three + src/inject.js，IIFE）
 *   GET /version     构建版本号，userscript 轮询它 → 变了就重新注入
 *   GET /            本地 mock 桌面页（结构与 Olares Desktop 一致，离线可调）
 *
 * 文件一改就重建；userscript 下次轮询拿到新版本号，自动 dispose 旧层再注入。
 * 用法：node serve.mjs  → http://127.0.0.1:8790/
 */
import { readFileSync, watch, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 8790;
const PS = join(ROOT, '..', '..', 'prototype');

/* ---------------- 打包 ---------------- */
function build() {
  const three = readFileSync(join(PS, 'vendor', 'three.module.min.js'), 'utf8')
    .replace(/^\s*\/\/# sourceMappingURL=.*$/m, '');
  const m = three.match(/export\{([^}]*)\};?\s*$/);
  if (!m) throw new Error('three 的 export 语句没找到');
  const props = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((e) => {
    const [local, exported] = e.split(/\s+as\s+/);
    if (!exported) throw new Error('无法解析导出项: ' + e);
    return `${exported}: ${local}`;
  });
  const core = three.slice(0, m.index) + 'const THREE = {' + props.join(', ') + '};';
  const inject = readFileSync(join(ROOT, 'src', 'inject.js'), 'utf8');
  // 主代码包进块级作用域：避免与 three 压缩后的顶层短名冲突
  const code = `(function(){'use strict';\n${core}\n{\n${inject}\n}\n})();`;
  return { code, bytes: Buffer.byteLength(code) };
}

let cache = null;
let version = Date.now();
function getBundle() {
  if (!cache) cache = build();
  return cache;
}
function invalidate() {
  cache = null;
  version = Date.now();
  console.log(`[rebuild] ${new Date(version).toLocaleTimeString()}  bundle 待重建`);
}

watch(join(ROOT, 'src'), { recursive: true }, invalidate);
watch(join(PS, 'vendor', 'three.module.min.js'), invalidate);

/* ---------------- 服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

function serveFile(res, file) {
  try {
    const buf = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (p === '/bundle.js') {
    const { code } = getBundle();
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(code);
    return;
  }
  if (p === '/version') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ version, bytes: cache ? cache.bytes : 0 }));
    return;
  }
  if (p === '/' || p === '/index.html') { serveFile(res, join(ROOT, 'mock', 'desktop.html')); return; }
  if (p.startsWith('/demo/')) { serveFile(res, join(PS, normalize(p.slice(6)))); return; }
  if (p.startsWith('/_ps/')) { serveFile(res, join(PS, normalize(p.slice(5)))); return; }

  const local = normalize(join(ROOT, p));
  if (!local.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  serveFile(res, local);
}).listen(PORT, '127.0.0.1', () => {
  const b = build();
  console.log(`粒子门注入服务已启动`);
  console.log(`  mock 桌面页   http://127.0.0.1:${PORT}/`);
  console.log(`  注入包        http://127.0.0.1:${PORT}/bundle.js   (${(b.bytes / 1024).toFixed(0)} KB)`);
  console.log(`  版本号        http://127.0.0.1:${PORT}/version`);
  console.log(`改 src/inject.js 后自动重建，userscript 会在 1s 内热替换`);
});
