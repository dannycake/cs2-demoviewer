// Writes public/detail.png: the 256² grey noise the viewer tiles over the maps every 1.5 m
// (src/scene/detail.ts). Tileable value noise over five octaves, weighted to the fine ones so
// the 1.5 m repeat does not show as a pattern on big floors, plus a little per-pixel grain,
// centred on mid-grey, from a fixed seed: every run makes the same pixels. The compressed
// bytes are not: deflate's output depends on the zlib node links, so the file is rewritten
// only when the pixels in it differ, and `prebuild` leaves the committed one as it is on any
// node. No dependencies: node's zlib makes the PNG.
//
//   node scripts/make-detail.mjs [out.png]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIZE = 256;
/** Lattice cells across the tile, coarse to fine, and each octave's weight. */
const OCTAVES = [
  [8, 0.12],
  [16, 0.22],
  [32, 0.3],
  [64, 0.3],
  [128, 0.2],
];
/** Per-pixel grain, against the octaves' sum. */
const GRAIN = 0.15;
/** Standard deviation of the result in 0..255, around 128. */
const STDDEV = 22;

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise with `cells` lattice cells across the tile, wrapping at its edges. */
function octave(cells, rand) {
  const lattice = Float64Array.from({ length: cells * cells }, () => rand());
  const at = (x, y) => lattice[(y % cells) * cells + (x % cells)];
  const out = new Float64Array(SIZE * SIZE);
  const step = SIZE / cells;
  for (let y = 0; y < SIZE; y++) {
    const gy = y / step;
    const y0 = Math.floor(gy);
    const fy = fade(gy - y0);
    for (let x = 0; x < SIZE; x++) {
      const gx = x / step;
      const x0 = Math.floor(gx);
      const fx = fade(gx - x0);
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
      const bottom =
        at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
      out[y * SIZE + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}

function noise() {
  const rand = rng(0x5ca1ab1e);
  const sum = new Float64Array(SIZE * SIZE);
  for (const [cells, weight] of OCTAVES) {
    const o = octave(cells, rand);
    for (let i = 0; i < sum.length; i++) sum[i] += o[i] * weight;
  }
  for (let i = 0; i < sum.length; i++) sum[i] += (rand() - 0.5) * GRAIN;
  let mean = 0;
  for (const v of sum) mean += v;
  mean /= sum.length;
  let variance = 0;
  for (const v of sum) variance += (v - mean) ** 2;
  const k = STDDEV / Math.sqrt(variance / sum.length);
  return Uint8Array.from(sum, (v) =>
    Math.max(0, Math.min(255, Math.round(128 + (v - mean) * k)))
  );
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The IHDR of an 8-bit greyscale `SIZE`² image. */
function header() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return ihdr;
}

/** The PNG scanlines of `pixels` (`SIZE`² bytes), every row filtered "up". */
function scanlines(pixels) {
  const raw = Buffer.alloc(SIZE * (SIZE + 1));
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE + 1);
    raw[row] = 2; // up: smooth noise compresses better as row differences
    for (let x = 0; x < SIZE; x++) {
      const v = pixels[y * SIZE + x];
      const up = y ? pixels[(y - 1) * SIZE + x] : 0;
      raw[row + 1 + x] = (v - up) & 0xff;
    }
  }
  return raw;
}

/** The PNG of IHDR `ihdr` and scanlines `raw`. */
function png(ihdr, raw) {
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Whether `file` is a PNG with IHDR `ihdr` and scanlines `raw`, whatever zlib packed it. */
function holds(file, ihdr, raw) {
  try {
    const bytes = readFileSync(file);
    if (!bytes.subarray(0, 8).equals(SIGNATURE)) return false;
    let head = null;
    const idat = [];
    for (let at = 8; at + 12 <= bytes.length;) {
      const len = bytes.readUInt32BE(at);
      const type = bytes.toString('latin1', at + 4, at + 8);
      const data = bytes.subarray(at + 8, at + 8 + len);
      if (type === 'IHDR') head = data;
      else if (type === 'IDAT') idat.push(data);
      at += 12 + len;
    }
    return (
      head !== null &&
      head.equals(ihdr) &&
      inflateSync(Buffer.concat(idat)).equals(raw)
    );
  } catch {
    return false; // missing or unreadable: write it
  }
}

const out =
  process.argv[2] ??
  fileURLToPath(new URL('../public/detail.png', import.meta.url));
const ihdr = header();
const raw = scanlines(noise());
if (holds(out, ihdr, raw)) {
  console.log(`detail: unchanged ${out}`);
} else {
  const bytes = png(ihdr, raw);
  writeFileSync(out, bytes);
  console.log(`detail: ${out} (${bytes.length} bytes)`);
}
