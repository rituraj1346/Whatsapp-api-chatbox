// App icons drawn in code: a neutral chat bubble with three dots on a brand-colour square.
import zlib from 'node:zlib';

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));

// Shapes in 0..1 coordinates, all inside the maskable safe zone (circle of radius 0.4)
const BOX = { x0: 0.24, y0: 0.28, x1: 0.76, y1: 0.66, r: 0.12 };
const TAIL = [[0.30, 0.62], [0.43, 0.62], [0.28, 0.76]];
const DOTS = [0.38, 0.5, 0.62].map(x => [x, 0.47]);
const DOT_R = 0.045;

function inRoundRect(u, v, { x0, y0, x1, y1, r }) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const dx = Math.max(x0 + r - u, 0, u - (x1 - r)), dy = Math.max(y0 + r - v, 0, v - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}
function inTriangle(u, v, [a, b, c]) {
  const s = (p, q) => (u - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (v - q[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
/** true = white bubble at this point */
function isBubble(u, v) {
  if (DOTS.some(([x, y]) => (u - x) ** 2 + (v - y) ** 2 <= DOT_R * DOT_R)) return false;
  return inRoundRect(u, v, BOX) || inTriangle(u, v, TAIL);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}

const cache = new Map();
/** RGB PNG of the icon, 3×3 supersampled. */
export function iconPng(size, color) {
  const key = `${size}${color}`;
  if (cache.has(key)) return cache.get(key);
  const [br, bg, bb] = hex(color);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let white = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        if (isBubble((x + (sx + 0.5) / 3) / size, (y + (sy + 0.5) / 3) / size)) white++;
      }
      const t = white / 9;
      raw[o++] = Math.round(br + (255 - br) * t);
      raw[o++] = Math.round(bg + (255 - bg) * t);
      raw[o++] = Math.round(bb + (255 - bb) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  cache.set(key, png);
  return png;
}

export function iconSvg(color) {
  const p = n => Math.round(n * 1000) / 10;
  const { x0, y0, x1, y1, r } = BOX;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" rx="22" fill="${color}"/>` +
    `<rect x="${p(x0)}" y="${p(y0)}" width="${p(x1 - x0)}" height="${p(y1 - y0)}" rx="${p(r)}" fill="#fff"/>` +
    `<path d="M${TAIL.map(([u, v]) => `${p(u)} ${p(v)}`).join('L')}Z" fill="#fff"/>` +
    DOTS.map(([u, v]) => `<circle cx="${p(u)}" cy="${p(v)}" r="${p(DOT_R)}" fill="${color}"/>`).join('') +
    `</svg>`;
}
