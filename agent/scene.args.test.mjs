/**
 * 畸形参数自测：`node agent/scene.args.test.mjs`
 *
 * 它钉住的是 2026-10-23 线上那次"它明明写好了，屏幕上却什么都没有"：
 * V4.1-Flash 调 `scene_show` 时把**后面所有字段当成了 reading 的一部分**
 * 写进字符串里（还老老实实转义了）：
 *
 *   {"reading":"…要不要我看一眼？",\n  \"gauges\": […],\n  \"note\": …}
 *
 * JSON 完全合法，所以我们解析成功 —— 拿到的是 `{reading: "…后面还跟着一大段 JSON"}`。
 * 于是 `expandShow` 看到"没给 gauges、没给 ask"，回一句"这一屏什么都没有"，
 * 模型重写一遍。屏幕上闪过一行 ✕，用户看到的是"它先失败了一次"。
 *
 * 夹具 `fixtures/squeezed-reading.json` 是**线上原样**（只截了 reading 正文的措辞？
 * 没有 —— 一个字都没动，440 字的那个字符串就是它发出来的）。
 */

import fs from 'node:fs';
import { unwrapReading } from './scene.schema.mjs';
import { makeTools } from './tools.mjs';

let failed = 0;
const ok = (c, l, e = '') => { if (c) console.log('  ✓ ' + l); else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); } };

const squeezed = JSON.parse(fs.readFileSync(new URL('./fixtures/squeezed-reading.json', import.meta.url), 'utf8'));

console.log('线上那个 440 字的畸形参数');
{
  ok(Object.keys(squeezed).length === 1 && typeof squeezed.reading === 'string', '夹具确实是"只有一个 reading"（不然这个用例就失去意义了）');
  ok(squeezed.reading.length > 400, `原文 ${squeezed.reading.length} 字`);

  const f = unwrapReading(squeezed);
  ok(Object.keys(f).length === 6, `拆出 6 个键：${Object.keys(f).join(',')}`);
  ok(String(f.reading).length < 250, `reading 收到 ${String(f.reading).length} 字（剩下的 JSON 去掉了）`);
  ok(!/"gauges"/.test(String(f.reading)), 'reading 里不再有字段名');
  ok(Array.isArray(f.gauges) && f.gauges.length === 3, '三个仪表挖出来了');
  ok(f.gauges[0].label === '整机内存' && Math.abs(f.gauges[0].value - 0.447) < 1e-9, '仪表的值是对的（不是 0，也不是字符串）');
  ok(f.ask === '要看 n8n 最近的运行情况吗' && f.yes === '看日志' && f.no === '先不用', '问句和两个选项都在');
  ok(f.note === 'n8n 355MB，是三者里最大的', 'note 也在');
  ok(/\?$|？$/.test(String(f.reading)), '正文以问号收尾（切点没吃掉最后一句）');

  /* 拆开之后要真的能铺出一屏 —— 只"拆对"但铺不出东西还是没有意义。
     （`normalizeSpec` 吃的是完整 spec，不是这些扁平参数；真正的验收在最后一段。） */
}

console.log('\n正常参数不许动');
{
  const good = { reading: '机器不忙。', gauges: [{ label: 'CPU', value: 0.2 }], ask: '要看吗', yes: '看', no: '不看' };
  const f = unwrapReading(good);
  ok(f === good, '多键 → 原样返回（同一个对象，连拷贝都不做）');

  /* 正文里本来就有的引号：不能因为看见一个引号就去切 */
  const quoted = { reading: '他说"别动"，然后就走了。', gauges: [{ label: 'CPU', value: 0.2 }] };
  ok(unwrapReading(quoted) === quoted, '正文里的引号不被当成 JSON');
}

console.log('\n只有 reading、但里面没有字段名');
{
  const plain = { reading: '机器基本是闲的，CPU 只有 3%。' };
  ok(unwrapReading(plain) === plain, '原样返回');
  ok(unwrapReading({}) .reading === undefined, '空对象不抛');
  ok(unwrapReading(null).reading === undefined, 'null 不抛');
  ok(unwrapReading({ reading: 42 }).reading === 42, '非字符串不动（交给后面的校验去说）');
}

console.log('\n尾巴没闭合：至少把 JSON 从正文里切掉');
{
  /* 模型写到一半停了（max_tokens / 用户按停）。挖不出对象，但正文必须是干净的 ——
     否则那段带引号的花括号会被 say 通道念出来。 */
  const cut = { reading: '机器不忙。",\n  \\"gauges\\": [{\\"label\\": \\"CPU\\", \\"value\\": 0.2' };
  const f = unwrapReading(cut);
  /* 句号留着：它是正文的标点，去掉就成了半句话。要切掉的只是那段 JSON。 */
  ok(f.reading === '机器不忙。', `正文收干净了：${JSON.stringify(f.reading)}`);
  ok(!f.gauges, '挖不出来就不硬凑（没有 gauges 也行，不能编）');
}

console.log('\n接进工具之后真的能铺');
{
  const t = makeTools({ source: 'host' });
  const r = await t.exec('scene_show', squeezed);
  ok(r.ok === true, 'scene_show 成功（以前这里是「这一屏什么都没有」）');
  ok(r.spec?.layers?.length === 5, `5 层（3 仪表 + note + ask），实际 ${r.spec?.layers?.length}`);
  ok(r.spec?.layers?.some((l) => l.kind === 'fork'), '问句层在');
  ok(String(r.say || '').length > 150, `say 是完整的正文（${String(r.say || '').length} 字）`);
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
