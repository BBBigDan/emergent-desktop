/**
 * 上屏前的清洗自测：
 *
 *   node agent/speech.test.mjs
 *
 * 用例 1 是**线上原话**（2026-10-22，问"n8n 现在什么状态"）：
 * 正文两句之后，它接着写"第 1 步，调 logs_tail… 第 2 步，调 scene_show…"，
 * 还把参数 JSON 包进代码块 —— 整段都上了屏，400 字的一页被草稿占满。
 * 这不是提示词能修的（示例就长这样，7B 会照抄），必须在出口切掉。
 */

import { cleanSpeech } from './speech.mjs';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (extra ? ` — ${extra}` : '')); }
};

const REAL = `从最近的记录来看，n8n 的 pod 目前是运行状态，并且已经准备好运行（ready 状态为 3/3）。它没有显示有任何重启的记录。不过，为了确认这一点，我们可以进一步检查 n8n 的事件日志。你希望我查看一下吗？
第 1 步，调 logstail 查看 n8n 的最近日志。参数是 app: n8n。第 2 步，调 sceneshow 展示结果。参数长这样：
\`\`\`json
{"reading":"查看 n8n 的最近日志，看看它最近有没有重启。", "ask":"要看 n8n 的日志吗", "yes":"看看日志", "no":"先看着"}
\`\`\``;

console.log('线上原话');
{
  const t = cleanSpeech(REAL);
  ok(t.startsWith('从最近的记录来看'), '正文留着');
  ok(!t.includes('第 1 步'), '步骤说明切掉');
  ok(!t.includes('```'), '代码块切掉');
  ok(!t.includes('reading'), '参数 JSON 切掉');
  ok(t.length < 130, `从 ${REAL.length} 字降到 ${t.length} 字`);
}

console.log('\n不该误伤的');
{
  const fine = '内存现在 48%，比早上高了 6 个点。\n要不要看看是哪个应用涨的？';
  ok(cleanSpeech(fine) === fine, '普通两段话一个字不动');

  const mention = '我查了一下 pod 的事件，n8n 在 10:02 重启过一次，原因是内存超限。';
  ok(cleanSpeech(mention) === mention, '正文里提到工具/pod 不算草稿');

  const num = '磁盘用了 62%。1. 先清 Downloads；2. 再看镜像。';
  ok(cleanSpeech(num).includes('再看镜像'), '行内的"1. 2."不是步骤行（不切）');
}

console.log('\n其它形态');
{
  ok(cleanSpeech('') === '', '空串');
  ok(cleanSpeech('```json\n{"a":1}\n```') === '', '只有代码块 → 空');
  /* 没闭合的代码块：后面那半截正是 JSON 参数，必须一起切 */
  ok(cleanSpeech('先说结论：正常。\n```json\n{"reading":"x"') === '先说结论：正常。', '未闭合代码块也切');
  /* 行首 JSON 残片（没有围栏）。**不枚举键名** —— 线上漏过 label 这个键 */
  ok(cleanSpeech('CPU 21%。\n{"reading":"CPU 21%"') === 'CPU 21%。', '裸 JSON 行也切');
  ok(cleanSpeech('运行正常。\n{"label":"要看日志吗","yes":"看","no":"不看"}') === '运行正常。',
    '选项形态的 JSON 也切（label 曾经漏网）');
  /* 四空格缩进的代码块不是围栏，但内容是参数 —— 由 JSON_LINE 兜住 */
  ok(cleanSpeech('正常。\n    {"ask":"要看吗"}') === '正常。', '缩进的 JSON 也切');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
