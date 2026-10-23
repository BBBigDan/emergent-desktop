/**
 * 上下文满窗自收。
 *
 * 为什么必须自己做：32k 窗口里固定开销（系统提示 4.8k + 工具表 4.6k）已经占了 30%，
 * 十几轮就能把窗口吃满。吃满时接口直接 400，而且**报错发生在工具跑到一半** ——
 * 用户看到的是"它做了一半就不动了"，比一开始就拒绝更糟。
 *
 * 策略是最保守的一种：从最老的消息开始丢，只保留**从某条 user 消息开始**的整段。
 *
 * 为什么切点必须是 user：OpenAI 形状里 `assistant(tool_calls)` 和随后的
 * `tool` 结果是一条消息链，切断任何一处，下一次请求直接 400
 * （"tool_call_id 找不到对应的 assistant 消息"）。而一轮对话总是从 user 起头，
 * 从 user 切天然完整 —— 这比自己判断配对关系可靠得多。
 *
 * 为什么不摘要：摘要要再调一次模型，而**这次调用的上下文本来就是满的**——
 * 用满窗的上下文去省上下文，是最贵的那种省法。要做也应该在后台做，不挡这一轮。
 */

/** 一条"你只看到最近几轮"的说明。
 *  为什么要插：不插的话，模型会以为自己一直看着全程，然后对早期的事编一个答案。
 *  用 user 角色而不是改 system —— 改 system 会把前缀缓存整个打掉。 */
const NOTE = '（更早的对话已经省略，你只看到最近这几轮。以前的事用 memory_recall 查。）';

const DEFAULT_AT = 0.78;   // 到这个水位才动手
const DEFAULT_TO = 0.45;   // 收到这个水位（滞回：涨回 78% 之前不会再裁）

/**
 * 从 `at` 往回找最近的一条 user，返回它的下标（找不到返回 -1）。
 *
 * 为什么要"往回"：切点落在 user 上是这套裁剪唯一的硬约束，
 * 而一轮对话的**末尾**可能是一长串工具调用（没有 user）。
 * 往后找不到的时候，正确做法是把这一整轮留下、丢掉更早的几轮，
 * 而不是在工具链中间砍一刀。
 */
function snapBackToUser(messages, at) {
  let i = Math.min(Number(at) || 0, messages.length - 1);
  while (i > 1 && messages[i].role !== 'user') i--;
  return i >= 1 && messages[i]?.role === 'user' ? i : -1;
}

/**
 * @param {Array} messages  会话消息（第 0 条应该是 system）
 * @param {object} o        { used, limit, parts: {sys, tools}, at, to }
 * @returns {null | { messages, dropped, before, cramped?: boolean }}
 */
export function trimHistory(messages, o = {}) {
  const limit = Number(o.limit || 0);
  const used = Number(o.used || 0);
  const at = Number(o.at || DEFAULT_AT);
  const to = Number(o.to || DEFAULT_TO);
  if (!limit || !used) return null;
  if (used / limit < at) return null;
  if (!Array.isArray(messages) || messages.length < 4) return null;
  /* 第一条不是 system 就不动：裁完会变成一个没有身份提示的会话 */
  if (messages[0]?.role !== 'system') return null;

  const p = o.parts || {};
  const fixed = (p.sys || 0) + (p.tools || 0);
  const histTok = Math.max(0, used - fixed);
  /* 历史该占多少：目标水位减去固定开销。剩下的才是能留给对话的。 */
  const budget = limit * to - fixed;

  let cut;
  let cramped = false;
  if (budget <= 200) {
    /* 系统提示 + 工具表本身就把目标水位吃光了 —— 裁历史救不了。
       这时候不做"假装裁过了"：留最近两条，并把 cramped 交回去，让上层说实话。
       但"最近两条"也要退回 user：直接切在 `tool` 上就是一次 400，
       而 400 比"裁不动"糟得多（裁不动只是这一轮挤，400 是这一轮死）。 */
    cramped = true;
    cut = snapBackToUser(messages, Math.max(1, messages.length - 2));
  } else if (histTok <= budget) {
    /* 历史本来就没超预算。这里**必须 return null**，不能算 cramped ——
       "历史很小"和"裁不动"是两件相反的事，混在一起会让每轮都报一条假警报。 */
    return null;
  } else {
    const keepRatio = Math.max(0.1, budget / histTok);
    const from = Math.max(1, Math.floor(messages.length * (1 - keepRatio)));
    cut = from;
    while (cut < messages.length && messages[cut].role !== 'user') cut++;
    if (cut >= messages.length) {
      /* 往后找不到 user：说明**这一轮还没结束**（一轮里几十次工具调用，现在很常见）。
         以前这里是 `cut = length - 2` —— 那一刀很可能正落在
         `assistant(tool_calls)` 和它的 `tool` 之间，下一次请求直接 400，
         而报错看起来像"接口坏了"。改成**往回**退到本轮开头那条 user：
         丢掉的是更早的几轮，本轮整段留着（工具结果靠 foldToolResults 折叠）。 */
      cut = snapBackToUser(messages, messages.length - 1);
    }
  }

  /* 丢掉的是 1..cut-1 —— 第 0 条 system 永远留着，所以不是 `length - cut`。
     这个数字会出现在 note 里给用户看，报错了比不报更糟。 */
  const dropped = cut - 1;
  if (dropped < 1) return null;

  return {
    messages: [messages[0], { role: 'user', content: NOTE }, ...messages.slice(cut)],
    dropped,
    before: used,
    cramped,
  };
}

/* ─────────────────── 一轮之内的折叠（长任务用） ───────────────────
 *
 * 不设步数上限之后，把窗口吃满的往往不是"聊了很多轮"，而是**这一轮干了很多事**：
 * 三十次工具调用、每次回一段 JSON，一轮就能吃掉半个窗口。
 *
 * 这里做的是最省的一种：**只折内容，不动结构**。
 * `tool` 消息留着、`tool_call_id` 留着（所以永远不会 400），
 * 只把较早那些的正文换成一句"已折叠"加开头一小段。
 * 对比之下，从头裁消息要撞"切点必须在 user"这条 —— 而本轮只有开头一个 user，
 * 往后无 user 可切（那正是 trimHistory 里那个往回退的分支）。
 *
 * 为什么不摘要素：摘要要再调一次模型，用的还是**已经快满的**上下文，
 * 而且挡住的正是用户等着的那一步。折叠是零成本的。
 */

/**
 * @param {Array} messages 完整消息（第 0 条 system）
 * @param {{keep?:number, head?:number}} o 留最近几条不动、折叠后保留多少字
 * @returns {null | {messages:Array, folded:number, chars:number}}
 */
export function foldToolResults(messages, { keep = 6, head = 240 } = {}) {
  if (!Array.isArray(messages)) return null;
  const idx = [];
  for (let i = 1; i < messages.length; i++) if (messages[i]?.role === 'tool') idx.push(i);
  const victims = idx.slice(0, Math.max(0, idx.length - Math.max(1, keep)));
  if (!victims.length) return null;
  const out = messages.slice();
  let folded = 0;
  let chars = 0;
  for (const i of victims) {
    const c = String(out[i].content ?? '');
    /* 已经折过的不再折 —— 不然第二次调用会把 head 也切掉，剩一句空话 */
    if (c.startsWith('{"_folded"')) continue;
    if (c.length <= head) continue;
    out[i] = {
      ...out[i],
      content: JSON.stringify({
        _folded: '较早的工具结果已折叠（省上下文）。要细节就再查一次。',
        head: c.slice(0, head),
      }),
    };
    folded++;
    chars += Math.max(0, c.length - head);
  }
  if (!folded) return null;
  return { messages: out, folded, chars };
}

/* ─────────────────── 压缩（摘要，不是丢） ───────────────────
 *
 * 78% 时直接丢最老的消息，解决的是"接口 400"，不是"用户还想接着聊"。
 * 压缩是同一个位置的另一种处理：**先把这段讲成一段话，再替换进去**。
 *
 * 三条纪律（写在这里，因为实现的人容易在实现里忘掉）：
 *   1. 摘要必须标身份。不标的话模型会把摘要当原话引用 ——
 *      而我们不允许"模型自己的话"变成事实。
 *   2. 只留三类：用户说过的结论/偏好、做过的动作及结果、还没做完的事。
 *      读数不留（每轮都变）、模型的推测不留。
 *   3. 摘要那条用 **user 角色**，不改 system —— 改 system 会把前缀缓存整个打掉，
 *      而且 system 是"我是谁"，不是"我们聊过什么"。
 */

export const SUMMARY_TAG = '（以下是更早对话的摘要，不是原话。要细节用 memory_recall 查。）';

/** 压缩用的系统提示。短，是因为它要处理的是已经很长的一段上下文。 */
export const COMPACT_SYS = `你把一段对话压成**一段**接得上话的摘要。

只写这三类：
- 用户明确说过的结论、偏好、忌讳（"不想在半夜被重启"）
- 已经做过的动作和它的结果（"把 n8n 挪到 5679，起来了"）
- 还没做完的事（"建议 7 天轮转日志，用户还没动手"）

不写：任何读数（CPU 18%、内存 41%）、寒暄、你打算做什么、屏幕上铺了几个仪表。
用第三人称，中文，150 字以内，一段话，不要分点、不要开场白。`;

/**
 * 算压缩方案：哪一段拿去摘要，留哪几条当"最近的上下文"。
 * @returns {null | {head: Array, tail: Array, cut: number}}  head 是 1..cut-1
 */
export function compactPlan(messages, { tail = 4 } = {}) {
  if (!Array.isArray(messages) || messages.length < 6) return null;
  if (messages[0]?.role !== 'system') return null;
  let cut = Math.max(1, messages.length - tail);
  /* 切点必须落在 user（assistant(tool_calls)+tool 链断一处就 400） */
  while (cut < messages.length && messages[cut].role !== 'user') cut++;
  if (cut >= messages.length) {
    /* 窗口太窄，往后找不到 user 了：**往回**退到最近的那一条。
       踩过：直接兜底成 `length - 2`，那一条可能是 tool —— 切在那里，
       下一次请求就是"tool_call_id 找不到对应的 assistant"，而报错看起来像接口坏了。 */
    cut = messages.length - 1;
    while (cut > 1 && messages[cut].role !== 'user') cut--;
    if (cut <= 1 || messages[cut].role !== 'user') return null;
  }
  const head = messages.slice(1, cut);
  if (head.length < 3) return null;
  return { head, tail: messages.slice(cut), cut };
}

/**
 * 把摘要替换进去。
 * @param {Array} messages 原消息（第 0 条是 system）
 * @param {object} plan    compactPlan 的返回
 * @param {string} summary 模型给的摘要
 */
export function applyCompact(messages, plan, summary) {
  const s = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!s) return null;
  return {
    messages: [
      messages[0],
      { role: 'user', content: `${SUMMARY_TAG}\n${s}` },
      ...plan.tail,
    ],
    summarized: plan.head.length,
    summary: s,
  };
}

/** 摘要调用的输入：整段对话的流水。头尾都要 —— 头是"为什么开始聊这件事"。 */
export function transcriptFor(messages, { head = 1800, tail = 4200 } = {}) {
  const lines = [];
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue;
    const c = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (m.role === 'user') lines.push('用户说：' + c.slice(0, 220));
    else if (m.role === 'assistant') {
      if (c) lines.push('我说：' + c.slice(0, 160));
      for (const t of m.tool_calls || []) {
        lines.push(`（我调了 ${t?.function?.name || '工具'}）`);
      }
    } else if (m.role === 'tool') {
      lines.push(`工具返回：${c.slice(0, 120)}`);
    }
  }
  const all = lines.join('\n');
  if (all.length <= head + tail) return all;
  return `${all.slice(0, head)}\n…（中间省略）…\n${all.slice(-tail)}`;
}

/** 新会话时写进记忆的那一条 episode 的提示。 */
export const EPISODE_SYS = `把这段对话压成**一行**，用来让下一次会话想起"上次聊了什么"。

格式：上次+主题+关键结论/结果+是否收尾。不超过 38 个字，中文，第三人称，不要引号，不要句号之外的标点。
例：上次查磁盘，n8n 日志两周涨 3.2G，建议 7 天轮转，用户还没动手。`;

/** 新会话时插给模型的第一句（不进历史，只当一次性的系统提示）。 */
export const NEW_SESSION_MARK = '[新会话]';
