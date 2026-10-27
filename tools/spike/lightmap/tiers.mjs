// Spike (Task 1b): what each lighting tier costs in world.glb.gz, through the order Task 4 would use
// (drop -> weld -> simplify -> bake per final vertex -> textures -> meshopt -> gzip).
//   node tools/spike/lightmap/tiers.mjs <map> <tier> [--simplify std|attr|permissive] [--uvweight W]
//        [--hybrid <texels per vertex>] [--range R] [--name <file stem>]
// assets/raw/<map>/world.glb -> assets/spike/lm/<map>/tier-<name>.glb and .glb.gz, plus one JSON line
// of counts and bytes (also appended to assets/spike/lm/<map>/tiers.jsonl).
//
// Tiers:
//   today  shrink-map.mjs as it is: every UV but TEXCOORD_0 stripped, AO (lib/ao.mjs) in COLOR_0.
//   V      CS2's light per final vertex in COLOR_0, no lightmap UV shipped. Before anything is stripped,
//          each source vertex gets its light: the composed lightmap (light_2048.f32: irradiance + the sun
//          through direct_light_shadows, bake.mjs) at its lightmap UV, or for a primitive without one the
//          probes (ambient cube + sun.N.L.(1 - _dlshd.r), full-resolution volumes, as shrink-lm.mjs
//          --vertexlight full). After weld and simplify each final vertex takes the mean of the source
//          vertices of its material at its position (a chart seam has several UVs there: averaged).
//   L      the lightmap UV shipped as TEXCOORD_1 (14-bit) on lightmapped primitives, COLOR_0 (as V) only
//          on the others. L1024 and L2048 are this GLB with a 1024 or 2048 px lightmap.
//   H      hybrid: L's UV only on primitives with at least --hybrid lightmap texels (at 2048) per vertex,
//          where a lightmap carries more than vertices could; V's vertex light on the rest.
// COLOR_0 light is normalized u8 RGBA, rgb = sqrt(min(light / range, 1)) (range 8 Mirage, 16 Nuke, as
// the lightmap's RGBM), decoded in viewer.html (vc=<range>) as rgb^2 * range.
// --vcbits N rounds those codes to N bits per channel.
// --simplify (lightmapped primitives only; the rest always get shrink-map's simplify):
//   std         shrink-map's: gltf-transform simplify, positions only, LockBorder.
//   attr        meshopt simplifyWithAttributes with TEXCOORD_1 as an attribute (weight --uvweight).
//   permissive  attr plus meshopt's Permissive flag: collapses may cross attribute seams.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { compactPrimitive, dedup, flatten, join, meshopt, prune, simplify, simplifyPrimitive, textureCompress, weld } from '@gltf-transform/functions';
import { createIO, countTris, MeshoptEncoder, MeshoptSimplifier } from '../../lib/gltf.mjs';
import { shouldDrop, vmatOf } from '../../lib/filters.mjs';
import { hiddenAtStart, hiddenNodes, parseEntities } from '../../lib/entities.mjs';
import { bakeTint, hasMask, tintMaskPng } from '../../lib/tint.mjs';
import { fitTextures } from '../../lib/alpha.mjs';
import { bakeAo } from '../../lib/ao.mjs';
import { loadChart, uvAgreement } from './chart.mjs';

const args = process.argv.slice(2);
const [map, tier] = args;
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
if (!map || !['today', 'V', 'L', 'H'].includes(tier)) { console.error('usage: tiers.mjs <map> today|V|L|H [...]'); process.exit(2); }
const simplifyMode = opt('--simplify', 'std');
const uvWeight = Number(opt('--uvweight', 1));
const hybridMin = Number(opt('--hybrid', 4));
const range = Number(opt('--range', map === 'de_mirage' ? 8 : 16));
const name = opt('--name', tier);
// --vcbits N: COLOR_0 light codes rounded to N bits per channel (a byte lever for V).
const vcStep = 2 ** (8 - Number(opt('--vcbits', 8)));
const base = path.join('assets/spike/lm', map);
const raw = path.join('assets/raw', map);
const SIMPLIFY = { ratio: 0.35, error: 0.002, lockBorder: true }; // shrink-map.mjs PARAMS.simplify
const t0 = performance.now();
const log = (m) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

const io = await createIO();
const doc = await io.read(path.join(raw, 'world.glb'));
const root = doc.getRoot();
log(`${map} ${name}: read ${countTris(doc)} tris`);

// shrink-map.mjs: entities that start disabled, editor meshes, tints, embedded lights.
const vents = fs.readFileSync(path.join(raw, 'entities', 'default_ents.vents'), 'utf8');
for (const n of hiddenNodes(doc, hiddenAtStart(parseEntities(vents)))) n.dispose();
const failing = new Set();
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const prims = mesh.listPrimitives();
  const bad = prims.filter((p) => { const { name: n, shader } = vmatOf(p.getMaterial()); return shouldDrop(node.getName(), n, shader, map); });
  if (bad.length === prims.length) node.setMesh(null); else bad.forEach((p) => failing.add(p));
}
for (const p of failing) p.dispose();
const baked = new Map();
for (const m of root.listMaterials()) {
  const mask = tintMaskPng(m, raw), tex = m.getBaseColorTexture();
  if (!tex || !hasMask(mask)) continue;
  const f = m.getBaseColorFactor();
  const key = `${tex.getName()}|${mask}|${f.slice(0, 3).map((x) => x.toFixed(3)).join(',')}`;
  let out = baked.get(key);
  if (!out) {
    out = doc.createTexture(`${tex.getName()}_tint${baked.size}`).setImage(await bakeTint(Buffer.from(tex.getImage()), fs.readFileSync(mask), f)).setMimeType('image/png');
    baked.set(key, out);
  }
  m.setBaseColorTexture(out).setBaseColorFactor([1, 1, 1, f[3]]);
}
root.listExtensionsUsed().find((e) => e.extensionName === 'KHR_lights_punctual')?.dispose();
const trisKept = countTris(doc);
log(`dropped editor meshes, baked ${baked.size} tint texture(s): ${trisKept} tris`);

const lightmapUv = (p) => { const uv = p.getAttribute('TEXCOORD_2') ?? p.getAttribute('TEXCOORD_1'); return uv && !uv.getArray().every((v) => v === 0) ? uv : null; };
const stats = { map, tier, name, simplify: tier === 'today' || tier === 'V' ? 'std' : simplifyMode, trisKept };

// Per source vertex light, keyed by material and position (5 mm cells), for V's COLOR_0 and the
// unlightmapped primitives of L and H.
const CELL = 0.005, OFF = 65536, SH = 131072;
const cellKey = (x, y, z) => ((Math.round(x / CELL) + OFF) * SH + (Math.round(y / CELL) + OFF)) * SH + (Math.round(z / CELL) + OFF);
const light = new Map(); // key -> [matId, r, g, b, n, matId, ...]
const matIds = new Map();
const matId = (m) => { if (!matIds.has(m)) matIds.set(m, matIds.size); return matIds.get(m); };
const keepUv = new Set(); // L/H: primitives whose lightmap UV ships

if (tier !== 'today') {
  // A lightmap UV that lands at chance in debug_chart_color is a second material UV (Task 1 D1): removed.
  const chart = await loadChart(map);
  let removed = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const uv = p.getAttribute('TEXCOORD_2') ?? p.getAttribute('TEXCOORD_1');
    if (!uv) continue;
    const { big, agree } = uvAgreement(chart, uv.getArray(), p.getIndices()?.getArray());
    if (big >= 20 && agree < big / 4) { p.setAttribute('TEXCOORD_2', null); p.setAttribute('TEXCOORD_1', null); removed++; }
  }
  // Materials are final after dedup, so the keys made below still name the joined primitives' materials.
  await doc.transform(dedup(), prune({ keepAttributes: true }));
  log(`${removed} primitive(s) with a UV that misses the charts: removed; dedup + prune`);

  const S = 2048;
  const lm = new Float32Array(fs.readFileSync(path.join(base, `light_${S}.f32`)).buffer.slice(0));
  const sample = (u, v, out) => {
    const x = Math.min(S - 1, Math.max(0, u * S - 0.5)), y = Math.min(S - 1, Math.max(0, v * S - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(S - 1, x0 + 1), y1 = Math.min(S - 1, y0 + 1), fx = x - x0, fy = y - y0;
    for (let c = 0; c < 3; c++) {
      const a = lm[3 * (y0 * S + x0) + c], b = lm[3 * (y0 * S + x1) + c], d = lm[3 * (y1 * S + x0) + c], e = lm[3 * (y1 * S + x1) + c];
      out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
  };
  // The probes and the sun, for primitives without a lightmap UV (shrink-lm.mjs --vertexlight full).
  const { parseVolumes, loadAtlas, probe, ambient } = await import('./probes.mjs');
  const vols = parseVolumes(map), A = await loadAtlas(map);
  const env = vents.split(/^====\d+====$/m).find((b) => /classname\s+"light_environment"/.test(b));
  const vec = (k) => /\[([^\]]*)\]/.exec(new RegExp(`^${k}\\s+(.*)$`, 'm').exec(env)[1])[1].split(',').map(Number);
  const [pitch, yaw] = vec('angles'), bright = Number(/^brightness\s+(\S+)/m.exec(env)[1]);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const sun = vec('color').map((c) => lin(c / 255) * bright), rad = Math.PI / 180;
  const toSun = [-Math.cos(pitch * rad) * Math.cos(yaw * rad), -Math.cos(pitch * rad) * Math.sin(yaw * rad), Math.sin(pitch * rad)]; // Source
  log(`light sources: light_${S}.f32, ${vols.length} probe volumes`);

  const tmp = [0, 0, 0];
  let vLm = 0, vProbe = 0, vNone = 0, hybridKept = 0, hybridDropped = 0, texelsKept = 0, texelsAll = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const mid = matId(p.getMaterial());
      const pos = p.getAttribute('POSITION').getArray(), n = pos.length / 3;
      const uvA = lightmapUv(p), uv = uvA?.getArray(), nrm = p.getAttribute('NORMAL')?.getArray();
      // VRF's primitives of one mesh share its vertex buffer: only the vertices this one indexes count.
      const used = new Uint8Array(n), pidx = p.getIndices()?.getArray();
      if (pidx) for (const i of pidx) used[i] = 1; else used.fill(1);
      let nUsed = 0; for (let j = 0; j < n; j++) nUsed += used[j];
      if (uvA && (tier === 'L' || tier === 'H')) {
        let ship = true;
        if (tier === 'H') {
          // Lightmap texels (at 2048) per vertex: under the threshold the vertices sample the light
          // about as densely as the lightmap does, so vertex light loses little.
          const idx = p.getIndices()?.getArray(); let area = 0;
          const cnt = idx ? idx.length : n;
          for (let i = 0; i + 2 < cnt; i += 3) {
            const a = idx ? idx[i] : i, b = idx ? idx[i + 1] : i + 1, c = idx ? idx[i + 2] : i + 2;
            area += Math.abs((uv[2 * b] - uv[2 * a]) * (uv[2 * c + 1] - uv[2 * a + 1]) - (uv[2 * c] - uv[2 * a]) * (uv[2 * b + 1] - uv[2 * a + 1])) / 2;
          }
          ship = area * S * S / nUsed >= hybridMin;
          if (ship) { hybridKept++; texelsKept += area * S * S; } else hybridDropped++;
          texelsAll += area * S * S;
        }
        if (ship) keepUv.add(p);
      }
      for (let j = 0; j < n; j++) {
        if (!used[j]) continue;
        const x = pos[3 * j], y = pos[3 * j + 1], z = pos[3 * j + 2];
        const g = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        if (uv) { sample(uv[2 * j], uv[2 * j + 1], tmp); vLm++; } else {
          let N = [0, 0, 1];
          if (nrm) { const a = nrm[3 * j], b = nrm[3 * j + 1], c = nrm[3 * j + 2]; const gn = [m[0] * a + m[4] * b + m[8] * c, m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c]; const l = Math.hypot(...gn) || 1; N = [gn[2] / l, gn[0] / l, gn[1] / l]; }
          const P = [g[2] / 0.0254 + N[0] * 4, g[0] / 0.0254 + N[1] * 4, g[1] / 0.0254 + N[2] * 4]; // 10 cm off the surface
          const pr = probe(A, vols, P, false, true);
          if (!pr) { tmp[0] = tmp[1] = tmp[2] = 0.05; vNone++; } else {
            const amb = ambient(pr.faces, N), ndl = Math.max(0, N[0] * toSun[0] + N[1] * toSun[1] + N[2] * toSun[2]) * (1 - pr.shadow[0]);
            for (let k = 0; k < 3; k++) tmp[k] = amb[k] + sun[k] * ndl;
            vProbe++;
          }
        }
        const key = cellKey(g[0], g[1], g[2]);
        let e = light.get(key);
        if (!e) { e = []; light.set(key, e); }
        let i = 0; while (i < e.length && e[i] !== mid) i += 5;
        if (i === e.length) e.push(mid, 0, 0, 0, 0);
        e[i + 1] += tmp[0]; e[i + 2] += tmp[1]; e[i + 3] += tmp[2]; e[i + 4]++;
      }
    }
  }
  Object.assign(stats, { srcVerticesLightmap: vLm, srcVerticesProbe: vProbe, srcVerticesNoProbe: vNone, cells: light.size });
  if (tier === 'H') Object.assign(stats, { hybridMin, hybridPrimsLightmapped: hybridKept, hybridPrimsVertexLit: hybridDropped, hybridTexelSharePct: +(100 * texelsKept / texelsAll).toFixed(1) });
  log(`source vertex light: ${vLm} from the lightmap, ${vProbe} from probes, ${vNone} outside every volume; ${light.size} cells${tier === 'H' ? `; hybrid >= ${hybridMin} texels/vertex: ${hybridKept} primitives keep the UV (${(100 * texelsKept / texelsAll).toFixed(1)} % of the instances' lightmap texels), ${hybridDropped} vertex-lit` : ''}`);
}

// Strip: only POSITION, TEXCOORD_0 and (L/H) the lightmap UV, moved to TEXCOORD_1.
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  const uv = keepUv.has(p) ? lightmapUv(p) : null;
  for (const s of p.listSemantics()) if (s !== 'POSITION' && s !== 'TEXCOORD_0') p.setAttribute(s, null);
  if (uv) p.setAttribute('TEXCOORD_1', uv);
}
const keep = prune({ keepAttributes: tier === 'L' || tier === 'H' }); // prune() drops TEXCOORD_1 otherwise (no material reads it)
await doc.transform(dedup(), keep, flatten(), join(), weld());
const trisWelded = countTris(doc);

// Simplify: shrink-map's for everything without a lightmap UV; --simplify picks it for the rest.
let simpErr = 0;
for (const mesh of root.listMeshes()) {
  for (const p of mesh.listPrimitives()) {
    const uv = p.getAttribute('TEXCOORD_1');
    if (!uv || simplifyMode === 'std') { simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ...SIMPLIFY }); continue; }
    if (p.getIndices().getCount() < p.getAttribute('POSITION').getCount() / 2) compactPrimitive(p);
    const pos = p.getAttribute('POSITION').getArray(), src = p.getIndices();
    const flags = ['LockBorder', ...(simplifyMode === 'permissive' ? ['Permissive'] : [])];
    const target = Math.floor(SIMPLIFY.ratio * src.getCount() / 3) * 3;
    const [dst, err] = MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(src.getArray()), new Float32Array(pos), 3,
      new Float32Array(p.getAttribute('TEXCOORD_1').getArray()), 2, [uvWeight, uvWeight], null, target, SIMPLIFY.error, flags);
    simpErr = Math.max(simpErr, err);
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(dst).setBuffer(src.getBuffer()));
    if (src.listParents().length === 1) src.dispose();
    compactPrimitive(p);
  }
}
for (const mesh of root.listMeshes()) {
  for (const p of mesh.listPrimitives()) if (p.getIndices().getCount() === 0) p.dispose();
  if (!mesh.listPrimitives().length) mesh.dispose();
}
const tris = countTris(doc);
log(`dedup prune flatten join weld: ${trisWelded} tris; simplify (${stats.simplify}): ${tris} tris`);

// Chart agreement of the shipped lightmap UVs (a collapse across charts shows up here).
if (tier === 'L' || tier === 'H') {
  const chart = await loadChart(map); let big = 0, agree = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const uv = p.getAttribute('TEXCOORD_1'); if (!uv) continue;
    const r = uvAgreement(chart, uv.getArray(), p.getIndices()?.getArray()); big += r.big; agree += r.agree;
  }
  Object.assign(stats, { chartBigTris: big, chartAgreePct: +(100 * agree / big).toFixed(2) });
  log(`final lightmap UVs: ${agree} of ${big} triangles >= 4 texels (at 4096) inside one chart (${(100 * agree / big).toFixed(1)} %)`);
}

// Bake per final vertex.
const users = new Map();
for (const node of root.listNodes()) { const mesh = node.getMesh(); if (mesh) users.set(mesh, (users.get(mesh) ?? 0) + 1); }
stats.sharedMeshes = [...users.values()].filter((n) => n > 1).length;
if (tier === 'today') {
  const ao = bakeAo(doc, { rays: 16, maxDist: 6 });
  log(`AO: ${ao.vertices} vertices in ${ao.seconds.toFixed(1)}s`);
} else {
  // Meshes several nodes share get a copy per node, since the light is per instance.
  let unshared = 0;
  const first = new Set();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(); if (!mesh || users.get(mesh) <= 1) continue;
    if (!first.has(mesh)) { first.add(mesh); continue; }
    const copy = doc.createMesh(mesh.getName());
    for (const p of mesh.listPrimitives()) copy.addPrimitive(p.clone());
    node.setMesh(copy); unshared++;
  }
  let hit = 0, near = 0, other = 0, miss = 0;
  const buffer = root.listBuffers()[0];
  const find = (e, mid) => { if (!e) return -1; for (let i = 0; i < e.length; i += 5) if (e[i] === mid) return i; return -1; };
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      if (p.getAttribute('TEXCOORD_1')) continue;
      const mid = matIds.get(p.getMaterial()) ?? -1;
      const pos = p.getAttribute('POSITION').getArray(), n = pos.length / 3, color = new Uint8Array(n * 4);
      for (let j = 0; j < n; j++) {
        const x = pos[3 * j], y = pos[3 * j + 1], z = pos[3 * j + 2];
        const g = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        const cx = Math.round(g[0] / CELL), cy = Math.round(g[1] / CELL), cz = Math.round(g[2] / CELL);
        let e = light.get(((cx + OFF) * SH + (cy + OFF)) * SH + (cz + OFF)), i = find(e, mid);
        if (i >= 0) hit++;
        else {
          // Rounding put it in a neighbouring cell, or (rarely) another material sits there.
          let best = null, bi = -1, bd = Infinity;
          for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const f = light.get(((cx + dx + OFF) * SH + (cy + dy + OFF)) * SH + (cz + dz + OFF)); const k = find(f, mid);
            if (k >= 0 && dx * dx + dy * dy + dz * dz < bd) { best = f; bi = k; bd = dx * dx + dy * dy + dz * dz; }
          }
          if (best) { e = best; i = bi; near++; } else if (e) { i = 0; other++; } else miss++;
        }
        const c = i >= 0 ? [e[i + 1] / e[i + 4], e[i + 2] / e[i + 4], e[i + 3] / e[i + 4]] : [0.05, 0.05, 0.05];
        for (let k = 0; k < 3; k++) color[4 * j + k] = Math.min(255, Math.round(Math.round(255 * Math.sqrt(Math.min(1, Math.max(0, c[k]) / range))) / vcStep) * vcStep);
        color[4 * j + 3] = 255;
      }
      p.setAttribute('COLOR_0', doc.createAccessor('light').setType('VEC4').setArray(color).setNormalized(true).setBuffer(buffer));
    }
  }
  Object.assign(stats, { unshared, lookupHit: hit, lookupNeighbour: near, lookupOtherMaterial: other, lookupMiss: miss });
  log(`vertex light: ${unshared} shared mesh uses copied; per final vertex ${hit} hits, ${near} in a neighbouring cell, ${other} from another material, ${miss} misses`);
}

let vertsUv1 = 0, vertsOther = 0, trisUv1 = 0;
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  const nv = p.getAttribute('POSITION').getCount();
  if (p.getAttribute('TEXCOORD_1')) { vertsUv1 += nv; trisUv1 += p.getIndices().getCount() / 3; } else vertsOther += nv;
}
await fitTextures(doc, [256, 256]);
await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [256, 256], quality: 60 }));
const texBytes = root.listTextures().reduce((s, t) => s + t.getImage().byteLength, 0);
await doc.transform(keep, meshopt({ encoder: MeshoptEncoder, level: 'high', quantizationVolume: 'scene', quantizePosition: 16, ...(tier === 'L' || tier === 'H' ? { quantizeTexcoord: 14 } : {}) }));
const bytes = await io.writeBinary(doc);
const gz = zlib.gzipSync(bytes, { level: 9 });
const out = path.join(base, `tier-${name}.glb`);
fs.writeFileSync(out, bytes);
fs.writeFileSync(`${out}.gz`, gz);
Object.assign(stats, { tris, trisWithUv1: trisUv1, vertices: vertsUv1 + vertsOther, verticesWithUv1: vertsUv1, textureBytes: texBytes, glbBytes: bytes.byteLength, gzBytes: gz.length, simplifyMaxError: simpErr, seconds: +((performance.now() - t0) / 1000).toFixed(1) });
fs.appendFileSync(path.join(base, 'tiers.jsonl'), `${JSON.stringify(stats)}\n`);
log(`wrote ${out}: ${(bytes.byteLength / 1e6).toFixed(2)} MB, gzip ${(gz.length / 1e6).toFixed(3)} MB; ${tris} tris (${trisUv1} with UV1), ${vertsUv1 + vertsOther} vertices (${vertsUv1} with UV1), textures ${(texBytes / 1e6).toFixed(2)} MB`);
console.log(JSON.stringify(stats));
