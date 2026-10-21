/**
 * persona 自测。
 *
 * 这个文件里最值得看的是三组：
 *   · 正交判据（错了就退化成检索，而面板上看不出来）
 *   · 什么时候**不**注入（空注入是常态）
 *   · 编号能不能查回来源（验收标准是"说得出口那句从哪来"）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPersona, terms, orthogonal, actText, looksLikeReading, usableSeed, traceRefs } from './persona.mjs';

let pass = 0;
let fail = 0;
const ok = (c, name, extra = '') => {
  if (c) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};

const tmp = path.join(os.tmpdir(), `persona-test-${process.pid}`);
await fs.rm(tmp, { recursive: true, force: true });
process.env.PERSONA_DIR = tmp;

/* ── 一、正交判据 ─────────────────────────────────────── */
console.log('\n正交判据（Ω ⟂ goal）');
ok(terms('重启了 n8n').has('n8n'), '英文词进词表');
ok(terms('内存占用多少').has('内存'), '中文二元组进词表');
ok(!terms('现在什么情况').has('现在'), '停用词被剔掉（否则任何两句话都"相关"）');

ok(orthogonal('重启了 n8n', '机器现在什么情况'), '问整体状况 ⊥ 重启过 n8n');
ok(!orthogonal('重启了 n8n', 'n8n 现在占多少内存'), '问 n8n 内存 ✗ 重启过 n8n —— 这是检索不是漂移');
ok(!orthogonal('删了 report.pdf', 'report 还在吗'), '文件名按词切（report.pdf → report + pdf），否则这条永远对不上');
/* 已知局限，写在这里而不是假装没有：**同义词和中英混写跨不过去** ——
   "挪到了 Documents" 与 "我的文件都在哪" 在字面上没有一个共同二元组。
   这层判据只保证"字面同源的不会被当成漂移"，不保证"语义相关的一定被挡住"。
   剩下的漏网由泄漏率兜（35% 的轮次才有机会说旧事），代价是偶尔一句答非所问，
   而这正是这条功能必须能一眼关掉的原因（PERSONA=off）。 */
ok(orthogonal('把 report.pdf 挪到了 Documents', '我的文件都在哪'),
  '同义词不在这层判（字面无关 → 放行；这是已知局限，靠泄漏率兜）');
ok(orthogonal('回收了一次内存', ''), '目标为空时按不相关放行（由调用方决定要不要用）');

/* ── 二、动作→人话 ───────────────────────────────────── */
console.log('\n动作翻译');
ok(actText('k8s_restart', { name: 'navidrome' }) === '重启了 navidrome', 'k8s_restart');
ok(actText('fs_move', { from: '/a/b/report.pdf', to: '/a/Documents/report.pdf' })
  === '把 report.pdf 挪到了 report.pdf', 'fs_move 只取文件名（全路径太长，也没人关心）');
ok(actText('fs_move', { from: '/a/x.tar.gz', to: '/a/Documents/x.tar.gz' }) === '把 x.tar.gz 挪到了 x.tar.gz', '带点的文件名不被截断');
ok(actText('k8s_scale', { name: 'n8n', replicas: 2 }) === '把 n8n 调成 2 个副本', 'k8s_scale');
ok(actText('tool_keep', { name: 'navidrome_playlist' }) === '给自己装了一个工具 navidrome_playlist', 'tool_keep');
ok(actText('sys_status', {}) === null, '读数不算经历（每轮都有，收进来会淹掉真事）');
ok(actText('scene_show', { reading: 'x' }) === null, '铺屏不是世界状态');
ok(actText('memory_recall', { query: 'x' }) === null, '查记忆不是经历（那是它自己的检索动作）');
ok(actText('k8s_restart', null) === '重启了 一个应用', '参数缺失也能翻（模型常给空对象）');

/* ── 三、种子采集 ─────────────────────────────────────── */
console.log('\n种子采集');
const p = createPersona({ on: true, leak: 1 });
await p.start();

const made = p.afterTurn({
  sid: 's1', turn: 3,
  actions: [
    { name: 'k8s_restart', brief: '{"name":"n8n"}', ok: true },
    { name: 'sys_status', brief: '{}', ok: true },
    { name: 'fs_delete', brief: '{"path":"/a/old.log"}', ok: false },   // 失败不算做过
    { name: 'fs_delete', brief: '{"path":"/a/old.log"}', denied: true },// 被拒更不算
  ],
});
ok(made.length === 1, '四个调用只收一个（读数不收、失败不收、被拒不收）', String(made.length));
ok(made[0].text === '重启了 n8n', '种子文本是人话');
ok(made[0].id === 'n1' && made[0].tool === 'k8s_restart', '带 id 与工具名（可溯源）');

const again = p.afterTurn({
  sid: 's1', turn: 4, actions: [{ name: 'k8s_restart', brief: '{"name":"n8n"}', ok: true }],
});
ok(again.length === 0, '同一个动作 24h 内不重复记（"又重启了一次"是噪声）');

/* ── 四、漂移注入 ─────────────────────────────────────── */
console.log('\n漂移注入');
const empty = p.drift('');   // 手势回合
ok(!empty.text, '没有目标文本时不注入（手势回合说旧事是纯干扰）');

/* 用户问"你经历过什么"时，旧事**就是答案**：这时候抽签决定说不说，
   等于掷骰子决定要不要回答。所以它绕过泄漏率，也绕过正交判据。 */
const pz = createPersona({ on: true, leak: 0 });   // 泄漏率 0：正常情况下一句都不说
await pz.start();
pz.afterTurn({ sid: 's9', turn: 1, actions: [{ name: 'k8s_restart', brief: '{"app":"n8n"}', ok: true }] });
const sr = pz.drift('你最近都干什么了', { turn: 2 });
ok(sr.items.length === 1, '问"你最近干了什么"→ 必答（泄漏率 0 也照说）', String(sr.items.length));
ok(sr.selfRef === true, '标记成 selfRef（面板能分开算）');
ok(sr.text.includes('直接把下面这几件说出来'), '自我指涉换一套头文字（"时机合适才提"会把它说成谦虚）');
const sr2 = pz.drift('你还记得 n8n 的事吗', { turn: 3 });
ok(sr2.items.length === 0 || sr2.selfRef, '"你记得 n8n 吗"这类问题不被正交判据挡死（挡了就成答非所问）');
/* 复用期是防"主动啰嗦"的，不是防"回答问题"的。 */
const reuse = pz.drift('你最近都干什么了', { turn: 5 });
ok(reuse.items.length > 0,
  '刚说过的事，用户再问一次仍然要说（复用期不该拦住回答）', String(reuse.items.length));
ok(!pz.drift('磁盘怎么样', { turn: 4 }).text, '普通问题在泄漏率 0 时仍然闭嘴');

const d1 = p.drift('机器现在什么情况', { turn: 5 });
ok(d1.items.length === 1, '问整体状况 → 注入一条');
ok(d1.text.includes('## 你自己记着的事'), '带小标题');
ok(d1.text.includes('这不是用户刚说的'), '带纪律：不能当成用户的话复述');
ok(!/#\d+/.test(d1.text), '注入文本里不给模型编号（7B 会照抄或对应错，编号由系统给）');
ok(/#\d+/.test(d1.items[0].id ? '#' + d1.items[0].id.replace(/^i/, '') : ''), '编号在记录里（面板按它显示）');
ok(d1.text.includes('重启了 n8n'), '内容就是那件真事');
ok(d1.items[0].seed === 'n1' && d1.items[0].goal === '机器现在什么情况', '注入记录带种子 id 与当时的问题');

const d2 = p.drift('n8n 现在占多少内存', { turn: 6 });
ok(!d2.text, '问 n8n → 同一条种子被正交判据挡住（该走检索）');

const d3 = p.drift('机器现在什么情况', { turn: 7 });
ok(!d3.text, '七天之内说过的不再说');

/* ── 四点五、溯源 ─────────────────────────────────────── */
console.log('\n溯源（它说的那句是哪来的）');
const it2 = [{ id: 'i3', text: '把 report.pdf 挪到了 Documents' }, { id: 'i4', text: '重启了 n8n' }];
ok(traceRefs('重启过 n8n', it2).includes('i4'), '动作变形也认得出（"重启过" ↔ "重启了"）');
ok(traceRefs('帮你在 Documents 里找过 report.pdf', it2).includes('i3'), '长种子两个词对上才算');
ok(traceRefs('CPU 71% · 内存 60%', it2).length === 0, '读数行不会被认成引用（不然溯源就是假的）');
/* 实测踩过：它答"今天早上 n8n 占用了 60% 的内存"，和"重启了 n8n"只共享一个实体名 n8n，
   就被记成引用过重启 —— 溯源一旦这么松，等于每条都能"被引用"。 */
ok(traceRefs('今天早上 n8n 占用了 60% 的内存', [{ id: 'i4', text: '重启了 n8n' }]).length === 0,
  '只共享实体名不算说过（必须有一个中文词对上）');
/* 实测踩过：三条"用户把 X 加进周末"，它只说了一条，溯源却把三条都记上。 */
const similar = [
  { id: 'i1', text: '用户把 Blue in Green 加进周末' },
  { id: 'i2', text: '用户把 So What 加进周末歌单' },
  { id: 'i3', text: '用户把 n8n 挪到了 5679 端口' },
];
ok(traceRefs('今天 用户把 Blue in Green 加进周末', similar).join() === 'i1',
  '相似种子只认最像的那条（全认等于没认）', traceRefs('今天 用户把 Blue in Green 加进周末', similar).join());

/* ── 五、落盘与回读 ───────────────────────────────────── */
console.log('\n落盘');
await p.drain();
const month = new Date().toISOString().slice(0, 7);
const file = path.join(tmp, 'drift', `${month}.jsonl`);
const raw = await fs.readFile(file, 'utf8');
const rows = raw.trim().split('\n').map((l) => JSON.parse(l));
ok(rows.some((r) => r.t === 'seed' && r.text === '重启了 n8n'), '种子落盘');
ok(rows.some((r) => r.t === 'inject' && r.seed === 'n1'), '注入落盘');
const injRow = rows.find((r) => r.t === 'inject' && r.goal === '机器现在什么情况');
ok(injRow && typeof injRow.turn === 'number' && !injRow.sid, '注入行带 turn（能定位到哪一轮）');
ok(rows.find((r) => r.t === 'inject' && r.selfRef), '自我指涉的注入在记录里被标出来');

const p2 = createPersona({ on: true, leak: 1 });
await p2.start();
const d4 = p2.drift('磁盘怎么样', { turn: 1 });
ok(!d4.text, '重启后记得"说过"（复用期跨进程有效）');
const st2 = p2.stats();
ok(st2.seeds === 1, '重启后种子数还在', String(st2.seeds));

const pm = await fs.readFile(path.join(tmp, 'persona.md'), 'utf8').catch(() => '');
ok(/桌面/.test(pm), 'persona.md 第一次跑就写出来了（人可读可改）');

/* ── 六、总开关 ───────────────────────────────────────── */
console.log('\n总开关');
const off = createPersona({ on: false });
await off.start();
ok(!off.promptText(), '关掉时不注入人格');
ok(!off.drift('机器现在什么情况').text, '关掉时不漂移');
ok(off.afterTurn({ sid: 's', turn: 1, actions: [{ name: 'k8s_restart', brief: '{"name":"x"}' }] }).length === 0,
  '关掉时不写种子（关掉就是真关掉，不留后台账）');

/* ── 七、事实种子 ─────────────────────────────────────── */
console.log('\n事实种子（记忆库来的旧事）');
const pf = createPersona({
  on: true, leak: 1,
  recallFacts: () => [
    { id: 'abc123', text: '用户把日志目录挪到了 Documents', when: '3 天前' },
    { id: 'def456', text: 'n8n 的内存上限被调过', when: '昨天' },
    /* 实测踩过：库里躺着一条读数，漂移把它当谈资说了出去，而真实值早已不是 60% */
    { id: 'ghi789', text: 'n8n 占用 60% 内存', when: '昨天' },
  ],
});
await pf.start();
const df = pf.drift('机器现在什么情况', { turn: 1 });
ok(df.items.length === 2, '事实种子最多两条');
ok(!df.items.some((r) => /60%/.test(r.text)), '读数不当经历（"占用 60%" 是快照，说成做过的事就是记错）');
ok(looksLikeReading('n8n 占用 60% 内存') && !looksLikeReading('把内存上限调到 60%'), '读数判据看整句：带百分比但有动作词就不算读数');
/* 记忆库里有抽取失败留下的残渣（实测躺着一条「我做了 → 工具返回」）。 */
ok(!usableSeed('我做了 → 工具返回') && !usableSeed('x') && usableSeed('把 report.pdf 挪到了 Documents'),
  '抽取失败的残渣不当谈资（结构性符号 / 太短都丢）');
/* 提示词里写示例编号会被 7B 原样抄进回答，用户看到一个查不到的编号 —— 比不给更糟。 */
ok(!/[(（]#?\d+[)）]/.test(df.text.replace(/#\d+ /g, '')), '提示词里没有可照抄的示例编号');
ok(df.items.some((r) => String(r.seed).startsWith('m:')), '事实种子的 id 指回记忆（m:factId）');
ok(df.text.length < 320, '注入文本有上限', String(df.text.length));

/* 记忆里的旧事大多是"用户把 X 加进歌单"这种用户视角的事。拿它回答
   "你最近干了什么"，说出来的是一句转述（实测："今天 用户把 Blue in Green 加进周末"）。
   注意这个目录里已经有前面写的动作种子 —— 所以判的是"没有事实种子混进来"，
   不是"一条都没有"。 */
const sr3 = pf.drift('你最近都干什么了', { turn: 2 });
ok(!sr3.items.some((r) => String(r.seed).startsWith('m:')),
  '询问"你干了什么"时不拿用户视角的旧事充数（动作种子才算经历）',
  JSON.stringify(sr3.items.map((r) => r.seed)));

const st = pf.stats();
ok(st.ratio > 0 && st.ratio <= 1, '泄漏率是"注入了的轮数 / 问过的轮数"');
ok(st.recent.length >= 1 && st.recent[0].id, '面板能摊开最近注入');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} · 未通过 ${fail}`);
process.exit(fail ? 1 : 0);
