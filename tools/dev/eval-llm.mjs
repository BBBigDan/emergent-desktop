/**
 * 模型效果评测：同一个版本、同一组问题，跑一遍看"它到底能不能一次做完"。
 *
 *   node tools/dev/eval-llm.mjs                      # 打本机 8788
 *   BASE=http://127.0.0.1:8880 node tools/dev/eval-llm.mjs
 *   EVAL_Q="机器现在什么情况,Downloads 里什么最占地方" node tools/dev/eval-llm.mjs
 *
 * 每题一个干净的 sid（不共享历史）—— 测的是"这一问它能不能做完"，
 * 不是"聊了十轮之后"。多轮衰减另有一个用例（EVAL_MULTI=1）。
 *
 * 记五件事，对应五种坏法：
 *   steps   模型往返次数 —— 越多越贵（每步重发整份上下文）
 *   err     被服务端拒掉 / 参数坏的调用 —— 无效步数
 *   tools   实际调过什么 —— 有没有乱调、有没有走弯路
 *   scene   有没有铺屏 —— 只说不做是这台东西最严重的失败
 *   tok     本轮输入总量
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const TIMEOUT = Number(process.env.EVAL_TIMEOUT || 75_000);

const DEFAULT_Q = [
  '机器现在什么情况',
  '有哪个应用不正常吗',
  'Downloads 里什么最占地方',
  'n8n 现在占多少内存',
  '你还记得我上次说过什么吗',
];
const QS = process.env.EVAL_Q ? process.env.EVAL_Q.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_Q;

const pad = (s, n) => {
  /* 中文按两格算，否则表格会歪 */
  const w = [...String(s)].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

async function ask(question) {
  const sid = 'ev' + Math.random().toString(36).slice(2, 10);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const out = { q: question, steps: 0, tok: 0, tools: [], errs: [], scenes: 0, surfaces: 0, say: '', fail: '' };

  let res;
  try {
    res = await fetch(`${BASE}/api/events?sid=${sid}`, { signal: ctl.signal });
  } catch (e) {
    out.fail = '连不上 ' + BASE;
    clearTimeout(timer);
    return out;
  }
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.t === 'usage' && !ev.final) out.steps = Math.max(out.steps, ev.turn?.calls || 0);
          if (ev.t === 'usage' && ev.final) out.tok = ev.turn?.in || 0;
          if (ev.t === 'tool' && ev.state === 'run') out.tools.push(ev.name);
          if (ev.t === 'tool' && (ev.state === 'err' || ev.state === 'denied')) {
            out.errs.push(`${ev.name}:${ev.state}`);
          }
          if (ev.t === 'scene') out.scenes++;
          if (ev.t === 'surface') out.surfaces++;
          if (ev.t === 'say') out.say = ev.text;
          if (ev.t === 'error') out.fail = ev.message;
          if (ev.t === 'idle') { ctl.abort(); return; }
        }
      }
    } catch { /* abort 是正常的结束方式 */ }
  })();

  await new Promise((r) => setTimeout(r, 300));
  try {
    await fetch(`${BASE}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, t: 'ask', text: question }),
    });
  } catch { out.fail = 'POST 失败'; }

  await pump.catch(() => {});
  clearTimeout(timer);
  return out;
}

const rows = [];
for (const q of QS) {
  process.stdout.write(`· ${q} … `);
  const t0 = Date.now();
  const r = await ask(q);
  r.ms = Date.now() - t0;
  rows.push(r);
  console.log(`${r.steps} 步 / ${(r.ms / 1000).toFixed(1)}s`);
}

console.log('\n' + pad('问题', 30) + pad('步', 6) + pad('工具', 44) + pad('错', 6) + pad('输出', 6) + pad('输入', 8) + '结果');
console.log('-'.repeat(114));
for (const r of rows) {
  /* "只说不做"的判据要三个通道一起看：场、渲染树、那一行话。
     只数 scene 会把"铺了一张表"和"答了一句话"都判成没输出 —— 那是测量错误。 */
  const gave = r.scenes + r.surfaces > 0 ? (r.scenes ? '场' : '') + (r.surfaces ? '表' : '')
    : (r.say ? '说' : '');
  const verdict = r.fail
    ? (/429/.test(r.fail) ? '! 限流（不算它的错）' : '✗ ' + r.fail.slice(0, 26))
    : (gave ? '✓' : '△ 一声不吭');
  console.log(
    pad(r.q, 30) + pad(r.steps, 6)
    + pad(r.tools.join(' → ').slice(0, 42), 44)
    + pad(r.errs.length, 6) + pad(gave || '—', 6)
    + pad(r.tok ? `${(r.tok / 1000).toFixed(1)}k` : '—', 8)
    + verdict,
  );
}
const ok = rows.filter((r) => !r.fail && (r.scenes + r.surfaces + (r.say ? 1 : 0)) > 0).length;
const steps = rows.reduce((a, r) => a + r.steps, 0);
const errs = rows.reduce((a, r) => a + r.errs.length, 0);
const limited = rows.filter((r) => /429/.test(r.fail)).length;
console.log(`\n完成 ${ok}/${rows.length} · 平均 ${(steps / rows.length).toFixed(1)} 步 · 无效调用 ${errs} 次 · 总输入 ${(rows.reduce((a, r) => a + r.tok, 0) / 1000).toFixed(1)}k`
  + (limited ? ` · 限流 ${limited} 题（重跑或错开）` : ''));
