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
       这时候不做"假装裁过了"：留最近两条，并把 cramped 交回去，让上层说实话。 */
    cramped = true;
    cut = Math.max(1, messages.length - 2);
  } else if (histTok <= budget) {
    /* 历史本来就没超预算。这里**必须 return null**，不能算 cramped ——
       "历史很小"和"裁不动"是两件相反的事，混在一起会让每轮都报一条假警报。 */
    return null;
  } else {
    const keepRatio = Math.max(0.1, budget / histTok);
    const from = Math.max(1, Math.floor(messages.length * (1 - keepRatio)));
    cut = from;
    while (cut < messages.length && messages[cut].role !== 'user') cut++;
    if (cut >= messages.length) cut = Math.max(1, messages.length - 2);
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
