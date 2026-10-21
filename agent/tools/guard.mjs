/**
 * 自造工具的运行时护栏。
 *
 * 文档 §5 那句话是硬要求：`needs` 声明的域名与路径**由运行时强制，不靠脚本自觉**。
 * 所以这一层不在模型这一侧，也不在 forge 这一侧 —— 它在**工具自己那个进程里**，
 * 靠 `node --import guard.mjs run.mjs` 先于任何用户代码执行。
 *
 * 它拦三样：
 *   1. 网：fetch / http / https / net / tls / dns —— 域名不在 needs.net 里就抛
 *   2. 文件：fs（同步 / 回调 / promises 三套）—— 路径不在 needs.fs 里就抛
 *   3. 进程：child_process / process.binding / dlopen —— 一律禁
 *
 * **它不是一个沙箱。** 同一个进程里的 JS 想绕总能绕（比如 `process.mainModule`）。
 * 但它把"偷偷连一个域名"从一行 fetch 变成必须刻意对着一份要给人看的 manifest
 * 撒谎 —— 而 manifest 是要贴到审批卡上的。这是"知情"级别的防护，不是"隔离"级别，
 * 文档里也这么写的。真隔离要上容器，那是另一件事。
 *
 * 拦下来的错误信息是**写给模型看**的：它得知道"改哪一行才能继续"。
 */

import path from 'node:path';
import fsCjs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const RAW = process.env.EM_TOOL_NEEDS || '{}';
/* 别让脚本把自己的 needs 读走再改成"什么都能连"—— 它读到的应该是空的。 */
delete process.env.EM_TOOL_NEEDS;

let spec = {};
try { spec = JSON.parse(RAW) || {}; } catch { spec = {}; }

const netList = (Array.isArray(spec.net) ? spec.net : []).map(String).filter(Boolean);
const fsList = (Array.isArray(spec.fs) ? spec.fs : []).map(String).filter(Boolean);

/* 工具自己的目录永远可写：脚本要存个缓存/临时结果，不该为此多写一条 needs。
   它是 cwd —— 但 spawn 时 cwd 由 forge 给，脚本改不了。 */
const SELF = process.cwd();

const deny = (msg, hint) => {
  const e = new Error(msg + (hint ? `。${hint}` : ''));
  e.code = 'EM_TOOL_DENIED';
  return e;
};

/* ── 网 ── */

/** `host:port` 或 `host` 或 `*.example.com`。带端口的只放行那个端口。 */
function splitHostPort(s) {
  const t = String(s).trim().toLowerCase();
  const m = /^(.*?):(\d+)$/.exec(t);
  return m ? [m[1], m[2]] : [t, null];
}

function hostAllowed(host, port) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  const p = port == null ? null : String(port);
  for (const raw of netList) {
    const [want, wantPort] = splitHostPort(raw);
    if (wantPort && p && wantPort !== p) continue;
    if (want.startsWith('*.')) {
      const tail = want.slice(1);                 // '.example.com'
      if (h === want.slice(2) || h.endsWith(tail)) return true;
    } else if (h === want) return true;
  }
  return false;
}

function denyNet(host, port) {
  const h = String(host || '?');
  return deny(
    `工具没有声明访问 ${h}${port ? ':' + port : ''}`,
    '如果这个地址是拼出来的，就把完整的 http://host:port 直接写在代码里 —— '
    + '系统会从代码里把它读出来、摆到审批卡上；'
    + '也可以让用户在 tool_write 的 net 里写上它。脚本里绕不过去。',
  );
}

/** 从 http.request 的第一参数里抠出 host/port。三种写法都要认。 */
function targetOf(a, b) {
  if (typeof a === 'string') {
    const s = a.includes('://') ? a : `http://${a}`;
    try {
      const u = new URL(s);
      return [u.hostname, u.port || (u.protocol === 'https:' ? '443' : '80')];
    } catch {
      return [a, null];
    }
  }
  if (a instanceof URL) return [a.hostname, a.port || (a.protocol === 'https:' ? '443' : '80')];
  if (a && typeof a === 'object') {
    if (typeof a.hostname === 'string') return [a.hostname, a.port ?? null];
    if (typeof a.host === 'string') {
      const [h, p] = a.host.split(':');
      return [h, a.port ?? p ?? null];
    }
    return [null, a.port ?? null];
  }
  if (typeof a === 'number') return [typeof b === 'string' ? b : 'localhost', a];
  return [null, null];
}

const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    let url;
    try {
      url = typeof input === 'string' ? input
        : (input instanceof URL ? input.href
          : String(input?.url || ''));
    } catch { url = ''; }
    if (url) {
      try {
        const u = new URL(url);
        if (!hostAllowed(u.hostname, u.port || (u.protocol === 'https:' ? '443' : '80'))) {
          throw denyNet(u.hostname, u.port || undefined);
        }
      } catch (e) {
        if (e?.code === 'EM_TOOL_DENIED') throw e;
        /* URL 解析不了：不是 http 请求（fetch 自己会拒），放它过去 */
      }
    }
    return realFetch.call(this, input, init);
  };
}

function wrapHttp(mod) {
  for (const fn of ['request', 'get']) {
    const real = mod[fn];
    if (typeof real !== 'function') continue;
    mod[fn] = function guarded(a, b, c) {
      const [h, p] = targetOf(a, b);
      if (h && !hostAllowed(h, p)) throw denyNet(h, p);
      return real.call(this, a, b, c);
    };
  }
}
wrapHttp(http);
wrapHttp(https);

/* 裸 socket。http 模块内部走 internal binding，拦不住 —— 所以上面的 http/https
   是必须的；这里拦的是脚本自己 new net.Socket() 或者连一个没声明的端口。 */
for (const [mod, fns] of [[net, ['connect', 'createConnection']], [tls, ['connect']]]) {
  for (const fn of fns) {
    const real = mod[fn];
    if (typeof real !== 'function') continue;
    mod[fn] = function guarded(...a) {
      const [h, p] = targetOf(a[0], a[1]);
      if (h && !hostAllowed(h, p)) throw denyNet(h, p);
      return real.apply(this, a);
    };
  }
}

/* DNS 也拦：先解析出 IP 再连 IP，是一条常见绕法。 */
for (const fn of ['lookup', 'lookupService']) {
  const real = dns[fn];
  if (typeof real !== 'function') continue;
  dns[fn] = function guarded(host, ...rest) {
    if (typeof host === 'string' && host && !hostAllowed(host, null)) throw denyNet(host);
    return real.call(this, host, ...rest);
  };
}
try {
  if (dns.promises && typeof dns.promises.lookup === 'function') {
    const realP = dns.promises.lookup;
    dns.promises.lookup = async function guarded(host, ...rest) {
      if (typeof host === 'string' && host && !hostAllowed(host, null)) throw denyNet(host);
      return realP.call(this, host, ...rest);
    };
  }
} catch { /* 老 node 没有 promises */ }

/* ── 文件 ── */

const WIN = process.platform === 'win32';

/**
 * 一条路径 → 用来比对的绝对形态。
 *
 * Windows 上有个坑：Node 的 ESM 加载器读入口文件时，传进来的是 `/C:/...`
 * 这种"半个 POSIX"的写法（Node 22 实测），`path.resolve` 会把它拼成
 * `C:\C:\...`。不认这个形状的话，**工具连自己的源码都读不了**，
 * 而报错会指向 needs.fs，把人往完全错的方向带。
 */
function absOf(p) {
  const sep = path.win32.sep;
  let s = String(p);
  if (WIN) {
    s = s.replace(/\//g, sep);
    /* 开头是分隔符、后面紧跟盘符的（/C:/…），把多余那层摘掉 */
    if (s[0] === sep && /^.[A-Za-z]:/.test(s)) s = s.slice(1);
    if (/^[A-Za-z]:/.test(s)) return path.win32.normalize(s);
    return path.win32.resolve(SELF, s);
  }
  if (s.startsWith('/')) return path.posix.normalize(s);
  return path.posix.resolve(SELF, s);
}

const under = (p, base) => {
  if (WIN) {
    const a = p.toLowerCase();
    const b = base.toLowerCase();
    return a === b || a.startsWith(b + path.win32.sep);
  }
  return p === base || p.startsWith(base + path.sep);
};

function fsAllowed(p) {
  for (const raw of fsList) {
    let base = raw;
    if (base === '~') base = process.env.HOME || '';
    else if (base.startsWith('~/')) base = path.join(process.env.HOME || '', base.slice(2));
    if (!base) continue;
    if (under(p, absOf(base))) return true;
  }
  if (under(p, absOf(SELF))) return true;   // 工具自己的目录
  return false;
}

function denyFs(p) {
  const shown = String(p).length > 80 ? String(p).slice(0, 77) + '…' : String(p);
  return deny(
    `工具没有声明读写 ${shown}`,
    '要碰它就在 manifest.json 的 needs.fs 里写上那个目录（脚本自己的目录不用写）',
  );
}

function checkPath(p) {
  if (typeof p === 'string') {
    if (!p || p === '.') return;
    if (p.includes('\0')) throw deny('路径里有非法字符');
    const abs = absOf(p);
    if (!fsAllowed(abs)) throw denyFs(p);
    return;
  }
  if (p instanceof URL) { checkPath(p.pathname); return; }
  if (Buffer.isBuffer(p)) checkPath(p.toString());
  /* 数字是 fd，对象是 FileHandle —— 它们能改的东西在前面那次 open 就已经判过了 */
}

const PATH_FIRST = ['access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync',
  'chown', 'chownSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'createReadStream',
  'createWriteStream', 'exists', 'existsSync', 'lchmod', 'lchown', 'link', 'linkSync', 'lstat',
  'lstatSync', 'lutimes', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'open', 'openSync',
  'opendir', 'opendirSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'readlink',
  'readlinkSync', 'realpath', 'realpathSync', 'rename', 'renameSync', 'rm', 'rmSync', 'rmdir',
  'rmdirSync', 'stat', 'statSync', 'statfs', 'statfsSync', 'symlink', 'symlinkSync', 'truncate',
  'truncateSync', 'unlink', 'unlinkSync', 'utimes', 'utimesSync', 'watch', 'watchFile',
  'writeFile', 'writeFileSync'];

function wrapFsObject(obj) {
  if (!obj) return;
  for (const fn of PATH_FIRST) {
    const real = obj[fn];
    if (typeof real !== 'function') continue;
    obj[fn] = function guarded(...a) {
      /* 前两个参数都判：rename/copyFile/link/symlink 的**目标**同样要过白名单，
         只判来源的话 `fs.rename(~/x, /etc/y)` 就穿过去了。 */
      checkPath(a[0]);
      if (a.length > 1) checkPath(a[1]);
      return real.apply(this, a);
    };
  }
}
wrapFsObject(fsCjs);
wrapFsObject(fsCjs.promises);

/* ── 进程 ── */

const denyProc = (what) => deny(
  `工具不允许调起别的进程（${what}）`,
  '写脚本解决问题，别 shell out —— 一条 shell 能做的事，护栏都白写了',
);

for (const k of Object.keys(cp)) {
  if (typeof cp[k] === 'function') {
    cp[k] = () => { throw denyProc(`child_process.${k}`); };
  }
}
/* execSync 等是 lazy getter 之外的普通函数，上面的循环已覆盖；
   但 fork 走的是 cp.fork，也在这张表里。 */
try { process.binding = () => { throw denyProc('process.binding'); }; } catch { /* 只读 */ }
try {
  if (typeof process.dlopen === 'function') process.dlopen = () => { throw denyProc('process.dlopen'); };
} catch { /* 只读 */ }

/* 把 CJS 上的改动同步给 ESM 的具名导出。
   不调这一下的话，`import { request } from 'node:https'` 拿到的仍是原函数 ——
   而工具是 ESM（.mjs），那正好是最常见的写法。这一行是整层的关键。 */
syncBuiltinESMExports();

