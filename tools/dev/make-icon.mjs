/**
 * 生成应用图标 dist/icon.png（256×256），零依赖。
 *
 * 为什么自己画而不是找一张图：这个项目的身份就是"点阵 + 贴底边的一道缝"，
 * 用官方截图缩到 48px 会糊成一块（踩过：满幅插画降采样 = 实心方块）。
 * 所以按题材重画字形 —— 稀疏点阵组成一个开口的环，底边一道细光缝。
 *
 * 输出：RGBA、无压缩滤镜、zlib 标准压缩。PNG 格式本身不复杂：
 * 签名 + IHDR + IDAT + IEND，每块带 CRC32。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const S = 256;
const px = Buffer.alloc(S * S * 4);   // RGBA

/** 加色叠一个点（预乘在最后统一做：icon 是不透明的，直接混到黑底上） */
function dot(cx, cy, r, a, tint = [255, 255, 255]) {
  const x0 = Math.max(0, Math.floor(cx - r - 2));
  const x1 = Math.min(S - 1, Math.ceil(cx + r + 2));
  const y0 = Math.max(0, Math.floor(cy - r - 2));
  const y1 = Math.min(S - 1, Math.ceil(cy + r + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      /* 芯 + 一圈柔光：硬边点在 48px 会闪，需要一点过渡 */
      const core = Math.max(0, 1 - d / r);
      const glow = Math.max(0, 1 - d / (r * 2.4)) * 0.35;
      const k = (core * core + glow) * a;
      if (k <= 0) continue;
      const i = (y * S + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, px[i + c] + tint[c] * k);
      px[i + 3] = 255;
    }
  }
}

/* ── 底：近黑，中心略亮（避免整片死黑，但也别抢点） ── */
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const d = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
    const v = 6 + Math.max(0, 1 - d) * 9;
    px[i] = v * 0.9; px[i + 1] = v; px[i + 2] = v * 1.15; px[i + 3] = 255;
  }
}

/* ── 环：开口在右下方（"出口"），点径随机，密度按角度不均 ── */
const CX = S / 2, CY = S / 2 - 4, R = 74;
const N = 132;
for (let i = 0; i < N; i++) {
  const t = i / N;
  const a = t * Math.PI * 2 - Math.PI / 2;
  /* 右下 40° 留空 */
  const deg = ((a * 180) / Math.PI + 360) % 360;
  if (deg > 20 && deg < 62) continue;
  const wob = Math.sin(t * 22) * 2.1 + Math.sin(t * 7.3) * 3.4;
  const r = R + wob;
  const x = CX + Math.cos(a) * r;
  const y = CY + Math.sin(a) * r;
  const jitter = (Math.sin(i * 12.9898) * 43758.5453) % 1;
  dot(x + jitter * 1.6, y - jitter * 1.2, 1.9 + Math.abs(jitter) * 1.5, 0.5 + Math.abs(jitter) * 0.45);
}

/* ── 环内的芯：九颗更亮的点，构成"还在形成中的秩序" ── */
const INNER = [
  [0, -16], [13, -8], [15, 9], [4, 18], [-11, 15], [-17, 2], [-9, -13], [2, -4], [-3, 6],
];
for (const [dx, dy] of INNER) dot(CX + dx, CY + dy, 3.4, 0.95);

/* ── 底边光缝：贴底 6px 的一道横光，两端渐隐 ── */
for (let x = 0; x < S; x++) {
  const edge = Math.min(x, S - 1 - x) / (S * 0.28);
  const k = Math.max(0, Math.min(1, edge));
  for (let y = S - 14; y < S - 4; y++) {
    const dy = Math.abs(y - (S - 9));
    const v = Math.max(0, 1 - dy / 4) * k * 0.55;
    if (v <= 0) continue;
    const i = (y * S + x) * 4;
    px[i] = Math.min(255, px[i] + 120 * v);
    px[i + 1] = Math.min(255, px[i + 1] + 200 * v);
    px[i + 2] = Math.min(255, px[i + 2] + 190 * v);
  }
}

/* ── PNG 封装 ── */
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;   // filter type 0（None）
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
  return Buffer.concat([len, body, crc]);
}

/* node 的 zlib 在部分版本没有 crc32，自己算一份（多项式 0xEDB88320） */
let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(import.meta.dirname || '.', '..', '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`${out}  ${S}×${S}  ${(png.length / 1024).toFixed(1)} KB`);
