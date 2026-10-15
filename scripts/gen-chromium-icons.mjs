#!/usr/bin/env node
/** Writes extension/chromium/icons/desk-{16,32,48,128}.png (static fallback = logged-out red mark). */
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "extension", "chromium", "icons");
const RED = [0xc6, 0x28, 0x28];
const SS = 4;

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const c = size / 2;
  const radius = size * 0.47;
  const half = Math.max(1.5, size * 0.07) / 2;
  const segs = [
    [0.33, 0.33, 0.67, 0.67],
    [0.67, 0.33, 0.33, 0.67],
  ].map((s) => s.map((v) => v * size));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      let a = 0;
      let white = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (Math.hypot(px - c, py - c) > radius) continue;
          a += 1;
          if (segs.some((s) => distToSegment(px, py, ...s) <= half)) white += 1;
        }
      }
      const total = SS * SS;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const wf = a ? white / a : 0;
      raw[o] = Math.round(RED[0] + (255 - RED[0]) * wf);
      raw[o + 1] = Math.round(RED[1] + (255 - RED[1]) * wf);
      raw[o + 2] = Math.round(RED[2] + (255 - RED[2]) * wf);
      raw[o + 3] = Math.round((a / total) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `desk-${size}.png`), render(size));
}
console.log(`wrote icons to ${outDir}`);
