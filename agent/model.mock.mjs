/**
 * 假模型。
 *
 * 它的全部作用是**把工具调用循环跑起来**，好让 M0 验证的是链路而不是模型本身。
 * 所以它刻意长得和真模型一样：入参是 `messages`（OpenAI 形状），出参是
 * `{ content, tool_calls }`，一次只决定"下一步做什么"。换成 DeepSeek / Claude
 * 时只需要换掉这个文件，loop 一行都不用改。
 *
 * 两条纪律，将来对真模型同样适用：
 *   1. **不许自己算几何、不许自己写 HTML。** 它能做的只是"看工具结果 → 决定下一步"。
 *   2. **每一步都要能从消息里确认"做没做过"，不要靠内存里的状态。**
 *      第一版用"最后一条工具结果"判断进度，结果在重跑时读到的是上一步的
 *      scene_patch，`freedGB` 就成了 undefined，而且它会一直重复同一段 ——
 *      这就是为什么下面全是 `has()` 的线性阶梯。
 */

/* ───────────────────────── 读消息 ───────────────────────── */

function sinceLastUser(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;
  return messages.slice(i + 1);
}

const has = (messages, name) =>
  sinceLastUser(messages).some((m) => m.role === 'tool' && m.name === name);

/** 取某个工具最近一次的结果（不是"最后一条工具结果"——重跑时会读错） */
function resultOf(messages, name) {
  const list = sinceLastUser(messages).filter((m) => m.role === 'tool' && m.name === name);
  const m = list[list.length - 1];
  if (!m) return {};
  try { return JSON.parse(m.content); } catch { return {}; }
}

const tc = (name, args) => ({
  id: `c_${name}_${Math.random().toString(36).slice(2, 7)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const pct = (v) => `${Math.round(v * 100)}%`;

/* ───────────────────────── 场景构造 ─────────────────────────
   这是"模型的表达"，不是前端模板。所以它只说自己知道的事：
   有哪些指标、哪个应用异常、要不要问一句。几何一律不碰。 */

function overviewScene(st, apps) {
  const bad = apps.find((a) => a.state === 'restarting');
  const layers = [
    { id: 'cpu', kind: 'gauge', label: 'CPU', value: st.cpu },
    { id: 'mem', kind: 'gauge', label: '内存', value: st.mem },
    { id: 'disk', kind: 'gauge', label: '磁盘', value: st.disk, color: '#b9a6ff' },
  ];
  if (bad) {
    layers.push({ id: 'iss', kind: 'turbulence', label: `${bad.name} 重启`, level: 0.45 });
    layers.push({
      id: 'ask', kind: 'fork', label: `要处理 ${bad.name} 重启吗`,
      options: [{ id: 'yes', label: '看看日志' }, { id: 'no', label: '先看着' }],
    });
  }
  return { rev: Date.now(), focus: bad ? 'iss' : 'mem', mood: bad ? 'working' : 'calm', layers };
}

function diskScene(scan) {
  const total = (scan.files || []).reduce((a, f) => a + f.size, 0) / 1024 ** 3;
  return {
    rev: Date.now(), focus: 'sum', mood: 'calm',
    layers: [
      { id: 'sum', kind: 'condense', text: `${String(scan.path || '').replace('~/', '')} 有 ${total.toFixed(1)} GB 可清` },
      {
        id: 'ask', kind: 'fork', label: `归档最大的 ${Math.min(4, (scan.files || []).length)} 个？`,
        options: [{ id: 'yes', label: '归档' }, { id: 'no', label: '先不动' }],
      },
    ],
  };
}

function appScene(app, logs) {
  /* 24 小时的重启次数。真接上之后这里改成监控查询，现在按日志条数铺一条曲线。 */
  const base = Math.max(1, (logs.lines || []).length);
  const data = Array.from({ length: 24 }, (_, h) => {
    const v = 0.06 + (h % 3 === 0 ? 0.08 : 0) + (h > 13 ? 0.12 : 0) + Math.random() * 0.06;
    return Math.min(1, v * (base / 4));
  });
  return {
    rev: Date.now(), focus: 'rs', mood: 'alert',
    layers: [
      { id: 'rs', kind: 'trace', label: `${app} · 24 小时`, data, axis: [0, 1] },
      { id: 'mem', kind: 'gauge', label: '内存', value: 0.6 },
      { id: 'cpu', kind: 'gauge', label: 'CPU', value: 0.34 },
      {
        id: 'ask', kind: 'fork', label: '卡在 Notion 节点？',
        options: [{ id: 'off', label: '先禁用它' }, { id: 'keep', label: '保留' }],
      },
    ],
  };
}

/* ───────────────────────── 主入口 ───────────────────────── */

export function createMockModel() {
  return {
    name: 'mock:v1',

    async complete({ messages, goal }) {
      /* 压缩上下文 / 新会话的 episode 这两条调用**不带 goal** ——
         它们不是"一轮对话"，是对话的整理。桩也要能回答，否则本地跑不通这两条路。 */
      if (!goal) {
        return { content: '用户问过磁盘，扫了 Downloads，建议清理没用的包，还没动手。', tool_calls: [] };
      }
      const st = resultOf(messages, 'sys_status');

      /* ═══ 用户说了一句话 ═══ */
      if (goal.kind === 'ask') {
        const text = goal.text || '';

        /* — 磁盘流：只给结论 + 一个决定。明细表不属于场（那是渲染树的事） — */
        if (/磁盘|空间|占|清理|下载/.test(text)) {
          if (!has(messages, 'fs_scan')) {
            return { content: '我先扫一下 Downloads。', tool_calls: [tc('fs_scan', { path: '~/Downloads', limit: 6 })] };
          }
          if (!has(messages, 'scene_set')) {
            return { content: '', tool_calls: [tc('scene_set', { spec: diskScene(resultOf(messages, 'fs_scan')) })] };
          }
          return { content: '' };
        }

        /* — 共同前奏：看数据 → 铺一屏 —
           一次 sys_status 就够：它现在连应用状态一起返回（合并前要两次往返，
           而每次往返都要重发整份上下文）。 */
        if (!has(messages, 'sys_status')) {
          return { content: '我看一眼。', tool_calls: [tc('sys_status', {})] };
        }
        if (!has(messages, 'scene_set')) {
          const apps = resultOf(messages, 'sys_status').apps || [];
          /* 一句话只放读数，不放判断 —— 判断由场上的分叉去问。
             这一行有 18 字硬预算，写成"CPU 71%、内存 60%，n8n 一直在重启"会被腰斩。 */
          return {
            content: `CPU ${pct(st.cpu)} · 内存 ${pct(st.mem)}`,
            tool_calls: [tc('scene_set', { spec: overviewScene(st, apps) })],
          };
        }

        /* — 说了"内存"就接着动手。这是**模型自己的主意**，所以会撞上审批门 — */
        if (/内存|卡|慢/.test(text)) {
          if (!has(messages, 'mem_trim')) {
            return {
              content: '内存 60%，主要是 n8n 在涨。',
              tool_calls: [tc('mem_trim', { to: 0.34 })],
            };
          }
          const r = resultOf(messages, 'mem_trim');
          if (r.denied) {
            return {
              content: '好，那不动。',
              tool_calls: [tc('scene_patch', {
                ops: [{ id: 'ask', label: '没动', options: [{ id: 'close', label: '好' }, { id: 'no', label: '好' }] }],
              })],
            };
          }
          if (!has(messages, 'scene_pulse')) {
            return {
              content: `压到 34%，释放 ${r.freedGB} GB。`,
              tool_calls: [
                tc('scene_patch', { ops: [{ id: 'mem', value: r.to }] }),
                tc('scene_pulse', { kind: 'confirm', at: 'mem' }),
                tc('scene_patch', {
                  ops: [{ id: 'ask', label: '已处理', options: [{ id: 'undo', label: '撤销' }, { id: 'close', label: '知道了' }] }],
                }),
              ],
            };
          }
          return { content: '' };
        }

        return { content: '' };
      }

      /* ═══ 用户动了一下手 ═══ */
      if (goal.kind === 'intent') {
        const it = goal.intent || {};

        /* 拖一个仪表：不执行，先反问。这正是 §8 那条分界线 */
        if (it.kind === 'adjust') {
          /* 反问只发一次。第二次进来就收尾 —— 否则会一直重发同一组 patch，
             界面上就是同一个脉冲一秒震八下（第一版就是这样，很吓人）。 */
          if (has(messages, 'scene_pulse')) return { content: '' };
          const to = Math.round(it.to * 100);
          const gb = ((it.from - it.to) * 15).toFixed(1);
          return {
            content: `压到 ${to}% 得重启占得最多的应用，几十秒不可用。`,
            tool_calls: [
              tc('scene_patch', {
                ops: [{
                  id: 'ask',
                  label: `用 ${gb} GB 换 ${to}%`,
                  options: [{ id: 'yes', label: `压到 ${to}%` }, { id: 'no', label: '算了' }],
                }],
              }),
              tc('scene_pulse', { kind: 'arrive', at: 'ask' }),
            ],
          };
        }

        /* 选了「压到 x%」：用户已经点过，这就是批准 —— 直接做，不再问第二遍 */
        if (it.kind === 'pick' && it.target === 'ask' && it.option === 'yes') {
          if (!has(messages, 'mem_trim')) {
            return { content: '', tool_calls: [tc('mem_trim', { to: goal.pendingTo ?? 0.34 })] };
          }
          const r = resultOf(messages, 'mem_trim');
          if (has(messages, 'scene_pulse')) return { content: '' };
          return {
            content: `压到 ${pct(r.to ?? 0.34)}，释放 ${r.freedGB ?? '—'} GB。`,
            tool_calls: [
              tc('scene_patch', { ops: [{ id: 'mem', value: r.to ?? 0.34 }] }),
              tc('scene_pulse', { kind: 'confirm', at: 'mem' }),
              tc('scene_patch', {
                ops: [{ id: 'ask', label: '已处理', options: [{ id: 'undo', label: '撤销' }, { id: 'close', label: '知道了' }] }],
              }),
            ],
          };
        }

        /* 点了那团乱点：先看日志，再换一屏详情 */
        if (it.kind === 'tap' && it.target === 'iss') {
          const name = (it.label || 'n8n').split(' ')[0];
          if (!has(messages, 'logs_tail')) {
            return { content: '', tool_calls: [tc('logs_tail', { app: name, lines: 8 })] };
          }
          if (!has(messages, 'scene_set')) {
            return {
              content: '日志是 502 + OOMKilled，不是网络问题。',
              tool_calls: [tc('scene_set', { op: 'transition', spec: appScene(name, resultOf(messages, 'logs_tail')) })],
            };
          }
          return { content: '' };
        }

        /* 横向拖了曲线：视图操作，本地已经做完了，模型只需要接一句 */
        if (it.kind === 'pan') {
          return { content: '这一段是更早的，峰值在第三天晚上。' };
        }

        return { content: '嗯。' };
      }

      return { content: '' };
    },
  };
}
