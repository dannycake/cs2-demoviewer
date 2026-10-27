// Sprite textures for the utility effects, made once from a fixed seed as small RGBA data
// textures: a soft smoke puff, a flame tongue and a round glow. White, so a material's colour
// tints them; no image files to fetch or commit.

import * as THREE from 'three';
import { seeded } from '../sim/random';

/** A number in [0, 1) fixed by `n`, for per-frame poses that must make nothing. */
export function hash01(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

/** Value noise in [0, 1] over a `size`² grid, `octaves` doublings from `cells` cells across. */
function fbm(
  size: number,
  cells: number,
  octaves: number,
  seed: number
): Float32Array {
  const out = new Float32Array(size * size);
  const rand = seeded(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++, cells *= 2, amp *= 0.5) {
    const grid = new Float32Array((cells + 1) * (cells + 1)).map(() => rand());
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells;
        const gy = (y / size) * cells;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = gx - ix;
        const fy = gy - iy;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const at = (i: number, j: number) => grid[j * (cells + 1) + i];
        const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
        const bot = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
        out[y * size + x] += (top + (bot - top) * sy) * amp;
      }
    total += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function texture(
  size: number,
  alpha: (x: number, y: number, i: number) => number,
  shade: (x: number, y: number, i: number) => number = () => 1
) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Centred coordinates in [-1, 1], +y up. With `flipY` off, row 0 of a data texture is
      // the bottom of the image (v = 0), so the rows go upwards.
      const cx = ((x + 0.5) / size) * 2 - 1;
      const cy = ((y + 0.5) / size) * 2 - 1;
      const a = Math.min(1, Math.max(0, alpha(cx, cy, i)));
      const v = Math.min(1, Math.max(0, shade(cx, cy, i)));
      data.set([v * 255, v * 255, v * 255, a * 255].map(Math.round), i * 4);
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.flipY = false;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** A dense, lumpy round puff, lit from above: lighter at the top, darker underneath. */
export function puffTexture(size = 64, seed = 7): THREE.DataTexture {
  const n = fbm(size, 4, 4, seed);
  return texture(
    size,
    (x, y, i) => {
      const r2 = x * x + y * y;
      if (r2 >= 1) return 0;
      return Math.pow(1 - r2, 0.55) * (0.75 + 0.5 * n[i]);
    },
    (_x, y, i) => 0.72 + 0.1 * (y + 1) + 0.12 * n[i]
  );
}

/**
 * A tongue of flame: a round, full body low down that narrows into a ragged tip, the noise
 * eating into its edges so no two flames read alike.
 */
export function flameTexture(size = 64, seed = 11): THREE.DataTexture {
  const n = fbm(size, 3, 4, seed);
  return texture(size, (x, y, i) => {
    const h = (y + 1) / 2; // 0 at the bottom, 1 at the top
    // Widest a quarter of the way up, rounded below, tapering above.
    const body =
      h < 0.25 ? Math.sqrt(1 - ((0.25 - h) / 0.25) ** 2) : (1 - h) / 0.75;
    const width = 0.62 * body ** 0.8 * (0.85 + 0.3 * n[i]) + 0.02;
    const across = Math.abs(x) / width;
    if (across >= 1) return 0;
    return (
      (1 - across ** 2) ** 0.8 * Math.min(1, body * 1.6) * (0.55 + 0.6 * n[i])
    );
  });
}

/** A round glow, brightest at the centre. */
export function glowTexture(size = 64): THREE.DataTexture {
  return texture(
    size,
    (x, y) => Math.exp(-(x * x + y * y) * 4) * (x * x + y * y < 1 ? 1 : 0)
  );
}
