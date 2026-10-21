/**
 * OpenAI 兼容适配器（默认指向硅基流动）。
 *
 * 换模型只换这个文件 —— `server.mjs` 的循环一行都不用动。这不是为了"通用"，
 * 而是因为循环里那几条纪律（一次一步、重复调用即中止、危险动作过审批）
 * 是**协议**的性质，不是某个模型的性质。
 *
 * 三件在真实接口上必须处理、mock 里不存在的事：
 *
 * 1. **消息要洗干净。** 我们的会话里带 `intent`（手势的结构化原样）
 *    和 `name` 之外的私有字段，OpenAI 形状里没有它们。有的服务端会直接 400，
 *    有的会静默丢弃 —— 后者更糟：你以为模型看到了手势的数值，其实没有。
 *
 * 2. **失败要分类。** 429 和 5xx 是"过一会儿再来"，400 是"你发的东西不对"。
 *    对前者重试，对后者必须把原文抛出来，否则调提示词时会一直以为是模型笨。
 *
 * 3. **工具调用不是一定有的。** 便宜模型经常在该调工具时只回一句话，
 *    或者吐出半截 JSON。返回结构与 mock 严格一致，让上层的处理逻辑只有一套。
 */

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1';
/* 默认落在一张 ¥0 的模型上：余额为 0 的账户用收费模型会触发账户级停服，
   连免费模型一起 402。要换更强的模型，自己设 MODEL。 */
const DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct';

/** 只保留 OpenAI 认识的字段。`intent` 这类私有字段漏出去就是 400。 */
function cleanMessages(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? '' };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: {
          name: c.function?.name || '',
          /* 有的模型会把 arguments 直接给成对象，回灌时要序列化成字符串 */
          arguments: typeof c.function?.arguments === 'string'
            ? c.function.arguments
            : JSON.stringify(c.function?.arguments ?? {}),
        },
      }));
    }
    if (m.role === 'tool') {
      out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
    }
    return out;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOpenAIModel(o = {}) {
  const baseURL = (o.baseURL || process.env.MODEL_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = o.apiKey || process.env.MODEL_KEY || '';
  const model = o.model || process.env.MODEL || DEFAULT_MODEL;
  const temperature = Number(o.temperature ?? process.env.MODEL_TEMP ?? 0.3);
  const maxTokens = Number(o.maxTokens ?? process.env.MODEL_MAX_TOKENS ?? 900);
  const timeoutMs = Number(o.timeoutMs ?? process.env.MODEL_TIMEOUT ?? 45_000);
  const retries = Number(o.retries ?? 2);

  if (!apiKey) {
    throw new Error('缺少 MODEL_KEY：在 agent/.env 里写 MODEL_KEY=sk-...（或设环境变量）');
  }

  async function once({ messages, tools, toolChoice = 'auto' }) {
    const body = {
      model,
      messages: cleanMessages(messages),
      temperature,
      max_tokens: maxTokens,
    };
    /* 没有工具时不能发 tools: []，部分服务端会当"空工具集"报错 */
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const t0 = Date.now();
        const r = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        const text = await r.text();
        let j;
        try { j = JSON.parse(text); } catch { j = null; }

        if (!r.ok) {
          const detail = (j?.error?.message || j?.message || text || '').slice(0, 300);
          /* 4xx（除 429）是请求本身的问题，重试只会重复同一个错误 */
          const retryable = r.status === 429 || r.status >= 500;
          const err = new Error(`模型接口 ${r.status}：${detail || '(无返回内容)'}`);
          err.status = r.status;
          if (!retryable) throw err;
          lastErr = err;
          await sleep(500 * (attempt + 1));
          continue;
        }

        const msg = j?.choices?.[0]?.message || {};
        return {
          content: typeof msg.content === 'string' ? msg.content.trim() : '',
          tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
          /* 长度被截断时上面的 tool_calls 可能是半截 JSON —— 上层要能看出来 */
          truncated: j?.choices?.[0]?.finish_reason === 'length',
          ms: Date.now() - t0,
        };
      } catch (e) {
        /* 超时 / DNS / 连接被重置：同样是"过一会儿再来" */
        if (e.status) throw e;
        lastErr = new Error(
          e.name === 'TimeoutError' || e.name === 'AbortError'
            ? `模型超时（${timeoutMs}ms 没有返回）`
            : `连不上模型：${e.message}`
        );
        if (attempt === retries) throw lastErr;
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  return {
    name: `sf:${model}`,
    model,
    async complete({ messages, tools }) {
      const out = await once({ messages, tools });
      if (out.truncated && !out.tool_calls.length) {
        console.warn('[model] 输出被 max_tokens 截断');
      }
      return out;
    },
  };
}
