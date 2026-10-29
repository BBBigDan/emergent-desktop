/**
 * 子 agent：**换一个上下文，把立场锁住。**
 *
 * 存在的理由（用户 2026-10-29 的判断，一句话）：任务里存在互相冲突的内容或角色时，
 * 模型**没有办法在一次回复里换对立角度思考**，必然会因为梯度下降陷入"无意义的不出错回复"
 * ——「这取决于你的需求」「两者各有优劣」「没有绝对的好坏」。
 *
 * 这不是提示词能修的：同一个上下文里让它"先支持再反对"，它会在采样时把两个立场中和掉，
 * 因为那是训练分布里"安全"的那一侧。**只有换一个上下文，立场才锁得住。**
 *
 * 三个刻意的设计（都是为了把成本压到"随时可以开一次"）：
 *
 *   ① **一次调用，不是一轮**。没有工具、没有历史、不循环。
 *      成本 ≈ 一次普通问答，而不是"一份 9k 上下文 × N 步"。
 *      所以"该不该为了一个判断多花一次调用"的答案是：值得。
 *   ② **不给工具**。这同时解决了两件事：它没法用工具去查证（也就不会跑偏成
 *      一次侦察），也没法再起一个子 agent（**嵌套在这里是结构上不可能的**，
 *      不是靠一句"不许嵌套"的约定）。
 *   ③ **看不到主对话**。它只看到这一条 task。立场被污染最常见的路径就是
 *      "刚才主对话已经说了倾向于 A" —— 那它就会顺着 A 找理由。
 *      所以调用方必须把要审的东西**完整贴进 task**，不能指望它"知道上文"。
 *
 * 输出用**行首标签**而不是 JSON：7B 在括号配对上的失败率远高于认中文标签
 * （`scene.schema` 那条路的教训：嵌套对象是模型的敌人，平铺的才是朋友）。
 */

/* ───────────────────────── 角色 ───────────────────────── */

/**
 * 每个角色三件事：**只许做什么**、**不许做什么**、**输出什么**。
 * 「不许」那几句是这套东西的核心 —— critic 一旦被允许"也要看到优点"，
 * 它就退化成一段平衡的废话，那还不如不问。
 */
export const ROLES = {
  critic: {
    zh: '挑毛病',
    brief: [
      '你是审稿人。你**只找问题**，不评价优点，不做平衡。',
      '你面前这个东西如果有致命缺陷，说清它是哪一步会坏、坏了用户看到什么。',
      '不许说"整体不错但"、不许说"建议进一步优化"这类没有指向的话 ——',
      '每一句都要能落到具体的一行、一个字段、一个操作上。',
      '你无法验证的事**不要断言**，说成"这里需要确认 X"即可。',
    ].join('\n'),
  },
  advocate: {
    zh: '替它说话',
    brief: [
      '你是这个方案的辩护人。你的任务是**把它做到的最好版本讲清楚**：',
      '它解决了什么真问题、为什么现在这个形状是对的、反对它的人最容易忽略什么。',
      '你不必假装它没有缺点，但**不许用缺点来抵消结论** —— 结论要明确站在它这一边。',
      '如果你发现它其实站不住，就说"站不住"并说清哪一条最站不住（这比硬撑有用）。',
    ].join('\n'),
  },
};

/** 输出格式：**行首标签**，两三种就行。多了模型会漏。 */
const FORMAT = [
  '只输出下面三行（不要别的话，不要 markdown 标题，不要代码块）：',
  '结论：一句话，明确站定，不许"取决于"',
  '理由：1) …；2) …；3) …（最多三条，每条一句）',
  '反对：对方最强的那个攻击点是什么（由你替他说出来，一句）',
].join('\n');

export function roleBrief(role, { subject = '' } = {}) {
  const r = ROLES[role] || ROLES.critic;
  return [
    r.brief,
    subject ? `\n审的对象：${subject}` : '',
    `\n${FORMAT}`,
    '\n特别禁止（这几句一出现就等于没答）：这取决于、各有优劣、因人而异、视情况而定、'
      + '没有绝对的对错、需要根据实际情况判断。',
  ].join('\n');
}

/* ───────────────────────── 解析 ───────────────────────── */

const LABEL = {
  conclusion: /^(结论|判断|我的结论)\s*[:：]\s*/,
  reasons: /^(理由|原因|依据)\s*[:：]\s*/,
  counter: /^(反对|反驳|对方最强|最强反驳|对方最强的一点)\s*[:：]\s*/,
};

/** 「和稀泥」的指纹。不拿它做判断，只用来**量**结构改动有没有效。 */
const FENCE = /(这取决于|各有优劣|因人而异|视情况而定|没有绝对|取决于你的需求|两者都可以)/;

/**
 * 把模型的回复拆成三块。
 *
 * 容错的顺序是有讲究的：先按行找标签，找不到标签就**整段当结论**并标 `parsed:false` ——
 * 而不是报错或返回空。原因：这一段文字仍然是它说的话，丢掉等于白花一次调用；
 * 标出来，调用方可以决定"要不要重问一次"。
 *
 * @returns {{conclusion:string, reasons:string[], counter:string, parsed:boolean, fence:boolean}}
 */
export function parseVerdict(text) {
  const raw = String(text || '').trim();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let conclusion = '';
  let reasonsText = '';
  let counter = '';
  const extra = [];

  for (const line of lines) {
    /* 模型常给"1) xxx；2) yyy"或者"- xxx"。剥掉这些前缀再判标签。 */
    const t = line.replace(/^[-*·]\s*/, '');
    if (LABEL.conclusion.test(t)) { conclusion = t.replace(LABEL.conclusion, ''); continue; }
    if (LABEL.reasons.test(t)) { reasonsText = t.replace(LABEL.reasons, ''); continue; }
    if (LABEL.counter.test(t)) { counter = t.replace(LABEL.counter, ''); continue; }
    extra.push(t);
  }

  /* 理由的分隔：；、;都是。也接受"1) 1. 一、"这些前缀。
     **不要按长度过滤**：`2. 快` 剥掉编号只剩一个"快"，那是一条真理由，丢了就少一条
     （自测里"1. 便宜；2. 快"只剩一条就是这么来的）。空的才丢。 */
  const reasons = reasonsText
    .split(/[；;]\s*|\s(?=\d\))/)
    .map((r) => r.replace(/^\s*\d[).、]\s*/, '').replace(/^[一二三四]、?\s*/, '').trim())
    .filter((r) => r.length > 0)
    .slice(0, 3);

  const parsed = !!(conclusion || reasons.length);
  /* 没有标签时：把全部内容当结论（截 300 字），仍然给调用方一个能用的东西。 */
  const out = parsed ? conclusion : raw.slice(0, 300);
  return {
    conclusion: out,
    reasons,
    counter,
    /* 有标签但没理由 —— 通常是模型只答了一句。标出来，不要假装完整。 */
    parsed,
    fence: FENCE.test(raw),
    /* 标签以外的零散行：留着，可能是有用的细节，但不进结论。 */
    extra: extra.slice(0, 4),
  };
}

export function looksLikeFence(text) {
  return FENCE.test(String(text || ''));
}

/* ───────────────────────── 运行 ───────────────────────── */

/**
 * @param {object} o
 * @param {(req:{messages:any[],tools:any[],signal?:AbortSignal})=>Promise<any>} o.complete
 *        模型的一次调用。**不接受工具表**，调用方也不该给 —— 见文件头 ②。
 * @param {(u:any)=>void} [o.onUsage] 记进账本（子 agent 也要算钱，否则数字对不上）
 * @param {number} [o.timeout] 默认 120 秒：一次调用，不该超过这个数
 */
export function createSub(o = {}) {
  const complete = o.complete;
  const timeout = Number(o.timeout || 120_000);
  const onUsage = o.onUsage || null;
  let n = 0;

  /**
   * 跑一个角色。
   *
   * @param {object} a
   * @param {'critic'|'advocate'} a.role
   * @param {string} a.task **要审/要辩的全部材料**（它看不到主对话）
   * @param {string} [a.subject] 一句话说清这是什么东西（进 system，不占结论）
   * @returns {Promise<{ok:boolean, role:string, conclusion:string, reasons:string[],
   *                    counter:string, parsed:boolean, fence:boolean, ms:number,
   *                    error?:string, code?:string}>}
   */
  async function run({ role = 'critic', task, subject = '' } = {}) {
    if (!complete) return { ok: false, code: 'sub_unavailable', error: '子 agent 没有接模型', role };
    const body = String(task || '').trim();
    if (!body) return { ok: false, code: 'sub_empty', error: '没给要审的内容', role };
    if (!ROLES[role]) return { ok: false, code: 'sub_bad_role', error: `没有这个角色：${role}`, role };

    const messages = [
      { role: 'system', content: roleBrief(role, { subject }) },
      { role: 'user', content: body },
    ];
    const t0 = Date.now();
    n += 1;
    try {
      const out = await complete({
        messages,
        tools: [],            // 见文件头 ②：不给工具，嵌套因此不可能
        signal: AbortSignal.timeout(timeout),
      });
      if (onUsage && out?.usage) onUsage(out.usage);
      const v = parseVerdict(out?.content);
      /* 空回复是常见坏情况（7B 偶尔给一个空 message）。**不许当成"没意见"** ——
         "没人反对"和"没人说话"是两件事，混起来会让主 agent 以为方案过关了。 */
      if (!String(out?.content || '').trim()) {
        return { ok: false, code: 'sub_silent', error: '它没说话（空回复），这不是"没问题"',
          role, ms: Date.now() - t0 };
      }
      return { ok: true, role, roleZh: ROLES[role].zh, ...v, ms: Date.now() - t0 };
    } catch (e) {
      const msg = String(e?.message || e);
      const to = /abort|timeout|timed out/i.test(msg);
      return {
        ok: false, role, ms: Date.now() - t0,
        code: to ? 'sub_timeout' : 'sub_failed',
        error: to ? `子 agent 超时（${Math.round(timeout / 1000)} 秒）` : msg,
      };
    }
  }

  return { run, roles: () => Object.keys(ROLES), get calls() { return n; } };
}
