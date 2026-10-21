/**
 * 限流重试自测。不需要真模型 —— 起一个本地假服务端，按剧本回 429：
 *
 *   node agent/model.retry.test.mjs
 *
 * 它验的是"看起来像变蠢"的那个坑：
 *   1. 429 之后要**真的等**（1s / 3s / 7s 退避），不能 500ms 就放弃 ——
 *      免费模型的限流窗口是"每分钟 N 次"，等半秒等于没等。
 *   2. 重试有上限（一共 3 次），不能因为 429 一直排下去。
 *   3. 最终失败要带 `limited` 标记，上层才能说"被限流了"而不是"模型出错了"。
 *   4. 服务端给了 `Retry-After` 就听它的。
 */

import http from 'node:http';
import { createOpenAIModel } from './model.openai.mjs';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (extra ? ` — ${extra}` : '')); }
};

/** 假服务端：`plan` 是每次请求要回什么。 */
async function makeServer(plan) {
  let n = 0;
  const hits = [];
  const srv = http.createServer((req, res) => {
    const step = plan[Math.min(n, plan.length - 1)];
    n++;
    hits.push({ at: Date.now(), step: step.status });
    if (step.status === 429) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        ...(step.retryAfter ? { 'Retry-After': String(step.retryAfter) } : {}),
      });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { url: `http://127.0.0.1:${port}/v1`, hits, close: () => srv.close() };
}

console.log('429 之后真的等');
{
  const s = await makeServer([{ status: 429 }, { status: 200 }]);
  const m = createOpenAIModel({ baseURL: s.url, apiKey: 'x', model: 'test', timeoutMs: 20_000 });
  const t0 = Date.now();
  const out = await m.complete({ messages: [{ role: 'user', content: 'hi' }] });
  const ms = Date.now() - t0;
  ok(out.content === '好', '重试之后成功');
  ok(ms >= 900, `等够了（${ms}ms ≥ 1s 退避）`, String(ms));
  ok(s.hits.length === 2, '只多打了一次');
  s.close();
}

console.log('\nRetry-After 优先');
{
  const s = await makeServer([{ status: 429, retryAfter: 1 }, { status: 200 }]);
  const m = createOpenAIModel({ baseURL: s.url, apiKey: 'x', model: 'test', timeoutMs: 20_000 });
  const t0 = Date.now();
  await m.complete({ messages: [{ role: 'user', content: 'hi' }] });
  const ms = Date.now() - t0;
  ok(ms >= 900 && ms < 4000, `按 Retry-After=1 等（${ms}ms）`, String(ms));
  s.close();
}

console.log('\n一直被限流要有上限');
{
  const s = await makeServer([{ status: 429 }]);
  const m = createOpenAIModel({ baseURL: s.url, apiKey: 'x', model: 'test', timeoutMs: 30_000 });
  const t0 = Date.now();
  let err = null;
  try { await m.complete({ messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok(!!err, '最终抛错');
  ok(err?.limited === true, '带 limited 标记（上层才能说"被限流了"）', String(err?.limited));
  ok(s.hits.length === 3, `一共试了 3 次（实际 ${s.hits.length}）`);
  /* 1s + 3s 两次等待，第三次直接抛 —— 不能等满三个窗口 */
  ok(ms >= 3500 && ms < 20_000, `总耗时在 4~20s（${ms}ms）`, String(ms));
  s.close();
}

console.log('\n500 还是快重试');
{
  const s = await makeServer([{ status: 500 }, { status: 200 }]);
  const m = createOpenAIModel({ baseURL: s.url, apiKey: 'x', model: 'test', timeoutMs: 20_000 });
  const t0 = Date.now();
  await m.complete({ messages: [{ role: 'user', content: 'hi' }] });
  const ms = Date.now() - t0;
  ok(ms < 1200, `5xx 不该等太久（${ms}ms）`, String(ms));
  s.close();
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
