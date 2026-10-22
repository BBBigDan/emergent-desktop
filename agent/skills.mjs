/**
 * 官方技能包（olares-cli skills）的索引与按需展开。
 *
 * 为什么不是自己写工具说明：
 *   `olares-cli` 这个二进制里编着 12 份 SKILL.md（`skills list/read/export` 就是读它们）。
 *   它们和**这个版本的 CLI 一起发**：命令树改了什么，文档改的就是什么。
 *   自己抄一遍到工具描述里，迟早会出现"文档说有这个动词、二进制里没有"——
 *   而那种错误模型查不出来，只会照着做然后拿到 unknown command。
 *
 * 为什么不在运行时调 `olares-cli skills read`：
 *   · 要 spawn（虽然 olares.mjs 是唯一出口，但每问一句都起一个进程不值）；
 *   · SKILL.md 是英文长文（5~17KB），整份塞给 7B 等于把窗口吃掉一半。
 *   所以镜像构建时 `skills export` 落成文件，运行时只读盘，并且**按需压缩**。
 *
 * 压缩的三条取舍（对着 7B 的实际表现定的）：
 *   1. 留 "When to use" 的条目 —— 它决定"这个技能该不该用"；
 *   2. 留所有 `olares-cli ...` 命令样例 —— 7B 缺的不是知识，是**动词**；
 *   3. 留 routing 表里的"症状 → 该看哪份" —— 排障的唯一入口。
 *   三样之外的正文（心智模型、长篇说明、版本演进）一律不要。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/** 镜像里 `olares-cli skills export` 的落点（见 deploy/docker/agent.Dockerfile） */
const DEFAULT_DIR = path.join(HERE, 'olares-skills');

/** 一份技能展开后的目标体积。实测 7B 在 2k 字符内会照着做，4k 之后开始只回述。 */
const MAX_DOC = 2100;

/**
 * 技能 → 我们**现在真的能执行**的 `olares` op。
 *
 * 这张表是这套设计里最重要的一格诚实：技能文档教的是 CLI 的动词表（几十个），
 * 而工具只开放了十几个读操作。不给这张映射，模型学到的动词里有九成是执行不了的 ——
 * 它会照着文档说"我来装一下"，然后调一个不存在的 op。
 *
 * 表里没有的技能（chart / publish / router / knowledge / search）就是**还没接**。
 * 那时候应该对用户说"这一块还没接"，而不是现场编一条命令。
 */
const OPS_OF = {
  'olares-market': ['apps', 'app', 'appinfo', 'catalog', 'categories'],
  'olares-dashboard': ['overview', 'usage'],
  'olares-settings': ['users', 'appcfg', 'backup'],
  'olares-cluster': ['pods', 'events', 'context'],
  'olares-doctor': ['images', 'pods', 'events'],
  'olares-shared': ['whoami', 'version'],
  'olares-files': [],
  'olares-router': [],
  'olares-search': [],
  'olares-knowledge': [],
  'olares-chart': [],
  'olares-publish': [],
};

/**
 * @param {object} o
 * @param {string} [o.dir]   技能目录（测试用）
 */
export function createSkills(o = {}) {
  const dir = o.dir || process.env.OLARES_SKILLS_DIR || DEFAULT_DIR;
  let cache = null;

  /** 读一份 SKILL.md 的 frontmatter（只认 `key: value`，够用） */
  function front(text) {
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      /* 值可能带引号、也可能被 yaml 折成多行 —— 这里只取第一行，
         完整 description 在正文里还会出现一次。 */
      v = v.replace(/^["']|["']$/g, '');
      if (k) out[k] = v;
    }
    return out;
  }

  /** 索引：名字 + 一句话 + 全文，启动时读一次 */
  async function index() {
    if (cache) return cache;
    const list = [];
    let names = [];
    try {
      names = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (e) {
      console.warn('[skills] 没有技能目录（' + dir + '）：' + e.message);
      cache = [];
      return cache;
    }
    for (const name of names.sort()) {
      try {
        const text = await fs.readFile(path.join(dir, name, 'SKILL.md'), 'utf8');
        const fm = front(text);
        list.push({
          name: fm.name || name,
          version: fm.version || '',
          /* 一句话：frontmatter 的 description 里 " — " 之前那段（域名 + 一句干什么） */
          when: String(fm.description || '').split('—')[0].trim(),
          description: String(fm.description || ''),
          text,
        });
      } catch { /* 缺一份不算故障，剩下的照用 */ }
    }
    cache = list;
    return list;
  }

  /** 给工具 schema 用的名字表（同步；索引没读完时返回空，调用方自己兜） */
  function names() {
    return (cache || []).map((s) => s.name);
  }

  /**
   * 把一份 SKILL.md 压成"能照着做"的短版。
   * 三条取舍见文件头。
   */
  function condense(s) {
    const body = s.text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const lines = body.split('\n');
    const out = [];

    /* ① When to use 的条目：决定"该不该用这份" */
    const when = [];
    let inWhen = false;
    for (const ln of lines) {
      if (/^##\s/.test(ln)) inWhen = /when to use/i.test(ln);
      else if (inWhen && /^[-*]\s+/.test(ln)) when.push(ln.replace(/^[-*]\s+/, '').slice(0, 110));
    }
    if (when.length) {
      out.push('用它的场合：');
      for (const w of when.slice(0, 6)) out.push('- ' + w);
    }

    /* ② 命令样例：7B 缺的是动词，不是解释。
       去重按"前三个词"——同一个动词的长短两种写法留一条就够。 */
    const cmds = [];
    const seen = new Set();
    for (const m of body.matchAll(/`(olares-cli [^`\n]{1,120})`/g)) {
      const c = m[1].replace(/\s+/g, ' ').trim();
      const key = c.split(' ').slice(0, 3).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      cmds.push(c);
    }
    if (cmds.length) {
      out.push('这台机器上真有的命令（原样，别改动词）：');
      for (const c of cmds.slice(0, 14)) out.push('- ' + c);
    }

    /* ③ 症状路由表：排障的入口。只在 doctor 那种"症状 → 看哪儿"的表里存在。 */
    const routes = [];
    let inTable = false;
    for (const ln of lines) {
      if (/^##\s/.test(ln)) inTable = /symptom|routing/i.test(ln);
      else if (inTable && /^\|/.test(ln) && !/^\|?\s*-{2,}/.test(ln) && !/\|\s*(Symptom|症状)\s*\|/i.test(ln)) {
        const cells = ln.split('|').map((x) => x.trim()).filter(Boolean);
        if (cells.length >= 1 && cells[0].length < 90 && !/^\[/.test(cells[0])) routes.push(cells[0]);
      }
    }
    if (routes.length) {
      out.push('症状 → 该走的诊断：');
      for (const r of routes.slice(0, 5)) out.push('- ' + r);
    }

    let text = `${s.name}\n${s.when}\n\n${out.join('\n')}`;
    if (text.length > MAX_DOC) {
      /* 截在行边界上：半句话比没有更危险（它会照着半句做） */
      text = text.slice(0, MAX_DOC);
      const nl = text.lastIndexOf('\n');
      if (nl > MAX_DOC * 0.7) text = text.slice(0, nl);
    }
    return text;
  }

  /**
   * 读一份技能。
   * @returns {Promise<{name:string, doc:string, chars:number}|{error:string}>}
   */
  async function read(name) {
    const n = String(name || '').trim();
    if (!n) return { error: '要给技能名（skill_use 的 name）' };
    const list = await index();
    const s = list.find((x) => x.name === n) || list.find((x) => x.name.endsWith(n.replace(/^olares-/, '')));
    if (!s) {
      return {
        error: `没有这份技能。可用：${list.map((x) => x.name).join(' / ')}`,
      };
    }
    const doc = condense(s);
    return { name: s.name, doc, chars: doc.length, ops: OPS_OF[s.name] || [] };
  }

  return {
    dir,
    index,
    names,
    read,
    /** 索引里的一句话（进提示词用；读不到就空串） */
    async brief() {
      const list = await index();
      if (!list.length) return '';
      return list.map((s) => `${s.name}：${s.when}`).join('\n');
    },
  };
}
