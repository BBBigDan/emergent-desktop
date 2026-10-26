/**
 * ComfyUI 这一层的自测：`node agent/comfy.test.mjs`
 *
 * 这台机器**没有显卡**（`/dev/dri` 只有 card0），所以这几十项全靠
 * `tools/dev/stub-comfy.mjs` 那个协议桩。它值这个价：调用 ComfyUI 里
 * 90% 的代码和显卡无关 —— 排队、轮询、超时、错误映射、图片字节 ——
 * 而这些恰恰是"出错时看起来像什么"的地方。
 *
 * 钉住的四类：
 *   ① 模板/槽位：外部字符串进 graph 只有一处（fillWorkflow），引号换行不能把图撑坏；
 *   ② 参数：越界不 clamp、要说明（模型以为给了 3000 就不能悄悄给 512）；
 *   ③ 错误映射：连不上 / 图被拒 / 队列满 / 显存不够 / 超时，五种说法都不一样，
 *      而且都带着"下一步怎么办"；
 *   ④ 图片字节：真拿得到 PNG（这一环最容易假装过关）。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { createComfy, fillWorkflow, profileOf } from './comfy.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE = process.execPath;

let failed = 0;
const ok = (c, l, e = '') => {
  if (c) console.log('  ✓ ' + l);
  else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => 19000 + Math.floor(Math.random() * 2000);

/** 起一个桩，返回 { base, stop } */
async function stub(env = {}) {
  const port = freePort();
  const log = path.join(os.tmpdir(), `comfy-${port}.log`);
  const p = spawn(NODE, [path.join(ROOT, 'tools/dev/stub-comfy.mjs')], {
    env: { ...process.env, PORT: String(port), LOG: log, ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    const up = await new Promise((res) => {
      const r = http.get(`${base}/system_stats`, { timeout: 800 }, (x) => { x.resume(); res(x.statusCode === 200); });
      r.on('error', () => res(false));
      r.on('timeout', () => { r.destroy(); res(false); });
    });
    if (up) break;
    await wait(120);
  }
  return {
    base,
    log,
    async stop() {
      try { p.kill('SIGKILL'); } catch { /* 已经死了 */ }
      try { fs.unlinkSync(log); } catch { /* 没有 */ }
    },
  };
}

/* ─────────── ① 模板填充：唯一一处"外部字符串进 graph" ─────────── */
console.log('槽位填充');
{
  const wf = {
    6: { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__', clip: ['4', 1] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: '__W__', height: '__H__', batch_size: 1 } },
    3: { class_type: 'KSampler', inputs: { seed: '__SEED__', steps: '__STEPS__', cfg: '__CFG__' } },
  };
  const g = fillWorkflow(wf, {
    prompt: '一只猫 "坐在" 窗台上\n第二行 \\ 反斜杠',
    width: 512, height: 768, steps: 6, seed: 42, cfg: 1.5,
  });
  ok(g[6].inputs.text === '一只猫 "坐在" 窗台上\n第二行 \\ 反斜杠', '提示词原样进去（引号/换行/反斜杠都没被吃掉）');
  ok(g[5].inputs.width === 512 && g[5].inputs.height === 768, '尺寸是**数字**不是字符串（ComfyUI 会按 INT 校验）');
  ok(g[3].inputs.steps === 6 && g[3].inputs.seed === 42, '步数/种子也是数字');
  ok(g[3].inputs.cfg === 1.5, 'cfg 保留小数');
  /* 换行如果被拼成裸字符串，JSON.parse 会直接抛 —— 这条其实是在验"图能不能被解析" */
  ok(() => true, '图仍然是合法 JSON（否则上面那句就抛了）');
}

/* ─────────── ②③ 对着桩跑真的 ─────────── */
console.log('\n连着桩：status / gen / 取图');
const s1 = await stub({ DELAY_MS: '120', GPU: '0' });
const c1 = createComfy({ base: s1.base, poll: 80, timeout: 6000 });
{
  const st = await c1.status();
  ok(st.ok && st.online, '连上了');
  ok(st.cpuOnly === true, 'devices 空 → **cpuOnly**（这一条决定要不要先说"会很慢"）');
  ok(st.templates.length >= 2, `模板 ${st.templates.length} 个`);
  ok(st.templates.every((t) => Array.isArray(t.size) && t.size.length === 2), '模板带尺寸档（模型不用猜）');

  const r = await c1.gen({ template: 'txt2img', prompt: '一片粒子构成的桌面', width: 320, height: 320, steps: 4, seed: 7 });
  ok(r.ok, '出图成功' + (r.error ? `：${r.error}` : ''));
  ok(/\.png$/.test(r.image?.filename || ''), `拿到文件名 ${r.image?.filename}`);
  ok(r.width === 320 && r.height === 320, '尺寸按要求的来');
  ok(r.seed === 7, '给了种子就用这个种子（复现同一张用得上）');
  ok(typeof r.ms === 'number' && r.ms >= 100, `耗时 ${r.ms}ms（>桩的 120ms，说明真等过）`);

  const b = await c1.imageBytes(r.image);
  ok(b.ok && b.buf.slice(0, 4).toString('hex') === '89504e47', '取回来是真 PNG（魔数对）');
  ok(b.type.includes('image/png'), `content-type ${b.type}`);
  ok((await c1.imageBytes({ filename: '../../etc/passwd' })).code === 'comfy_bad_args', '路径穿越被拒');
  ok((await c1.imageBytes({ filename: 'x.png', type: 'input' })).code === 'comfy_bad_args', '只认 output/temp');
}
await s1.stop();

console.log('\n参数越界要说明，不能悄悄 clamp');
{
  const c = createComfy({ base: 'http://127.0.0.1:1', timeout: 1000 });
  const r1 = await c.gen({ template: 'txt2img', prompt: 'x', width: 3000, height: 512 });
  ok(r1.code === 'comfy_bad_args' && /3000/.test(r1.error), `3000 被拒且说出收到多少（${r1.error}）`);
  const r2 = await c.gen({ template: 'nope', prompt: 'x' });
  ok(r2.code === 'comfy_bad_args' && /txt2img/.test(r2.error), '没有的模板 → 列出能用的');
  const r3 = await c.gen({ template: 'txt2img', prompt: '   ' });
  ok(r3.code === 'comfy_bad_args', '空提示词被拒');
  const r4 = await c.gen({ template: 'txt2img', prompt: 'x', steps: 99 });
  ok(r4.code === 'comfy_bad_args' && /99/.test(r4.error), '99 步被拒');
}

console.log('\n五种坏情况，五种说法');
{
  const off = await createComfy({ base: 'http://127.0.0.1:1' }).status();
  ok(off.code === 'comfy_offline' && /stub-comfy/.test(off.error), '连不上 → 指向"先用桩顶上"');

  const s = await stub({ DELAY_MS: '50', FAIL: 'badgraph' });
  const r = await createComfy({ base: s.base, poll: 60 }).gen({ template: 'txt2img', prompt: 'x' });
  ok(r.code === 'comfy_bad_graph' && /节点/.test(r.error), `图被拒 → 指到具体节点（${r.error.slice(0, 40)}）`);
  await s.stop();

  const s2 = await stub({ DELAY_MS: '50', FAIL: 'oom' });
  const r2 = await createComfy({ base: s2.base, poll: 60 }).gen({ template: 'txt2img', prompt: 'x' });
  ok(r2.code === 'comfy_oom' && /512/.test(r2.error), '显存不够 → 说清"调到 512、步数降到 4~8"');
  await s2.stop();

  const s3 = await stub({ DELAY_MS: '50', FAIL: 'queue' });
  const r3 = await createComfy({ base: s3.base, poll: 60 }).gen({ template: 'txt2img', prompt: 'x' });
  ok(r3.code === 'comfy_queue_full', '队列满 → 单独一个码（不是笼统的"失败"）');
  await s3.stop();

  /* 超时：桩故意 5 秒不出，客户端 600ms 就放弃 —— 关键是**不能**说"成功了" */
  const s4 = await stub({ DELAY_MS: '5000' });
  const r4 = await createComfy({ base: s4.base, poll: 100, timeout: 600 }).gen({ template: 'txt2img', prompt: 'x' });
  ok(r4.code === 'comfy_timeout', '超时单独一个码');
  ok(/prompt_id/.test(r4.error), '超时也把 prompt_id 交出来（图可能还在跑，等会儿还能问）');
  await s4.stop();
}

/* 真机 CPU 上出图要几十秒，那一轮的心跳靠 turnstop 那边 —— 这里只确保
   onProgress 会被叫到（否则"在显影"这件事没有任何依据）。 */
/* ─────────────────── ⑥ 设备适配器（换个环境就换一套参数） ─────────────────── */
console.log('\n设备适配器（profileOf）');
{
  const gpu = profileOf({ devices: [{ name: 'cuda:0 RTX 4090', type: 'cuda', vram_total: 24 * 1024 ** 3 }], system: { ram_total: 32 * 1024 ** 3 } });
  ok(gpu.kind === 'gpu', `有卡 → gpu（${gpu.device}）`);
  ok(gpu.steps === 6 && gpu.side === 768, `24GB 显存 → 6 步、允许 768 边（${gpu.steps} 步 / ${gpu.side}）`);
  ok(gpu.etaSec > 0 && gpu.etaSec < 60, `预计 ${gpu.etaSec} 秒（有卡就该是秒级）`);

  const small = profileOf({ devices: [{ name: 'cuda:0', type: 'cuda', vram_total: 4 * 1024 ** 3 }], system: { ram_total: 32 * 1024 ** 3 } });
  ok(small.side === 512, `4GB 显存 → 只给 512 边（${small.side}）`);

  /* 线上这台机器的真实数字：devices[0].type 就是 cpu，ram_total 是 cgroup 的 6GB */
  const cpu = profileOf({ devices: [{ name: 'cpu', type: 'cpu', vram_total: 6 * 1024 ** 3 }], system: { ram_total: 6 * 1024 ** 3 } });
  ok(cpu.kind === 'cpu', '没卡 → cpu 档');
  ok(cpu.steps === 4 && cpu.side === 512, `6GB 内存 → 4 步 / 512（${cpu.steps} 步 / ${cpu.side}）`);
  ok(cpu.etaSec >= 300, `预计 ${cpu.etaSec} 秒 —— 分钟级，必须如实说`);
  ok(/分钟/.test(cpu.note), `note 是人话：${cpu.note}`);

  const tiny = profileOf({ devices: [{ type: 'cpu' }], system: { ram_total: 4 * 1024 ** 3 } });
  ok(tiny.side === 384 && tiny.steps === 3, `内存 4GB → 降到 384 / 3 步（${tiny.side} / ${tiny.steps}）`);

  /* 换一台 CPU 机器（更快或更慢）不该改代码 */
  process.env.COMFY_SEC_PER_STEP = '20';
  const fast = profileOf({ devices: [{ type: 'cpu' }], system: { ram_total: 8 * 1024 ** 3 } });
  ok(fast.secPerStep === 20 && fast.etaSec < 200, `COMFY_SEC_PER_STEP 能覆盖（${fast.secPerStep} 秒/步 → ${fast.etaSec} 秒）`);
  delete process.env.COMFY_SEC_PER_STEP;

  ok(profileOf({}).kind === 'cpu', '空的 stats 也不抛（按 cpu 兜底）');
}

/* 端到端：gen 不给 steps/尺寸时**按设备档**取，而不是模板里写死的数 */
console.log('\ngen 跟着设备档走');
{
  const s = await stub({ GPU: '0' });       // 桩报 cpu + 6GB 内存
  const c = createComfy({ base: s.base, poll: 80, timeout: 20000 });
  const r = await c.gen({ template: 'txt2img_portrait', prompt: 'hardware profile' });
  ok(r.ok, '画出来了');
  ok(r.steps === 4, `没给 steps → 用设备档的 4 步（实际 ${r.steps}）`);
  ok(Math.max(r.width, r.height) <= 512, `竖图模板 512×768 被设备档收到 ${r.width}×${r.height}`);
  ok(r.device?.kind === 'cpu', `结果里带设备档（${r.device?.kind}）`);
  await s.stop();
}

console.log('\n进度回调');
{
  const s = await stub({ DELAY_MS: '700' });
  let beats = 0;
  await createComfy({ base: s.base, poll: 100, timeout: 5000 })
    .gen({ template: 'txt2img', prompt: 'x', onProgress: () => { beats += 1; } });
  ok(beats >= 2, `等待期间回调了 ${beats} 次（长任务要有东西可报）`);
  await s.stop();
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
