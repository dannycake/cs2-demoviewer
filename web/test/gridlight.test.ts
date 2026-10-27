// The grid's light on a wall by its normal (`wallLight`), as the players are lit: a floor takes
// the grid's up, a wall its side, a ceiling its down, and the sun only where the wall faces it.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { wallLight } from '../src/scene/gridlight';
import { makeProbeSample, sampleLightGrid } from '../src/scene/probes';
import { lightGrid } from './helpers/light-grid';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('wallLight', () => {
  const grid = lightGrid();
  // In the bright cell: up 255, down 64, side 128 (bytes; light is their square), sun 1.
  const at = v3(0, 2.5, 0);
  const q = sampleLightGrid(grid, at, makeProbeSample());
  const sun = new THREE.Color(0.5, 0.4, 0.3);
  const toSun = v3(1, 1, 0).normalize();
  const out = new THREE.Color();

  it('takes the up of the grid on a floor, its side on a wall, its down on a ceiling', () => {
    expect(wallLight(grid, at, v3(0, 1, 0), null, null, out).r).toBeCloseTo(
      q.up.r,
      6
    );
    expect(wallLight(grid, at, v3(0, 0, 1), null, null, out).g).toBeCloseTo(
      q.side.g,
      6
    );
    expect(wallLight(grid, at, v3(0, -1, 0), null, null, out).b).toBeCloseTo(
      q.down.b,
      6
    );
  });

  it("takes the sun by the cosine where the wall faces it, past the grid's sun, and none turned away", () => {
    expect(q.sun).toBeCloseTo(1, 6);
    const facing = wallLight(grid, at, v3(1, 0, 0), sun, toSun, out).clone();
    expect(facing.r).toBeCloseTo(q.side.r + sun.r * Math.SQRT1_2, 6);
    expect(facing.b).toBeCloseTo(q.side.b + sun.b * Math.SQRT1_2, 6);
    const away = wallLight(grid, at, v3(-1, 0, 0), sun, toSun, out);
    expect(away.r).toBeCloseTo(q.side.r, 6);
    // Where the grid has no sun (the dark cell at y = 0), none.
    const dark = sampleLightGrid(grid, v3(0, 0, 0), makeProbeSample());
    expect(dark.sun).toBe(0);
    expect(
      wallLight(grid, v3(0, 0, 0), v3(1, 0, 0), sun, toSun, out).r
    ).toBeCloseTo(dark.side.r, 6);
  });
});
