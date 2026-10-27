import { describe, expect, test } from 'vitest';
import { Document } from '@gltf-transform/core';
import { CELL_H, CELL_W, dropFloaters, layout, rasterize, sideTriangles, trim } from '../weapon-icons.mjs';

// Boxes as triangle meshes in one document: [min, max] corners in glTF metres (y up).
function boxes(list) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('s');
  for (const [a, b] of list) {
    const p = [];
    for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) p.push(x, y, z);
    const idx = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer));
    scene.addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  }
  return doc;
}

const coverage = (alpha, x0, x1) => {
  let n = 0;
  for (let y = 0; y < CELL_H; y++) for (let x = x0; x < x1; x++) n += alpha[y * CELL_W + x];
  return n;
};

describe('sideTriangles and rasterize', () => {
  // A gun along z: a long thin barrel (z 0..0.6) and a tall stock at z 0.6..0.8.
  const gun = [[[0, 0.04, 0], [0.02, 0.06, 0.6]], [[0, 0, 0.6], [0.02, 0.15, 0.8]]];

  test('lays the longest axis across with the thin end to the right', () => {
    const side = sideTriangles(boxes(gun));
    expect(side.axis).toBe('z');
    expect(side.up).toBe('y');
    expect(side.flipped).toBe(true);
    const a = rasterize(side);
    // The stock (tall) is on the left, so the left fifth holds far more ink than the right fifth.
    expect(coverage(a, 0, 32)).toBeGreaterThan(3 * coverage(a, 128, 160));
    expect(a.some((v) => v === 255)).toBe(true);
  });

  test('a knife modelled standing lies down; an upright object keeps +Y up', () => {
    const knife = [[[0, 0, 0], [0.005, 0.3, 0.03]]];
    expect(sideTriangles(boxes(knife))).toMatchObject({ axis: 'y', up: 'z' });
    expect(sideTriangles(boxes(knife), { upright: true })).toMatchObject({ axis: 'z', up: 'y' });
  });

  test('a part floating apart from the body is dropped, an attached one kept', () => {
    const doc = boxes([...gun, [[0, 0.15, 0.3], [0.02, 0.2, 0.35]], [[0, 0, 2], [0.01, 0.01, 2.01]]]);
    const tris = [];
    for (const node of doc.getRoot().listNodes()) {
      const prim = node.getMesh().listPrimitives()[0];
      const pos = prim.getAttribute('POSITION');
      const ind = prim.getIndices();
      for (let i = 0; i < ind.getCount(); i++) tris.push(pos.getElement(ind.getScalar(i), []));
    }
    const kept = dropFloaters(tris);
    expect(kept.dropped).toBe(1);
    expect(kept.tris.length).toBe(3 * 12 * 3);
    // The floater would have stretched the long axis to 2 m.
    expect(sideTriangles(doc).width).toBeCloseTo(0.8, 5);
  });
});

describe('layout', () => {
  test('six columns of fixed cells in the given order', () => {
    const l = layout(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(l).toMatchObject({ cell: [CELL_W, CELL_H], columns: 6, width: 6 * CELL_W, height: 2 * CELL_H });
    expect(l.icons.a).toEqual({ x: 0, y: 0, w: CELL_W, h: CELL_H });
    expect(l.icons.g).toEqual({ x: 0, y: CELL_H, w: CELL_W, h: CELL_H });
    expect(l.icons.f.x).toBe(5 * CELL_W);
  });
});

describe('trim', () => {
  test('narrows a cell to the columns its drawing covers, with a 2 px margin', () => {
    const w = 40;
    const h = 4;
    const alpha = new Uint8Array(w * h);
    for (let x = 10; x <= 20; x++) alpha[1 * w + x] = 255;
    expect(trim(alpha, w, h)).toEqual({ x: 8, w: 15 });
  });
  test('keeps the margin inside the cell and the whole cell when it is empty', () => {
    const w = 10;
    const alpha = new Uint8Array(w);
    alpha[0] = 255;
    alpha[9] = 255;
    expect(trim(alpha, w, 1)).toEqual({ x: 0, w: 10 });
    expect(trim(new Uint8Array(w), w, 1)).toEqual({ x: 0, w: 10 });
  });
});
