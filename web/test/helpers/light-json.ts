// light.json as tools/lib/light.mjs `lightJson` writes it, for two maps' bakes (each the file
// shrink-map.mjs wrote for the map: a 1024² lightmap and the sun in the bake). The objects are
// written here, so the viewer tests built on them load nothing of tools/ (whose modules need
// tools/node_modules); tools-parity.test.ts holds each equal to what lightJson writes for its
// range, lightmap size and sun, so a change to the format in tools fails that test rather than
// leave these behind.

import type { LightInfo } from '../../src/scene/baked';

/** Nuke's light.json. */
export const NUKE_LIGHT = {
  version: 2,
  range: 16,
  lightmap: { file: 'lightmap.webp', size: [1024, 1024] },
  sun: {
    dir: [-0.219186, 0.866025, -0.449397],
    color: [1, 0.973445, 0.863157],
    intensity: 2.4,
    baked: true,
  },
  probes: { file: 'probes.bin' },
} satisfies LightInfo;

/** Mirage's light.json. */
export const MIRAGE_LIGHT = {
  version: 2,
  range: 8,
  lightmap: { file: 'lightmap.webp', size: [1024, 1024] },
  sun: {
    dir: [0.334565, 0.866025, -0.371572],
    color: [1, 0.73791, 0.450786],
    intensity: 3,
    baked: true,
  },
  probes: { file: 'probes.bin' },
} satisfies LightInfo;

/** Every fixture, by map, for the parity test. */
export const LIGHT_JSONS: Record<string, LightInfo> = {
  de_nuke: NUKE_LIGHT,
  de_mirage: MIRAGE_LIGHT,
};
