/**
 * olares 的形状压缩自测。不需要网络、不需要 CLI：
 *
 *   node agent/olares.test.mjs
 *
 * 夹具（`agent/fixtures/olares/*.json`）是**线上 pod 里抓的真货**：
 * 2026-10-22，`olares-cli 1.12.8-cli.0`，用户 bbbigdan。
 * pods 和 images 各截了前 8 / 30 条，其余原样 —— 只截数量，不改字段。
 *
 * 为什么值得单测这一层：字段名是**猜的**，猜错时屏幕上不会报错，
 * 只会少一个数或者多一句假话（踩过两次：
 *   ① 把 images 的引用数当成 `in_use`，于是 179 个镜像全说成"没人用"；
 *   ② 把 `--mine` 的应用占比当成整机使用率，2% 说成 0.22%）。
 * 这两种错误都长得像"数字就是这样的"，只能靠对真数据验形状来挡。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createOlares, OPS, OP_DOC } from './olares.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/olares', n), 'utf8'));

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (extra ? ` — ${extra}` : '')); }
};

/* 不 exec，只用它的 shape */
const { shape } = createOlares({ bin: 'echo' });

console.log('pods（原始 366KB，只留能回答问题的四个数）');
{
  const r = shape('pods', fx('pods.json'));
  ok(Array.isArray(r.pods) && r.pods.length === 8, `8 条 → ${r.pods?.length}`);
  const p = r.pods[0];
  ok(p.name && p.ns, `名字和命名空间：${p.name} @ ${p.ns}`);
  ok(/^\d+\/\d+$/.test(p.ready), `就绪数：${p.ready}`);
  ok(typeof p.restarts === 'number', `重启次数：${p.restarts}`);
  ok(JSON.stringify(r).length < 4000, `压完 ${JSON.stringify(r).length} 字（原始 366KB）`);
  /* 没有 waiting 的不给 undefined 占位 —— 模型看到 "waiting: undefined" 会当成有 */
  ok(!('waiting' in p) || p.waiting !== undefined, '没有 waiting 就不给这个键');
}

console.log('\nimages（引用数字段是 refs，不是 in_use）');
{
  const r = shape('images', fx('images.json'));
  ok(r.total === 30, `总数 ${r.total}`);
  ok(typeof r.unused === 'number', `没人用的 ${r.unused} 个`);
  ok(r.biggest.length === 8, '最大的 8 个');
  ok(r.biggest[0].sizeMB >= r.biggest[7].sizeMB, '真的按大小降序');
  ok(r.biggest.every((x) => x.tag && x.tag.length <= 20), '每一条都有个能念出来的名字');
  ok(r.biggest[0].used !== undefined, 'used 是真的从 refs 算出来的');

  /* 字段不在时**不给假数**：宁可少一句 */
  const bare = shape('images', { images: [{ id: 'sha256:abc', size: 1024 }] });
  ok(bare.unused === undefined, '没有 refs 字段时不给 unused（不编 0）');
}

console.log('\nstatus（"一直转圈"的答案在 progress / message 里）');
{
  const r = shape('app', fx('status.json'), 'n8n');
  ok(r.state === 'running' && r.version === '1.1.8', `${r.state} · ${r.version}`);
  ok(r.progress === undefined, 'progress 是 "-" 时不给（那是占位符）');
  ok(r.message === undefined || typeof r.message === 'string', 'message 原样');
  ok(r.source === 'market.olares', '来源');
  /* 卡住时的形状：必须有 progress 或 message 能把原因说清 */
  const stuck = shape('app', { name: 'x', state: 'installing', progress: '45%', message: 'pulling image', version: '1.0' }, 'x');
  ok(stuck.progress === '45%' && stuck.message === 'pulling image', '卡住时把进度和原因带出来');
}

console.log('\nbackup');
{
  const r = shape('backup', fx('backup.json'));
  ok(r.count === 0 && Array.isArray(r.plans), '没有备份计划时是空数组，不是 undefined');
}

console.log('\n其它 op 的兜底');
{
  /* dashboard overview 的三个坑：单位、utilisation、ranking 只留前 3 */
  const ov = shape('overview', {
    sections: {
      physical: { items: [
        { raw: { metric: 'cpu', total: 8, utilisation: 0.325 } },
        { raw: { metric: 'memory', unit: 'Gi', value: 7085707264, total: 16375776000, utilisation: 0.47 } },
      ] },
      ranking: { items: [1, 2, 3, 4, 5].map((n) => ({ raw: { name: 'a' + n, utilisation: 0.1 * n } })) },
    },
    meta: { fetched_at: 'now' },
  });
  ok(ov.physical.cpu.pct === 0.325, 'cpu 用 utilisation');
  ok(ov.physical.memory.unit === 'GiB' && ov.physical.memory.total === 15.3,
    `字节折 GiB：${ov.physical.memory.total}（原样交给模型会说"70 亿 Gi"）`);
  ok(ov.ranking.length === 3, 'ranking 只留前 3');
  /* 没有 utilisaton 的不补 0 —— 补 0 会画出满格 */
  const noPct = shape('overview', { sections: { physical: { items: [{ raw: { metric: 'disk', value: 5, total: 10 } }] } } });
  ok(noPct.physical.disk.pct === undefined, '没有 pct 就不给（不补 0）');
}

console.log('\nop 表自洽');
{
  ok(OPS.includes('apps') && OPS.includes('pods') && OPS.includes('images'), `${OPS.length} 个 op`);
  /* 每个 op 都要在说明里出现 —— 少一个，模型就少一条"这个 op 是干什么的" */
  const missing = OPS.filter((o) => !OP_DOC.includes(`${o}=`));
  ok(missing.length === 0, '每个 op 都有说明', missing.join(','));
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
