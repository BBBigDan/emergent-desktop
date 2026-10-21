/**
 * 探模型：一次最小调用，只回答"这个模型现在能不能用"。
 *
 * 为什么单独写一个脚本，而不是随手用 node -e 打几个请求：
 * **零余额账户上，一次收费模型的调用就会把整个账户打停。**
 * 硅基流动的规则是「现金余额 < 0 → 停止该账户的全部 API 服务」，
 * 而停服是账户级的 —— 收费模型欠的那几分钱，会把免费模型一起带走。
 * 2026-10-21 就是这样把账号打停的：探测时混了四个收费模型，
 * 每个只跑了几百 token（合计不到一分钱），但余额本来是 0，
 * 于是结算后变成负数，几分钟后连 ¥0 的 Qwen 都开始 402。
 *
 * 所以这里的默认行为是**只碰免费模型**；要碰收费的，必须显式 --paid，
 * 而且它会把"余额可能为 0"这件事再提示一遍。
 *
 * 用法：
 *   node tools/dev/probe-model.mjs                    # 探全部免费模型
 *   node tools/dev/probe-model.mjs Qwen/Qwen3-8B      # 探指定的（必须免费）
 *   node tools/dev/probe-model.mjs --paid <model>     # 明确知道要花钱
 */

const KEY = process.env.MODEL_KEY || process.env.SF_KEY || '';

/* 已验证 ¥0 的模型（来源：硅基流动价格页 + 实测）。
   注意 DeepSeek-V4-Flash / GLM-5.3-Flash / Qwen3.5-9B 都不在这个名单里 ——
   名字里带 Flash 不代表免费。 */
const FREE = new Set([
  'Qwen/Qwen2.5-7B-Instruct',
  'Qwen/Qwen3-8B',
  'Qwen/Qwen3.5-4B',
  'THUDM/GLM-4-9B-0414',
  'THUDM/GLM-Z1-9B-0414',
  'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
  'XingChenAGI/Xing4.0-29B',
]);

const argv = process.argv.slice(2);
const allowPaid = argv.includes('--paid');
const ids = argv.filter((a) => !a.startsWith('--'));
const targets = ids.length ? ids : [...FREE];

if (!KEY) {
  console.error('缺 MODEL_KEY：先用 agent/.env 或环境变量给一个');
  process.exit(1);
}

const paid = targets.filter((id) => !FREE.has(id));
if (paid.length && !allowPaid) {
  console.error('这些模型不在免费名单里，会扣钱：');
  for (const p of paid) console.error('  ' + p);
  console.error('\n零余额账户上，一次收费调用会让**整个账户停服**（免费模型一起 402）。');
  console.error('确认要花这个钱就加 --paid。');
  process.exit(2);
}

let dead = 0;
for (const model of targets) {
  const t0 = Date.now();
  let line;
  try {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 2 }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (r.ok) {
      line = `OK    ${String(ms).padStart(6)}ms`;
    } else {
      dead++;
      /* 402 要单独说清楚：它不是这个模型的问题，是整个账户的问题 */
      const hint = r.status === 402
        ? '  ← 账户级停服（免费模型也会 402）。需实名 + 充值任意金额解锁'
        : r.status === 401 ? '  ← key 无效' : '';
      line = `FAIL  ${r.status} ${(j.message || '').slice(0, 40)}${hint}`;
    }
  } catch (e) {
    dead++;
    line = `ERR   ${e.name === 'TimeoutError' ? '超时' : e.message}`;
  }
  console.log(`${model.padEnd(38)} ${line}${FREE.has(model) ? '' : '  [收费]'}`);
}

if (dead && dead === targets.length) {
  console.log('\n全部不可用 —— 先看是不是账户余额的问题，不是模型选错了。');
}
