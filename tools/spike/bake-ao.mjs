// Spike: bake per-vertex AO into COLOR_0 of a meshopt-compressed world GLB.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { meshopt } from '@gltf-transform/functions';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
const [,, inPath, outPath, raysArg = '16'] = process.argv;
const RAYS = +raysArg, MAXDIST = 6.0; // metres (world is in metres, Y-up)
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const t0 = Date.now(); const log = m => console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${m}`);
const doc = await io.read(inPath); const root = doc.getRoot();
// 1. gather world-space triangles from every mesh node
const prims = []; let vtotal = 0, ttotal = 0;
for (const node of root.listNodes()) { const mesh = node.getMesh(); if (!mesh) continue;
  const m = new THREE.Matrix4().fromArray(node.getWorldMatrix());
  for (const p of mesh.listPrimitives()) { const pos = p.getAttribute('POSITION'), idx = p.getIndices(); if (!pos || !idx) continue;
    prims.push({ p, m, pos, idx }); vtotal += pos.getCount(); ttotal += idx.getCount() / 3; } }
log(`prims=${prims.length} verts=${vtotal} tris=${ttotal}`);
const positions = new Float32Array(ttotal * 9); let o = 0; const v = new THREE.Vector3();
for (const { m, pos, idx } of prims) { const a = pos.getArray(), ia = idx.getArray();
  for (let i = 0; i < ia.length; i++) { const k = ia[i] * 3; v.set(a[k], a[k+1], a[k+2]).applyMatrix4(m); positions[o++] = v.x; positions[o++] = v.y; positions[o++] = v.z; } }
const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
const bvh = new MeshBVH(geom, { maxLeafTris: 8 }); log('bvh built');
// 2. per-vertex hemisphere rays around the (area-weighted face) normal
const dirs = []; for (let i = 0; i < RAYS; i++) { // cosine-weighted hemisphere, fixed pattern (Fibonacci)
  const u = (i + 0.5) / RAYS, phi = i * 2.39996323; const r = Math.sqrt(u); dirs.push(new THREE.Vector3(r * Math.cos(phi), Math.sqrt(1 - u), r * Math.sin(phi))); }
const ray = new THREE.Ray(), hit = {}; const n = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
let done = 0;
for (const { p, m, pos, idx } of prims) {
  const cnt = pos.getCount(), a = pos.getArray(), ia = idx.getArray();
  const normals = new Float32Array(cnt * 3), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let i = 0; i < ia.length; i += 3) { const i0 = ia[i]*3, i1 = ia[i+1]*3, i2 = ia[i+2]*3;
    e1.set(a[i1]-a[i0], a[i1+1]-a[i0+1], a[i1+2]-a[i0+2]); e2.set(a[i2]-a[i0], a[i2+1]-a[i0+1], a[i2+2]-a[i0+2]); fn.crossVectors(e1, e2);
    for (const j of [i0, i1, i2]) { normals[j] += fn.x; normals[j+1] += fn.y; normals[j+2] += fn.z; } }
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const color = new Uint8Array(cnt * 4);
  for (let i = 0; i < cnt; i++) {
    n.set(normals[i*3], normals[i*3+1], normals[i*3+2]).applyMatrix3(nm); if (n.lengthSq() === 0) n.set(0,1,0); n.normalize();
    v.set(a[i*3], a[i*3+1], a[i*3+2]).applyMatrix4(m).addScaledVector(n, 0.02);
    t.set(1,0,0); if (Math.abs(n.x) > 0.9) t.set(0,1,0); b.crossVectors(n, t).normalize(); t.crossVectors(b, n);
    let occ = 0;
    for (const dd of dirs) { d.copy(t).multiplyScalar(dd.x).addScaledVector(n, dd.y).addScaledVector(b, dd.z); ray.set(v, d);
      const h = bvh.raycastFirst(ray, THREE.DoubleSide); if (h && h.distance < MAXDIST) occ += 1 - h.distance / MAXDIST; }
    const ao = Math.max(0, 1 - occ / RAYS); const g = Math.round(255 * Math.pow(0.25 + 0.75 * ao, 1.0));
    color[i*4] = g; color[i*4+1] = g; color[i*4+2] = g; color[i*4+3] = 255; }
  const acc = doc.createAccessor('ao').setType('VEC4').setArray(color).setNormalized(true).setBuffer(root.listBuffers()[0]);
  p.setAttribute('COLOR_0', acc);
  done += cnt; if (prims.indexOf(prims.find(x => x.p === p)) % 50 === 0) log(`verts ${done}/${vtotal}`);
}
log('baked');
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
await io.write(outPath, doc);
log(`wrote ${outPath} ${(await import('node:fs')).statSync(outPath).size/1e6} MB`);
