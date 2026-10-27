// Spike: formats, sizes and value ranges of a map's exported lightmaps.
//   node tools/spike/lightmap/inspect.mjs <map>
// Reads assets/spike/lm/<map>/maps/<map>/lightmaps/ (export.sh) and prints, per file, the format,
// dimensions, channels and value ranges; writes inspect.json and a tone-mapped 1024 px
// preview (irradiance_preview.png) beside the export.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { readExr } from './exr.mjs';

const map = process.argv[2];
const base = path.join('assets/spike/lm', map);
const dir = path.join(base, 'maps', map, 'lightmaps');
const report = { map, files: {} };
const say = (s) => console.log(s);

/** Percentiles of positive values from a log2 histogram (1/64 stop bins). */
function logPercentiles(values, ps) {
  const LO = -24, HI = 16, BINS = (HI - LO) * 64;
  const h = new Float64Array(BINS); let n = 0;
  for (const v of values) { if (!(v > 0)) continue; const b = Math.min(BINS - 1, Math.max(0, Math.floor((Math.log2(v) - LO) * 64))); h[b]++; n++; }
  const out = {}; let acc = 0, b = 0;
  for (const p of ps) { const target = p / 100 * n; while (b < BINS && acc + h[b] < target) acc += h[b++]; out[p] = +(2 ** (LO + (b + 1) / 64)).toPrecision(4); }
  return out;
}

// irradiance.exr
{
  const f = path.join(dir, 'irradiance.exr');
  const t0 = performance.now();
  const { width, height, data } = readExr(f);
  const secs = (performance.now() - t0) / 1000;
  const N = width * height;
  const ch = ['R', 'G', 'B', 'A'].map(() => ({ min: Infinity, max: -Infinity, sum: 0 }));
  let covered = 0, negative = 0, nan = 0;
  const alphaVals = new Map();
  function* maxes() { for (let i = 0; i < N; i++) { const o = 4 * i; const m = Math.max(data[o], data[o + 1], data[o + 2]); if (m > 0) yield m; } }
  for (let i = 0; i < N; i++) {
    const o = 4 * i;
    for (let c = 0; c < 4; c++) { const v = data[o + c]; if (Number.isNaN(v)) { nan++; continue; } const s = ch[c]; if (v < s.min) s.min = v; if (v > s.max) s.max = v; s.sum += v; if (v < 0) negative++; }
    if (data[o] > 0 || data[o + 1] > 0 || data[o + 2] > 0) covered++;
    if (i % 97 === 0) { const a = +data[o + 3].toFixed(3); alphaVals.set(a, (alphaVals.get(a) ?? 0) + 1); }
  }
  const pct = logPercentiles(maxes(), [1, 10, 50, 90, 99, 99.9, 99.99, 100]);
  const r = {
    format: 'OpenEXR, 4 x float32 (channels A,B,G,R), ZIP', bytes: fs.statSync(f).size, width, height, readSeconds: +secs.toFixed(1),
    channels: Object.fromEntries(['R', 'G', 'B', 'A'].map((k, i) => [k, { min: ch[i].min, max: ch[i].max, mean: +(ch[i].sum / N).toPrecision(4) }])),
    coveredFraction: +(covered / N).toFixed(4), negative, nan,
    alphaSample: [...alphaVals].sort((a, b) => b[1] - a[1]).slice(0, 8),
    maxChannelPercentiles: pct,
  };
  report.files['irradiance.exr'] = r;
  say(`irradiance.exr ${width}x${height} ${(r.bytes / 1e6).toFixed(1)} MB read in ${r.readSeconds}s; covered ${(100 * r.coveredFraction).toFixed(1)}%; negative ${negative}, NaN ${nan}`);
  for (const [k, v] of Object.entries(r.channels)) say(`  ${k}: min ${v.min.toPrecision(4)} max ${v.max.toPrecision(4)} mean ${v.mean}`);
  say(`  alpha (sampled): ${JSON.stringify(r.alphaSample)}`);
  say(`  max(rgb) percentiles over covered texels: ${JSON.stringify(pct)}`);
  // Preview: box-downscale to 1024, exposure so the 99th percentile maps to 1, sRGB.
  const P = 1024, k = width / P, img = Buffer.alloc(P * P * 3), ex = 1 / pct[99];
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const acc = [0, 0, 0];
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const o = 4 * ((y * k + j) * width + x * k + i); acc[0] += data[o]; acc[1] += data[o + 1]; acc[2] += data[o + 2]; }
    for (let c = 0; c < 3; c++) { const v = Math.min(1, acc[c] / (k * k) * ex); img[3 * (y * P + x) + c] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)); }
  }
  await sharp(img, { raw: { width: P, height: P, channels: 3 } }).png().toFile(path.join(base, 'irradiance_preview.png'));
}

// The LDR textures S2V writes as PNG.
for (const name of ['direct_light_shadows.png', 'directional_irradiance.png', 'debug_chart_color.png']) {
  const f = path.join(dir, name);
  const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height, C = info.channels;
  const stats = [];
  for (let c = 0; c < C; c++) {
    let min = 255, max = 0, sum = 0, zero = 0, full = 0;
    for (let i = c; i < data.length; i += C) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; sum += v; if (v === 0) zero++; if (v === 255) full++; }
    stats.push({ min, max, mean: +(sum / n).toFixed(1), zero: +(zero / n).toFixed(3), full: +(full / n).toFixed(3) });
  }
  // Are the channels copies of each other? (S2V expands one-channel BC4 to grey.)
  let same = true; for (let i = 0; i < data.length && same; i += C * 101) same = data[i] === data[i + 1] && data[i] === data[i + 2];
  report.files[name] = { format: `PNG ${C} x 8 bit`, bytes: fs.statSync(f).size, width: info.width, height: info.height, channels: stats, rgbIdentical: same };
  say(`${name} ${info.width}x${info.height} ${C} ch ${(fs.statSync(f).size / 1e6).toFixed(1)} MB; rgb identical: ${same}`);
  stats.forEach((s, c) => say(`  ch${c}: ${JSON.stringify(s)}`));
}

// The probe atlas and its _dlshd, one file per z slice.
for (const stem of ['env_light_probe_volume_atlas_z', 'env_light_probe_volume_atlas_dlshd_z']) {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(stem)).sort();
  const first = path.join(dir, files[0]);
  let w, h, fmt;
  if (first.endsWith('.exr')) { const e = readExr(first); w = e.width; h = e.height; fmt = 'EXR float32 RGBA per slice'; }
  else { const m = await sharp(first).metadata(); w = m.width; h = m.height; fmt = `PNG ${m.channels} ch per slice`; }
  report.files[stem] = { format: fmt, slices: files.length, width: w, height: h, bytes: files.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) };
  say(`${stem}* ${files.length} slices of ${w}x${h} (${fmt})`);
}
fs.writeFileSync(path.join(base, 'inspect.json'), JSON.stringify(report, null, 2) + '\n');
