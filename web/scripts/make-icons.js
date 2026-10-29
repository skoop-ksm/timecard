// Generates public/icon-{180,192,512}.png (a clock on a green tile) with no
// dependencies: iOS home-screen icons must be PNG, so the SVG alone is not enough.
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, shade) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = shade(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GREEN = [0x2a, 0x9d, 0x5c];
const WHITE = [255, 255, 255];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Coverage of the white clock glyph at a pixel, 4x4 supersampled.
function glyphCoverage(px, py, size) {
  const cx = size / 2, cy = size / 2;
  const rOuter = size * 0.30, rInner = size * 0.225;
  const hand = size * 0.04;
  let hits = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const x = px + (i + 0.5) / 4 - cx, y = py + (j + 0.5) / 4 - cy;
    const d = Math.hypot(x, y);
    const ring = d <= rOuter && d >= rInner;
    const minute = Math.abs(x) <= hand && y <= 0 && y >= -size * 0.20;          // 12 o'clock
    const hx = x - 0, hy = y - 0;
    const ang = Math.atan2(hy, hx), hourLen = size * 0.14;                        // 4 o'clock-ish
    const target = Math.PI / 5;
    const along = hx * Math.cos(target) + hy * Math.sin(target);
    const across = Math.abs(-hx * Math.sin(target) + hy * Math.cos(target));
    const hour = along >= 0 && along <= hourLen && across <= hand;
    const dot = d <= hand * 1.2;
    if (ring || minute || hour || dot) hits++;
    void ang;
  }
  return hits / 16;
}

const shade = (x, y, size) => mix(GREEN, WHITE, glyphCoverage(x, y, size));

for (const size of [180, 192, 512]) {
  const file = path.join(out, `icon-${size}.png`);
  await fs.writeFile(file, png(size, shade));
  console.log('wrote', path.relative(process.cwd(), file));
}
