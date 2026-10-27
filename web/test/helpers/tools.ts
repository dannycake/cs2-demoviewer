// The asset pipeline's own writers, readers and tables (tools/lib/*.mjs, plain ESM without
// declarations), typed as tools-parity.test.ts calls them: it runs them beside the viewer's
// readers, and holds the fixtures (light-grid.ts, light-json.ts) to their output, so a format
// change in tools fails a web test instead of passing both suites. Importing this loads tools/node_modules (sharp,
// @gltf-transform, three), so no other test does; a type import loads nothing.

// @ts-expect-error the tools are plain ESM without declarations
import * as entities from '../../../tools/lib/entities.mjs';
// @ts-expect-error the tools are plain ESM without declarations
import * as kv from '../../../tools/lib/kv.mjs';
// @ts-expect-error the tools are plain ESM without declarations
import * as light from '../../../tools/lib/light.mjs';
// @ts-expect-error the tools are plain ESM without declarations
import * as lightmap from '../../../tools/lib/lightmap.mjs';
// @ts-expect-error the tools are plain ESM without declarations
import * as overview from '../../../tools/lib/overview.mjs';
// @ts-expect-error the tools are plain ESM without declarations
import * as players from '../../../tools/lib/players.mjs';
// @ts-expect-error the tools are plain ESM without declarations
import * as probes from '../../../tools/lib/probes.mjs';
// @ts-expect-error the tools are plain ESM without declarations
import * as sounds from '../../../tools/lib/sounds.mjs';

/** tools/lib/probes.mjs LightGrid: glTF metres; per cell linear RGB (3 a cell) and the sun. */
export interface ToolsLightGrid {
  origin: number[];
  step: number;
  size: number[];
  up: Float32Array;
  down: Float32Array;
  side: Float32Array;
  sun: Float32Array;
}

/** probes.bin version 2 of `grid` at the map's light `range`. */
export const encodeLightGrid: (
  grid: ToolsLightGrid,
  range: number
) => Uint8Array = probes.encodeLightGrid;
/** probes.bin (version 1 or 2) back to a grid, as check-map reads it; throws as the viewer does. */
export const decodeLightGrid: (
  bytes: Uint8Array | ArrayBuffer
) => ToolsLightGrid & { range: number; version: number } =
  probes.decodeLightGrid;
/** A grid at a point, trilinear and clamped, as the pipeline reads it. */
export const sampleGrid: (
  grid: ToolsLightGrid,
  p: number[]
) => { up: number[]; down: number[]; side: number[]; sun: number } =
  probes.sampleGrid;
/** The refit's parameters: `heights` above the floors that players are lit at. */
export const FIT: { heights: readonly number[] } = probes.FIT;

/** light.json as shrink-map.mjs writes it. */
export const lightJson: (bake: {
  range: number;
  lightmapSize: number[] | null;
  sun: {
    dir: number[];
    color: number[];
    intensity: number;
    baked: boolean;
  } | null;
}) => Record<string, unknown> = light.lightJson;
/** Why check-map.mjs fails a light.json, or null when it passes it. */
export const lightJsonProblem: (j: unknown) => string | null =
  light.lightJsonProblem;
/** COLOR_0's bits a channel (the vertex light). */
export const VERTEX_LIGHT_BITS: number = light.LIGHT_PARAMS.colorBits;

/** Linear RGB as the `bits`-bit codes the lightmap (8) and COLOR_0 (6) store. */
export const lightBytes: (
  rgb: number[],
  range: number,
  bits: number
) => number[] = lightmap.lightBytes;
/** Lightmap bytes back to linear light, as the pipeline says the viewer decodes them. */
export const decodeLightmap: (rgb: Uint8Array, range: number) => Float32Array =
  lightmap.decodeLightmap;
/** The lightmap's bits a channel. */
export const LIGHTMAP_BITS: number = lightmap.LIGHTMAP_PARAMS.bits;

/** resource/overviews/<map>.txt (KeyValues) parsed. */
export const parseKv: (text: string) => Record<string, unknown> = kv.parseKv;
/** overview.json as radar.mjs writes it. */
export const overviewFromKv: (
  map: string,
  kv: Record<string, unknown>,
  images: Record<string, string>
) => Record<string, unknown> = overview.overviewFromKv;
/** Why check-map.mjs fails an overview.json for `map`, or null when it passes it. */
export const overviewProblem: (ov: unknown, map: string) => string | null =
  overview.overviewProblem;
/** Source (x, y) to radar pixels, as the pipeline places things on the radar. */
export const worldToRadar: (
  x: number,
  y: number,
  ov: { posX: number; posY: number; scale: number }
) => [number, number] = overview.worldToRadar;

/** Source angles (pitch, yaw, roll) as the glTF rotation entities.glb's roots carry. */
export const anglesToGltfQuat: (
  angles: [number, number, number]
) => [number, number, number, number] = entities.anglesToGltfQuat;

/** The third-person clips a player GLB carries, by family. */
export const CLIP_SET: Record<string, readonly string[]> = players.CLIP_SET;
/** Every clip rip-players.sh asks VRF for: what a player GLB can carry. */
export const CLIPS_REQUESTED: readonly string[] = players.CLIPS_REQUESTED;

/** A hull node's surface, as the sounds build keys its step sets. */
export const surfaceOfNode: (name: string) => string | null =
  sounds.surfaceOfNode;
