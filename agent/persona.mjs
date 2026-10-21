/**
 * M5 人格层：L0 种子 + 漂移注入。
 *
 * 这不是"给模型加一点性格"。它回答的是一个更具体的问题：
 * **它凭什么说"我今天看到…"，而且说得出口那句是从哪来的。**
 *
 * 三条规矩，都是靠代码判的，不靠模型自觉：
 *
 * 1. **种子只能是真发生过的事。** 来源只有两个：它自己动手造成的后果（重启了谁、
 *    挪了什么 —— server 在执行完工具后传进来），和记忆库里已经落地的旧事实。
 *    模型"说过的话"永远不进种子：它上一轮编一句，这一轮就当成自己的经历 —— 
 *    那是最快的一种自我污染。
 *
 * 2. **注入必须与当前问题正交（Ω ⟂ goal）。** 不相关才叫"漂移"，相关了就是检索，
 *    而检索记忆已经有专门的一条通道（memory.context）。两条通道混在一起的表现是：
 *    用户问磁盘，它答"我上次给你挪过文件" —— 看着像记忆，其实是答非所问。
 *
 * 3. **每条注入带编号，编号能查回来源。** 用户看到「重启过 n8n（#41）」，
 *    能拿 41 去 drift/YYYY-MM.jsonl 查到那一行的 sid / turn / 工具名。
 *    没有编号的"我记得"是不可核对的，等于允许它编。
 *
 * 落盘位置跟记忆一样放在 Home，不藏私有目录：
 *   ~/Agent/memory/persona.md          人格设定（人可读可改，改了下一轮生效）
 *   ~/Agent/memory/drift/YYYY-MM.jsonl 种子 + 注入记录（逐行，可审计）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
/* 路径**每次用时才算**，不在模块加载时定死。
   这条不是洁癖：测试在 import 之后才设 PERSONA_DIR，定死的话它会往用户的真实
   目录里写假种子（踩过一次）—— 自测污染真实数据，比测不出来更坏。
   默认跟**记忆同一个目录**（~ 下 Files 里看得见的那份）。踩过一次：集群上记忆在
   /userspace/pvc-xxx/Home/Agent/memory，而人格写进了 /root/Agent/memory —— 容器内的
   私有目录，pod 一删全没，用户在 Files 里也永远看不到它在记什么。 */
const rootDir = (o = {}) => {
  const d = typeof o.dir === 'function' ? o.dir() : o.dir;
  return process.env.PERSONA_DIR || d || path.join(HOME, 'Agent', 'memory');
};
const driftDir = (o) => path.join(rootDir(o), 'drift');
const personaPath = (o) => path.join(rootDir(o), 'persona.md');

/* 默认人格设定。它是**可改的文本**，不是代码：用户想改它的说话方式就编辑这个文件，
   下一轮生效。所以这里只写"它是谁、怎么说话"，不写任何工具规则 —— 规则在 prompt.mjs。 */
const DEFAULT_PERSONA = `你不是浏览器里的聊天框，你是这个桌面本身。
不确定的事就去读一次，别猜；读不到就说读不到。
你记得自己做过什么。提到旧事时带上编号，别把"我记得"当成修辞。
话短一点。屏幕上已经有数字了，不用再念一遍。
`;

/* ── 正交性 ──────────────────────────────────────────────
 * 中文没有空格，分词器又不值得引进来。用二元字组做粗粒度的"同一件事"判定：
 * 只要有**一个实义二元组**重合，就认为这条种子讲的是用户正在问的那件事，
 * 这时不该走漂移通道（该走检索）。
 *
 * 停用词是必须的：少了它，"现在"「什么」「情况」这些词会让任何两句话都"相关"，
 * 于是漂移永远不触发 —— 而这种坏掉的方式是**静默的**（面板上泄漏率恒等于 0，
 * 看起来像"这功能没开"）。 */
const STOP = new Set([
  '现在', '什么', '怎么', '一下', '我们', '这个', '那个', '可以', '一个', '已经', '还是',
  '就是', '没有', '不是', '是不', '多少', '哪个', '这些', '那些', '时候', '的话', '然后',
  '因为', '所以', '但是', '如果', '一样', '知道', '觉得', '可能', '应该',
]);

export function terms(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  /* ASCII 按"连续字母数字"切，不把点号并进词里：种子写的是 report.pdf、
     用户问的是 report —— 并成一个词就永远对不上，判据会静默失效。 */
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < cjk.length; i++) {
    const g = cjk.slice(i, i + 2);
    if (!STOP.has(g)) out.add(g);
  }
  return out;
}

export function orthogonal(seedText, goalText) {
  const a = terms(seedText);
  const b = terms(goalText);
  if (!a.size || !b.size) return true;   // 一方没词就没法判"相关"，按不相关放行
  for (const t of a) if (b.has(t)) return false;
  return true;
}

/* ── 动作 → 一句话 ──────────────────────────────────────────
 * 只收**有后果**的动作。读数类（sys_status / fs_scan / logs_tail）每轮都有，
 * 收进来会把真正的"做过的事"淹掉，而且"我看了一眼内存"不算经历。
 *
 * 键是工具名，值是「把参数翻成一句人话」。翻不出来的工具一律不收 —— 
 * 与其存一句 "k8s_patch {...}"，不如不存。 */
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '文件';

const ACTS = {
  k8s_restart: (a) => `重启了 ${a.name || a.pod || a.app || a.deployment || '一个应用'}`,
  k8s_scale: (a) => `把 ${a.name || a.app || '一个应用'} 调成 ${a.replicas ?? '?'} 个副本`,
  fs_move: (a) => `把 ${base(a.from)} 挪到了 ${base(a.to)}`,
  fs_delete: (a) => `删了 ${base(a.path)}`,
  fs_write: (a) => `写了 ${base(a.path)}`,
  mem_trim: () => '回收了一次内存',
  tool_keep: (a) => `给自己装了一个工具 ${a.name || ''}`.trim(),
  skill_save: (a) => `记下了一个做法${a.name ? `：${a.name}` : ''}`,
};

/** 把一个工具调用翻成种子文本。不是"有后果的动作"就返回 null。 */
export function actText(name, args) {
  const f = ACTS[name];
  if (!f) return null;
  const a = args && typeof args === 'object' ? args : {};
  try {
    return String(f(a) || '').trim() || null;
  } catch {
    return null;
  }
}

/* 读数不是经历。
   判据跟 memory.mjs 的 cleanFact 是同一个想法：带百分比、又没有"会持续下去"的动作词，
   那是一次快照 —— 拿它说成"我做过的事"就是记错时间。实测踩过：记忆库里躺着
   "n8n 占用 60% 内存"，漂移把它当谈资说了出来，而那时真实值是 41%。
   记忆侧本来就该挡住这条，但库里可能有旧数据，人格层再挡一次。 */
/* 动作词用**双字**，不用单字。
   中文里单字会撞进名词/状态词："占用"里有"用"、"内存上限"里有"存" ——
   用单字集合判，读数会被当成动作（踩过：含"占用"的读数照样过关）。
   宁可漏判（少收一条种子），不可误判（把快照当经历说出来）。 */
const DURABLE = /(挪|删除|装了|装好|装上|换成|换成|写到|写了|保存|重启|调整|调到|调成|调过|配置|关闭|打开|创建|移动|加了|加进|放到|放回|设成|设为|改到|改成|要求|喜欢|不希望|需要|应该|不要|记得|提醒)/;

export function looksLikeReading(text) {
  return /\d+(\.\d+)?\s*%/.test(String(text || '')) && !DURABLE.test(String(text || ''));
}

/* 记忆库里有抽取失败的产物（实测躺着一条「我做了 → 工具返回」）。它不是事实，
   更不该被当成"我做过的事"说出来。判据看形状：结构性符号、复述腔。 */
const NOISE = /→|\{"|工具返回|^我(做了|试了|调用了|先看)/;

/** 一条旧事能不能当谈资：得像人话，且不能是读数/噪声。 */
export function usableSeed(text) {
  const t = String(text || '').trim();
  if (t.length < 4) return false;
  if (NOISE.test(t)) return false;
  return !looksLikeReading(t);
}

/* 同一个动作反复做只该记一次（"又重启了一次 n8n"是噪声，不是经历）。
   判重键 = 工具名 + 翻出来的那句话的前 12 字：比只比工具名细，比比全参数稳。 */
const dedupeKey = (name, text) => `${name}:${text.slice(0, 12)}`;
const DAY = 86400e3;

function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}
/* 时间要给**人话**，不是 ISO 也不是 "10-20 17:14"。
   实测：注入 "10-20 17:14 重启了 navidrome"，7B 原样念了出来 ——
   屏幕上就出现一行日期串。给"昨天 17:14"，念出来也是句人话。 */
function clock(ts, now = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const day = (x) => new Date(x).setHours(0, 0, 0, 0);
  const diff = Math.round((day(now) - day(ts)) / DAY);
  if (diff <= 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  if (diff < 7) return `${diff} 天前`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/**
 * 反向核对：它说的话里，有哪些确实来自这一轮注入的旧事。
 *
 * 为什么要这一步 —— 验收里那句"能指出那条信息是哪来的"，靠模型自己带编号是不保险的
 * （7B 实测：内容说对了，"（#3）"没带）。所以系统自己核一遍：说了就算引用过，
 * 记录里留下编号；反过来，如果它没引用却被记成引用，也说明这一段是白占 token。
 *
 * 判据不看句式，看**词**：一条种子里有若干词出现在它这句话里，就算说过这件事。
 * 短种子（一句话一件事）命中一个词就够了 —— 用户屏幕上那一行只有 20 字，
 * 它常把"重启了"说成"重启过"，二元组只对上"重启"，按两个词的门槛就永远认不出来。
 * 长种子要求两个：那种句子里单个词重合太容易（"文件""内存"到处都有）。
 */
export function traceRefs(said, items = []) {
  const saidTerms = terms(said);
  let best = [];
  let bestScore = 0;
  for (const it of items) {
    const text = String(it?.text || '');
    const a = terms(text);
    if (!a.size) continue;
    let all = 0;
    let zh = 0;
    for (const w of a) {
      if (!saidTerms.has(w)) continue;
      all++;
      /* 实体名（n8n、report）到处都有，单独命中不说明它说了这件事。
         实测踩过：它答"今天早上 n8n 占用了 60% 的内存"，被认成引用了"重启了 n8n" ——
         两句只共享一个 n8n。所以至少得有一个中文词对得上，才算说了那件事。 */
      if (/[\u4e00-\u9fa5]/.test(w)) zh++;
    }
    if (!(all >= 2 || (text.length <= 12 && zh >= 1))) continue;
    /* 只认**最像**的那一条，不是所有"沾边"的。
       实测踩过：记忆里三条"用户把 X 加进周末"，它只说了 Blue in Green，
       溯源却把三条都记上了 —— 那种溯源等于没有。 */
    const score = all / a.size;
    if (score > bestScore + 1e-9) { bestScore = score; best = [it.id]; }
    else if (Math.abs(score - bestScore) <= 1e-9) best.push(it.id);
  }
  return best;
}

export function createPersona(o = {}) {
  const on = o.on !== false && process.env.PERSONA !== 'off';
  /* 泄漏率：每轮"有机会"注入的概率。1 = 每轮都说点旧事（很吵，会变成祥林嫂），
     0 = 永不注入（等于没这个功能）。0.35 是"偶尔提一句"的手感。 */
  const leak = clamp01(o.leak ?? Number(process.env.PERSONA_LEAK ?? 0.35), 0.35);
  const maxItems = Math.max(1, Math.min(3, o.maxItems ?? 2));
  const maxLen = o.maxLen ?? 42;
  const reuseMs = (o.reuseDays ?? 7) * DAY;

  let ok = false;
  let seedSeq = 0;
  let injSeq = 0;
  const seeds = new Map();      // id → {id, at, text, tool, sid, turn}
  const seen = new Map();       // dedupeKey → ts
  const lastUsed = new Map();   // seedId → ts
  const injections = [];        // 最近的注入记录（新在后）
  let attempts = 0;             // 进程内：有多少轮问过它"要不要说点旧事"
  let injectedTurns = 0;        // 其中真的注入了的
  let persona = DEFAULT_PERSONA;
  let queue = Promise.resolve();

  const append = (row) => {
    const line = JSON.stringify(row) + '\n';
    queue = queue.then(() => fs.appendFile(path.join(driftDir(o), `${ymd()}.jsonl`), line).catch(() => {}));
    return queue;
  };

  async function loadPersonaFile() {
    try {
      const t = await fs.readFile(personaPath(o), 'utf8');
      if (t.trim()) persona = t.trim();
    } catch {
      /* 第一次跑：写一份默认的。写失败也不影响运行（人格用内存里那份）。 */
      await fs.mkdir(rootDir(o), { recursive: true }).catch(() => {});
      await fs.writeFile(personaPath(o), DEFAULT_PERSONA, 'utf8').catch(() => {});
    }
  }

  async function loadDrift() {
    const files = await fs.readdir(driftDir(o)).catch(() => []);
    const list = files.filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
    /* 只回读最近两个月：更早的种子还在文件里（可审计），但不再进候选池 ——
       半年前"重启过 n8n"当谈资，只会让用户觉得它记错了时间。 */
    for (const f of list.slice(-2)) {
      const txt = await fs.readFile(path.join(driftDir(o), f), 'utf8').catch(() => '');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (r.t === 'seed' && r.id) {
          seeds.set(r.id, r);
          seedSeq = Math.max(seedSeq, Number(String(r.id).slice(1)) || 0);
          const k = dedupeKey(r.tool || '', r.text || '');
          seen.set(k, Math.max(seen.get(k) || 0, +new Date(r.at) || 0));
        } else if (r.t === 'inject' && r.id) {
          injSeq = Math.max(injSeq, Number(String(r.id).slice(1)) || 0);
          injections.push(r);
          if (r.seed) lastUsed.set(r.seed, Math.max(lastUsed.get(r.seed) || 0, +new Date(r.at) || 0));
        }
      }
    }
    if (injections.length > 200) injections.splice(0, injections.length - 200);
  }

  async function start() {
    await fs.mkdir(driftDir(o), { recursive: true }).catch(() => {});
    await loadPersonaFile();
    await loadDrift();
    ok = true;
    if (on) console.log(`[persona] 种子 ${seeds.size} 条 · 泄漏率 ${leak} · 设定 ${persona.split('\n')[0].slice(0, 20)}…`);
  }

  /** 那一轮它自己做过的事 → 种子。只有"有后果的动作"才进，读数不进。 */
  function afterTurn({ sid, turn, actions = [], at = Date.now() }) {
    if (!ok || !on) return [];
    const made = [];
    for (const a of actions) {
      /* server 传进来的是 {name, brief, note, ok}。失败的调用不算"做过的事" —— 
         它没造成任何后果，记下来只会在下一轮说"我试过但失败了"，那是日志不是经历。 */
      if (!a || a.ok === false || a.denied) continue;
      let args = {};
      try { args = JSON.parse(a.brief || '{}'); } catch { args = {}; }
      const text = actText(a.name, args);
      if (!text) continue;
      const k = dedupeKey(a.name, text);
      const prev = seen.get(k) || 0;
      if (at - prev < DAY) continue;
      seen.set(k, at);
      const seed = {
        t: 'seed', id: `n${++seedSeq}`, at: new Date(at).toISOString(),
        text, tool: a.name, sid, turn,
      };
      seeds.set(seed.id, seed);
      made.push(seed);
      append(seed);
    }
    return made;
  }

  /* 事实种子：记忆库里已经落地的旧事。它不是"动作后果"，但同样是真实发生过的
     （而且是**用户参与过**的），拿来当谈资比动作更自然。
     现取不落盘：记忆库自己会变（巩固/软删），复制一份到 drift 里必然与它漂移。 */
  function factSeeds(n = 6) {
    const rec = o.recallFacts;
    if (typeof rec !== 'function') return [];
    try {
      const list = rec(n);
      if (!Array.isArray(list)) return [];
      return list.map((f) => ({
        id: `m:${f.id}`,
        at: +new Date(f.when || 0) || 0,
        /* 记忆库给的时间是"3 天前"这种人话，不是 ISO 时间戳 —— 直接拿来用，
           不要硬转成日期：转不出来会变成 1970，说成"01-01 挪过文件"就是记错时间。 */
        when: typeof f.when === 'string' ? f.when : '',
        text: String(f.text || '').slice(0, maxLen),
        tool: 'memory', fact: true,
      })).filter((s) => usableSeed(s.text));
    } catch {
      return [];
    }
  }

/**
 * 这一轮要不要说点旧事。
 *
 * 返回 { text, items }。text 直接进 ctxNote；items 是给面板看的。
 * **没有合适的话就返回空字符串** —— 空注入是常态，不是失败。
 */
/* 用户在问"你经历过什么"。这时候旧事不是背景，**就是答案** ——
   所以不适用"与当前问题正交"这条：问题是关于它自己的，正交等于不答。
   这是唯一一处允许漂移通道直接答话的地方，判据必须在代码里，
   否则模型会把"你最近干了啥"答成一句"我一直在这儿帮你"。 */
const SELF_REF = /你(最近|这两天|这几天|今天|昨天|都干|干过|做过|经历|看到|记得|在忙|忙什么)|你这几天|你的经历/;

function drift(goal = '', { at = Date.now(), turn = 0 } = {}) {
    if (!ok || !on) return { text: '', items: [] };
    attempts++;
    const goalText = String(goal || '');
    /* 手势回合不注入：用户刚拖了一下内存，这时候说"我上周重启过 n8n"是纯干扰。 */
    if (!goalText.trim()) return { text: '', items: [] };
    const selfRef = SELF_REF.test(goalText);
    /* 自我指涉的提问必答：用户就是在问"你做过什么"，这时候抽签决定说不说，
       等于掷骰子决定要不要回答问题。其余情况下按泄漏率抽。 */
    if (!selfRef && Math.random() > leak) return { text: '', items: [] };

    /* 自我指涉时**只用动作种子**：记忆库里的旧事大多是"用户把 X 加进歌单"这种
       用户视角的事，拿它回答"你最近干了什么"，说出来的是一句转述 ——
       实测原话："今天 用户把 Blue in Green 加进周末"，既不是它的经历，也不是人话。
       它自己做过的事只有动作种子这一种来源；没有就老实说没有。 */
    const pool = selfRef ? [...seeds.values()] : [...seeds.values(), ...factSeeds()];
    /* 最久没被说过的排前面：保证覆盖，而不是反复说同一条。
       随机取会让"记得的那一两件"永远被抽中，时间一长人格就变成一句口头禅。 */
    pool.sort((a, b) => (lastUsed.get(a.id) || 0) - (lastUsed.get(b.id) || 0));

    const picked = [];
    const now = at;
    const cap = selfRef ? Math.max(maxItems, 3) : maxItems;
    for (const s of pool) {
      if (picked.length >= cap) break;
      if (!usableSeed(s.text)) continue;
      const used = lastUsed.get(s.id) || 0;
      /* 七天之内说过的不再说 —— 但**用户直接问它经历过什么时不算**。
         那条规矩是为了防止它主动啰嗦；用户开口问了还闭嘴，就是答不上话。
         （踩过：问"你最近都干什么了"，两条种子都因为刚说过被挡，它答了句"我看一眼"。） */
      if (!selfRef && used && now - used < reuseMs) continue;
      /* 相关性判定只对"背景式注入"有意义。用户问"你记得 n8n 吗"的时候，
         n8n 那条正是答案，挡住它就变成答非所问。 */
      if (!selfRef && !orthogonal(s.text, goalText)) continue;
      picked.push(s);
    }
    if (!picked.length) return { text: '', items: [] };

    const lines = [];
    const items = [];
    for (const s of picked) {
      const id = `i${++injSeq}`;
      const when = s.when || (s.at ? clock(s.at) : '');
      const body = s.text.length > maxLen ? s.text.slice(0, maxLen - 1) + '…' : s.text;
      /* 给模型看的这一行**不带编号**：编号是给系统和用户用的（面板里按 #N 显示），
         模型带着它只会照抄或对应错。少几个字符也是少。 */
      lines.push(`- ${when ? when + ' ' : ''}${body}`);
      lastUsed.set(s.id, now);
      const row = {
        t: 'inject', id, at: new Date(now).toISOString(), seed: s.id,
        text: body, goal: goalText.slice(0, 60), turn, selfRef,
      };
      injections.push(row);
      items.push(row);
      append(row);
    }
    injectedTurns++;

    /* 头两行是纪律，不是装饰：不写清楚"这不是用户刚说的"，模型会把注入当成用户的话
       复述一遍。
       **不让它自己写编号**：实测 7B 会照抄示例编号（写出一个查不到的 #41），
       或者编号带对了但张冠李戴（#3 指的是挪文件，它说成"我查过内存"）。
       编错的编号比不给更糟 —— 用户会去查，然后发现它连出处都是编的。
       所以编号由系统给（trace → say.refs → 面板），模型只负责把事说成人话。
       自我指涉的提问要换一种说法：那时候"时机合适才提一句"会让它继续谦虚，
       而用户就是在等它说。 */
    const rule = '说的时候就像在讲一件自己经历过的事，别提"记忆库""记录""系统提示"这些词。）\n';
    const head = selfRef
      ? '## 你自己记着的事\n'
        + '（用户正在问你经历过什么。**直接把下面这几件说出来**，别绕、别谦虚、别答成"我一直在这儿帮你"。'
        + '一次只说一件 —— 屏幕那一行放不下两句。'
        + rule
      : '## 你自己记着的事\n'
        + '（这不是用户刚说的，是你过去真的做过、看到过的。时机合适才提一句，别每句都提。'
        + rule;
    const text = head + lines.join('\n');
    return { text, items, selfRef };
  }

  function stats() {
    const today = new Date().toISOString().slice(0, 10);
    const todayInj = injections.filter((r) => String(r.at).startsWith(today)).length;
    return {
      on, leak, ok,
      seeds: seeds.size,
      facts: factSeeds().length,
      inject: {
        attempts, turns: injectedTurns, today: todayInj, total: injections.length,
        /* 其中有多少次是"用户直接问它经历过什么"——那几次是必答，不占泄漏率的预算 */
        selfRef: injections.filter((r) => r.selfRef).length,
      },
      /* 实际泄漏率：注入了的轮数 / 问过的轮数。它是这个功能唯一的手感指标 —— 
         接近 1 就是祥林嫂，恒等 0 就是没接通。 */
      ratio: attempts ? +(injectedTurns / attempts).toFixed(2) : 0,
      persona: persona.split('\n').slice(0, 6).join('\n'),
      recent: injections.slice(-6).reverse().map((r) => ({
        id: r.id, at: r.at, text: r.text, goal: r.goal, seed: r.seed,
      })),
    };
  }

  function promptText() {
    if (!ok || !on || !persona) return '';
    return `## 你是谁\n${persona}`;
  }

  return {
    start, afterTurn, drift, stats, promptText,
    /* 面板/测试用：把种子和注入摊开，方便核对"它说的这句是哪来的" */
    debug() { return { seeds: [...seeds.values()].slice(-20), injections: injections.slice(-20) }; },
    get on() { return on && ok; },
    drain: () => queue,
  };
}

function clamp01(v, d) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(0, Math.min(1, n));
}
