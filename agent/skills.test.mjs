/**
 * 技能索引自测。不需要网络、不需要 olares-cli：
 *
 *   node agent/skills.test.mjs
 *
 * 它验的是"压缩会不会把文档压坏"这件事 —— 技能包是**构建时**从二进制里导出的
 * 英文长文，真正上屏的是这里压出来的 2k 字符。压错了模型会照着半句话做。
 *
 *   1. 索引能读出名字和一句话；
 *   2. 展开后带 "该用的场合" + 命令样例 + 症状路由；
 *   3. 长文截断落在**行边界**上（不留半句）；
 *   4. 名字容错（`market` 也能找到 `olares-market`）。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkills } from './skills.mjs';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (extra ? ` — ${extra}` : '')); }
};

const MARKET = `---
name: olares-market
version: 1.2.3
description: "Olares Market via olares-cli market — install, upgrade, uninstall apps; catalog, status, --watch."
metadata:
  openclaw:
    requires:
      bins:
        - olares-cli
---

# market

## When to use

- Browse the catalog or inspect "my apps".
- Install, upgrade, uninstall, clone, stop, resume, restart, or cancel an app.
- Inspect lifecycle status.

## Fast paths

| Task | First command |
|---|---|
| See what this user has installed | \`olares-cli market list --mine -o json\` |
| Follow one app's lifecycle | \`olares-cli market status <app>\` |
| Install | \`olares-cli market install <app> --watch\` |

## Verb index

Long prose that should NOT survive condensing: ${'lorem ipsum '.repeat(400)}
`;

const DOCTOR = `---
name: olares-doctor
description: "Runtime diagnosis for Olares apps — find the root cause."
---

# doctor

## When to use

- An install/upgrade is stuck or never reaches \`running\`.

## Symptom routing

| Symptom | Reference |
|---|---|
| Install stuck; sits in pending / downloading | references/a.md |
| App crashes, CrashLoopBackOff | references/b.md |

\`olares-cli doctor images -o json\`
`;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'));
await fs.mkdir(path.join(dir, 'olares-market'), { recursive: true });
await fs.mkdir(path.join(dir, 'olares-doctor'), { recursive: true });
await fs.writeFile(path.join(dir, 'olares-market', 'SKILL.md'), MARKET);
await fs.writeFile(path.join(dir, 'olares-doctor', 'SKILL.md'), DOCTOR);

const skills = createSkills({ dir });

console.log('索引');
{
  const list = await skills.index();
  ok(list.length === 2, `读到 ${list.length} 份`);
  ok(list[0].name === 'olares-doctor' || list[0].name === 'olares-market', '名字来自 frontmatter');
  const m = list.find((x) => x.name === 'olares-market');
  ok(m.when.startsWith('Olares Market via olares-cli market'), '一句话取 description 的第一段', m.when);
  ok(skills.names().includes('olares-doctor'), 'names() 同步可用（工具 schema 用它）');
}

console.log('\n展开');
{
  const r = await skills.read('olares-market');
  ok(!r.error, '能展开', r.error);
  ok(r.doc.includes('Browse the catalog'), '带"该用的场合"');
  ok(r.doc.includes('olares-cli market list --mine'), '带命令样例');
  ok(!r.doc.includes('lorem ipsum'), '长篇正文不进去');
  ok(r.doc.length <= 2100, `体积 ${r.doc.length} 字`);
  /* 截断落在行边界：末行不能是半句（半句比没有更危险） */
  ok(r.doc.endsWith('\n') === false, '不以换行结尾');
  ok(!/\|\s*$/.test(r.doc.split('\n').pop()), '最后一行不是半截表格');
}

console.log('\n症状路由');
{
  const r = await skills.read('olares-doctor');
  ok(r.doc.includes('Install stuck'), '保留症状表的第一列');
  ok(r.doc.includes('olares-cli doctor images'), '保留命令');
}

console.log('\n名字容错');
{
  ok((await skills.read('market')).name === 'olares-market', '`market` 能找到 `olares-market`');
  const bad = await skills.read('nope');
  ok(!!bad.error && bad.error.includes('olares-market'), '找不到时列出可用的', bad.error);
}

await fs.rm(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
