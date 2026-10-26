/**
 * ComfyUI —— 只认一个 HTTP 地址，其余什么都不假设。
 *
 * 为什么不让模型写 workflow：
 *   一张真图是 2~5KB 的节点 id + 连线，7B 一定写错（实测它在 20 行的 JSON 里
 *   都会漏参数），而且"任意图"等于"任意节点执行" —— 那是安全口子。
 *   所以**图归服务端所有**（`agent/workflows/*.json`），模型只填几个槽：
 *   模板名、提示词、尺寸档、步数、种子。这和 `scene.schema.mjs` 的白名单一个思路：
 *   能表达的范围由代码决定，不由模型的表达欲决定。
 *
 * 为什么这一层能脱离显卡开发：
 *   排队、轮询、超时、错误映射、图片怎么回到屏幕上 —— 这些都和 GPU 无关。
 *   `tools/dev/stub-comfy.mjs` 把真契约实现了一遍，于是这些能在 CI 里钉死。
 *   真出图另说：本机 CPU 跑 SD-Turbo（4 步 512）20~40 秒一张，够验收。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, 'workflows');

const DEFAULTS = {
  prompt: '',
  negative: 'blurry, low quality, watermark, text',
  steps: 8,
  seed: 0,           // 0 = 随机
  model: '',
};

/* 一条消息里能出现的所有槽。模板里写成 `"__PROMPT__"`（带引号），
   填值的时候整段替换成 **JSON 编码后的值** —— 提示词里的引号、换行、
   反斜杠都由 JSON.stringify 负责，不当字符串拼。 */
const SLOT_RE = /"__(PROMPT|NEGATIVE|W|H|STEPS|SEED|CFG|MODEL|SAMPLER|PREFIX|SCHEDULER)__"/g;

/**
 * 把模板里的占位符填成真值。
 * 导出的理由是：这是唯一一处"外部字符串进 graph"的地方，值得单独钉住。
 * @param {object} wf 模板 workflow（API 格式）
 * @param {object} v  槽值（已经过范围检查）
 */
export function fillWorkflow(wf, v) {
  const map = {
    PROMPT: JSON.stringify(String(v.prompt ?? '')),
    NEGATIVE: JSON.stringify(String(v.negative ?? '')),
    W: String(Math.round(v.width)),
    H: String(Math.round(v.height)),
    STEPS: String(Math.round(v.steps)),
    SEED: String(Math.round(v.seed)),
    CFG: String(Number(v.cfg ?? 1.5)),
    MODEL: JSON.stringify(String(v.model || '')),
    SAMPLER: JSON.stringify(String(v.sampler || 'euler')),
    SCHEDULER: JSON.stringify(String(v.scheduler || 'normal')),
    PREFIX: JSON.stringify(String(v.prefix || 'emergent')),
  };
  const text = JSON.stringify(wf).replace(SLOT_RE, (_m, k) => map[k]);
  return JSON.parse(text);
}

/**
 * **设备 → 参数（"适配器"）**：模板只提供"形状"，档位由这台机器决定。
 *
 * 同一份模板要跑在有卡的机器、纯 CPU 的机器、内存被 cgroup 掐住的 pod 上。
 * 把 steps / 尺寸写死在模板里 = 只对开发那台机器有效：
 * 在 4090 上按 CPU 档（4 步 512）画是浪费；在纯 CPU 上按 GPU 档（8 步 768）画
 * 是十几分钟起步（实测）。
 *
 * 判据只用一个真数据源：ComfyUI 自己的 `/system_stats`
 * （`devices[].type` / `vram_total` / `system.ram_total`，后者在 cgroup 里就是 cgroup 限额）。
 * 换算系数 `COMFY_SEC_PER_STEP` 可以覆盖 —— 换机器时不必改代码。
 *
 * @param {any} stats /system_stats 的返回
 */
export function profileOf(stats) {
  const dev = (stats?.devices || [])[0] || {};
  const type = String(dev.type || '').toLowerCase();
  const vram = Number(dev.vram_total || 0);
  const ram = Number(stats?.system?.ram_total || 0);
  const secEnv = Number(process.env.COMFY_SEC_PER_STEP || 0);
  const gb = (n) => +((n / 1024 ** 3).toFixed(1));

  if (/cuda|rocm|mps|xpu|gpu/.test(type) && vram > 0) {
    const secPerStep = secEnv || 2;          // 一张 512、6 步 ≈ 12~20 秒
    const steps = 6;
    return {
      kind: 'gpu',
      device: String(dev.name || type).slice(0, 48),
      vramGB: gb(vram),
      ramGB: ram ? gb(ram) : null,
      side: vram >= 8 * 1024 ** 3 ? 768 : 512,   // 显存够就允许竖图/大图
      steps,
      secPerStep,
      etaSec: Math.round(secPerStep * steps + 6),
      etaMin: [Math.max(1, Math.round((secPerStep * steps + 6) * 0.8 / 60)),
        Math.max(2, Math.round((secPerStep * steps + 6) * 1.6 / 60))],
      note: '',
    };
  }

  /* 没卡。`--force-fp32` 与否不影响这个判断：都是 CPU 上算，
     差别只是"哪一档更慢"，档位按 CPU 给。 */
  const tight = ram > 0 && ram < 6 * 1024 ** 3;   // cgroup 只有 6GB 以内：别上 512
  /* 每步多少秒：**取实测的中位数，不取最好那一次**。
     这台机器四次真实测量的"扣掉 40 秒固定开销"的每步耗时是 82 / 100 / 106 / 137 秒
     （同样 512×512、SD1.5 LCM、8 vCPU、fp32），差别来自整机争抢 —— load 30 的时候
     比空闲时慢 60%。原来写 88（最好那一次的整图平均），于是 `advice` 说"7 分钟"、
     实际 8~10 分钟，用户听到的就是一句会打脸的估计。 */
  const secPerStep = secEnv || 105;
  const steps = tight ? 3 : 4;
  const etaSec = Math.round(secPerStep * steps + 40);   // +40s ≈ 载权重 / 文本编码 / VAE 解码
  /* **给区间，不给单点。** 单点数在这种共享 CPU 上必然有一半时间不准；
     区间还顺带把"机器忙时更慢"这件事说出来了。 */
  const loMin = Math.max(1, Math.round((etaSec * 0.85) / 60));
  const hiMin = Math.max(loMin + 1, Math.round((etaSec * 1.35) / 60));
  return {
    kind: 'cpu',
    device: String(dev.name || type || 'cpu').slice(0, 48),
    vramGB: null,
    ramGB: ram ? gb(ram) : null,
    side: tight ? 384 : 512,
    steps,
    secPerStep,
    etaSec,
    etaMin: [loMin, hiMin],
    note: tight
      ? `纯 CPU、内存只有 ${gb(ram)}GB：最多 ${tight ? 384 : 512} 边、${steps} 步，一张 ${loMin}~${hiMin} 分钟。`
      : `纯 CPU：约 ${secPerStep} 秒/步，一张 ${loMin}~${hiMin} 分钟（机器忙时靠上）。画之前先跟用户说一声要等这么久。`,
  };
}

/** 错误码 → 给模型看的一句话（模型再翻成人话给用户）。 */
const ERR_ZH = {
  comfy_offline: '连不上 ComfyUI',
  comfy_bad_graph: '工作流被 ComfyUI 拒了',
  comfy_queue_full: 'ComfyUI 队列满了',
  comfy_oom: '显存/内存不够',
  comfy_failed: '出图失败了',
  comfy_timeout: '等太久还没出来',
  comfy_no_image: '跑完了但没有输出图',
  comfy_bad_args: '参数不对',
};

/**
 * @param {object} o
 * @param {string} [o.base]    覆盖地址（测试用）；默认 COMFY_URL 或 127.0.0.1:8188
 * @param {number} [o.timeout] 单张图的等待上限
 */
export function createComfy(o = {}) {
  const baseOf = () => String(o.base ?? process.env.COMFY_URL ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');
  /* 等一张图的上限。**默认值不再是常数 180 秒**：同样 6 步，有卡的机器 15 秒，
     纯 CPU 的机器 10 分钟 —— 写死一个数总有一边是错的。env / 调用方仍然最高优先。 */
  const WAIT_OVERRIDE = Number(o.timeout || process.env.COMFY_TIMEOUT_MS || 0);
  const waitOf = (prof) => WAIT_OVERRIDE || Math.max(120_000, (prof?.etaSec || 120) * 2.5 * 1000);
  const POLL = Number(o.poll || 700);

  /* 设备档案缓存 30 秒：一张图的生成里会问好几次，没必要每次都打 /system_stats。 */
  let profCache = null;
  let profAt = 0;
  async function profile({ fresh = false } = {}) {
    if (!fresh && profCache && Date.now() - profAt < 30_000) return profCache;
    const st = await getJSON('/system_stats', { timeout: 5000 });
    if (!st.ok) return profCache;          // 连不上就用旧的（null 也行：下面都有兜底）
    profCache = profileOf(st.data);
    profAt = Date.now();
    return profCache;
  }

  /* 模板：目录里一个文件一个模板，id = 文件名。启动时读一次，改模板要重启 —— 
     "重启才生效"对**服务端自己的文件**是可以的（它跟着镜像走）。 */
  let tplCache = null;
  async function templates() {
    if (tplCache) return tplCache;
    const out = [];
    try {
      const files = (await fs.readdir(WORKFLOW_DIR)).filter((f) => f.endsWith('.json'));
      for (const f of files.sort()) {
        const j = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, f), 'utf8'));
        out.push({
          id: f.replace(/\.json$/, ''),
          label: j.label || f,
          doc: j.doc || '',
          /* 默认值也一起给出去：模型不用猜"尺寸档有哪些" */
          size: j.size || [512, 512],
          steps: j.steps ?? DEFAULTS.steps,
          model: j.model || '',
          /* 采样器/CFG 跟着模型走：少步蒸馏模型（LCM / Turbo）用 `lcm` 或 `euler` + 低 CFG，
             普通 SD1.5 用 `dpmpp_2m` + 7。写死在代码里就只能有一种模型。 */
          sampler: j.sampler || '',
          scheduler: j.scheduler || '',
          cfg: j.cfg == null ? null : Number(j.cfg),
          note: j.note || '',
          _wf: j.workflow,
        });
      }
    } catch (e) {
      console.warn('[comfy] 读模板失败：' + e.message);
    }
    tplCache = out;
    return out;
  }

  async function getJSON(p, { timeout = 8000 } = {}) {
    const t0 = Date.now();
    try {
      const r = await fetch(baseOf() + p, { signal: AbortSignal.timeout(timeout) });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* 下面按非 JSON 处理 */ }
      return { ok: r.ok, status: r.status, data, text, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, status: 0, error: String(e?.message || e), ms: Date.now() - t0 };
    }
  }

  async function postJSON(p, body, { timeout = 15000 } = {}) {
    const t0 = Date.now();
    try {
      const r = await fetch(baseOf() + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* 保持 null */ }
      return { ok: r.ok, status: r.status, data, text, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, status: 0, error: String(e?.message || e), ms: Date.now() - t0 };
    }
  }

  /**
   * 它现在能不能干活 —— **有没有卡**是这里的第一个事实，不是猜的。
   * `devices` 空就是纯 CPU：出图会慢到分钟级，这件事必须先告诉用户，
   * 而不是让他等三分钟以为是卡住了。
   */
  async function status() {
    const st = await getJSON('/system_stats');
    if (!st.ok) {
      return {
        error: `连不上 ComfyUI（${baseOf()}）：${st.error || `HTTP ${st.status}`}。`
          + '先确认地址对不对、服务起没起；没起的话这台机器可以用 tools/dev/stub-comfy.mjs 先顶上。',
        code: 'comfy_offline',
      };
    }
    const q = await getJSON('/queue', { timeout: 5000 });
    const models = await getJSON('/object_info/CheckpointLoaderSimple', { timeout: 6000 });
    const list = models.data?.input?.required?.ckpt_name?.[0];
    const tpls = await templates();
    /* **设备档：这一屏里"该怎么画"的唯一出处。**
       模型不用记"78 秒/步"这种数字，它只要照 recommend 里的 steps / 尺寸来；
       换一台有卡的机器，同一段对话里的建议就自动变成 6 步 512 或 768。 */
    const prof = profileOf(st.data);
    profCache = prof;
    profAt = Date.now();
    const side = prof.side;
    const fit = (sz) => {
      const m = Math.max(...sz);
      const k = side ? Math.min(1, side / m) : 1;
      return [Math.max(64, Math.round(sz[0] * k / 8) * 8), Math.max(64, Math.round(sz[1] * k / 8) * 8)];
    };
    const first = tpls[0];
    const [rw, rh] = fit(first?.size || [512, 512]);
    /* `etaSec` 是"大概多久"（用来设等待上限、也用来算钱），`etaMin` 是**说给用户听的区间** ——
       共享 CPU 上单点数必然有一半时间不准，说了"7 分钟"却等 10 分钟，用户会认为它在瞎报。 */
    const recommend = {
      template: first?.id || '', steps: prof.steps, width: rw, height: rh,
      etaSec: prof.etaSec, etaMin: prof.etaMin || null,
    };
    return {
      ok: true,
      online: true,
      version: st.data?.system?.comfyui_version || '',
      /* 保留老字段（gpu / cpuOnly）：工具描述、报错话术、自测都在用 */
      gpu: prof.kind === 'gpu' ? { name: prof.device, vramGB: prof.vramGB } : null,
      cpuOnly: prof.kind !== 'gpu',
      device: prof,
      recommend,
      /* 这台机器上"用哪套参数"的一句话 —— 模型照着说给用户听 */
      advice: prof.note
        || `有卡（${prof.device}，${prof.vramGB}GB 显存）：${rw}×${rh}、${prof.steps} 步，约 ${prof.etaSec} 秒。`,
      queue: q.ok ? { running: (q.data?.queue_running || []).length, pending: (q.data?.queue_pending || []).length } : null,
      models: Array.isArray(list) ? list.slice(0, 12) : [],
      /* 模板报的是**生效值**（设备档裁过的）。模板文件里那套数只是兜底。 */
      templates: tpls.map((t) => ({ id: t.id, label: t.label, size: fit(t.size), steps: prof.steps })),
    };
  }

  /**
   * 生成一张。
   * @param {object} a
   * @param {string} a.template  模板 id（不给就用第一个）
   * @param {string} a.prompt    提示词（会过长度上限）
   * @param {number} [a.width]
   * @param {number} [a.height]
   * @param {number} [a.steps]
   * @param {number} [a.seed]    0 / 不给 = 随机
   * @param {(p:{elapsedMs:number,queueAhead?:number})=>void} [a.onProgress]
   */
  async function gen(a = {}) {
    const tpls = await templates();
    if (!tpls.length) return { error: '服务端没有可用的工作流模板（agent/workflows/*.json）', code: 'comfy_bad_args' };
    const tpl = String(a.template || tpls[0].id);
    const t = tpls.find((x) => x.id === tpl);
    if (!t) {
      return { error: `没有这个模板：${tpl}。能用的是 ${tpls.map((x) => x.id).join(' / ')}。`, code: 'comfy_bad_args' };
    }
    const prompt = String(a.prompt ?? '').trim();
    if (!prompt) return { error: '要给 prompt（想画什么）', code: 'comfy_bad_args' };
    if (prompt.length > 1200) return { error: `prompt 太长（${prompt.length} 字，最多 1200）`, code: 'comfy_bad_args' };

    /* 设备档案：模型不需要知道这台机器几核几张卡，但**参数要跟着它变**。 */
    const prof = await profile();
    let scaledDown = null;      // 被设备档缩过尺寸时记一笔，回给模型/用户

    /* 尺寸夹在模板允许的档里：模型给 3000×3000 时不 clamp 而是**说明**，
       否则它会以为"我给了 3000，出来怎么是 512"。
       然后按设备再收一次：纯 CPU 上 768×768 是十几分钟，缩到设备档（保持比例、8 的倍数）。 */
    let W = Math.round(Number(a.width || t.size?.[0] || 512));
    let H = Math.round(Number(a.height || t.size?.[1] || 512));
    if (!(W >= 64 && W <= 1024 && H >= 64 && H <= 1024)) {
      return { error: `尺寸要在 64~1024 之间（收到 ${W}×${H}）`, code: 'comfy_bad_args' };
    }
    const side = Number(prof?.side || 0);
    if (side && Math.max(W, H) > side) {
      const k = side / Math.max(W, H);
      W = Math.max(64, Math.round(W * k / 8) * 8);
      H = Math.max(64, Math.round(H * k / 8) * 8);
      /* 只有"用户/模板明确要了大尺寸、被这台机器缩了"才需要解释；
         本来就是模板默认尺寸的话，缩了也不用说。 */
      if (a.width || a.height) scaledDown = { from: [Math.round(Number(a.width)), Math.round(Number(a.height))], to: [W, H], why: prof.note || prof.kind };
    }

    /* 步数：调用方说了算 > 设备推荐 > 模板 > 默认。
       模板里的 steps 现在只是"不知道设备时的兜底"，不再是硬编码答案。 */
    const steps = Math.round(Number(a.steps || prof?.steps || t.steps || DEFAULTS.steps));
    if (!(steps >= 1 && steps <= 30)) return { error: `步数要在 1~30 之间（收到 ${steps}）`, code: 'comfy_bad_args' };
    const seed = Number(a.seed) > 0 ? Math.round(Number(a.seed)) : Math.floor(Math.random() * 2 ** 31);

    const graph = fillWorkflow(t.workflow || t._wf, {
      prompt,
      negative: a.negative ?? DEFAULTS.negative,
      width: W, height: H, steps, seed,
      /* `COMFY_MODEL` 是**换环境不改代码**的那个口子：同一份模板，
         指向本机 CPU 版（LCM 权重）和有卡的机器（sd-turbo）时模型名不一样。 */
      model: a.model || process.env.COMFY_MODEL || t.model || DEFAULTS.model,
      sampler: a.sampler || t.sampler || '',
      scheduler: a.scheduler || t.scheduler || '',
      cfg: a.cfg ?? t.cfg ?? null,
      prefix: 'emergent',
    });

    const t0 = Date.now();
    const posted = await postJSON('/prompt', { prompt: graph, client_id: `emergent-${t0}` });
    if (!posted.ok || posted.data?.error) {
      /* ComfyUI 的 400 正文带 node_errors，把它翻成一句能改的话 */
      if (posted.status === 429) return { error: 'ComfyUI 队列满了，等它跑完再说（或者先 /queue 里清掉）', code: 'comfy_queue_full' };
      const ne = posted.data?.node_errors || {};
      const first = Object.entries(ne)[0];
      const detail = first ? `节点 ${first[0]}：${JSON.stringify(first[1]).slice(0, 160)}` : (posted.error || posted.text || '').slice(0, 160);
      return { error: `工作流被拒了（${posted.status || '连接失败'}）。${detail}`, code: 'comfy_bad_graph' };
    }
    const id = posted.data?.prompt_id;
    if (!id) return { error: 'ComfyUI 没给 prompt_id（响应不是它的形状）', code: 'comfy_bad_graph' };

    /* 轮询 /history。**不用 ws**：进度只影响"看不看得见在动"，
       而 ws 会带来重连/半包一整套复杂度；心跳和观察窗已经把"在干活"说清楚了。 */
    let queueAhead;
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL));
      const elapsed = Date.now() - t0;
      const WAIT = waitOf(prof);
      if (elapsed > WAIT) {
        /* 超时**不打断它** —— 图可能还在跑，用户下一句还能看到结果。
           这里只回一句"还没出来"，并给 prompt_id 好让人去 ComfyUI 里看。 */
        return {
          error: `等了 ${Math.round(WAIT / 1000)} 秒还没出来（prompt_id ${id}）。CPU 上出图会慢到几分钟，可以等会儿再问"画好了吗"。`,
          code: 'comfy_timeout', promptId: id, ms: elapsed,
        };
      }
      /* 变量名别叫 `h`：它会把上面的高度遮住，于是返回的 height 变成整个 HTTP
         响应对象 —— 不报错、筛查看不出来，自测里一行断言才发现。 */
      const hist = await getJSON(`/history/${encodeURIComponent(id)}`, { timeout: 6000 });
      const rec = hist.data?.[id];
      if (!rec) {
        if (a.onProgress) a.onProgress({ elapsedMs: elapsed, queueAhead });
        continue;
      }
      const st = rec.status || {};
      if (st.status_str === 'error' || st.completed === false) {
        const msgs = st.messages || [];
        const errMsg = msgs.map((m) => m?.[1]).find((x) => x?.exception_message) || {};
        const oom = /out of memory|OutOfMemory/i.test(String(errMsg.exception_type || errMsg.exception_message || ''));
        return {
          error: oom
            ? `出图时内存/显存不够（${String(errMsg.exception_message || '').slice(0, 120)}）。把尺寸调到 512×512、步数降到 4~8 再试。`
            : `出图失败了：${String(errMsg.exception_type || '')} ${String(errMsg.exception_message || '').slice(0, 160)}`.trim(),
          code: oom ? 'comfy_oom' : 'comfy_failed',
          promptId: id,
        };
      }
      const imgs = rec.outputs?.[Object.keys(rec.outputs || {})[0]]?.images || [];
      const img = imgs.find((x) => x.type === 'output' || x.type === 'temp') || imgs[0];
      if (!img) return { error: '跑完了，但输出里没有图（SaveImage 可能被删了）', code: 'comfy_no_image', promptId: id };
      return {
        ok: true,
        promptId: id,
        ms: Date.now() - t0,
        template: t.id,
        prompt,
        seed,
        width: W,
        height: H,
        steps,
        device: prof ? { kind: prof.kind, name: prof.device, etaSec: prof.etaSec } : null,
        /* 被设备档缩过尺寸要说出来 —— 否则"我要 768 出来怎么是 512" 只能靠猜 */
        adjusted: scaledDown,
        image: { filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' },
      };
    }
  }

  /** 取图字节（给 /api/comfy/img 代理用）。只允许 output/temp，不允许绝对路径。 */
  async function imageBytes({ filename, subfolder = '', type = 'output' } = {}) {
    const fn = String(filename || '');
    if (!/^[\w.\- ]+\.(png|jpg|jpeg|webp)$/i.test(fn)) return { error: '文件名不合法', code: 'comfy_bad_args' };
    if (String(subfolder).includes('..') || String(subfolder).startsWith('/')) return { error: '子目录不合法', code: 'comfy_bad_args' };
    if (!['output', 'temp'].includes(String(type))) return { error: '只允许 output / temp 里的图', code: 'comfy_bad_args' };
    const q = new URLSearchParams({ filename: fn, subfolder: String(subfolder), type: String(type) });
    try {
      const r = await fetch(`${baseOf()}/view?${q}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return { error: `取图失败（HTTP ${r.status}）`, code: 'comfy_failed' };
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, buf, type: r.headers.get('content-type') || 'image/png' };
    } catch (e) {
      return { error: `取图失败：${e?.message || e}`, code: 'comfy_offline' };
    }
  }

  /** 打断当前这张（用户说"算了"时）。 */
  async function interrupt() {
    const r = await postJSON('/interrupt', {}, { timeout: 6000 });
    return r.ok ? { ok: true } : { error: `打断失败：${r.error || r.status}`, code: 'comfy_failed' };
  }

  return { status, gen, imageBytes, interrupt, templates, base: baseOf, ERR_ZH };
}
