/**
 * 文档抽取的自测。**夹具是现造的**（zip / pdf 都用 zlib 手写），
 * 理由和 apps.test.mjs 一样：真文档会随版本变，而这里要钉住的是**我们的解析器**
 * 在遇到某种字节形状时的行为。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createFs } from './sources/fs.mjs';
import { createDocs, readZip, pdfText, docxText, xlsxSheet } from './docs.mjs';

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed += 1; };

/* ── 手写 zip（store，不压缩） ── */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function zip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nm = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nm.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(off, 42);
    locals.push(lh, nm, data);
    central.push(cd, nm);
    off += 30 + nm.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/* ── 手写 pdf（一段 FlateDecode 内容流） ── */
function pdf(body, { flate = true } = {}) {
  const content = flate ? zlib.deflateSync(Buffer.from(body, 'latin1')) : Buffer.from(body, 'latin1');
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page /Length ${content.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
    'latin1',
  );
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  return Buffer.concat([head, content, tail]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
const home = path.join(tmp, 'Home');
fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
const fsmod = createFs({ root: tmp, pvc: null });
await fsmod.info;
/* createFs 自己去发现 PVC，这里直接用真实路径写文件更省事 */
/* 返回的是**给 fs 用的路径**（`~/Documents/x.docx`），不是磁盘绝对路径：
   fs 层的 `inner()` 只认 `~` / 相对 / 以 `/` 开头的绝对路径，Windows 盘符路径
   会被当成"裸名字"去 Home 下找（生产是 Linux，不会遇到；自测必须走同一条入口）。 */
const put = (name, buf) => {
  fs.writeFileSync(path.join(home, 'Documents', name), buf);
  return '~/Documents/' + name;
};

console.log('① zip：中央目录能读回来');
{
  const z = zip({ 'a/b.txt': 'hello', 'c.xml': '<x>1</x>' });
  const r = readZip(z);
  ok(r.names.length === 2 && r.has('a/b.txt'), `名字对（${r.names.join(',')}）`);
  ok(r.get('a/b.txt').toString() === 'hello', '内容对');
}

console.log('\n② docx：段落分得开，制表符和换行不丢');
{
  const xml = '<w:document><w:body>'
    + '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>甲</w:t></w:r><w:r><w:tab/><w:t>乙</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>第三段</w:t></w:r></w:p></w:body></w:document>';
  const t = docxText(xml);
  ok(t.split('\n').length === 3, `三段落（实际 ${JSON.stringify(t)}）`);
  ok(t.includes('甲\t乙'), '制表符保留');
  const f = put('合同.docx', zip({ 'word/document.xml': xml }));
  const r = await fsmod.bytes(f);
  ok(r.size > 0, 'fs.bytes 能取原始字节（docx 不是文本，用 read 会被拒）');
  const d = createDocs({ fs: fsmod });
  const out = await d.extract(f);
  ok(out.ok && out.kind === 'docx' && out.text.includes('第三段'), `抽出来了（${out.chars} 字）`);
}

console.log('\n③ xlsx：共享字符串 + 数字，一行一条');
{
  const shared = '<sst><si><t>项目</t></si><si><t>金额</t></si></sst>';
  const sheet = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>1234.5</v></c></row>'
    + '<row r="3"><c r="A3" t="inlineStr"><is><t>现金</t></is></c></row>'
    + '</sheetData></worksheet>';
  const f = put('账.xlsx', zip({
    'xl/sharedStrings.xml': shared,
    'xl/worksheets/sheet1.xml': sheet,
  }));
  const d = createDocs({ fs: fsmod });
  const out = await d.extract(f);
  /* 第一行是 `# 表 1`（多工作表时必须有分隔，否则两张表会连成一张） */
  const lines = (out.text || '').split('\n').filter((l) => !l.startsWith('# '));
  ok(out.ok && out.kind === 'xlsx', '认出来了');
  ok(lines[0] === '项目\t金额', `表头（${JSON.stringify(lines[0])}）`);
  ok(lines[1] === '项目\t1234.5', `数字不被当字符串（${JSON.stringify(lines[1])}）`);
  ok(lines[2] === '现金', 'inlineStr 也认');
}

console.log('\n④ pptx：一页一个分隔，页序对');
{
  const f = put('讲义.pptx', zip({
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>开场</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>第二部分</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:sld>',
  }));
  const d = createDocs({ fs: fsmod });
  const out = await d.extract(f);
  ok(out.ok, '抽出来了');
  ok(/第 1 页[\s\S]*开场[\s\S]*第 2 页[\s\S]*第二部分/.test(out.text), '页序按数字不是按字符串');
  ok(out.text.indexOf('第十页') > out.text.indexOf('第二部分'), 'slide10 排最后（不是排在 slide2 前）');
}

console.log('\n⑤ pdf：FlateDecode 的内容流能取到字');
{
  const f = put('说明.pdf', pdf('BT /F1 12 Tf 72 700 Td (Hello PDF 2026) Tj ET'));
  const d = createDocs({ fs: fsmod });
  const out = await d.extract(f);
  ok(out.ok && out.kind === 'pdf', '认出来了');
  ok(/Hello PDF 2026/.test(out.text || ''), `字对（${JSON.stringify(out.text)}）`);
}

console.log('\n⑥ pdf：CID/十六进制取不出字 → 不返回乱码，指路去看图');
{
  const f = put('扫描.pdf', pdf('BT <00480065006C006C006F> Tj ET'));
  const d = createDocs({ fs: fsmod });
  const out = await d.extract(f);
  ok(out.ok === false, `没假装成功（${out.error}）`);
  ok(/看|图/.test(out.suggest || ''), `给了下一步（${out.suggest}）`);
}

console.log('\n⑦ 老版 Office 与认不出的二进制：如实拒绝');
{
  const d = createDocs({ fs: fsmod });
  const old = put('旧文档.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2]));
  const r1 = await d.extract(old);
  ok(!r1.ok && /另存为/.test(r1.suggest || ''), `doc 让用户另存（${r1.error}）`);
  const junk = put('x.bin', Buffer.from([0, 1, 2, 3, 4]));
  const r2 = await d.extract(junk);
  ok(!r2.ok, `不认识就说不知道（${r2.error}）`);
}

console.log('\n⑧ 文本类：html 剥标签，长文截断有交代');
{
  const f = put('页.html', '<html><style>p{color:red}</style><body><p>你好</p><p>世界</p></body></html>');
  const d = createDocs({ fs: fsmod });
  const out = await d.extract(f);
  ok(!/color:red/.test(out.text || ''), 'style 里的东西不会混进正文');
  ok(/你好/.test(out.text) && /世界/.test(out.text), '正文在');
  const long = put('长.md', 'a'.repeat(500));
  const cut = await createDocs({ fs: fsmod, limit: 100 }).extract(long);
  ok(cut.truncated && cut.chars === 500, `截断说清楚（${cut.note}）`);
}

console.log('\n⑨ 越界：不能读用户空间以外的文件');
{
  const d = createDocs({ fs: fsmod });
  const r = await d.extract('/etc/passwd');
  ok(!r.ok, `拒了（${r.error}）`);
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
