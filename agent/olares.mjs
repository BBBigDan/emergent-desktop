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

import { execFile } from 'node:child_process';

const BIN = process.env.OLARES_CLI || 'olares-cli';

/* 读操作白名单：op → argv。**不带 `-o json`**，统一在 run() 里加。 */
const READ = {
  /* 应用清单：装了什么、什么版本、从哪个源来的、什么状态。
     比原来自己从 k8s 拼的 app_list 多出 version / source / categories。 */
  apps: () => ['market', 'list', '--mine'],
  /* 市场里有什么（可装什么）。catalog 是全量，慢一些。 */
  catalog: () => ['market', 'list'],
  /* 单个应用的生命周期状态（含 entranceStatuses） */
  app: (name) => ['market', 'status', name],
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
};

/** 需要 `name` 的 op */
const NEED_NAME = new Set(['app', 'appcfg']);

/** 可用的 op 列表（工具 schema 的 enum 从这里来，别在两个地方各写一份） */
export const OPS = Object.keys(READ);

/** 给模型看的 op 说明。写在这里而不是提示词里：工具 schema 离调用更近。 */
export const OP_DOC = [
  'apps=装了哪些应用(版本/状态/来源)',
  'app=某个应用的状态(name)',
  'catalog=市场有什么可装',
  'overview=整机负载(CPU/内存/磁盘/网络)',
  'usage=哪个应用吃资源',
  'version=系统版本',
  'whoami=当前身份',
  'users=用户列表',
  'appcfg=应用配置与入口(name)',
  'context=当前 K8s 视野',
].join(' · ');

/**
 * @param {object} o
 * @param {string} [o.bin]  覆盖二进制路径（测试用）
 * @param {number} [o.ttl]  `profile list` 结果的缓存时长
 */
export function createOlares(o = {}) {
  const bin = o.bin || BIN;
  const ttl = o.ttl ?? 30_000;

  let probeCache = null;   // { at, ok, code, message, who }
  let inflight = null;     // 同一刻只探一次（一轮里四个工具同时调很常见）

  /**
   * 跑一次。**argv 必须是白名单里拼好的数组**，不做字符串拼接。
   * @returns {{ok:boolean, data?:any, error?:{code:string,message:string}, ms:number, stderr?:string}}
   */
  function run(argv, { timeout = 25_000 } = {}) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      execFile(bin, [...argv, '-o', 'json'], {
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
        const ok = !!cur && String(cur.status || '').includes('logged');
        out = {
          at: now,
          ok,
          who: cur?.name || cur?.olaresId || '',
          role: cur?.ownerRole || cur?.role || '',
          code: ok ? '' : (list.length ? 'auth_not_logged_in' : 'auth_no_profile'),
          message: ok ? '' : '这台机器还没有授权过 Olares 身份',
        };
      }
      probeCache = out;
      inflight = null;
      return out;
    })();
    return inflight;
  }

  const NOAUTH = () => ({
    error: '还没授权 Olares 身份，查不了系统层（不是"没有数据"）。'
      + '告诉用户去授权一次：在安装时加 --login，或者在终端跑 '
      + '`olares-cli profile login --olares-id <你的 Olares ID>`。'
      + '在那之前，机器负载和文件仍然能查（走的是另一条路）。',
    needAuth: true,
  });

  /**
   * 读一个 op。
   * @param {string} op
   * @param {string} [name]
   */
  async function read(op, name) {
    const make = READ[op];
    if (!make) return { error: `不认识的 op：${op}。可用：${Object.keys(READ).join(' / ')}` };
    if (NEED_NAME.has(op) && !name) return { error: `${op} 要给 name（应用名）` };

    const p = await probe();
    if (!p.ok) return NOAUTH();

    /* apps 要三份数据才够用：清单（版本/来源）、占用（cpu/内存）、总量（算占比）。
       三个 exec **并行**跑，总耗时约等于最慢那个（~2s）；串行要 5s 以上。
       为什么非要合并：模型画仪表要 0~1 的占比，只有清单时会拿 0 顶上去 ——
       屏幕上就是"n8n / navidrome / qbittorrent 全 0%"，那是**假数**。 */
    if (op === 'apps') return await readApps();

    const r = await run(make(name));
    if (!r.ok) {
      /* 认证类错误要说得比 CLI 原文更像人话，并且**提示可恢复** */
      if (r.error.code?.startsWith('auth_')) {
        probeCache = null;      // 让下一次重新探
        return { error: `Olares 那边不认这个身份了（${r.error.code}）。可能是 token 过期或被撤销，需要重新授权一次。` };
      }
      return { error: r.error.message, code: r.error.code };
    }
    return shape(op, r.data, name);
  }

  /** apps：清单 + 占用 + 总量，合成一份 */
  async function readApps() {
    const [mk, ap, ov] = await Promise.all([
      run(['market', 'list', '--mine']),
      run(['dashboard', 'applications']),
      run(['dashboard', 'overview'], { timeout: 30_000 }),
    ]);
    if (!mk.ok) {
      if (mk.error.code?.startsWith('auth_')) return { error: `Olares 不认这个身份了（${mk.error.code}），要重新授权。` };
      return { error: mk.error.message };
    }
    const totalBytes = (ov.ok ? (ov.data?.sections?.physical?.items || []) : [])
      .find((x) => x?.raw?.metric === 'memory')?.raw?.total || null;
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
        entrances: (data?.entrances || []).map((e) => ({
          name: e.name, url: e.url || e.host, state: e.state, authLevel: e.authLevel,
        })),
        raw: undefined,
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

  return {
    bin,
    probe,
    read,
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
