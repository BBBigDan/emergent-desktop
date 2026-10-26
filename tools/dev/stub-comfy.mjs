/**
 * ComfyUI 的**协议桩**：`node tools/dev/stub-comfy.mjs`
 *
 * 为什么需要它：这台机器没有显卡（`/dev/dri` 只有 card0、没有 renderD128），
 * 但"调用 ComfyUI"这件事里 90% 的代码和显卡无关 —— 排队、轮询、超时、
 * 错误映射、图片怎么回到屏幕上。那些都该在没有 GPU 的机器上、在 CI 里被钉死。
 *
 * 它照的是 ComfyUI 真的 HTTP 契约（0.3.x）：
 *
 *   GET  /system_stats          → {system:{os,comfyui_version,python_version}, devices:[...]}
 *   GET  /object_info           → 节点定义（这里只给 CheckpointLoaderSimple 那一份）
 *   POST /prompt                → {prompt_id, number, node_errors}；图不合法时 400
 *   GET  /history/<prompt_id>   → {<id>:{outputs:{<node>:{images:[...]}}, status:{...}}}
 *   GET  /view?filename=…       → PNG 字节
 *   GET  /queue                 → {queue_running, queue_pending}
 *   POST /interrupt             → 200（打断当前那张）
 *
 * 环境变量：
 *   PORT=8188          监听端口（和 ComfyUI 默认一致）
 *   GPU=0              1 = 假装有卡（devices 里给一条 CUDA）；0 = 只有 CPU
 *   DELAY_MS=200       每张图"生成"耗时。真机 CPU 上 SD-Turbo 4 步约 20~40 秒
 *   FAIL=oom|badgraph|queue  注入故障，用来验错误映射（默认不注入）
 *   LOG=…              每个请求记一行，测试用它判断"到底有没有真的发过去"
 *
 * 图片是真的 PNG（zlib 现编的渐变+噪点），因为"能不能拿到字节、能不能显示"
 * 是这条链路里最容易假装过关的一环。
 */
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 8188);
const GPU = process.env.GPU === '1';
const DELAY = Number(process.env.DELAY_MS || 200);
const FAIL = process.env.FAIL || '';
const LOG = process.env.LOG || '';

/* ───────────────────── 一张真 PNG（不含第三方依赖） ─────────────────────
 *
 * 渐变 + 一点噪点：够用来验"字节能不能过代理、前端能不能显示"，
 * 又不至于像纯色块那样在缩放/fit 上看出问题。
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @returns {Buffer} 一张 w×h 的 RGB PNG */
function makePng(w, h, seed = 7) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  let r = seed;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;                        // 每行的 filter 字节
    for (let x = 0; x < w; x++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      const n = (r >>> 16) % 26 - 13;    // 噪点，别让它是一张死渐变
      raw[p++] = Math.max(0, Math.min(255, Math.round((x / w) * 190 + 30 + n)));
      raw[p++] = Math.max(0, Math.min(255, Math.round((y / h) * 150 + 40 + n)));
      raw[p++] = Math.max(0, Math.min(255, Math.round(150 - (x / w) * 90 + n)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 2;      // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = makePng(256, 256);

/* ───────────────────── 假状态 ───────────────────── */

let seq = 0;
const jobs = new Map();   // prompt_id → { at, graph, w, h }
let interrupted = 0;

const log = (line) => { if (LOG) { try { fs.appendFileSync(LOG, line + '\n'); } catch { /* 日志不该影响服务 */ } } };

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
};

/** 把请求里的图当作 ComfyUI 会做的那样**检查一遍**：每个节点要 class_type + inputs。 */
function validate(graph) {
  const errs = {};
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { error: 'prompt 必须是一个 {节点id: 节点} 的对象', node_errors: {} };
  }
  const kinds = new Set();
  for (const [id, node] of Object.entries(graph)) {
    if (!node || typeof node !== 'object') { errs[id] = { errors: [{ type: 'invalid_node' }] }; continue; }
    if (!node.class_type) errs[id] = { errors: [{ type: 'required_input_missing', details: 'class_type' }] };
    else kinds.add(node.class_type);
    if (!node.inputs || typeof node.inputs !== 'object') errs[id] = { errors: [{ type: 'required_input_missing', details: 'inputs' }] };
  }
  if (!kinds.has('KSampler')) errs.root = { errors: [{ type: 'missing_node', details: 'KSampler' }] };
  return Object.keys(errs).length ? { error: 'Prompt outputs failed validation', node_errors: errs } : null;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  log(`${req.method} ${p}`);

  /* 系统信息：这台机器有没有卡，前端/模型都靠它 —— 别猜 */
  if (p === '/system_stats') {
    return json(res, 200, {
      system: { os: 'posix', ram_total: 16 * 1024 ** 3, ram_free: 8 * 1024 ** 3, comfyui_version: '0.3.40', python_version: '3.11.9', pytorch_version: '2.4.1' },
      devices: GPU
        ? [{ name: 'cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync', type: 'cuda', index: 0, vram_total: 24 * 1024 ** 3, vram_free: 21 * 1024 ** 3, torch_vram_total: 24 * 1024 ** 3 }]
        : [],
    });
  }

  if (p === '/object_info' || p === '/object_info/CheckpointLoaderSimple') {
    const node = {
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['sd-turbo.safetensors', 'v1-5-pruned-emaonly.safetensors', 'dreamshaper_8.safetensors']] } },
        name: 'CheckpointLoaderSimple', output: ['MODEL', 'CLIP', 'VAE'],
      },
    };
    return json(res, 200, p === '/object_info' ? node : node.CheckpointLoaderSimple);
  }

  if (p === '/queue') {
    const running = [...jobs.entries()].filter(([, j]) => Date.now() - j.at < DELAY).map(([id]) => [0, id]);
    return json(res, 200, { queue_running: running, queue_pending: [] });
  }

  if (p === '/interrupt') { interrupted++; jobs.clear(); return json(res, 200, {}); }

  if (p === '/prompt' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch { return json(res, 400, { error: { type: 'invalid_json', message: 'body 不是 JSON' }, node_errors: {} }); }
      const graph = j.prompt;
      const bad = validate(graph);
      if (bad || FAIL === 'badgraph') {
        return json(res, 400, { error: { type: 'prompt_outputs_failed_validation', message: bad?.error || 'injected' }, node_errors: bad?.node_errors || { 9: { errors: [{ type: 'value_not_in_list' }] } } });
      }
      if (FAIL === 'queue') return json(res, 429, { error: { type: 'queue_full', message: '队列满了' }, node_errors: {} });
      seq += 1;
      const id = `stub-${String(seq).padStart(4, '0')}-${Math.random().toString(36).slice(2, 8)}`;
      /* 从图里读回尺寸：验"参数真的进了图"，而不是被客户端写在别处 */
      const latent = Object.values(graph).find((n) => n.class_type === 'EmptyLatentImage');
      jobs.set(id, { at: Date.now(), graph, w: Number(latent?.inputs?.width) || 0, h: Number(latent?.inputs?.height) || 0 });
      return json(res, 200, { prompt_id: id, number: seq, node_errors: {} });
    });
    return;
  }

  if (p.startsWith('/history/')) {
    const id = decodeURIComponent(p.slice('/history/'.length));
    const job = jobs.get(id);
    if (!job) return json(res, 200, {});
    const elapsed = Date.now() - job.at;
    if (FAIL === 'oom') {
      jobs.delete(id);
      return json(res, 200, {
        [id]: {
          outputs: {},
          status: {
            status_str: 'error', completed: false,
            messages: [['execution_error', { node_id: '3', node_type: 'KSampler', exception_type: 'torch.OutOfMemoryError', exception_message: 'CUDA out of memory. Tried to allocate 2.00 GiB' }]],
          },
        },
      });
    }
    if (elapsed < DELAY) return json(res, 200, {});       // 还在跑
    jobs.delete(id);
    return json(res, 200, {
      [id]: {
        prompt: [0, id, job.graph, {}, []],
        outputs: { 9: { images: [{ filename: `emergent_${id}.png`, subfolder: '', type: 'output' }] } },
        status: { status_str: 'success', completed: true, messages: [] },
      },
    });
  }

  if (p === '/view') {
    const fn = u.searchParams.get('filename') || '';
    if (!/\.png$/i.test(fn)) return json(res, 400, { error: '只有 png' });
    const sub = u.searchParams.get('subfolder') || '';
    if (sub.includes('..')) return json(res, 400, { error: 'bad subfolder' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    return res.end(PNG);
  }

  json(res, 404, { error: `桩没实现 ${req.method} ${p}` });
});

server.listen(PORT, '127.0.0.1', () => console.log(`stub-comfy on ${PORT}${GPU ? ' (fake GPU)' : ' (cpu only)'}${FAIL ? ` fail=${FAIL}` : ''}`));
