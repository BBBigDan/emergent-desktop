/**
 * 错题本（roadmap ④「从你纠正过它里学」）
 *
 * 为什么要有这个东西：抽取器抽的是**事实**（"这台机器装了 n8n"），
 * 不抽**判断错误**（"它把 Jellyfin 当成了 Navidrome"）。所以用户当场纠正、
 * 它当场认错，下一次同类问题照错不误 —— 纠正信息根本没进任何地方。
 *
 * ── 三条设计判据 ──
 *
 * 1. **不靠模型自省，靠一句话的句式。** 判据是"用户紧接着否定上一句"
 *    （「不对」「不是」「我说的是」「搞错了」打头）。这条信号很硬：
 *    人纠正机器时几乎都这么开口，而机器自己判断"我是不是错了"从来不可靠。
 *
 * 2. **记的是原话，不是总结。** `wrong` = 它上一轮说的那句，
 *    `right` = 用户纠正的原话。让 7B 去总结"我错在哪"，它会总结成一句
 *    "我需要更仔细地确认信息" —— 那种东西进上下文只会让它更啰嗦，不会让它更对。
 *    原话是可以照抄的：下次它看到"我说过 X，用户纠正 Y"，就不会再说 X。
 *
 * 3. **错题会过期，也会被推翻。** 环境变了，当年的教训就变成误导：
 *    90 天前的错题不再注入；同一个场景被纠正第二次，说明上一次没吃进去，
 *    这时记 `repeat`（在提示里说"这个坑踩过两次"比说一次更有分量）。
 *
 * 存哪儿：`agent/config/mistakes.json`（和 settings/tasks 同一个挂载点，
 * pod 重建不丢）。**不塞进记忆图**：错题的检索方式（按场景词命中，排最前）
 * 和事实不一样，混在一起会把"用户纠正过我"降级成一条普通记忆，
 * 而它必须在每次同类提问里优先出现。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 超过这么多天的错题不再注入（环境变了，教训会变成误导） */
const FRESH_DAYS = 90;
/** 一次最多注入几条 —— 多了会把它压成"处处小心"的复读机 */
const MAX_INJECT = 2;
/** 同一个场景最多留几条（防止一个坑记住十条） */
const PER_SCENE = 3;

/**
 * 这句话是在纠正上一句吗。
 *
 * 只在**开头**认：中文里"不对"可以出现在句尾当语气（"这样不对吧"），
 * 也可以出现在句中被引用（"他说不对"）。打头那几个字才是纠正。
 *
 * 反例（不能中枪）：
 *   「不是所有应用都在跑」—— 开头就是"不是"，但它是**在陈述**，不是纠正。
 *   所以除了打头的否定词，还要有"指向上一句话"的东西：我说的是 / 你弄错 / 搞错 /
 *   是 X 不是 Y / 应该。只看"不是"两个字会误伤太多正常句子。
 */
const NEG_HEAD = /^(不对|错了|搞错|弄错|说错|答错|不准确|纠正一下|纠正下|我说的是|我说的不是|不是这个|并不是|其实是|那不对|你错了)/;
/** 指向"上一句"的强标记：单独出现就够了 */
const POINTS_BACK = /(我说的是|我说的不是|你(说|弄|搞|答)错|不是这个|别搞错|纠正一下|我讲的|我问的是)/;

export function looksLikeCorrection(text) {
  const t = String(text || '').trim().replace(/^[「"'\s]+/, '');
  if (!t) return false;
  const head = t.slice(0, 12);
  if (POINTS_BACK.test(head)) return true;
  if (!NEG_HEAD.test(head)) return false;
  /* 打头的否定词 + 要么句子不长（"不对，是 Jellyfin"），要么带"是…不是…"的对照。
     长句子里的"不是"多半是在讲道理（"不是所有 pod 都会重启"）。 */
  if (t.length <= 24) return true;
  return /(是|对的是|应该是)[^，。]{1,20}不是|不是[^，。]{1,20}(而是|是)/.test(t);
}

/**
 * 从一句纠正里抽"场景词"。
 *
 * 只抽**具体的名字**：拉丁词（应用名/文件名/命令）和引号里的中文。
 * 中文自由词不抽 —— 两个汉字的排列组合会让"硬盘"和"盘快"互相命中，
 * 错题就会在无关的问题里跳出来，那种"提醒"只是在添乱。
 */
export function sceneOf(text) {
  const t = String(text || '');
  const out = new Set();
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9._-]{1,}/g)) {
    const w = m[0].toLowerCase().replace(/[._-]+$/, '');
    if (w.length >= 2) out.add(w);
  }
  /* 端口号、设备号这类纯数字也要留：它是"同一个场景、不同的纠正"里
     唯一能分开两条东西的字段（"端口是 5679" 和 "端口是 6000" 是两个坑）。 */
  for (const m of t.matchAll(/\b\d{2,5}\b/g)) out.add(m[0]);
  for (const m of t.matchAll(/[「『"'‘]([^」』"'’]{2,12})[」』"'’]/g)) {
    const w = m[1].trim().toLowerCase();
    if (w.length >= 2 && !/^(这个|那个|什么|怎么|这样|那样)$/.test(w)) out.add(w);
  }
  return [...out].slice(0, 8);
}

const tokensOf = (s) => new Set(sceneOf(s));
const overlap = (a, b) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
};
/** 交并比。用来判"这是不是同一个坑"：场景词几乎重合才算，差一半就算新的一条。 */
const jaccard = (a, b) => {
  const u = new Set([...a, ...b]);
  return u.size ? overlap(a, b) / u.size : 0;
};

/**
 * 错题本。所有磁盘读写都在这一层；server 只拿"要不要说"和"说什么"。
 */
export function createMistakes({ file, now = () => Date.now(), warn = console.warn } = {}) {
  const list = [];
  let loaded = false;

  async function load() {
    if (loaded) return list;
    loaded = true;
    try {
      const arr = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(arr)) for (const e of arr) if (e && e.id && e.right) list.push(e);
    } catch (e) {
      if (e.code !== 'ENOENT') warn('[mistakes] 读不出来，当作空的：' + e.message);
    }
    return list;
  }

  async function save() {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (e) {
      warn('[mistakes] 写不进去：' + e.message);
    }
  }

  const fresh = (e) => now() - (e.at || 0) < FRESH_DAYS * 86_400_000;

  return {
    async init() { await load(); return list.length; },
    list: () => list.slice(),

    /**
     * 记一条。`wrong` 是它上一轮说的那句，`right` 是用户的纠正。
     *
     * 同一个场景 + 同一句纠正 = 不重复记；**同一个场景 + 不同的纠正** = 记 `repeat`，
     * 因为那说明上一次的教训没生效（或者上次记错了），而"这个坑踩过两次"本身
     * 就是一条更强的信号。
     */
    async add({ wrong = '', right = '', at = null } = {}) {
      await load();
      const r = String(right || '').trim().slice(0, 80);
      const w = String(wrong || '').trim().slice(0, 80);
      if (!r) return null;
      const scene = sceneOf(`${r} ${w}`);

      /* 同一个坑的判据是**场景词几乎重合**，不是原话一模一样：
         用户第一次说「不对，我说的是 Jellyfin」，第二次说「不是，我说的是 Jellyfin」——
         两句话不同，但要记的是同一件事。按原话去重会给同一个坑攒出三四条，
         而注入时它们会一起冒出来，看起来像"它记了一堆废话"。
         反过来，"端口是 5679" 和 "端口是 6000" 因为数字进了场景词，Jaccard 掉下去，
         会被记成两条 —— 这两个确实是两个坑。 */
      const mine = new Set(scene);
      const same = list.find((e) => jaccard(new Set(e.scene), mine) >= 0.6);
      if (same) {
        same.repeat = (same.repeat || 0) + 1;
        same.at = now();
        same.right = r;                      // 以最新的说法为准
        if (w) same.wrong = w;
        await save();
        return same;
      }

      const entry = {
        id: 'm' + crypto.randomBytes(3).toString('hex'),
        at: at || now(),
        wrong: w,
        right: r,
        scene,
        seen: 0,
        repeat: 0,
      };
      list.push(entry);
      /* 同一场景最多留 PER_SCENE 条，旧的先走 */
      const sib = list.filter((e) => overlap(new Set(e.scene), new Set(entry.scene)) > 0);
      if (sib.length > PER_SCENE) {
        sib.sort((a, b) => b.at - a.at);
        for (const old of sib.slice(PER_SCENE)) {
          const i = list.indexOf(old);
          if (i >= 0) list.splice(i, 1);
        }
      }
      await save();
      return entry;
    },

    /**
     * 这个问题有没有对应的老毛病。
     *
     * 命中条件：**至少一个具体名字重合**（拉丁词/引号里的中文）。
     * 只有"场景词重合"才算 —— 靠句式相似度凑出来的命中会天天误报，
     * 而误报的代价是它每次回答前都先道一次歉。
     */
    match(text, k = MAX_INJECT) {
      const q = tokensOf(text);
      if (!q.size) return [];
      const hits = [];
      for (const e of list) {
        if (!fresh(e)) continue;
        const n = overlap(new Set(e.scene), q);
        if (!n) continue;
        hits.push({ e, n });
      }
      return hits
        .sort((a, b) => b.n - a.n || (b.e.at - a.e.at))
        .slice(0, k)
        .map((x) => x.e);
    },

    /** 这一段要不要拼进上下文；拼就顺手记 seen（注入次数，给"这条到底有用没"看） */
    async promptText(text) {
      await load();
      const hits = this.match(text);
      if (!hits.length) return '';
      for (const e of hits) e.seen = (e.seen || 0) + 1;
      save();
      const lines = ['## 上次这里判断错过', '（用户当场纠正过。这次先按"对的那句"来；拿不准就先查，别沿用上次的说法。）'];
      for (const e of hits) {
        const twice = e.repeat > 0 ? `（这个坑踩过 ${e.repeat + 1} 次）` : '';
        lines.push(`- 我说过「${e.wrong || '（没留下原话）'}」，用户纠正「${e.right}」${twice}`);
      }
      return lines.join('\n');
    },

    /** 工具回给模型用的形状（memory_recall 里排最前面） */
    async recall(text, k = MAX_INJECT) {
      await load();
      return this.match(text, k).map((e) => ({ wrong: e.wrong, right: e.right, when: new Date(e.at).toISOString().slice(0, 10) }));
    },

    async stats() {
      await load();
      return {
        total: list.length,
        fresh: list.filter(fresh).length,
        repeated: list.filter((e) => (e.repeat || 0) > 0).length,
      };
    },

    _reset() { list.length = 0; loaded = false; },
  };
}
