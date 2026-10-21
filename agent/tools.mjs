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
    layers.push({ id: 'tr', kind: 'trace', label: a.trace.label, data: a.trace.data });
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
export function defaultOverview(status = {}, apps = [], reading = '') {
  const gauges = [{ label: 'CPU', value: status.cpu ?? 0 }, { label: '内存', value: status.mem ?? 0 }];
  if (status.disk != null) gauges.push({ label: '磁盘', value: status.disk });
  const bad = (apps || []).find((a) => a.state === 'restarting');
  const args = { reading, gauges };
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

export function makeTools(o = {}) {  const source = o.source || 'host';
  const T = {};
  const add = (name, def) => { T[name] = { name, ...def }; };

  add('sys_status', {
    level: 'safe',
    describe: '读一次系统状态：CPU、内存、磁盘、网络。返回 0~1 的比例，不是百分数。',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      if (source === 'mock') return { ...MOCK_STATUS };
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
    describe: '列出这台机器上装了的应用，以及各自的状态、占用、备注。',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => ({ apps: MOCK_APPS }),
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
    run: async ({ path }) => ({
      path,
      files: MOCK_DISK.filter((f) => f.path.startsWith(path) || path === '~')
        .sort((a, b) => b.size - a.size),
    }),
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
    run: async ({ app }) => ({ app, lines: MOCK_LOGS[app] || ['(no logs)'] }),
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
          description: '一段随时间变化的曲线（可选）',
          properties: {
            label: { type: 'string', description: '≤12 字' },
            data: { type: 'array', items: { type: 'number' }, description: '2~280 个 0~1 的数，左旧右新' },
          },
          required: ['label', 'data'],
          additionalProperties: false,
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

  return {
    all: T,
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
