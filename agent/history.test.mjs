/**
 * 裁剪自测。不需要模型、不需要网络：
 *
 *   node agent/history.test.mjs
 *
 * 它验的是"切错就会 400"的那几处：
 *   1. 没到水位不动（每轮都裁会让前缀缓存每轮失效）。
 *   2. 切点必须落在 user 上 —— assistant(tool_calls) 和 tool 结果被拆开，
 *      下一次请求直接 400，而且报错长得像"模型接口坏了"。
 *   3. 第一条 system 永远保留（丢了它，会话就没有身份和规则了）。
 *   4. 固定开销本身就把窗口占满时，不能假装裁过了（返回 cramped）。
 */

import { trimHistory, compactPlan, applyCompact, transcriptFor, SUMMARY_TAG } from './history.mjs';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (extra ? ` — ${extra}` : '')); }
};

const SYS = { role: 'system', content: 'x'.repeat(4000) };

/* 造一段对话：每条 user 后面跟一条 assistant(tool_calls) + 一条 tool。
   这正是真实形状，也是切点考验的地方。 */
function convo(turns) {
  const m = [SYS];
  for (let i = 0; i < turns; i++) {
    m.push({ role: 'user', content: `问题 ${i}` });
    m.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'sys_status', arguments: '{}' } }],
    });
    m.push({ role: 'tool', name: 'sys_status', tool_call_id: `c${i}`, content: '{"cpu":0.1}' });
    m.push({ role: 'assistant', content: `回答 ${i}` });
  }
  return m;
}

/* 线性近似：每条消息算 100 token，system 算 4000 */
const est = (msgs) => msgs.reduce((a, m) => a + (m.role === 'system' ? 4000 : 100), 0);
const parts = { sys: 4000, tools: 1000 };

console.log('不到水位不动');
{
  const m = convo(3);                     // ≈ 4000 + 12*100 = 5200
  const total = est(m) + 1000;
  ok(trimHistory(m, { used: total, limit: 32000, parts }) === null, '水位很低时是 null');
  const tiny = [{ role: 'system', content: 'x' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  ok(trimHistory(tiny, { used: 9000, limit: 9000, parts }) === null, '只有 3 条消息时不裁（太短）');
}

console.log('\n切点');
{
  const m = convo(20);                    // 1 + 80 条
  const total = est(m) + 1000;            // ≈ 13000
  const r = trimHistory(m, { used: total, limit: 16000, parts });
  ok(!!r, '到了水位就裁', String(total / 16000));
  ok(r.messages[0].role === 'system', 'system 保留');
  ok(r.messages[1].role === 'user', '切完第一条是 user（或说明）', r.messages[1]?.role);
  ok(r.dropped > 0, `丢了 ${r.dropped} 条`);

  /* 这是真正要防的：保留段里不能出现"孤立的 tool 消息" */
  const kept = r.messages.slice(2);
  const firstTool = kept.findIndex((x) => x.role === 'tool');
  const firstAssistant = kept.findIndex((x) => x.role === 'assistant' && x.tool_calls?.length);
  ok(!(firstTool >= 0 && (firstAssistant < 0 || firstAssistant > firstTool)),
    '没有孤立的 tool 消息（配对完整）');

  /* 每个 tool 的 tool_call_id 都能在保留段里找到对应的 assistant */
  const ids = new Set(kept.filter((x) => x.role === 'assistant').flatMap((x) => (x.tool_calls || []).map((c) => c.id)));
  const orphan = kept.filter((x) => x.role === 'tool' && !ids.has(x.tool_call_id)
    /* 紧跟在裁剪说明后面的那一条不算：它的 assistant 被裁掉了，但 tool 也一定被裁掉 */
  );
  ok(orphan.length === 0, 'tool_call_id 全有对应', orphan.map((x) => x.tool_call_id).join(','));
}

console.log('\n收到哪一档');
{
  const m = convo(20);
  const total = est(m) + 1000;
  const r = trimHistory(m, { used: total, limit: 16000, parts });
  const after = est(r.messages) + 1000;
  /* 不能要求精确（token 与条数不是线性的），但要明显降下来 */
  ok(after < total * 0.75, `裁完明显变小：${total} → ${after}`);
}

console.log('\n没有可裁的空间');
{
  /* 固定开销 5000，窗口 6000，历史只剩 200 —— 连 400 的地板都保不住 */
  const m = convo(2);
  const r = trimHistory(m, { used: 5200, limit: 6000, parts: { sys: 4000, tools: 1000 } });
  ok(r === null || r.cramped, '固定开销占满时标 cramped，不假装裁好了', JSON.stringify(r && { cramped: r.cramped }));
}

console.log('\n第一条不是 system');
{
  const m = convo(10).slice(1);
  ok(trimHistory(m, { used: 15000, limit: 16000, parts }) === null, '没有 system 就不裁（否则会话失去身份）');
}

/* ───────────────── 压缩（摘要） ─────────────────
 * 和裁剪验的是同一件事的两面：裁剪只要"不 400"，压缩还要"能接着聊"。
 * 所以这里额外验两条：
 *   5. 摘要那条**不是**原话（带身份标签）—— 否则模型会把摘要当事实引用；
 *   6. 留下的那截仍然以 user 开头（配对完整）。 */
console.log('\n压缩：切点与身份');
{
  const m = convo(10);                     // 1 + 40 条
  const plan = compactPlan(m, { tail: 4 });
  ok(!!plan, '给得出方案');
  ok(plan.head.length > 0 && plan.tail.length >= 4, `头 ${plan.head?.length} 条 / 尾 ${plan.tail?.length} 条`);
  ok(plan.tail[0]?.role === 'user', '尾巴从 user 起（配对完整）', plan.tail[0]?.role);

  const r = applyCompact(m, plan, '用户问过磁盘，查了 n8n 日志，建议轮转，还没动手。');
  ok(!!r, '应用成功');
  ok(r.messages[0].role === 'system', 'system 还在');
  ok(r.messages[1].role === 'user' && r.messages[1].content.startsWith(SUMMARY_TAG),
    '摘要那条带身份标签（"不是原话"）');
  ok(r.messages.length < m.length, `总条数下降 ${m.length} → ${r.messages.length}`);
  ok(r.messages.slice(2)[0]?.role === 'user', '摘要之后紧接着是 user');
  /* 摘要为空时不替换 —— 空摘要会让模型以为"前面什么都没发生" */
  ok(applyCompact(m, plan, '   ') === null, '空摘要不替换');
}

console.log('\n压缩：太短不动');
{
  ok(compactPlan(convo(1), { tail: 4 }) === null, '只有一轮就不压（压了也是空话）');
  /* 尾巴必须从 user 起：故意构造一个"尾巴落在 assistant 中间"的位置 */
  const m = convo(6);
  const plan = compactPlan(m, { tail: 2 });
  ok(plan && plan.tail[0].role === 'user', 'tail 小的时候也会把切点推到 user 上', plan?.tail[0]?.role);
}

console.log('\n摘要的输入');
{
  const m = convo(10);
  const t = transcriptFor(m);
  ok(/用户说：问题 0/.test(t), '带上第一句（头是"为什么聊这件事"）');
  ok(/用户说：问题 9/.test(t), '带上最后一句');
  ok(!/system/.test(t), '不把系统提示塞进去（那是身份，不是对话）');
  ok(t.length < 6500, `长度收敛在 ${t.length} 字`);
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
