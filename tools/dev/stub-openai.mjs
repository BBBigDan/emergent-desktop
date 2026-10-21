/**
 * 本地 OpenAI 兼容桩。
 *
 * 为什么需要它：真模型的账户余额说没就没（402），但**协议不该被余额挡住**。
 * 这个小服务把"模型"这一端固定下来，于是可以确定地验证三件与模型质量无关的事：
 *
 *   1. 请求干净吗 —— 我们的会话里带 intent 等私有字段，桩会把收到的原文落盘，
 *      直接 grep 就知道有没有漏给服务端。
 *   2. 非法输出挡得住吗 —— 加 --bad，它故意吐 value=71、两个 fork、七个 layer、
 *      拼错的 kind，用来验 scene.schema.mjs 的边界。
 *   3. 循环与审批跑得通吗 —— 它是无状态的：靠"最后一条 user 之后有几个
 *      assistant.tool_calls"决定这一步该说什么，所以重放同一段对话得到的响应一致。
 *
 * 用法：
 *   node tools/dev/stub-openai.mjs                  # :8790
 *   node tools/dev/stub-openai.mjs --bad            # 每次 scene 都吐坏 spec
 *   MODEL_BASE=http://127.0.0.1:8790/v1 MODEL=stub MODEL_KEY=x node agent/server.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.STUB_PORT || 8790);
const BAD = process.argv.includes('--bad');
const LOG = path.join(ROOT, '.tmp', 'stub-req.jsonl');

const tc = (name, args) => ({
  id: `c_${name}_${Math.random().toString(36).slice(2, 7)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const ok = (content, tool_calls = []) => ({ content, tool_calls });

/** 最后一条 user 之后，模型已经发过几次工具调用 */
function stepsSinceUser(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;
  return messages.slice(i + 1).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
}

const lastUser = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.content || '';

function decide(messages) {
  const step = stepsSinceUser(messages);
  const text = String(lastUser(messages));

  if (BAD) {
    /* 一次把所有典型错误犯完，看校验层能不能全挡住并如实回报 */
    if (step === 0) {
      return ok('', [tc('scene_set', { spec: { focus: 'nope', mood: 'happy', layers: [
        { id: 'cpu', kind: 'gauge', label: 'CPU 使用率', value: 71 },
        { id: 'cpu', kind: 'gauge', label: '重复 id', value: 0.2 },
        { id: '1bad', kind: 'wat', label: '拼错 kind' },
        { id: 'f1', kind: 'fork', label: '第一问', options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] },
        { id: 'f2', kind: 'fork', label: '第二问', options: [{ id: 'a', label: '丙' }, { id: 'b', label: '丁' }] },
        { id: 'g2', kind: 'gauge', label: 'G2' },
        { id: 'g3', kind: 'gauge', label: 'G3' },
        { id: 'g4', kind: 'gauge', label: 'G4' },
        { id: 'c1', kind: 'condense', text: '这一行结论很长很长很长很长很长很长很长很长很长很长很长' },
        { id: 't1', kind: 'trace', label: '只有一点', data: [0.5] },
      ] } })]);
    }
    return ok('');
  }

  /* ── 手势：拖了一个仪表 ── */
  if (text.startsWith('[手势]') && /拖/.test(text)) {
    if (step === 0) {
      return ok('压到 34% 要重启 n8n，会中断它正在跑的活。', [
        tc('scene_patch', { ops: [{ id: 'ask', label: '用 4 GB 换 34%？', options: [
          { id: 'yes', label: '压到 34%' }, { id: 'no', label: '算了' },
        ] }] }),
        tc('scene_pulse', { kind: 'arrive', at: 'ask' }),
      ]);
    }
    return ok('');
  }

  /* ── 手势：点了"看看日志" ── */
  if (text.startsWith('[手势]') && /看看日志|选了/.test(text)) {
    if (step === 0) return ok('', [tc('logs_tail', { app: 'n8n', lines: 8 })]);
    if (step === 1) {
      return ok('日志是 502 和 OOMKilled，不是网络问题。', [tc('scene_transition', { spec: {
        focus: 'rs', mood: 'alert', layers: [
          { id: 'rs', kind: 'trace', label: 'n8n · 24 小时', data: Array.from({ length: 24 }, (_, h) => 0.2 + (h > 13 ? 0.5 : 0) + (h % 5 === 0 ? 0.2 : 0)) },
          { id: 'mem', kind: 'gauge', label: '内存', value: 0.6 },
          { id: 'ask', kind: 'fork', label: '卡在 Notion 节点？', options: [{ id: 'off', label: '先禁用它' }, { id: 'keep', label: '保留' }] },
        ] } })]);
    }
    return ok('');
  }

  /* ── 一句话：直接动危险工具（验审批门） ── */
  if (/压内存/.test(text)) {
    if (step === 0) return ok('要重启 n8n 才能压下去。', [tc('mem_trim', { to: 0.34 })]);
    return ok('');
  }

  /* ── 一句话：三步步进 ── */
  if (step === 0) return ok('我先看一眼。', [tc('sys_status', {})]);
  if (step === 1) return ok('', [tc('app_list', {})]);
  if (step === 2) {
    return ok('CPU 71% · 内存 60%', [tc('scene_set', { spec: {
      focus: 'iss', mood: 'alert', layers: [
        { id: 'cpu', kind: 'gauge', label: 'CPU', value: 0.71 },
        { id: 'mem', kind: 'gauge', label: '内存', value: 0.6 },
        { id: 'disk', kind: 'gauge', label: '磁盘', value: 0.48 },
        { id: 'iss', kind: 'turbulence', level: 0.45 },
        { id: 'ask', kind: 'fork', label: '要处理 n8n 重启吗', options: [{ id: 'yes', label: '看看日志' }, { id: 'no', label: '先看着' }] },
      ] } })]);
  }
  return ok('');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('{"error":"not found"}');
    return;
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400).end('{"error":"bad json"}'); return; }

    /* 落盘原文：验"消息洗干净了没有"全靠这一行 */
    try {
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), body }) + '\n');
    } catch { /* 日志失败不影响响应 */ }

    const out = decide(body.messages || []);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-stub',
      model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: out.content, tool_calls: out.tool_calls },
        finish_reason: out.tool_calls.length ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
  });
});

server.listen(PORT, () => {
  console.log(`stub-openai  http://127.0.0.1:${PORT}/v1   bad=${BAD}`);
  console.log(`  请求原文 → ${LOG}`);
});
