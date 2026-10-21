/**
 * 自造工具的自测。不需要模型、不需要集群 —— 只测"这层护栏和这套账"对不对。
 *
 * 重点不是 happy path（那个一眼就能看出来），而是**越权的那几条**：
 * 一个没声明域名的 fetch、一个没声明目录的 readFile、一个想 shell out 的脚本，
 * 必须**真的跑不起来**。它们跑不起来，M4 才敢开。
 *
 *   node agent/tools/forge.test.mjs
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createForge } from './forge.mjs';

let pass = 0;
let fail = 0;
const ok = (c, name, extra = '') => {
  if (c) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const HOME = path.join(os.tmpdir(), `em-forge-${Date.now()}`);

async function main() {
  await fsp.mkdir(path.join(HOME, 'Agent'), { recursive: true });
  const secret = path.join(HOME, 'secret.txt');
  await fsp.writeFile(secret, '这是一条不该被随便读到的内容', 'utf8');

  const forge = createForge({ home: HOME });
  await forge.init();

  console.log('\n[1] 写草稿 —— 写了不等于能用');
  const w = await forge.write({
    name: 'echo_args',
    description: '把参数原样回声，用来验证契约',
    params: { word: { type: 'string', description: '要说的话' } },
    needs: {},
    code: `
const args = JSON.parse(process.env.EM_TOOL_ARGS || '{}');
console.log('拿到 ' + JSON.stringify(args));
console.log(JSON.stringify({ ok: true, echo: args.word, n: (args.word || '').length }));
`,
  });
  ok(w.ok && w.status === 'draft', '落盘为 draft', JSON.stringify(w));
  ok(forge.registered().length === 0, '草稿不进工具表');
  const l0 = await forge.list();
  ok(l0.length === 1 && l0[0].status === 'draft', 'list 里能看到草稿');

  console.log('\n[2] 契约：最后一行 JSON 就是结果');
  const r1 = await forge.call('echo_args', { word: '周末' });
  ok(r1.ok && r1.echo === '周末' && r1.n === 2, '参数从 EM_TOOL_ARGS 进来、结果从最后一行 JSON 出去', JSON.stringify(r1));

  console.log('\n[3] 护栏：没声明的网络');
  await forge.write({
    name: 'peek_net',
    description: '试图连一个没声明的域名',
    params: {},
    needs: { net: ['allowed.example.com'] },
    /* 地址是**拼出来**的：从代码里读不出这个域名，卡片上也没有它 —— 必须拒。
       （写成完整的 URL 就会被读出来、摆到审批卡上，那是另一条路：知情之后放行。） */
    code: `
try {
  const host = ['evil', 'example', 'org'].join('.');
  const r = await fetch('https://' + host + '/x');
  console.log(JSON.stringify({ ok: true, leaked: await r.text() }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
`,
  });
  const r2 = await forge.call('peek_net', {});
  ok(r2.ok === false && /没有声明访问 evil\.example\.org/.test(r2.error || ''), '拼出来的域名读不到 → 被拒（话是写给模型看的）', JSON.stringify(r2));

  console.log('\n[4] 护栏：没声明的文件');
  await forge.write({
    name: 'peek_fs',
    description: '试图读没声明目录里的文件',
    params: {},
    needs: { fs: [] },
    code: `
import { readFileSync } from 'node:fs';
try {
  const t = readFileSync(${JSON.stringify(secret)}, 'utf8');
  console.log(JSON.stringify({ ok: true, leaked: t.slice(0, 10) }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
`,
  });
  const r3 = await forge.call('peek_fs', {});
  ok(r3.ok === false && /没有声明读写/.test(r3.error || ''), '未声明的路径被拒（含 ESM 具名导入）', JSON.stringify(r3));

  console.log('\n[5] 声明了就能读 —— 护栏不是"什么都不许"');
  await forge.write({
    name: 'read_secret',
    description: '读一份声明过的文件',
    params: {},
    needs: { fs: [HOME] },
    code: `
import { readFileSync } from 'node:fs';
const t = readFileSync(${JSON.stringify(secret)}, 'utf8');
console.log(JSON.stringify({ ok: true, chars: t.length }));
`,
  });
  const r4 = await forge.call('read_secret', {});
  ok(r4.ok === true && r4.chars > 5, 'needs.fs 里写了就能读', JSON.stringify(r4));

  console.log('\n[6] 子进程一律拒');
  const w6 = await forge.write({
    name: 'shell_out',
    description: '想调起 shell',
    params: {},
    needs: {},
    code: `import cp from 'node:child_process';\ncp.execSync('id');`,
  });
  ok(w6.ok === false && /子进程/.test(w6.error || ''), '写的时候就被拦下的（比运行时更早）', JSON.stringify(w6));

  console.log('\n[7] 超时被杀');
  await forge.write({
    name: 'hang',
    description: '一直不退出，用来测超时',
    params: {},
    needs: {},
    code: 'while (true) {}\n',
  });
  const t0 = Date.now();
  const r5 = await forge.call('hang', {}, { timeout: 800 });
  ok(r5.ok === false && /杀掉/.test(r5.error || '') && Date.now() - t0 < 6000, '卡死的脚本会被杀', JSON.stringify(r5));

  console.log('\n[8] 装起来 + 版本 + 归档');
  const k = await forge.keep('echo_args');
  ok(k.ok && k.version === 1, 'keep 之后注册', JSON.stringify(k));
  ok(forge.registered().length === 1, '工具表里出现了它');
  const r6 = await forge.call('echo_args', { word: 'ab' }, { publishedOnly: true });
  ok(r6.ok && r6.echo === 'ab', 'publishedOnly 能跑');

  const w2 = await forge.write({
    name: 'echo_args',
    description: '改一版：回声大写',
    params: { word: { type: 'string' } },
    needs: {},
    code: `const a = JSON.parse(process.env.EM_TOOL_ARGS || '{}');
console.log(JSON.stringify({ ok: true, echo: String(a.word || '').toUpperCase() }));`,
  });
  ok(w2.ok && w2.version === 2 && w2.status === 'draft', '改一次 version+1 且退回草稿', JSON.stringify(w2));
  const hist = await fsp.readdir(path.join(HOME, 'Agent', 'tools', 'echo_args', 'history')).catch(() => []);
  ok(hist.some((f) => /^run\.(mjs|cjs)\.v1$/.test(f)), '旧版本归档在 history/', JSON.stringify(hist));
  const r7 = await forge.call('echo_args', { word: 'ab' }, { publishedOnly: true });
  ok(!!r7.error, '改了没批准之前，工具表里那版不许跑', JSON.stringify(r7));

  console.log('\n[9] 审计真的写了');
  const day = new Date().toISOString().slice(0, 10);
  const audit = await fsp.readFile(path.join(HOME, 'Agent', 'audit', `tools-${day}.jsonl`), 'utf8').catch(() => '');
  const rows = audit.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok(rows.length >= 5 && rows.some((r) => r.tool === 'peek_net' && r.ok === false), `审计 ${rows.length} 行，失败的也在`, audit.slice(0, 160));

  console.log('\n[10] 技能');
  const s1 = await forge.saveSkill({ name: '清理磁盘', when: '用户说空间不够时', body: '1. fs_scan ~\n2. 把大的挪进 .trash' });
  ok(s1.ok, '存一页技能');
  const prompt = await forge.skillsForPrompt();
  ok(prompt.includes('清理磁盘') && prompt.includes('用户说空间不够时') && prompt.includes('fs_scan'), '技能进得了提示词');

  console.log('\n[11] 名字与 needs 的脏输入');
  ok((await forge.write({ name: 'Bad Name', description: 'x', code: '1' })).ok === false, '非法名字被拒');
  ok((await forge.write({ name: 'sys_status', description: '撞内置', code: '1' })).ok === false, '撞内置名被拒');
  ok((await forge.write({
    name: 'too_wide', description: '声明整个 /etc', needs: { fs: ['/etc'] }, code: '1',
  })).ok === false, '声明 /etc 被拒（等于没声明）');
  ok((await forge.write({
    name: 'no_desc', description: '', code: 'console.log(1)',
  })).ok === false, '没有 description 被拒');

  console.log('');
  console.log('[12] 模型调 tool_keep 时一个参数都没填');
  /* 实测 7B 会把 tool_keep 调成 `{}`。它刚试跑成功，只是没把名字带过来。
     系统应该知道指的是哪个 —— 只有一个草稿，没有歧义。 */
  const { makeTools } = await import('./../tools.mjs');
  await forge.write({
    name: 'only_draft', description: '只有一个草稿时，忘填名字也能装上', params: {}, needs: {},
    code: 'console.log(JSON.stringify({ok:true}))',
  });
  const T = makeTools({ source: 'mock', forge });
  await T.reload();
  const filled = T.fill('tool_keep', {});
  ok(filled.name === 'only_draft' && filled.assumed === true, '名字被补上了（并留痕）', JSON.stringify(filled));
  const kept = await T.exec('tool_keep', filled);
  ok(kept.ok && kept.version === 1, '补完就能装起来', JSON.stringify(kept));
  ok(!!T.fill('tool_keep', {}).name, '换了草稿也还能兜住（不抛）');

  console.log('');
  console.log('[13] needs 用扁平字符串，而且改工具时不会把授权弄丢');
  const w13 = await forge.write({
    name: 'flat_needs', description: '扁平的 net 也能读懂', net: 'a.example.com, b.example.com:8080',
    code: 'console.log(JSON.stringify({ok:true}))',
  });
  ok(w13.ok && w13.needs.net.length === 2 && w13.needs.net[1] === 'b.example.com:8080',
    '逗号分隔的两个域名都收下了', JSON.stringify(w13.needs));
  const w14 = await forge.write({ name: 'flat_needs', description: '改一句说明，没提 needs' });
  ok(w14.ok && w14.needsInherited === true && w14.needs.net.length === 2,
    '没提 needs 就继承上一次的（否则每次改说明都会把授权清空）', JSON.stringify(w14));

  console.log('');
  console.log('[14] 从代码里读出它要连谁（7B 填不对 needs，但代码是它写的）');
  const w15 = await forge.write({
    name: 'infer_net', description: '代码里写着完整的地址', level: 'confirm',
    code: `
try {
  await fetch('http://127.0.0.1:1/x');
  console.log(JSON.stringify({ ok: true }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
`,
  });
  ok(w15.ok && w15.needs.net.length === 0, '先声明里是空的', JSON.stringify(w15.needs));
  ok(JSON.stringify(await forge.inferred('infer_net')).includes('127.0.0.1:1'), '能把地址读出来', JSON.stringify(await forge.inferred('infer_net')));
  const r15 = await forge.call('infer_net', {});
  ok(r15.ok === false && !/没有声明/.test(r15.error || ''), '推出来的地址真的被放行了（失败原因不是被拒）', JSON.stringify(r15));
  const k15 = await forge.keep('infer_net');
  ok(k15.ok && k15.needs.net.includes('127.0.0.1:1'), '装上时把它落到 manifest 里', JSON.stringify(k15.needs));

  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${pass} 过 / ${fail} 不过`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
