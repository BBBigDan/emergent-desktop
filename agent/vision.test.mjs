/**
 * `probeOnce`（**显式核对**那条路）的自测。
 *
 * 注意定位：正常对话**不走这里** —— 能力来自公开资料（`models.mjs` 的 `vision` 列），
 * 只有"怀疑网关把图丢了"时才会手动核一次。但这条路一旦走，判据必须准，
 * 所以下面把四种态度都装了一遍。
 *
 * 这里的桩**必须能装四种态度**（收图并认对、400 拒图、200 但说看不见、答非所问），
 * 因为这四件事在真实平台上都发生过：
 *   · 400 是真拒绝；
 *   · 200 但"我看不到图片"是**网关静默丢了图** —— 只看状态码会判成"能看"，
 *     然后我们就会得到一段基于"不存在的图"的胡说。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeOnce, createVision, stripImages, redPNG } from './vision.mjs';
import { sniffImage } from './docs.mjs';

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed += 1; };

const KEY = 'k-test';
const BASE = 'https://sf.example/v1';

/** 造一个"某种态度"的桩；`hits` 记被调用了几次。 */
function stub(attitude) {
  const st = { hits: 0, lastBody: null };
  st.fetch = async (url, opt) => {
    st.hits += 1;
    st.lastBody = JSON.parse(opt.body || '{}');
    const reply = (status, obj) => ({
      ok: status < 400,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(obj),
    });
    if (attitude === 'yes') return reply(200, { choices: [{ message: { content: '红色' } }] });
    if (attitude === 'yes-en') return reply(200, { choices: [{ message: { content: 'The color is red.' } }] });
    if (attitude === 'reject') return reply(400, { error: { message: 'image_url content type is not supported by this model' } });
    if (attitude === 'blind') return reply(200, { choices: [{ message: { content: '我看不到图片，请描述一下。' } }] });
    if (attitude === 'offtopic') return reply(200, { choices: [{ message: { content: '你好，有什么可以帮你？' } }] });
    if (attitude === '402') return reply(402, { error: { message: 'insufficient balance' } });
    if (attitude === 'boom') throw new Error('connect ECONNREFUSED');
    return reply(500, {});
  };
  return st;
}

console.log('① 探测的四种结局（这是整个模块的判据）');
{
  const a = stub('yes');
  const r = await probeOnce({ model: 'm', baseURL: BASE, apiKey: KEY, fetchImpl: a.fetch });
  ok(r.vision === true, `认出了颜色 → 能看（${r.why}）`);
  ok(/image_url/.test(JSON.stringify(a.lastBody?.messages)), '发出去的确实是图片段，不是纯文字');

  const b = stub('yes-en');
  const r2 = await probeOnce({ model: 'm', baseURL: BASE, apiKey: KEY, fetchImpl: b.fetch });
  ok(r2.vision === true, '英文回答也算（"red"）');

  const c = stub('reject');
  const r3 = await probeOnce({ model: 'm', baseURL: BASE, apiKey: KEY, fetchImpl: c.fetch });
  ok(r3.vision === false, `400 提到图片 → 不能看（${r3.why}）`);

  const d = stub('blind');
  const r4 = await probeOnce({ model: 'm', baseURL: BASE, apiKey: KEY, fetchImpl: d.fetch });
  ok(r4.vision === false, `200 但自己说看不见 → 不能看（${r4.why}）—— 只看状态码会判错`);

  const e = stub('offtopic');
  const r5 = await probeOnce({ model: 'm', baseURL: BASE, apiKey: KEY, fetchImpl: e.fetch });
  ok(r5.vision === null, `答非所问 → **不知道**，不硬判（${r5.why}）`);
}

console.log('\n② 探不出来时不能记成"看不见"');
{
  const c = stub('402');
  const r = await probeOnce({ model: 'm', baseURL: BASE, apiKey: KEY, fetchImpl: c.fetch });
  ok(r.vision === null, `402（余额不足）→ 不知道（${r.why}）`);

  const b = stub('boom');
  const r2 = await probeOnce({ model: 'm', baseURL: BASE, apiKey: KEY, fetchImpl: b.fetch });
  ok(r2.vision === null, `连不上 → 不知道（${r2.why}）`);

  const r3 = await probeOnce({ model: 'm', baseURL: BASE, apiKey: '', fetchImpl: b.fetch });
  ok(r3.vision === null && /key/.test(r3.why), '没 key 直接说没 key，不发请求');
}

console.log('\n③ 缓存：同一个模型只探一次，换地址要重新探');
{
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vis-')), 'vision.json');
  const a = stub('yes');
  const v = createVision({ file, fetchImpl: a.fetch });

  const r1 = await v.check({ model: 'm1', baseURL: BASE, apiKey: KEY });
  ok(r1.vision === true && a.hits === 1, '第一次真的探了');
  const r2 = await v.check({ model: 'm1', baseURL: BASE, apiKey: KEY });
  ok(r2.vision === true && a.hits === 1, `第二次走缓存（请求数还是 ${a.hits}）`);
  ok(r2.cached === true, '结果上标明是缓存');
  const r3 = await v.check({ model: 'm1', baseURL: BASE, apiKey: KEY, force: true });
  ok(r3.vision === true && a.hits === 2, `force 重探（${a.hits} 次）`);

  /* 同一个 id 在另一个网关上可能是另一个东西：只按 id 记会互相污染 */
  const b = stub('reject');
  const v2 = createVision({ file, fetchImpl: b.fetch });
  const r4 = await v2.check({ model: 'm1', baseURL: 'https://other.example/v1', apiKey: KEY });
  ok(r4.vision === false, '换 baseURL 就是另一条记录（不沿用上一个网关的结论）');

  /* 落盘之后重开还能读回来：pod 重启不能让"探过的"白探 */
  const v3 = createVision({ file, fetchImpl: a.fetch });
  const k = v3.known('m1', BASE);
  ok(k.vision === true && k.fresh === true, '重启后仍然记得，而且是新鲜期内的');
  const kOld = v3.known('m1', 'https://other.example/v1');
  ok(kOld.vision === false, '另一条也在');
}

console.log('\n④ 撞出来的证据也能写进去（mark）');
{
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vis-')), 'vision.json');
  const v = createVision({ file, fetchImpl: stub('boom').fetch });
  v.mark('m9', BASE, { vision: false, why: '接口 400：不支持 image_url' });
  ok(v.known('m9', BASE).vision === false, '写进去了');
  ok(createVision({ file }).known('m9', BASE).vision === false, '也落盘了');
}

console.log('\n⑤ stripImages：撤图之后消息**条数与角色不变**');
{
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: [{ type: 'text', text: '看到了' }] },
  ];
  const r = stripImages(msgs);
  ok(r.count === 1, `撤掉 1 张（${r.count}）`);
  ok(r.messages.length === msgs.length, '条数不变（protocol 靠条数和顺序）');
  ok(r.messages[2].role === 'user' && typeof r.messages[2].content === 'string', '变成纯文本');
  ok(/看图/.test(r.messages[2].content) && /图/.test(r.messages[2].content), '正文保留，并且留下一句"图被撤了"');
  ok(r.messages[1] === msgs[1], '没图的工具消息原样不动（tool_call_id 必须留着）');
  const none = stripImages([{ role: 'user', content: 'hi' }]);
  ok(none.count === 0, '没有图时什么都不做');
}

console.log('\n⑥ 那张测试图是真的图');
{
  const png = redPNG(8);
  ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG 签名对');
  const info = sniffImage(png);
  ok(info?.mime === 'image/png' && info.width === 8 && info.height === 8, `文件头能读出来（${info?.width}×${info?.height}）`);
  ok(png.length < 400, `足够小（${png.length} 字节），探一次几乎不花钱`);
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
