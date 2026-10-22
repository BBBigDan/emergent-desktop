/**
 * 场的信任边界。
 *
 * 接上真模型之后，`scene_set` 的 spec 就不再是"我写的对象"，而是**外部输入** ——
 * 和用户上传的文件、网页里的 HTML 一样不可信。它会拼错 kind、把 value 写成 71、
 * 一次塞九个 layer、给 fork 三个选项、或者干脆忘了 id。
 *
 * 这些错误在 scene.js 里的表现不是报错，而是**静默画错**：
 *   value 71 → clamp 到 1，仪表满格，看上去像"CPU 100%"；
 *   两个 fork   → 第二个覆盖第一个的锚点，点哪都只应第一个；
 *   九个 layer  → 槽位越界，互相覆盖，字缺笔画。
 * 界面上看不出是模型的错，只会觉得"这系统不准"。
 *
 * 所以这里做两件事，缺一不可：
 *   1. **挡住**：白名单 + 截断 + clamp，保证交给渲染的永远合法。
 *   2. **如实回报**：被丢掉的东西写进 `dropped`，作为工具结果回给模型。
 *      只挡不报，模型会以为自己成功了，然后在同一个错误上重复八次。
 *
 * 校验属于工具层而不是服务层：工具是唯一能改变世界的通道，
 * 边界就该长在通道上 —— 这样 mock、真模型、以后接的别的模型走的是同一道门。
 */

/* ───────────────────────── 每一类的能力上限 ─────────────────────────
   数字不是审美偏好，是渲染器实际的槽位与布局决定的：
   gauge 一个吃 360 槽（亮圈 180 + 暗圈 180），一屏 6400；
   trace 固定画在 a.y+244..408，两条会叠在一起；
   fork 只有一个决策槽，这是"决策是排他的"那条设计在代码里的落点。 */

export const LIMITS = {
  layers: 6,
  gauge: 3,
  stream: 2,
  trace: 1,          // 布局位置是固定的，第二条会压住第一条
  fork: 1,           // 场里只有一个决策槽
  condense: 2,
  turbulence: 2,
  tracePoints: 280,  // 与 scene.js 的 N 一致
};

/** 各 kind 的文字上限（字）。与 scene.js 里 ParticleText 的 max 一一对应。 */
export const TEXT_CAP = {
  /* gauge 的 label 以前是 4 —— 那是按"CPU / 内存 / 磁盘"三个汉字估的。
     但仪表现在经常是**应用占用**，`navidrome` / `qbittorrent` 在这里被截成
     `navi` / `qbit`，用户认不出是哪个应用（2026-10-22 线上）。
     宽度的活交给前端 `fitLabel`（按 px 算，竖排 120px），这里只挡"模型写一整句话"。 */
  gauge: { label: 12 },
  stream: { label: 12 },
  trace: { label: 12 },
  /* 问句给到 30：屏幕上是**两行**（splitTitle，每行 15）。
     14 会把「要在 Navidrome 中查找《千与千寻》这部电影吗？」切成半句 —— 线上实拍。 */
  fork: { label: 30, option: 8 },
  condense: { text: 20 },
  turbulence: { label: 8 },
};

const MOODS = ['calm', 'working', 'alert'];

/* ───────────────────────── 小工具 ───────────────────────── */

/* 按「字」而不是「字节」截断：'内存' 是 2 个字、6 个字节，
   用 slice(0,4) 会切出半个汉字（渲染成一个方块）。 */
const clip = (v, n) => {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  const a = [...s];
  /* 截完再 trim 一次：'CPU 使用率' 取 4 个字正好停在空格上，
     渲染出来是"CPU ␣"，字会偏左半格。 */
  return (a.length > n ? a.slice(0, n).join('') : s).trim();
};

/**
 * 0~1 的量，但容忍"百分数"。
 *
 * 契约写的是 0~1，可模型天天给 71、45、88 —— 那是它从日志里读到的百分数。
 * 直接 clamp 会把 71% 画成满格，**界面上看不出错，只会显得仪表永远 100%**；
 * 而按百分数折算，读数是对的。所以这里做折算，并把折算次数记下来告诉模型：
 * 猜对了也留一句，它下次才会改用 0~1。
 */
function unit(v, ctx, def = 0) {
  const x = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(x)) return def;
  if (x > 1 && x <= 100) { ctx.pct++; return x / 100; }
  return Math.min(1, Math.max(0, x));
}

const safeId = (v, fallback) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/.test(s) ? s : fallback;
};

const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);

/* ───────────────────────── 单个 layer ───────────────────────── */

function normLayer(raw, i, taken, dropped, ctx) {
  const id = safeId(raw?.id, `l${i}`);
  const kind = raw?.kind;
  if (!TEXT_CAP[kind]) {
    dropped.push(`layer[${i}] kind=${kind} 不在 gauge/stream/trace/fork/condense/turbulence 里`);
    return null;
  }
  if (taken.has(id)) {
    dropped.push(`layer[${i}] id=${id} 重复`);
    return null;
  }
  taken.add(id);

  const cap = TEXT_CAP[kind];
  const out = { id, kind };

  if (kind === 'gauge') {
    out.label = clip(raw.label, cap.label);
    out.value = unit(raw.value, ctx, 0);
    const c = hex(raw.color);
    if (c) out.color = c;
  } else if (kind === 'stream') {
    out.label = clip(raw.label, cap.label);
    out.progress = unit(raw.progress ?? raw.value, ctx, 0);
  } else if (kind === 'trace') {
    out.label = clip(raw.label, cap.label);
    const data = Array.isArray(raw.data) ? raw.data.map((v) => unit(v, ctx, 0)).slice(0, LIMITS.tracePoints) : [];
    if (data.length < 2) {
      dropped.push(`layer[${i}] trace 需要至少 2 个 data 点`);
      return null;
    }
    out.data = data;
    const ax = Array.isArray(raw.axis) ? raw.axis.map(Number) : null;
    if (ax && ax.length === 2 && Number.isFinite(ax[0]) && Number.isFinite(ax[1]) && ax[1] > ax[0]) out.axis = ax;
    const w = Array.isArray(raw.win) ? raw.win.map(Number) : null;
    if (w && w.length === 2 && w[1] > w[0]) out.win = [Math.min(1, Math.max(0, w[0])), Math.min(1, Math.max(0, w[1]))];
    const c = hex(raw.color);
    if (c) out.color = c;
  } else if (kind === 'fork') {
    out.label = clip(raw.label, cap.label);
    const opts = (Array.isArray(raw.options) ? raw.options : [])
      .slice(0, 8)
      .map((o, k) => ({
        id: safeId(o?.id, `o${k}`),
        label: clip(o?.label, cap.option),
        when: ['past', 'now', 'next'].includes(o?.when) ? o.when : 'next',
      }))
      .filter((o) => o.label);
    if (opts.length < 2) {
      dropped.push(`layer[${i}] fork 至少 2 个带 label 的选项`);
      return null;
    }
    /* 每一类最多 4 个：60° 扇区里 4 个标签的垂直间距 29px，而标签高 20px ——
       这是"不叠字"的下限。超了就丢，并且把丢掉的写进 dropped，
       而不是让它悄悄消失（模型会以为它给出的选项都在屏幕上）。 */
    const seen = { past: 0, now: 0, next: 0 };
    const kept = [];
    for (const o of opts) {
      if (seen[o.when] >= 4) {
        dropped.push(`layer[${i}] fork 的 ${o.when} 已经 4 个，丢弃「${o.label}」`);
        continue;
      }
      seen[o.when] += 1;
      kept.push(o);
    }
    out.options = kept;
  } else if (kind === 'condense') {
    out.text = clip(raw.text ?? raw.label, cap.text);
    if (!out.text) return null;
  } else if (kind === 'turbulence') {
    if (raw.label) out.label = clip(raw.label, cap.label);
    out.level = unit(raw.level, ctx, 0.3);
  }
  return out;
}

/* ───────────────────────── 整屏 ───────────────────────── */

export function normalizeSpec(raw) {
  const dropped = [];
  const ctx = { pct: 0 };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.layers)) {
    return { spec: null, dropped: ['spec.layers 缺失'], adjusted: [] };
  }

  const taken = new Set();
  const perKind = {};
  const layers = [];

  for (const [i, l] of raw.layers.entries()) {
    if (layers.length >= LIMITS.layers) { dropped.push(`layer[${i}] 超过一屏 ${LIMITS.layers} 个的上限`); continue; }
    const kind = l?.kind;
    /* 先按 kind 配额挡一道，再进逐字段校验：这样"多给了一个"的报错是
       "gauge 最多 3 个"，而不是含糊的"被丢弃"，模型才知道下次怎么改。 */
    if (TEXT_CAP[kind]) {
      perKind[kind] = (perKind[kind] || 0) + 1;
      if (perKind[kind] > LIMITS[kind]) {
        dropped.push(`layer[${i}] ${kind} 最多 ${LIMITS[kind]} 个`);
        continue;
      }
    }
    const n = normLayer(l, i, taken, dropped, ctx);
    if (n) layers.push(n);
  }

  if (!layers.length) return { spec: null, dropped: dropped.concat('没有任何可用 layer'), adjusted: [] };

  const ids = new Set(layers.map((l) => l.id));
  const spec = {
    rev: Date.now(),
    /* focus 必须是场上真有的那个 id —— 否则 scene.js 找不到就整屏没有焦点 */
    focus: ids.has(raw.focus) ? raw.focus : layers[0].id,
    mood: MOODS.includes(raw.mood) ? raw.mood : 'calm',
    layers,
  };
  const adjusted = ctx.pct
    ? [`${ctx.pct} 个 0~100 的数按百分数折算了（契约是 0~1，下次直接给小数）`]
    : [];
  return { spec, dropped, adjusted };
}

/* ───────────────────────── patch 的 ops ─────────────────────────
   patch 只改值不重排，所以能改的字段比 set 少得多：
   能改 value/progress/data/label/options，不能改 kind、不能新建。
   限制字段比限制格式更重要 —— 模型最爱干的事是"用 patch 加一个 layer"，
   那会让几何在用户没预期的时候重排。 */

export function normalizeOps(raw) {
  const dropped = [];
  const ctx = { pct: 0 };
  if (!Array.isArray(raw)) return { ops: null, dropped: ['ops 必须是数组'], adjusted: [] };
  const ops = [];
  for (const [i, o] of raw.slice(0, 6).entries()) {
    const id = safeId(o?.id, null);
    if (!id) { dropped.push(`ops[${i}] 缺 id`); continue; }
    const out = { id };
    if (o.value != null) out.value = unit(o.value, ctx, 0);
    if (o.progress != null) out.progress = unit(o.progress, ctx, 0);
    if (Array.isArray(o.data)) {
      const d = o.data.map((v) => unit(v, ctx, 0)).slice(0, LIMITS.tracePoints);
      if (d.length >= 2) out.data = d;
      else dropped.push(`ops[${i}] data 少于 2 点`);
    }
    if (o.label != null) out.label = clip(o.label, TEXT_CAP.fork.label);
    if (Array.isArray(o.options)) {
      const opts = o.options.slice(0, 8)
        .map((x, k) => ({
          id: safeId(x?.id, `o${k}`),
          label: clip(x?.label, TEXT_CAP.fork.option),
          when: ['past', 'now', 'next'].includes(x?.when) ? x.when : 'next',
        }))
        .filter((x) => x.label);
      if (opts.length >= 2) out.options = opts;
      else dropped.push(`ops[${i}] options 需要 2~8 个`);
    }
    if (Object.keys(out).length === 1) { dropped.push(`ops[${i}] 没有任何可改字段`); continue; }
    ops.push(out);
  }
  const adjusted = ctx.pct ? [`${ctx.pct} 个 0~100 的数按百分数折算了（契约是 0~1）`] : [];
  return { ops: ops.length ? ops : null, dropped, adjusted };
}

/* ───────────────────────── 脉冲 ───────────────────────── */

export const PULSES = ['confirm', 'arrive', 'error', 'settle'];

export function normalizePulse({ kind, at }) {
  return {
    kind: PULSES.includes(kind) ? kind : 'confirm',
    at: safeId(at, null) || undefined,
  };
}

/* ───────────────────────── 给模型看的 schema ─────────────────────────
   这是工具定义里 `spec` 的那段。它同时是**契约**和**说明书**：
   便宜模型主要靠这里（而不是提示词里的长文）知道"能填什么"。
   所以每个字段都写了上限，且措辞是"给我看"的，不是"给编译器看"的。 */

const OPTION_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string', description: '≤ 8 字' },
    /* 选项落在环的哪个方位。左 = 过去（补细节/还技术债/修老 bug）、
       下 = 现在（停下/验证）、右 = 未来（继续下一步）。缺省 next。 */
    when: { type: 'string', enum: ['past', 'now', 'next'] },
  },
  required: ['id', 'label'],
  additionalProperties: false,
};

const LAYER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '本屏内唯一，小写字母开头，如 mem / cpu / ask' },
    kind: { type: 'string', enum: Object.keys(TEXT_CAP) },
    /* 一个字段服务多种 kind，是因为 models 对 oneOf 的支持很差：
       用 oneOf 时便宜模型经常整段 spec 都不生成了。宁可 schema 宽一点，
       由 normalizeSpec 按 kind 二次收紧。 */
    label: { type: 'string', description: 'gauge ≤12 字（应用就写真名），stream/trace ≤12 字，fork ≤30 字（会排成两行）' },
    value: { type: 'number', description: 'gauge 用，0~1 的比例' },
    progress: { type: 'number', description: 'stream 用，0~1 的比例' },
    level: { type: 'number', description: 'turbulence 用，0~1，越大越乱' },
    text: { type: 'string', description: 'condense 用，一行结论 ≤20 字' },
    data: { type: 'array', items: { type: 'number' }, description: 'trace 用，最多 280 个 0~1 的点，从左到右是时间' },
    axis: { type: 'array', items: { type: 'number' }, description: 'trace 用，[最小值, 最大值]；缺省 0~1' },
    options: { type: 'array', items: OPTION_SCHEMA, description: 'fork 用，2~8 个；每个标 when: past/now/next（左=过去/下=现在/右=未来）' },
    color: { type: 'string', description: '可省略。#RRGGBB' },
  },
  required: ['id', 'kind'],
  additionalProperties: false,
};

export const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    focus: { type: 'string', description: '最该看的那个 layer 的 id' },
    mood: { type: 'string', enum: MOODS },
    layers: { type: 'array', items: LAYER_SCHEMA, description: `最多 ${LIMITS.layers} 个` },
  },
  required: ['layers'],
  additionalProperties: false,
};

const OP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '要改的那个 layer 的 id（必须在当前屏上）' },
    value: { type: 'number', description: 'gauge 的新值 0~1' },
    progress: { type: 'number', description: 'stream 的新进度 0~1' },
    data: { type: 'array', items: { type: 'number' }, description: 'trace 的新数据' },
    label: { type: 'string', description: '换文字（fork 换问法就用这个）' },
    options: { type: 'array', items: OPTION_SCHEMA, description: 'fork 换选项（2~8 个，各带 when）' },
  },
  required: ['id'],
  additionalProperties: false,
};

export const OPS_SCHEMA = { type: 'array', items: OP_SCHEMA };

/**
 * 把一串 patch op 合并成一份完整 spec。
 *
 * 只在**目标层还不存在**时用（见 runTurn 里那段）。op 的形状是扁平的
 * （`{id, label, options}` / `{id, value}`），要靠"带了哪个字段"反推 kind ——
 * 因为 `normalizeOps` 也要吃同一份形状，两边都得能从字段认出类型。
 */
export function patchToSpec(prev, ops) {
  const layers = (prev?.layers || []).map((l) => ({ ...l }));
  for (const o of ops || []) {
    if (!o?.id) continue;
    const at = layers.findIndex((l) => l.id === o.id);
    /* 已存在 → 这一条交给原来的 patch 路径（合并进旧层） */
    if (at >= 0) {
      const l = layers[at];
      if (Array.isArray(o.options)) Object.assign(l, { kind: 'fork', label: o.label ?? l.label, options: o.options });
      else if (o.value != null) Object.assign(l, { kind: 'gauge', value: o.value, label: o.label ?? l.label });
      else if (o.progress != null) Object.assign(l, { kind: 'stream', progress: o.progress, label: o.label ?? l.label });
      else if (o.label != null) l.label = o.label;
      continue;
    }
    if (Array.isArray(o.options)) {
      layers.push({ id: o.id, kind: 'fork', label: o.label, options: o.options });
    } else if (o.value != null) {
      layers.push({ id: o.id, kind: 'gauge', label: o.label || o.id, value: o.value });
    } else if (o.progress != null) {
      layers.push({ id: o.id, kind: 'stream', label: o.label || o.id, progress: o.progress });
    } else if (Array.isArray(o.data)) {
      layers.push({ id: o.id, kind: 'trace', label: o.label || o.id, data: o.data, axis: o.axis });
    } else if (o.label != null) {
      /* 只有一句问题、没有选项：做成"一问两选项"里的问句层没意义，
         退化成一句凝聚的话（至少屏幕上看得见）。 */
      layers.push({ id: o.id, kind: 'condense', text: o.label });
    }
  }
  return { ...(prev || {}), layers };
}
