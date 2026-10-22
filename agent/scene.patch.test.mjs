/**
 * patch → set 的升级自测（`node agent/scene.patch.test.mjs`）。
 *
 * 它钉住的是 2026-10-22 线上那次"它说了好多个选项，但屏幕上没有"：
 * 屏幕上只有三个仪表，模型调 `scene_ask` 发了一个 `id: "ask"` 的 patch，
 * 而客户端 `patch()` 对不存在的层直接 `continue` —— 问题就这么消失了，
 * 模型却以为已经问过。
 *
 * 服务端现在把"打到新 id 的 patch"升级成一屏 set（旧层保留 + 新层加进去）。
 */

import { normalizeSpec, patchToSpec } from './scene.schema.mjs';

let failed = 0;
const ok = (c, l, e = '') => { if (c) console.log('  ✓ ' + l); else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); } };

const prev = {
  focus: 'g1',
  layers: [
    { id: 'g1', kind: 'gauge', label: 'CPU', value: 0.3 },
    { id: 'g2', kind: 'gauge', label: '内存', value: 0.7 },
    { id: 'g3', kind: 'gauge', label: '磁盘', value: 0.2 },
  ],
};

const ASK = [{
  id: 'ask',
  label: '要在 Navidrome 中查找《千与千寻》这部电影吗？',
  options: [{ id: 'yes', label: '查找', when: 'next' }, { id: 'no', label: '不找了', when: 'next' }],
}];

console.log('屏幕上有东西时，新层要加进去');
{
  const spec = patchToSpec(prev, ASK);
  ok(spec.layers.length === 4, `4 层（3 仪表 + 问句），实际 ${spec.layers.length}`);
  const fork = spec.layers.find((l) => l.id === 'ask');
  ok(fork?.kind === 'fork', 'ask 那一层是 fork');
  ok(fork?.options?.length === 2, '两个选项都在');
  /* 问句不能被截成半句 —— schema 的上限是 30（屏幕上排两行） */
  const norm = normalizeSpec(spec);
  ok(!!norm.spec, '正常化通过', JSON.stringify(norm.dropped || []));
  const f2 = norm.spec.layers.find((l) => l.id === 'ask');
  ok(f2.label === ASK[0].label, `问句原文保留：${f2.label}`);
  ok(f2.label.length > 14, '超过旧上限 14 字也没被切', String(f2.label.length));
  ok(norm.spec.layers.length === 4, '三个仪表没被吃掉');
}

console.log('空场也能长出问句');
{
  const spec = patchToSpec(null, ASK);
  ok(spec.layers.length === 1 && spec.layers[0].kind === 'fork', '只有一层 fork');
  ok(normalizeSpec(spec).spec?.layers?.length === 1, '正常化通过');
}

console.log('已有层走合并，不重复添加');
{
  const spec = patchToSpec(prev, [{ id: 'g1', value: 0.9, label: 'CPU' }]);
  ok(spec.layers.filter((l) => l.id === 'g1').length === 1, 'g1 只有一层');
  ok(spec.layers.find((l) => l.id === 'g1').value === 0.9, '值被更新');
}

console.log('只有一句问题、没有选项');
{
  const spec = patchToSpec(prev, [{ id: 'q', label: '要看看 n8n 的日志吗' }]);
  ok(spec.layers.length === 4 && spec.layers[3].kind === 'condense', '退化成一句凝缩的话（至少看得见）');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
