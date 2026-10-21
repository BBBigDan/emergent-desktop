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

const GB = 1024 ** 3;

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
    gauges = apps.slice(0, 3).map((a) => ({ label: String(a.name).slice(0, 4), value: a.memPct ?? 0 }));
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
  const T = {};
  const add = (name, def) => { T[name] = { name, ...def }; };

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

  add('sys_status', {
    level: 'safe',
    describe: '读一次系统状态：CPU、内存、磁盘的真实占用，以及谁在吃内存。'
      + '返回 0~1 的比例，不是百分数。',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      if (source === 'mock') return { ...MOCK_STATUS };

      if (cluster) {
        const s = await cluster.nodeMetrics();
        const totalMB = (s.memTotal || 15.6) * 1024;
        /* top 只给前 5 条、名字去后缀：模型要的是"谁在吃"，不是集群清单。
           给全量只会让它照着念一遍 pod 名字。
           **memPct 必须给**：实测模型拿到 memMB=382 之后，会自己"换算"成
           value:0.382 塞进仪表 —— 屏幕上显示 38%，而它其实只占 2.4%。
           单位对不上时模型不会问，它会直接除个 1000。 */
        return {
          cpu: s.cpu, mem: s.mem, disk: s.disk,
          memTotal: s.memTotal, memUsed: s.memUsed, memFree: s.memFree,
          top: s.top.slice(0, 5).map((r) => ({
            name: r.name,
            memMB: r.memMB,
            memPct: +(r.memMB / totalMB).toFixed(3),
            cpu: +r.cpu.toFixed(3),
          })),
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

  add('app_list', {
    level: 'safe',
    describe: '列出用户装了的应用，以及各自的状态、占用时长、吃多少内存。'
      + '不含 Olares 自己的系统组件。',
    schema: {
      type: 'object',
      properties: {
        includeSystem: { type: 'boolean', description: '连系统组件一起看，缺省 false' },
      },
      additionalProperties: false,
    },
    run: async ({ includeSystem } = {}) => {
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
  });

  add('fs_scan', {
    level: 'safe',
    describe: '按体积列出某个目录下最占地方的文件。用来回答"什么东西在吃我的盘"。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录，例如 ~/Downloads' },
        limit: { type: 'integer', description: '最多返回几条，缺省 6' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async ({ path }) => {
      /* 真实集群上没有做目录级扫描：文件都在 PVC 里，要读得进 pod 或走 Files 的 API。
         这里如实报，不要拿假文件列表糊弄 —— 用户会照着去删。 */
      if (cluster) {
        return { error: '还没接目录扫描：真集群上文件在 PVC 里，需要走 Files 应用或进 pod 执行 du' };
      }
      return {
        path,
        files: MOCK_DISK.filter((f) => f.path.startsWith(path) || path === '~')
          .sort((a, b) => b.size - a.size),
      };
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

  /* 输出通道也是工具 —— 它们不改变世界，只改变"看见什么"。所以都是 safe。
     但"看见什么"同样要过边界：spec 来自模型，是不可信输入（见 scene.schema.mjs）。 */

  /* ── 高层动词：给便宜模型用的 ──
     字段全平、全部可选，不用起 id、不用选 kind。想精确控制再用下面的 scene_set。 */

  add('scene_show', {
    level: 'safe',
    describe: '铺一屏，或换一屏。这是最常用的输出方式：把要说的话和要显示的读数一次给它。'
      + ' reading 会直接出现在用户眼前那一行，所以它必须是一句人话（≤20 字，不换行、不列清单）。'
      + ' gauges 是此刻的几个比例（最多 3 个）；note 是一句结论；'
      + ' ask 是一个问题 + 两个选项，用户点哪个系统会告诉你。',
    schema: {
      type: 'object',
      properties: {
        reading: { type: 'string', description: '用户眼前那一行话，≤20 字，例如 "CPU 3% · 内存 62%"' },
        gauges: {
          type: 'array',
          description: '最多 3 个',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '≤4 字，例如 CPU / 内存 / 磁盘' },
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
        ask: { type: 'string', description: '要问用户的那句话，≤14 字（可选）。填了它就必须同时填 yes 和 no' },
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
        label: { type: 'string', description: '问题，≤14 字' },
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

  add('scene_set', {
    level: 'safe',
    describe: '铺一整屏，替换当前所有内容。只有第一屏用这个。',
    schema: { type: 'object', properties: { spec: SPEC_SCHEMA }, required: ['spec'], additionalProperties: false },
    run: async ({ spec }) => {
      const r = normalizeSpec(spec);
      if (!r.spec) return { ok: false, error: 'spec 没有可用的 layer', dropped: r.dropped };
      return { ok: true, op: 'set', spec: r.spec, ...tail(r) };
    },
  });

  add('scene_patch', {
    level: 'safe',
    describe: '只改值，不重排。指标刷新、进度推进、换一句问话都走这个。'
      + ' 不能新建 layer，也不能改 kind —— 要加东西用 scene_transition。',
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
    describe: '换一整屏：溶解 → 换几何 → 重组。已经有内容之后再换景都用这个，不要用 set。',
    schema: { type: 'object', properties: { spec: SPEC_SCHEMA }, required: ['spec'], additionalProperties: false },
    run: async ({ spec }) => {
      const r = normalizeSpec(spec);
      if (!r.spec) return { ok: false, error: 'spec 没有可用的 layer', dropped: r.dropped };
      return { ok: true, op: 'transition', spec: r.spec, ...tail(r) };
    },
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

  return {
    all: T,
    /** 兜底屏要一条真曲线时用。没有集群就返回 null，调用方自己决定退化成什么。 */
    series: cluster ? (metric, o2) => cluster.series(metric, o2) : null,
    /** 给模型看的 tools 数组（OpenAI 兼容形状，换真模型不用改） */
    schemas() {
      return Object.values(T).map((t) => ({
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
  };
}

export const SCENE_BUILDERS = { statusScene };
