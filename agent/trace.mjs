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
