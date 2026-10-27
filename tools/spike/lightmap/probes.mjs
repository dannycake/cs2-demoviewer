// Spike (D6, D7): CS2's light probe volumes (env_combined_light_probe_volume) and their atlas.
//   node tools/spike/lightmap/probes.mjs <map> radar <sourceZ> [flipy]   top-down check against radar.png
//   node tools/spike/lightmap/probes.mjs <map> grid <step m> [--floor H]    coarse grid -> probes.bin(.gz) size
//   node tools/spike/lightmap/probes.mjs <map> faces                       which face looks which way
// Atlas layout (D6): env_light_probe_volume_atlas is W x H x 6D; face f of a volume is the block
// z in [f*D, f*D + D) (Mirage D = 64, Nuke 108), the volume at (light_probe_atlas_x, _y, _z + f*D)
// with light_probe_size_{x,y,z} texels. A volume's box is box_mins..box_maxs relative to its
// origin, and its probes fill the box like texel centres: probe i sits at
// mins + (i + 0.5) * (maxs - mins) / size. _dlshd is W x H x D, RGBA, no faces.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { readExr } from './exr.mjs';

// Face f's direction in Source axes. Not Source 1's ambient-cube order (+x -x +y -y +z -z): `faces`
// below matched each face against the lightmap of surfaces facing each axis.
export const FACES = ['+x', '+y', '+z', '-x', '-y', '-z'];

export function parseVolumes(map) {
  const text = fs.readFileSync(path.join('assets/raw', map, 'entities', 'default_ents.vents'), 'utf8');
  const vols = [];
  for (const block of text.split(/^====\d+====$/m)) {
    const kv = {};
    for (const line of block.split('\n')) { const m = /^(\S+)\s+(.*)$/.exec(line.trim()); if (m) kv[m[1]] = m[2].trim(); }
    if (!/light_probe_volume"$/.test(kv.classname ?? '')) continue;
    const v = (k) => kv[k].replace(/[\[\]"]/g, '').split(',').map(Number);
    const vol = { classname: kv.classname.replace(/"/g, ''), origin: v('origin'), mins: v('box_mins'), maxs: v('box_maxs'),
      size: ['x', 'y', 'z'].map((a) => +kv[`light_probe_size_${a}`]), atlas: ['x', 'y', 'z'].map((a) => +kv[`light_probe_atlas_${a}`]) };
    vol.lo = vol.mins.map((m, i) => vol.origin[i] + m); vol.hi = vol.maxs.map((m, i) => vol.origin[i] + m);
    vol.volume = vol.size[0] * vol.size[1] * vol.size[2];
    vols.push(vol);
  }
  return vols.sort((a, b) => a.volume - b.volume); // smallest (most detailed) first
}

export async function loadAtlas(map) {
  const dir = path.join('assets/spike/lm', map, 'maps', map, 'lightmaps');
  const exrs = fs.readdirSync(dir).filter((f) => /^env_light_probe_volume_atlas_z\d+\.exr$/.test(f)).sort();
  const pngs = fs.readdirSync(dir).filter((f) => /^env_light_probe_volume_atlas_dlshd_z\d+\.png$/.test(f)).sort();
  const D = pngs.length;
  if (exrs.length !== 6 * D) throw new Error(`${exrs.length} atlas slices for ${D} dlshd slices`);
  let W, H, rgb;
  exrs.forEach((f, z) => {
    const e = readExr(path.join(dir, f));
    if (!rgb) { W = e.width; H = e.height; rgb = new Float32Array(W * H * 6 * D * 3); }
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) rgb[(z * W * H + i) * 3 + c] = e.data[4 * i + c];
  });
  const sh = new Uint8Array(W * H * D * 4);
  for (let z = 0; z < D; z++) sh.set(await sharp(path.join(dir, pngs[z])).ensureAlpha().raw().toBuffer(), z * W * H * 4);
  return { W, H, D, rgb, sh };
}

/** The probe of `vol` nearest to Source point p: 6 faces x RGB and the 4 _dlshd channels (0-1), or null outside. */
export function probeAt(A, vol, p, flipY = false) {
  const t = [0, 1, 2].map((i) => (p[i] - vol.lo[i]) / (vol.hi[i] - vol.lo[i]));
  if (t.some((x) => x < 0 || x > 1)) return null;
  if (flipY) t[1] = 1 - t[1];
  const [x, y, z] = t.map((x, i) => vol.atlas[i] + Math.min(vol.size[i] - 1, Math.floor(x * vol.size[i])));
  const faces = [];
  for (let f = 0; f < 6; f++) { const o = (((f * A.D + z) * A.H + y) * A.W + x) * 3; faces.push([A.rgb[o], A.rgb[o + 1], A.rgb[o + 2]]); }
  const so = ((z * A.H + y) * A.W + x) * 4;
  return { faces, shadow: [0, 1, 2, 3].map((c) => A.sh[so + c] / 255) };
}

/** Trilinear probe of `vol` at Source point p between its texel centres (clamped to the volume), or null outside. */
export function probeLerp(A, vol, p) {
  const t = [0, 1, 2].map((i) => (p[i] - vol.lo[i]) / (vol.hi[i] - vol.lo[i]));
  if (t.some((x) => x < 0 || x > 1)) return null;
  const f = t.map((x, i) => Math.min(vol.size[i] - 1, Math.max(0, x * vol.size[i] - 0.5)));
  const i0 = f.map(Math.floor), w = f.map((x, i) => x - i0[i]);
  const faces = FACES.map(() => [0, 0, 0]), shadow = [0, 0, 0, 0];
  for (let c = 0; c < 8; c++) {
    const d = [c & 1, (c >> 1) & 1, (c >> 2) & 1];
    const q = i0.map((x, i) => vol.atlas[i] + Math.min(vol.size[i] - 1, x + d[i]));
    const wt = d.reduce((s, b, i) => s * (b ? w[i] : 1 - w[i]), 1);
    if (!wt) continue;
    for (let fi = 0; fi < 6; fi++) { const o = (((fi * A.D + q[2]) * A.H + q[1]) * A.W + q[0]) * 3; for (let k = 0; k < 3; k++) faces[fi][k] += wt * A.rgb[o + k]; }
    const so = ((q[2] * A.H + q[1]) * A.W + q[0]) * 4;
    for (let k = 0; k < 4; k++) shadow[k] += wt * A.sh[so + k] / 255;
  }
  return { faces, shadow };
}

/** Light arriving at a surface with Source normal n from an ambient cube (sum of n_axis^2 * the face n points at). */
export function ambient(faces, n) {
  const out = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const f = faces[FACES.indexOf(`${n[a] >= 0 ? '+' : '-'}${'xyz'[a]}`)];
    for (let k = 0; k < 3; k++) out[k] += n[a] * n[a] * f[k];
  }
  return out;
}

/** The probe from the smallest volume containing p (CS2 lets detail volumes override the map-wide one). */
export function probe(A, vols, p, flipY, lerp = false) {
  for (const v of vols) { const r = lerp ? probeLerp(A, v, p) : probeAt(A, v, p, flipY); if (r) return r; }
  return null;
}

// Face order check: for lightmapped triangles whose normal is (nearly) a Source axis, compare the
// lightmap irradiance (irr_2048.f32, sun not in it) with each face of the probe 0.3 m off the
// surface. The face that sees what the surface sees is the one pointing along its normal.
async function faces(map, A, vols) {
  const { createIO } = await import('../../lib/gltf.mjs');
  const { shouldDrop, vmatOf } = await import('../../lib/filters.mjs');
  const S = 2048, irr = new Float32Array(fs.readFileSync(path.join('assets/spike/lm', map, `irr_${S}.f32`)).buffer.slice(0));
  const io = await createIO();
  const doc = await io.read(path.join('assets/raw', map, 'world.glb'));
  const rows = FACES.map(() => FACES.map(() => []));
  const lmDir = path.join('assets/spike/lm', map, 'maps', map, 'lightmaps');
  const dls = await sharp(path.join(lmDir, 'direct_light_shadows.png')).raw().toBuffer({ resolveWithObject: true });
  const agree = [[0, 0], [0, 0]]; // [lightmap says lit, shadowed] x [probe _dlshd ch0 < 0.5, >= 0.5]
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const { name, shader } = vmatOf(prim.getMaterial());
      if (shouldDrop(node.getName(), name, shader, map)) continue;
      const uvA = prim.getAttribute('TEXCOORD_2') ?? prim.getAttribute('TEXCOORD_1'); if (!uvA) continue;
      const uv = uvA.getArray(), pos = prim.getAttribute('POSITION').getArray(), idx = prim.getIndices()?.getArray();
      const n = idx ? idx.length : pos.length / 3;
      const W = (j) => { const x = pos[3 * j], y = pos[3 * j + 1], z = pos[3 * j + 2]; const g = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; return [g[2] / 0.0254, g[0] / 0.0254, g[1] / 0.0254]; };
      for (let i = 0; i + 2 < n; i += 3 * 7) {
        const t = [0, 1, 2].map((k) => (idx ? idx[i + k] : i + k)), P = t.map(W);
        const e1 = P[1].map((v, c) => v - P[0][c]), e2 = P[2].map((v, c) => v - P[0][c]);
        const N = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(...N); if (len < 400) continue; // > 200 square units
        // Source is right-handed with Z up and glTF is (y, z, x), also right-handed: winding is kept.
        const nn = N.map((v) => v / len), axis = nn.findIndex((v) => Math.abs(v) > 0.95); if (axis < 0) continue;
        const dirFace = FACES.indexOf(`${nn[axis] > 0 ? '+' : '-'}${'xyz'[axis]}`);
        const c = [0, 1, 2].map((k) => (P[0][k] + P[1][k] + P[2][k]) / 3);
        const pr = probe(A, vols, c.map((v, k) => v + nn[k] * 12)); if (!pr) continue;
        const u = (uv[2 * t[0]] + uv[2 * t[1]] + uv[2 * t[2]]) / 3, v = (uv[2 * t[0] + 1] + uv[2 * t[1] + 1] + uv[2 * t[2] + 1]) / 3;
        const o = 3 * (Math.min(S - 1, Math.floor(v * S)) * S + Math.min(S - 1, Math.floor(u * S)));
        const L = irr[o] + irr[o + 1] + irr[o + 2]; if (L < 0.05) continue;
        pr.faces.forEach((f, fi) => rows[dirFace][fi].push(Math.log2((f[0] + f[1] + f[2]) / L)));
        if (dirFace === FACES.indexOf('+z')) {
          const DW = dls.info.width, ls = dls.data[(Math.min(DW - 1, Math.floor(v * DW)) * DW + Math.min(DW - 1, Math.floor(u * DW))) * dls.info.channels] / 255;
          if (ls < 0.1 || ls > 0.9) agree[ls > 0.9 ? 1 : 0][pr.shadow[0] >= 0.5 ? 1 : 0]++;
        }
      }
    }
  }
  console.log('median log2(probe face / lightmap irradiance), rows = surface normal, columns = probe face (order ' + FACES.join(' ') + ')');
  rows.forEach((r, di) => {
    const med = r.map((a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; });
    const spread = r.map((a) => (a.length ? (a[Math.floor(a.length * 0.75)] - a[Math.floor(a.length * 0.25)]) : NaN));
    console.log(`  normal ${FACES[di]} (${r[0].length} tris): ${med.map((x, i) => `${x.toFixed(2)}±${spread[i].toFixed(2)}`).join('  ')}`);
  });
  console.log(`floors (normal +z): lightmap sun channel lit -> probe _dlshd ch0 < 0.5: ${agree[0][0]}, >= 0.5: ${agree[0][1]}; lightmap shadowed -> < 0.5: ${agree[1][0]}, >= 0.5: ${agree[1][1]}`);
}

async function main() {
  const [map, mode, a1, a2] = process.argv.slice(2);
  const vols = parseVolumes(map);
  const A = await loadAtlas(map);
  console.log(`${map}: ${vols.length} volumes, atlas ${A.W}x${A.H}x(6x${A.D}), ${vols.reduce((s, v) => s + v.volume, 0)} probes`);
  if (mode === 'faces') await faces(map, A, vols);
  if (mode === 'radar') {
    // Average of the six faces at height a1 (Source units), drawn over radar.png in its own space.
    const z = Number(a1), flipY = a2 === 'flipy';
    const ov = fs.readFileSync(path.join('assets/raw', map, 'overview.txt'), 'utf8');
    const num = (k) => Number(new RegExp(`"${k}"\\s+"([^"]+)"`).exec(ov)[1]);
    const [px, py, sc] = [num('pos_x'), num('pos_y'), num('scale')];
    const R = 1024, radar = await sharp(path.join('assets/raw', map, 'radar.png')).resize(R, R).removeAlpha().raw().toBuffer();
    const out = Buffer.alloc(R * R * 3);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const p = [px + i * sc, py - j * sc, z], pr = probe(A, vols, p, flipY), o = 3 * (j * R + i);
      if (!pr) { for (let c = 0; c < 3; c++) out[o + c] = radar[o + c] >> 2; continue; }
      for (let c = 0; c < 3; c++) {
        const v = pr.faces.reduce((s, f) => s + f[c], 0) / 6;
        const g = Math.round(255 * Math.min(1, v / 1.5) ** (1 / 2.2));
        out[o + c] = (g * 3 + radar[o + c]) >> 2;
      }
    }
    const file = path.join('assets/spike', `m2a-${map.replace('de_', '')}-probes-z${z}${flipY ? '-flipy' : ''}.png`);
    await sharp(out, { raw: { width: R, height: R, channels: 3 } }).png().toFile(file);
    console.log(file);
  }
  if (mode === 'grid') {
    // probes.bin: a regular grid over the union of the volumes' boxes at `step` metres; each cell
    // 6 faces x RGB as RGBM-free half floats would be 36 B; here 6 x RGB9E5-like 4 B = 24 B, plus
    // 1 B sun visibility. Cells no volume covers are skipped by a 1-bit mask.
    const step = Number(a1) / 0.0254;
    const lo = [0, 1, 2].map((i) => Math.min(...vols.map((v) => v.lo[i]))), hi = [0, 1, 2].map((i) => Math.max(...vols.map((v) => v.hi[i])));
    const n = [0, 1, 2].map((i) => Math.ceil((hi[i] - lo[i]) / step));
    const cells = n[0] * n[1] * n[2];
    // --floor H: keep only cells whose centre is 0..H m above an upward-facing surface of the world's
    // collision mesh (players stand on those), by column: each up-facing triangle marks the columns its
    // bounding box overlaps with its height range.
    const floorArg = process.argv.indexOf('--floor'), floorH = floorArg > 0 ? Number(process.argv[floorArg + 1]) / 0.0254 : 0;
    let nearFloor = null;
    if (floorH) {
      const { createIO } = await import('../../lib/gltf.mjs');
      const { shouldDrop } = await import('../../lib/filters.mjs');
      const io = await createIO();
      const doc = await io.read(path.join('assets/raw', map, 'world_collision.glb'));
      nearFloor = new Uint8Array(cells);
      for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh(); if (!mesh || shouldDrop(node.getName(), '', '', map)) continue;
        const m = node.getWorldMatrix();
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION').getArray(), idx = prim.getIndices()?.getArray(), cnt = idx ? idx.length : pos.length / 3;
          const W = (j) => { const x = pos[3 * j], y = pos[3 * j + 1], z = pos[3 * j + 2]; const g = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; return [g[2] / 0.0254, g[0] / 0.0254, g[1] / 0.0254]; };
          for (let t = 0; t + 2 < cnt; t += 3) {
            const P = [0, 1, 2].map((k) => W(idx ? idx[t + k] : t + k));
            const e1 = P[1].map((v, c) => v - P[0][c]), e2 = P[2].map((v, c) => v - P[0][c]);
            const N = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            if (N[2] / (Math.hypot(...N) || 1) < 0.7) continue; // walkable: within ~45 degrees of up
            const i0 = Math.max(0, Math.floor((Math.min(P[0][0], P[1][0], P[2][0]) - lo[0]) / step)), i1 = Math.min(n[0] - 1, Math.floor((Math.max(P[0][0], P[1][0], P[2][0]) - lo[0]) / step));
            const j0 = Math.max(0, Math.floor((Math.min(P[0][1], P[1][1], P[2][1]) - lo[1]) / step)), j1 = Math.min(n[1] - 1, Math.floor((Math.max(P[0][1], P[1][1], P[2][1]) - lo[1]) / step));
            const zlo = Math.min(P[0][2], P[1][2], P[2][2]), zhi = Math.max(P[0][2], P[1][2], P[2][2]) + floorH;
            const k0 = Math.max(0, Math.floor((zlo - lo[2]) / step - 0.5)), k1 = Math.min(n[2] - 1, Math.ceil((zhi - lo[2]) / step - 0.5));
            for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) nearFloor[(k * n[1] + j) * n[0] + i] = 1;
          }
        }
      }
    }
    const maskBits = new Uint8Array(Math.ceil(cells / 8));
    const payload = [];
    let filled = 0;
    for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
      const p = [lo[0] + (i + 0.5) * step, lo[1] + (j + 0.5) * step, lo[2] + (k + 0.5) * step];
      if (nearFloor && !nearFloor[(k * n[1] + j) * n[0] + i]) continue;
      const pr = probe(A, vols, p, false);
      if (!pr) continue;
      const c = (k * n[1] + j) * n[0] + i; maskBits[c >> 3] |= 1 << (c & 7); filled++;
      for (const f of pr.faces) payload.push(...f.map((x) => Math.round(Math.min(1, Math.sqrt(Math.max(0, x) / 16)) * 255)));
      payload.push(Math.round((1 - pr.shadow[0]) * 255));
    }
    const bin = Buffer.concat([Buffer.from(new Float32Array([...lo, step, ...n]).buffer), Buffer.from(maskBits), Buffer.from(payload)]);
    const gz = zlib.gzipSync(bin, { level: 9 });
    console.log(`grid ${a1} m${floorH ? `, cells up to ${floorH * 0.0254} m above a walkable surface` : ''}: ${n.join('x')} = ${cells} cells, ${filled} kept; probes.bin ${(bin.length / 1e6).toFixed(2)} MB, gzip ${(gz.length / 1e6).toFixed(2)} MB = ${gz.length} B (19 B per cell: 6 faces x RGB8 sqrt(light/16) + sun visibility)`);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
