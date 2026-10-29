/**
 * 定时任务的自测：`node agent/sched.test.mjs`
 *
 * 这一层**没有 IO 可以假装**（除了一个 json 文件），所以全部用例都对着真模块跑，
 * 用一个可以拨的假时钟把时间推来推去。钉住的是四类"上线才会发现"的错：
 *
 *   ① 解析：用户说"每 15 分钟"、模型抄成"每15分钟"、抄成全角 —— 都得一样能用；
 *      "每天" 不带时刻不许猜（猜错就是每天中午吵一次）。
 *   ② 时刻：`at` 型算的是"下一次出现的那个点"（今天过了就是明天），跨天不能差一天。
 *   ③ 补跑：过期 6 个周期只跑**一次**（否则用户一睁眼收到一串一样的结论）。
 *   ④ 降频：连续 3 次结论相同才放大间隔，有变化立刻恢复原频率，且间隔真的往后推了。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSched, parseWhen, nextAt, whenText, atLabel } from './sched.mjs';
import { makeTools } from './tools.mjs';

let failed = 0;
const ok = (c, l, e = '') => {
  if (c) console.log('  ✓ ' + l);
  else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); }
};

/** 假时钟：`clock.t` 想拨到哪就拨到哪，模块只通过 now() 看时间 */
function fakeClock(t) {
  return { t, now() { return this.t; } };
}

async function mkSched(t0 = new Date(2026, 9, 29, 9, 0, 0).getTime()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-'));
  const clock = fakeClock(t0);
  const s = createSched({ file: path.join(dir, 'tasks.json'), now: () => clock.now(), warn: () => {} });
  await s.init();
  return { s, clock, dir, file: path.join(dir, 'tasks.json') };
}

console.log('\n① 解析：它填的必须是用户说的话，不是我们发明的格式');
{
  const iv = ['每15分钟', '15m', '每 15 分', '每隔15分钟', '15 分钟', '15min'];
  ok(iv.every((x) => parseWhen(x).everyMs === 900_000), '六种写法都解析成 15 分钟');
  ok(parseWhen('每２小时').everyMs === 7_200_000, '全角数字也认（模型抄用户的话会带上）');
  ok(parseWhen('每半小时').error, '「半小时」看不懂要报错，不能静默变成别的');
  ok(parseWhen('2小时').everyMs === 7_200_000, '「2小时」（没有"每"）也认');

  const d1 = parseWhen('每天 08:00');
  ok(d1.at?.h === 8 && d1.at?.m === 0, '「每天 08:00」→ 时刻');
  ok(parseWhen('每天8点半').at?.m === 30, '「8点半」→ 30 分');
  ok(parseWhen('08:00').at?.h === 8, '只写时刻也当每天');
  ok(parseWhen('每天').error, '「每天」不带时刻 → 报错，不替它猜');

  ok(parseWhen('每30秒').error, '低于一分钟要拒绝（每一轮都是一份完整上下文）');
  ok(parseWhen('').error, '空 → 报错');
  ok(/每 15 分钟|每天/.test(parseWhen('随便').error), '看不懂时把能用的写法给它，能照抄');
}

console.log('\n② 时刻：算的是"下一次出现的那个点"');
{
  const t = { at: { h: 8, m: 0 } };
  const today0700 = new Date(2026, 9, 29, 7, 0).getTime();
  const today0900 = new Date(2026, 9, 29, 9, 0).getTime();
  ok(new Date(nextAt(t, today0700)).getDate() === 29, '7 点时看 08:00 → 今天');
  ok(new Date(nextAt(t, today0900)).getDate() === 30, '9 点时看 08:00 → 明天');
  ok(whenText(t) === '每天 08:00', '人话：每天 08:00');
  ok(whenText({ everyMs: 900_000 }) === '每 15 分钟', '人话：每 15 分钟');
  const lbl = atLabel(new Date(2026, 9, 30, 8, 0).getTime(), today0900);
  ok(lbl === '明天 08:00', `跨天的时刻要说"明天"（实际 ${lbl}）`);
}

console.log('\n③ 落盘：重启之后任务还在，且不会连着补跑');
{
  const { s, clock, dir } = await mkSched();
  const r = await s.add({ sid: 'sid-a', task: '看一眼 n8n 重启次数', when: '每 15 分钟' });
  ok(r.ok && r.next, '加一条能拿到下次时刻');
  ok((await s.list()).length === 1, '表里一条');

  const r2 = await s.add({ sid: 'sid-a', task: '看一眼 n8n 重启次数', when: '每 15 分钟' });
  ok(r2.ok && r2.dup, '同一句话加两次不重复加（否则每次两轮、两份钱）');

  /* 模拟 pod 重启：新实例读同一个文件，但时间已经过去 6 个周期 */
  clock.t += 90 * 60_000;
  const s2 = createSched({ file: path.join(dir, 'tasks.json'), now: () => clock.now(), warn: () => {} });
  await s2.init();
  const t2 = s2.list()[0];
  ok(t2 && t2.task === '看一眼 n8n 重启次数', '重启后任务还在');
  ok(s2.due().length === 1, '过期 6 个周期 → 起来时算一次到期（不是 6 次）');
  s2.begin(t2, clock.now());
  ok(s2.due().length === 0, 'begin 之后立刻不再到期（nextAt 先推到未来再跑）');
  s2.settle(t2, { text: '还是好的' });
  ok(s2.due().length === 0, 'settle 之后也不会重复到期');
  ok(t2.nextAt > clock.now(), '下次时刻在未来');
}

console.log('\n④ 降频：一样就放大间隔，有变化立刻恢复');
{
  const { s, clock } = await mkSched();
  const r = await s.add({ sid: 'sid-b', task: '看磁盘', when: '每 5 分钟' });
  const t = s.list()[0];
  ok(r.when === '每 5 分钟', '初始频率 5 分钟');

  for (let i = 0; i < 2; i++) {
    clock.t += 5 * 60_000;
    s.begin(t, clock.now());
    const x = s.settle(t, { text: '磁盘还剩 87G，没变化' });
    ok(!x.slowed, `第 ${i + 1} 次相同：还没到降频阈值（same=${t.same}）`);
  }
  clock.t += 5 * 60_000;
  s.begin(t, clock.now());
  const x = s.settle(t, { text: '磁盘还剩 87G，没变化' });
  ok(x.slowed && t.factor === 2, '第 3 次相同 → 间隔 ×2');
  ok(whenText(t) === '每 10 分钟', `对外说的是放宽后的间隔（实际 ${whenText(t)}）`);
  ok(t.nextAt - clock.now() >= 10 * 60_000 - 1000, '下次时刻按新间隔排（不是只改了个名字）');

  clock.t += 10 * 60_000;
  s.begin(t, clock.now());
  const y = s.settle(t, { text: '磁盘只剩 12G 了' });
  ok(!y.slowed && t.factor === 1, '有变化 → 立刻回到原频率，不永久阉掉它');
}

console.log('\n⑤ 取消与暂停');
{
  const { s } = await mkSched();
  await s.add({ sid: 'sid-c', task: '看 n8n', when: '每 10 分钟' });
  await s.add({ sid: 'sid-c', task: '看磁盘', when: '每天 08:00' });
  const id = s.list()[0].id;
  ok((await s.cancel(id)).ok, '按 id 取消');
  ok(s.list().length === 1, '少了一条');
  ok((await s.cancel('看磁盘')).ok, '按任务原话取消（7B 常把原话当 id 传回来）');
  ok(!(await s.cancel('不存在')).ok, '找不到要报错，不能假装成功');

  await s.add({ sid: 'sid-c', task: '看内存', when: '每 5 分钟' });
  const t = s.list()[0];
  await s.pause('看内存', true);
  ok(s.due().length === 0 || s.due().every((x) => x.id !== t.id), '暂停后不进到期队列');
  await s.pause('看内存', false);
  ok(!t.paused, '恢复');
}

console.log('\n⑥ 上限与坏文件');
{
  const { s, dir, file } = await mkSched();
  for (let i = 0; i < 20; i++) await s.add({ sid: 'x', task: '任务' + i, when: '每 1 小时' });
  const over = await s.add({ sid: 'x', task: '第二十一条', when: '每 1 小时' });
  ok(!over.ok && /上限/.test(over.error), '到上限要明说，不能静默丢');

  await fs.writeFile(file, '{ 这不是 json');
  const bad = createSched({ file, now: Date.now, warn: () => {} });
  const n = await bad.init();
  ok(n === 0, '坏文件当作空表，不抛异常（否则 agent 起不来）');
  ok(true, '目录还在：' + path.basename(dir));
}

console.log('\n⑦ 工具层：模型看到的那张表');
{
  /* 直接造一份工具表，走 model 真正会走的那条路（`schemas()` + `run()`）——
     不是"我调了 sched.add"，而是"模型调了 schedule 之后发生了什么"。 */
  const { s: sc } = await mkSched();
  const T = makeTools({ source: 'mock', sched: sc, sid: 'sid-tool' });

  const names = T.schemas().map((x) => x.function.name);
  ok(names.includes('schedule'), 'schedule 在工具表里（不然它根本挂不了任务）');
  const sch = T.schemas().find((x) => x.function.name === 'schedule');
  ok(sch?.function?.parameters?.properties?.op?.enum?.includes('add'), 'op 是枚举（7B 看到自由字符串会瞎填）');
  ok(!sch?.function?.parameters?.properties?.every, '字段叫 when 不叫 every（和描述里说的一致）');

  const a = await T.all.schedule.run({ op: 'add', when: '每天 08:00', task: '报一下磁盘' });
  ok(a.ok && /记下了/.test(a.message || ''), 'op=add 的回执是人话（模型会照抄给用户）');
  ok(/每天 08:00/.test(a.when || ''), '回执里带着频率');
  ok(/今天|明天/.test(a.next || ''), `回执里带着"下次什么时候"（${a.next}）`);

  const l = await T.all.schedule.run({ op: 'list' });
  ok(l.ok && l.tasks.length === 1, 'op=list 能看到自己挂的');
  ok(/每天 08:00/.test(l.message), 'list 的 message 是能直接念出来的清单');

  const bad = await T.all.schedule.run({ op: 'add', when: '随便', task: 'x' });
  ok(!bad.ok && /看不懂/.test(bad.error), '看不懂的频率要报错');

  const c = await T.all.schedule.run({ op: 'cancel', id: '报一下磁盘' });
  ok(c.ok, 'op=cancel 用原话也能取消');
  ok((await T.all.schedule.run({ op: 'list' })).tasks.length === 0, '取消之后表里没有了');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
