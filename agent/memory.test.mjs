/**
 * 记忆自测。不需要模型、不需要集群：
 *
 *   node agent/memory.test.mjs
 *
 * 它验的是四件事，每一条都对应一个"不做就会悄悄坏掉"的地方：
 *   1. 同一句话记两次只留一条（去重），但 freq 会涨（强化）
 *   2. 问"n8n 端口"能命中那条事实，并沿 about 走到"关于 n8n 的其它记忆"
 *   3. 巩固会把三个星期没人碰、只说过一次的东西剪掉（软删，能数出来）
 *   4. 反复一起出现的实体塌缩成一个社群摘要节点
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createMemory, parseFacts } from './memory.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'em-mem-'));
let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (extra ? ` — ${extra}` : '')); }
};

/** 假抽取器：按预设队列返回，模拟模型原文（带围栏、带解释也要能救回来）。 */
let batches = [];
const extractor = async () => {
  const b = batches.shift() || [];
  return '好的，结果如下：\n```json\n' + JSON.stringify({ facts: b }) + '\n```';
};

const m = createMemory({ dir: tmp, extractor });
await m.start();
console.log('dir =', m.dir);

console.log('\n[0] 复读也能解析');
/* 7B 实测行为：给完 JSON 又把同一份重抄一遍，中间夹着 ```json。
   旧解析用"第一个 { 到最后一个 }"，两段被拼坏，整轮记忆静默丢失。 */
const dup = '{"facts":[{"text":"甲","about":[]}]}```json\n{"facts":[{"text":"甲","about":[]}]}\n```';
ok(parseFacts(dup).length === 1, '取第一段完整对象，忽略复读', JSON.stringify(parseFacts(dup)));

console.log('\n[1] 抽取 + 去重');
batches = [[
  { text: '用户把 n8n 挪到了 5679 端口', about: ['n8n', '端口'], kind: 'event', valence: 0.2 },
  { text: 'n8n 每小时重启一次，原因是内存超限', about: ['n8n', '重启'], kind: 'fact', valence: -0.6 },
  { text: '内存现在是 41%', about: [], kind: 'fact', valence: 0 },   // 读数，应被丢弃
]];
await m.afterTurn({ sid: 's1', turn: 1, user: '我把 n8n 挪到 5679 了，别在半夜重启它', reply: '记下了' });
await m.drain();
let s = m.stats();
ok(s.facts === 2, '读数被丢掉，只留 2 条事实', `facts=${s.facts}`);

batches = [[{ text: '用户把 n8n 挪到了 5679 端口', about: ['n8n'], kind: 'event', valence: 0.2 }]];
await m.afterTurn({ sid: 's1', turn: 2, user: '再说一次，n8n 在 5679', reply: '嗯' });
await m.drain();
ok(m.stats().facts === 2, '同一句话第二次不新增节点', `facts=${m.stats().facts}`);

console.log('\n[2] 回忆');
const r = m.recall('n8n 的端口是多少', 5);
ok(r.facts.some((f) => f.text.includes('5679')), '命中端口那条', JSON.stringify(r.facts.map((f) => f.text)));
ok(r.facts.length >= 2, '沿 about 走到了关于 n8n 的其它记忆', `n=${r.facts.length}`);
const ctx = m.context('n8n 的端口是多少').text;
ok(ctx.includes('5679') && ctx.includes('长期记忆'), '注入给模型的上下文里有这条', ctx.split('\n')[0]);

console.log('\n[3] 巩固：剪枝 + 社群');
/* 补三条，让 n8n / 重启 / 端口 反复同框 */
m.remember({ text: '用户不想在半夜重启 n8n', about: ['n8n', '重启'], kind: 'pref', valence: -0.5 }, 'test#3');
m.remember({ text: '用户把 n8n 的日志放在 ~/n8n.log', about: ['n8n', '日志'], kind: 'fact', valence: 0 }, 'test#4');
m.remember({ text: '用户用 Navidrome 听歌', about: ['Navidrome'], kind: 'fact', valence: 0.4 }, 'test#5');
/* 一条 60 天前、没被回忆过、只说过一次的小事 —— 该被剪掉 */
m.remember({ text: '用户那天随手试了一下 Emby', about: ['Emby'], kind: 'event', valence: 0 }, 'test#0', Date.now() - 60 * 86400_000);
const before = m.stats();
const rep = m.consolidate();
const after = m.stats();
ok(rep && rep.pruned >= 1, '剪掉了至少一条陈旧的记忆', JSON.stringify(rep));
ok(after.facts === before.facts - rep.pruned, '剪掉的是那一条，别的都还在', `${before.facts} → ${after.facts}`);
ok(after.communities >= 1, '出现了社群摘要节点', `communities=${after.communities}`);
ok(rep.covered >= 4, '摘要覆盖了 n8n 那团记忆', `covered=${rep.covered}`);
ok(after.themes.some((t) => t.label === 'n8n'), 'stats 里能看出主题是 n8n', JSON.stringify(after.themes));

console.log('\n[4] 软删除能捞回来（alive=0，不是消失）');
const again = m.recall('Emby', 3);
ok(!again.facts.some((f) => f.text.includes('Emby')), '被剪掉的不会再被回忆到');

console.log('\n[5] 快照');
const snap = await m.snapshot();
ok(!!snap, '快照写出来了', snap);
const st = await fs.stat(snap);
ok(st.size > 0, '快照不是空文件', `${st.size}B`);

m.stop();
await fs.rm(tmp, { recursive: true, force: true });

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
