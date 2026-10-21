/**
 * 工具仓 —— 让 agent 自己造工具，造出来的东西用户在 Files 里看得见、改得动、删得掉。
 *
 * 形态（文档 §5 原样）：
 *   ~/Agent/tools/<name>/manifest.json   —— 叫什么、要什么参数、要碰什么（needs）
 *   ~/Agent/tools/<name>/run.mjs         —— 脚本，node 内建模块，不许装包
 *   ~/Agent/skills/<slug>.md             —— "该怎么做"，会进系统提示
 *   ~/Agent/audit/tools-YYYY-MM-DD.jsonl —— 每次调用一行
 *
 * 三个不由模型决定的点：
 *   1. **草稿不会被当成工具。** write 出来的东西 status=draft，模型看得到自己写了什么，
 *      但下一轮的工具表里没有它 —— 只有 keep（用户批准过）之后才注册。
 *   2. **needs 由 guard.mjs 在子进程里强制执行**，不靠脚本自觉。
 *   3. **每次调用都进审计。** 自造工具是这台机器上唯一"行为不预先确定"的东西，
 *      没有一行日志，出了问题连"它昨天跑过什么"都答不上来。
 *
 * 脚本的输出契约只有一条：**最后一行 stdout 是一段 JSON**。就这么一条 ——
 * 让它写回调注册、写文件、写退出码，7B 会写出十种不同的东西，然后一切都对不上。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveHome, localDir } from '../sources/home.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* --import 收的是模块说明符，Windows 的盘符路径会被当成协议头，必须给 file:// URL */
const GUARD = pathToFileURL(path.join(HERE, 'guard.mjs')).href;

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_CODE = 8000;   // 40~60 行。再长不是功能多，是没想清楚，而且会被截断
const MAX_PARAMS = 6;
const OUT_CAP = 32 * 1024;          // 单次调用留给模型的输出上限
const RUN_TIMEOUT = 20000;

/* 这些名字是内置工具，自造工具占用会让分发路由串味（同一个名字两套实现）。 */
const RESERVED = new Set(['sys_status', 'app_list', 'fs_scan', 'fs_list', 'fs_read', 'fs_search',
  'fs_write', 'fs_move', 'fs_delete', 'logs_tail', 'k8s_get', 'k8s_restart', 'mem_trim',
  'memory_recall', 'memory_stats', 'memory_forget', 'scene_show', 'scene_ask', 'scene_set',
  'scene_patch', 'scene_pulse', 'scene_transition', 'surface_render', 'surface_close', 'draw',
  'face', 'draw_stop', 'tool_write', 'tool_code', 'tool_try', 'tool_keep', 'tool_list', 'skill_save', 'web_get']);

/* 带毫秒："最近动过的草稿"要靠它排序，秒级精度会在同一秒里的两次写之间分不出先后 */
const nowIso = () => new Date().toISOString();
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function createForge(o = {}) {
  const enabled = o.enabled !== false && process.env.TOOLS !== '0';
  let home = '';
  let root = '';          // ~/Agent
  let toolsDir = '';
  let skillsDir = '';
  let auditDir = '';
  const cache = new Map();
  let booted = null;

  async function init() {
    if (booted) return booted;
    booted = (async () => {
      home = o.home || await resolveHome();
      root = home ? path.join(home, 'Agent') : localDir('.tools');
      toolsDir = path.join(root, 'tools');
      skillsDir = path.join(root, 'skills');
      auditDir = path.join(root, 'audit');
      for (const d of [toolsDir, skillsDir, auditDir]) {
        await fsp.mkdir(d, { recursive: true }).catch(() => {});
      }
      await scan();
      return true;
    })().catch((e) => {
      console.warn('[forge] 初始化失败，自造工具停用：' + e.message);
      return false;
    });
    return booted;
  }

  /* ── 清单 ── */

  function normNeeds(n) {
    const net = (Array.isArray(n?.net) ? n.net : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
    const fs = (Array.isArray(n?.fs) ? n.fs : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    return { net, fs };
  }

  /** 参数表 → JSON Schema。只收 string / number / boolean 三种：7B 写不出嵌套结构。 */
  function paramSchema(params) {
    const p = params && typeof params === 'object' ? params : {};
    const props = {};
    const required = [];
    for (const [k, v] of Object.entries(p).slice(0, MAX_PARAMS)) {
      if (!NAME_RE.test(k)) continue;
      const type = ['string', 'number', 'boolean'].includes(v?.type) ? v.type : 'string';
      props[k] = { type, description: String(v?.description || v?.desc || k).slice(0, 120) };
      if (v?.required) required.push(k);
    }
    const s = { type: 'object', properties: props, additionalProperties: false };
    if (required.length) s.required = required;
    return s;
  }

  function invalidNeeds(needs) {
    for (const p of needs.fs) {
      /* 三种合法写法：~/…、/…、C:…（Windows 上调试用）。
         其它一律拒 —— "app 目录"这种名字到运行时也没法判断。 */
      const absish = p === '~' || p.startsWith('~/') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
      if (!absish) return `needs.fs 里的「${p}」要么是 ~/... 要么是绝对路径`;
      const abs = p.startsWith('~') ? path.join(home || '/tmp', p.slice(1)) : p;
      const norm = abs.replace(/[\\/]+$/, '').replace(/\\/g, '/');
      if (norm === '' || norm === '/' || /^[A-Za-z]:$/.test(norm)) {
        return `needs.fs 不能声明整个盘符/根目录`;
      }
      if (['/etc', '/proc', '/sys', '/dev', '/root', '/var', '/usr', '/bin'].includes(norm.toLowerCase())) {
        return `needs.fs 不能声明「${p}」—— 那是整个系统目录，等于没声明`;
      }
    }
    for (const h of needs.net) {
      if (!/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(h)) return `needs.net 里的「${h}」不像一个域名`;
    }
    return '';
  }

  async function scan() {
    cache.clear();
    let ents = [];
    try { ents = await fsp.readdir(toolsDir, { withFileTypes: true }); } catch { return cache; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const mf = path.join(toolsDir, e.name, 'manifest.json');
      try {
        const m = JSON.parse(await fsp.readFile(mf, 'utf8'));
        if (!NAME_RE.test(m?.name) || m.name !== e.name) continue;
        m.needs = normNeeds(m.needs);
        m.params = m.params && typeof m.params === 'object' ? m.params : {};
        m.level = m.level === 'safe' ? 'safe' : 'confirm';
        m.status = m.status === 'published' ? 'published' : 'draft';
        m.dir = path.join(toolsDir, e.name);
        cache.set(m.name, m);
      } catch { /* 半个清单（写一半就崩了）就当没这个工具 */ }
    }
    return cache;
  }

  const published = () => [...cache.values()].filter((m) => m.status === 'published');

  /* ── 写 ── */

  /** 代码体检。write 和 setCode 共用 —— 两条入口，一套规矩。 */
  function checkCode(src) {
    const code = String(src || '');
    if (!code.trim()) return { error: 'code 是空的' };
    if (code.length > MAX_CODE) return { error: `代码太长（${code.length} 字 > ${MAX_CODE}），拆小一点` };
    if (code.includes('EM_TOOL_NEEDS')) return { error: '不要碰 EM_TOOL_NEEDS，那是护栏的输入' };
    if (/\bchild_process\b|\bexecSync\b|\bspawnSync\b/.test(code)) {
      return { error: '自造工具里不能用子进程（护栏会直接拒绝）。用 fetch / fs 解决' };
    }
    return { code };
  }

  /**
   * 落一份草稿。**不注册** —— 工具表里仍然没有它。
   * 更新一个已发布的工具时：旧代码归档到 history/，version +1，状态退回 draft
   * （改了代码就得重新看一眼，这是"首次运行看代码"的自然延伸）。
   */
  async function write({ name, description, params, level, needs, net, fs, code }) {
    await init();
    const n = String(name || '').trim();
    if (!NAME_RE.test(n)) return { ok: false, error: `工具名只能用 a-z 0-9 _，2~41 个字（收到「${n}」）` };
    if (RESERVED.has(n)) return { ok: false, error: `「${n}」是内置工具的名字，换一个` };
    const desc = String(description || '').trim();
    if (desc.length < 4) return { ok: false, error: 'description 要有，模型以后靠它决定什么时候用' };
    /* code 可以留空：7B 把一整段脚本塞进 JSON 参数里并不可靠（实测它会**静默地**
       只发 name / description / params，code 根本不在里面，重试十次都一样）。
       拆成两步之后，最难的那一步只剩一个字符串字段，成功率完全不一样。
       代码由 tool_code 补。 */
    let src = String(code || '');
    if (src.trim()) {
      const c = checkCode(src);
      if (c.error) return { ok: false, error: c.error };
      src = c.code;
    }

    /* 扁平写法 wins：`net: "127.0.0.1:7899,api.foo.com"`。
       7B 对"嵌套对象里的数组"很不稳（实测六次 tool_write，六次 needs.net 都是空的，
       哪怕刚被明确告知要加 127.0.0.1:7899）。一个逗号分隔的字符串它填得住。 */
    const flat = { net: [], fs: [] };
    if (typeof net === 'string' && net.trim()) {
      flat.net = net.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    }
    if (typeof fs === 'string' && fs.trim()) {
      flat.fs = fs.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    }
    let nd = normNeeds({
      net: [...(needs?.net || []), ...flat.net],
      fs: [...(needs?.fs || []), ...flat.fs],
    });
    /* 改一个已有工具却没提 needs：**继承上一次的**。
       不继承的话，模型每次"补一句说明"都会把授权清空，然后又撞护栏 —— 死循环。 */
    let inherited = false;
    if (!nd.net.length && !nd.fs.length && cache.has(n)) {
      const prev = cache.get(n);
      if (prev.needs && (prev.needs.net.length || prev.needs.fs.length)) {
        nd = { net: [...prev.needs.net], fs: [...prev.needs.fs] };
        inherited = true;
      }
    }
    const bad = invalidNeeds(nd);
    if (bad) return { ok: false, error: bad };

    const dir = path.join(toolsDir, n);
    const prev = cache.get(n);
    let version = 1;
    if (prev) {
      version = (prev.version || 1) + 1;
      /* 归档旧版本。文档说"每个工具带 version 可回滚" —— 回滚的前提是旧代码还在。 */
      const hist = path.join(dir, 'history');
      await fsp.mkdir(hist, { recursive: true }).catch(() => {});
      const old = path.join(dir, prev.entry || 'run.mjs');
      await fsp.copyFile(old, path.join(hist, `${prev.entry || 'run.mjs'}.v${prev.version || 1}`)).catch(() => {});
    } else {
      await fsp.mkdir(dir, { recursive: true });
    }

    /* ESM 还是 CommonJS？
     *
     * 7B 写脚本时第一反应是 `const fetch = require('node-fetch')` —— 它见过的
     * 例子大多是 CJS。在 .mjs 里那一行直接报 "require is not defined"，
     * 而模型从错误里学到的往往是"要装依赖"，于是越修越远。
     * 与其跟模型较劲，不如认它：只要它写的是 require 风格的同步代码，
     * 就用 .cjs 落盘 —— 全局 fetch 在 CJS 里一样有。
     * 有顶层 await 时不能用 CJS，那种情况仍走 .mjs（ESM 的特权）。 */
    const cjs = src ? (/(^|[^.\w])require\s*\(/.test(src)
      && !/^\s*(?:await|const\s+\w+\s*=\s*await)/m.test(src)) : false;
    const entry = cjs ? 'run.cjs' : 'run.mjs';
    if (src) await fsp.writeFile(path.join(dir, entry), src, 'utf8');

    const now = nowIso();
    const manifest = {
      name: n,
      description: desc.slice(0, 200),
      params: params && typeof params === 'object' ? params : {},
      entry,
      runtime: 'node',
      level: level === 'safe' ? 'safe' : 'confirm',
      needs: nd,
      version,
      status: 'draft',
      createdAt: prev?.createdAt || now,
      updatedAt: now,
      author: 'agent',
    };
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await scan();

    const tips = [];
    if (src && !/console\.log|stdout\.write/.test(src)) tips.push('脚本里没有 console.log —— 结果要靠最后一行 JSON 交出来');
    if (src && !nd.net.length && /fetch\(|https?\.request/.test(src)) tips.push('代码里要发请求，但 needs.net 是空的，跑起来会被护栏拒');

    return {
      ok: true,
      name: n,
      dir: `~/Agent/tools/${n}`,
      version,
      status: 'draft',
      needs: nd,
      ...(inherited ? { needsInherited: true } : {}),
      lines: src ? src.split('\n').length : 0,
      ...(src ? {} : { missing: '还没有代码。下一步用 tool_code 把脚本贴上来' }),
      ...(tips.length ? { tips } : {}),
      next: src
        ? '用 tool_try 跑一次看看（会先问你一次），跑通了再 tool_keep'
        : '先用 tool_code 把脚本写进去（name + code 两个字段），再 tool_try',
    };
  }

  /**
   * 单独贴代码。**这是给 7B 走的窄门**：一个工具、一个字符串参数，
   * 不用它在同一个 JSON 里同时写对 params 和三十行脚本。
   * （实测：让它一次写全，它会静默地只发 name/description/params，
   *  code 根本不在参数里，重试十次都一样。）
   * 已发布的工具改了代码就退回 draft —— 改了就得重新过一次门。
   */
  async function setCode(name, code) {
    await init();
    const m = cache.get(String(name || ''));
    if (!m) return { ok: false, error: `还没有叫「${name}」的工具。先用 tool_write 起个头（名字 / 说明 / 参数）` };
    const c = checkCode(code);
    if (c.error) return { ok: false, error: c.error };
    const cjs = /(^|[^.\w])require\s*\(/.test(c.code)
      && !/^\s*(?:await|const\s+\w+\s*=\s*await)/m.test(c.code);
    const entry = cjs ? 'run.cjs' : 'run.mjs';
    if (m.entry && m.entry !== entry) await fsp.unlink(path.join(m.dir, m.entry)).catch(() => {});
    await fsp.writeFile(path.join(m.dir, entry), c.code, 'utf8');
    m.entry = entry;
    m.updatedAt = nowIso();
    if (m.status === 'published') m.status = 'draft';
    const { dir, ...clean } = m;
    await fsp.writeFile(path.join(m.dir, 'manifest.json'), JSON.stringify(clean, null, 2) + '\n', 'utf8');
    await scan();
    /* 代码要发请求而 needs.net 是空的 —— 最容易忘的一步，而且要等到试跑才炸。
       在这里就说，比让护栏在子进程里拒绝好：护栏那句话是给模型看的，
       这一句是"顺手把 manifest 补上"的机会。 */
    const warns = [];
    if (/fetch\(|https?\.request/.test(c.code) && !m.needs.net.length) {
      warns.push('代码要发请求，但 needs.net 还是空的 —— 试跑会被护栏拒。'
        + '先用 tool_write 把要访问的域名补进 needs.net');
    }
    return {
      ok: true, name: m.name, entry, lines: c.code.split('\n').length, status: m.status,
      ...(warns.length ? { warn: warns.join('；') } : {}),
      next: '用 tool_try 跑一次（会先问用户一次），跑通了再 tool_keep',
    };
  }

  /** 注册。用户批准过这一步，之后的每一轮工具表里都有它。 */
  async function keep(name) {
    await init();
    const m = cache.get(String(name || ''));
    if (!m) return { ok: false, error: `没有叫「${name}」的工具` };
    if (m.status === 'published') return { ok: true, already: true, name: m.name, version: m.version };
    /* 装上之前，把"从代码里读出来的域名"落进 manifest —— 以后再跑就不用推断了，
       而且用户翻 ~/Agent/tools 的时候能看到它要连哪儿。 */
    try {
      const extra = (await inferred(m.name)).filter((h) => !m.needs.net.includes(h));
      if (extra.length) m.needs = { ...m.needs, net: [...m.needs.net, ...extra] };
    } catch { /* 推不出来就照原样 */ }
    m.status = 'published';
    m.updatedAt = nowIso();
    m.publishedAt = m.updatedAt;
    const { dir, ...clean } = m;
    await fsp.writeFile(path.join(m.dir, 'manifest.json'), JSON.stringify(clean, null, 2) + '\n', 'utf8');
    await scan();
    return { ok: true, name: m.name, version: m.version, level: m.level, needs: m.needs };
  }

  /* ── 跑 ── */

  function runChild(m, args, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(process.execPath, ['--import', GUARD, m.entry || 'run.mjs'], {
        cwd: m.dir,
        env: {
          /* 环境变量只给这三样。给全了就等于把集群令牌、模型 key 一起递给
             一段模型写的脚本 —— 而那正是"自造工具藏后门"最省事的入口。 */
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: home || m.dir,
          TZ: process.env.TZ || 'Asia/Shanghai',
          /* needs 必须递进去 —— 忘了这一行，护栏拿到的是空清单，
             于是**什么都没声明**的工具也能跑（自测里当场抓到）。 */
          EM_TOOL_NEEDS: JSON.stringify(m.needs || {}),
          EM_TOOL_ARGS: JSON.stringify(args || {}),
          NODE_OPTIONS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      }, Math.min(60000, Math.max(500, timeoutMs || m.timeout || RUN_TIMEOUT)));

      child.stdout.on('data', (d) => { if (out.length < OUT_CAP * 4) out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { if (err.length < OUT_CAP) err += d.toString('utf8'); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, out, err: err + String(e?.message || e), ms: Date.now() - t0, killed });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err, ms: Date.now() - t0, killed });
      });
    });
  }

  /** stdout 的最后一行 JSON。前面可以有日志，最后一行必须是结果。 */
  function lastJson(s) {
    const lines = String(s || '').trim().split('\n');
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 6; i--) {
      const t = lines[i].trim();
      if (!t.startsWith('{') && !t.startsWith('[')) continue;
      try { return JSON.parse(t); } catch { /* 继续往上找 */ }
    }
    return null;
  }

  /** 调一次。审批在 server 那层，这里只管跑和记账。 */
  async function call(name, args, opt = {}) {
    await init();
    const m = cache.get(String(name || ''));
    if (!m) return { ok: false, error: `没有叫「${name}」的工具。先 tool_list 看看有哪些` };
    if (opt.publishedOnly && m.status !== 'published') {
      return { ok: false, error: `「${name}」还是草稿，先用 tool_try 试跑、tool_keep 装起来` };
    }
    /* 生效的 allowlist = manifest 里写的 + 从代码里读出来的（仅 confirm 层）。
       合并只在**这一行**发生：guard 只认一个清单，读的人不用去猜它从哪来。 */
    let allow = m.needs || { net: [], fs: [] };
    if (m.level !== 'safe') {
      try {
        const src = await fsp.readFile(path.join(m.dir, m.entry || 'run.mjs'), 'utf8');
        const extra = inferNeeds(src).filter((h) => !allow.net.includes(h));
        if (extra.length) allow = { ...allow, net: [...allow.net, ...extra] };
      } catch { /* 没代码就没得推 */ }
    }
    const r = await runChild({ ...m, needs: allow }, args || {}, opt.timeout);
    const json = lastJson(r.out);
    const rec = {
      ts: nowIso(), tool: name, args: args || {}, ms: r.ms, exit: r.code,
      ok: !!(json?.ok ?? (r.code === 0)), killed: r.killed,
    };
    if (!rec.ok) rec.err = String(json?.error || r.err || '').slice(0, 300);

    audit(rec);

    if (r.killed) {
      return { ok: false, error: `「${name}」跑了 ${Math.round(r.ms / 1000)} 秒还没结束，被杀掉了。缩短它` };
    }
    if (json && typeof json === 'object') {
      /* 脚本自己给了结论：以它为准。它说 ok:false 就照实说，别替它圆。 */
      return { ok: json.ok !== false, ...json, ms: r.ms };
    }
    if (r.code !== 0) {
      return { ok: false, error: `退出码 ${r.code}：${(r.err || r.out || '(没有输出)').slice(0, 800)}`, ms: r.ms };
    }
    /* 没给 JSON 但也没报错：把输出当文本交出去，并推它一把改写法。 */
    return {
      ok: true,
      text: String(r.out || '').trim().slice(0, 2000) || '(没有输出)',
      note: '脚本没有打印 JSON。约定是最后一行 stdout 输出 {"ok":true,...}',
      ms: r.ms,
    };
  }

  /* ── 看代码 ── */

  /**
   * 从脚本里读它要访问哪些域名。
   *
   * 为什么不让模型declare：实测让它在 manifest 里填 `needs.net`，十次有十次是空的
   * ——连"我刚跟你说要写 127.0.0.1:7899"都不写。但**代码它写得出来**。
   * 于是分工改成：它写代码，我们从代码里读出域名，**摆到审批卡上给用户看**。
   * 安全强度没变（用户仍然是在知道"它会连哪"的前提下点的允许），
   * 但少了一个 7B 填不对的字段。
   *
   * 只对 `level: confirm` 生效（每次执行都要点头）。声明成 safe 的工具
   * 没有这道门，就只认 manifest 里写死的 needs。
   */
  function inferNeeds(code) {
    const hosts = new Set();
    const re = /https?:\/\/(\[[^\]]+\]|[A-Za-z0-9][A-Za-z0-9.\-]*)(?::(\d+))?/g;
    let m;
    while ((m = re.exec(String(code || '')))) {
      hosts.add(m[2] ? `${m[1]}:${m[2]}` : m[1]);
    }
    return [...hosts].slice(0, 8);
  }

  /** 读某个工具的代码并推断域名（草稿也行）。 */
  async function inferred(name) {
    const c = await code(name);
    if (!c) return [];
    return inferNeeds(c.code);
  }


  /**
   * 读一份工具的源码，给"首次运行必须看代码"那道门用。
   *
   * 这件事**不能交给模型**（"请把代码贴给用户看"）—— 它可以贴一份删过的版本。
   * 审批那一刻，系统自己去磁盘上读它将要执行的那份字节。
   */
  async function code(name) {
    await init();
    const m = cache.get(String(name || ''));
    if (!m) return null;
    try {
      const src = await fsp.readFile(path.join(m.dir, m.entry || 'run.mjs'), 'utf8');
      return { name: m.name, version: m.version, status: m.status, needs: m.needs, code: src };
    } catch {
      return null;
    }
  }

  /* ── 审计 ── */
  function audit(rec) {
    if (!auditDir) return;
    const day = new Date().toISOString().slice(0, 10);
    fsp.appendFile(path.join(auditDir, `tools-${day}.jsonl`), JSON.stringify(rec) + '\n', 'utf8')
      .catch(() => { /* 记不了账不该让工具失败 */ });
  }

  /* ── 技能 ── */

  /** 解析 `---` 头：name / when。头可以是普通几行 `name: x`。 */
  function parseSkill(file, text) {
    const t = String(text || '');
    const head = {};
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
    if (m) {
      for (const line of m[1].split('\n')) {
        const kv = /^([a-zA-Z_]+)\s*[:：]\s*(.+)$/.exec(line.trim());
        if (kv) head[kv[1]] = kv[2].trim();
      }
    }
    const body = (m ? t.slice(m[0].length) : t).trim();
    return {
      slug: path.basename(file, '.md'),
      name: head.name || path.basename(file, '.md'),
      when: head.when || '',
      body,
      file: `~/Agent/skills/${path.basename(file)}`,
    };
  }

  async function skills() {
    await init();
    let ents = [];
    try { ents = await fsp.readdir(skillsDir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      try {
        out.push(parseSkill(e.name, await fsp.readFile(path.join(skillsDir, e.name), 'utf8')));
      } catch { /* 坏文件跳过 */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 进系统提示的那一段。
   *
   * 7B 的窗口很小，所以**不是全塞**：小技能（正文 ≤900 字）给全文，
   * 大的只给"什么时候用"，正文等它真的要做时再说（`skill_save` 会覆盖旧的）。
   */
  async function skillsForPrompt(maxChars = 2200) {
    const list = await skills();
    if (!list.length) return '';
    const lines = ['## 你学会的做法（用户教过，或你自己总结的）'];
    let used = 0;
    for (const s of list.slice(0, 6)) {
      const head = `- **${s.name}**${s.when ? `：${s.when}` : ''}`;
      if (used + head.length > maxChars) break;
      lines.push(head);
      used += head.length;
      if (s.body && s.body.length <= 900 && used + s.body.length <= maxChars) {
        lines.push(...s.body.split('\n').map((l) => '  ' + l));
        used += s.body.length;
      } else if (s.body) {
        lines.push(`  （正文 ${s.body.length} 字，在 ${s.file}）`);
      }
    }
    return lines.join('\n');
  }

  async function saveSkill({ name, when, body }) {
    await init();
    const n = String(name || '').trim();
    if (n.length < 2) return { ok: false, error: '给它起个名字' };
    const b = String(body || '').trim();
    if (b.length < 10) return { ok: false, error: '正文太短了，写清楚步骤' };
    const sl = slug(n) || 'skill';
    const file = path.join(skillsDir, `${sl}.md`);
    const text = `---\nname: ${n}\nwhen: ${String(when || '').replace(/\n/g, ' ').slice(0, 120)}\n---\n\n${b}\n`;
    await fsp.writeFile(file, text, 'utf8');
    return { ok: true, name: n, file: `~/Agent/skills/${sl}.md`, chars: b.length };
  }

  /* ── 给工具层看的形状 ── */

  /** 已注册的工具 → makeTools 能直接吃的一串定义 */
  function registered() {
    return published().map((m) => ({
      name: m.name,
      description: m.description,
      level: m.level,
      params: m.params,
      schema: paramSchema(m.params),
      needs: m.needs,
      version: m.version,
    }));
  }

  async function list() {
    await init();
    return [...cache.values()].map((m) => ({
      name: m.name,
      description: m.description,
      status: m.status,
      level: m.level,
      needs: m.needs,
      version: m.version,
      updatedAt: m.updatedAt,
      hasCode: true,
    })).sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'published' ? -1 : 1));
  }

  return {
    init, scan, write, setCode, keep, call, code, inferred, inferNeeds, list, registered, skills, skillsForPrompt, saveSkill,
    get home() { return home; },
    get toolsDir() { return toolsDir; },
  };
}
