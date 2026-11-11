// Draws the app icon procedurally (no image assets, no dependencies):
// a circle filled with the dusk sky gradient, holding a single star.
// Run with `npm run icons`; the PNGs in public/icons are committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Dusk palette from the game, top of the circle to the bottom.
const STOPS = [
  [0.0, hex('#16255a')],
  [0.3, hex('#4a4a96')],
  [0.52, hex('#a85f9f')],
  [0.7, hex('#e86a92')],
  [0.86, hex('#f5a15a')],
  [1.0, hex('#e8533a')],
];
const BG_TOP = hex('#0a0e2c');
const BG_BOTTOM = hex('#161a48');

function gradient(t) {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** Colour at a point in unit coordinates (0..1, y down). */
function shade(x, y) {
  let col = mix(BG_TOP, BG_BOTTOM, y);
  const cx = 0.5;
  const cy = 0.5;
  const r = 0.36; // inside the maskable safe zone (0.4)
  const d = Math.hypot(x - cx, y - cy);

  // Soft warm halo around the circle.
  const halo = Math.exp(-Math.pow(Math.max(0, d - r) / 0.07, 2)) * 0.22;
  col = mix(col, hex('#f08a6a'), halo * smooth(0.2, 1.0, (y - cy) / r * 0.5 + 0.5));

  // The sunset circle.
  const inside = 1 - smooth(r - 0.004, r + 0.004, d);
  col = mix(col, gradient(clamp01((y - (cy - r)) / (2 * r))), inside);

  // One four-pointed star in the upper sky, with a little glow.
  const sx = 0.585;
  const sy = 0.34;
  const size = 0.085;
  const dx = Math.abs(x - sx) / size;
  const dy = Math.abs(y - sy) / size;
  const astroid = Math.pow(Math.pow(dx, 0.58) + Math.pow(dy, 0.58), 1 / 0.58);
  const star = 1 - smooth(0.9, 1.02, astroid);
  const glow = Math.exp(-(dx * dx + dy * dy) * 2.2) * 0.4 * inside;
  col = mix(col, hex('#fff3df'), clamp01(star + glow));
  return col;
}

function render(size) {
  const ss = 4; // supersampling per axis
  const data = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const c = shade((px + (i + 0.5) / ss) / size, (py + (j + 0.5) / ss) / size);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const o = (py * size + px) * 4;
      const n = ss * ss;
      data[o] = Math.round(clamp01(r / n) * 255);
      data[o + 1] = Math.round(clamp01(g / n) * 255);
      data[o + 2] = Math.round(clamp01(b / n) * 255);
      data[o + 3] = 255; // opaque: iOS turns transparency black
    }
  }
  return data;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
  ['favicon-64.png', 64],
]) {
  writeFileSync(join(OUT, name), png(size, render(size)));
  console.log(`wrote ${name} (${size}x${size})`);
}
