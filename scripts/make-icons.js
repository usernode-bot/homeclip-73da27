/* Renders the app's icons from the TV mark (the one in index.html's
 * favicon: a dark bezel, an amber screen and a small stand) with Node
 * built-ins only - no image library. Committed PNGs are what ships;
 * rerun this after changing the mark:
 *
 *   node scripts/make-icons.js
 *
 * Sizes: 192 and 512 for the manifest's "any" icons, a maskable 512 with
 * the mark pulled into the safe zone over a full-bleed ground, drawn at
 * 4x and box-downsampled so the rounded corners stay smooth.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COLORS = {
  ground: [250, 250, 249], // warm white page ground
  ink: [24, 21, 18],       // the bezel and stand
  amber: [251, 191, 36],   // the screen
};

// The mark's geometry, in its own 100x100 viewBox (see index.html).
const MARK = {
  bezel: { x: 8, y: 14, w: 84, h: 60, r: 10 },
  screen: { x: 16, y: 22, w: 68, h: 44, r: 6 },
  stand: { x: 40, y: 80, w: 20, h: 8, r: 3 },
};

function insideRect(px, py, r, s, ox, oy) {
  const x = (px - ox) / s;
  const y = (py - oy) / s;
  if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) return false;
  const cx = Math.max(r.x + r.r, Math.min(x, r.x + r.w - r.r));
  const cy = Math.max(r.y + r.r, Math.min(y, r.y + r.h - r.r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r.r * r.r || (x >= r.x + r.r && x < r.x + r.w - r.r) ||
    (y >= r.y + r.r && y < r.y + r.h - r.r);
}

// Draws the mark over `bg` at `size`, mark width = markScale of the canvas.
function draw(size, markScale, bg) {
  const SS = 4; // supersample
  const big = size * SS;
  const s = (big * markScale) / 100;
  const ox = (big - 100 * s) / 2;
  const oy = (big - 100 * s) / 2;
  const px = new Uint8Array(big * big * 3);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      let c = bg;
      if (insideRect(x, y, MARK.bezel, s, ox, oy)) c = COLORS.ink;
      if (insideRect(x, y, MARK.screen, s, ox, oy)) c = COLORS.amber;
      if (insideRect(x, y, MARK.stand, s, ox, oy)) c = COLORS.ink;
      const i = (y * big + x) * 3;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
    }
  }
  // Box-downsample SSxSS to one pixel.
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * big + (x * SS + sx)) * 3;
          r += px[i]; g += px[i + 1]; b += px[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// A minimal PNG encoder: RGBA rows, no interlace, zlib deflate.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgb, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, y * size * 3, size * 3).copy(raw, y * (size * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
function write(name, rgb, size) {
  fs.writeFileSync(path.join(outDir, name), encodePNG(rgb, size));
  console.log(name, fs.statSync(path.join(outDir, name)).size, 'bytes');
}
write('icon-192.png', draw(192, 0.82, COLORS.ground), 192);
write('icon-512.png', draw(512, 0.82, COLORS.ground), 512);
// Maskable: full-bleed ground, the mark inside the 80% safe zone.
write('icon-maskable-512.png', draw(512, 0.62, COLORS.ground), 512);
