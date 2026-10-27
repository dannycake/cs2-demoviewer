// Spike (D5): banding and blocking in the darkest lightmapped surface of a region.
//   node tools/spike/lightmap/banding.mjs <map> <minX,minY,minZ,maxX,maxY,maxZ (glTF m)> <range> <webp>...
// Finds the lightmapped triangles inside the box, takes the 2048 px texels they cover, picks the
// darkest WIN x WIN (default 16) texel window that is fully covered, and writes it scaled 8x (nearest), exposed so
// the window's brightest texel is white: the float reference, then each RGBM WebP decode
// (a 1024 px file is sampled at the same UV). Output: assets/spike/m2a-<map>-darkest-window.png.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createIO } from '../../lib/gltf.mjs';
import { shouldDrop, vmatOf } from '../../lib/filters.mjs';

const [map, boxS, rangeS, ...webps] = process.argv.slice(2);
const box = boxS.split(',').map(Number), range = Number(rangeS), S = 2048, WIN = Number(process.env.WIN ?? 16);
const base = path.join('assets/spike/lm', map);
const ref = new Float32Array(fs.readFileSync(path.join(base, `light_${S}.f32`)).buffer.slice(0));
const mask = new Uint8Array(S * S);
const io = await createIO();
const doc = await io.read(path.join('assets/raw', map, 'world.glb'));
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const p of mesh.listPrimitives()) {
    const { name, shader } = vmatOf(p.getMaterial());
    if (shouldDrop(node.getName(), name, shader, map)) continue;
    const uvA = p.getAttribute('TEXCOORD_2') ?? p.getAttribute('TEXCOORD_1'); if (!uvA) continue;
    const uv = uvA.getArray(), pos = p.getAttribute('POSITION').getArray(), idx = p.getIndices()?.getArray();
    const n = idx ? idx.length : pos.length / 3;
    for (let i = 0; i + 2 < n; i += 3) {
      const t = [0, 1, 2].map((k) => (idx ? idx[i + k] : i + k));
      const inside = t.every((j) => { const x = pos[3 * j], y = pos[3 * j + 1], z = pos[3 * j + 2]; const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; return w.every((v, c) => v >= box[c] && v <= box[c + 3]); });
      if (!inside) continue;
      const P = t.map((j) => [uv[2 * j] * S - 0.5, uv[2 * j + 1] * S - 0.5]);
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = Math.max(0, Math.ceil(Math.min(P[0][1], P[1][1], P[2][1]))); y <= Math.min(S - 1, Math.floor(Math.max(P[0][1], P[1][1], P[2][1]))); y++)
        for (let x = Math.max(0, Math.ceil(Math.min(P[0][0], P[1][0], P[2][0]))); x <= Math.min(S - 1, Math.floor(Math.max(P[0][0], P[1][0], P[2][0]))); x++) {
          const w0 = ((P[1][0] - x) * (P[2][1] - y) - (P[2][0] - x) * (P[1][1] - y)) / area, w1 = ((P[2][0] - x) * (P[0][1] - y) - (P[0][0] - x) * (P[2][1] - y)) / area;
          if (w0 >= -1e-6 && w1 >= -1e-6 && 1 - w0 - w1 >= -1e-6) mask[y * S + x] = 1;
        }
    }
  }
}
// Summed-area tables of coverage and luminance pick the darkest fully covered window.
const sat = (get) => { const t = new Float64Array((S + 1) * (S + 1)); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t[(y + 1) * (S + 1) + x + 1] = get(y * S + x) + t[y * (S + 1) + x + 1] + t[(y + 1) * (S + 1) + x] - t[y * (S + 1) + x]; return t; };
const lum = (k) => 0.2126 * ref[3 * k] + 0.7152 * ref[3 * k + 1] + 0.0722 * ref[3 * k + 2];
const C = sat((k) => mask[k]), L = sat(lum);
const sum = (t, x, y) => t[(y + WIN) * (S + 1) + x + WIN] - t[y * (S + 1) + x + WIN] - t[(y + WIN) * (S + 1) + x] + t[y * (S + 1) + x];
let best = null;
for (let y = 0; y + WIN <= S; y++) for (let x = 0; x + WIN <= S; x++) if (sum(C, x, y) === WIN * WIN) { const l = sum(L, x, y); if (!best || l < best.l) best = { x, y, l }; }
if (!best) throw new Error('no fully covered window');
const decoded = [];
for (const f of webps) { const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true }); decoded.push({ f, data, size: info.width }); }
const get = (src, u, v) => {
  if (!src) { const k = Math.floor(v * S) * S + Math.floor(u * S); return [ref[3 * k], ref[3 * k + 1], ref[3 * k + 2]]; }
  const k = (Math.floor(v * src.size) * src.size + Math.floor(u * src.size)) * 4, m = src.data[k + 3] / 255 * range;
  return [src.data[k] / 255 * m, src.data[k + 1] / 255 * m, src.data[k + 2] / 255 * m];
};
let peak = 0;
for (let j = 0; j < WIN; j++) for (let i = 0; i < WIN; i++) peak = Math.max(peak, ...get(null, (best.x + i + 0.5) / S, (best.y + j + 0.5) / S));
const Z = Math.round(384 / WIN), panels = [null, ...decoded];
const img = Buffer.alloc(panels.length * WIN * Z * WIN * Z * 3);
const W = panels.length * WIN * Z;
panels.forEach((src, pi) => {
  for (let y = 0; y < WIN * Z; y++) for (let x = 0; x < WIN * Z; x++) {
    const c = get(src, (best.x + (x / Z | 0) + 0.5) / S, (best.y + (y / Z | 0) + 0.5) / S);
    for (let k = 0; k < 3; k++) { const v = Math.min(1, c[k] / peak); img[3 * (y * W + pi * WIN * Z + x) + k] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)); }
  }
});
const out = path.join('assets/spike', `m2a-${map.replace('de_', '')}-darkest-window.png`);
await sharp(img, { raw: { width: W, height: WIN * Z, channels: 3 } }).png().toFile(out);
console.log(`${map}: darkest fully covered ${WIN}x${WIN} window at 2048 px (${best.x}, ${best.y}), mean luminance ${(best.l / WIN / WIN).toFixed(4)}, peak ${peak.toFixed(4)}; ${out} = reference | ${webps.map((f) => path.basename(f)).join(' | ')}`);
