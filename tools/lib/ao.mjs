// Per-vertex ambient occlusion baked into COLOR_0 (from tools/spike/bake-ao.mjs).
//
// Every triangle of every mesh node goes into one world-space BVH. Each vertex
// then casts `rays` cosine-weighted hemisphere rays (a fixed Fibonacci pattern,
// so the bake is deterministic) around its area-weighted face normal, from 2 cm
// off the surface; a hit at distance d < maxDist occludes by 1 - d/maxDist. The
// stored grey is 0.25 + 0.75·ao as a normalized u8 RGBA with alpha 255.
import { Primitive } from '@gltf-transform/core';
import * as THREE from 'three';
// three-mesh-bvh's package main is a UMD build that require()s a second, CJS copy of three;
// its ESM source shares the one ESM three this module imports.
import { MeshBVH } from 'three-mesh-bvh/src/index.js';

export const AO_DEFAULTS = Object.freeze({ rays: 16, maxDist: 6, offset: 0.02, floor: 0.25 });

const GOLDEN_ANGLE = 2.39996323;

/** Unit hemisphere directions (x, y=up, z), cosine-weighted, Fibonacci spiral. */
function hemisphere(rays) {
  const dirs = [];
  for (let i = 0; i < rays; i++) {
    const u = (i + 0.5) / rays, phi = i * GOLDEN_ANGLE, r = Math.sqrt(u);
    dirs.push([r * Math.cos(phi), Math.sqrt(1 - u), r * Math.sin(phi)]);
  }
  return dirs;
}

/** Index array of a primitive; a non-indexed primitive gets 0..n-1. */
function indicesOf(prim) {
  const idx = prim.getIndices();
  if (idx) return idx.getArray();
  const n = prim.getAttribute('POSITION').getCount();
  const seq = new Uint32Array(n);
  for (let i = 0; i < n; i++) seq[i] = i;
  return seq;
}

/** An accessor's values as floats: its array, decoded when it holds normalized (quantized) integers. */
function floatsOf(acc) {
  if (!acc.getNormalized()) return acc.getArray();
  const n = acc.getElementSize(), out = new Float32Array(acc.getCount() * n), el = [];
  for (let i = 0; i < acc.getCount(); i++) out.set(acc.getElement(i, el), i * n);
  return out;
}

/** Each triangle primitive of the mesh nodes: `{ p, m (world matrix), pos (floats), idx }`. */
function instancesOf(nodes) {
  const out = [];
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== Primitive.Mode.TRIANGLES || !p.getAttribute('POSITION')) continue;
      out.push({ p, m, pos: floatsOf(p.getAttribute('POSITION')), idx: indicesOf(p) });
    }
  }
  return out;
}

/**
 * World-space triangles of `instances`, nine floats each; with `within` (`{ min, max }`, world
 * space) only those whose bounding box meets it.
 */
function soupOf(instances, within) {
  let total = 0;
  for (const { idx } of instances) total += Math.floor(idx.length / 3);
  const soup = new Float32Array(total * 9);
  const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let o = 0;
  for (const { m, pos, idx } of instances) {
    const n = idx.length - (idx.length % 3);
    for (let i = 0; i < n; i += 3) {
      for (let j = 0; j < 3; j++) {
        const k = idx[i + j] * 3;
        tri[j].set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m);
      }
      if (within && [0, 1, 2].some((a) => Math.max(tri[0].getComponent(a), tri[1].getComponent(a), tri[2].getComponent(a)) < within.min[a]
        || Math.min(tri[0].getComponent(a), tri[1].getComponent(a), tri[2].getComponent(a)) > within.max[a])) continue;
      for (const v of tri) { soup[o++] = v.x; soup[o++] = v.y; soup[o++] = v.z; }
    }
  }
  return o === soup.length ? soup : soup.slice(0, o);
}

/**
 * World-space triangles of `doc`'s mesh nodes as a Float32Array, nine floats per triangle:
 * every node's, or only `under` and its descendants'; with `within` (`{ min, max }`, world
 * space) only the triangles whose bounding box meets it. Quantized positions are decoded.
 */
export function triangleSoup(doc, { under, within } = {}) {
  const nodes = [];
  const visit = (node) => { nodes.push(node); node.listChildren().forEach(visit); };
  if (under) visit(under);
  return soupOf(instancesOf(under ? nodes : doc.getRoot().listNodes()), within);
}

/**
 * Adds COLOR_0 (normalized u8 VEC4) to every triangle primitive of every mesh node.
 * A primitive shared by several nodes is baked once, from its first node. The triangles of
 * `occluders` (another document, such as the world around the doors of entities.glb) join the
 * BVH and shade the bake, but that document is not baked and not changed; only its triangles
 * a ray can reach (within maxDist + offset of a baked vertex's bounds) are used.
 * @param {import('@gltf-transform/core').Document} doc
 * @param {{ rays?: number, maxDist?: number, occluders?: import('@gltf-transform/core').Document }} [opts]
 * @returns {{ vertices: number, seconds: number, occluderTris: number }}
 */
export function bakeAo(doc, opts = {}) {
  const t0 = performance.now();
  const rays = opts.rays ?? AO_DEFAULTS.rays;
  const maxDist = opts.maxDist ?? AO_DEFAULTS.maxDist;
  const { offset, floor } = AO_DEFAULTS;
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0] ?? doc.createBuffer();

  // 1. world-space triangle soup of every instance; the bake list holds each primitive once
  const instances = instancesOf(root.listNodes());
  const bake = [], seen = new Set();
  for (const { p, m, idx } of instances) if (!seen.has(p)) { seen.add(p); bake.push({ p, m, idx }); }
  const own = soupOf(instances);
  let occluded = new Float32Array(0);
  if (opts.occluders) {
    // Every ray starts within `offset` of a baked vertex and ends at maxDist.
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const { p, m } of bake) {
      const a = p.getAttribute('POSITION').getArray();
      for (let i = 0; i < a.length; i += 3) box.expandByPoint(v.set(a[i], a[i + 1], a[i + 2]).applyMatrix4(m));
    }
    box.expandByScalar(maxDist + offset);
    occluded = soupOf(instancesOf(opts.occluders.getRoot().listNodes()), { min: box.min.toArray(), max: box.max.toArray() });
  }
  const soup = occluded.length ? new Float32Array(own.length + occluded.length) : own;
  if (occluded.length) { soup.set(own); soup.set(occluded, own.length); }
  const soupTris = soup.length / 9;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  const bvh = soupTris > 0 ? new MeshBVH(geom, { maxLeafTris: 8 }) : null;

  // 2. hemisphere rays per vertex
  const dirs = hemisphere(rays);
  const ray = new THREE.Ray();
  const v = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let vertices = 0;
  for (const { p, m, idx } of bake) {
    const a = p.getAttribute('POSITION').getArray();
    const cnt = a.length / 3;
    const normals = new Float64Array(cnt * 3);
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const i0 = idx[i] * 3, i1 = idx[i + 1] * 3, i2 = idx[i + 2] * 3;
      const e1x = a[i1] - a[i0], e1y = a[i1 + 1] - a[i0 + 1], e1z = a[i1 + 2] - a[i0 + 2];
      const e2x = a[i2] - a[i0], e2y = a[i2 + 1] - a[i0 + 1], e2z = a[i2 + 2] - a[i0 + 2];
      const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
      for (const j of [i0, i1, i2]) { normals[j] += fx; normals[j + 1] += fy; normals[j + 2] += fz; }
    }
    nm.getNormalMatrix(m);
    const color = new Uint8Array(cnt * 4);
    for (let i = 0; i < cnt; i++) {
      n.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]).applyMatrix3(nm);
      if (n.lengthSq() === 0) n.set(0, 1, 0);
      n.normalize();
      v.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(m).addScaledVector(n, offset);
      t.set(1, 0, 0); if (Math.abs(n.x) > 0.9) t.set(0, 1, 0);
      b.crossVectors(n, t).normalize(); t.crossVectors(b, n);
      let occ = 0;
      if (bvh) {
        for (const [dx, dy, dz] of dirs) {
          d.copy(t).multiplyScalar(dx).addScaledVector(n, dy).addScaledVector(b, dz);
          ray.set(v, d);
          const h = bvh.raycastFirst(ray, THREE.DoubleSide, 0, maxDist);
          if (h && h.distance < maxDist) occ += 1 - h.distance / maxDist;
        }
      }
      const ao = Math.max(0, 1 - occ / rays);
      const g = Math.round(255 * (floor + (1 - floor) * ao));
      color[i * 4] = g; color[i * 4 + 1] = g; color[i * 4 + 2] = g; color[i * 4 + 3] = 255;
    }
    p.setAttribute('COLOR_0', doc.createAccessor('ao').setType('VEC4').setArray(color).setNormalized(true).setBuffer(buffer));
    vertices += cnt;
  }
  geom.dispose();
  return { vertices, seconds: (performance.now() - t0) / 1000, occluderTris: occluded.length / 9 };
}
