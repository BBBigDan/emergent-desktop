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

import { createSub, parseVerdict, roleBrief, looksLikeFence, ROLES, cleanLine } from './sub.mjs';

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

/* ─────────────────────── ②′ 扮一个人（写戏用） ─────────────────────── */
console.log('\n扮一个人：声音要分开');
{
  const c = roleBrief('character', { subject: '老陈，欠了三个月车贷的货车司机' });
  ok(/只扮演一个人/.test(c), '只扮一个人');
  ok(/你不知道对方在想什么/.test(c), '**切断它替对方体谅的路径**（这是戏死掉的头号原因）');
  ok(/不许承认他有道理/.test(c), '不许承认对方有道理');
  ok(/不会说/.test(c), '要求指出"有一类话这人不会说"（声音的边界比形容词有用）');
  ok(/你是：老陈/.test(c), `subject 当"你是"用，不是"审的对象"（${c.split('\n').find((l) => l.includes('老陈'))}）`);
  ok(!/声音：/.test(c), '**格式里没有「声音」**（强模型写成"短句、报数字"，弱模型抄进正文）');
  ok(/台词：/.test(c), '第一行是「台词」不是「结论」');
  const lineRow = (c.split('台词：')[1] || '').split('\n')[0] || '';
  ok(!/[（(]/.test(lineRow), `台词那一行没有括号套括号（${lineRow}）`);

  const v = parseVerdict([
    '结论：我没拔。',
    '理由：1) 车是我唯一的生计；2) 收车我就没活干；3) 登记证在我手里',
    '反对：他知道我上个月只还了两千',
    '声音：短句、报数字、不抬头',
  ].join('\n'));
  ok(/我没拔/.test(v.conclusion), `台词抓到了：${v.conclusion}`);
  ok(v.reasons.length === 3, `要什么/怕什么/筹码三条（${v.reasons.length}）`);
  ok(/只还了两千/.test(v.counter), '对手能戳中的地方也抓到了');
  /* `台词：` 必须和 `结论：` 一样被认出来 —— 7B 看到"结论"会当成正文去解说 */
  const v2 = parseVerdict(['台词：车你今天开不走', '理由：1) 要活 2) 怕没路 3) 拿车当筹码',
    '反对：他知道我拖不起'].join('\n'));
  ok(/开不走/.test(v2.conclusion), `「台词」也当结论解析：${v2.conclusion}`);
  ok(v2.reasons.length === 3, `理由三条（${v2.reasons.length}）`);

  /* 老角色不受影响：critic 的格式里不该出现"声音"这一行 */
  ok(!/声音：/.test(roleBrief('critic')), 'critic 的格式没被改脏');
  ok(Object.keys(ROLES).length === 3, `三个角色（${Object.keys(ROLES).join('/')}）`);
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

/* ─────────────────────── ④ 对戏：卡片不出服务端 ─────────────────────── */
console.log('\n对戏（两个人各自上下文，服务端拼）');

/** 假模型：按 prompt 里出现的东西决定回什么，顺便把每次调用的 prompt 记下来。 */
function duelStub(lines = ['我没拔。', '那就拖。', '你拖一个坐着的人试试。', '我拖。']) {
  const seen = [];
  let i = 0;
  const complete = async (req) => {
    const body = req.messages[1].content;
    seen.push(body);
    if (/^要什么：一句话$/m.test(body)) {
      /* 卡片：每人不同，靠 body 里出现的人名区分 */
      const who = /你是 (\S+?)。/.exec(body)?.[1] || '';
      return { content: `要什么：${who}要的东西\n怕什么：${who}怕的东西\n筹码：${who}的筹码` };
    }
    return { content: lines[i++ % lines.length] };
  };
  return { complete, seen };
}

{
  const s = duelStub();
  const sub = createSub({ complete: s.complete });
  const r = await sub.dialogue({
    cast: [{ name: '老陈', who: '货车司机' }, { name: '小段', who: '收车人' }],
    scene: '车贷逾期三个月',
    turns: 2,
  });
  ok(r.ok, `跑通了：${r.lines.length} 条台词`);
  ok(r.lines.length === 4, `turns=2 → 每人两句（${r.lines.length}）`);
  ok(r.lines.map((x) => x.name).join(',') === '老陈,小段,老陈,小段', '严格交替');
  ok(!('wants' in (r.lines[0] || {})), '**台词里没有卡片字段**（只有 name/line）');
  ok(!/要什么|筹码/.test(JSON.stringify(r)), '整个返回值里都没有卡片内容');
  ok(s.seen.length === 6, `调用次数 = 2 张卡 + 4 句（${s.seen.length}）`);

  /* 关键隔离：第二个人的第一句，只能看到第一个人的**台词**，看不到他的卡 */
  const second = s.seen[3] || '';
  ok(/他刚刚说：「我没拔。」/.test(second), `看得到对方说出口的那句：${second.slice(-60).replace(/\n/g, ' ')}`);
  ok(!/老陈要的东西|老陈的筹码/.test(second), '**看不到对方的卡**（这就是"体谅"没有机会发生的原因）');
  ok(/小段的筹码|小段要的东西/.test(second), '看得到自己的卡');
}

{
  /* 卡片生成时，两个人互不知道对方存在 */
  const s = duelStub();
  const sub = createSub({ complete: s.complete });
  await sub.dialogue({ cast: [{ name: '甲', who: 'A' }, { name: '乙', who: 'B' }], scene: 'x', turns: 1 });
  const cardCalls = s.seen.slice(0, 2);
  ok(!/乙/.test(cardCalls[0]), '做甲的卡时没提乙');
  ok(!/甲/.test(cardCalls[1]), '做乙的卡时没提甲');
}

{
  /* 参数与失败 */
  const sub = createSub({ complete: duelStub().complete });
  ok((await sub.dialogue({ cast: [{ name: '甲' }], scene: 'x' })).code === 'sub_bad_cast', '一个人不成戏');
  ok((await sub.dialogue({ cast: [{ name: '甲' }, { name: '乙' }, { name: '丙' }], scene: 'x' })).code === 'sub_bad_cast', '三个人也不行（只做两个，多给就拒）');
  ok((await sub.dialogue({ cast: [{ name: '甲' }, { name: '乙' }], scene: '' })).code === 'sub_empty', '没说情况就直说');

  /* 空台词**不许静默跳过**：那会让对手对着空气说话，读起来是两个独白 */
  const blank = createSub({
    complete: async (req) => (/^要什么：一句话$/m.test(req.messages[1].content)
      ? { content: '要什么：x\n怕什么：y\n筹码：z' } : { content: '   ' }),
  });
  const r = await blank.dialogue({ cast: [{ name: '甲' }, { name: '乙' }], scene: 'x', turns: 2 });
  ok(r.ok === false && r.code === 'sub_silent', `空台词报错而不是跳过（${r.code}）`);
  ok(Array.isArray(r.lines) && r.lines.length === 0, '把已经说出来的部分带回去，不吞掉');
}

{
  /* 台词清洗：引号、名字前缀、markdown 都要剥掉 —— 弱模型爱加这些 */
  const cases = [
    ['「我没拔。」', '我没拔。'],
    ['老陈：我没拔。', '我没拔。'],
    ['台词：我没拔。', '我没拔。'],
    ['我没拔。\n（他转过身）', '我没拔。'],
    ['"我没拔。"', '我没拔。'],
  ];
  let allOk = true;
  for (const [inp, want] of cases) {
    const got = cleanLine(inp);
    if (got !== want) { allOk = false; console.log(`    cleanLine(${JSON.stringify(inp)}) = ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`); }
  }
  ok(allOk, '台词清洗（引号 / 名字前缀 / 标签 / 旁白 / 英文引号）');
  ok(cleanLine('') === '', '空的不抛');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
