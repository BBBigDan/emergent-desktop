/**
 * 子 agent 自测：`node agent/sub.test.mjs`
 *
 * 钉住三件事（都不能靠"看着对"）：
 *   ① 输出解析：模型给的是中文行标签，不是 JSON。它给歪了也要**拿到能用的东西**，
 *      而不是空 —— 空会被主 agent 读成"没人反对"。
 *   ② 立场不许被中和：role brief 里必须明确禁止那几句和稀泥的话；
 *      真给一段和稀泥的话，`fence` 必须为 true（这是**量它有没有变好**的唯一信号）。
 *   ③ 失败要能分辨：空回复 ≠ 没问题；超时 ≠ 模型说错了。混在一起会让主 agent
 *      以为方案过关了。
 */

import { createSub, parseVerdict, roleBrief, looksLikeFence, ROLES } from './sub.mjs';

let failed = 0;
const ok = (c, l, e = '') => { if (c) console.log('  ✓ ' + l); else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); } };

/* ─────────────────────── ① 解析 ─────────────────────── */
console.log('解析（中文行标签，不是 JSON）');
{
  const v = parseVerdict([
    '结论：不该常驻，它挤掉的是别的应用的内存',
    '理由：1) 6 核 7Gi 在这台机器上等于一半算力；2) 空闲时也占着内存不还；3) 出图那几分钟桌面明显卡',
    '反对：如果不常驻，用户每次要画图都得等 4 分钟启动',
  ].join('\n'));
  ok(v.parsed, '认出了标签');
  ok(/不该常驻/.test(v.conclusion), `结论抓到了：${v.conclusion}`);
  ok(v.reasons.length === 3, `三条理由都拆出来了（${v.reasons.length}）`);
  ok(/一半算力/.test(v.reasons[0]), `第一条内容对：${v.reasons[0]}`);
  ok(/4 分钟启动/.test(v.counter), `反对意见抓到了：${v.counter}`);
  ok(v.fence === false, '这段没有和稀泥');

  /* 没有标签：**不许返回空**，整段当结论并标 parsed=false */
  const v2 = parseVerdict('我觉得这个方案有问题，主要是内存占用太高了。');
  ok(v2.conclusion.length > 5, `没标签也能拿到话：${v2.conclusion.slice(0, 20)}…`);
  ok(v2.parsed === false, '标出"没按格式来"（调用方可以决定要不要重问）');

  /* 半懂：只给了结论没有理由 —— 不许假装完整 */
  const v3 = parseVerdict('结论：应该做');
  ok(v3.parsed === true && v3.reasons.length === 0, '只有结论就这样，不编理由');

  /* 常见变形：markdown 列表、全角冒号、英文冒号、"判断"当结论 */
  const v4 = parseVerdict('- 判断: 值得\n- 理由：1. 便宜；2. 快\n- 反驳：会多花钱');
  ok(/值得/.test(v4.conclusion), `全角/半角冒号都认：${v4.conclusion}`);
  ok(v4.reasons.length === 2, `编号前缀剥掉了（${v4.reasons.length}）`);
  ok(/多花钱/.test(v4.counter), '反驳也认');

  ok(parseVerdict('').conclusion === '', '空输入不抛');
  ok(parseVerdict(null).reasons.length === 0, 'null 不抛');
}

/* ─────────────────────── ② 不许和稀泥 ─────────────────────── */
console.log('\n立场不许被中和');
{
  const c = roleBrief('critic', { subject: '一个画图工具的默认参数' });
  ok(/只找问题/.test(c), 'critic 只找问题');
  ok(/不做平衡/.test(c), '明确说了不做平衡');
  ok(!/也要看到优点/.test(c), '没有"也要看到优点"这种自我中和的指令');
  ok(/这取决于/.test(c) && /各有优劣/.test(c), '把禁止说的几句列出来了');

  const a = roleBrief('advocate');
  ok(/不许用缺点来抵消结论/.test(a), 'advocate 不许用缺点抵消结论');

  ok(Object.keys(ROLES).includes('critic') && Object.keys(ROLES).includes('advocate'), '两个角色都在');
  ok(roleBrief('不存在的角色').length > 20, '坏角色名退回 critic，不抛');

  /* 指纹：这是"改前/改后"能用同一个尺子量的那个数 */
  ok(looksLikeFence('这取决于你的需求，各有优劣。'), '和稀泥的话能被认出来');
  ok(looksLikeFence('没有绝对的对错，视情况而定'), '换一种说法也认');
  ok(!looksLikeFence('结论：不该常驻，因为 6 核是这台机器一半算力'), '明确的结论不算和稀泥');
}

/* ─────────────────────── ③ 运行与失败 ─────────────────────── */
console.log('\n运行：一次调用、无工具、失败要能分辨');
const stub = (content, extra = {}) => async (req) => {
  stub.last = req;
  if (extra.throw) throw new Error(extra.throw);
  return { content, usage: { prompt: 100, completion: 20 } };
};

{
  const sub = createSub({ complete: stub('结论：该做\n理由：1) 便宜\n反对：要多花一次调用') });
  const r = await sub.run({ role: 'critic', task: '帮我审一下这个方案', subject: '画图默认参数' });
  ok(r.ok && /该做/.test(r.conclusion), `跑通了：${r.conclusion}`);
  ok(r.roleZh === '挑毛病', `带回中文角色名（${r.roleZh}）`);

  /* 关键：**不给工具**（嵌套因此不可能），**看不到主对话** */
  ok(Array.isArray(stub.last.tools) && stub.last.tools.length === 0, '没有传工具表');
  ok(stub.last.messages.length === 2, `只有 system + task 两条（实际 ${stub.last.messages.length}）`);
  ok(!JSON.stringify(stub.last.messages).includes('画图默认参数') === false, 'subject 进了 system');
  ok(r.ms >= 0, '带了耗时');
}

{
  /* 空回复 = 没人说话，不是"没问题" */
  const sub = createSub({ complete: stub('   ') });
  const r = await sub.run({ role: 'critic', task: 'x' });
  ok(r.ok === false && r.code === 'sub_silent', `空回复单独一个码（${r.code}）`);
  ok(/不是"没问题"|不是\"没问题\"/.test(r.error), `话里说清了：${r.error}`);
}

{
  const sub = createSub({ complete: stub('x', { throw: 'Connection error.' }) });
  const r = await sub.run({ role: 'critic', task: 'x' });
  ok(r.ok === false && r.code === 'sub_failed', `模型报错不抛出去（${r.code}）`);

  const sub2 = createSub({ complete: stub('x', { throw: 'The operation was aborted' }) });
  const r2 = await sub2.run({ role: 'critic', task: 'x' });
  ok(r2.code === 'sub_timeout', `超时和普通错误分开（${r2.code}）`);

  const sub3 = createSub({ complete: stub('x') });
  ok((await sub3.run({ role: 'critic', task: '' })).code === 'sub_empty', '没给材料就直说');
  ok((await sub3.run({ role: '神明', task: 'x' })).code === 'sub_bad_role', '坏角色直接拒，不静默退回');

  const sub4 = createSub({});
  ok((await sub4.run({ role: 'critic', task: 'x' })).code === 'sub_unavailable', '没接模型时给一个明确的码');
}

{
  /* 用量要回传：子 agent 也算钱，否则账本对不上（一次判断 = 多一次调用） */
  let got = null;
  const sub = createSub({ complete: stub('结论：x\n理由：1) y'), onUsage: (u) => { got = u; } });
  await sub.run({ role: 'critic', task: 'x' });
  ok(got && got.prompt === 100, `用量回传了（${JSON.stringify(got)}）`);
  ok(sub.calls === 1, '数了调用次数');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
