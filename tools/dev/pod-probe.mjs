/* 在 pod 内部跑一轮：验证 in-cluster 凭据、ClusterRole 权限、以及整条链路。
 * 用法（在集群里）：node /tmp/pod-probe.mjs "机器怎么样" */
const BASE = 'http://127.0.0.1:8788/agent';
const text = process.argv[2] || '机器怎么样';
const sid = 'pod-' + Date.now();
const t0 = Date.now();
const ts = () => String(Date.now() - t0).padStart(5);

const es = await fetch(`${BASE}/api/events?sid=${sid}`);
if (!es.ok) { console.log('SSE', es.status, await es.text()); process.exit(1); }
const rd = es.body.getReader();
const dec = new TextDecoder();
let buf = '';
let sent = false;

while (true) {
  const { value, done } = await rd.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const raw = buf.slice(0, i); buf = buf.slice(i + 2);
    if (!raw.startsWith('data:')) continue;
    const ev = JSON.parse(raw.slice(5));
    if (ev.t === 'hello') {
      console.log(`${ts()}  hello sys=${ev.sys} model=${ev.model} tools=${ev.tools.length}`);
      if (!sent) {
        sent = true;
        fetch(`${BASE}/api/send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid, t: 'ask', text }),
        });
      }
    } else if (ev.t === 'tool' && ev.state === 'run') {
      console.log(`${ts()}  ⚙ ${ev.name} ${JSON.stringify(ev.args).slice(0, 90)}`);
    } else if (ev.t === 'tool') {
      console.log(`${ts()}    ↳ ${ev.state} ${ev.note || ''} ${ev.ms ?? ''}ms`);
    } else if (ev.t === 'say') {
      console.log(`${ts()}  💬 ${ev.text}`);
    } else if (ev.t === 'scene') {
      const l = ev.spec ? ev.spec.layers.map((x) => `${x.kind}:${x.id}`).join(' ') : JSON.stringify(ev.ops || '');
      console.log(`${ts()}  ▦ ${ev.op} ${l}`);
      const tr = ev.spec?.layers?.find((x) => x.kind === 'trace');
      if (tr) console.log(`${ts()}     曲线 ${tr.label} ${tr.data.length}点 ${Math.round(Math.min(...tr.data) * 100)}~${Math.round(Math.max(...tr.data) * 100)}% axis=${JSON.stringify(tr.axis)}`);
    } else if (ev.t === 'idle') {
      console.log(`${ts()}  ■ idle（全程 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      process.exit(0);
    } else if (ev.t === 'error') {
      console.log(`${ts()}  ✗ ${ev.message}`);
      process.exit(1);
    } else if (ev.t === 'note') {
      console.log(`${ts()}  · ${String(ev.message).slice(0, 70)}`);
    }
  }
}
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 120000);
