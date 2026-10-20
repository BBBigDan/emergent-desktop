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

export function makeTools(o = {}) {
  const source = o.source || 'host';
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

  /* 输出通道也是工具 —— 它们不改变世界，只改变"看见什么"。所以都是 safe。 */

  add('scene_set', {
    level: 'safe',
    describe: '铺一整屏。首屏用这个；已经有一屏了就用 scene_transition。'
      + ' 约束：label ≤ 12 字（超过会被截断），数值一律用 0~1 的 number 不用字符串，'
      + ' 一屏最多 6 个 layer，总字数越少越好。',
    schema: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'], additionalProperties: false },
    run: async ({ spec }) => ({ ok: true, op: 'set', spec }),
  });

  add('scene_patch', {
    level: 'safe',
    describe: '只改数值，不重排。进度推进、指标刷新、换一句问话都走这个。'
      + ' 换 fork 的文案时只传 label/options，几何不用管。',
    schema: { type: 'object', properties: { ops: { type: 'array' } }, required: ['ops'], additionalProperties: false },
    run: async ({ ops }) => ({ ok: true, op: 'patch', ops }),
  });

  add('scene_pulse', {
    level: 'safe',
    describe: '一次物理动作：confirm / arrive / error / settle。',
    schema: {
      type: 'object',
      properties: { kind: { type: 'string' }, at: { type: 'string' } },
      required: ['kind'],
      additionalProperties: false,
    },
    run: async ({ kind, at }) => ({ ok: true, op: 'pulse', kind, at }),
  });

  add('scene_transition', {
    level: 'safe',
    describe: '换一整屏：溶解 → 换几何 → 重组。之后的换景都用这个，不要用 set。',
    schema: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'], additionalProperties: false },
    run: async ({ spec }) => ({ ok: true, op: 'transition', spec }),
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
