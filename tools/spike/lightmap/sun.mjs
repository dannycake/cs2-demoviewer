// Spike (D3): is the sun's direct light in irradiance.exr, and which way round is the shadow channel?
//   node tools/spike/lightmap/sun.mjs <map> [channel]
// 1. Within each chart (debug_chart_color, 4096 px, one colour per chart), the mean irradiance
//    luminance of texels where direct_light_shadows[channel] >= 0.9 over that of texels <= 0.1.
//    Found: 0.54 (Mirage) and 0.44 (Nuke). The >= 0.9 texels are the shadowed ones (see 2), so
//    sunlit texels hold about 2x the irradiance of shadowed ones. That is bounce and sky
//    occlusion: a sun of brightness 3 in the bake would make them about 5x brighter.
// 2. Facing test: triangles facing away from the sun can only be shadowed, and they read 1.0
//    (94 %), so the channel stores the shadow, 1 = shadowed.
import path from 'node:path';
import sharp from 'sharp';
import { readExr } from './exr.mjs';

const map = process.argv[2];
const channel = Number(process.argv[3] ?? 0);
const dir = path.join('assets/spike/lm', map, 'maps', map, 'lightmaps');
const { width: W, data: irr } = readExr(path.join(dir, 'irradiance.exr'));
const sh = await sharp(path.join(dir, 'direct_light_shadows.png')).raw().toBuffer({ resolveWithObject: true });
const ch = await sharp(path.join(dir, 'debug_chart_color.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const CW = ch.info.width, k = W / CW, SC = sh.info.channels;
if (sh.info.width !== W) throw new Error('shadow and irradiance sizes differ');
const charts = new Map();
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  const s = sh.data[i * SC + channel] / 255;
  if (s > 0.1 && s < 0.9) continue;
  const c = ((y / k | 0) * CW + (x / k | 0)) * 3;
  const key = (ch.data[c] << 16) | (ch.data[c + 1] << 8) | ch.data[c + 2];
  if (key === 0) continue;
  const L = 0.2126 * irr[4 * i] + 0.7152 * irr[4 * i + 1] + 0.0722 * irr[4 * i + 2];
  let e = charts.get(key); if (!e) charts.set(key, (e = [0, 0, 0, 0]));
  if (s >= 0.9) { e[0] += L; e[1]++; } else { e[2] += L; e[3]++; }
}
const ratios = [];
let hiSum = 0, hiN = 0, loSum = 0, loN = 0;
for (const [, e] of charts) {
  if (e[1] < 64 || e[3] < 64) continue;
  ratios.push((e[0] / e[1]) / (e[2] / e[3]));
  hiSum += e[0]; hiN += e[1]; loSum += e[2]; loN += e[3];
}
ratios.sort((a, b) => a - b);
const q = (p) => ratios[Math.floor(p * (ratios.length - 1))].toFixed(2);
console.log(`${map} channel ${channel}: ${ratios.length} charts with >= 64 texels of each`);
console.log(`  irradiance where value >= 0.9 / where <= 0.1, per chart: p10 ${q(0.1)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}`);
console.log(`  pooled over those charts: value >= 0.9 ${(hiSum / hiN).toFixed(3)} (${hiN} texels), value <= 0.1 ${(loSum / loN).toFixed(3)} (${loN} texels)`);

// Facing test (2). Sun direction from
// light_environment `angles` (pitch, yaw); Source (x, y, z) is glTF (y, z, x).
const { createIO } = await import('../../lib/gltf.mjs');
const { shouldDrop, vmatOf } = await import('../../lib/filters.mjs');
const fs = await import('node:fs');
const text = fs.readFileSync(path.join('assets/raw', map, 'entities', 'default_ents.vents'), 'utf8');
const env = text.split(/^====\d+====$/m).find((b) => /classname\s+"light_environment"/.test(b));
const [pitch, yaw] = /angles\s+\[([^\]]*)\]/.exec(env)[1].split(',').map(Number);
const r = Math.PI / 180;
const fwd = [Math.cos(pitch * r) * Math.cos(yaw * r), Math.cos(pitch * r) * Math.sin(yaw * r), -Math.sin(pitch * r)];
const toSun = [-fwd[1], -fwd[2], -fwd[0]]; // glTF
const io = await createIO();
const doc = await io.read(path.join('assets/raw', map, 'world.glb'));
const bins = { towards: [0, 0], away: [0, 0], grazing: [0, 0] };
const hist = { towards: new Array(11).fill(0), away: new Array(11).fill(0) };
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const p of mesh.listPrimitives()) {
    const { name, shader } = vmatOf(p.getMaterial());
    if (shouldDrop(node.getName(), name, shader, map)) continue;
    const uvA = p.getAttribute('TEXCOORD_2') ?? p.getAttribute('TEXCOORD_1'); if (!uvA) continue;
    const pos = p.getAttribute('POSITION').getArray(), uv = uvA.getArray(), idx = p.getIndices()?.getArray();
    const n = idx ? idx.length : pos.length / 3;
    const P = (j) => { const x = pos[3 * j], y = pos[3 * j + 1], z = pos[3 * j + 2]; return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; };
    for (let i = 0; i + 2 < n; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => (idx ? idx[i + k] : i + k));
      const A = P(a), B = P(b), C = P(c);
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const N = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(...N); if (len < 1e-4) continue; // area > 0.5 cm^2 x 2
      const ndl = (N[0] * toSun[0] + N[1] * toSun[1] + N[2] * toSun[2]) / len;
      const u = (uv[2 * a] + uv[2 * b] + uv[2 * c]) / 3, v = (uv[2 * a + 1] + uv[2 * b + 1] + uv[2 * c + 1]) / 3;
      const x = Math.min(W - 1, Math.max(0, Math.floor(u * W))), y = Math.min(W - 1, Math.max(0, Math.floor(v * W)));
      const s = sh.data[(y * W + x) * SC + channel] / 255;
      const key = ndl > 0.3 ? 'towards' : ndl < -0.3 ? 'away' : 'grazing';
      bins[key][0] += s; bins[key][1]++;
      if (key !== 'grazing') hist[key][Math.round(s * 10)]++;
    }
  }
}
console.log(`  sun angles [${pitch}, ${yaw}] -> towards the sun (glTF) [${toSun.map((x) => x.toFixed(3)).join(', ')}]`);
for (const [k, [s, n]] of Object.entries(bins)) console.log(`  triangles facing ${k.padEnd(8)} (N.L ${k === 'towards' ? '> 0.3' : k === 'away' ? '< -0.3' : 'in between'}): ${String(n).padStart(7)}, mean shadow-texture value ${(s / n).toFixed(3)}`);
for (const k of ['towards', 'away']) console.log(`  histogram (0.0 .. 1.0) ${k.padEnd(8)}: ${hist[k].map((c) => (100 * c / hist[k].reduce((a, b) => a + b, 0)).toFixed(0) + '%').join(' ')}`);
