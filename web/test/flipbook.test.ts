import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FlipbookBatch,
  frameRect,
  loopFrame,
  onceFrame,
} from '../src/scene/flipbook';
import type { Atlas } from '../src/scene/effects';
import { countCalls } from './helpers/count-calls';

const v = new THREE.Vector4();
const white = new THREE.Color(1, 1, 1);

function atlas(cols: number, rows: number, frames: number): Atlas {
  return {
    texture: new THREE.Texture(),
    cols,
    rows,
    frames,
    sequences: [[0, frames]],
    aspect: 1,
  };
}

describe('frameRect', () => {
  it('counts frames from the top-left cell, row by row', () => {
    frameRect({ cols: 16, rows: 9 }, 17, v);
    expect(v.x).toBeCloseTo(1 / 16);
    expect(v.y).toBeCloseTo(1 - 2 / 9);
    expect(v.z).toBeCloseTo(1 / 16);
    expect(v.w).toBeCloseTo(1 / 9);
    frameRect({ cols: 16, rows: 9 }, 0, v);
    expect([v.x, v.y]).toEqual([0, 1 - 1 / 9]);
  });
});

describe('loopFrame', () => {
  it('runs through its sequence at fps, offset by the phase', () => {
    expect(loopFrame([10, 12], 0.5, 30, 0)).toBe(13);
    expect(loopFrame([10, 12], 0.5, 30, 0.25)).toBe(16);
    // 1 s at 30 fps is 30 frames: two laps and 6 more.
    expect(loopFrame([10, 12], 1.0, 30, 0)).toBe(16);
  });
  it('stays inside its sequence before zero', () => {
    const f = loopFrame([10, 12], -0.1, 30, 0);
    expect(f).toBeGreaterThanOrEqual(10);
    expect(f).toBeLessThanOrEqual(21);
    expect(Number.isInteger(f)).toBe(true);
  });
});

describe('onceFrame', () => {
  it('plays its sequence once over the life, null outside it', () => {
    expect(onceFrame([0, 33], 0.5, 1)).toBe(16);
    expect(onceFrame([0, 33], 0, 1)).toBe(0);
    expect(onceFrame([5, 33], 0.999, 1)).toBe(37);
    expect(onceFrame([0, 33], 1, 1)).toBeNull();
    expect(onceFrame([0, 33], -0.01, 1)).toBeNull();
  });
});

describe('FlipbookBatch', () => {
  it('draws at most its capacity', () => {
    const b = new FlipbookBatch(4, {
      blending: 'premultiplied',
      facing: 'camera',
      emissive: false,
    });
    b.begin();
    for (let i = 0; i < 4; i++)
      expect(b.push(i, 0, 0, 1, 1, 0, 0, white, 1)).toBe(true);
    expect(b.push(5, 0, 0, 1, 1, 0, 0, white, 1)).toBe(false);
    b.end();
    expect(b.mesh.geometry.instanceCount).toBe(4);
    b.dispose();
  });

  it('shows the batch only while it has sprites', () => {
    const b = new FlipbookBatch(4, {
      blending: 'premultiplied',
      facing: 'camera',
      emissive: false,
    });
    b.begin();
    b.end();
    expect(b.mesh.visible).toBe(false);
    b.begin();
    b.push(0, 0, 0, 1, 1, 0, 0, white, 1);
    b.end();
    expect(b.mesh.visible).toBe(true);
    b.begin();
    b.end();
    expect(b.mesh.visible).toBe(false);
    b.dispose();
  });

  it('fills and ends a batch without iterating an array, calling back over one or making an update range', () => {
    const b = new FlipbookBatch(16, {
      blending: 'alpha',
      facing: 'camera',
      emissive: false,
    });
    const g = b.mesh.geometry;
    const centre = g.getAttribute('aCentre') as THREE.InstancedBufferAttribute;
    const counts = countCalls(() => {
      for (let round = 0; round < 50; round++) {
        b.begin();
        for (let i = 0; i < round % 17; i++)
          b.push(i, 0, 0, 1, 1, 0, i, white, 1);
        b.end();
      }
    });
    // What a `for…of` over an array, a callback over one or `addUpdateRange` would call.
    expect(counts).toEqual({ iterator: 0, forEach: 0, map: 0, range: 0 });
    // The last round's upload covers its 15 sprites, through the batch's own range object.
    expect(g.instanceCount).toBe(15);
    expect(centre.updateRanges).toHaveLength(1);
    const range = centre.updateRanges[0];
    expect(range.count).toBe(15 * 3);
    b.begin();
    b.push(0, 0, 0, 1, 1, 0, 0, white, 1);
    b.end();
    expect(centre.updateRanges[0]).toBe(range);
    b.dispose();
  });

  it('uploads nothing when it holds no sprite', () => {
    const b = new FlipbookBatch(4, {
      blending: 'alpha',
      facing: 'camera',
      emissive: false,
    });
    const a = b.mesh.geometry.getAttribute(
      'aColor'
    ) as THREE.InstancedBufferAttribute;
    b.begin();
    b.push(0, 0, 0, 1, 1, 0, 0, white, 1);
    b.end();
    const v = a.version;
    b.begin();
    b.end();
    expect(a.version).toBe(v);
    expect(b.mesh.geometry.instanceCount).toBe(0);
    b.dispose();
  });

  it('reuses its arrays: 1,000 rounds of pushes allocate none', () => {
    const b = new FlipbookBatch(64, {
      blending: 'additive',
      facing: 'upright',
      emissive: true,
    });
    const g = b.mesh.geometry;
    const arrays = Object.values(g.attributes).map((a) => a.array);
    for (let round = 0; round < 1000; round++) {
      b.begin();
      const n = round % 65;
      for (let i = 0; i < n; i++)
        b.push(i, round, -i, 0.5, 1, i * 0.1, i, white, 0.5);
      b.end();
      expect(g.instanceCount).toBe(n);
    }
    expect(Object.values(g.attributes).map((a) => a.array)).toEqual(arrays);
    Object.values(g.attributes).forEach((a, i) =>
      expect(a.array).toBe(arrays[i])
    );
    b.dispose();
  });

  it('writes what it is given into the instance attributes', () => {
    const b = new FlipbookBatch(2, {
      blending: 'alpha',
      facing: 'surface',
      emissive: false,
    });
    b.begin();
    b.push(
      1,
      2,
      3,
      0.4,
      0.6,
      0.5,
      7,
      new THREE.Color(0.1, 0.2, 0.3),
      0.8,
      0,
      0,
      1
    );
    b.end();
    const at = (name: string) =>
      Array.from(b.mesh.geometry.getAttribute(name).array as Float32Array);
    expect(at('aCentre').slice(0, 3)).toEqual([1, 2, 3]);
    expect(
      at('aSize')
        .slice(0, 4)
        .map((x) => +x.toFixed(4))
    ).toEqual([0.4, 0.6, 0.5, 7]);
    expect(
      at('aColor')
        .slice(0, 4)
        .map((x) => +x.toFixed(4))
    ).toEqual([0.1, 0.2, 0.3, 0.8]);
    expect(at('aNormal').slice(0, 3)).toEqual([0, 0, 1]);
    const m = b.mesh.material;
    expect(m.polygonOffset).toBe(true);
    expect(m.polygonOffsetFactor).toBe(-1);
    expect(m.depthWrite).toBe(false);
    b.dispose();
  });

  it('cuts frames from an atlas, or draws the whole fallback texture', () => {
    const b = new FlipbookBatch(2, {
      blending: 'premultiplied',
      facing: 'camera',
      emissive: true,
    });
    const fallback = new THREE.Texture();
    const fire = atlas(16, 9, 131);
    b.setAtlas(fire, fallback);
    const u = b.mesh.material.uniforms;
    expect(u.uMap.value).toBe(fire.texture);
    expect([u.uGrid.value.x, u.uGrid.value.y]).toEqual([16, 9]);
    b.setAtlas(null, fallback);
    expect(u.uMap.value).toBe(fallback);
    expect([u.uGrid.value.x, u.uGrid.value.y]).toEqual([1, 1]);
    b.setExposure(1.6);
    expect(u.uExposure.value).toBe(1.6);
    expect(b.mesh.material.fog).toBe(true);
    expect(b.mesh.frustumCulled).toBe(false);
    b.dispose();
  });

  it('blends as asked', () => {
    const make = (blending: 'additive' | 'premultiplied' | 'alpha') =>
      new FlipbookBatch(1, { blending, facing: 'camera', emissive: false }).mesh
        .material;
    const add = make('additive');
    expect([add.blendSrc, add.blendDst]).toEqual([
      THREE.OneFactor,
      THREE.OneFactor,
    ]);
    const pre = make('premultiplied');
    expect([pre.blendSrc, pre.blendDst]).toEqual([
      THREE.OneFactor,
      THREE.OneMinusSrcAlphaFactor,
    ]);
    expect(make('alpha').blending).toBe(THREE.NormalBlending);
  });

  it('darkens a dark core into its sprites when given one (bullet holes), and leaves the shader as it was without', () => {
    const make = (core?: { radius: number; shade: number }) =>
      new FlipbookBatch(1, {
        blending: 'alpha',
        facing: 'surface',
        emissive: false,
        core,
      }).mesh.material;
    const plain = make();
    expect(plain.defines.CORE).toBeUndefined();
    const holed = make({ radius: 0.3, shade: 0.04 });
    expect(holed.defines.CORE).toBeDefined();
    expect((holed.uniforms.uCore.value as THREE.Vector2).toArray()).toEqual([
      0.3, 0.04,
    ]);
    // Within the radius of the cell's middle the colour falls to `shade` of itself, covering.
    expect(holed.fragmentShader).toContain('col *= mix(uCore.y, 1.0, k)');
    expect(holed.fragmentShader).toContain('a = max(a, (1.0 - k) * vColor.a)');
  });

  it("multiplies the atlas's alpha by its gain, up to 1, when given one", () => {
    const make = (alphaGain?: number) =>
      new FlipbookBatch(1, {
        blending: 'alpha',
        facing: 'camera',
        emissive: false,
        alphaGain,
      }).mesh.material;
    expect(make().uniforms.uAlphaGain.value).toBe(1);
    expect(make(2.5).uniforms.uAlphaGain.value).toBe(2.5);
    expect(make().fragmentShader).toContain(
      'min(1.0, t.a * uAlphaGain) * vColor.a'
    );
  });
});
