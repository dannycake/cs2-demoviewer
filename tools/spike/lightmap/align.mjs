// Spike (D1): which UV set and transform lands each triangle inside one lightmap chart?
//   node tools/spike/lightmap/align.mjs <map>
// chart.mjs's test (debug_chart_color, one flat colour per chart) per shader, UV set and transform;
// rows are <shader> | <which primitives> | <attribute tested> | <transform>. A wrong UV set or
// transform lands the samples in unrelated charts, so agreement falls towards chance. Then the same
// test per primitive with the rule shrink-lm.mjs uses (TEXCOORD_2 if present, else TEXCOORD_1).
import path from 'node:path';
import { createIO } from '../../lib/gltf.mjs';
import { shouldDrop, vmatOf } from '../../lib/filters.mjs';
import { loadChart, uvAgreement } from './chart.mjs';

const map = process.argv[2];
const chart = await loadChart(map);
const S = 1.14284; // m_worldLightingInfo.m_vLightmapUvScale in world.vwrld_c
const transforms = {
  identity: (u, v) => [u, v],
  flipV: (u, v) => [u, 1 - v],
  'x8/7': (u, v) => [u * S, v * S],
  'x7/8': (u, v) => [u / S, v / S],
};
const mapUv = (a, f) => { const out = new Float32Array(a.length); for (let i = 0; i < a.length; i += 2) { const [u, v] = f(a[i], a[i + 1]); out[i] = u; out[i + 1] = v; } return out; };
const io = await createIO();
const doc = await io.read(path.join('assets/raw', map, 'world.glb'));
const rows = new Map();
const add = (key, all, big) => { const r = rows.get(key) ?? { n: 0, ok: 0, big: 0, bigOk: 0 }; r.n += all.big; r.ok += all.agree; r.big += big.big; r.bigOk += big.agree; rows.set(key, r); };
const buckets = [0, 0.5, 0.8, 0.9, 1.01];
const hist = buckets.slice(1).map(() => ({ prims: 0, tris: 0 }));
const worst = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const p of mesh.listPrimitives()) {
    const { name, shader } = vmatOf(p.getMaterial());
    if (shouldDrop(node.getName(), name, shader, map)) continue;
    const uv1 = p.getAttribute('TEXCOORD_1'), uv2 = p.getAttribute('TEXCOORD_2');
    if (!uv1) continue;
    const idx = p.getIndices()?.getArray();
    const group = uv2 ? 'has TEXCOORD_2' : 'TEXCOORD_1 only', sh = shader.replace('.vfx', '');
    for (const [tn, f] of Object.entries(transforms)) {
      const test = (attr, a) => { const t = mapUv(a.getArray(), f); add(`${sh} | ${group} | ${attr} | ${tn}`, uvAgreement(chart, t, idx, 0), uvAgreement(chart, t, idx, 16)); };
      if (!uv2 || tn === 'identity' || tn === 'flipV') test('TEXCOORD_1', uv1);
      if (uv2 && (tn === 'identity' || tn === 'flipV')) test('TEXCOORD_2', uv2);
    }
    const lm = uv2 ?? uv1;
    if (lm.getArray().every((v) => v === 0)) continue;
    const { big, agree } = uvAgreement(chart, lm.getArray(), idx, 4);
    if (!big) continue;
    const fr = agree / big, b = buckets.findIndex((x, i) => fr >= x && fr < buckets[i + 1]);
    hist[b].prims++; hist[b].tris += (idx ? idx.length : lm.getCount()) / 3;
    if (fr < 0.5) worst.push(`${node.getName()} (${shader}, ${(100 * fr).toFixed(0)}% of ${big})`);
  }
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1).padStart(5) + '%' : '    -');
console.log(`${map}: chart ${chart.W}x${chart.H}; agreement of all triangles, and of triangles >= 16 texels`);
for (const [k, r] of [...rows].sort()) console.log(`  ${k.padEnd(78)} ${pct(r.ok, r.n)} of ${String(r.n).padStart(7)}   big ${pct(r.bigOk, r.big)} of ${String(r.big).padStart(6)}`);
console.log(`per primitive (lightmap UV = TEXCOORD_2 ?? TEXCOORD_1), agreement over triangles >= 4 texels:`);
hist.forEach((h, i) => console.log(`  [${buckets[i]}, ${Math.min(1, buckets[i + 1])}${i === hist.length - 1 ? ']' : ')'}: ${h.prims} primitives, ${h.tris} triangles`));
console.log(`  below 50%: ${worst.length ? worst.join('; ') : 'none'}`);
