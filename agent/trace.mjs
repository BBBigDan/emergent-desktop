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
  /* 画图那一行要说出"画什么"，不是在说"调了个工具" —— 用户想看的是画面。
     提示词截 12 字：再长就把那一行挤掉了，而它也只是个索引。 */
  comfy: ['画图', (a) => (a?.op === 'gen' ? cut(a?.prompt, 12) || '一张图' : a?.op === 'status' ? '看它有没有卡' : '看有哪些画法')],
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
  /* 子 agent 那一行要说清"谁在说"：用户需要一眼看出这不是它的结论，是另一个立场。
     `critic` = 挑毛病的人，`advocate` = 替这件事说话的人。 */
  /* 对戏那一行要说清「两个人在说话」，不是「生成了一段文本」 */
  dialogue: ['让两个人当面说', (a) => (Array.isArray(a?.cast) ? a.cast.map((c) => c?.name).filter(Boolean).join(' 对 ') : '')],
  sub_run: ['换个立场问', (a) => (a?.role === 'advocate' ? '替它说话的人'
    : a?.role === 'character' ? '扮一个人' : '挑毛病的人')],
  /* 定时那一行要让用户看懂"它给自己排了个班"，而不是"它查了一下" */
  schedule: ['排了个班', (a) => (a?.op === 'add' ? (a?.when || '') : (a?.op === 'list' ? '看有哪些' : (a?.id || a?.task || '')))],
  /* 应用层：要让人一眼看出"它在读某个应用的接口"还是"在改某个应用里的东西" */
  app_api: ['读应用的接口', (a) => (a?.op === 'probe' ? `探 ${a?.app || ''}` : `${a?.app || ''} ${a?.path || ''}`.trim())],
  app_act: ['改应用里的东西', (a) => `${a?.app || ''} ${a?.method || ''} ${a?.path || ''}`.trim()],
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

/** 按**显示宽度**收口，但**不把英文单词劈成两半**。
 *
 *  为什么按宽度而不是字数：同样一句意思，英文比中文长一倍多。按字数切的话，
 *  中文那行读得完整，英文那行只剩三个词。一个汉字算 1、一个 ASCII 字符算 0.55
 *  —— 28 的额度下中文 28 字、英文 50 个字符，屏幕上占的宽度一样。
 *
 *  为什么不在词中间下刀：`总盘容量未知…olares overvi…` —— "overview" 被切成
 *  "overvi"，读起来像个拼错的函数名。中文没有这个问题（一个字就是一个词），
 *  所以只在"断点两侧都是字母数字"时往回退，最多退到 60%，再退就丢太多信息了。
 */
function fitSent(s, w) {
  const ch = Array.from(s);
  const wide = (c) => (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(c) ? 1 : 0.55);
  let acc = 0;
  let k = 0;
  for (; k < ch.length; k++) {
    acc += wide(ch[k]);
    if (acc > w) break;
  }
  if (k >= ch.length) return s;
  let cut = k;
  while (cut > Math.floor(k * 0.6) && /[A-Za-z0-9]/.test(ch[cut - 1] || '') && /[A-Za-z0-9]/.test(ch[cut] || '')) cut--;
  return `${ch.slice(0, cut).join('').replace(/[\s,;:，、；：]+$/u, '')}…`;
}

/**
 * 把模型的 `reasoning_content` 切成几条**能直接排在屏幕上的短句**。
 *
 * 为什么要切、要筛，而不是原样往屏幕上撒：
 *
 *   · 一段思考 300~1000 字，那一栏只有 250px 高（约 10 行）。原样放进去就是
 *     一堵墙，用户不会读；而"它在想什么"恰恰只需要开头那几句。
 *   · 有的模型会把 `<think>` 原样吐在 reasoning_content 里（GLM-Z1），要剥掉。
 *
 * **语言的筛法已经删掉了**（2026-10-23）。这里曾经有一条"中文占比 < 30% 就丢"，
 * 理由是"英文夹在中文界面里看着像坏了"。那是个错误：模型用英文想，是它真实的
 * 思考过程，丢掉就是信息缺失 —— 而且丢的往往正是推理链（越复杂的事越容易切回
 * 母语）。让思考说中文是**提示词的责任**（"思考也用中文"），不是出口的责任。
 * 模型不吃那一套，屏幕上就照实显示英文。
 *
 * 三条弃用规则：太短的碎片（"好的。"）、同一句重复、屏幕放不下的长度。
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
     英文句号不切的话，"I need to call X. Then draw three gauges." 会被当成
     一句超长的，然后被宽度截掉一半 —— 屏幕上只剩半句。 */
  const raw = t
    .split(/(?<=[。！？!?；;])|(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const s0 of raw) {
    /* 尾部标点去掉：屏幕上每行都以"。"结尾会显得像文稿，不像在说给自己听 */
    const s = s0.replace(/[。！？；，,、\s]+$/u, '').trim();
    /* 下限挡碎片（"好的。"），上限挡"一整段没有标点"的思考 ——
       那截到 28 宽也只剩开头，白占一个名额。160 对英文也算宽了。 */
    if (s.length < 6 || s.length > 160) continue;
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
