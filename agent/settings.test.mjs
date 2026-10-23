/**
 * 设置的自测：`node agent/settings.test.mjs`
 *
 * 它钉住的是**"改了但没生效"的四种长相**（这四种在屏幕上都像"没保存"，
 * 而原因完全不同，用户自己分不出来）：
 *
 *   ① 地址写错一层 —— 贴了 `/chat/completions`、粘了两遍、没写协议。
 *      服务端不该照单全收：一个 `https://a/v1https://a/v1` 能通过 `new URL()`，
 *      然后每一轮请求都发到一个不存在的路径，报错看起来像"对方挂了"。
 *   ② key 的三种状态 —— 没传（不改）/ 空串（清掉）/ 新值（换）。
 *      混了就会"我明明没动，key 怎么没了"。
 *   ③ 提示词的空值 —— 替换栏被删空必须退回内置那套，否则模型连
 *      "你面前是一片粒子屏"都不知道。空字符串是最容易被当成"一个值"的。
 *   ④ 脱敏 —— GET 里**不许有 apiKey 字段**。这块面板会被截图。
 *
 * 另外把"设置怎么进模型表"这一条链也量了：加了接口 → 表里多一组「自定义」→
 * id 能翻译成 baseURL → 删掉之后切不回它。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  applyPatch, saveSettings, loadSettings, getSettings, publicSettings,
  normalizeBaseURL, _reset, settingsFile,
} from './settings.mjs';
import { catalog, findModel, routeOf, setCustomProviders } from './models.mjs';
import { systemPrompt, buildSystemPrompt } from './prompt.mjs';

let n = 0;
let failed = 0;
function ok(cond, name, extra) {
  n++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}

/* 自测不碰用户真正的设置文件 */
const TMP = path.join(os.tmpdir(), `em-settings-${process.pid}.json`);
process.env.SETTINGS_FILE = TMP;
delete process.env.MODEL_KEY;

/* ─────────────────── ① 地址：三种手滑都要接住 ─────────────────── */
console.log('地址归一化');
{
  ok(normalizeBaseURL('https://a.test/v1') === 'https://a.test/v1', '正常地址原样');
  ok(normalizeBaseURL('https://a.test/v1///') === 'https://a.test/v1', '去掉多余的结尾斜杠');
  ok(normalizeBaseURL('a.test/v1') === 'https://a.test/v1', '没写协议就补 https');
  ok(normalizeBaseURL('https://a.test/v1/chat/completions') === 'https://a.test/v1',
    '贴了完整的 /chat/completions 也剥回 /v1');
  ok(normalizeBaseURL('https://a.test/v1https://a.test/v1') === '',
    '粘了两遍的地址直接判无效（new URL 拦不住这个）');
  ok(normalizeBaseURL('') === '', '空串是空串，不补协议');
  ok(normalizeBaseURL('http://127.0.0.1:8080/v1') === 'http://127.0.0.1:8080/v1', 'http 和端口都留着');
}

/* ─────────────────── ② key 的三态 ─────────────────── */
console.log('key 的三态');
{
  _reset();
  let r = applyPatch({
    providers: [{ name: 'A', baseURL: 'https://a.test/v1', apiKey: 'sk-first', models: 'm1' }],
  });
  const id = r.settings.providers[0].id;
  ok(/^p_[a-z0-9]{6}$/.test(id), `id 形状对（${id}）`);

  /* 不带 apiKey 字段 = 不改 */
  r = applyPatch({ providers: [{ id, name: 'A', baseURL: 'https://a.test/v1', models: 'm1' }] });
  ok(r.settings.providers[0].apiKey === 'sk-first', '没传 key 就不动它');

  /* 空串 = 清掉（本地网关不需要 key，这是合法状态） */
  r = applyPatch({ providers: [{ id, name: 'A', baseURL: 'https://a.test/v1', apiKey: '', models: 'm1' }] });
  ok(r.settings.providers[0].apiKey === '', '空串把 key 清掉');

  /* 新值 = 换掉，而且 id 不变（改 key 不该让它变成"另一条接口"） */
  r = applyPatch({ providers: [{ id, name: 'A2', baseURL: 'https://a.test/v1', apiKey: 'sk-second', models: 'm1' }] });
  ok(r.settings.providers[0].apiKey === 'sk-second', '新值换掉');
  ok(r.settings.providers[0].id === id, 'id 沿用了（不是新加一条）');
  ok(r.settings.providers[0].name === 'A2', '名字能改');
}

/* ─────────────────── ③ 校验：该拒的拒，该丢的丢 ─────────────────── */
console.log('校验');
{
  _reset();
  const r = applyPatch({
    providers: [
      { name: '整条空的' },
      { name: '只填了名字' },
      { name: '地址坏的', baseURL: 'ftp://x', models: 'm' },
      { name: '没模型', baseURL: 'https://b.test/v1' },
      { name: '好的', baseURL: 'https://c.test/v1', models: 'x, y\nz, x' },
    ],
  });
  const keep = r.settings.providers.map((p) => p.name);
  ok(!keep.includes('整条空的'), '全空的卡片静默丢掉（用户只是点了一下"+"）');
  ok(keep.length === 1 && keep[0] === '好的', `只留下填好的那条（实际：${keep.join('/')}）`);
  ok(r.settings.providers[0].models.length === 3, '模型名去重（x, y, z）');
  ok(r.notes.length >= 2, `填了一半的要说明原因（${r.notes.length} 条）`);
}

/* ─────────────────── ④ 提示词：空值必须退回内置 ─────────────────── */
console.log('提示词');
{
  _reset();
  const builtin = buildSystemPrompt();
  ok(systemPrompt({}).length === builtin.length, '默认就是内置那套');

  const app = systemPrompt({ append: '叫我老板' });
  ok(app.endsWith('叫我老板'), '追加写在末尾');
  ok(app.startsWith(builtin.slice(0, 40)), '内置那套一个字没动');

  ok(systemPrompt({ replace: '   ' }).length === builtin.length, '替换栏只有空白 → 退回内置');
  ok(systemPrompt({ replace: '你是一只猫' }) === '你是一只猫', '替换真的替换');
  ok(systemPrompt({ replace: '你是一只猫', append: '叫我老板' }).includes('叫我老板'),
    '替换 + 追加两个都生效');

  /* 设置里的空值也要落到同一个结论 */
  const r = applyPatch({ prompt: { append: '只说短句', replace: '  ' } });
  ok(r.settings.prompt.replace === '', '空白替换被归一化成空串');
  ok(systemPrompt(getSettings().prompt).endsWith('只说短句'), '走设置拿到的提示词也正确');
}

/* ─────────────────── ⑤ 行为：夹紧范围，不让人把 agent 弄死 ─────────────────── */
console.log('行为');
{
  _reset();
  let r = applyPatch({ behavior: { temp: 5, maxSteps: 999 } });
  ok(r.settings.behavior.temp <= 1.2, `温度被夹在 1.2（${r.settings.behavior.temp}）`);
  ok(r.settings.behavior.maxSteps <= 30, `步数夹在 30（${r.settings.behavior.maxSteps}）`);
  r = applyPatch({ behavior: { temp: -1, maxSteps: 1 } });
  ok(r.settings.behavior.temp === 0, '温度不小于 0');
  ok(r.settings.behavior.maxSteps >= 3, '步数不小于 3（少于 3 连"查一下再说"都走不完）');
  r = applyPatch({ behavior: { temp: 'x', maxSteps: null } });
  ok(r.settings.behavior.temp === 0 && r.settings.behavior.maxSteps === 3, '乱填的值退回上一次的');
}

/* ─────────────────── ⑥ 脱敏：GET 里不许有明文 key ─────────────────── */
console.log('脱敏');
{
  _reset();
  applyPatch({ providers: [{ name: 'A', baseURL: 'https://a.test/v1', apiKey: 'sk-super-secret-9876', models: 'm' }] });
  const pub = publicSettings();
  const raw = JSON.stringify(pub);
  ok(!raw.includes('super-secret'), '公开的那份里根本没有 key');
  ok(!('apiKey' in pub.providers[0]), '连字段名都不出现');
  ok(pub.providers[0].hasKey === true, '但告诉界面"有 key"');
  ok(pub.providers[0].keyTail === '9876', '给尾四位，好让人确认是哪一个');
}

/* ─────────────────── ⑦ 落盘：存了要读得回来 ─────────────────── */
console.log('落盘');
{
  _reset();
  await saveSettings({
    providers: [{ name: 'B', baseURL: 'https://b.test/v1', apiKey: 'k1', models: 'm1, m2' }],
    prompt: { append: '短一点' },
    behavior: { temp: 0.5, maxSteps: 8 },
  });
  const st = await fs.stat(TMP);
  ok(st.size > 20, '文件写了');
  ok(settingsFile() === path.resolve(TMP), 'settingsFile() 认 SETTINGS_FILE');

  _reset();
  const back = await loadSettings(TMP);
  ok(back.providers.length === 1 && back.providers[0].apiKey === 'k1', 'key 读得回来（服务端要它）');
  ok(back.prompt.append === '短一点', '提示词读得回来');
  ok(back.behavior.maxSteps === 8, '行为读得回来');

  /* 坏文件不该让 agent 起不来 */
  await fs.writeFile(TMP, '{ 这不是 json');
  _reset();
  const bad = await loadSettings(TMP);
  ok(bad.providers.length === 0 && bad.behavior.maxSteps > 0, '文件坏了就退回默认值，不抛');

  await fs.rm(TMP, { force: true });
  _reset();
  const none = await loadSettings(TMP);
  ok(none.providers.length === 0, '文件不存在也退回默认值');
}

/* ─────────────────── ⑧ 设置怎么进模型表 ─────────────────── */
console.log('进模型表');
{
  setCustomProviders([
    { id: 'p_ab12cd', name: '我的中转', baseURL: 'https://x.test/v1', apiKey: 'k', models: ['gpt-4o-mini', 'openai/gpt-4o'] },
  ]);
  const c = await catalog();
  const g = c.groups.find((x) => x.key === 'custom');
  ok(!!g, '表里出现「自定义」组');
  ok(g.models.length === 2, '两条模型都在');
  ok(g.models.every((m) => m.usable), '没测过能力也**可以选**（不是灰着）');
  ok(g.models.every((m) => m.think === null && m.tools === null), '想/工 是 null（界面写 ?，不按名字猜）');
  ok(g.models.every((m) => m.price === null), '价格不知道就是 null（界面"未定价"，不是 ¥0）');
  ok(g.models.every((m) => m.org === '我的中转'), 'org 是那条接口的名字（表里分得清是哪条）');

  /* id → 接口。模型名里带 `/` 是最容易解析错的一种 */
  const r1 = routeOf('x/p_ab12cd/openai/gpt-4o');
  ok(r1.kind === 'openai' && r1.model === 'openai/gpt-4o', 'id 里带斜杠的模型名解析对');
  ok(r1.baseURL === 'https://x.test/v1', '发往那条接口的 baseURL');
  ok(!('apiKey' in r1) === false && r1.apiKey === 'k', 'key 跟着走');

  console.log('  · 没填 key 时');
  setCustomProviders([{ id: 'p_zz11yy', name: '本地网关', baseURL: 'http://127.0.0.1:8000/v1', apiKey: '', models: ['m'] }]);
  const r2 = routeOf('x/p_zz11yy/m');
  ok(!!r2.apiKey, '给了一个占位 key（适配器无条件拼 Authorization，空 key 会抛"缺少 MODEL_KEY"）');

  /* 删掉接口之后：切不回去，会话里的旧 modelId 也解析不出路 */
  setCustomProviders([]);
  ok(await findModel('x/p_ab12cd/gpt-4o-mini') === null, '删掉之后 findModel 返回 null（拒绝切换）');
  ok(!routeOf('x/p_ab12cd/gpt-4o-mini').baseURL.startsWith('https://x.test'),
    '也不会再发往那条地址（routeOf 退到默认接口，而不是把旧地址留在里面）');
}

console.log(failed ? `\n${failed} 项没过（共 ${n} 项）` : `\n全部通过（${n} 项）`);
process.exit(failed ? 1 : 0);
