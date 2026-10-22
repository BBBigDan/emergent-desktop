/**
 * 分叉问句断行自测：`node shell/src/forktitle.test.mjs`
 *
 * 用例 1 是线上原话（2026-10-22）：问句被 14 字上限切成
 * 「要在 Navidrome 中…」，屏幕上只有半句话。
 */

import { splitTitle } from './forktitle.js';

let failed = 0;
const ok = (c, l, e = '') => { if (c) console.log('  ✓ ' + l); else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); } };

console.log('线上那句');
{
  const q = '要在 Navidrome 中查找《千与千寻》这部电影吗？';
  const L = splitTitle(q);
  ok(L.length === 2, `两行：${JSON.stringify(L)}`);
  ok(!L[0].endsWith('…'), '第一行不是被硬截的');
  ok(L.join('').replace(/\s/g, '').length >= q.replace(/\s/g, '').length - 1, '内容没丢（最多差一个省略号）');
  ok(L[1].includes('？') || L[1].includes('吗'), '问号留在最后一行');
  ok(L.every((x) => Array.from(x).length <= 15), `每行 ≤15：${L.map((x) => Array.from(x).length)}`);
}

console.log('短的照旧一行');
{
  ok(JSON.stringify(splitTitle('要看 n8n 的日志吗')) === JSON.stringify(['要看 n8n 的日志吗']), '一行，一个字不动');
  ok(splitTitle('').length === 0, '空串 → 空数组');
  ok(splitTitle(null).length === 0, 'null → 空数组');
}

console.log('太长的收在第二行');
{
  const L = splitTitle('这是一句特别特别长的问题，长到两行都放不下，只能截断了，真的很长很长');
  ok(L.length === 2, '最多两行');
  ok(L[1].endsWith('…'), '放不下就补省略号');
  ok(Array.from(L[1]).length <= 15, '第二行不超宽');
}

console.log('断点优先标点');
{
  const L = splitTitle('先看看磁盘，然后我们再决定要不要清理');
  ok(L[0].endsWith('，'), `第一行断在逗号：${L[0]}`);
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
