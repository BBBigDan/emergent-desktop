/**
 * 探"思考"：`node tools/dev/probe-think.mjs [模型…]`
 *
 * `probe-model.mjs` 只回答"这个模型现在能不能用"（一次 hi，2 个 token）。
 * 但换模型时真正要问的是另外两件事，而且**它们都不能靠名字猜**：
 *
 *   ① 它返回 `reasoning_content` 吗？—— 没有的话，界面左上那栏就只有
 *      "调了什么、画了什么"，用户会说"看起来很怪"（2026-10-22 的原话）。
 *   ② 它的**工具调用**靠得住吗？—— 思考能力白给也不行：实测有模型
 *      （Qwen3.5-4B）会把调用写成 `<tool_call>` **文本**，还有模型
 *      （DeepSeek-R1-0528-Qwen3-8B）直接 400 "Function call is not supported"。
 *
 * 判据是**两轮**：第一轮该调 sys_status，把结果回灌后该接着调 scene_show。
 * 只测一轮的话，"会调"和"调对了"分不开。
 *
 * 为什么花钱要小心：零余额账户上，收费模型的一点点调用就会触发
 * 「现金余额 < 0 → 停整个账户的 API」，连 ¥0 的模型一起 402（见 probe-model.mjs）。
 * 所以默认**只跑免费名单**，收费模型必须 `--paid`，而且要你点名。
 *
 * 用法：
 *   node tools/dev/probe-think.mjs                      # 探免费名单里那些"可能能思考"的
 *   node tools/dev/probe-think.mjs Qwen/Qwen3-8B        # 点名探（必须在免费名单里）
 *   node tools/dev/probe-think.mjs --paid deepseek-ai/DeepSeek-V4.1-Flash
 */

const KEY = process.env.MODEL_KEY || process.env.SF_KEY || '';
const BASE = process.env.MODEL_BASE || 'https://api.siliconflow.cn/v1';

/* 已验证 ¥0 且**可能**有推理能力的（看名字带 R1 / Z1 / Qwen3 的那些）。
   注意 Qwen2.5-7B-Instruct 也在这里：它不思考，作为"对照组"——
   一个不返回 reasoning_content 的基线，比只看"有"的更容易判断。 */
const FREE = new Set([
  'Qwen/Qwen2.5-7B-Instruct',
  'Qwen/Qwen3-8B',
  'Qwen/Qwen3.5-4B',
  'THUDM/GLM-Z1-9B-0414',
  'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
  'XingChenAGI/Xing4.0-29B',
]);
const DEFAULT_CAND = [
  'Qwen/Qwen3-8B',
  'THUDM/GLM-Z1-9B-0414',
  'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
  'XingChenAGI/Xing4.0-29B',
];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'sys_status',
      description: '看这台机器的 CPU/内存/磁盘现状。问"机器忙不忙"必须先调它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scene_show',
      description: '在屏幕上铺一屏读数。',
      parameters: {
        type: 'object',
        properties: { reading: { type: 'string', description: '一句话结论，≤30 字' } },
        required: ['reading'],
        additionalProperties: false,
      },
    },
  },
];

const SYS = '你是这台 Olares 的设备助手。要看机器状态必须先调工具，不许凭空说数。**思考也用中文。**';

if (!KEY) {
  console.error('缺 MODEL_KEY：先用 agent/.env 或环境变量给一个');
  process.exit(1);
}

const argv = process.argv.slice(2);
const allowPaid = argv.includes('--paid');
const picked = argv.filter((a) => !a.startsWith('--'));
const targets = picked.length ? picked : DEFAULT_CAND;

if (picked.length && picked.some((m) => !FREE.has(m)) && !allowPaid) {
  console.error('这些不在免费名单里，会扣钱：');
  for (const m of picked.filter((x) => !FREE.has(x))) console.error('  ' + m);
  console.error('\n零余额账户上，一次收费调用会让**整个账户停服**（免费模型一起 402）。');
  console.error('确认要花这个钱就加 --paid。');
  process.exit(2);
}

async function ask(model, messages) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      /* Qwen3 系列的思考开关；别的模型不认这个字段，给了不报错 */
      enable_thinking: true,
      max_tokens: 900,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = await r.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (!r.ok) return { err: `${r.status} ${(j.message || j.error?.message || '').slice(0, 80)}`, ms };
  const m = j?.choices?.[0]?.message || {};
  return {
    ms,
    think: String(m.reasoning_content || m.reasoning || ''),
    content: String(m.content || ''),
    calls: (m.tool_calls || []).map((c) => ({ name: c.function?.name, args: c.function?.arguments })),
    finish: j?.choices?.[0]?.finish_reason,
    reasonTokens: j?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

/** 中文占比：思考语言是这个探针的一半目的 */
const zhRatio = (s) => {
  const ch = Array.from(String(s || ''));
  if (!ch.length) return 0;
  return ch.filter((c) => /[\u4e00-\u9fa5]/.test(c)).length / ch.length;
};

let bad = 0;
for (const model of targets) {
  console.log(`\n=== ${model}`);
  const a = await ask(model, [
    { role: 'system', content: SYS },
    { role: 'user', content: '机器现在忙不忙？' },
  ]);
  if (a.err) { bad++; console.log('   ✕ 第一轮就失败：' + a.err); continue; }

  const think1 = a.think.trim();
  const zh = zhRatio(think1);
  console.log(`   第一轮 ${a.ms}ms · finish=${a.finish} · reasoning_tokens=${a.reasonTokens}`);
  console.log(`   思考 ${Array.from(think1).length} 字（中文 ${Math.round(zh * 100)}%）`);
  if (think1) console.log('     ' + JSON.stringify(Array.from(think1.slice(0, 70)).join('')));
  console.log(`   调 ${a.calls.length ? a.calls.map((c) => c.name).join(', ') : '(没调)'}`);

  if (!think1) console.log('   → 不会思考（界面那栏只会显示动作）');
  else if (zh < 0.3) console.log('   → 会思考，但**不是中文**（不加"思考也用中文"就会这样）');

  if (!a.calls.length) {
    bad++;
    console.log('   ✕ 没调工具：这一轮在真实 agent 里就废了');
    continue;
  }

  /* 第二轮：回灌结果，看它会不会继续下一步（真实的 agent 循环） */
  const b = await ask(model, [
    { role: 'system', content: SYS },
    { role: 'user', content: '机器现在忙不忙？' },
    {
      role: 'assistant',
      content: a.content,
      tool_calls: a.calls.map((c, i) => ({
        id: `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args },
      })),
    },
    {
      role: 'tool',
      tool_call_id: 'call_0',
      name: a.calls[0].name,
      content: JSON.stringify({ cpu: 0.21, mem: 0.41, disk: 0.38, note: 'CPU 21% · 内存 41% · 磁盘 38%' }),
    },
  ]);
  if (b.err) { bad++; console.log('   ✕ 回灌后失败：' + b.err); continue; }
  console.log(`   第二轮 ${b.ms}ms · 思考 ${Array.from(b.think.trim()).length} 字 · 调 ${b.calls.map((c) => c.name).join(', ') || '(没调，直接说)'}`);
  if (b.calls.some((c) => c.name === a.calls[0].name)) {
    console.log(`   ⚠ 又调了一次 ${a.calls[0].name} —— 可能原地打转`);
  }
  console.log(`   → ${b.calls.length ? 'OK：会顺着结果往下走' : 'OK：拿到结果就收口'}`);
}

console.log(bad ? `\n${bad} 个模型不可用于 agent` : '\n全部可用于 agent 循环');
process.exit(0);
