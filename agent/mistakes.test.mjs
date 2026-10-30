/**
 * 错题本自测：`node agent/mistakes.test.mjs`
 *
 * 这一层最容易出的错**不在存储，在判据**：
 *   ① 把陈述当纠正（"不是所有应用都在跑"）→ 天天记假错题，它每轮先道一次歉；
 *   ② 把纠正漏掉（"不对，是 Jellyfin"）→ 用户白纠正一次；
 *   ③ 命中太宽（中文两字随便撞）→ 错题在无关问题里跳出来；
 *   ④ 永不过期 → 环境变了，老教训变成误导。
 *
 * 四类都要有用例，而且**反例比正例重要** —— 正例错了用户会再说一遍，
 * 反例错了是它一直在错的地方道歉。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMistakes, looksLikeCorrection, sceneOf } from './mistakes.mjs';

let failed = 0;
const ok = (c, l, e = '') => {
  if (c) console.log('  ✓ ' + l);
  else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); }
};

const DAY = 86_400_000;
async function mk(t0 = Date.now()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mistakes-'));
  const clock = { t: t0 };
  const m = createMistakes({ file: path.join(dir, 'm.json'), now: () => clock.t, warn: () => {} });
  await m.init();
  return { m, dir, clock, file: path.join(dir, 'm.json') };
}

console.log('\n① 判据：什么才算"用户在纠正它"');
{
  const yes = ['不对，是 Jellyfin', '不是这个，我说的是 n8n', '你弄错了', '搞错了，那个是备份盘',
    '错了，端口是 5679', '纠正一下：它叫 Navidrome', '我说的是 n8n 的日志'];
  const no = ['不是所有应用都在跑', '这样不对吧，我觉得再等等', '有没有 n8n 的日志',
    '帮我重启一下 n8n', '这个对不对？', '不是我不想，是它一直失败'];
  ok(yes.every(looksLikeCorrection), '七种纠正句式都认得');
  const miss = yes.filter((x) => !looksLikeCorrection(x));
  ok(!miss.length, '一个都没漏', miss.join(' / '));
  const bad = no.filter((x) => looksLikeCorrection(x));
  ok(!bad.length, '六种非纠正不中枪', bad.join(' / '));
}

console.log('\n② 场景词：只抽具体的名字');
{
  const s = sceneOf('不对，我说的是 Jellyfin，不是「Navidrome」');
  ok(s.includes('jellyfin') && s.includes('navidrome'), `拉丁词与引号中文都抽到（${s.join(',')}）`);
  ok(!s.includes('用户') && !s.includes('这个'), '虚词不进来');
  ok(sceneOf('不对').length === 0, '没有具体名字就是空场景（宁可不记）');
}

console.log('\n③ 记一条：去重、重复计数');
{
  const { m } = await mk();
  const a = await m.add({ wrong: '这台机器上跑的是 Navidrome', right: '不对，是 Jellyfin' });
  ok(!!a && a.id, '记下了');
  const b = await m.add({ wrong: '这台机器上跑的是 Navidrome', right: '不对，是 Jellyfin' });
  ok(b.id === a.id && b.repeat === 1, '同一句纠正再来一次 → 不重复记，只加重（repeat=1）');
  ok((await m.list()).length === 1, '表里还是一条');
  ok(!(await m.add({ right: '' })), '空纠正不记');
}

console.log('\n④ 命中：靠具体名字，不靠语气');
{
  const { m } = await mk();
  await m.add({ wrong: '音乐库是 Navidrome', right: '不对，我说的是 Jellyfin' });
  ok(m.match('Jellyfin 里怎么加用户').length === 1, '同名就问得出来');
  ok(m.match('把那个种子停掉').length === 0, '无关问题不跳出来');
  ok(m.match('磁盘还剩多少').length === 0, '中文两字相撞不算命中（错题不能到处冒）');

  const txt = await m.promptText('Jellyfin 现在什么状态');
  ok(/上次这里判断错过/.test(txt), '拼出来是一段带标题的上下文');
  ok(/我说过「音乐库是 Navidrome」/.test(txt) && /用户纠正「不对，我说的是 Jellyfin」/.test(txt), '两句原话都在（不是总结）');
  ok((await m.promptText('把那个种子停掉')) === '', '无关问题不注入任何东西');
}

console.log('\n⑤ 过期：老教训会变成误导');
{
  const { m, clock } = await mk();
  await m.add({ wrong: '跑的是 Navidrome', right: '不对，是 Jellyfin' });
  ok(m.match('Jellyfin').length === 1, '当天命中');
  clock.t += 91 * DAY;
  ok(m.match('Jellyfin').length === 0, '90 天后不再注入');
  const s = await m.stats();
  ok(s.total === 1 && s.fresh === 0, `记录还在（total=${s.total} fresh=${s.fresh}），只是不再说`);
}

console.log('\n⑥ 同一个场景不堆十条，但真的不同的坑要分开');
{
  const { m } = await mk();
  for (let i = 0; i < 5; i++) {
    await m.add({ wrong: `n8n 端口是 ${1000 + i}`, right: `不对，n8n 端口是 ${6000 + i}` });
  }
  ok((await m.list()).length <= 3, `同场景只留 3 条（实际 ${(await m.list()).length}）`);

  /* 换个说法说同一件事 = 同一个坑（加重，不新增） */
  const { m: m2 } = await mk();
  const a1 = await m2.add({ wrong: '音乐库是 Navidrome', right: '不对，我说的是 Jellyfin' });
  const a2 = await m2.add({ wrong: '音乐库是 Navidrome', right: '不是，我说的是 Jellyfin' });
  ok(a2.id === a1.id && a2.repeat === 1, '换个说法 → 还是同一条（加重）');
  ok(a2.right.includes('不是'), '以最新的说法为准（用户后来怎么说的，就怎么记）');
}

console.log('\n⑦ 落盘：重启之后错题还在');
{
  const { m, file } = await mk();
  await m.add({ wrong: 'X 是 Navidrome', right: '不是，我说的是 Jellyfin' });
  const m2 = createMistakes({ file, now: Date.now, warn: () => {} });
  await m2.init();
  ok(m2.match('Jellyfin 有用户吗').length === 1, '新实例读得到');
  const bad = path.join(path.dirname(file), 'broken.json');
  await fs.writeFile(bad, '{oops');
  const m3 = createMistakes({ file: bad, now: Date.now, warn: () => {} });
  ok((await m3.init()) === 0, '坏文件当空表，不抛异常');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
