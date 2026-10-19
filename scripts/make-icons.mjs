// Renders the PNG app icons (same shapes as icons/icon.svg). No dependencies.
// Usage: node scripts/make-icons.mjs

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0xee, 0xee, 0xea];
const FG = [0x05, 0x05, 0x05];

// Shapes in a 512x512 space: [x, y, w, h, radius]
const SHAPES = [
  [70, 204, 372, 22, 0],
  [86, 204, 160, 124, 46],
  [266, 204, 160, 124, 46],
];

function inside(px, py) {
  return SHAPES.some(([x, y, w, h, r]) => {
    if (px < x || py < y || px > x + w || py > y + h) return false;
    const cx = Math.min(Math.max(px, x + r), x + w - r);
    const cy = Math.min(Math.max(py, y + r), y + h - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  });
}

function render(size) {
  const SS = 4; // supersampling for smooth edges
  const scale = 512 / size;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inside((x + (sx + 0.5) / SS) * scale, (y + (sy + 0.5) / SS) * scale)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const o = row + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
      raw[o + 3] = 255;
    }
  }
  return png(size, size, raw);
}

function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), render(size));
  console.log(`icons/icon-${size}.png`);
}
