// Light grids as tools/lib/probes.mjs `encodeLightGrid` writes them (probes.bin version 2), small
// enough to reason about. GRID: 1×2×1 cells 2.5 m apart from the origin, range 8, dark at y = 0
// and bright above (up 255, down 64, side 128, sun 255), so a point at height y reads y / 2.5 of
// the bright cell. ONE_CELL: one cell at range 16, only the red of its up light set (byte 200),
// for the loader's tests. The bytes are written here, so the viewer tests built on them load
// nothing of tools/ (whose modules need tools/node_modules); tools-parity.test.ts holds them
// equal to what the encoder writes for each grid, so a change to the format in tools fails that
// test rather than leave these bytes behind.

import { parseLightGrid, type LightGrid } from '../../src/scene/probes';
import type { ToolsLightGrid } from './tools';

/** The linear light a byte `b` stands for at `range`: (b / 255)² · range. */
const light = (b: number, range: number) => (b / 255) ** 2 * range;

/**
 * probes.bin version 2 of `size` cells 2.5 m apart from the origin at `range`, holding `cells`
 * (10 bytes a cell: up, down and side RGB, then the sun), under `magic`.
 */
function gridFile(
  size: number[],
  range: number,
  cells: number[],
  magic = 'DVLG'
): ArrayBuffer {
  const buf = new ArrayBuffer(36 + cells.length);
  const v = new DataView(buf);
  magic.split('').forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  v.setUint16(4, 2, true);
  v.setFloat32(20, 2.5, true);
  size.forEach((n, a) => v.setUint16(24 + 2 * a, n, true));
  v.setFloat32(32, range, true);
  cells.forEach((b, k) => v.setUint8(36 + k, b));
  return buf;
}

/** The grid's light range: a byte of 255 stands for this much light. */
export const GRID_RANGE = 8;

/** The grid the bytes hold, as the encoder takes it: glTF metres, linear light. */
export const GRID: ToolsLightGrid = {
  origin: [0, 0, 0],
  step: 2.5,
  size: [1, 2, 1],
  up: Float32Array.of(0, 0, 0, ...Array(3).fill(light(255, GRID_RANGE))),
  down: Float32Array.of(0, 0, 0, ...Array(3).fill(light(64, GRID_RANGE))),
  side: Float32Array.of(0, 0, 0, ...Array(3).fill(light(128, GRID_RANGE))),
  sun: Float32Array.of(0, 1),
};

/** The grid's bytes. */
export function lightGridFile(): ArrayBuffer {
  return gridFile([1, 2, 1], GRID_RANGE, [
    ...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ...[255, 255, 255, 64, 64, 64, 128, 128, 128, 255],
  ]);
}

/** The grid, parsed. */
export function lightGrid(): LightGrid {
  return parseLightGrid(lightGridFile());
}

/** The one-cell grid's light range. */
export const ONE_CELL_RANGE = 16;

/** The one-cell grid, as the encoder takes it. */
export const ONE_CELL: ToolsLightGrid = {
  origin: [0, 0, 0],
  step: 2.5,
  size: [1, 1, 1],
  up: Float32Array.of(light(200, ONE_CELL_RANGE), 0, 0),
  down: new Float32Array(3),
  side: new Float32Array(3),
  sun: new Float32Array(1),
};

/** The one-cell grid's bytes, or with `magic` in place of DVLG, a file that is not a light grid. */
export function oneCellFile(magic = 'DVLG'): ArrayBuffer {
  return gridFile(
    [1, 1, 1],
    ONE_CELL_RANGE,
    [200, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    magic
  );
}
