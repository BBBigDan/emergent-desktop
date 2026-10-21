/**
 * token 账本自测。不需要模型、不需要网络：
 *
 *   node agent/usage.test.mjs
 *
 * 它验的是四件"不做就会悄悄算错"的事：
 *   1. 上下文水位取自**最后一次** prompt_tokens，不是把历史累加（累加会因为重试、
 *      裁剪、记忆注入而算错，而且错得看不出来）。
 *   2. 没有单价就不算钱 —— 未知模型必须是 `null`（界面上显示"单价未配置"），
 *      不能是 0。¥0 和"不知道"在屏幕上长得一样，含义完全不同。
 *   3. 没有 usage 时按字数估，但必须打上 `est` 标记。
 *   4. 日账本跨会话累计；恢复会话快照**不会**把当天的账翻倍。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createMeter, estTokens, normUsage, ymd } from './usage.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'em-usage-'));
let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (extra ? ` — ${extra}` : '')); }
};

/* 环境变量是全局的，测完要清 —— 否则后面的用例会被前面写的价格污染 */
const resetEnv = () => {
  for (const k of ['MODEL_CTX', 'MODEL_PRICE_IN', 'MODEL_PRICE_OUT', 'TOKEN_DAY_CAP']) delete process.env[k];
};

/* ── 1. 估算 ── */
console.log('估算');
resetEnv();
{
  /* 中文一字一 token，英文四字符一 token。按 4 字符算中文会低估 3~4 倍，
     而低估的后果是"以为还有余量" —— 这是最不该错的方向。 */
  ok(estTokens('内存占用百分之四十') === 9, '中文按字算', String(estTokens('内存占用百分之四十')));
  ok(estTokens('abcdefgh') === 2, '英文四字符一 token', String(estTokens('abcdefgh')));
  ok(estTokens('') === 0, '空串是 0');
  ok(estTokens('一二三abcde') === 5, '中英混排分别算', String(estTokens('一二三abcde')));
}

/* ── 2. usage 归一化 ── */
console.log('归一化');
{
  ok(normUsage(null) === null, '没有 usage 时返回 null（交给上层估算）');
  ok(normUsage({}) === null, '空对象不算 usage');
  ok(normUsage({ prompt_tokens: 100, completion_tokens: 7 }).prompt === 100, '标准字段');
  ok(normUsage({ input_tokens: 100, output_tokens: 7 }).out === undefined
    && normUsage({ input_tokens: 100, output_tokens: 7 }).completion === 7, '兼容 input/output 命名');
  const c = normUsage({
    prompt_tokens: 100, completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 64 },
  });
  ok(c.cached === 64, '缓存命中单独拎出来');
  ok(c.est === false, '真实 usage 不带 est');
}

/* ── 3. 上下文水位 ── */
console.log('上下文水位');
resetEnv();
process.env.MODEL_CTX = '10000';
{
  const m = await createMeter({ model: 'some/model' });
  m.add({ prompt: 1000, completion: 50, cached: 0, est: false });
  m.add({ prompt: 1200, completion: 80, cached: 0, est: false });
  const s = m.snap();
  ok(s.ctx.tokens === 1200, '水位是最后一次 prompt_tokens，不是 1000+1200', String(s.ctx.tokens));
  ok(s.ctx.pct === 12, '百分比对得上', String(s.ctx.pct));
  ok(s.turn.in === 2200, '本轮输入是**累加**（两次调用都发了整份上下文）', String(s.turn.in));
  ok(s.turn.out === 130, '本轮输出累加', String(s.turn.out));
  ok(s.turn.calls === 2, '调用次数');
  /* 一个容易忽略的事实：上下文没变长时，第二次调用的 prompt_tokens 会**重复**
     算进本轮输入。这正是"多步长任务很贵"的原因，也是这个账本存在的理由。 */
  ok(s.turn.in > s.ctx.tokens, '多步的输入远超一次上下文大小');
}

/* ── 4. 估算标记 ── */
console.log('估算标记');
resetEnv();
{
  const m = await createMeter({ model: 'some/model' });
  const s = m.add({ prompt: 300, completion: 20, cached: 0, est: true });
  ok(s.turn.est === true, '估算值必须自己承认（est）');
  ok(s.session.est === true, '会话级也记住"含估算"');
}

/* ── 5. 钱 ── */
console.log('钱');
resetEnv();
{
  const free = await createMeter({ model: 'Qwen/Qwen2.5-7B-Instruct' });
  free.add({ prompt: 1_000_000, completion: 1_000_000, cached: 0, est: false });
  const s = free.snap();
  ok(s.price?.free === true, '免费模型认出来');
  ok(s.turn.cost === 0, '免费模型是 ¥0', String(s.turn.cost));

  const unknown = await createMeter({ model: 'acme/mystery-model' });
  unknown.add({ prompt: 1_000_000, completion: 1_000_000, cached: 0, est: false });
  ok(unknown.snap().price === null, '未知模型没有单价');
  ok(unknown.snap().turn.cost === null, '未知模型**不算钱**（不是 0）', String(unknown.snap().turn.cost));

  process.env.MODEL_PRICE_IN = '4';
  process.env.MODEL_PRICE_OUT = '16';
  const paid = await createMeter({ model: 'acme/mystery-model' });
  paid.add({ prompt: 1_000_000, completion: 500_000, cached: 0, est: false });
  ok(paid.snap().turn.cost === 12, '按 ¥4/¥16 每百万算：1M 入 + 0.5M 出 = ¥12', String(paid.snap().turn.cost));
  resetEnv();
}

/* ── 6. 轮次与日账本 ── */
console.log('轮次与日账本');
resetEnv();
{
  const dir = path.join(tmp, 'usage');
  const m = await createMeter({ model: 'Qwen/Qwen2.5-7B-Instruct', dir });
  m.beginTurn();
  m.add({ prompt: 500, completion: 30, cached: 0, est: false });
  await m.endTurn();
  m.beginTurn();
  m.add({ prompt: 700, completion: 40, cached: 0, est: false });
  await m.endTurn();
  const s = m.snap();
  ok(s.session.turns === 2, '两轮');
  ok(s.session.in === 1200, '会话累计输入');
  ok(m.history().length === 2, '每轮一条明细');
  ok(m.history()[1].in === 700, '明细里第二轮只有自己那一次');

  const file = path.join(dir, `${ymd()}.json`);
  const day = JSON.parse(await fs.readFile(file, 'utf8'));
  ok(day.in === 1200 && day.out === 70, '日账本落盘', JSON.stringify(day));

  /* 换一个会话（同一个 dir）—— 今天的账必须接着算，而不是从零开始。
     这是"重启会话不丢当天成本"的全部实现。 */
  const m2 = await createMeter({ model: 'Qwen/Qwen2.5-7B-Instruct', dir });
  ok(m2.snap().day.in === 1200, '新会话读回今天的账', String(m2.snap().day.in));
  ok(m2.snap().session.in === 0, '但会话级是干净的');

  /* 恢复快照：会话累计回来，日账本**不能**跟着翻倍 */
  m2.restore(s);
  const s2 = m2.snap();
  ok(s2.session.in === 1200, '恢复会话累计');
  ok(s2.ctx.tokens === 700, '恢复上下文水位');
  ok(s2.day.in === 1200, '恢复不会把日账本乘二', String(s2.day.in));
}

/* ── 7. 预算闸 ── */
console.log('预算闸');
resetEnv();
{
  const noCap = await createMeter({ model: 'Qwen/Qwen2.5-7B-Instruct' });
  ok(noCap.overBudget() === false, '没设上限就不拦');

  process.env.TOKEN_DAY_CAP = '1000';
  const m = await createMeter({ model: 'Qwen/Qwen2.5-7B-Instruct', dir: path.join(tmp, 'cap') });
  m.add({ prompt: 600, completion: 100, cached: 0, est: false });
  ok(m.overBudget() === false, '还没到上限');
  m.add({ prompt: 400, completion: 10, cached: 0, est: false });
  ok(m.overBudget() === true, '超了就拦（进出都算）');
  ok(m.snap().cap.limit === 1000, '上限在快照里可见');
  resetEnv();
}

/* ── 8. 上限来源 ── */
console.log('上下文上限');
resetEnv();
{
  const t = await createMeter({ model: 'Qwen/Qwen2.5-7B-Instruct' });
  ok(t.snap().limit === 32768 && t.snap().limitSrc === 'table', '认识 Qwen2.5 的窗口');
  const d = await createMeter({ model: 'acme/mystery-model' });
  ok(d.snap().limitSrc === 'default', '不认识就落缺省值，并**标出来**');
  process.env.MODEL_CTX = '200000';
  const e = await createMeter({ model: 'acme/mystery-model' });
  ok(e.snap().limit === 200000 && e.snap().limitSrc === 'env', '环境变量能推翻表');
  resetEnv();
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
