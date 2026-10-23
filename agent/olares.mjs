/**
 * Olares 系统能力 —— 官方 `olares-cli` 的**唯一受控出口**。
 *
 * 为什么不再自己读 CRD / 猜 HTTP 路径：
 *   官方把系统管理做完了，而且做成了给 agent 读的技能包（`cli/skills/*`）。
 *   实测（2026-10-22，线上 pod 内）：
 *     olares-cli version                → 1.12.8-cli.0 (skills)
 *     profile login --password-stdin    → Owner
 *     market list --mine -o json        → name/title/version/source/state
 *     dashboard overview -o json        → cpu 0.325 + 结构化 envelope
 *   CLI 自带版本对齐（`settings` 的 gpu/compute 按 1.12.5 / 1.12.6+ 切）、
 *   token 刷新、`--watch` 的状态机语义 —— 重写一遍就是重写一个 CLI。
 *
 * 这一层只做三件事，**别的都不做**：
 *   1. 把 `op` 翻译成**固定的 argv 数组**（模型只填枚举和名字，拼不了字符串，注入不了）；
 *   2. 跑，带超时，把 stdout 的 JSON 与 stderr 的 `{error:{code,message}}` 分开；
 *   3. 每次调用写一条审计（命令、耗时、退出码、输出前 200 字）。
 *
 * 安全边界（和 guard.mjs 的分工）：
 *   `guard.mjs` 管的是**模型自己写的脚本**（在 tool_code 的子进程里 import，禁 child_process）。
 *   这个文件是 agent 主进程里唯一允许 spawn 的地方 —— 所以白名单必须硬编码在这里，
 *   不能由模型的参数拼出来。危险动词（install/uninstall/delete）**不在这里**，
 *   它们要走 tools.mjs 的 danger 级和审批门。
 */

import { execFile, spawn } from 'node:child_process';

const BIN = process.env.OLARES_CLI || 'olares-cli';

/**
 * `profile list` 的 `status` → 我们该不该当成"能干活"。
 *
 * 这张表**不是猜的**，是 CLI 自己文档里的（`cli/skills/shared/references/auth.md`）：
 *
 *   logged-in  → 继续
 *   expired    → **继续**：只是 access token 过了期，下一条命令会自己刷新
 *   pending    → 继续：平台发的 profile 还没交换 grant，下一条命令会交换
 *   unknown    → 继续：本地判断不了，跑一条命令看
 *   invalidated→ 停：服务端拒了 refresh，要重新登录
 *   never      → 停：从来没有存过 token
 *
 * 这里踩过一次，而且踩得很像"设计如此"：原来判的是 `status.includes('logged')`，
 * 于是 `expired` 被当成"没授权"，工具直接回一句"去终端跑 olares-cli profile login"。
 * 实测后果（2026-10-23）：pod 里 profile 一直是 `expired`，而 `market list --mine`
 * 照样能跑通（它自己刷新了），跑完 `profile list` 就变回 `logged-in`。
 * 也就是说**我们拦住了一次本来会成功的调用，还让用户去开终端**。
 */
export function authState(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('invalidat')) return 'reauth';
  if (s.includes('never')) return 'reauth';
  if (s.includes('expired')) return 'stale';     // 能干活，只是 token 该刷了
  if (s.includes('pending')) return 'pending';
  return 'ok';
}

/**
 * 密码登录的 argv。
 *
 * **不能带 `-o json`** —— `profile login` 不认这个旗标，会回
 * `unknown shorthand flag: 'o' in -o`，整条自救链就断在这儿（线上真踩过，
 * 而那个报错看起来像"密码不对"）。同一个坑 `settings me` 也踩过：
 * **不是每条子命令都支持 `-o`**，别把 `run()` 里那套统一加旗标当成理所当然。
 */
export function loginArgv(id, totp = '') {
  return ['profile', 'login', '--olares-id', String(id), '--password-stdin',
    ...(totp ? ['--totp', String(totp)] : [])];
}

/* 读操作白名单：op → argv。**不带 `-o json`**，统一在 run() 里加。 */
const READ = {
  /* 应用清单：装了什么、什么版本、从哪个源来的、什么状态。
     比原来自己从 k8s 拼的 app_list 多出 version / source / categories。 */
  apps: () => ['market', 'list', '--mine'],
  /* 市场里有什么（可装什么）。catalog 是全量，慢一些。 */
  catalog: () => ['market', 'list'],
  /* 单个应用的生命周期状态（含 entranceStatuses） */
  app: (name) => ['market', 'status', name],
  /* 市场条目详情：一句话介绍、分类、版本历史、chart 来源。
     **原始输出 32KB**（一整个 app_info），必须 shape 之后再交给模型。 */
  appinfo: (name) => ['market', 'get', name],
  /* 市场分类与各类数量（"有没有能记账的应用"先看这个） */
  categories: () => ['market', 'categories'],
  /* 整机负载：physical / user / ranking 三段 envelope */
  overview: () => ['dashboard', 'overview'],
  /* 按应用排资源占用 */
  usage: () => ['dashboard', 'applications'],
  /* 版本、身份 */
  version: () => ['settings', 'me', 'version'],
  whoami: () => ['settings', 'me', 'whoami'],
  /* 用户 */
  users: () => ['settings', 'users', 'list'],
  /* 某个应用的后置配置：入口、环境变量、ACL */
  appcfg: (name) => ['settings', 'apps', 'get', name],
  /* 用户空间的 k8s 视图（不是系统全部命名空间） */
  context: () => ['cluster', 'context'],
  /* 这个用户能看见的所有 pod（跨命名空间，比 kubectl 那套视口宽）。
     原始 366KB —— 只有 name/状态/重启次数有用。 */
  pods: () => ['cluster', 'pod', 'list'],
  /* 一个 pod 最近的事件：CrashLoopBackOff / 拉不到镜像 的根因都在这儿 */
  events: (name) => ['cluster', 'pod', 'events', name],
  /* 本地 containerd 镜像与引用数（"磁盘被什么占了"的最后一块） */
  images: () => ['doctor', 'images'],
  /* 备份计划（有没备、备到哪、上次什么时候） */
  backup: () => ['settings', 'backup', 'plans', 'list'],
};

/** 需要 `name` 的 op */
const NEED_NAME = new Set(['app', 'appcfg', 'appinfo', 'events']);

/**
 * 写操作 —— **单独一张表，不是 READ 的延伸**。
 *
 * 三条硬规矩（也写在 tools.mjs 的 olares_act 里）：
 *   1. 每个动词都是固定 argv，模型只给应用名，拼不了 flag；
 *   2. 全部走 danger 级审批门（`needsGate`），用户点头才跑；
 *   3. `--watch` 有超时：等不到终态就返回"还没结束"，绝不当成失败。
 *      装一个应用要拉镜像，90 秒等不到很正常 —— 把它报成失败会让人重试，
 *      而重试一个正在跑的任务只会多一条排队。
 */
const WRITE = {
  stop: (name) => ['market', 'stop', name],
  resume: (name) => ['market', 'resume', name],
  restart: (name) => ['market', 'restart', name],
  install: (name) => ['market', 'install', name, '--watch', '--watch-timeout', '90s'],
  upgrade: (name) => ['market', 'upgrade', name, '--watch', '--watch-timeout', '90s'],
  uninstall: (name) => ['market', 'uninstall', name],
  cancel: () => ['market', 'cancel'],
};

/** 可写的动词 */
export const ACTS = Object.keys(WRITE);

export const ACT_DOC = [
  'stop=停掉一个应用（可 resume 回来）',
  'resume=把停掉的应用开回来',
  'restart=重启一个应用中',
  'install=从市场装一个应用(name=市场里的名字)，最多等 90 秒',
  'upgrade=升级到最新版',
  'uninstall=卸载（数据一般保留，但入口没了）',
  'cancel=取消正在进行的装/卸/升级',
].join(' · ');

/** 可用的 op 列表（工具 schema 的 enum 从这里来，别在两个地方各写一份） */
export const OPS = Object.keys(READ);

/** 给模型看的 op 说明。写在这里而不是提示词里：工具 schema 离调用更近。 */
export const OP_DOC = [
  'apps=装了哪些应用(版本/状态/来源/CPU/内存)，并附整机内存 node；每个应用的 cpu/memPct 是 0~1、指它自己占节点的比例（整机看 node）',
  'app=某个应用的状态(name)；不含重启次数，那个看 pods',
  'appinfo=某个应用是什么、能干什么(name)',
  'catalog=市场有什么可装',
  'categories=市场分类与数量',
  'overview=整机负载(CPU/内存/磁盘/网络)',
  'usage=哪个应用吃资源',
  'version=系统版本',
  'whoami=当前身份',
  'users=用户列表',
  'appcfg=应用配置与入口(name)',
  'context=当前 K8s 视野',
  'pods=用户空间里所有 pod 的状态与重启次数',
  'events=某个 pod 最近发生了什么(name=pod 名)',
  'images=本地镜像与引用数(占磁盘)',
  'backup=备份计划',
].join(' · ');

/**
 * @param {object} o
 * @param {string} [o.bin]  覆盖二进制路径（测试用）
 * @param {number} [o.ttl]  `profile list` 结果的缓存时长
 */
export function createOlares(o = {}) {
  const bin = o.bin || BIN;
  const ttl = o.ttl ?? 30_000;
  /* 自测口子之二：密码登录要 spawn 一个进程、从 stdin 灌密码，
     整个这一条（"身份坏了 → 自己登一次 → 继续查"）在 CI 里没法真跑。 */
  const loginFn = o.login || ((id, pw, totp) => runLogin(id, pw, totp));

  let probeCache = null;   // { at, ok, code, message, who }
  /* 读结果缓存（见 read 里那段注释）。键是 `op:name`，只存成功的读。 */
  const cache = new Map();
  const RES_TTL = Number(process.env.OLARES_CACHE_MS || 15000);

  /* 节点内存总量（算应用占比的分母）。

     **实测两者完全一致**：`/proc/meminfo` 的 MemTotal 是 16375776 kB，
     `dashboard overview` 的 memory.total 是 15992 MB —— 同一个数。
     而前者 0 ms、后者 8.5 秒（它去查 Prometheus）。

     所以分母读本机，overview 只做兜底（非 Linux、或容器没挂 procfs 时）。
     这一条把"第一次问应用清单"从 9 秒降到 4 秒。

     为什么非要分母：模型画仪表要 0~1 的占比，只有清单时会拿 0 顶上去 ——
     屏幕上就是"n8n / navidrome / qbittorrent 全 0%"，那是**假数**。 */
  let quota = null;      // { at, memTotal }
  const QUOTA_TTL = 30 * 60_000;
  let quotaInflight = null;
  let inflight = null;     // 同一刻只探一次（一轮里四个工具同时调很常见）

  /**
   * 跑一次。**argv 必须是白名单里拼好的数组**，不做字符串拼接。
   * @returns {{ok:boolean, data?:any, error?:{code:string,message:string}, ms:number, stderr?:string}}
   */
  function run(argv, { timeout = 25_000, json = true } = {}) {
    /* 自测口子：把整条 CLI 换成一个函数。
       认证判断（哪几种 status 该放行）决定"会不会拦住用户"，而它原来只能在
       真 pod 里验 —— 没有这个口子，这类 bug 就只能靠线上复现一次、再修一次。 */
    if (o.exec) return o.exec(argv, { timeout, json });
    const t0 = Date.now();
    const full = json ? [...argv, '-o', 'json'] : argv;
    return new Promise((resolve) => {
      execFile(bin, full, {
        timeout,
        killSignal: 'SIGTERM',
        maxBuffer: 8 * 1024 * 1024,
        env: {
          /* 只给够用的环境：CLI 需要 HOME 找配置和 keychain，
             PATH 找它自己可能 exec 的东西（比如 kubectl）。别的都不给。 */
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME || '/root',
          TZ: process.env.TZ || 'Asia/Shanghai',
          OLARES_CLI_CREDENTIALS_DIR: process.env.OLARES_CLI_CREDENTIALS_DIR || '',
          OLARES_CLI_CACHE_DIR: process.env.OLARES_CLI_CACHE_DIR || '',
        },
      }, (err, stdout, stderr) => {
        const ms = Date.now() - t0;
        /* CLI 的约定：成功 → stdout 是 JSON；失败 → stderr 是**整条** JSON
           （`{"error":{"code","message","retryable","action"}}`），
           所以 stderr 可以整条 parse，不用切。 */
        if (err) {
          const j = tryJSON(stderr);
          const e = j?.error || {};
          const timeoutErr = err.killed || err.signal === 'SIGTERM';
          const out = {
            ok: false,
            ms,
            error: {
              code: e.code || (timeoutErr ? 'timeout' : 'unclassified'),
              message: e.message || (timeoutErr ? `超过 ${Math.round(timeout / 1000)} 秒没返回` : String(stderr || err.message).slice(0, 400)),
            },
            stderr: String(stderr || '').slice(0, 200),
          };
          audit(argv, out);
          resolve(out);
          return;
        }
        const data = tryJSON(stdout);
        const out = data
          ? { ok: true, data, ms }
          : { ok: false, ms, error: { code: 'unparsable', message: '命令回来了，但不是 JSON' }, stderr: String(stdout || '').slice(0, 200) };
        audit(argv, out);
        resolve(out);
      });
    });
  }

  /** 审计：一行一条，和 tool_* 的审计同一条流（stdio 就够，pod 日志能看到） */
  function audit(argv, r) {
    const out = r.ok
      ? `${Array.isArray(r.data) ? r.data.length + ' 条' : 'ok'}`
      : `${r.error.code}: ${r.error.message.slice(0, 60)}`;
    console.log(`[olares] ${argv.slice(0, 4).join(' ')} → ${out} (${r.ms}ms)`);
  }

  /**
   * 有没有身份。它决定两件事：工具返回什么、以及**要不要提前说"没法查"**。
   * 缓存 30 秒：一轮里可能连着调四五个 op，每次都跑 `profile list` 是浪费。
   */
  async function probe() {
    const now = Date.now();
    if (probeCache && now - probeCache.at < ttl) return probeCache;
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await run(['profile', 'list'], { timeout: 8000 });
      let out;
      if (!r.ok) {
        out = { at: now, ok: false, code: r.error.code, message: r.error.message };
      } else {
        /* `profile list -o json` 是**数组**，每项 `{name, olaresId, status, current}`。
           不是 `{currentProfile, profiles}` —— 那是 config.json 的形状，两者不一样。
           踩过：按 config 的形状读，永远读到空，于是"已经登录"被判成"没授权"。 */
        const list = Array.isArray(r.data) ? r.data : (r.data?.profiles || []);
        const cur = list.find((p) => p.current === true) || (list.length === 1 ? list[0] : null);
        const st = authState(cur?.status);
        /* `expired` / `pending` 都算能干活（见上面 authState 的注释）。 */
        const ok = !!cur && st !== 'reauth';
        out = {
          at: now,
          ok,
          who: cur?.name || cur?.olaresId || '',
          olaresId: cur?.olaresId || cur?.name || '',
          role: cur?.ownerRole || cur?.role || '',
          status: cur?.status || '',
          stale: st === 'stale',
          code: ok ? '' : (list.length ? 'auth_not_logged_in' : 'auth_no_profile'),
          message: ok ? '' : '这台机器上的 Olares 身份失效了（不是没有数据）',
        };
      }
      probeCache = out;
      inflight = null;
      return out;
    })();
    return inflight;
  }

  const NOAUTH = () => ({
    error: '这台机器上的 Olares 身份现在用不了（不是"没有数据"）。'
      + (authNote ? `自动重登试过了：${authNote}。` : '')
      /* 这条最要紧：**不要叫用户去敲命令。** 他面对的是桌面，不是 shell。
         程序跑在这台机器上，能自己做的事就不该转交给用户。 */
      + '不要叫用户去终端跑什么命令 —— 他打开的是桌面。'
      + '要恢复只有一条路：把 Olares 的 refresh token 或密码放进服务端环境变量 '
      + '（`OLARES_REFRESH_TOKEN`，或 `OLARES_PASSWORD` + `OLARES_ID`），程序会自己接上。'
      + '在那之前，机器负载和文件仍然能查（走的是另一条路）。',
    needAuth: true,
  });

  /* ───────────── 自己重登（不是让用户去开终端） ─────────────
   *
   * 判据来自 CLI 的 auth.md：它自己会刷新过期的 access token，
   * 所以**我们不做认证重试循环**；但 `invalidated`（服务端拒了 refresh）
   * 它自己救不了 —— 那时只有一条出路：用配置里的凭据重登一次。
   *
   * 三件事不能省：
   *   ① 冷却 5 分钟。否则每条业务命令都会带一次登录，几秒变几十秒；
   *   ② 单飞。一轮里四五个工具同时撞 auth 时只登一次；
   *   ③ 密码只走 stdin。`profile login` 的 help 里写死了：参数里放密码会进 `ps`。
   */
  let authAt = 0;
  let authInflight = null;
  let authNote = '';

  function creds() {
    return {
      id: String(process.env.OLARES_ID || '').trim(),
      rt: String(process.env.OLARES_REFRESH_TOKEN || '').trim(),
      pw: process.env.OLARES_PASSWORD || '',
    };
  }

  /** 密码登录：`--password-stdin` 要求密码走管道，不能进 argv。 */
  function runLogin(id, password, totp = '') {
    const t0 = Date.now();
    const argv = loginArgv(id, totp);
    return new Promise((resolve) => {
      const p = spawn(bin, argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME || '/root',
          TZ: process.env.TZ || 'Asia/Shanghai',
        },
      });
      let out = '';
      let err = '';
      const t = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* 已退出 */ } }, 20_000);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, ms: Date.now() - t0, error: { code: 'spawn_failed', message: String(e.message) } }); });
      p.on('close', (code) => {
        clearTimeout(t);
        const ms = Date.now() - t0;
        const j = tryJSON(out) || tryJSON(err);
        const r = code === 0
          ? { ok: true, data: j, ms }
          : { ok: false, ms, error: { code: j?.error?.code || 'login_failed', message: String(j?.error?.message || err || out || `退出码 ${code}`).slice(0, 300) } };
        console.log(`[olares] profile login ${id} → ${r.ok ? 'ok' : r.error.code} (${ms}ms)`);
        resolve(r);
      });
      try { p.stdin.write(password + '\n'); p.stdin.end(); } catch { /* 进程已经没了 */ }
    });
  }

  /**
   * 用配置里的凭据重新登录一次。**没有凭据就什么都没有** —— 不假装。
   * @returns {Promise<{ok:boolean, how?:string, reason?:string}>}
   */
  async function reauth() {
    if (authInflight) return authInflight;
    const now = Date.now();
    if (now - authAt < 5 * 60_000) return { ok: false, reason: 'cooling' };
    authAt = now;
    authInflight = (async () => {
      const c = creds();
      const id = c.id || probeCache?.olaresId || '';
      if (!c.rt && !c.pw) {
        authNote = '没配凭据（OLARES_REFRESH_TOKEN / OLARES_PASSWORD），无从下手';
        return { ok: false, reason: 'no-credentials' };
      }
      if (!id) {
        authNote = '不知道该用哪个 Olares ID（配 OLARES_ID）';
        return { ok: false, reason: 'no-id' };
      }
      /* refresh token 优先：不用密码，也不会因为改密码而失效 */
      if (c.rt) {
        const r = await run(['profile', 'import', '--olares-id', id, '--refresh-token', c.rt],
          { json: false, timeout: 20_000 });
        if (r.ok) { authNote = ''; probeCache = null; cache.clear(); return { ok: true, how: 'refresh-token' }; }
        authNote = `refresh token 被拒（${r.error.code}）`;
        console.warn('[olares] import 失败：' + r.error.message);
      }
      if (c.pw) {
        const r = await loginFn(id, c.pw);
        if (r.ok) { authNote = ''; probeCache = null; cache.clear(); return { ok: true, how: 'password' }; }
        authNote = `密码登录也失败（${r.error.code}）`;
        console.warn('[olares] login 失败：' + r.error.message);
      }
      return { ok: false, reason: 'failed' };
    })().finally(() => { authInflight = null; });
    return authInflight;
  }

  /**
   * 确保这一刻能干活。
   *
   * `expired` / `pending` **直接算能**（CLI 下一次调用会自己刷新/交换）；
   * `invalidated` / `never` 先自己重登一次再探（冷却 5 分钟，撞了就用上次的结论）。
   *
   * 这个函数存在的原因是：原来的闸只看"profile list 说没说 logged"，
   * 而那个判断会**拦住一次本来会成功的调用** —— 拦住之后，也就永远等不到
   * "命令失败 → 触发重登"的机会。闸和自救必须在同一个地方。
   */
  async function ensure() {
    const p = await probe();
    if (p.ok) return p;
    const re = await reauth();
    if (!re.ok) return p;
    return probe();
  }

  /**
   * 跑一条业务命令；认证类失败时**自己重登一次再试**。
   *
   * 只在 `auth*` 上这么做：那是"身份被拒"，重试业务命令本身不会有别的结果。
   * 其它错误（超时、权限 403）原样回去 —— 403 不是登录能修的（CLI 的 auth.md 也这么说）。
   */
  async function runAuthed(argv, opts) {
    let r = await run(argv, opts);
    if (r.ok || !String(r.error?.code || '').startsWith('auth')) return r;
    const re = await reauth();
    if (!re.ok) return r;
    console.log(`[olares] 身份已自动恢复（${re.how}），重试 ${argv.slice(0, 3).join(' ')}`);
    r = await run(argv, opts);
    return r;
  }

  /**
   * 读一个 op。
   * @param {string} op
   * @param {string} [name]
   */
  async function read(op, name) {
    const make = READ[op];
    if (!make) return { error: `不认识的 op：${op}。可用：${Object.keys(READ).join(' / ')}` };
    if (NEED_NAME.has(op) && !name) return { error: `${op} 要给 name（应用名）` };

    /* **模型会重复调同一个 op**，不是偶尔，是实测每一轮都这样：一轮里
       `market list --mine` 跑了两遍（日志里并排两条），每次 4~6 秒，
       45 秒都收不了尾。缓存不是为了省时间，是为了让"重复调"这件事不产生代价 ——
       它重复调是因为拿不准第一次的结果够不够，罚它 6 秒只会让它更慢。

       TTL 8 秒 ≈ 一轮的长度。同一轮里是**同一时刻的读数**，不违反"只认本轮读数"；
       跨轮（8 秒以上）自然重取。命中的结果带 `cached: true`，模型知道这不是新取的。 */
    const key = `${op}:${name || ''}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < RES_TTL) {
      return { ...hit.data, cached: true, ageMs: Date.now() - hit.at };
    }

    const p = await ensure();
    if (!p.ok) return NOAUTH();

    /* apps 要三份数据才够用：清单（版本/来源）、占用（cpu/内存）、总量（算占比）。
       三个 exec **并行**跑，总耗时约等于最慢那个（~2s）；串行要 5s 以上。
       为什么非要合并：模型画仪表要 0~1 的占比，只有清单时会拿 0 顶上去 ——
       屏幕上就是"n8n / navidrome / qbittorrent 全 0%"，那是**假数**。 */
    if (op === 'apps') return remember(key, await readApps());
    /* events 要带命名空间（CLI 强制要求），而模型只记得住 pod 名 —— 这里替它查 */
    if (op === 'events') return remember(key, await readEvents(name));

    const r = await runAuthed(make(name));
    if (!r.ok) {
      /* 走到这里说明**自动重登也没救回来**（runAuthed 已经试过一次）。 */
      if (r.error.code?.startsWith('auth')) {
        probeCache = null;      // 让下一次重新探
        return NOAUTH();
      }
      return { error: r.error.message, code: r.error.code };
    }
    return remember(key, shape(op, r.data, name));
  }

  /** /proc/meminfo 的总量与可用量（字节）。读不到返回 null，不抛 */
  async function readMemInfo() {
    try {
      const fs = await import('node:fs/promises');
      const txt = await fs.readFile('/proc/meminfo', 'utf8');
      const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(txt);
      const avail = /^MemAvailable:\s+(\d+)\s+kB/m.exec(txt);
      if (!total) return null;
      return {
        total: Number(total[1]) * 1024,
        avail: avail ? Number(avail[1]) * 1024 : null,
      };
    } catch {
      return null;
    }
  }

  /** 只要总量 */
  async function readMemTotal() {
    const m = await readMemInfo();
    return m ? m.total : null;
  }

  /** 节点内存总量（字节）：本机优先，overview 兜底 */
  async function memTotal(wait = true) {
    if (quota && Date.now() - quota.at < QUOTA_TTL) return quota.memTotal;

    const local = await readMemTotal();
    if (local) {
      quota = { at: Date.now(), memTotal: local };
      return local;
    }

    if (!quotaInflight) {
      quotaInflight = (async () => {
        const r = await runAuthed(['dashboard', 'overview'], { timeout: 30_000 });
        const t = r.ok
          ? (r.data?.sections?.physical?.items || []).find((x) => x?.raw?.metric === 'memory')?.raw?.total
          : null;
        if (t) quota = { at: Date.now(), memTotal: t };
        quotaInflight = null;
        return t || null;
      })();
    }
    return wait ? quotaInflight : null;
  }

  /** 写缓存（只缓存成功的读；错误是"此刻的状态"，不该被记忆 15 秒） */
  function remember(key, data) {
    if (data && !data.error) cache.set(key, { at: Date.now(), data });
    return data;
  }

  /* pod 名 → 命名空间。`cluster pod events` 的 `-n` 是**必填**（实测：
     不带给 plain error "namespace required"），而模型只会记得住 pod 名。
     与其让它先问一轮，不如在这里替它查一次 —— 顺手也把最近一次 pods 的结果用上了。 */
  let podNs = new Map();

  async function readEvents(name) {
    let pod = String(name || '').trim();
    let ns = '';
    /* 显式给了 `命名空间/pod` 就用它 */
    if (pod.includes('/')) { const [a, b] = pod.split('/'); ns = a; pod = b; }
    if (!ns) {
      if (!podNs.size) {
        const r = await runAuthed(['cluster', 'pod', 'list'], { timeout: 30_000 });
        if (r.ok) {
          for (const p of r.data?.items || []) {
            if (p?.metadata?.name) podNs.set(p.metadata.name, p.metadata.namespace || 'default');
          }
        }
      }
      ns = podNs.get(pod) || '';
      /* 模型常用应用名（n8n）而不是 pod 名（n8n-7d9f-xx2k）—— 唯一前缀匹配一次 */
      if (!ns) {
        const cand = [...podNs.keys()].filter((k) => k.startsWith(pod));
        if (cand.length === 1) { pod = cand[0]; ns = podNs.get(pod); }
      }
    }
    if (!ns) {
      const known = [...podNs.keys()].slice(0, 12).join('、');
      return {
        error: `没找到叫「${pod}」的 pod（它可能已经重建过，名字变了）。`
          + `先调 olares 的 pods 看现在的名字${known ? `：${known}` : ''}；`
          + '或者用「命名空间/pod名」的形式给 name。',
      };
    }
    const r = await runAuthed(['cluster', 'pod', 'events', pod, '-n', ns], { timeout: 30_000 });
    if (!r.ok) return { error: r.error.message, code: r.error.code };
    return { ns, ...shape('events', r.data, pod) };
  }

  /** apps：清单 + 占用 + 总量，合成一份 */
  async function readApps() {
    const [mk, ap, totalBytes, memInfo] = await Promise.all([
      run(['market', 'list', '--mine']),
      run(['dashboard', 'applications']),
      /* 分母走配额缓存（启动时已预取）。冷启动时才真去等那 8.5 秒 */
      memTotal(true),
      readMemInfo(),
    ]);
    if (!mk.ok) {
      if (mk.error.code?.startsWith('auth_')) return { error: `Olares 不认这个身份了（${mk.error.code}），要重新授权。` };
      return { error: mk.error.message };
    }
    const usage = new Map(((ap.ok ? ap.data?.items : []) || []).map((it) => [it?.raw?.app, it.raw || {}]));
    const list = Array.isArray(mk.data) ? mk.data : (mk.data?.items || []);
    return {
      apps: list.map((a) => {
        const u = usage.get(a.name) || {};
        const memPct = (u.memory != null && totalBytes)
          ? Math.round((u.memory / totalBytes) * 1000) / 1000
          : undefined;
        return {
          name: a.name,
          title: a.title || a.name,
          version: a.version || '',
          state: a.state || u.state || '',
          source: a.source || '',
          /* cpu 是 0~1；memMB 是无量纲的"多少兆"；memPct 是相对总内存 —— 
             两个都给，因为模型看到 memMB 会自己除 1000（记忆里踩过），
             而仪表要的是 memPct。 */
          cpu: typeof u.cpu === 'number' ? Math.round(u.cpu * 1000) / 1000 : undefined,
          memMB: typeof u.memory === 'number' ? Math.round(u.memory / 1024 / 1024) : undefined,
          memPct,
        };
      }),
      count: list.length,
      /* 总内存一起给：没有它，memPct 就是一个无法核对的百分比 */
      memTotalMB: totalBytes ? Math.round(totalBytes / 1024 / 1024) : undefined,
      /* **整机内存使用率**。不给这个，模型会拿上面某个应用的 memPct（0.022）
         去说"整机内存使用了大约 0.22%" —— 实测它就是这么读的，而且读得自信。
         根因不是它笨：问"装了哪些应用"时它手里只有应用占比，想补一句整体
         就只能猜。把整机读数一起递过去，它就不必猜。
         （`MemAvailable` 才是"还能用多少"，`MemFree` 会把 cache 算成已用。） */
      node: memInfo?.avail
        ? {
          memUsedPct: Math.round((1 - memInfo.avail / memInfo.total) * 1000) / 1000,
          memUsedMB: Math.round((memInfo.total - memInfo.avail) / 1024 / 1024),
          memTotalMB: Math.round(memInfo.total / 1024 / 1024),
        }
        : undefined,
      usageAt: ap.ok ? ap.data?.meta?.fetched_at : undefined,
    };
  }

  /**
   * 把 CLI 的输出压成"模型读得懂、又不会太胖"的形状。
   *
   * dashboard 的 envelope 有三段（physical / user / ranking），原样给模型是几千 token
   * 的结构体和 `fetched_at`/`profile` 这类元数据；这里只留数和单位。
   * market list 的每条有 categories/source 这类"市场分类"，对回答没用，去掉。
   */
  function shape(op, data, name) {
    if (op === 'apps') {
      const list = Array.isArray(data) ? data : (data?.items || []);
      return {
        apps: list.map((a) => ({
          name: a.name,
          title: a.title || a.name,
          version: a.version || '',
          state: a.state || '',
          source: a.source || '',
          categories: a.categories || undefined,
        })),
        count: list.length,
      };
    }

    if (op === 'overview') {
      const sec = data?.sections || {};
      const pick = (k) => {
        const items = sec?.[k]?.items || [];
        const out = {};
        for (const it of items) {
          const m = it?.raw?.metric;
          if (!m) continue;
          /* 单位陷阱：CLI 给 memory / disk 的 `unit` 写的是 "Gi"，但 `value` / `total`
             是**字节**（7085707264）—— 原样交给模型，它会说"内存用了 70 亿 Gi"。
             这里按字节折成 GiB，和 Olares 设置页显示的口径一致。 */
          const isBytes = (it.raw.unit === 'Gi' || it.raw.unit === 'Mi') && Number(it.raw.value) > 1e6;
          const conv = (v) => (typeof v === 'number' && isBytes ? Math.round((v / 1024 ** 3) * 10) / 10 : round(v));
          out[m] = {
            value: conv(it.raw.value),
            unit: isBytes ? 'GiB' : (it.raw.unit || ''),
            total: conv(it.raw.total),
            /* utilisation 是 0~1，和屏幕上仪表同一口径；没有就不给（别补 0） */
            pct: it.raw.utilisation != null ? round(it.raw.utilisation) : undefined,
          };
        }
        return out;
      };
      return {
        physical: pick('physical'),
        /* ranking 是"谁在吃资源"，和 usage 那个 op 重复，这里只留前 3 */
        ranking: (sec?.ranking?.items || []).slice(0, 3).map((x) => ({
          name: x?.raw?.name, pct: round(x?.raw?.utilisation ?? x?.raw?.value),
        })),
        at: data?.meta?.fetched_at,
      };
    }

    if (op === 'usage') {
      const items = data?.items || data?.applications || [];
      return {
        apps: items.slice(0, 8).map((x) => ({
          name: x?.raw?.name || x?.name,
          cpu: round(x?.raw?.cpu ?? x?.cpu),
          mem: round(x?.raw?.memory ?? x?.mem),
          pct: round(x?.raw?.utilisation ?? x?.pct),
        })),
      };
    }

    if (op === 'app') {
      return {
        name,
        state: data?.state || data?.status || '',
        version: data?.version || undefined,
        source: data?.source || undefined,
        /* 装到一半卡住时，progress / message 才是答案（"一直在转圈"问的就是这个） */
        progress: data?.progress && data.progress !== '-' ? data.progress : undefined,
        message: data?.message || undefined,
        reason: data?.reason && data.reason !== data?.state ? data.reason : undefined,
        entrances: (data?.entrances || []).map((e) => ({
          name: e.name, url: e.url || e.host, state: e.state, authLevel: e.authLevel,
        })),
      };
    }

    if (op === 'appcfg') {
      /* 这一条是"n8n 从哪进"的答案来源：entrances 里有域名 */
      const d = data?.data || data;
      return {
        name,
        entrances: (d?.entrances || []).map((e) => ({
          name: e.name, host: e.host, url: e.url, authLevel: e.authLevel, policy: e.policy,
        })),
        env: d?.env || undefined,
        state: d?.state || undefined,
      };
    }

    if (op === 'appinfo') {
      /* 原样给是 32KB —— 里面 90% 是 chart 的 CRD 定义和截图列表。
         用户问"这个应用是干什么的"要的是 title/description/categories/最新版本。 */
      const ai = data?.app_info || data?.appInfo || data || {};
      const entry = ai.app_entry || ai.entry || ai;
      const ver = ai.latest_version || ai.version || entry.version || '';
      return {
        name,
        title: entry.title || ai.title || name,
        description: String(entry.description || ai.description || '').slice(0, 240),
        categories: entry.categories || undefined,
        version: ver,
        entrances: (entry.entrances || []).map((e) => e.name || e.host).filter(Boolean).slice(0, 6),
      };
    }

    if (op === 'pods') {
      const items = data?.items || (Array.isArray(data) ? data : []);
      return {
        pods: items.map((p) => {
          const cs = p?.status?.containerStatuses || [];
          const waiting = cs.map((c) => c.state?.waiting?.reason).filter(Boolean).slice(0, 2).join(',');
          const row = {
            name: p?.metadata?.name,
            ns: p?.metadata?.namespace,
            phase: p?.status?.phase,
            ready: cs.filter((c) => c.ready).length + '/' + (cs.length || (p?.spec?.containers || []).length),
            restarts: cs.reduce((n, c) => n + (c.restartCount || 0), 0),
          };
          /* 起不来的真信号单独给；正常的 pod **不带这个键** ——
             `waiting: undefined` 在 JSON 里会消失，但在模型眼里那是一句"它在等什么"，
             于是它会给正常 pod 编一个原因。 */
          if (waiting) row.waiting = waiting;
          return row;
        }).slice(0, 40),
        count: items.length,
      };
    }

    if (op === 'events') {
      const items = data?.items || (Array.isArray(data) ? data : []);
      return {
        name,
        events: items
          .filter((e) => String(e?.type || '') !== 'Normal' || /Unhealthy|BackOff|Failed/i.test(String(e?.reason || '')))
          .slice(-10)
          .map((e) => ({
            type: e.type, reason: e.reason,
            msg: String(e.message || '').slice(0, 160),
            count: e.count, at: e.lastTimestamp || e.eventTime,
          })),
      };
    }

    if (op === 'images') {
      const items = data?.images || (Array.isArray(data) ? data : []);
      /* 字段名是 `refs`（被几个工作负载引用），不是 in_use —— 猜错过一次，
         结果把 179 个镜像全说成"没人用"。没有这个数就不给 unused，
         宁可少一句，也不给一句假话。 */
      const hasRefs = items.length > 0 && items[0] && 'refs' in items[0];
      const usedN = hasRefs ? items.filter((i) => Number(i.refs) > 0).length : null;
      return {
        total: items.length,
        unused: hasRefs ? items.length - usedN : undefined,
        /* 只给最大的 8 个：这一问的答案永远是"哪几个最占地方" */
        biggest: items
          .map((i) => ({
            sizeMB: Math.round((i.size || 0) / 1024 / 1024),
            tag: (i.repo_tags || i.repoTags || [])[0] || String(i.id || '').slice(7, 19),
            used: hasRefs ? Number(i.refs) > 0 : undefined,
          }))
          .sort((a, b) => b.sizeMB - a.sizeMB)
          .slice(0, 8),
      };
    }

    if (op === 'backup') {
      const list = data?.backups || data?.items || (Array.isArray(data) ? data : []);
      return {
        plans: list.slice(0, 8).map((b) => ({
          name: b.name, state: b.state || b.status,
          last: b.lastBackupTime || b.last_backup_time || b.updatedAt,
          schedule: b.schedule || b.cron,
          target: b.location || b.target,
        })),
        count: list.length,
        totalCount: data?.totalCount,
      };
    }

    if (op === 'users') {
      const list = Array.isArray(data) ? data : (data?.users || data?.items || []);
      return {
        users: list.map((u) => ({
          name: u.name || u.olaresId, role: u.role || u.ownerRole, state: u.state,
        })),
        count: list.length,
      };
    }

    /* version / whoami / context / catalog 原样给（本来就小） */
    return data;
  }

  /** 写一个 op（stop / resume / restart / install / upgrade / uninstall / cancel） */
  async function act(op, name) {
    const make = WRITE[op];
    if (!make) return { error: `不能执行「${op}」。能写的只有：${ACTS.join(' / ')}` };
    if (op !== 'cancel' && !name) return { error: `${op} 要给 name（应用名，例如 n8n）` };

    const p = await ensure();
    if (!p.ok) return NOAUTH();

    /* 装 / 升级要等 `--watch`，所以 exec 的超时必须**大于** watch-timeout，
       否则 CLI 还没说话就被我们掐了，报出来的是"超时"而不是"还在装"。 */
    const long = op === 'install' || op === 'upgrade';
    const r = await runAuthed(make(name), { timeout: long ? 130_000 : 60_000 });
    /* 写完必须让读缓存全失效 —— 否则下一次 apps 拿到的还是写之前那 15 秒的快照，
       用户会看到"我明明停了它，怎么还显示 running"。 */
    cache.clear();
    if (!r.ok) {
      /* 写操作也一样：身份不行就说"身份不行 + 怎么自己恢复"，
         别把 CLI 的 code 丢给模型让它自己猜（它会猜成"要不要重试一次"）。 */
      if (String(r.error.code || '').startsWith('auth')) {
        probeCache = null;
        return { ...NOAUTH(), op, name };
      }
      return { error: r.error.message, code: r.error.code, op, name };
    }
    const d = r.data || {};
    /* 实测（1.12.8，2026-10-22 线上，navidrome stop→resume）：
     *   stop   → {app, operation:"stop", status:"accepted", message:"stop requested"}
     *   resume → {app, operation:"resume", status:"accepted", message:"resume requested"}
     *   随后 `market status` 才是 {name, state:"stopped"|"resuming", version, opType, message}
     * 也就是说：**写操作自己不带终态**，`accepted` 只代表服务端收下了。
     * `--watch` 才有 finalState；没有它的时候绝不能把 accepted 说成"好了"。 */
    /* `--watch` 的语义：`.status` 判的是**这次动词**成不成功，`.finalState` 才是
       应用落在哪。没有 `--watch` 时只有 `accepted` —— 那是"服务端收下了"，不是"好了"。 */
    const status = d.status || '';
    return {
      done: true,
      op,
      name,
      status,
      finalState: d.finalState || d.state || '',
      message: d.message || '',
      /* 说人话的下一步。模型拿到这句话就不会把 accepted 说成"已经装好了"。 */
      hint: status === 'accepted'
        ? '服务端收下了这个请求，但还没结束。过几秒用 op=app 看它的状态，别当成功。'
        : undefined,
    };
  }

  return {
    bin,
    probe,
    read,
    act,
    /* 给自测用：拿真实 CLI 的原始输出喂进来，看压出来的形状对不对。
       这一层最容易错（字段名是猜的），而错了屏幕上不会报错，只会少一个数。 */
    shape,

    /**
     * 启动预热：探身份 + 把内存分母读进来。
     *
     * 探身份要 0.9 秒（起一个进程 + 读配置文件），而且 token 有效期内结论不变。
     * 放在启动时做，用户第一次提问就不用付这笔钱 —— 而"pod 起来"到
     * "用户打开页面开始问"之间通常有十几秒，正好装得下。
     *
     * 失败不抛：预热是**优化**，不是前置条件。
     */
    async warm() {
      let p = await probe();
      /* 起来就发现身份坏了，就**自己登一次** —— 这一条是"程序自己应该能 auth"的
         落点：用户不该知道 token 有过期这回事，更不该被叫去开终端。
         失败不抛：预热是优化，不是前置条件。 */
      if (!p.ok) {
        const re = await reauth();
        if (re.ok) {
          console.log(`[olares] 启动时自动恢复了身份（${re.how}）`);
          p = await probe();
        } else if (re.reason !== 'cooling') {
          console.warn('[olares] 身份用不了，且自动恢复失败：' + (authNote || re.reason || '未知'));
        }
      }
      if (!p.ok) return { ok: false, code: p.code };
      /* 只触发不等 —— 用户第一次问 apps 时如果配额还没到，readApps 会等它 */
      memTotal(false);
      return { ok: true, who: p.who, role: p.role };
    },

    /** 命令行本身在不在（镜像装没装）。给自检和启动日志用 */
    async available() {
      const r = await run(['version'], { timeout: 6000 });
      return r.ok;
    },
  };
}

function tryJSON(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 下面再试一次从第一个 { 开始 */ }
  const i = t.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(t.slice(i)); } catch { return null; }
}

function round(v) {
  if (typeof v !== 'number' || !isFinite(v)) return undefined;
  return Math.round(v * 1000) / 1000;
}
