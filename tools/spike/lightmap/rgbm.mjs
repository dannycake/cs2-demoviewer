// Spike (D5): RGBM WebP encodings of the composed light, their bytes and their error.
//   node tools/spike/lightmap/rgbm.mjs <map> <size> <range> <quality>... [--src light|irr] [--mblock B]
// Reads assets/spike/lm/<map>/<src>_<size>.f32 (bake.mjs), encodes
//   m = ceil(max(c) / range * 255) / 255, rgb = c / (m * range)
// as WebP (RGB lossy at <quality>, alpha lossless), decodes it with sharp and reports, over
// texels the coverage raster marks, the error of max(rgb) in stops, and writes
// assets/spike/lm/<map>/<src>_<size>_r<range>_q<quality>.webp.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const [map, sizeS, rangeS] = args;
const src = args.includes('--src') ? args[args.indexOf('--src') + 1] : 'light';
const qualities = args.slice(3).filter((a, i, rest) => /^\d+$/.test(a) && !['--src', '--mblock'].includes(rest[i - 1])).map(Number);
const size = Number(sizeS), range = Number(rangeS);
const base = path.join('assets/spike/lm', map);
const f = new Float32Array(fs.readFileSync(path.join(base, `${src}_${size}.f32`)).buffer.slice(0));
const N = size * size;
// Coverage at this size: a texel counts when at least half its 8192 px block is covered.
const cov = await sharp(path.join(base, 'coverage.png')).resize(size, size, { kernel: 'mitchell' }).raw().toBuffer();
// --mblock B: one multiplier per aligned BxB block (the block's max), so lossy RGB sees smooth
// mantissas inside a block instead of a jump wherever the per-texel multiplier changes.
const B = args.includes('--mblock') ? Number(args[args.indexOf('--mblock') + 1]) : 1;
const blockMax = new Float32Array(N);
for (let y = 0; y < size; y += B) for (let x = 0; x < size; x += B) {
  let mx = 0;
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) { const k = (y + j) * size + x + i; mx = Math.max(mx, f[3 * k], f[3 * k + 1], f[3 * k + 2]); }
  for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) blockMax[(y + j) * size + x + i] = mx;
}
const enc = Buffer.alloc(N * 4);
let clipped = 0;
for (let i = 0; i < N; i++) {
  const r = f[3 * i], g = f[3 * i + 1], b = f[3 * i + 2];
  const mx = blockMax[i];
  if (Math.max(r, g, b) > range) clipped++;
  const m = Math.min(255, Math.ceil(Math.min(mx, range) / range * 255));
  enc[4 * i + 3] = m;
  const s = m ? 255 / (m / 255 * range) : 0;
  enc[4 * i] = Math.min(255, Math.round(r * s)); enc[4 * i + 1] = Math.min(255, Math.round(g * s)); enc[4 * i + 2] = Math.min(255, Math.round(b * s));
}
const png = await sharp(enc, { raw: { width: size, height: size, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
console.log(`${map} ${src} ${size}px range ${range}: ${clipped} texels above range (${(100 * clipped / N).toFixed(3)}%); lossless PNG RGBM ${(png.length / 1e6).toFixed(2)} MB`);
for (const q of qualities) {
  const out = path.join(base, `${src}_${size}_r${range}_q${q}${B > 1 ? `_b${B}` : ''}.webp`);
  await sharp(enc, { raw: { width: size, height: size, channels: 4 } }).webp({ quality: q, alphaQuality: 100, effort: 6, exact: true }).toFile(out);
  const dec = await sharp(out).raw().toBuffer();
  const errs = [];
  let dark = 0, darkErr = 0;
  for (let i = 0; i < N; i++) {
    if (cov[i] < 128) continue;
    const m = dec[4 * i + 3] / 255 * range;
    const ref = Math.max(f[3 * i], f[3 * i + 1], f[3 * i + 2]);
    const got = Math.max(dec[4 * i], dec[4 * i + 1], dec[4 * i + 2]) / 255 * m;
    if (ref < 1e-3) continue;
    const e = Math.abs(Math.log2(Math.max(got, 1e-6) / Math.min(ref, range)));
    errs.push(e);
    if (ref < 0.05) { dark++; darkErr += e; }
  }
  errs.sort((a, b) => a - b);
  const p = (x) => errs[Math.floor(x * (errs.length - 1))].toFixed(3);
  console.log(`  q${q}: ${(fs.statSync(out).size / 1e6).toFixed(2)} MB; |error| in stops over covered texels: median ${p(0.5)} p90 ${p(0.9)} p99 ${p(0.99)}; dark texels (< 0.05, ${dark}) mean ${(darkErr / dark).toFixed(3)}`);
}
