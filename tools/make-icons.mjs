// Renders the app icon (gold equalizer bars on a flat espresso tile) to PNG files, no dependencies.
// Usage: node tools/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [32, 192, 512];
const TILE = [0.03, 0.03, 0.97, 0.97];
const BARS = [[0.26, 0.46], [0.42, 0.24], [0.58, 0.36], [0.74, 0.54]]; // [centre x, top y]; all end at y = 0.76
const TILE_COLOUR = [42, 29, 20]; // #2a1d14 espresso, the app's panels
const BAR_COLOUR = [229, 174, 61]; // #e5ae3d gold, the app's buttons
const CREAM = [244, 235, 219]; // #f4ebdb, the app's page

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size); // each row: filter byte 0 + pixels
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Point-in-rounded-rectangle test (unit coordinates).
function inRoundRect(x, y, [x0, y0, x1, y1], r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** fullBleed fills the whole square (a record sleeve) instead of drawing the inset, rounded app tile. */
function render(size, { tile = TILE_COLOUR, bar = BAR_COLOUR, fullBleed = false } = {}) {
  const samples = 4; // 4×4 supersampling for smooth edges
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / size;
          const v = (y + (sy + 0.5) / samples) / size;
          if (!fullBleed && !inRoundRect(u, v, TILE, 0.22)) continue;
          const onBar = BARS.some(([cx, top]) => inRoundRect(u, v, [cx - 0.06, top, cx + 0.06, 0.76], 0.06));
          const colour = onBar ? bar : tile;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          hits++;
        }
      }
      if (!hits) continue;
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(r / hits);
      pixels[i + 1] = Math.round(g / hits);
      pixels[i + 2] = Math.round(b / hits);
      pixels[i + 3] = Math.round((255 * hits) / samples ** 2);
    }
  }
  return pixels;
}

const write = (name, size, options) => writeFileSync(new URL(`../icons/${name}`, import.meta.url), encodePng(size, render(size, options)));
for (const size of SIZES) write(`icon-${size}.png`, size);
// Placeholder sleeves for when nothing is playing: square to the edge, so they match real album covers.
write('cover.png', 512, { tile: CREAM, bar: TILE_COLOUR, fullBleed: true }); // on the espresso panels
write('cover-dark.png', 512, { tile: TILE_COLOUR, bar: BAR_COLOUR, fullBleed: true }); // on the cream login page
console.log(`Wrote ${SIZES.map((s) => `icon-${s}.png`).join(', ')}, cover.png, cover-dark.png`);
