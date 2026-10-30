/**
 * 用户文件 —— 真目录，不是假列表。
 *
 * Olares 把用户的 Home 放在宿主机的
 *   /olares/rootfs/userspace/pvc-userspace-<id>-<hash>/Home
 * 里（Files 应用就是靠这个 hostPath 起家的）。Pod 把它的父目录挂成 /userspace，
 * 于是 agent 看到的 ~/Documents 和用户在 Files 里看到的是**同一批文件**。
 *
 * 三条规矩，写在这里而不是靠模型自觉：
 *   1. 一切路径先归一化，**必须落在用户空间里**（越界直接拒，不"尽力而为"）
 *   2. 删除不是真删，是挪进 ~/.trash/ —— 用户说"清掉"时他要的是"不占地方"，不是"不可恢复"
 *   3. 大目录要有上限。扫描不设限，一个 node_modules 就能把一轮对话拖死。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

const MAX_WALK = 24000;        // 一次遍历最多看这么多个条目
const TEXT_LIMIT = 64 * 1024;  // fs_read 默认返回的上限

const fmtSize = (n) => {
  if (n == null) return null;
  if (n >= 1024 ** 3) return +(n / 1024 ** 3).toFixed(1) + 'G';
  if (n >= 1024 ** 2) return +(n / 1024 ** 2).toFixed(1) + 'M';
  if (n >= 1024) return +(n / 1024).toFixed(0) + 'K';
  return n + 'B';
};

export function createFs(o = {}) {
  const root = o.root || process.env.FS_ROOT || '';
  let home = '';
  let base = '';

  /* 哪一层是"用户空间"不写死在代码里：PVC 的名字带随机后缀，
     换个集群就变了。认 pvc-userspace- 这个前缀，比记整串名字可靠。 */
  const ready = (async () => {
    if (!root) throw new Error('没有挂载用户目录（FS_ROOT 未设置）');
    const ents = await fsp.readdir(root, { withFileTypes: true });
    const pvc = ents.find((e) => e.isDirectory() && e.name.startsWith('pvc-userspace-'));
    base = pvc ? path.join(root, pvc.name) : root;
    const h = path.join(base, 'Home');
    try {
      await fsp.access(h);
      home = h;
    } catch {
      home = base;
    }
    return true;
  })();

  const pretty = (p) => {
    const rel = path.relative(home, p);
    if (!rel) return '~';
    if (rel.startsWith('..')) return p;
    return '~/' + rel;
  };

  /** 归一化 + 越界检查。所有对外方法的第一步都是它。 */
  async function inner(p) {
    await ready;
    const raw = String(p ?? '').trim() || '~';
    let s = raw;
    if (s === '~') s = home;
    else if (s.startsWith('~/')) s = path.join(home, s.slice(2));
    else if (!s.startsWith('/')) s = path.join(home, s);   // 裸名字当"在 Home 下找"
    if (s.includes('\0')) throw new Error('路径里有非法字符');

    const n = path.normalize(s);
    /* 存在就 realpath（软链要跟着解析，否则 ln -s /etc ~/x 就绕出去了）；
       不存在（写新文件）就校验父目录。 */
    let real = n;
    try {
      real = await fsp.realpath(n);
    } catch {
      try { real = path.join(await fsp.realpath(path.dirname(n)), path.basename(n)); } catch { real = n; }
    }
    const rel = path.relative(base, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`不能碰用户空间以外的路径（${raw}）`);
    }
    return real;
  }

  const stat = async (p) => {
    try { return await fsp.stat(p); } catch { return null; }
  };

  /* ── 读 ── */

  /** 目录清单。默认按体积降序 —— 用户问"这儿有什么"时，先看到的该是大的。 */
  async function list(p = '~', { limit = 40, sort = 'size' } = {}) {
    const dir = await inner(p);
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of ents.slice(0, 400)) {
      if (e.name === '.trash') continue;
      const full = path.join(dir, e.name);
      const st = await stat(full);
      out.push({
        name: e.name,
        dir: e.isDirectory(),
        size: st?.isDirectory() ? null : (st?.size ?? null),
        bytes: st?.isDirectory() ? null : (st?.size ?? 0),
        mtime: st ? new Date(st.mtime).toISOString().slice(0, 10) : null,
      });
    }
    out.sort((a, b) => (sort === 'time'
      ? String(b.mtime).localeCompare(String(a.mtime))
      : (b.bytes || 0) - (a.bytes || 0)));
    return {
      path: pretty(dir),
      total: out.length,
      entries: out.slice(0, limit).map((e) => ({ ...e, sizeText: e.size != null ? fmtSize(e.size) : null })),
      truncated: out.length > limit,
    };
  }

  /** 读文本。二进制不硬转字符串 —— 那样返回的是一堆替换字符，模型会当真。 */
  async function read(p, { maxBytes = TEXT_LIMIT, lines = 0 } = {}) {
    const f = await inner(p);
    const st = await fsp.stat(f);
    if (st.isDirectory()) return { error: `「${pretty(f)}」是目录，用 fs_list` };
    if (st.size > 8 * 1024 * 1024) {
      return { error: `文件 ${fmtSize(st.size)}，太大不读全文。用 fs_head 或指定 maxBytes`, size: st.size };
    }
    const buf = await fsp.readFile(f);
    const probe = buf.subarray(0, 4096);
    if (probe.includes(0)) return { error: '这是二进制文件（不是文本），读不了', size: st.size };
    let text = buf.toString('utf8');
    let truncated = false;
    if (text.length > maxBytes) { text = text.slice(0, maxBytes); truncated = true; }
    if (lines > 0) {
      const all = text.split('\n');
      if (all.length > lines) { text = all.slice(0, lines).join('\n'); truncated = true; }
    }
    return {
      path: pretty(f), size: st.size, sizeText: fmtSize(st.size),
      lines: text.split('\n').length, truncated, text,
    };
  }

  /** 按名字找。返回浅的在前 —— 用户找"那个 pdf"时不想先看到 node_modules 里的。 */
  async function search(q, { path: start = '~', limit = 20, depth = 5 } = {}) {
    const from = await inner(start);
    const needle = String(q || '').toLowerCase().trim();
    if (!needle) return { error: '要搜什么？给个名字片段' };
    const hits = [];
    let seen = 0;
    const walk = async (dir, d) => {
      if (d > depth || hits.length >= limit * 3 || seen > MAX_WALK) return;
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (seen++ > MAX_WALK) return;
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(needle)) {
          const st = await stat(full);
          hits.push({
            name: e.name, path: pretty(full), dir: e.isDirectory(),
            depth: d, size: st?.size ?? null, sizeText: st ? fmtSize(st.size) : null,
            mtime: st ? new Date(st.mtime).toISOString().slice(0, 10) : null,
          });
        }
        if (e.isDirectory()) await walk(full, d + 1);
      }
    };
    await walk(from, 0);
    hits.sort((a, b) => a.depth - b.depth);
    return { query: q, from: pretty(from), hits: hits.slice(0, limit), scanned: seen };
  }

  /** 体积扫描：问答"什么在吃我的盘"。depth=2 就够，太深只会把答案埋起来。 */
  async function du(p = '~', { depth = 2, limit = 8 } = {}) {
    const from = await inner(p);
    let seen = 0;
    let total = 0;
    const dirSize = async (dir, d) => {
      let sum = 0;
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
      for (const e of ents) {
        if (e.name === '.trash') continue;
        if (seen++ > MAX_WALK) return sum;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          sum += d < depth ? await dirSize(full, d + 1) : 0;
          if (d >= depth) { const st = await stat(full); sum += 0; void st; }
        } else {
          const st = await stat(full);
          sum += st?.size ?? 0;
        }
      }
      return sum;
    };

    const items = [];
    for (const e of await fsp.readdir(from, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(from, e.name);
      if (e.isDirectory()) {
        const s = await dirSize(full, 1);
        total += s;
        items.push({ name: e.name, path: pretty(full), dir: true, bytes: s, sizeText: fmtSize(s) });
      } else {
        const st = await stat(full);
        total += st?.size ?? 0;
        items.push({ name: e.name, path: pretty(full), dir: false, bytes: st?.size ?? 0, sizeText: fmtSize(st?.size ?? 0) });
      }
    }
    items.sort((a, b) => b.bytes - a.bytes);
    return {
      path: pretty(from), totalBytes: total, totalText: fmtSize(total),
      items: items.slice(0, limit), scanned: seen,
    };
  }

  /* ── 写 ── */

  async function write(p, content, { overwrite = true } = {}) {
    const f = await inner(p);
    const existed = !!(await stat(f));
    if (existed && !overwrite) return { error: `「${pretty(f)}」已经存在，要覆盖请明说` };
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, String(content ?? ''), 'utf8');
    const st = await fsp.stat(f);
    return { path: pretty(f), created: !existed, size: st.size, sizeText: fmtSize(st.size) };
  }

  /** 移动。to 是已存在的目录时，放进去（和 mv 的语义一致）。 */
  async function move(from, to) {
    const a = await inner(from);
    let b = await inner(to);
    const tb = await stat(b);
    if (tb?.isDirectory()) b = path.join(b, path.basename(a));
    if (await stat(b)) return { error: `目标「${pretty(b)}」已经存在` };
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
    return { from: pretty(a), to: pretty(b) };
  }

  /** 删除 = 挪进 ~/.trash/。<time>-<name>，撤得回来。 */
  async function trash(p) {
    const f = await inner(p);
    const st = await stat(f);
    if (!st) return { error: `没有「${pretty(f)}」这个文件` };
    const dir = path.join(home, '.trash');
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let dest = path.join(dir, `${stamp}-${path.basename(f)}`);
    let n = 1;
    while (await stat(dest)) dest = path.join(dir, `${stamp}-${n++}-${path.basename(f)}`);
    await fsp.rename(f, dest);
    return { deleted: pretty(f), movedTo: pretty(dest), bytes: st.size, sizeText: fmtSize(st.size), recoverable: true };
  }

  /**
   * 读原始字节（图片、PDF、docx 这些**不是文本**的东西）。
   *
   * 和 `read` 分开而不是加一个 `binary:true` 参数：这两个函数返回的东西
   * 形状完全不同（一个是能直接进上下文的字符串，一个是必须再解释的字节），
   * 合成一个的话，调用方总要记得"这次是不是文本"，忘一次就是把 20KB
   * 乱码塞进模型窗口。
   *
   * 上限 24MB：iPhone 一张原图也就这个量级；再大就不该整份读，
   * 而是应该先缩过（这里不做缩图，因为缩图要解码器，那是另一个依赖）。
   */
  async function bytes(p, { maxBytes = 24 * 1024 * 1024 } = {}) {
    const f = await inner(p);
    const st = await stat(f);
    if (!st) return { error: `没有「${pretty(f)}」这个文件` };
    if (st.isDirectory()) return { error: `「${pretty(f)}」是目录，用 fs_list` };
    if (st.size > maxBytes) {
      return { error: `文件 ${fmtSize(st.size)}，超过 ${fmtSize(maxBytes)}，不整份读`, size: st.size, path: pretty(f) };
    }
    return { abs: f, path: pretty(f), size: st.size, sizeText: fmtSize(st.size), buf: await fsp.readFile(f) };
  }

  /* `resolve` 只给需要自己 stat/open 的调用方用（比如文档抽取要按扩展名分派）。
     它仍然过同一道越界检查 —— 导出 inner 会让这个边界形同虚设。 */
  async function resolve(p) {
    const f = await inner(p);
    return { abs: f, path: pretty(f) };
  }

  return {
    kind: 'fs',
    info: () => `${home}`,
    home: () => home,
    list, read, search, du, write, move, trash, bytes, resolve, pretty,
  };
}
