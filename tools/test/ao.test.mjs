import { Document } from '@gltf-transform/core';
import { bakeAo, triangleSoup } from '../lib/ao.mjs';

// A 4x4 m floor (8x8 grid of quads, y = 0) with a 1 m cube centred on it (y 0..1),
// both indexed; the cube is a separate node translated up by 0.5 m so world
// matrices are exercised.
function scene() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = (pos, idx) => doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer));

  const fpos = [], fidx = [];
  for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) fpos.push(-2 + i * 0.5, 0, -2 + j * 0.5);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const a = j * 9 + i, b = a + 1, c = a + 9, d = c + 1;
    fidx.push(a, c, b, b, c, d); // counter-clockwise seen from +y
  }
  const floor = prim(fpos, fidx);

  // cube centred at the origin, 24 vertices (4 per face) so face normals stay sharp
  const cpos = [], cidx = [];
  const faces = [ // [normal axis, sign]
    [0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1],
  ];
  for (const [ax, s] of faces) {
    const u = (ax + 1) % 3, v = (ax + 2) % 3, base = cpos.length / 3;
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0]; p[ax] = 0.5 * s; p[u] = 0.5 * du; p[v] = 0.5 * dv; cpos.push(...p);
    }
    if (s > 0) cidx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else cidx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const cube = prim(cpos, cidx);

  const sceneNode = doc.createScene();
  sceneNode.addChild(doc.createNode('floor').setMesh(doc.createMesh('floor').addPrimitive(floor)));
  sceneNode.addChild(doc.createNode('cube').setTranslation([0, 0.5, 0]).setMesh(doc.createMesh('cube').addPrimitive(cube)));
  return { doc, floor, cube, fpos };
}

const vertexAt = (pos, x, z) => {
  for (let i = 0; i < pos.length / 3; i++) if (pos[i * 3] === x && pos[i * 3 + 2] === z) return i;
  throw new Error(`no floor vertex at ${x},${z}`);
};

test('bakeAo writes a normalized u8 COLOR_0 on every primitive, darker next to the cube', () => {
  const { doc, floor, cube, fpos } = scene();
  const res = bakeAo(doc, { rays: 16 });
  expect(res.vertices).toBe(81 + 24);
  expect(res.seconds).toBeGreaterThanOrEqual(0);

  for (const p of [floor, cube]) {
    const c = p.getAttribute('COLOR_0');
    expect(c).toBeTruthy();
    expect(c.getType()).toBe('VEC4');
    expect(c.getNormalized()).toBe(true);
    expect(c.getArray()).toBeInstanceOf(Uint8Array);
    expect(c.getCount()).toBe(p.getAttribute('POSITION').getCount());
    for (const g of c.getArray()) { expect(g).toBeGreaterThanOrEqual(64); expect(g).toBeLessThanOrEqual(255); }
  }

  const col = floor.getAttribute('COLOR_0').getArray();
  const grey = (i) => col[i * 4];
  const nearCube = vertexAt(fpos, 1, 0);   // nearest floor vertex outside the cube's base, 0.5 m from its face
  const corner = vertexAt(fpos, 2, 2);
  const under = vertexAt(fpos, 0, 0);      // under the cube
  expect(grey(nearCube)).toBeLessThan(grey(corner));
  expect(grey(under)).toBeLessThan(grey(nearCube));
  expect(col[corner * 4 + 3]).toBe(255);   // alpha stays opaque
  expect(grey(corner)).toBeGreaterThan(200); // an almost open corner is almost white
});

test('bakeAo is deterministic', () => {
  const a = scene(), b = scene();
  bakeAo(a.doc); bakeAo(b.doc);
  expect(Buffer.from(a.floor.getAttribute('COLOR_0').getArray())).toEqual(Buffer.from(b.floor.getAttribute('COLOR_0').getArray()));
});

// A 1×1 m quad at y = 0 facing up, alone in its document; the occluder document holds a
// 4×4 m roof 1 m above it.
function quadUnderRoof() {
  const quadDoc = (y, half, flip) => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const pos = [-half, y, -half, half, y, -half, -half, y, half, half, y, half];
    const idx = flip ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3];
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer));
    doc.createScene().addChild(doc.createNode('quad').setMesh(doc.createMesh('quad').addPrimitive(prim)));
    return { doc, prim };
  };
  return { quad: quadDoc(0, 0.5, false), roof: quadDoc(1, 2, true) };
}

test('bakeAo with occluders: their triangles shade the document but are not baked', () => {
  const alone = quadUnderRoof().quad;
  bakeAo(alone.doc);
  const { quad, roof } = quadUnderRoof();
  const res = bakeAo(quad.doc, { occluders: roof.doc });
  expect(res.vertices).toBe(4);
  const grey = (p) => p.getAttribute('COLOR_0').getArray()[0];
  expect(grey(alone.prim)).toBe(255);
  expect(grey(quad.prim)).toBeLessThan(200);
  expect(roof.prim.getAttribute('COLOR_0')).toBeNull();
});

test('bakeAo leaves out occluder triangles no ray can reach: the same colours from fewer triangles', () => {
  const near = quadUnderRoof();
  const a = bakeAo(near.quad.doc, { occluders: near.roof.doc });
  // the same roof, plus a floor 20 m away (beyond maxDist 6 m of every vertex)
  const far = quadUnderRoof();
  const pos = [30, 0, 30, 31, 0, 30, 30, 0, 31];
  const buffer = far.roof.doc.getRoot().listBuffers()[0];
  far.roof.doc.getRoot().listScenes()[0].addChild(far.roof.doc.createNode('far').setMesh(far.roof.doc.createMesh('far').addPrimitive(
    far.roof.doc.createPrimitive().setAttribute('POSITION', far.roof.doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer)))));
  const b = bakeAo(far.quad.doc, { occluders: far.roof.doc });
  expect(a.occluderTris).toBe(2);
  expect(b.occluderTris).toBe(2);
  expect(Buffer.from(far.quad.prim.getAttribute('COLOR_0').getArray())).toEqual(Buffer.from(near.quad.prim.getAttribute('COLOR_0').getArray()));
});

test('triangleSoup: world-space triangles of every mesh node, or of one subtree, or within a box', () => {
  const { doc } = scene();
  const all = triangleSoup(doc);
  expect(all).toBeInstanceOf(Float32Array);
  expect(all.length).toBe((128 + 12) * 9);
  const cube = doc.getRoot().listNodes().find((n) => n.getName() === 'cube');
  const only = triangleSoup(doc, { under: cube });
  expect(only.length).toBe(12 * 9);
  expect(Math.min(...only.filter((_, i) => i % 3 === 1))).toBe(0); // translated up 0.5 m: y 0..1
  const box = triangleSoup(doc, { within: { min: [1.6, -1, 1.6], max: [3, 1, 3] } });
  expect(box.length).toBe(2 * 9); // the floor's corner quad only
});

test('triangleSoup decodes quantized (normalized integer) positions', () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3')
    .setArray(new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0])).setNormalized(true).setBuffer(buffer));
  doc.createScene().addChild(doc.createNode('q').setScale([2, 2, 2]).setMesh(doc.createMesh('q').addPrimitive(prim)));
  expect([...triangleSoup(doc)]).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
});
