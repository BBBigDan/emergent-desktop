/**
 * 把文档读成字 —— 不引依赖。
 *
 * 为什么是"抽文本"而不是"让模型看图"：
 *   · 一份 20 页 PDF 渲染成图，是 20 张图、几万 token，而且模型要**逐张**看；
 *   · 而它要回答的问题（"这份合同违约金多少"）只需要其中的字。
 *   所以两件事分开：**能拿字的先拿字**（这里），拿不到字（扫描件、纯图）
 *   才轮到 `fs_view` 去看图。反过来做的话，每份文档都要付一遍视觉的价钱。
 *
 * 零依赖的代价写清在这里，免得以后有人以为这里漏了库：
 *   · zip：自己解析中央目录 + `zlib.inflateRawSync`（docx/xlsx/pptx 都是 zip）；
 *   · pdf：扫 `stream…endstream`，FlateDecode 解压后按文本算子取字符串。
 *     这**不是**完整的 PDF 解释器：字体子集、Identity-H 编码的 CID 文本
 *     会取不出来（中文 PDF 常见）。取不出来时如实说"抽不到字，建议看图"，
 *     不返回半篇乱码 —— 乱码比空更坏，模型会把它当成正文引用。
 *
 * 一条纪律：**不编**。抽到多少说多少，`note` 里写清为什么少。
 */

import zlib from 'node:zlib';

const LIMIT_DEFAULT = 80_000;   // 一份文档最多回这么多字（约 50k token 的中文）

const dec = (buf) => buf.toString('utf8');

/* ─────────────────────────── zip ─────────────────────────── */

/** 解 zip：只做"取出某个名字的字节"这一件事。加密、分卷、zip64 一律如实报错。 */
export function readZip(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = dec(buf.subarray(p + 46, p + 46 + nameLen));
    files.set(name, { method, csize, lho });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return {
    names: [...files.keys()],
    has: (n) => files.has(n),
    get(n) {
      const f = files.get(n);
      if (!f) return null;
      if (f.method !== 0 && f.method !== 8) throw new Error(`zip 压缩方式 ${f.method} 不支持`);
      /* 本地头的长度可能和中央目录不同（extra 字段会被改）—— 必须以本地头为准 */
      const lnameLen = buf.readUInt16LE(f.lho + 26);
      const lextraLen = buf.readUInt16LE(f.lho + 28);
      const start = f.lho + 30 + lnameLen + lextraLen;
      const raw = buf.subarray(start, start + f.csize);
      return f.method === 0 ? raw : zlib.inflateRawSync(raw);
    },
  };
}

/* ─────────────────────── xml → 段落 ─────────────────────── */

const unent = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

/** docx：`<w:p>` 是一段，`<w:t>` 是字。`<w:tab/>` 是制表符，`<w:br/>` 是换行。 */
export function docxText(xml) {
  const out = [];
  for (const m of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)) {
    const seg = m[0];
    let line = '';
    for (const t of seg.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      if (t[1] != null) line += unent(t[1]);
      else if (t[0].startsWith('<w:tab')) line += '\t';
      else line += '\n';
    }
    if (line.trim()) out.push(line);
  }
  return out.join('\n');
}

/** pptx：一页一个文件。页与页之间必须有分隔，否则"第 3 页说了什么"无从回答。 */
export function pptxText(xml) {
  const out = [];
  for (const m of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
    let line = '';
    for (const t of m[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) line += unent(t[1]);
    if (line.trim()) out.push(line);
  }
  return out.join('\n');
}

/** xlsx：单元格 → 行（制表符分隔）。公式取 `<f>` 里的原文，值取 `<v>`。 */
export function xlsxSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
    const cells = [];
    for (const cm of rm[0].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = cm[1] || '';
      const body = cm[2] || '';
      const t = /t="([^"]+)"/.exec(attr)?.[1] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const isText = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
      if (isText != null) cells.push(unent(isText));
      else if (t === 's' && v != null) cells.push(shared[Number(v)] ?? '');
      else if (t === 'inlineStr') cells.push('');
      else if (v != null) cells.push(unent(v));
      else cells.push('');
    }
    /* 整行空就不占位：xlsx 的空行能有一万行 */
    if (cells.some((c) => String(c).trim())) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

/* ─────────────────────────── pdf ─────────────────────────── */

const pdfUnescape = (s) => s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => {
  switch (e) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'b': return '\b';
    case 'f': return '\f';
    case '(': return '(';
    case ')': return ')';
    case '\\': return '\\';
    default: return String.fromCharCode(parseInt(e, 8));
  }
});

/** 一段内容流里的字。`Tj` 出一段，`TJ` 出一行里带字距的几段，`'`/`"` 是换行。 */
export function pdfStreamText(content) {
  const out = [];
  const re = /\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)\s*(Tj|TJ|'|")|\[((?:\((?:\\.|[^\\()])*\)|[^\]])*)\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj|(T\*|TD|Td|ET)/g;
  let m;
  let line = '';
  while ((m = re.exec(content))) {
    if (m[1]) {
      const s = /^\(([\s\S]*)\)\s/.exec(m[0])?.[1] ?? '';
      line += pdfUnescape(s);
    } else if (m[2] != null) {
      for (const p of m[2].matchAll(/\(((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*)\)/g)) line += pdfUnescape(p[1]);
    } else if (m[3] != null) {
      /* <00480065> 这种是十六进制 CID —— 没有 ToUnicode 表就解不出字。
         这里**不解**，只留一个标记；调用方据此判断"抽不到字"。 */
      line += '\uFFFD';
    } else if (m[4]) {
      if (line) { out.push(line); line = ''; }
    }
  }
  if (line) out.push(line);
  return out.join('\n');
}

/** 把 PDF 里所有能解压的流找出来。不追对象树 —— 页序不影响"读内容"。 */
export function pdfText(buf) {
  const s = buf.toString('latin1');
  const chunks = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const head = s.slice(Math.max(0, m.index - 900), m.index);
    const raw = buf.subarray(start, end);
    let data = raw;
    if (/FlateDecode/.test(head)) {
      try { data = zlib.inflateSync(raw); } catch { continue; }
    } else if (/DCTDecode|JPXDecode|CCITTFaxDecode/.test(head)) {
      continue;   // 图，不是字
    }
    const txt = data.toString('latin1');
    /* 只解"看起来像内容流"的：有 BT/ET 或文本算子。字体文件里也有 stream，
       全解开再正则匹配是浪费（而且会撞出乱七八糟的东西）。 */
    if (!/(BT|Tj|TJ)\b/.test(txt)) continue;
    const t = pdfStreamText(txt);
    if (t.trim()) chunks.push(t);
  }
  return chunks.join('\n\n');
}

/* ─────────────────────────── 对外 ─────────────────────────── */

/**
 * 看一眼字节就能说出"这是什么图、多大"。不解码像素，只读文件头。
 *
 * 为什么需要尺寸：屏幕上那个图片框要按真实比例摆（`imagepanel` 拿 width/height
 * 算最大缩放），而链路里没有任何地方会去解码图片。PNG 的 IHDR、JPEG 的 SOF、
 * GIF 的逻辑屏、WEBP 的 VP8/VP8L 头里有这些数，读 30 个字节就够。
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 16) return null;
  /* PNG：\x89PNG\r\n\x1a\n + IHDR */
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
      && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  /* JPEG：逐段找 SOF0/2（C0~CF，去掉 C4 C8 CC） */
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { mime: 'image/jpeg', width: 0, height: 0 };
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', width: 0, height: 0 };
  }
  return null;
}

const textLike = /\.(txt|md|markdown|log|json|ya?ml|csv|tsv|ini|conf|xml|html?|js|mjs|ts|py|sh|sql)$/i;
const HTML_TAGS = /<(script|style)[\s\S]*?<\/\1>|<[^>]+>/gi;

/**
 * 抽文本。返回 `{ok, kind, text, chars, note}`；抽不到字时 `ok:false` 且
 * `suggest` 说下一步该怎么办（有 `fs_view` 就用它 —— 扫描件只能看图）。
 */
export function createDocs(o = {}) {
  const fsmod = o.fs;
  const limitDefault = o.limit || LIMIT_DEFAULT;

  async function extract(p, { limit = limitDefault } = {}) {
    if (!fsmod) return { ok: false, error: '文件系统没接' };
    const r = await fsmod.bytes(p, { maxBytes: 64 * 1024 * 1024 }).catch((e) => ({ error: String(e.message || e) }));
    if (r.error) return { ok: false, error: r.error, path: r.path };
    const ext = (p.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
    const buf = r.buf;

    const finish = (kind, text, note = '') => {
      const t = String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!t) {
        return {
          ok: false, kind, path: r.path, sizeText: r.sizeText, chars: 0,
          error: '这份文档里抽不到文字',
          suggest: '它是图片或扫描件。要读内容只能看图 —— 用 fs_view 把某一页交给模型看',
        };
      }
      const cut = t.length > limit;
      return {
        ok: true, kind, path: r.path, sizeText: r.sizeText,
        chars: t.length, truncated: cut,
        text: cut ? t.slice(0, limit) : t,
        note: cut ? `只回了前 ${limit} 字（全文 ${t.length} 字）` : note,
      };
    };

    try {
      if (ext === '.pdf') {
        const text = pdfText(buf);
        const bad = (text.match(/\uFFFD/g) || []).length;
        const note = bad > text.length * 0.3
          ? '这份 PDF 的中文是字形索引编码，取不出可读的字（需要字体映射表，没做）'
          : '';
        if (bad > text.length * 0.3 && text.replace(/\uFFFD/g, '').trim().length < 40) {
          return {
            ok: false, kind: 'pdf', path: r.path, sizeText: r.sizeText,
            error: '抽不出可读文字（CID 编码或扫描件）',
            suggest: '用 fs_view 让模型直接看那几页',
          };
        }
        /* 页数：`/Type /Page` 出现几次（含 Pages 不算） */
        const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length || null;
        return finish('pdf', text, [note, pages ? `约 ${pages} 页` : ''].filter(Boolean).join('；'));
      }

      if (ext === '.docx') {
        const z = readZip(buf);
        const xml = dec(z.get('word/document.xml') || Buffer.alloc(0));
        return finish('docx', docxText(xml));
      }

      if (ext === '.xlsx' || ext === '.xlsm') {
        const z = readZip(buf);
        const shared = [];
        const ss = z.get('xl/sharedStrings.xml');
        if (ss) {
          for (const m of dec(ss).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
            let s = '';
            for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unent(t[1]);
            shared.push(s);
          }
        }
        const sheets = z.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
        const parts = sheets.slice(0, 8).map((n, i) => `# 表 ${i + 1}\n${xlsxSheet(dec(z.get(n)), shared)}`);
        return finish('xlsx', parts.join('\n\n'), sheets.length > 8 ? `只读了前 8 个工作表（共 ${sheets.length}）` : '');
      }

      if (ext === '.pptx') {
        const z = readZip(buf);
        const slides = z.names
          .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
        const parts = slides.map((n, i) => `# 第 ${i + 1} 页\n${pptxText(dec(z.get(n)))}`);
        return finish('pptx', parts.join('\n\n'));
      }

      if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
        return {
          ok: false, kind: ext.slice(1), path: r.path,
          error: '这是老版 Office 二进制格式（97-2003），不是 zip，没有解析器',
          suggest: '让用户用 WPS/Office 另存为 .docx/.xlsx/.pptx 再读',
        };
      }

      if (textLike.test(ext) || ext === '') {
        if (buf.subarray(0, 4096).includes(0)) {
          return { ok: false, path: r.path, error: '二进制文件，不是文本' };
        }
        let text = dec(buf);
        if (/^\.html?$/i.test(ext)) text = text.replace(HTML_TAGS, ' ').replace(/\n{3,}/g, '\n\n');
        return finish(ext.replace('.', '') || 'text', text);
      }

      /* 认不出扩展名：试一次 zip（很多 .docx 被改名成别的），再试文本。 */
      try {
        const z = readZip(buf);
        if (z.has('word/document.xml')) return finish('docx', docxText(dec(z.get('word/document.xml'))));
      } catch { /* 不是 zip */ }
      if (!buf.subarray(0, 4096).includes(0)) return finish('text', dec(buf));
      return {
        ok: false, path: r.path, sizeText: r.sizeText,
        error: `不认识的格式（${ext || '无扩展名'}）`,
        suggest: '如果是图片就 fs_view，是文档就 fs_read 看看前几个字节',
      };
    } catch (e) {
      return { ok: false, path: r.path, error: String(e.message || e) };
    }
  }

  return { extract };
}
