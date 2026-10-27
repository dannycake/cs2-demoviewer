// ItemLight: the light grid on one thing the players handle that lies or flies in the world (a
// grenade in flight, an item on the ground, the bomb), lit as a player is: its own copies' lit
// materials take its own sample of the grid, and its meshes the shadow maps.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ItemLight } from '../src/scene/itemlight';
import { makeProbeSample, sampleLightGrid } from '../src/scene/probes';
import { lightGrid } from './helpers/light-grid';

/** A copy as `cloneWeapon` makes one in a lit look: a Lambert mesh, and an unlit one. */
function copy() {
  const g = new THREE.Group();
  const lit = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshLambertMaterial()
  );
  const unlit = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshBasicMaterial()
  );
  g.add(lit, unlit);
  return {
    g,
    lit,
    unlit,
    litMaterial: lit.material,
    unlitMaterial: unlit.material,
  };
}

/** The uniforms `m`'s hooks give its shader: the probe's read its sample on every draw. */
function uniformsOf(m: THREE.Material) {
  const src = THREE.ShaderLib.lambert;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(src.uniforms),
    vertexShader: src.vertexShader,
    fragmentShader: src.fragmentShader,
  } as Parameters<THREE.Material['onBeforeCompile']>[0];
  m.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
  return shader.uniforms;
}

const probed = (m: THREE.Material) =>
  m.customProgramCacheKey().includes('probe');

describe('ItemLight', () => {
  it('lights its lit materials by its own sample of the grid at the point, and its meshes take the shadow maps', () => {
    const grid = lightGrid();
    const light = new ItemLight(false);
    const c = copy();
    light.add(c.g);
    expect(c.lit.receiveShadow).toBe(false);
    const p = new THREE.Vector3(0, 1, 0);
    light.set(grid, p);
    expect(probed(c.litMaterial)).toBe(true);
    expect(probed(c.unlitMaterial)).toBe(false);
    const u = uniformsOf(c.litMaterial);
    expect(u.probeUp.value).toBe(light.sample.up);
    expect(u.probeSide.value).toBe(light.sample.side);
    const want = sampleLightGrid(grid, p, makeProbeSample());
    expect(light.sample.up.toArray()).toEqual(want.up.toArray());
    expect(light.sample.down.toArray()).toEqual(want.down.toArray());
    expect(light.sample.side.toArray()).toEqual(want.side.toArray());
    expect(light.sample.sun).toBeCloseTo(0.4, 6);
    // At medium and high the sun reaches it past the shadow maps, as it does a player.
    expect(c.lit.receiveShadow && c.unlit.receiveShadow).toBe(true);
  });

  it('samples again only when the point or the grid is another', () => {
    const grid = lightGrid();
    const light = new ItemLight(true);
    light.add(copy().g);
    const p = new THREE.Vector3(0, 1, 0);
    light.set(grid, p);
    // A mark the next sample would overwrite.
    light.sample.up.r = 99;
    light.set(grid, p.clone());
    expect(light.sample.up.r).toBe(99);
    light.set(grid, new THREE.Vector3(0, 2, 0));
    expect(light.sample.up.r).toBeCloseTo(0.8 * 8, 5);
    light.sample.up.r = 99;
    light.set(lightGrid(), new THREE.Vector3(0, 2, 0));
    expect(light.sample.up.r).toBeCloseTo(0.8 * 8, 5);
  });

  it('lights a copy added while lit at once, by the same sample', () => {
    const grid = lightGrid();
    const light = new ItemLight(false);
    light.add(copy().g);
    light.set(grid, new THREE.Vector3(0, 1, 0));
    const later = copy();
    light.add(later.g);
    expect(probed(later.litMaterial)).toBe(true);
    expect(uniformsOf(later.litMaterial).probeUp.value).toBe(light.sample.up);
    expect(later.lit.receiveShadow).toBe(true);
  });

  it('leaves the sky light and the shadows as they were without a grid, and puts them back when the grid goes', () => {
    const p = new THREE.Vector3(0, 1, 0);
    for (const shadows of [false, true]) {
      const light = new ItemLight(shadows);
      const c = copy();
      c.lit.receiveShadow = c.unlit.receiveShadow = shadows;
      light.add(c.g);
      light.set(null, p);
      expect(probed(c.litMaterial)).toBe(false);
      expect(c.lit.receiveShadow).toBe(shadows);
      light.set(lightGrid(), p);
      light.set(null, p);
      expect(probed(c.litMaterial)).toBe(false);
      expect(c.lit.receiveShadow).toBe(shadows);
    }
  });

  it('forgets a copy removed: its materials keep what they had and are lit no further', () => {
    const grid = lightGrid();
    const light = new ItemLight(false);
    const kept = copy();
    const gone = copy();
    light.add(kept.g);
    light.add(gone.g);
    light.remove(gone.g);
    light.set(grid, new THREE.Vector3(0, 1, 0));
    expect(probed(kept.litMaterial)).toBe(true);
    expect(probed(gone.litMaterial)).toBe(false);
    expect(gone.lit.receiveShadow).toBe(false);
  });

  it('forgets its copies on clear, and lights only those added after', () => {
    const grid = lightGrid();
    const light = new ItemLight(false);
    const old = copy();
    light.add(old.g);
    light.set(grid, new THREE.Vector3(0, 1, 0));
    light.clear();
    const fresh = copy();
    light.add(fresh.g);
    light.set(null, new THREE.Vector3(0, 1, 0));
    // The old copy's materials are its owner's to free: left as they were.
    expect(probed(old.litMaterial)).toBe(true);
    light.set(grid, new THREE.Vector3(0, 1, 0));
    expect(probed(fresh.litMaterial)).toBe(true);
  });
});
