/**
 * 工具注册表。
 *
 * M0 阶段的目标不是"能管服务器"，而是**把工具的契约固定下来**：
 * 每个工具四件事写死 —— 名字、给模型看的描述、参数 schema、危险等级。
 * 之后 M1 换成真的 k8s / 真的文件系统，`run()` 换掉，schema 一个字不用改。
 *
 * 危险等级只有两档，故意不做第三档：
 *   safe    只读，随便跑
 *   danger  会产生后果（写文件、删东西、重启服务），必须过审批门
 * "中间档"是所有权限系统烂掉的开始 —— 一旦有"半危险"，判据就模糊了。
 */

import os from 'node:os';
import fs from 'node:fs/promises';

import {
  SPEC_SCHEMA, OPS_SCHEMA, PULSES,
  normalizeSpec, normalizeOps, normalizePulse,
} from './scene.schema.mjs';
import { createK8s } from './sources/k8s.mjs';
import { createFs } from './sources/fs.mjs';
import { OPS, OP_DOC, ACTS, ACT_DOC } from './olares.mjs';

const GB = 1024 ** 3;

/* ───────────────────────── 工具分组（省 token 用） ─────────────────────────
 *
 * 34 个工具的 JSON schema 一次就是 6k token，**每一次调用都要重发**。
 * 但其中大部分是长尾：造工具那六件、记忆管理那两件，几十轮才用一次。
 *
 * 所以把它们标成"冷门组"，只在**这句话看起来要干这件事**的时候才发。
 * 三条纪律：
 *   1. 判据写在代码里（关键词），不靠模型自己声明 —— 它连 needs.net 都填不对。
 *   2. **漏判的代价必须是小的**。所以冷门组只收"用户不提就绝不会用到"的能力；
 *      读文件、铺屏、查状态这些永远常驻，宁可多花 token 也不让它"做不到"。
 *   3. 已经装好的自造工具**永远在表里**（它们不在这张表里），装完就能用。
 */
export const TOOL_GROUPS = {
  /* 造工具：一轮里能干完，但整轮只有它是主角时才需要 */
  forge: ['tool_write', 'tool_code', 'tool_try', 'tool_keep', 'skill_save', 'web_get'],
  /* 记忆管理：问"你记得什么 / 忘掉它"时才用；检索 memory_recall 常驻 */
  memAdmin: ['memory_stats', 'memory_forget'],
};

/** 这一轮**不发**给模型的工具名。`allow` 里没有的组，整组摘掉。 */
export function coldTools(allow = new Set()) {
  const drop = new Set();
  for (const [g, names] of Object.entries(TOOL_GROUPS)) {
    if (allow.has(g)) continue;
    for (const n of names) drop.add(n);
  }
  return drop;
}

/* ── 数据源：host 读本机真实数字，mock 给固定假数据（截图与自测要可复现） ── */

function hostStatus() {
  const load = os.loadavg()[0];
  const cores = os.cpus().length;
  const total = os.totalmem();
  const free = os.freemem();
  return {
    cpu: Math.min(1, load / Math.max(1, cores)),
    mem: (total - free) / total,
    cores,
    memTotal: +(total / GB).toFixed(1),
    memUsed: +((total - free) / GB).toFixed(1),
  };
}

const MOCK_STATUS = {
  cpu: 0.71, mem: 0.60, disk: 0.48, cores: 8,
  memTotal: 15, memUsed: 9,
  netIn: 1.2, netOut: 0.3,
};

const MOCK_APPS = [
  { name: 'Files', state: 'running', cpu: 0.02, mem: 0.04 },
  { name: 'Market', state: 'running', cpu: 0.01, mem: 0.03 },
  { name: 'qBittorrent', state: 'running', cpu: 0.14, mem: 0.06, note: '追剧 S03 下载中' },
  { name: 'Navidrome', state: 'running', cpu: 0.03, mem: 0.05 },
  { name: 'n8n', state: 'restarting', cpu: 0.22, mem: 0.11, note: '每小时重启一次' },
  { name: 'Vault', state: 'stopped', cpu: 0, mem: 0 },
];

const MOCK_DISK = [
  { path: '~/Downloads/ubuntu-24.04.1-desktop-amd64.iso', size: 4.9 * GB },
  { path: '~/Downloads/dataset-train-v3.tar.zst', size: 3.2 * GB },
  { path: '~/Downloads/Screencast 2026-09-14.mov', size: 2.1 * GB },
  { path: '~/Downloads/Olares-Setup-1.12.3.dmg', size: 0.8 * GB },
  { path: '~/Movies/The.Bear.S03.1080p', size: 12.4 * GB },
  { path: '~/Agent/cache/chromium-startup.log', size: 0.06 * GB },
];

const MOCK_LOGS = {
  n8n: [
    '2026-10-20T22:14:03Z start workflow "notion-sync"',
    '2026-10-20T22:14:07Z node "Notion" error: 502 Bad Gateway',
    '2026-10-20T22:14:07Z retry 1/3',
    '2026-10-20T22:15:11Z workflow failed, restarting',
    '2026-10-20T22:15:12Z OOMKilled (limit 512Mi, rss 498Mi)',
  ],
};

/* ── 场景构造：工具结果 → 给模型的"看一眼就知道"的一屏 ── */

function statusScene(s) {
  return {
    focus: 'job',
    mood: s.mem > 0.85 ? 'alert' : 'working',
    layers: [
      { id: 'cpu', kind: 'gauge', label: 'CPU', value: s.cpu },
      { id: 'mem', kind: 'gauge', label: '内存', value: s.mem },
      { id: 'disk', kind: 'gauge', label: '磁盘', value: s.disk ?? 0.48, color: '#b9a6ff' },
    ],
  };
}

/* ── 工具表 ── */

/* 校验层的两种"我说的话和你画的不一样"都要回给模型：
   dropped 是被丢弃的，adjusted 是被改写后仍然生效的。
   只挡不报，模型会以为自己成功了，然后在同一个错误上重复八次。 */
function tail(r) {
  const out = {};
  if (r.dropped?.length) out.dropped = r.dropped;
  if (r.adjusted?.length) out.adjusted = r.adjusted;
  return out;
}

/* ── 把"平坦的一个对象"展开成一屏 ──
   为什么要有这一层：6 种 kind + 每层的 id/字段，对 7B 级模型来说同时要求
   "选对编码器""起唯一的 id""填对字段名"，三件事一起做基本做不成（实测：
   它会把示例里的数字和调用原样抄出来）。而"给我三个读数和一个问题"它做得很好。
   所以高层动词只暴露**语义**，kind 与 id 全部由这里补 —— 和"几何不给模型"同一条道理。 */
function expandShow(a) {
  const layers = [];
  (a.gauges || []).slice(0, 3).forEach((g, i) => {
    layers.push({ id: `g${i + 1}`, kind: 'gauge', label: g.label, value: g.value });
  });
  if (a.trace && Array.isArray(a.trace.data) && a.trace.data.length >= 2) {
    layers.push({
      id: 'tr', kind: 'trace', label: a.trace.label, data: a.trace.data,
      ...(Array.isArray(a.trace.axis) ? { axis: a.trace.axis } : {}),
    });
  }
  if (a.note) layers.push({ id: 'note', kind: 'condense', text: a.note });

  /* 问题用三个平铺字段（ask / yes / no）而不是一个嵌套对象。
     实测：7B~29B 的模型会把嵌套的 {"label","yes","no"} 写成一句话 ——
     每多一层嵌套，它就多一次出错的机会。扁平化之后一次就对。 */
  const ask = typeof a.ask === 'object' && a.ask ? a.ask : { label: a.ask, yes: a.yes, no: a.no };
  if (ask.label && ask.yes && ask.no) {
    layers.push({
      id: 'ask', kind: 'fork', label: ask.label,
      options: [{ id: 'yes', label: ask.yes }, { id: 'no', label: ask.no }],
    });
  }
  return {
    focus: ask.label ? 'ask' : layers[0]?.id,
    mood: a.mood || (ask.label ? 'working' : 'calm'),
    layers,
  };
}

/* ── 兜底的一屏：系统自己铺 ──
 *
 * 这是这套东西里最容易引起争议的一处，所以说清楚它为什么存在：
 *
 * 实测四个免费模型（Qwen2.5-7B / Qwen3.5-4B / Qwen3.5-9B / GLM-4-9B / Xing-29B），
 * 它们**都会**看数据，但经常在该铺屏的时候停住不铺，或者铺一半。结果就是
 * 用户问了"机器怎么卡"，屏幕上什么都没有 —— 这不是"模型能力差"能解释掉的，
 * 是接口假设了模型有很强的多步规划能力。
 *
 * 所以分层：**看什么由模型决定，怎么长成屏幕由系统负责。**
 * 这和"几何不给模型"是同一条原则的延伸 —— 一屏的基本形状（三个仪表 + 一句结论
 * + 一个可选的问题）本来就是系统的 affordance，不是每个回合都要重新发明的表达。
 * 模型想表达更多时，它自己调 scene_show 覆盖掉这一屏。
 */
export function defaultOverview(status = {}, apps = [], reading = '', trend = null, o = {}) {
  let gauges = [];
  let note;

  if (status.cpu != null) {
    gauges = [{ label: 'CPU', value: status.cpu }, { label: '内存', value: status.mem }];
    if (status.disk != null) gauges.push({ label: '磁盘', value: status.disk });
  } else if ((apps || []).length) {
    /* 只有应用数据、没有节点读数 —— "我装了哪些应用"就是这种情况。
       这时仪表该量什么？量**每个应用占了多少内存**：
       圆环大小=占比，标签=应用名。这是编码器能表达的、最接近答案的形状。
       （不能拿"装了 3 个"去填一个 0~1 的仪表，那不是比例。） */
    /* 标签**不截**：`navidrome` 截成 4 字符就是 `navi`，用户认不出是哪个应用。
       宽度的活交给前端 `fitLabel`（按 px 算，竖排 120px 放得下 `qbittorrent`）——
       在这里按字数切，切掉的正是"这块表说的是谁"那部分信息。 */
    gauges = apps.slice(0, 3).map((a) => ({ label: String(a.name), value: a.memPct ?? 0 }));
    /* 这里**不要**再加一句 note。
       兜底屏的 reading 本身就会以 say 的形式说出来（"3 个应用在跑"），
       再挂一个内容相同的 condense，屏幕上就是同一句话出现两次 ——
       一行在底部、一行在场中间。实测看起来像渲染重影，其实是冗余。 */
  }

  const bad = (apps || []).find((a) => a.state === 'restarting');
  const args = { reading, gauges };
  if (note) args.note = note;
  /* 兜底屏也要有一条真曲线。
   *
   * 用户问"怎么有点卡"，三个此刻的读数其实回答不了 —— 卡是个随时间的问题。
   * 而这条曲线**本来就已经取到了**（Prometheus 里一直有），
   * 没有理由因为模型这一轮没想起来画 trend 就不给。 */
  if (trend && Array.isArray(trend.data) && trend.data.length >= 2) args.trace = trend;
  if (bad) {
    args.ask = `要看看 ${bad.name} 吗`;
    args.yes = '看看日志';
    args.no = '先看着';
  }
  const r = normalizeSpec(expandShow(args));
  return r.spec ? { spec: r.spec, say: reading } : null;
}

/** 给 server 用的：把 scene_show 的参数直接变成一屏（兜底路径复用同一条展开逻辑） */
export function buildShow(args) {
  const r = normalizeSpec(expandShow(args || {}));
  return r.spec ? { spec: r.spec, say: args?.reading || '' } : null;
}

export function makeTools(o = {}) {
  const source = o.source || 'host';
  const memory = o.memory || null;
  /* 官方 olares-cli 的封装（见 agent/olares.mjs）。
     由 server 注入：它要在启动时探一次"这个镜像里有没有这个二进制"。 */
  const olares = o.olares || null;
  const forge = o.forge || null;
  /* 官方技能包（见 agent/skills.mjs）。名字表是异步索引，启动时由 server 预热；
     没预热到时 schema 里退化成只有一个名字 —— 模型不会因此调到空东西。 */
  const skills = o.skills || null;
  const skillNames = skills ? skills.names() : [];
  const T = {};
  const add = (name, def) => { T[name] = { name, ...def }; };
  /* 自造工具是**运行时**长出来的：这一轮刚 tool_keep 一个，下一轮就该能用。
     所以它们单独放一个表，reload() 负责同步 —— 已装的加进来，被删掉的摘出去。 */
  const D = new Set();
  /* 最近动过的自造工具名。
     实测 7B 会把 tool_keep 调成 `{}` —— 一个字都没填。它明明刚刚试跑成功，
     只是没把名字带过来。这种时候系统知道它指的是哪个：只有一个草稿刚被动过。
     让用户因为"模型忘了填名字"而多等一轮，不值。 */
  let lastTool = '';
  let drafts = [];         // 当前草稿名（reload 时刷新），给"只填了 {}"的调用兜底


  /* 真实集群采集器。构造失败不致命 —— 退回本机读数，
     但一定要在日志里说出来：静默降级会让人以为"集群数据就是这样的"。 */
  let cluster = null;
  if (source === 'k8s') {
    try {
      cluster = createK8s({ ttl: o.ttl ?? 5000 });
      console.log('[source] 集群采集器就绪：' + cluster.info());
    } catch (e) {
      console.warn('[source] 集群采集器不可用，退回本机读数：' + e.message);
    }
  }

  /* 用户文件。挂的是宿主机的 /olares/rootfs/userspace —— 也就是 Files 应用
     自己用的那个目录，所以 ~/Documents 和用户在 Files 里看到的是同一批文件，
     不是模拟。没挂上就诚实说看不到，绝不拿假列表糊弄：用户会照着删。 */
  let files = null;
  if (process.env.FS_ROOT) {
    try {
      files = createFs({ root: process.env.FS_ROOT });
      console.log('[source] 用户目录已挂载：' + process.env.FS_ROOT);
    } catch (e) {
      console.warn('[source] 用户目录不可用：' + e.message);
    }
  }
  const noFs = () => ({
    error: '这台机器上还没挂用户目录，看不到文件。别猜文件名，直接告诉用户这一块还没接。',
  });

  /* ── Olares 系统层（官方 CLI） ──
   *
   * **一个工具 + op 枚举**，不是十几个平铺工具：每个工具的 schema 进上下文约 150 token，
   * 32k 窗口里最贵的就是这块。而模型记得住"olares 能查系统"，记不住十二个名字。
   *
   * 数据全部来自官方 `olares-cli -o json`，和 Olares 自己的设置页 / 市场页是同一份。
   * 所以"我装了哪些应用、什么版本、n8n 从哪进"这类问题，答案不该由 k8s 拼出来。
   */
  add('olares', {
    level: 'safe',
    describe: '查这台 Olares 的系统层（官方 CLI 的口径）：装了哪些应用/版本/状态/来源、'
      + '市场里有什么可装、某个应用的配置与入口、整机负载、谁在吃资源、用户、pod 与事件、'
      + '镜像占盘、备份计划、当前 K8s 视野。'
      + '**问"我装了哪些应用""n8n 从哪进""机器忙不忙"先调它** —— 不要自己从 pod 拼，'
      + '那会漏掉版本号和入口地址。op 不够用时用 skill_use 看这个系统还能干什么。',
    schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: OPS, description: OP_DOC },
        name: { type: 'string', description: 'op=app / appcfg / appinfo / events 时必填：应用名或 pod 名，例如 n8n' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    run: async ({ op, name } = {}) => {
      if (!olares) {
        return { error: '这台机器上没有 olares-cli（镜像里没装）。改用 sys_status / app_list 回答，并且告诉用户"系统层还没接"。' };
      }
      return await olares.read(op, name);
    },
  });

  /* ── 写操作：单独一个工具，**不给 op 枚举混在读里** ──
   *
   * 为什么不复用 olares 的 op 枚举：那个工具的 level 是 safe，而审批门是按
   * **工具名**判 level 的（`s.tools.level(name)`）。把一个 danger 动词混进 safe 的
   * 枚举里，等于给自己开一个"看参数决定要不要审批"的口子 —— 那种判据迟早会漏。
   * 分成两个工具，谁危险一眼就能看出来，schema 也短。
   */
  add('olares_act', {
    level: 'danger',
    describe: '**改变这台机器**的动作：停/开/重启/装/升级/卸载一个应用，或取消正在进行的操作。'
      + '只有用户**明确让你做**的时候才调（"帮我停掉 n8n"）；他只是问情况、问有没有问题时，'
      + '一个都不要调 —— 先回答，再问要不要动手。每次调用都会让用户点头。',
    schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ACTS, description: ACT_DOC },
        name: { type: 'string', description: '应用名（op=cancel 时不用给）例如 n8n / navidrome' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    run: async ({ op, name } = {}) => {
      if (!olares) {
        return { error: '这台机器上没有 olares-cli，改不了任何东西。照实告诉用户。' };
      }
      if (!olares.act) return { error: '这个版本还没接写操作。' };
      const r = await olares.act(op, name);
      /* 写完之后"屏幕上那些读数"全都过期了：下一次 sys_status 会重取，
         但这一轮已经铺出去的屏不会自己变 —— 让模型知道该重铺。 */
      if (r && !r.error) {
        return { ...r, next: '这一屏的读数是写之前的。要展示新状态就重新调 olares 的 apps/app。' };
      }
      return r;
    },
  });

  /* ── 官方技能（12 份 SKILL.md 编在 olares-cli 里） ──
   *
   * 这不是"再学一遍 olares 怎么用"：它是**动词表**。op 枚举是我们允许执行的，
   * 技能文档是这台机器真有的。两者不一致时，至少要能对用户说清楚差在哪 ——
   * 之前它只会说"我查不了"，而系统明明有 `market upgrade`。
   *
   * 展开后约 2k 字符（英文），**读完就该用掉**：所以返回里带一句"现在用 olares 执行"。
   */
  add('skill_use', {
    level: 'safe',
    describe: '展开一份 Olares 官方技能，看这个系统到底有哪些动词、某个症状该按什么顺序查。'
      + '当 olares 的 op 不够用、或者要排障（装不上/起不来/打不开/慢）时先展开，再动手。'
      + '不要凭印象猜命令。',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: skillNames.length ? skillNames : ['olares-shared'],
          description: '技能名。market=应用商店 · settings=设置 · dashboard=指标 · cluster=容器 · '
            + 'doctor=排障 · files=文件 · router=模型网关 · search=全局搜索 · backup 在 settings 里',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async ({ name } = {}) => {
      if (!skills) return { error: '这个镜像里没有技能包（构建时没 export）。直接按 olares 的 op 回答。' };
      const r = await skills.read(name);
      if (r.error) return r;
      /* 技能文档是**动词表**，op 是**能执行的那一小撮**。两个都递过去，
         模型才知道"这个系统能干这件事，但现在我只能看到这几样"。 */
      return {
        name: r.name,
        doc: r.doc,
        ops: r.ops,
        hint: r.ops.length
          ? `这些场合现在能用 olares 的 ${r.ops.join(' / ')} 完成；文档里别的动词还没接，别自己编命令。`
          : '这块能力还没接（规则见文档，但这里执行不了）。照实告诉用户，不要现场编命令。',
      };
    },
  });

  add('sys_status', {
    level: 'safe',
    describe: '读一次系统状态：CPU、内存、磁盘的真实占用，谁在吃内存（top），'
      + '以及用户装的应用各自什么状态。返回 0~1 的比例，不是百分数。'
      + '问"机器怎么样/卡不卡/哪个应用出问题了"，这一个工具就够了。',
    schema: {
      type: 'object',
      properties: {
        includeSystem: { type: 'boolean', description: '应用列表里连系统组件一起看，缺省 false' },
      },
      additionalProperties: false,
    },
    run: async ({ includeSystem } = {}) => {
      if (source === 'mock') {
        return { ...MOCK_STATUS, apps: MOCK_APPS.map((a) => ({ name: a.name, state: a.state, memPct: a.mem })) };
      }

      if (cluster) {
        const s = await cluster.nodeMetrics();
        const totalMB = (s.memTotal || 15.6) * 1024;
        /* 应用状态**在这里一起取**，不再单独一个 app_list。
         *
         * 理由不是"少一个工具"，是**少一次往返**：每多一次工具调用，就要把
         * 整份上下文（此刻 9.5k token）重新发一遍。"机器怎么样"这类问题
         * 天然需要"指标 + 应用"两样，分两次问等于为同一份上下文付两遍钱。
         * 实测：合并前这类问题稳定跑 2~3 步，合并后 1 步就能铺屏。
         *
         * `top` 只给前 5 条、名字去后缀：模型要的是"谁在吃"，不是集群清单。
         * 给全量只会让它照着念一遍 pod 名字。
         * **memPct 必须给**：实测模型拿到 memMB=382 之后，会自己"换算"成
         * value:0.382 塞进仪表 —— 屏幕上显示 38%，而它其实只占 2.4%。
         * 单位对不上时模型不会问，它会直接除个 1000。 */
        const apps = await cluster.apps({ includeSystem: !!includeSystem })
          .then((r) => r.apps.map((a) => ({
            name: a.name, state: a.state, restarts: a.restarts,
            memPct: a.memMB ? +(a.memMB / totalMB).toFixed(3) : 0,
          })))
          .catch(() => null);
        return {
          cpu: s.cpu, mem: s.mem, disk: s.disk,
          memTotal: s.memTotal, memUsed: s.memUsed, memFree: s.memFree,
          top: s.top.slice(0, 5).map((r) => ({
            name: r.name,
            memMB: r.memMB,
            memPct: +(r.memMB / totalMB).toFixed(3),
            cpu: +r.cpu.toFixed(3),
          })),
          apps,
          src: 'olares',
        };
      }

      const s = hostStatus();
      let disk = 0.48;
      try {
        const st = await fs.statfs('/');
        disk = 1 - st.bavail / st.blocks;
      } catch { /* 有些平台没有 statfs，退回缺省值 */ }
      return { ...s, disk, netIn: 0, netOut: 0 };
    },
  });

  /* 单独的应用列表。**不再发给模型**（hidden）—— sys_status 已经带着它。
     留着是因为旧会话/旧提示词里还有它的名字，exec 认；也方便人工调试。 */
  add('app_list', {
    level: 'safe',
    describe: '列出用户装了的应用，以及各自的状态、占用时长、吃多少内存。'
      + '不含 Olares 自己的系统组件。注意：这是**内存/CPU**，不是磁盘；'
      + '问"什么占地方"要用 fs_scan。',
    schema: {
      type: 'object',
      properties: {
        includeSystem: { type: 'boolean', description: '连系统组件一起看，缺省 false' },
      },
      additionalProperties: false,
    },
    run: async ({ includeSystem } = {}) => {
      /* 优先官方 CLI：它能给版本号、来源、市场分类，而 k8s 只能给"pod 在不在"。
         失败（没装 / 没授权）才回落到老的 k8s 口径 —— 回落要在返回值里说出来，
         否则模型会把"两份数据的差别"当成用户的应用变了。 */
      if (olares) {
        const r = await olares.read('apps');
        if (!r.error) return { ...r, source: 'olares-cli' };
        if (!cluster) return r;            // 没有 k8s 兜底时，把 CLI 的错原样交给模型
      }
      if (!cluster) return { apps: MOCK_APPS };
      const r = await cluster.apps({ includeSystem: !!includeSystem });
      const st = await cluster.nodeMetrics().catch(() => null);
      const totalMB = (st?.memTotal || 15.6) * 1024;
      /* 只把"是什么状态、吃多少"给模型；ns / pod / owner 是给 logs 工具解析用的，
         模型看了会照抄进 label，把一屏塞满 k8s 术语。
         memPct 是相对总内存的比例 —— 见 sys_status 里那段注释。 */
      return {
        apps: r.apps.map((a) => ({
          name: a.name, state: a.state, ready: a.ready,
          restarts: a.restarts, memMB: a.memMB,
          memPct: a.memMB ? +(a.memMB / totalMB).toFixed(3) : 0,
          upH: a.upH,
        })),
      };
    },
    hidden: true,
  });

  /* ── 文件：读 ──
   *
   * 这一组是"操作者"成立的地方。之前 fs_scan 在真集群上直接回"还没接"，
   * 因为文件在 PVC 里；现在把 userspace 挂进来了，看到的就是真文件。
   *
   * 路径一律先归一化：~ / 裸名字（当 Home 下找）/ 绝对路径都收，
   * 但解析完必须还在用户空间里 —— 越界直接拒，不"尽力而为"。 */
  add('fs_scan', {
    level: 'safe',
    describe: '按体积看某个目录里什么最占地方。回答"什么在吃我的盘"用它。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录，例如 ~/Downloads。缺省 ~' },
        limit: { type: 'integer', description: '最多几条，缺省 8' },
      },
      additionalProperties: false,
    },
    run: async ({ path = '~', limit = 8 } = {}) => {
      if (!files) return noFs();
      try { return await files.du(path, { limit: Math.min(20, limit), depth: 2 }); } catch (e) {
        return { error: String(e.message || e) };
      }
    },
  });

  add('fs_list', {
    level: 'safe',
    describe: '看一个目录里有什么（名字、大小、日期）。'
      + '用户说"我下载了什么"、"Documents 里有什么"时用它。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录，例如 ~/Downloads。缺省 ~' },
        limit: { type: 'integer', description: '最多几条，缺省 40' },
        sort: { type: 'string', enum: ['size', 'time'], description: 'size 大的在前 / time 新的在前' },
      },
      additionalProperties: false,
    },
    run: async ({ path = '~', limit = 40, sort = 'size' } = {}) => {
      if (!files) return noFs();
      try { return await files.list(path, { limit: Math.min(200, limit), sort }); } catch (e) {
        return { error: String(e.message || e) };
      }
    },
  });

  add('fs_read', {
    level: 'safe',
    describe: '读一个文本文件的内容（默认前 64KB）。日志、配置、md 都能读；二进制会如实拒绝。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，例如 ~/Documents/notes.md' },
        maxBytes: { type: 'integer', description: '最多读多少字节，缺省 65536' },
        lines: { type: 'integer', description: '只看前 N 行（可选）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async ({ path, maxBytes, lines }) => {
      if (!files) return noFs();
      try {
        return await files.read(path, {
          maxBytes: Math.min(256 * 1024, maxBytes || 64 * 1024),
          lines: lines || 0,
        });
      } catch (e) { return { error: String(e.message || e) }; }
    },
  });

  add('fs_search', {
    level: 'safe',
    describe: '按文件名找东西（不搜内容）。用户说"那个 pdf 在哪"用它。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '名字片段，例如 账单 或 .pdf' },
        path: { type: 'string', description: '从哪个目录开始找，缺省 ~' },
        limit: { type: 'integer', description: '最多几条，缺省 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: async ({ query, path = '~', limit = 20 }) => {
      if (!files) return noFs();
      try { return await files.search(query, { path, limit: Math.min(50, limit) }); } catch (e) {
        return { error: String(e.message || e) };
      }
    },
  });

  /* ── 文件：写（都过审批门） ── */

  add('fs_write', {
    level: 'danger',
    describe: '写一个文本文件（会新建，默认覆盖）。要用户先同意 —— 审批门会问他。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，例如 ~/Documents/todo.md' },
        content: { type: 'string', description: '文件内容' },
        overwrite: { type: 'boolean', description: '已存在时是否覆盖，缺省 true' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    run: async ({ path, content, overwrite }) => {
      if (!files) return noFs();
      try { return await files.write(path, content, { overwrite: overwrite !== false }); } catch (e) {
        return { error: String(e.message || e) };
      }
    },
  });

  add('fs_move', {
    level: 'danger',
    describe: '把文件或目录移到另一个位置。to 是已有目录时放进去（和 mv 一样）。要用户先同意。',
    schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径' },
        to: { type: 'string', description: '目标路径或目录' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    run: async ({ from, to }) => {
      if (!files) return noFs();
      try { return await files.move(from, to); } catch (e) { return { error: String(e.message || e) }; }
    },
  });

  add('fs_delete', {
    level: 'danger',
    describe: '把一个文件或目录挪进 ~/.trash（删得回来）。要用户先同意。',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '要删的路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    run: async ({ path }) => {
      if (!files) return noFs();
      try { return await files.trash(path); } catch (e) { return { error: String(e.message || e) }; }
    },
  });

  add('logs_tail', {
    level: 'safe',
    describe: '看某个应用最近的日志。回答"它为什么挂了"之前先看这个。',
    schema: {
      type: 'object',
      properties: { app: { type: 'string' }, lines: { type: 'integer' } },
      required: ['app'],
      additionalProperties: false,
    },
    run: async ({ app, lines }) => {
      if (!cluster) return { app, lines: MOCK_LOGS[app] || ['(no logs)'] };
      return cluster.logs(app, { lines: Math.min(120, lines || 40) });
    },
  });

  add('k8s_get', {
    level: 'safe',
    describe: '查一个应用**为什么没起来**：pod 阶段、容器 waiting/terminated 原因、'
      + 'conditions、最近事件。日志给的是结果，这个给的才是原因 —— '
      + '回答"xx 起不来"之前先调它，再决定要不要看日志。',
    schema: {
      type: 'object',
      properties: { app: { type: 'string', description: '应用名，例如 qbittorrent' } },
      required: ['app'],
      additionalProperties: false,
    },
    run: async ({ app }) => {
      if (!cluster) return { error: '没有集群数据源（SYS 不是 k8s）' };
      try { return await cluster.diagnose(app); } catch (e) { return { error: String(e.message || e) }; }
    },
  });

  add('k8s_restart', {
    level: 'danger',
    describe: '重启一个应用（删掉它的 pod，控制器会重新拉起）。会中断它正在做的事，要用户先同意。',
    schema: {
      type: 'object',
      properties: { app: { type: 'string', description: '应用名' } },
      required: ['app'],
      additionalProperties: false,
    },
    run: async ({ app }) => {
      if (!cluster) return { error: '没有集群数据源（SYS 不是 k8s）' };
      try { return await cluster.restart(app); } catch (e) { return { error: String(e.message || e) }; }
    },
  });

  add('mem_trim', {
    level: 'danger',
    describe: '把内存占用压到目标比例。会重启占内存最多的那个应用，可能中断它正在做的事。',
    schema: {
      type: 'object',
      properties: { to: { type: 'number', description: '目标比例 0~1' } },
      required: ['to'],
      additionalProperties: false,
    },
    run: async ({ to }) => {
      /* 接了真集群之后这里必须诚实：真机上"把内存压到某个比例"没有对应的系统动作，
         能做的只有重启应用，而重启**不保证**压到目标值。
         拿 mock 的算数糊弄过去，用户会真的以为内存被压下去了。 */
      if (cluster) {
        const s = await cluster.nodeMetrics();
        return {
          error: `真实集群上还没接"降内存"动作。当前 ${(s.mem * 100).toFixed(0)}%，`
            + `能做的只有重启应用（如 n8n），但重启不保证压到你给的目标值。`,
          now: s.mem,
        };
      }
      const from = MOCK_STATUS.mem;
      return { from, to, freedGB: +((from - to) * MOCK_STATUS.memTotal).toFixed(1), restarted: 'n8n' };
    },
  });

  /* ── 长期记忆 ──
   * 记忆不是"再给模型一个数据库"：抽取在每轮结束时自动发生（memory.mjs），
   * 这里的三个工具只负责**人主动问起来**的场合。
   * 少了它们，用户问"你记得我上次说什么吗"就只能靠系统提示里那几行，
   * 而模型一旦想不起细节就会开始编 —— 编历史比忘事坏得多。 */
  const noMem = () => ({ error: '这台机器上记忆还没起来（记忆库没打开）。如实说"我现在想不起来"。' });

  add('memory_recall', {
    level: 'safe',
    describe: '去长期记忆里定向查一件事。用户问"我以前说过…吗""上次那个…"时用它。'
      + ' 它按关键词和图上的邻近关系取，不是把全部记忆倒出来。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的东西，用用户话说，例如 "n8n 端口"' },
        k: { type: 'number', description: '要几条，默认 5，最多 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: async ({ query, k } = {}) => {
      if (!memory) return noMem();
      const n = Math.min(8, Math.max(1, Number(k) || 5));
      const r = await memory.recall(String(query || ''), n);
      if (!r.facts.length) return { ok: true, found: 0, note: '记忆里没有相关的东西。不要编。' };
      return {
        ok: true,
        found: r.facts.length,
        facts: r.facts.map((f) => ({ text: f.text, when: f.when, about: f.about })),
      };
    },
  });

  add('memory_stats', {
    level: 'safe',
    describe: '看记忆里都有什么：多少条、哪些主题、最近记住了什么、上次巩固剪掉了什么。'
      + ' 用户问"你记得什么""最近在忙什么"时用它，然后铺一屏给他看。',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      if (!memory) return noMem();
      const s = await memory.stats();
      /* 只回可读的那部分。节点 id、权重这些是给巩固用的，进上下文只是噪音。 */
      return {
        ok: true,
        facts: s.facts,
        entities: s.entities,
        communities: s.communities,
        pruned: s.pruned,
        themes: s.themes,
        recent: s.recent,
        last: s.last,
      };
    },
  });

  add('memory_forget', {
    level: 'danger',
    describe: '把某件事从长期记忆里删掉（软删，能捞回来）。用户说"忘了这件事"时才用。',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '要忘掉的那件事，用用户的话说' } },
      required: ['query'],
      additionalProperties: false,
    },
    run: async ({ query }) => {
      if (!memory) return noMem();
      const r = await memory.forget(String(query || ''));
      if (!r.forgotten.length) return { ok: true, forgotten: [], note: '没找到对应的记忆' };
      return { ok: true, forgotten: r.forgotten };
    },
  });

  /* 输出通道也是工具 —— 它们不改变世界，只改变"看见什么"。所以都是 safe。
     但"看见什么"同样要过边界：spec 来自模型，是不可信输入（见 scene.schema.mjs）。 */

  /* ── 高层动词：给便宜模型用的 ──
     字段全平、全部可选，不用起 id、不用选 kind。想精确控制再用下面的 scene_set。 */

  add('scene_show', {
    level: 'safe',
    describe: '铺一屏，或换一屏。这是最常用的输出方式：把要说的话和要显示的读数一次给它。'
      + ' reading 是**你的回答**，会上屏给人读：2~5 句，先给结论再给依据，200~400 字都正常'
      + '（一页 400 字，超了自动分页）。**不要把回答写成一行读数** —— 数字由 gauges 承载，'
      + ' reading 写判断、原因和下一步。 gauges 是此刻的几个比例（最多 3 个）；note 是一句结论；'
      + ' ask 是一个问题 + 两个选项，用户点哪个系统会告诉你。',
    schema: {
      type: 'object',
      properties: {
        reading: { type: 'string', description: '你的回答，会上屏给人读。2~5 句，先结论再依据。例如 "机器不忙：CPU 只有 3%，内存 62% 里大半是页面缓存。真正在动的是 n8n，它刚重启过一次，可能有工作流在刷错误。要不要看它的日志？"。不要只写 "CPU 3% · 内存 62%" 这样一行读数。' },
        gauges: {
          type: 'array',
          description: '最多 3 个',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '应用名或指标名，≤12 字。**应用要写真名**（navidrome，不是 navi）——缩写用户认不出是哪个' },
              value: { type: 'number', description: '0~1 的比例，不是百分数' },
            },
            required: ['label', 'value'],
            additionalProperties: false,
          },
        },
        trace: {
          type: 'object',
          description: '一段随时间变化的曲线（可选）。**优先用 trend，别自己编 data**',
          properties: {
            label: { type: 'string', description: '≤12 字' },
            data: { type: 'array', items: { type: 'number' }, description: '2~280 个 0~1 的数，左旧右新' },
          },
          required: ['label', 'data'],
          additionalProperties: false,
        },
        trend: {
          type: 'string',
          enum: ['cpu', 'mem', 'disk'],
          description: '要看哪个指标最近一小时的走势。填了它由系统取真实曲线，你不用给 data',
        },
        note: { type: 'string', description: '一句结论，≤20 字（可选）' },
        ask: { type: 'string', description: '要问用户的那句话，≤30 字（屏幕上最多两行，可选）。填了它就必须同时填 yes 和 no' },
        yes: { type: 'string', description: '左边那个选项，≤8 字' },
        no: { type: 'string', description: '右边那个选项，≤8 字' },
        mood: { type: 'string', enum: ['calm', 'working', 'alert'] },
      },
      additionalProperties: false,
    },
    run: async (a) => {
      /* 形状不对就明说，别静默丢掉。实测：模型会把 ask 写成一句话而不是
         {label, yes, no}；如果这里只是忽略，用户看到的是"屏幕上少了一个问题"，
         而模型以为自己做对了 —— 两边都不知道出了什么事。 */
      if (a.ask != null && typeof a.ask === 'object') a = { ...a, ...a.ask, ask: a.ask.label };
      if (a.ask != null && (!a.yes || !a.no)) {
        return { error: '要问问题就要同时给三个字段：ask（问题）、yes（左边选项）、no（右边选项）' };
      }
      if (a.gauges != null && !Array.isArray(a.gauges)) {
        return { error: 'gauges 要是数组：[{"label":"CPU","value":0.04}]' };
      }

      /* trend → 真曲线。
       *
       * 为什么不让模型自己填 data：一条 60 点的曲线，它要么编（编出来的形状
       * 看起来很像真的，这是最坏的情况），要么占掉几百 token 还抄错。
       * 而"曲线长什么样"和"几何长什么样"是同一类东西 —— 属于渲染层，
       * 不属于语义层。模型只需要说**看哪个指标**。
       * 和"id 不给模型起、kind 不给模型选"是同一条原则。 */
      if (a.trend && !a.trace) {
        if (!cluster) {
          return { error: '当前没有接集群，trend 取不到真实曲线。想画曲线就直接给 trace.data' };
        }
        try {
          const data = await cluster.series(a.trend, { minutes: 60, points: 60 });
          if (data.length >= 2) {
            const name = { cpu: 'CPU', mem: '内存', disk: '磁盘' }[a.trend] || a.trend;
            /* axis 固定 0~100%：这是**百分比负载**，不是随便一条曲线。
               自适应标度会把 40%→41% 画成剧烈波动，看起来像出事了；
               而屏幕上三个仪表写的就是百分比，两者必须能对上。 */
            a = { ...a, trace: { label: `${name} 一小时`, data, axis: [0, 1] } };
          }
        } catch (e) {
          return { error: `取 ${a.trend} 的走势失败：${e.message}` };
        }
      }

      const r = normalizeSpec(expandShow(a));
      if (!r.spec) return { ok: false, error: '这一屏什么都没有：至少要给 reading / gauges / note / ask 里的一个' };
      return {
        ok: true, op: 'set', spec: r.spec,
        /* reading 走 say 通道下发：这样那句话不经过模型的自由文本，
           长度和换行都由协议保证，而不是求它"别写太长"。 */
        ...(a.reading ? { say: a.reading } : {}),
        ...tail(r),
      };
    },
  });

  add('scene_ask', {
    level: 'safe',
    describe: '把场上的那个问题换成新的一句（不动其他任何东西）。'
      + ' 用户拖了仪表、你还没得到他确认时，用它把"要不要这么做"问出来。',
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '问题，≤30 字（屏幕上最多两行）' },
        yes: { type: 'string', description: '左边选项，≤8 字' },
        no: { type: 'string', description: '右边选项，≤8 字' },
      },
      required: ['label', 'yes', 'no'],
      additionalProperties: false,
    },
    run: async ({ label, yes, no }) => {
      const r = normalizeOps([{ id: 'ask', label, options: [{ id: 'yes', label: yes }, { id: 'no', label: no }] }]);
      if (!r.ops) return { ok: false, error: '问题或选项不合法', dropped: r.dropped };
      return { ok: true, op: 'patch', ops: r.ops, ...tail(r) };
    },
  });

  /* 铺屏 / 换屏是**同一个工具的两个模式**，不是两个工具。
   *
   * 分开写的时候，两份 `spec` 的 JSON schema 一字不差地各占一份 ——
   * 光是重复就多烧 470 token（每次调用、每一步都发）。
   * 更糟的是它给模型多了一个"选哪个"的决策点，而这个决策它经常选错：
   * 第一屏用了 transition（空场溶解，什么都看不见），换景却用了 set（硬切）。
   * 现在只有一个 op 枚举，选错的代价变小，语义也回来了：
   * **第一屏用替换，之后用换景**是这个系统的规则，不该由模型每轮重猜。 */
  add('scene_set', {
    level: 'safe',
    describe: '铺一整屏（替换当前所有内容），或者换一整屏（溶解 → 重组）。'
      + '第一屏用缺省的 replace；已经有内容、要换景时填 transition。',
    schema: {
      type: 'object',
      properties: {
        spec: SPEC_SCHEMA,
        op: {
          type: 'string',
          enum: ['replace', 'transition'],
          description: '缺省 replace（第一屏）；已经有一屏、要换掉它时用 transition',
        },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    run: async ({ spec, op }) => {
      const r = normalizeSpec(spec);
      if (!r.spec) return { ok: false, error: 'spec 没有可用的 layer', dropped: r.dropped };
      return { ok: true, op: op === 'transition' ? 'transition' : 'set', spec: r.spec, ...tail(r) };
    },
  });

  add('scene_patch', {
    level: 'safe',
    describe: '只改值，不重排。指标刷新、进度推进、换一句问话都走这个。'
      + ' 不能新建 layer，也不能改 kind —— 要加东西用 scene_set 的 transition。',
    schema: { type: 'object', properties: { ops: OPS_SCHEMA }, required: ['ops'], additionalProperties: false },
    run: async ({ ops }) => {
      const r = normalizeOps(ops);
      if (!r.ops) return { ok: false, error: 'ops 没有可用的改动', dropped: r.dropped };
      return { ok: true, op: 'patch', ops: r.ops, ...tail(r) };
    },
  });

  add('scene_pulse', {
    level: 'safe',
    describe: '一次物理动作，让某个 layer 震一下。confirm 是"成了"，arrive 是"看这里"，'
      + 'error 是"出事了"，settle 是"落定"。同一轮里最多发一次。',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: PULSES },
        at: { type: 'string', description: '震哪个 layer 的 id' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    run: async ({ kind, at }) => ({ ok: true, op: 'pulse', ...normalizePulse({ kind, at }) }),
  });

  add('scene_transition', {
    level: 'safe',
    describe: '旧名字，等价于 scene_set{op:"transition"}。不要再调它，用 scene_set。',
    schema: { type: 'object', properties: { spec: SPEC_SCHEMA }, required: ['spec'], additionalProperties: false },
    run: async ({ spec }) => {
      const r = normalizeSpec(spec);
      if (!r.spec) return { ok: false, error: 'spec 没有可用的 layer', dropped: r.dropped };
      return { ok: true, op: 'transition', spec: r.spec, ...tail(r) };
    },
    /* 不发给模型：它只是给旧脚本 / 旧会话留的入口。
       工具表按 `hidden` 过滤掉，但 invoke 仍然认这个名字。 */
    hidden: true,
  });

  /* ── 输出通道之二：渲染树（DOM）──
   *
   * 场装不下"要读进去"的东西：表格、清单、代码、表单。这些都是 DOM 的活，
   * 但模型不能给 HTML —— 渲染发生在我们自己的 origin 里，一段 script 标签
   * 就等于把 cookie 交出去。所以它只描述「这是什么」，版式由 surface.js 决定。
   *
   * 三条硬规则：动作只能指向已注册工具、数据必须内联、节点预算 200
   * （超了渲染器会截断并明说）。
   */
  add('surface_render', {
    level: 'safe',
    describe: '给用户看一块"要读进去"的内容：表格、清单、代码、表单、进度。'
      + '表格/清单/代码用它；要看一眼就知道的（几个比例、趋势、二选一）用 scene_show。'
      + 'root 是一棵节点树，节点类型只有：text / code / table / list / chart / progress / approval / actions / form / box。',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题，≤20 字' },
        subtitle: { type: 'string', description: '副标题，一行说明（可选）' },
        root: {
          type: 'object',
          description: '根节点。table:{"type":"table","head":["名字","大小"],"rows":[["a","1"]]} · '
            + 'text:{"type":"text","md":"..."} · list:{"type":"list","items":["一条","另一条"]} · '
            + 'code:{"type":"code","lang":"js","text":"..."} · '
            + 'chart:{"type":"chart","kind":"bars","data":[0.3,0.8],"labels":["一","二"]} · '
            + 'progress:{"type":"progress","value":0.6,"label":"..."} · '
            + 'actions:{"type":"actions","items":[{"label":"删掉","tool":"fs_scan"}]} · '
            + 'form:{"type":"form","fields":[],"submit":"..."} · 容器:{"type":"section","title":"...","children":[]}',
        },
      },
      required: ['root'],
      additionalProperties: false,
    },
    run: async ({ title, subtitle, root }) => {
      if (!root || typeof root !== 'object') return { ok: false, error: 'root 必须是节点对象' };
      /* 体积守门：渲染树是内联数据，超过 24KB 的屏一定是有东西写错了
         （比如把整个文件贴进表格里）。 */
      const bytes = Buffer.byteLength(JSON.stringify(root), 'utf8');
      if (bytes > 24 * 1024) {
        return { ok: false, error: `渲染树太大（${Math.round(bytes / 1024)}KB）。表格只放结论行，别贴原始数据。` };
      }
      return { ok: true, surface: { title, subtitle, root } };
    },
  });

  add('surface_close', {
    level: 'safe',
    describe: '收起当前那块渲染树内容。用户问下个问题时它自己也会收，所以只有"明确要收"才用。',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ ok: true, closeSurface: true }),
  });

  /* ── 输出通道之三：粒子绘画 ──
   *
   * 这套桌面独有的东西：模型说"画个笑脸"，桌面本身的 6400 颗粒子聚成脸。
   * 三级表达里只给**语义层**：模型给 mood / 文字 / 数据，几何由 painter 算。
   * 绝不让它给像素坐标 —— 它算不准，画布尺寸也轮不到它知道。
   */
  add('draw', {
    level: 'safe',
    describe: '用桌面自己的粒子画一幅画（解释类问题首选）。'
      + '层类型：stencil（具象图形，给 name）/ face（表情，给 mood）/ text（字）/ '
      + 'chart（柱状或折线，给 data）/ arrow / line / polyline / circle / rect / path。'
      + '**要画具体的东西一律先看 stencil**：name 有 dog / cat / house / tree / star / '
      + 'heart / check / cross / arrow / sun / cloud / person，图形是画好的，一定认得出。'
      + '别拿 circle 拼、也别自己写 path 去描一只狗 —— 你描不出来。'
      + '坐标全部是 0~1 的相对值（左上角 0,0），不是像素。'
      + '画会占用桌面，默认 8 秒后自动散开。',
    schema: {
      type: 'object',
      properties: {
        layers: {
          type: 'array',
          description: '最多 6 层',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['stencil', 'face', 'text', 'chart', 'arrow', 'line', 'polyline', 'circle', 'rect', 'path'] },
              name: {
                type: 'string',
                enum: ['dog', 'cat', 'house', 'tree', 'star', 'heart', 'check', 'cross', 'arrow', 'sun', 'cloud', 'person'],
                description: 'stencil 画什么',
              },
              mood: { type: 'string', enum: ['happy', 'calm', 'sad', 'angry', 'surprised', 'thinking'] },
              text: { type: 'string', description: 'text 层画的字，≤6 字' },
              kind: { type: 'string', description: 'chart 的形状：bars | line' },
              data: { type: 'array', items: { type: 'number' }, description: 'chart 的数据，2~8 个 0~1 的数' },
              labels: { type: 'array', items: { type: 'string' }, description: 'chart 的 x 轴标签（可选）' },
              from: { type: 'array', items: { type: 'number' }, description: 'arrow/line 起点 [x,y]，0~1' },
              to: { type: 'array', items: { type: 'number' }, description: 'arrow/line 终点 [x,y]，0~1' },
              points: { type: 'array', description: 'polyline 的点列 [[x,y],...]，0~1，至少 2 个' },
              d: { type: 'string', description: 'path 的 SVG 路径，如 "M .32 .60 C .32 .44 .42 .34 .5 .34 ..."（坐标 0~1，可用 M L C Q Z）' },
              closed: { type: 'boolean', description: 'polyline 是否收口成闭合轮廓（画身体、脸这类形状时用）' },
              fill: { type: 'boolean', description: '实心而不是描边（可选）' },
              at: { type: 'array', items: { type: 'number' }, description: '位置 [x,y]，0~1。face/text/circle 是中心，chart/rect 是左上角。不填由系统摆' },
              size: { type: 'number', description: '相对大小 0~1（文字是字号、表情/圆的直径、矩形的宽），不填由系统定' },
              w: { type: 'number', description: 'rect 的宽（0~1，可选）' },
              h: { type: 'number', description: 'rect 的高（0~1，可选）' },
              color: { type: 'string', description: '#rrggbb（可选）' },
            },
            required: ['type'],
            additionalProperties: true,
          },
        },
        hold: { type: 'number', description: '显示多久（毫秒），默认 8000' },
      },
      required: ['layers'],
      additionalProperties: false,
    },
    run: async ({ layers, hold }) => {
      const L = (layers || []).slice(0, 6);
      if (!L.length) return { ok: false, error: '至少要有一层' };
      /* 画不出来的要当场说，别让模型以为成功了。
       *
       * 之前这一步只看"有没有 layers"，于是 circle 缺 at、path 缺 d 全都回 ok:true，
       * 模型照常说"画好了"，屏幕上一片空白 —— 客户端那边只有 ?dev=1 才看得见。
       * 现在缺字段直接返回 error：模型在同一个回合里还能自己补一次。 */
      const bad = [];
      const isPt = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n));
      const inRange = (v) => (isPt(v) ? v.every((n) => Math.abs(n) <= 1.6) : true);
      L.forEach((l, i) => {
        const n = i + 1;
        if (!l || !l.type) { bad.push(`第 ${n} 层缺 type`); return; }
        switch (l.type) {
          case 'stencil':
            if (!l.name) bad.push(`第 ${n} 层 stencil 缺 name（dog/cat/house/tree/star/heart/check/cross/arrow/sun/cloud/person）`);
            break;
          case 'circle':
            if (!isPt(l.at) && !isPt(l.c)) bad.push(`第 ${n} 层 circle 缺 at:[x,y]`);
            break;
          case 'rect':
            if (!isPt(l.at)) bad.push(`第 ${n} 层 rect 缺 at:[x,y]（左上角）`);
            break;
          case 'line':
          case 'arrow':
            if (!isPt(l.from) || !isPt(l.to)) bad.push(`第 ${n} 层 ${l.type} 缺 from/to`);
            break;
          case 'polyline':
            if (!Array.isArray(l.points) || l.points.length < 2) bad.push(`第 ${n} 层 polyline 的 points 至少要 2 个点`);
            else if (!l.points.every(inRange)) bad.push(`第 ${n} 层 polyline 的坐标要用 0~1`);
            break;
          case 'path':
            if (typeof l.d !== 'string' || !l.d.trim()) bad.push(`第 ${n} 层 path 缺 d（SVG 路径字符串）`);
            break;
          case 'text':
            if (!l.text) bad.push(`第 ${n} 层 text 缺 text`);
            break;
          case 'chart':
            if (!Array.isArray(l.data) || l.data.length < 2) bad.push(`第 ${n} 层 chart 的 data 至少要 2 个数`);
            break;
          default:
            break;
        }
        if (isPt(l.at) && !inRange(l.at)) bad.push(`第 ${n} 层 at 超出 0~1（是相对坐标，不是像素）`);
        if (isPt(l.from) && !inRange(l.from)) bad.push(`第 ${n} 层 from 超出 0~1`);
        if (isPt(l.to) && !inRange(l.to)) bad.push(`第 ${n} 层 to 超出 0~1`);
      });
      if (bad.length) return { ok: false, error: `${bad.join('；')}。补齐后重新调一次 draw。` };

      const h = Number(hold);
      return { ok: true, draw: { layers: L, hold: Number.isFinite(h) ? Math.min(30000, Math.max(2500, h)) : 8000 } };
    },
  });

  /* 最常用的那个：一个参数，桌面粒子就笑了 */
  add('face', {
    level: 'safe',
    describe: '画一张表情。等于 draw 的一层 face，用起来更省事 —— 被夸、被问心情、打招呼时用它。',
    schema: {
      type: 'object',
      properties: { mood: { type: 'string', enum: ['happy', 'calm', 'sad', 'angry', 'surprised', 'thinking'] } },
      required: ['mood'],
      additionalProperties: false,
    },
    run: async ({ mood }) => ({ ok: true, draw: { layers: [{ type: 'face', mood }], hold: 6000 } }),
  });

  add('draw_stop', {
    level: 'safe',
    describe: '立刻把画散掉。',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ ok: true, draw: { stop: true } }),
  });

  /* ─────────────────── 自造工具（文档 §5） ───────────────────
   *
   * 这套东西存在的理由：不可能给每个应用写适配器。读一眼 API 文档、写 30 行脚本、
   * 注册成工具，之后一直能用。
   *
   * 但"让模型写代码并执行"是这台机器上风险最高的一件事，所以三处不由它决定：
   *   1. 草稿不进工具表（write 只落盘，keep 才注册）
   *   2. needs 由 guard.mjs 在子进程里强制（见 agent/tools/guard.mjs）
   *   3. 每次调用进审计（~/Agent/audit/tools-<day>.jsonl）
   *
   * 名字用 tool_ 前缀，是为了让 TOOL_WORDS 一条正则就能把这些词从回话里滤掉。
   */
  /* 读文档。造工具这件事有一半的失败是"没看过就写"：
     实测 7B 拿到"接口说明在 http://127.0.0.1:7899/doc"，也会直接编出
     /api/v1/playlists 这种不存在的路径。给它一条**读**的通道，
     它才有机会"先看再说" —— 这也是提示词里那条纪律在工具层的落点。 */
  add('web_get', {
    level: 'safe',
    describe: '读一个 http/https 地址的原文（GET）。要照着某个服务的接口写脚本之前，'
      + '先用它把文档读回来，别凭印象编路径。返回纯文本，最多 8000 字。',
    schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http:// 或 https:// 开头的完整地址' } },
      required: ['url'],
      additionalProperties: false,
    },
    run: async ({ url }) => {
      let u;
      try { u = new URL(String(url || '')); } catch { return { error: '这不是一个合法地址' }; }
      if (!/^https?:$/.test(u.protocol)) return { error: '只支持 http 和 https' };
      /* 云厂商的元数据地址：能拿到实例凭据，是 SSRF 最经典的那一个目标。
         内部域名（*.internal / *.svc）也一并挡掉 —— 这台机器上真需要读的
         是应用的对外地址，不是集群内网。 */
      const h = u.hostname;
      if (h === '169.254.169.254' || h.endsWith('.internal') || h.endsWith('.svc') || h === 'metadata') {
        return { error: '这个地址不让读' };
      }
      try {
        const r = await fetch(u, {
          signal: AbortSignal.timeout(10000),
          headers: { 'user-agent': 'emergent-agent/1.0 (+olares)' },
        });
        const ct = r.headers.get('content-type') || '';
        const raw = await r.text();
        const text = /json|text\/plain|xml/.test(ct)
          ? raw
          : raw.replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ');
        return {
          ok: r.ok, status: r.status, type: ct.split(';')[0] || '(未知)',
          chars: text.length, text: text.slice(0, 8000),
        };
      } catch (e) {
        return { error: `读不到：${String(e?.message || e).slice(0, 120)}` };
      }
    },
  });

  add('tool_list', {
    level: 'safe',
    describe: '看看现在有哪些自造工具（已装的 + 草稿）。用户问"能不能做某件事"之前，先看一眼有没有现成的。',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      if (!forge) return { ok: false, error: '这台机器上还没挂用户目录，自造工具用不了' };
      const list = await forge.list();
      return {
        ok: true,
        tools: list.map((t) => ({
          name: t.name, what: t.description, status: t.status === 'published' ? '已装' : '草稿',
          needs: t.needs, v: t.version,
        })),
        dir: '~/Agent/tools',
      };
    },
  });

  add('tool_write', {
    level: 'safe',
    describe: '写一个新工具（或改一个已有的）：名字、一句话说明、参数表、net（要访问的域名）、fs（要读写的目录）。'
      + '只会存成草稿，要跑还得 tool_try，要装起来还得 tool_keep。'
      + '脚本必须把结果打印成最后一行 JSON：console.log(JSON.stringify({ok:true,...}))；'
      + '参数从 process.env.EM_TOOL_ARGS 读（JSON）。不许用子进程、不许装 npm 包。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'a-z 0-9 下划线，例如 navidrome_playlist_add' },
        description: { type: 'string', description: '一句话说它能干什么（以后模型靠它决定什么时候用）' },
        params: {
          type: 'object',
          description: '参数表：{"album":{"type":"string","description":"专辑名"}}，类型只能是 string/number/boolean',
        },
        net: {
          type: 'string',
          description: '要访问的域名，多个用逗号隔开，例如 127.0.0.1:7899 或 api.example.com。'
            + '**少写一个它就跑不起来**（运行时真的会拒）',
        },
        fs: { type: 'string', description: '要读写的目录，多个用逗号隔开，例如 ~/Documents' },
        code: { type: 'string', description: '（可以留空，之后用 tool_code 贴）' },
        level: { type: 'string', enum: ['confirm', 'safe'], description: 'confirm=每次执行都问用户（默认），safe=直接跑' },
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
    run: async ({ name, description, params, needs, net, fs, code, level }) => {
      if (!forge) return { ok: false, error: '这台机器上还没挂用户目录，自造工具用不了' };
      const r = await forge.write({ name, description, params, needs, net, fs, code, level });
      if (r.ok) lastTool = r.name;
      /* 写完之后把它自己的 needs 说一遍：模型下一步要照着这份 needs 解释给用户听，
         而 7B 记不住自己刚才在 JSON 里写过什么。 */
      return r;
    },
  });

  add('tool_code', {
    level: 'safe',
    describe: '把一个工具的脚本代码写进去（覆盖旧的）。tool_write 只写名字和参数，代码用这一步贴 —— '
      + '两个字段：name 和 code。代码里读参数用 process.env.EM_TOOL_ARGS，'
      + '最后一行必须 console.log(JSON.stringify({ok:true,...}))。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工具名，要和 tool_write 时的一致' },
        code: { type: 'string', description: '完整的脚本源码，四十行以内' },
      },
      required: ['name', 'code'],
      additionalProperties: false,
    },
    run: async ({ name, code }) => {
      if (!forge) return { ok: false, error: '这台机器上还没挂用户目录，自造工具用不了' };
      const r = await forge.setCode(name, code);
      if (r.ok) lastTool = r.name;
      return r;
    },
  });

  add('tool_try', {
    level: 'danger',
    describe: '试运行一个工具（草稿也行）。会先问用户一次 —— 这是"首次运行看代码"那道门。'
      + '把参数写成对象传进来，例如 {"album":"Kind of Blue","playlist":"周末"}。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        args: { type: 'object', description: '给这个工具的参数' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async ({ name, args }) => {
      if (!forge) return { ok: false, error: '这台机器上还没挂用户目录，自造工具用不了' };
      if (name) lastTool = name;
      return forge.call(name, args || {});
    },
  });

  add('tool_keep', {
    level: 'danger',
    describe: '把试通过的草稿装起来，之后随时能用。会问用户一次。',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    run: async ({ name }) => {
      if (!forge) return { ok: false, error: '这台机器上还没挂用户目录，自造工具用不了' };
      return forge.keep(name);
    },
  });

  add('skill_save', {
    level: 'safe',
    describe: '把一个"以后照这样做"的做法记成技能（一页 markdown，用户能在 Files 里改）。'
      + '用户说过"以后就这么办"、或者你刚摸索出一套步骤时用它。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '短名字，例如 清理磁盘' },
        when: { type: 'string', description: '什么时候该用它（一句话）' },
        body: { type: 'string', description: '正文：可以照着做的步骤，用列表' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
    run: async ({ name, when, body }) => {
      if (!forge) return { ok: false, error: '这台机器上还没挂用户目录，技能存不了' };
      return forge.saveSkill({ name, when, body });
    },
  });

  return {
    all: T,
    /** 兜底屏要一条真曲线时用。没有集群就返回 null，调用方自己决定退化成什么。 */
    series: cluster ? (metric, o2) => cluster.series(metric, o2) : null,
    /**
     * 同步自造工具表。每轮开头调一次 —— 廉价的 readdir，比"重启才生效"好得多：
     * 用户刚说完"装起来吧"，下一句话就该能直接用上。
     */
    async reload() {
      if (!forge) return 0;
      let list = [];
      try { list = forge.registered(); } catch { return 0; }
      /* 草稿按"最近动过"排：模型忘填名字时，它指的那个几乎一定是最后动过的那份。 */
      try {
        drafts = (await forge.list())
          .filter((t) => t.status === 'draft')
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
          .map((t) => t.name);
      } catch { drafts = []; }
      const want = new Set(list.map((t) => t.name));
      for (const n of D) if (!want.has(n)) { delete T[n]; D.delete(n); }
      for (const t of list) {
        if (T[t.name] && !D.has(t.name)) continue;   // 撞了内置名，别覆盖（forge 那层已经拦，双保险）
        D.add(t.name);
        T[t.name] = {
          name: t.name,
          level: t.level,
          needs: t.needs,
          describe: `${t.description}（自造工具 v${t.version}）`,
          schema: t.schema,
          run: (args) => forge.call(t.name, args || {}, { publishedOnly: true }),
        };
      }
      return D.size;
    },
    isDynamic: (name) => D.has(name),
    /** 给模型看的 tools 数组（OpenAI 兼容形状，换真模型不用改）。
     *  `hidden` 的不发：它们是旧名字 / 旧入口，`exec` 仍然认（旧会话、旧脚本不会断），
     *  但不再占每次请求的 token —— 工具表是上下文里最贵的一块。
     *  `drop` 是按场景裁掉的冷门组（见 TOOL_GROUPS）；不传就是全给。 */
    schemas(drop = null) {
      return Object.values(T)
        .filter((t) => !t.hidden)
        .filter((t) => !drop || !drop.has(t.name))
        .map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.describe, parameters: t.schema },
        }));
    },

    async exec(name, args) {
      const t = T[name];
      if (!t) return { error: `unknown tool: ${name}` };
      return t.run(args || {});
    },
    level(name) {
      return T[name]?.level || 'danger';   // 不认识的一律按危险处理
    },
    /**
     * 把"模型忘了填"的参数补上，**在审批之前**。
     * 只补一个：tool_* 的 name —— 同一时刻只可能有一个刚被动过的工具。
     * 补了要留痕（assumed），别让它变成看不见的猜测。
     */
    fill(name, args) {
      const a = { ...(args || {}) };
      if (a.name) return a;
      if (!['tool_code', 'tool_try', 'tool_keep'].includes(name)) return a;
      /* 进程刚重启过时 lastTool 是空的 —— 退一步用"最后动过的那个草稿"。
         模型不会无缘无故调 tool_keep：它指的必然是刚写完/刚试过的那个。 */
      const nm = lastTool || drafts[0] || '';
      if (nm) { a.name = nm; a.assumed = true; }
      return a;
    },
    /**
     * 参数先过一遍必填检查，**在审批之前**。
     * 实测：7B 调 tool_try 时把 name 漏了，屏幕上先弹出一张"试跑「undefined」？"，
     * 用户点了允许才收到"没有这个工具"。让他为一个不可能成功的动作点一次头，
     * 比直接告诉他"少了 name"糟得多。
     */
    check(name, args) {
      const t = T[name];
      if (!t) return `没有叫「${name}」的工具`;
      if (typeof t.check === 'function') return t.check(args);
      const req = t.schema?.required || [];
      const miss = req.filter((k) => args?.[k] == null || args[k] === '');
      return miss.length ? `少了必填参数：${miss.join('、')}` : '';
    },
  };
}

export const SCENE_BUILDERS = { statusScene };
