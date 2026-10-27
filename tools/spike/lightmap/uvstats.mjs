// Spike: TEXCOORD_1 ranges in a raw world.glb, by shader, for kept and dropped primitives.
//   node tools/spike/lightmap/uvstats.mjs <map>
import path from 'node:path';
import { createIO } from '../../lib/gltf.mjs';
import { shouldDrop, vmatOf } from '../../lib/filters.mjs';

const map = process.argv[2];
const io = await createIO();
const doc = await io.read(path.join('assets/raw', map, 'world.glb'));
const groups = new Map();
const out = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const p of mesh.listPrimitives()) {
    const { name, shader } = vmatOf(p.getMaterial());
    const drop = shouldDrop(node.getName(), name, shader, map);
    const uv = p.getAttribute('TEXCOORD_1');
    const key = `${drop ? 'DROP ' : ''}${shader}`;
    const g = groups.get(key) ?? { prims: 0, withUv: 0, umin: Infinity, umax: -Infinity, vmin: Infinity, vmax: -Infinity, outside: 0 };
    g.prims++;
    if (uv) {
      g.withUv++;
      const a = uv.getArray();
      let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
      for (let i = 0; i < a.length; i += 2) { umin = Math.min(umin, a[i]); umax = Math.max(umax, a[i]); vmin = Math.min(vmin, a[i + 1]); vmax = Math.max(vmax, a[i + 1]); }
      g.umin = Math.min(g.umin, umin); g.umax = Math.max(g.umax, umax); g.vmin = Math.min(g.vmin, vmin); g.vmax = Math.max(g.vmax, vmax);
      if (umin < 0 || umax > 1 || vmin < 0 || vmax > 1) { g.outside++; out.push({ node: node.getName(), mat: name, shader, drop, umin, umax, vmin, vmax, n: a.length / 2 }); }
    }
    groups.set(key, g);
  }
}
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : '-');
for (const [k, g] of [...groups].sort((a, b) => b[1].prims - a[1].prims)) {
  console.log(`${k.padEnd(48)} prims=${String(g.prims).padStart(5)} uv1=${String(g.withUv).padStart(5)} u=[${f(g.umin)},${f(g.umax)}] v=[${f(g.vmin)},${f(g.vmax)}] outside01=${g.outside}`);
}
console.log(`\nprimitives with TEXCOORD_1 outside [0,1]: ${out.length}`);
for (const o of out.slice(0, 40)) console.log(` ${o.drop ? 'DROP' : 'keep'} ${o.shader} ${o.node} ${o.mat} n=${o.n} u=[${f(o.umin)},${f(o.umax)}] v=[${f(o.vmin)},${f(o.vmax)}]`);
