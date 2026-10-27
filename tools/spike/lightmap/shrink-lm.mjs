// Spike: a world GLB that keeps the lightmap UV, for lining CS2's lightmaps up in viewer.html.
//   node tools/spike/lightmap/shrink-lm.mjs <map> [--simplify] [--vertexlight full|<step m>]
//        [--texbits N] [--nolm] [--lmshaders <regex>] [--out <file>]
// assets/raw/<map>/world.glb -> assets/spike/lm/<map>/world_lm[_simplified][_vl<arg>].glb
//
// The production drop rule (hidden entities, lib/filters.mjs), then the lightmap UV moves to
// TEXCOORD_1: it is TEXCOORD_2 where a primitive has one (TEXCOORD_1 is then a second material
// UV, Nuke's silo and crates, or all zeros) and TEXCOORD_1 otherwise; an all-zero lightmap UV
// (Nuke's asphalt blend without TEXCOORD_2) is removed, so that primitive counts as unlit.
// NORMAL, TANGENT, COLOR_*, TEXCOORD_2+ and custom attributes go; 256 px WebP textures;
// dedup, prune, flatten, join, weld; --simplify adds shrink-map.mjs's simplify (for D9);
// meshopt with 16-bit texcoords (--texbits: production's default is 12).
// D9 variants: --nolm drops every lightmap UV (the baseline); --lmshaders keeps it only for
// matching shaders; --vertexlight adds COLOR_0 vertex light on unlightmapped primitives.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { dedup, flatten, join, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { createIO, countTris, MeshoptEncoder, MeshoptSimplifier } from '../../lib/gltf.mjs';
import { shouldDrop, vmatOf } from '../../lib/filters.mjs';
import { hiddenAtStart, hiddenNodes, parseEntities } from '../../lib/entities.mjs';
import { fitTextures } from '../../lib/alpha.mjs';

const args = process.argv.slice(2);
const map = args[0];
const doSimplify = args.includes('--simplify');
const texBits = Number(args[args.indexOf('--texbits') + 1]) || 16;
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]
  : path.join('assets/spike/lm', map, `world_lm${doSimplify ? '_simplified' : ''}${args.includes('--vertexlight') ? `_vl${args[args.indexOf('--vertexlight') + 1]}` : ''}.glb`);
const raw = path.join('assets/raw', map);
const t0 = performance.now();
const log = (m) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

const io = await createIO();
const doc = await io.read(path.join(raw, 'world.glb'));
const root = doc.getRoot();
log(`read ${countTris(doc)} tris`);

const vents = path.join(raw, 'entities', 'default_ents.vents');
for (const n of hiddenNodes(doc, hiddenAtStart(parseEntities(fs.readFileSync(vents, 'utf8'))))) n.dispose();
const failing = new Set();
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const prims = mesh.listPrimitives();
  const bad = prims.filter((p) => { const { name, shader } = vmatOf(p.getMaterial()); return shouldDrop(node.getName(), name, shader, map); });
  if (bad.length === prims.length) node.setMesh(null); else bad.forEach((p) => failing.add(p));
}
for (const p of failing) p.dispose();
const lights = root.listExtensionsUsed().find((e) => e.extensionName === 'KHR_lights_punctual');
lights?.dispose();
log(`dropped editor meshes: ${countTris(doc)} tris left`);

// A "lightmap UV" that lands at chance in debug_chart_color (>= 20 triangles of >= 4 texels and
// under a quarter of them inside one chart; real ones score >= 80 %, the one known false one 5 %)
// is a second material UV on an unlightmapped instance (Mirage's
// dust_shipping_crate_02_wood_color_1): it is removed, so the primitive counts as unlit.
const { loadChart, uvAgreement } = await import('./chart.mjs');
const chart = await loadChart(map);
const notLightmap = new Set();
for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
  const uv = p.getAttribute('TEXCOORD_2') ?? p.getAttribute('TEXCOORD_1');
  if (!uv) continue;
  const { big, agree } = uvAgreement(chart, uv.getArray(), p.getIndices()?.getArray());
  if (big >= 20 && agree < big / 4) { notLightmap.add(p); p.setAttribute('TEXCOORD_2', null); p.setAttribute('TEXCOORD_1', null); }
}
log(`${notLightmap.size} primitive(s) whose TEXCOORD_1/2 miss the charts: lightmap UV removed`);
// --lmshaders <regex>: keep the lightmap UV only on primitives whose ShaderName matches (the rest
// get vertex light): what lightmapping only the brushwork would save (D9).
if (args.includes('--lmshaders')) {
  const re = new RegExp(args[args.indexOf('--lmshaders') + 1]);
  let n = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    if (re.test(vmatOf(p.getMaterial()).shader)) continue;
    if (p.getAttribute('TEXCOORD_1') || p.getAttribute('TEXCOORD_2')) { p.setAttribute('TEXCOORD_2', null); p.setAttribute('TEXCOORD_1', null); n++; }
  }
  log(`--lmshaders: lightmap UV removed from ${n} primitive(s) of other shaders`);
}

// --vertexlight full|<step m>: primitives left without a lightmap UV get COLOR_0 = light / 8 (float),
// light = ambient cube of CS2's probes at the vertex (trilinear, smallest volume) + the sun
// (light_environment colour x brightness x max(N.L, 0) x (1 - _dlshd.r)). `full` samples the probe
// volumes themselves; <step> samples a regular grid of that step and interpolates it, as a coarse
// runtime grid would. Meshes shared by several nodes are cloned first, since the light is per instance.
const vlArg = args.includes('--vertexlight') ? args[args.indexOf('--vertexlight') + 1] : null;
let vertexLight = null;
if (vlArg) {
  const { parseVolumes, loadAtlas, probe, ambient } = await import('./probes.mjs');
  const vols = parseVolumes(map), A = await loadAtlas(map);
  const env = fs.readFileSync(vents, 'utf8').split(/^====\d+====$/m).find((b) => /classname\s+"light_environment"/.test(b));
  const vec = (k) => /\[([^\]]*)\]/.exec(new RegExp(`^${k}\\s+(.*)$`, 'm').exec(env)[1])[1].split(',').map(Number);
  const [pitch, yaw] = vec('angles'), bright = Number(/^brightness\s+(\S+)/m.exec(env)[1]);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const sun = vec('color').map((c) => lin(c / 255) * bright), r = Math.PI / 180;
  const toSun = [-Math.cos(pitch * r) * Math.cos(yaw * r), -Math.cos(pitch * r) * Math.sin(yaw * r), Math.sin(pitch * r)]; // Source
  const step = vlArg === 'full' ? 0 : Number(vlArg) / 0.0254;
  const at = (p) => {
    if (!step) return probe(A, vols, p, false, true);
    // Trilinear between the centres of a regular grid (cells sampled with the nearest probe).
    const g = p.map((x) => x / step - 0.5), i0 = g.map(Math.floor), w = g.map((x, i) => x - i0[i]);
    const faces = [0, 1, 2, 3, 4, 5].map(() => [0, 0, 0]), shadow = [0, 0, 0, 0]; let wsum = 0;
    for (let c = 0; c < 8; c++) {
      const d = [c & 1, (c >> 1) & 1, (c >> 2) & 1], q = i0.map((x, i) => (x + d[i] + 0.5) * step);
      const wt = d.reduce((s, b, i) => s * (b ? w[i] : 1 - w[i]), 1), pr = probe(A, vols, q);
      if (!pr || !wt) continue; wsum += wt;
      pr.faces.forEach((f, fi) => f.forEach((v, k) => { faces[fi][k] += wt * v; }));
      pr.shadow.forEach((v, k) => { shadow[k] += wt * v; });
    }
    if (!wsum) return null;
    return { faces: faces.map((f) => f.map((v) => v / wsum)), shadow: shadow.map((v) => v / wsum) };
  };
  vertexLight = (node, prim) => {
    const m = node.getWorldMatrix(), pos = prim.getAttribute('POSITION').getArray(), nrm = prim.getAttribute('NORMAL')?.getArray();
    const n = pos.length / 3, out = new Float32Array(n * 3);
    for (let j = 0; j < n; j++) {
      const x = pos[3 * j], y = pos[3 * j + 1], z = pos[3 * j + 2];
      const g = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
      let N = [0, 0, 1];
      if (nrm) { const a = nrm[3 * j], b = nrm[3 * j + 1], c = nrm[3 * j + 2]; const gn = [m[0] * a + m[4] * b + m[8] * c, m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c]; const l = Math.hypot(...gn) || 1; N = [gn[2] / l, gn[0] / l, gn[1] / l]; }
      const P = [g[2] / 0.0254, g[0] / 0.0254, g[1] / 0.0254];
      const pr = at(P.map((v, i) => v + N[i] * 4)); // 10 cm off the surface
      if (!pr) { out.set([0.05, 0.05, 0.05], 3 * j); continue; }
      const amb = ambient(pr.faces, N), ndl = Math.max(0, N[0] * toSun[0] + N[1] * toSun[1] + N[2] * toSun[2]) * (1 - pr.shadow[0]);
      for (let k = 0; k < 3; k++) out[3 * j + k] = (amb[k] + sun[k] * ndl) / 8;
    }
    return doc.createAccessor().setType('VEC3').setArray(out);
  };
  log(`vertex light from ${vlArg === 'full' ? 'the probe volumes' : `a ${vlArg} m grid`}`);
}

const counts = { fromTexcoord2: 0, fromTexcoord1: 0, zeroUv: 0, none: 0, vertexLit: 0 };
if (vertexLight) {
  // Unshare meshes that carry unlightmapped primitives, so each instance gets its own light.
  const users = new Map();
  for (const node of root.listNodes()) { const mesh = node.getMesh(); if (mesh) users.set(mesh, (users.get(mesh) ?? 0) + 1); }
  for (const node of root.listNodes()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    const unlit = (p) => { const uv = p.getAttribute('TEXCOORD_2') ?? p.getAttribute('TEXCOORD_1'); return !uv || uv.getArray().every((v) => v === 0); };
    if (users.get(mesh) > 1 && mesh.listPrimitives().some(unlit)) {
      const copy = doc.createMesh(mesh.getName());
      for (const p of mesh.listPrimitives()) copy.addPrimitive(unlit(p) ? p.clone() : p);
      node.setMesh(copy);
    }
    for (const p of node.getMesh().listPrimitives()) if (unlit(p) && !p.getAttribute('COLOR_0_VL')) { p.setAttribute('COLOR_0_VL', vertexLight(node, p)); counts.vertexLit++; }
  }
}
for (const mesh of root.listMeshes()) {
  for (const p of mesh.listPrimitives()) {
    const uv2 = p.getAttribute('TEXCOORD_2');
    let lmuv = uv2 ?? p.getAttribute('TEXCOORD_1');
    if (uv2) counts.fromTexcoord2++; else if (lmuv) counts.fromTexcoord1++; else counts.none++;
    if (lmuv && lmuv.getArray().every((v) => v === 0)) { counts.zeroUv++; lmuv = null; }
    const vl = p.getAttribute('COLOR_0_VL');
    for (const s of p.listSemantics()) if (s !== 'POSITION' && s !== 'TEXCOORD_0') p.setAttribute(s, null);
    if (lmuv && !args.includes('--nolm')) p.setAttribute('TEXCOORD_1', lmuv);
    else if (vl) p.setAttribute('COLOR_0', vl);
  }
}
log(`lightmap UV: ${JSON.stringify(counts)}`);

// prune() would drop TEXCOORD_1 (no material reads it) unless keepAttributes is set.
const keep = prune({ keepAttributes: true });
await doc.transform(dedup(), keep, flatten(), join(), weld());
log(`dedup prune flatten join weld: ${countTris(doc)} tris, ${root.listMeshes().length} meshes`);
if (doSimplify) {
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.35, error: 0.002, lockBorder: true }));
  log(`simplify: ${countTris(doc)} tris`);
}
await fitTextures(doc, [256, 256]);
await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [256, 256], quality: 60 }));
await doc.transform(keep, meshopt({ encoder: MeshoptEncoder, level: 'high', quantizationVolume: 'scene', quantizePosition: 16, quantizeTexcoord: texBits }));
let lmTris = 0, otherTris = 0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) { const t = (p.getIndices()?.getCount() ?? 0) / 3; if (p.getAttribute('TEXCOORD_1')) lmTris += t; else otherTris += t; }
const bytes = await io.writeBinary(doc);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, bytes);
log(`wrote ${out} ${(bytes.byteLength / 1e6).toFixed(1)} MB, ${lmTris + otherTris} tris (${lmTris} with a lightmap UV, ${otherTris} without), ${root.listTextures().length} textures`);
