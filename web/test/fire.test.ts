import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Atlas } from '../src/scene/effects';
import {
  FLAMES,
  fireSmokePuff,
  flameAtlasMaterial,
  flameGeometry,
  flameLayout,
  flameMaterial,
  setFlameSequences,
} from '../src/scene/fire';

describe('flameLayout', () => {
  const radius = 3.4;
  const a = flameLayout(7, 48, radius);

  it('stands every flame inside the fire, the same for the same seed', () => {
    for (let i = 0; i < 48; i++) {
      const x = a.offsets[i * 3];
      const z = a.offsets[i * 3 + 2];
      expect(a.offsets[i * 3 + 1]).toBe(0);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(radius);
    }
    expect(flameLayout(7, 48, radius)).toEqual(a);
    expect(flameLayout(8, 48, radius).offsets).not.toEqual(a.offsets);
  });

  it('catches from the middle outwards within the spread time, tallest in the middle', () => {
    const dist = (i: number) =>
      Math.hypot(a.offsets[i * 3], a.offsets[i * 3 + 2]);
    let inner = 0;
    let outer = 0;
    let innerH = 0;
    let outerH = 0;
    for (let i = 0; i < 48; i++) {
      expect(a.delays[i]).toBeGreaterThanOrEqual(0);
      expect(a.delays[i]).toBeLessThanOrEqual(FLAMES.spreadS);
      if (dist(i) < radius / 2) {
        inner++;
        innerH += a.shapes[i * 3 + 1];
        expect(a.delays[i]).toBeLessThan(FLAMES.spreadS / 2 + 0.1);
      } else {
        outer++;
        outerH += a.shapes[i * 3 + 1];
      }
    }
    expect(inner).toBeGreaterThan(0);
    expect(outer).toBeGreaterThan(0);
    expect(innerH / inner).toBeGreaterThan(outerH / outer);
  });
});

describe('fireSmokePuff', () => {
  const out = { x: 0, y: 0, z: 0, scale: 0, opacity: 0, frame: 0 };
  it('rises, grows and fades in and out over its life, the same at the same age', () => {
    const at = (age: number) => ({ ...fireSmokePuff(age, 3, 12, 7, 3.4, out) });
    const early = at(1.0);
    const later = at(1.0 + FLAMES.smokeLifeS * 0.3);
    expect(at(1.0)).toEqual(early);
    // Over one life a puff is somewhere in its rise; a later age in the same life is higher.
    const p0 = at(2.0);
    const p1 = at(2.0 + 0.2);
    if (p1.y > p0.y) expect(p1.scale).toBeGreaterThan(p0.scale);
    expect(later.opacity).toBeGreaterThanOrEqual(0);
    expect(later.opacity).toBeLessThanOrEqual(FLAMES.smokeOpacity);
    for (let t = 0.5; t < 8; t += 0.37) {
      const p = at(t);
      expect(p.y).toBeGreaterThanOrEqual(FLAMES.smokeBase - 1e-9);
      expect(p.y).toBeLessThanOrEqual(
        FLAMES.smokeBase + FLAMES.smokeRise + 1e-9
      );
      expect(Math.hypot(p.x, p.z)).toBeLessThan(3.4 + FLAMES.smokeDrift + 1e-9);
    }
  });

  it('shows no smoke before the fire has burned a moment', () => {
    expect(fireSmokePuff(0, 0, 12, 7, 3.4, out).opacity).toBe(0);
  });

  it("takes its frames from CS2's smoke atlas when given one: one per puff, kept while it rises, a new one each time it starts again", () => {
    const smoke = { frames: 32 };
    const frames = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const f = fireSmokePuff(2, i, 12, 7, 3.4, out, smoke).frame;
      expect(Number.isInteger(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(32);
      frames.add(f);
    }
    expect(frames.size).toBeGreaterThan(4);
    // Puff 3 at 2 s and 2.1 s is in one rise (it starts again every smokeLifeS): the same frame.
    const a = fireSmokePuff(2, 3, 12, 7, 3.4, out, smoke).frame;
    expect(fireSmokePuff(2.1, 3, 12, 7, 3.4, out, smoke).frame).toBe(a);
    // Its next rises draw other frames.
    const next = new Set<number>();
    for (let k = 1; k <= 6; k++)
      next.add(
        fireSmokePuff(2 + k * FLAMES.smokeLifeS, 3, 12, 7, 3.4, out, smoke)
          .frame
      );
    expect([...next].some((f) => f !== a)).toBe(true);
    // Without an atlas the generated puff is drawn whole: frame 0.
    expect(fireSmokePuff(2, 3, 12, 7, 3.4, out).frame).toBe(0);
    expect(fireSmokePuff(2, 3, 12, 7, 3.4, out, null).frame).toBe(0);
  });
});

describe('flameMaterial', () => {
  it('blends premultiplied, writes no depth, and takes the fire age and strength as uniforms', () => {
    const m = flameMaterial();
    expect(m).toBeInstanceOf(THREE.ShaderMaterial);
    expect(m.blending).toBe(THREE.CustomBlending);
    expect(m.blendSrc).toBe(THREE.OneFactor);
    expect(m.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(m.depthWrite).toBe(false);
    expect(m.uniforms.uTime.value).toBe(0);
    expect(m.uniforms.uStrength.value).toBe(0);
    expect(m.vertexShader).toContain('aOffset');
    expect(m.fragmentShader).toContain('fbm');
    m.dispose();
  });
});

/** The fire atlas as the manifest describes it (CS2 build 2000935). */
const FIRE_SEQUENCES: [number, number][] = [
  [0, 12],
  [12, 11],
  [23, 12],
  [35, 12],
  [47, 11],
  [58, 11],
  [69, 12],
  [81, 25],
  [106, 25],
];
const stubFireAtlas: Atlas = {
  texture: new THREE.Texture(),
  cols: 16,
  rows: 9,
  frames: 131,
  sequences: FIRE_SEQUENCES,
  aspect: 64 / 112,
};

describe('flames from an atlas', () => {
  it('give flame i the sequence i mod the sequence count', () => {
    const g = flameGeometry(64);
    setFlameSequences(g, FIRE_SEQUENCES);
    const seq = g.getAttribute('aSeq');
    expect(seq.itemSize).toBe(2);
    expect([seq.getX(10), seq.getY(10)]).toEqual(FIRE_SEQUENCES[1]);
    expect([seq.getX(63), seq.getY(63)]).toEqual(FIRE_SEQUENCES[0]);
    expect([seq.getX(8), seq.getY(8)]).toEqual(FIRE_SEQUENCES[8]);
    g.dispose();
  });

  it('loop the atlas premultiplied, without depth writes, the exposure divided out', () => {
    const m = flameAtlasMaterial(stubFireAtlas, 'loop');
    const u = m.uniforms;
    expect(u.uMap.value).toBe(stubFireAtlas.texture);
    expect([u.uGrid.value.x, u.uGrid.value.y]).toEqual([16, 9]);
    expect(u.uFps.value).toBe(FLAMES.fps);
    expect(u.uExposure.value).toBe(1);
    expect(u.uTime.value).toBe(0);
    expect(u.uStrength.value).toBe(0);
    expect(u.uAspect.value).toBeCloseTo(64 / 112);
    expect(u.uScale.value).toBe(FLAMES.atlasScale);
    expect(m.blending).toBe(THREE.CustomBlending);
    expect(m.blendSrc).toBe(THREE.OneFactor);
    expect(m.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(m.depthWrite).toBe(false);
    expect(m.vertexShader).toContain('aSeq');
    expect(m.fragmentShader).toContain('uExposure');
    m.dispose();
  });

  it('play a burst once over its life, scaled up', () => {
    const m = flameAtlasMaterial(stubFireAtlas, 'once');
    expect(m.uniforms.uLife.value).toBe(FLAMES.burstS);
    expect(m.uniforms.uLife.value).toBe(1.0);
    expect(m.uniforms.uScale.value).toBe(FLAMES.burstScale);
    expect(m.defines?.ONCE).toBeDefined();
    m.dispose();
  });
});
