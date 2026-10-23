/**
 * 「思考过程」那一栏的措辞。
 *
 * 一轮里真正发生的事有十几件：取证、翻记忆、铺屏、等你确认……
 * 它们以前只进 `?dev=1` 的观察窗（10px 等宽，用户根本看不见）。
 * 但"它刚才在干什么"是用户能看懂、也想看的东西 —— 尤其是它慢了的时候。
 *
 * 这里只干一件事：**把工具名翻成一句人话**。
 *   · 工具名 → 一个动作（`sys_status` 对用户来说是"看一眼机器"，不是函数名）
 *   · 参数   → 一个宾语（"n8n"、"最近 70 行"）
 *
 * 三个不做：
 *   · 不做判断（危不危险是 tools.mjs 的 level 管，这里只负责措辞）；
 *   · 不做截断策略（宽度是屏幕的事，CSS 有 ellipsis）；
 *   · 不编造结果（结果由服务端的 summarize 给，这里一个字都不猜）。
 *
 * 为什么服务端出文字、而不是让前端自己映射：前端拿得到工具名，
 * 但拿不到"这一轮命中了 2 条记忆""上下文压了一段"这些事 ——
 * 两个地方各写一份映射，迟早有一处开始漂。
 */

/** olares 的读 op → 一句话。写在这里而不是 OP_DOC（那份是给模型的，要带细节） */
const OP_ZH = {
  apps: '应用清单',
  app: '应用状态',
  appinfo: '应用介绍',
  appcfg: '应用入口',
  catalog: '市场里有什么',
  categories: '市场分类',
  overview: '整机负载',
  usage: '谁在吃资源',
  version: '系统版本',
  whoami: '当前身份',
  users: '用户列表',
  context: '集群视野',
  pods: 'pod 列表',
  events: 'pod 事件',
  images: '本地镜像',
  backup: '备份计划',
};

/** olares_act 的动词 → 一句话 */
const ACT_ZH = {
  stop: '停掉',
  resume: '开回',
  restart: '重启',
  install: '装',
  upgrade: '升级',
  uninstall: '卸载',
  cancel: '取消',
};

/** 取路径的最后一段：`/home/bbbigdan/Downloads/a.mkv` → `a.mkv` */
function tail(p, n = 22) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const name = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s;
  const ch = Array.from(name);
  return ch.length > n ? `${ch.slice(0, n - 1).join('')}…` : name;
}

export const cut = (s, n = 22) => {
  const ch = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim());
  return ch.length > n ? `${ch.slice(0, n - 1).join('')}…` : ch.join('');
};

/**
 * 每个工具：动作 + 宾语。
 * 宾语是函数，因为"看日志"需要知道看谁的日志 —— 而这不是动词能概括的。
 */
const T = {
  sys_status: ['看一眼机器'],
  app_list: ['看装了哪些应用'],
  olares: ['看系统', (a) => OP_ZH[a?.op] || a?.op || ''],
  olares_act: ['动系统', (a) => `${ACT_ZH[a?.act] || a?.act || ''}${a?.name ? ` ${a.name}` : ''}`],
  skill_use: ['翻官方说明', (a) => a?.name || ''],
  fs_scan: ['扫磁盘', (a) => (a?.path ? tail(a.path) : '整台机器')],
  fs_list: ['看目录', (a) => tail(a?.path || '~')],
  fs_read: ['读文件', (a) => tail(a?.path)],
  fs_search: ['搜文件', (a) => cut(a?.q || a?.query || a?.pattern, 16)],
  fs_write: ['写文件', (a) => tail(a?.path)],
  fs_move: ['挪文件', (a) => tail(a?.from || a?.src)],
  fs_delete: ['删文件', (a) => tail(a?.path)],
  logs_tail: ['看日志', (a) => `${a?.app || a?.name || ''}${a?.lines ? ` ${a.lines} 行` : ''}`],
  k8s_get: ['查集群对象', (a) => [a?.kind, a?.name].filter(Boolean).join(' ')],
  k8s_restart: ['重启应用', (a) => a?.app || a?.name || ''],
  mem_trim: ['清内存'],
  memory_recall: ['翻记忆', (a) => cut(a?.q || a?.query, 16)],
  memory_stats: ['数一数记忆'],
  memory_forget: ['忘掉几条', (a) => cut(a?.q || a?.query, 16)],
  scene_show: ['铺一屏'],
  scene_ask: ['把问题问出来'],
  scene_set: ['换一屏'],
  scene_patch: ['改一屏'],
  scene_pulse: ['让场动一下'],
  scene_transition: ['换场'],
  surface_render: ['打开内容窗口', (a) => a?.root?.type || a?.spec?.root?.type || ''],
  surface_close: ['收起内容窗口'],
  draw: ['画一张', (a) => (Array.isArray(a?.layers) ? `${a.layers.length} 层` : '')],
  face: ['做个表情'],
  draw_stop: ['停笔'],
  web_get: ['上网查', (a) => {
    try { return new URL(String(a?.url || '')).hostname; } catch { return cut(a?.url, 18); }
  }],
  tool_list: ['看自己有哪些工具'],
  tool_write: ['写一个新工具', (a) => a?.name || ''],
  tool_code: ['写脚本', (a) => (a?.lang ? a.lang : '')],
  tool_try: ['试跑脚本', (a) => a?.name || ''],
  tool_keep: ['把脚本装成工具', (a) => a?.name || ''],
  skill_save: ['记住一个做法', (a) => cut(a?.name || a?.title, 16)],
};

/**
 * @param {string} name 工具名
 * @param {object} args 已经 fill 过的参数（不是原始 JSON 字符串）
 * @returns {{verb:string, detail:string}}
 */
export function toolLine(name, args = {}) {
  const e = T[name];
  if (!e) return { verb: String(name || '做点什么'), detail: '' };
  let detail = '';
  if (typeof e[1] === 'function') {
    try { detail = e[1](args || {}) || ''; } catch { detail = ''; }
  }
  return { verb: e[0], detail: String(detail).slice(0, 24) };
}

/** 这一轮里"停下来问你"的那一行 */
export function gateLine(label) {
  return { verb: '停下来问你', detail: cut(label, 20) };
}

export const VERBS = Object.keys(T);
export { OP_ZH, ACT_ZH };

/* ───────────────────── 它的思考：一段自由文本 → 几条能上屏的短句 ───────────────────── */

/** 一个字符里有多少"像中文"的份量（汉字 1、全角标点 0.5、字母数字 0） */
function zhWeight(s) {
  const ch = Array.from(s);
  if (!ch.length) return 0;
  let w = 0;
  for (const c of ch) {
    if (/[\u4e00-\u9fa5]/.test(c)) w += 1;
    else if (/[\u3000-\u303f\uff00-\uffef“”‘’—…]/.test(c)) w += 0.5;
    else if (/\s/.test(c)) w += 0;
    else w += 0;
  }
  return w / ch.length;
}

/** 按长度收口，但**不把英文单词劈成两半**。
 *
 *  踩到的样子：`总盘容量未知，但可以用 olares overvi…` —— "overview" 被切成
 *  "overvi"，读起来像个拼错的函数名。中文没有这个问题（一个字就是一个词），
 *  所以只在"断点两侧都是字母数字"时往回退，退到空格/标点为止。
 *  最多退到 60%，再退就丢太多信息了，宁可劈开。
 */
function fitSent(s, n) {
  const ch = Array.from(s);
  if (ch.length <= n) return s;
  let k = n - 1;
  while (k > Math.floor(n * 0.6) && /[A-Za-z0-9]/.test(ch[k - 1] || '') && /[A-Za-z0-9]/.test(ch[k] || '')) k--;
  return `${ch.slice(0, k).join('').replace(/[\s,;:，、；：]+$/u, '')}…`;
}

/**
 * 把模型的 `reasoning_content` 切成几条**能直接排在屏幕上的短句**。
 *
 * 为什么要切、要筛，而不是原样往屏幕上撒：
 *
 *   · 一段思考 300~1000 字，那一栏只有 250px 高（约 10 行）。原样放进去就是
 *     一堵墙，用户不会读；而"它在想什么"恰恰只需要开头那几句。
 *   · **思考不一定是中文。** 实测 DeepSeek-V4.1-Flash 在没被要求时会用英文想
 *     （"Need to report. Maybe also scene_show?…"）。英文思考排在中文界面里
 *     比不显示更糟 —— 用户会以为界面坏了。所以按中文占比筛，筛不出就不显示。
 *   · 有的模型会把 `<think>` 原样吐在 reasoning_content 里（GLM-Z1），要剥掉。
 *
 * 三条弃用规则：纯英文句、太短的碎片（"好的。"）、同一句重复。
 *
 * @param {string} thinking 模型返回的 reasoning_content
 * @param {number} max 最多几条（屏幕上放得下的量，不是"能切出几条"）
 * @returns {string[]}
 */
export function reasonLines(thinking, max = 4) {
  /* 0 就是 0。调用方算出来的额度（`Math.min(3, 8 - 已用)`）可能正好是 0，
     而循环是"先 push 再判满"—— 不挡这一下，额度用光之后还会再冒一条。 */
  if (!(max > 0)) return [];
  let t = String(thinking || '')
    .replace(/<\/?think>/gi, '\n')
    .replace(/<\/?\|?think\|?>/gi, '\n')
    .replace(/```[\s\S]*?```/g, ' ')     // 它在想里贴代码，那不是"想"
    /* 只抹 markdown 的强调和反引号：**不能连下划线一起抹** ——
       思考里提到 sys_status 时会被抹成 sysstatus，屏幕上就是一个不存在的函数名 */
    .replace(/\*\*|`/g, '')
    /* 第一人称的英文思考经常带 markdown 列表符号，一并抹掉 */
    .replace(/^\s*[-•]\s*/gm, '');

  /* 中文句末 + 分号 + 换行，外加**英文句号后跟空格**。
     英文句号不切的话，"I need to call X. 这个工具会…" 会被当成**一句**
     （它含中文，能过中文占比筛），然后被 cut 掉后半截 —— 屏幕上就剩一句英文。 */
  const raw = t
    .split(/(?<=[。！？!?；;])|(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const s0 of raw) {
    /* 尾部标点去掉：屏幕上每行都以"。"结尾会显得像文稿，不像在说给自己听 */
    const s = s0.replace(/[。！？；，,、\s]+$/u, '').trim();
    if (s.length < 6 || s.length > 120) continue;
    /* 纯英文句：中文占比不足三成就是英文思考，不显示 */
    if (zhWeight(s) < 0.3) continue;
    /* 整句占比不够狠 —— 中英混排里夹一句中文就能骗过去。
       线上原样：`User asks "挑一个占内存最多的说说" —…` 中文占了五成，
       过了上一关，屏幕上就是一行半中半英。所以再看**开头 10 个字**：
       思考的中文句子开头几乎不可能是纯英文（"n8n 占内存最多：…" 这种
       专有名词开头，前 10 个字里也有四五个汉字）。 */
    const head = Array.from(s).slice(0, 10).join('');
    if ((head.match(/[一-龥]/g) || []).length < 2) continue;
    const k = s.slice(0, 12);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(fitSent(s, 28));
    if (out.length >= max) break;
  }
  return out;
}

/** 两句"说的是不是同一件事"：按 2-gram 集合的 Jaccard 比。
 *
 *  为什么要它：线上实测（2026-10-23）同一个模型在不同步里会想
 *  「用户问装了哪些应用，**挑**一个占内存最多的说说」和
 *  「用户问装了哪些应用，**并挑**一个占内存最多的说说」—— 差一个字，
 *  按整句去重拦不住，屏幕上就是连着两行几乎一样的话，看起来像卡住了。
 *
 *  用 2-gram 而不是按字数前缀：中文差一个字往往就在中间（"挑" / "并挑"），
 *  前缀法要么漏（取 12 字）要么误杀（取 8 字会把"装了哪些应用"和
 *  "装了哪些工具"判成同一句）。
 */
export function alike(a, b) {
  const gram = (s) => {
    const ch = Array.from(String(s || '').replace(/[\s，。、；：！？,.;:!?]/g, ''));
    const out = new Set();
    for (let i = 0; i + 1 < ch.length; i++) out.add(ch[i] + ch[i + 1]);
    return out;
  };
  const A = gram(a);
  const B = gram(b);
  if (!A.size || !B.size) return false;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / (A.size + B.size - hit) >= 0.72;
}
