/**
 * 模型清单的自测：`node agent/models.test.mjs`
 *
 * 它钉住的是**这张表最坏的失败方式**：一条看起来能用、点下去却什么也干不了的选项。
 * 那种错不会报错、不会红，只会让用户以为"这个 agent 坏了"。所以这里查的是：
 *
 *   ① 每一行都必须回答"会不会想 / 会不会调工具 / 多少钱"，不许留 undefined；
 *   ② 不会调工具的**必须写明原因**（否则那一行就是灰着让人猜）；
 *   ③ 价格：本地一律 0，**不知道的一律 null** —— 填 0 是这套东西里最贵的错
 *      （"¥0.0000"和"免费"在屏幕上长得一样，人会放心地跑一整天）；
 *   ④ id → 接口的翻译只有一处，本地那几行不许被发去平台。
 */

/* 环境变量会覆盖价格表（那是给线上改价用的），自测里先摘干净 */
delete process.env.MODEL_PRICE_IN;
delete process.env.MODEL_PRICE_OUT;
delete process.env.MODEL_CTX;
/* 指到一个必然关着的端口：本地探测要快，而且结果确定（= 没发现） */
process.env.MODEL_LOCAL_BASE = 'http://127.0.0.1:9/v1';
delete process.env.MODEL_KEY;

import { catalog, findModel, routeOf, priceOf, localBase, DEFAULT_MODEL } from './models.mjs';

let failed = 0;
const ok = (c, l, e = '') => { if (c) console.log('  ✓ ' + l); else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); } };

const all = (c) => c.groups.flatMap((g) => g.models);

console.log('表的形状');
const cat = await catalog();
{
  ok(cat.groups.length === 2, `两组：${cat.groups.map((g) => g.label).join(' / ')}`);
  ok(cat.groups[0].key === 'local' && cat.groups[1].key === 'platform', '本地在前、平台在后');
  ok(cat.groups[0].models[0].id === 'mock', '本地第一个永远是 mock（没网没 key 时唯一能用的那个）');
  const ms = all(cat);
  ok(new Set(ms.map((m) => m.id)).size === ms.length, `id 没有重复（${ms.length} 条）`);
  ok(ms.some((m) => m.id === DEFAULT_MODEL), '默认模型在表里');
  for (const m of ms) {
    ok(['true', 'false', 'null'].includes(String(m.think)), `${m.name} 的 think 是三态之一（${m.think}）`);
    ok(['true', 'false', 'null'].includes(String(m.tools)), `${m.name} 的 tools 是三态之一（${m.tools}）`);
    ok(typeof m.note === 'string' && m.note.length > 0, `${m.name} 有一句说明`);
  }
}

console.log('不可用的必须说原因');
{
  const bad = all(cat).filter((m) => !m.usable);
  ok(bad.length >= 1, `表里有不可用的（${bad.length} 条）`);
  for (const m of bad) ok(!!m.why, `${m.name} 写了 why：${m.why || '(空)'}`);
  /* tools === false 的一条都不能可用 —— 这是拒绝切换的依据 */
  ok(all(cat).filter((m) => m.tools === false && m.usable).length === 0, 'tools=false 的全都不可选');
  /* 没配 key 时平台整组灰着（不是删掉）：看得见"有这些"，也知道差什么 */
  const pf = cat.groups.find((g) => g.key === 'platform');
  ok(pf.models.every((m) => !m.usable), '没配 MODEL_KEY 时平台整组不可选');
  /* 两条本来就"不会调工具"的，理由比"没 key"更具体，先说自己的那条 */
  ok(pf.models.every((m) => m.why === '没配 MODEL_KEY' || m.tools === false),
    '其余的原因写的是"没配 MODEL_KEY"');
  ok(!!pf.empty, '并且那一组顶部有一句说明');
}

console.log('价格');
{
  ok(priceOf('mock').free, 'mock 免费');
  ok(priceOf('local/anything').free, '本地的模型一律 0（不产生 API 账）');
  ok(priceOf('Qwen/Qwen3-8B').free, 'Qwen3-8B 是 ¥0');
  /* 这一条是核心：不知道不等于 0 */
  ok(priceOf(DEFAULT_MODEL) === null, '收费且没配单价的 → null（不是 0）');
  ok(priceOf('随便/一个不存在的模型') === null, '不认识的模型 → null');
  const paid = all(cat).find((m) => m.id === DEFAULT_MODEL);
  ok(paid.price === null && paid.cost === 'paid', '表里那条：price=null 但 cost=paid（"按量，单价未配置"）');
  process.env.MODEL_PRICE_IN = '2';
  process.env.MODEL_PRICE_OUT = '8';
  const p = priceOf(DEFAULT_MODEL);
  ok(p && p.in === 2 && p.out === 8 && p.src === 'env', '给了环境变量就按环境变量算');
  ok(priceOf('Qwen/Qwen3-8B').free === false, '环境变量会覆盖（这是线上改价用的开关）');
  delete process.env.MODEL_PRICE_IN;
  delete process.env.MODEL_PRICE_OUT;
}

console.log('id → 接口（只有这一处翻译）');
{
  const a = routeOf('mock');
  ok(a.kind === 'mock', 'mock 不走网络');
  const b = routeOf('local/qwen3:8b');
  ok(b.kind === 'openai' && b.model === 'qwen3:8b', '本地：前缀剥掉，模型名原样发');
  ok(b.baseURL === localBase(), '本地：base 指向本地服务');
  const c = routeOf('Qwen/Qwen3-8B');
  ok(c.kind === 'openai' && c.model === 'Qwen/Qwen3-8B', '平台：整条 id 就是模型名');
  ok(/siliconflow/.test(c.baseURL), '平台：base 是硅基流动');
  ok(routeOf().model === DEFAULT_MODEL, '不给 id 就用默认模型');
}

console.log('查找与拒绝');
{
  ok((await findModel('mock'))?.usable, '找得到 mock');
  ok((await findModel('Qwen/Qwen3-8B'))?.id === 'Qwen/Qwen3-8B', '找得到平台的');
  ok((await findModel('local/qwen3:8b')) === null, '本地没跑，就找不到本地模型（不许凭空造一个）');
  ok((await findModel('nope/x')) === null, '不认识的 id → null（调用方据此拒绝切换）');
  ok((await findModel('')) === null, '空 id → null');
  ok((await findModel('Qwen/Qwen3.5-4B'))?.usable === false, 'Qwen3.5-4B 找得到但不可用');
}

console.log('本地那一组：探测不到也要能看');
{
  const g = cat.groups[0];
  ok(!!g.empty, '没发现本地服务时给了一句怎么办');
  ok(!g.note, '不会把"未发现"写两遍');
  ok(g.models.length === 1 && g.models[0].id === 'mock', '只剩 mock');
}

console.log(failed ? `\n${failed} 项没过` : '\n全部通过');
process.exit(failed ? 1 : 0);
