// Spike (D3, D4): coverage raster of the lightmap UV, and the sun added to irradiance.
//   node tools/spike/lightmap/bake.mjs <map> [--sizes 4096,2048,1024]
// Rasterizes every kept lightmapped triangle (texel centres, as a GPU would) into the 8192 px
// atlas, interpolating its smooth NORMAL into N.L for the light_environment. Prints D4: how
// covered texels relate to the texels irradiance.exr lights. Then composes
//   light = irradiance + sun.rgb * brightness * max(N.L, 0) * (1 - direct_light_shadows[0])
// (the sun is not in irradiance; channel 0 holds its shadow, 1 = shadowed), N.L dilated into
// uncovered texels, and box-downsamples it, weighting covered texels, to each size:
// assets/spike/lm/<map>/light_<size>.f32 (RGB float32) and irr_<size>.f32 (irradiance alone).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { readExr } from './exr.mjs';
import { createIO } from '../../lib/gltf.mjs';
import { shouldDrop, vmatOf } from '../../lib/filters.mjs';
import { hiddenAtStart, hiddenNodes, parseEntities } from '../../lib/entities.mjs';

const args = process.argv.slice(2);
const map = args[0];
const sizes = (args.includes('--sizes') ? args[args.indexOf('--sizes') + 1] : '4096,2048,1024').split(',').map(Number);
const base = path.join('assets/spike/lm', map);
const dir = path.join(base, 'maps', map, 'lightmaps');
const raw = path.join('assets/raw', map);
const t0 = performance.now();
const log = (m) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

// The sun: light_environment colour (sRGB 0-255), brightness, angles.
const vents = fs.readFileSync(path.join(raw, 'entities', 'default_ents.vents'), 'utf8');
const env = vents.split(/^====\d+====$/m).find((b) => /classname\s+"light_environment"/.test(b));
const vec = (k) => /\[([^\]]*)\]/.exec(new RegExp(`^${k}\\s+(.*)$`, 'm').exec(env)[1])[1].split(',').map(Number);
const [pitch, yaw] = vec('angles');
const brightness = Number(/^brightness\s+(\S+)/m.exec(env)[1]);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const sun = vec('color').map((c) => lin(c / 255) * brightness);
const r = Math.PI / 180;
const fwd = [Math.cos(pitch * r) * Math.cos(yaw * r), Math.cos(pitch * r) * Math.sin(yaw * r), -Math.sin(pitch * r)];
const toSun = [-fwd[1], -fwd[2], -fwd[0]]; // Source (x, y, z) -> glTF (y, z, x)
log(`sun ${sun.map((x) => x.toFixed(3))} (linear x brightness ${brightness}), towards the sun ${toSun.map((x) => x.toFixed(3))}`);

const { width: W, data: irr } = readExr(path.join(dir, 'irradiance.exr'));
const sh = await sharp(path.join(dir, 'direct_light_shadows.png')).raw().toBuffer({ resolveWithObject: true });
const SC = sh.info.channels;
log(`read irradiance ${W}px and direct_light_shadows (${SC} ch)`);

// Raster.
const ndl = new Float32Array(W * W).fill(NaN);
const io = await createIO();
const doc = await io.read(path.join(raw, 'world.glb'));
for (const n of hiddenNodes(doc, hiddenAtStart(parseEntities(vents)))) n.dispose();
let tris = 0, overlap = 0;
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh(); if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const p of mesh.listPrimitives()) {
    const { name, shader } = vmatOf(p.getMaterial());
    if (shouldDrop(node.getName(), name, shader, map)) continue;
    const uvA = p.getAttribute('TEXCOORD_2') ?? p.getAttribute('TEXCOORD_1');
    const nrm = p.getAttribute('NORMAL');
    if (!uvA || !nrm) continue;
    const uv = uvA.getArray(); if (uv.every((v) => v === 0)) continue;
    const na = nrm.getArray(), idx = p.getIndices()?.getArray();
    const count = idx ? idx.length : uv.length / 2;
    // N.L per vertex (normal matrix = upper 3x3; world nodes carry rotation and uniform scale).
    const vl = new Float32Array(uv.length / 2);
    for (let j = 0; j < vl.length; j++) {
      const x = na[3 * j], y = na[3 * j + 1], z = na[3 * j + 2];
      const n = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
      vl[j] = (n[0] * toSun[0] + n[1] * toSun[1] + n[2] * toSun[2]) / (Math.hypot(...n) || 1);
    }
    for (let i = 0; i + 2 < count; i += 3) {
      const a = idx ? idx[i] : i, b = idx ? idx[i + 1] : i + 1, c = idx ? idx[i + 2] : i + 2;
      const ax = uv[2 * a] * W - 0.5, ay = uv[2 * a + 1] * W - 0.5, bx = uv[2 * b] * W - 0.5, by = uv[2 * b + 1] * W - 0.5, cx = uv[2 * c] * W - 0.5, cy = uv[2 * c + 1] * W - 0.5;
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-12) continue;
      tris++;
      const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.floor(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), y1 = Math.min(W - 1, Math.floor(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const w0 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / area;
        const w1 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const k = y * W + x;
        if (!Number.isNaN(ndl[k])) overlap++;
        ndl[k] = w0 * vl[a] + w1 * vl[b] + w2 * vl[c];
      }
    }
  }
}
log(`rasterized ${tris} triangles; ${overlap} texel writes landed on an already covered texel`);

// D4.
const covered = new Uint8Array(W * W);
let nCov = 0, nLit = 0, covZero = 0, unc = 0;
for (let k = 0; k < W * W; k++) {
  const lit = irr[4 * k] > 0 || irr[4 * k + 1] > 0 || irr[4 * k + 2] > 0;
  if (!Number.isNaN(ndl[k])) { covered[k] = 1; nCov++; if (!lit) covZero++; }
  if (lit) nLit++;
}
// Distance (in texels, 4-neighbour rings) of each lit uncovered texel from coverage.
const ring = new Uint8Array(W * W); // 0 = covered or not reached
let frontier = [];
for (let k = 0; k < W * W; k++) if (covered[k]) frontier.push(k);
const ringCount = [];
for (let d = 1; d <= 8 && frontier.length; d++) {
  const next = []; let lit = 0;
  for (const k of frontier) {
    const x = k % W;
    for (const j of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, k - W, k + W]) {
      if (j < 0 || j >= W * W || covered[j] || ring[j]) continue;
      ring[j] = d; next.push(j);
      if (irr[4 * j] > 0 || irr[4 * j + 1] > 0 || irr[4 * j + 2] > 0) lit++;
    }
  }
  ringCount.push({ ring: d, texels: next.length, lit });
  frontier = next;
}
for (let k = 0; k < W * W; k++) if (!covered[k] && !ring[k] && (irr[4 * k] > 0 || irr[4 * k + 1] > 0 || irr[4 * k + 2] > 0)) unc++;
const pc = (n) => `${n} (${(100 * n / (W * W)).toFixed(2)}%)`;
log(`D4: covered texels ${pc(nCov)}; lit (irradiance > 0) ${pc(nLit)}; covered but unlit ${pc(covZero)}`);
log(`D4: uncovered texels by distance from coverage: ${ringCount.map((r) => `${r.ring}: ${r.texels} (${r.lit} lit)`).join(', ')}; lit beyond 8: ${unc}`);

// Dilate N.L into uncovered texels (4 passes) so bilinear filtering at chart edges reads the sun.
for (let pass = 0; pass < 4; pass++) {
  const src = ndl.slice();
  for (let k = 0; k < W * W; k++) {
    if (!Number.isNaN(src[k])) continue;
    const x = k % W; let s = 0, n = 0;
    for (const j of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, k - W, k + W]) if (j >= 0 && j < W * W && !Number.isNaN(src[j])) { s += src[j]; n++; }
    if (n) ndl[k] = s / n;
  }
}

// Compose in place over irr (RGBA float32): rgb = irradiance + sun term; alpha = 1 (spare).
const irrOnly = new Float32Array(W * W * 3);
const maxes = [];
for (let k = 0; k < W * W; k++) {
  const vis = 1 - sh.data[k * SC] / 255;
  const l = Number.isNaN(ndl[k]) ? 0 : Math.max(0, ndl[k]) * vis;
  for (let c = 0; c < 3; c++) { irrOnly[3 * k + c] = irr[4 * k + c]; irr[4 * k + c] += sun[c] * l; }
  if (covered[k] && (k % 7 === 0)) maxes.push(Math.max(irr[4 * k], irr[4 * k + 1], irr[4 * k + 2]));
}
maxes.sort((a, b) => a - b);
const q = (p) => maxes[Math.min(maxes.length - 1, Math.floor(p / 100 * maxes.length))].toFixed(3);
log(`composed light: max(rgb) over covered texels p50 ${q(50)} p90 ${q(90)} p99 ${q(99)} p99.9 ${q(99.9)} p99.99 ${q(99.99)} max ${maxes[maxes.length - 1].toFixed(2)}`);
fs.writeFileSync(path.join(base, 'light_stats.json'), JSON.stringify({ sun, toSun, brightness, p999: +q(99.9), p99: +q(99), coveredFraction: nCov / (W * W), litFraction: nLit / (W * W), coveredButUnlit: covZero, rings: ringCount, litBeyond8: unc }, null, 2));

// Downsample (covered texels weigh 1, dilated ones 1/64) and write raw float32 RGB.
function down(get, size, file) {
  const k = W / size, out = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, w = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
      const s = (y * k + j) * W + x * k + i, wt = covered[s] ? 1 : 1 / 64;
      const v = get(s); r += v[0] * wt; g += v[1] * wt; b += v[2] * wt; w += wt;
    }
    out.set([r / w, g / w, b / w], 3 * (y * size + x));
  }
  fs.writeFileSync(path.join(base, file), Buffer.from(out.buffer));
}
const tmp = [0, 0, 0];
for (const size of [W, ...sizes]) {
  if (size === W) continue;
  down((s) => { tmp[0] = irr[4 * s]; tmp[1] = irr[4 * s + 1]; tmp[2] = irr[4 * s + 2]; return tmp; }, size, `light_${size}.f32`);
  down((s) => { tmp[0] = irrOnly[3 * s]; tmp[1] = irrOnly[3 * s + 1]; tmp[2] = irrOnly[3 * s + 2]; return tmp; }, size, `irr_${size}.f32`);
  log(`wrote light_${size}.f32, irr_${size}.f32`);
}
// The full-resolution composed light as an 8-bit sRGB preview (light / 8), for alignment shots.
const img = Buffer.alloc(W * W * 3);
const srgb = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
for (let k = 0; k < W * W; k++) for (let c = 0; c < 3; c++) img[3 * k + c] = srgb(Math.min(1, irr[4 * k + c] / 8));
await sharp(img, { raw: { width: W, height: W, channels: 3 } }).png({ compressionLevel: 3 }).toFile(path.join(base, `light_${W}.png`));
// Coverage raster as an image (white = covered), for D4 comparisons.
await sharp(Buffer.from(covered.map((v) => v * 255)), { raw: { width: W, height: W, channels: 1 } }).png().toFile(path.join(base, 'coverage.png'));
log(`wrote light_${W}.png (sRGB of light/8) and coverage.png`);
