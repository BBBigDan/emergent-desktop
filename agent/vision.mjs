/**
 * 「这个模型看不看得见图」—— **先查资料，只在资料管不到时才观测**。
 *
 * 这一条被用户纠正过：能不能看图是**模型的公开规格**（模型卡上写着原生多模态
 * 就是能看，纯文本模型就是不能看），不需要现场做实验去试。所以：
 *
 *   ① 平台的模型：写在 `models.mjs` 那张表里，`visionSrc` 记出处。这里不碰。
 *   ② 本地模型：Ollama 的 `/api/show` 自己报 `capabilities`（模型自己声明）。
 *   ③ 自定义网关：公开资料管不到别人家的中转站 → 只有这一种情况才"不知道"，
 *      而"不知道"的做法是**照发**（真发一次本来就是这一轮要做的事），
 *      接口不收图会在协议层撞出来，那时把结论记在这里。
 *
 * 所以这个模块实际管两件事：
 *   · **台账**：谁在什么时候被观测到"看不见"，为什么（`config/vision.json`，7 天过期）；
 *   · **等外品**：`probeOnce` 只服务一个显式动作（`POST /api/models/vision`）——
 *     当你怀疑"公开说能看、但这个网关其实把图丢了"时，手动核对一次。
 *     **绝不在正常对话里自动发**：那是拿真钱去问一个查得到的问题。
 *
 * 判断的三种结局里，第三种（不知道）仍然是必须存在的：一个模型能看，
 * 不代表某个网关愿意转图。
 */


import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TTL = 7 * 24 * 3600_000;

/* ─────────────────────── 一张确定无疑的测试图 ───────────────────────
 *
 * 8×8 纯红。它必须小到免费额度也扛得住（一次探测 ≈ 几十 token），
 * 又必须"答案唯一"—— 红就是红，不会因为压缩损失变成橙。
 * 用 zlib 现编，不引第三方库：这里只是一张 8×8 的 RGBA 扫描线。
 */
export function redPNG(size = 8) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // truecolor RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const off = y * (1 + size * 3);
    raw[off] = 0;                        // filter none
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = 220;        // R
      raw[off + 2 + x * 3] = 30;         // G
      raw[off + 3 + x * 3] = 30;         // B
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const COLOR_WORDS = /(红|red|crimson|scarlet)/i;
/* 模型"看不见"时会说的话。它 200、正常回答，只是答的是"我看不到图片"。 */
const BLIND_WORDS = /(无法(查看|看到|识别|读取).{0,6}(图|照片)|看不到(图片|图像)|cannot (see|view|process).{0,12}(image|picture)|no image|图片(缺失|未提供|没有))/i;
const BLIND_400 = /(image|vision|multimodal|content[\s_-]?type|不支持.{0,6}图)/i;

/**
 * 探一次。**不改任何状态**，纯函数式地返回判断。
 * @returns {Promise<{vision:true|false|null, why:string, ms:number}>}
 */
export async function probeOnce({ model, baseURL, apiKey, fetchImpl = fetch, timeout = 25_000 } = {}) {
  const t0 = Date.now();
  if (!apiKey) return { vision: null, why: '没有 key，探不了', ms: 0 };
  const png = redPNG(8);
  const body = {
    model,
    temperature: 0,
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图片是什么颜色？只回答颜色名，两个字以内。' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } },
      ],
    }],
  };
  let res;
  try {
    res = await fetchImpl(`${String(baseURL).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    /* 超时/连不上：**不知道**。别记成"看不见"——那会把一个能用的模型永久锁掉。 */
    return { vision: null, why: `探不通（${e?.message || e}）`, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    if (res.status === 400 && BLIND_400.test(raw)) {
      return { vision: false, why: `接口不收图片（400）`, ms };
    }
    return { vision: null, why: `接口 ${res.status}，没探出结论`, ms };
  }
  let text = '';
  try {
    const j = JSON.parse(raw);
    text = String(j?.choices?.[0]?.message?.content || '');
  } catch { return { vision: null, why: '回了不是 JSON 的东西', ms }; }
  if (COLOR_WORDS.test(text)) return { vision: true, why: '认出了颜色', ms };
  if (BLIND_WORDS.test(text)) return { vision: false, why: '图被静默丢掉，它自己说看不见', ms };
  /* 200、回话了、但答的不是颜色 —— 这种最危险：可能是图被降采样糊了，也可能它在敷衍。
     不算数。 */
  return { vision: null, why: `答非所问（"${text.slice(0, 20)}"）`, ms };
}

/**
 * 把消息里的图换成一句文字。
 *
 * 只有一个用途：接口明确说不收图时，**别让整轮对话断掉**。
 * 换掉而不是删掉那条消息 —— 消息的条数和顺序是协议（tool_calls 与 tool 结果
 * 必须一一对应），删一条会让后面所有 tool_call_id 对不上。
 */
export function stripImages(messages, note = '（这里本来有一张图，但当前接口不收图片）') {
  let n = 0;
  const out = (messages || []).map((m) => {
    if (!Array.isArray(m.content)) return m;
    const imgs = m.content.filter((p) => p?.type === 'image_url');
    if (!imgs.length) return m;
    n += imgs.length;
    const text = m.content
      .filter((p) => p?.type !== 'image_url')
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('\n')
      .trim();
    return { ...m, content: (text ? text + '\n' : '') + note };
  });
  return { messages: out, count: n };
}

/**
 * 观测台账。缓存键**必须带上 baseURL**：同一个 id 在平台和自建网关上
 * 可能是两个东西（一个收图、一个不收），只按 id 记会互相污染。
 *
 * `known()` 是**正常路径**（不联网）；`check()` 只有显式核对时才用。
 */
export function createVision(o = {}) {
  const file = o.file || '';
  const fetchImpl = o.fetchImpl || fetch;
  const log = o.warn || (() => {});
  let table = {};
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      table = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
    } catch { table = {}; }
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(table, null, 1));
    } catch (e) { log('[vision] 存不下来：' + e.message); }
  }

  const keyOf = (model, baseURL) => `${baseURL || ''}|${model || ''}`;

  /** 已有的判断（不联网）。`fresh:false` 表示过期了，仅供界面上先说一句。 */
  function known(model, baseURL) {
    load();
    const hit = table[keyOf(model, baseURL)];
    if (!hit) return { vision: null, at: null, fresh: false, why: '还没测过' };
    return { ...hit, fresh: Date.now() - (hit.at || 0) < TTL };
  }

  /** 探并记住。`force` = 不管缓存。并发同一个模型只探一次。 */
  const flying = new Map();
  async function check({ model, baseURL, apiKey, force = false } = {}) {
    load();
    const k = keyOf(model, baseURL);
    const hit = table[k];
    if (!force && hit && Date.now() - (hit.at || 0) < TTL) return { ...hit, cached: true };
    if (flying.has(k)) return flying.get(k);
    const p = probeOnce({ model, baseURL, apiKey, fetchImpl })
      .then((r) => {
        /* 不知道也记，但记的是"不知道"：界面因此能说"上次测没测出来"，
           而不是每次打开面板都重新探一遍（那会烧钱）。 */
        table[k] = { ...r, at: Date.now(), model, baseURL };
        save();
        flying.delete(k);
        return { ...table[k], cached: false };
      })
      .catch((e) => { flying.delete(k); return { vision: null, why: e.message, ms: 0, cached: false }; });
    flying.set(k, p);
    return p;
  }

  /**
   * 直接把结论写下来 —— 给"发请求时撞出来的事实"用。
   *
   * `probeOnce` 是一次**主动**的探测；而更常见的证据是：我们真发了一张图，
   * 接口 400 / 或者它回"我看不到这张图"。那是最硬的证据，比探测还硬
   * （探测可能因为余额不足而失败，而真请求是业务路径）。所以留这个口子，
   * 让上层把撞到的事实记进来，下一次 `fs_view` 就能提前说清楚。
   */
  function mark(model, baseURL, { vision: v, why = '', ms = 0 } = {}) {
    load();
    const k = keyOf(model, baseURL);
    table[k] = { vision: v, why, ms, at: Date.now(), model, baseURL };
    save();
    return table[k];
  }

  return { known, check, mark, _path: () => file, _reset() { table = {}; loaded = true; } };
}
