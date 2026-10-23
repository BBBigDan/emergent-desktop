/**
 * 一个"坏掉"的模型桩（OpenAI 兼容）。`node tools/dev/stub-flaky.mjs`
 *
 * 它存在的唯一理由：`agent/loop.test.mjs` 要能**确定地**制造三种"模型不说结论"的
 * 情况，验证这一轮仍然有结局。真模型只会偶发这些毛病，测不稳。
 *
 *   loop  —— 每一步都调工具，参数还都不一样（所以不是"原地打转"），
 *            走到步数上限也从不说话
 *   stuck —— 每一步都调同一个工具、同一组参数
 *   mute  —— 空回复：没有 content，也没有 tool_calls
 *   dead  —— 连"你说结论"（上层收口时不再给工具）都不理
 *
 * 环境变量：MODE / PORT / LOG（每个请求记一行，`tools=0` 那次就是收口）。
 *
 * 三种坏毛病，都是线上真的出现过的：
 *   loop  —— 每一步都调工具，参数还都不一样（所以不是"原地打转"），
 *            走到步数上限也从不说话
 *   stuck —— 每一步都调同一个工具、同一组参数（模型卡住了）
 *   mute  —— 空回复：没有 content，也没有 tool_calls
 *
 * 每个请求记一行到 .tmp/fake-<mode>.log，好回答那个关键问题：
 * **循环结束之后，它到底有没有再问模型一次要结论？**
 */
import http from 'node:http';
import fs from 'node:fs';

const MODE = process.env.MODE || 'loop';
const PORT = Number(process.env.PORT || 11500);
const LOG = process.env.LOG || `.tmp/fake-${MODE}.log`;

let n = 0;
const send = (res, o) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(o));
};

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/v1/models')) {
      return send(res, { data: [{ id: `stub-${MODE}` }] });
    }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404).end('{}'); return; }

    let j = {};
    try { j = JSON.parse(body); } catch { /* 记录里留空即可 */ }
    n++;
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1] || {};
    /* 关键观测点：`tool_choice` 是 none 就说明上层在**要结论**（收口），
       而不是又让模型调一次工具。 */
    fs.appendFileSync(LOG, JSON.stringify({
      n,
      toolChoice: j.tool_choice ?? null,
      tools: (j.tools || []).length,
      lastRole: last.role,
      lastTail: String(last.content || '').slice(-90),
      /* 这一次是不是上层在**要结论**。判全文、不判尾部 ——
         那段提示一百多字，结尾是"不要说抱歉"，切尾部切不到关键句。 */
      closing: String(last.content || '').includes('不要再调工具'),
    }) + '\n');

    const usage = { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 };
    const choice = (message, finish = 'stop') => send(res, {
      choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
      usage,
    });

    /* 收口请求（tool_choice:none）必须给一句话 —— 模拟"好模型被要求总结时会答"。
       这样能验证的是：**我们有没有把那次机会给它**。 */
    const finalish = j.tool_choice === 'none' || !(j.tools || []).length;
    if (finalish) {
      /* dead：连"你说结论"都不理 —— 测的是最后那道系统兜底 */
      if (MODE === 'dead') return choice({ content: '' });
      return choice({ content: '我查了两三个地方，都没拿到有用的东西。' }, 'stop');
    }

    if (MODE === 'mute') return choice({ content: '' });
    if (MODE === 'stuck') {
      return choice({
        content: '',
        tool_calls: [{
          id: `c_stuck_${n}`, type: 'function',
          function: { name: 'sys_status', arguments: '{}' },
        }],
      }, 'tool_calls');
    }
    /* loop：参数每步都不同，所以不会被"重复调用"那条判据掐掉 */
    return choice({
      content: '',
      tool_calls: [{
        id: `c_loop_${n}`, type: 'function',
        function: { name: 'fs_list', arguments: JSON.stringify({ path: `~/nope-${n}` }) },
      }],
    }, 'tool_calls');
  });
}).listen(PORT, () => console.log(`fake-bad ${MODE} on ${PORT}`));
