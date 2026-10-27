// The sky colour, distance fog, light colours and exposure of each map. One table, read by the scene
// when a map loads; a map not in it gets the defaults. Fog distances are metres from the
// eye, which in every camera is the camera.

import { HEMI_GROUND, HEMI_SKY, SUN_COLOR, SUN_INTENSITY } from './lighting';

export interface Atmosphere {
  /**
   * The fog colour, and the background, for a map built without its own sky (sky.webp). With
   * one, the sky's horizon colour from the map's manifest takes this place, and the
   * background is the texture once it has loaded.
   */
  sky: string;
  fogNear: number;
  fogFar: number;
  sunColor: string;
  /**
   * The runtime sun's intensity, the world's and the players', where the map has no bake; with
   * one the sun is light.json's at the bake's scale (`Lighting.setBakedSun`), the players' where
   * it is in the bake and the world's too where it is not (de_cache). The direction is
   * light.json's (`Lighting.setSun`).
   */
  sunIntensity: number;
  /** The hemisphere light's sky and ground colours. */
  hemiSky: string;
  hemiGround: string;
  /** The tone mapping's exposure (Neutral), which sets how bright the map reads. */
  exposure: number;
  /**
   * The exposure instead when the world is drawn with the map's bake (baked.ts), at every
   * preset: CS2's light is in its own units, so the same map reads as its screenshot at
   * another exposure than the look without it.
   */
  bakedExposure: number;
  /**
   * How bright the map's sky.webp is drawn (`scene.backgroundIntensity`): 1 as tools/sky.mjs
   * exposed it. The sky is not tone-mapped: every preset shows it as this says.
   */
  skyIntensity: number;
}

export const DEFAULT_ATMOSPHERE: Readonly<Atmosphere> = Object.freeze({
  sky: '#a8c6e6',
  fogNear: 120,
  fogFar: 420,
  // The lights' own defaults, which the scene starts with (lighting.ts).
  sunColor: SUN_COLOR,
  sunIntensity: SUN_INTENSITY,
  hemiSky: HEMI_SKY,
  hemiGround: HEMI_GROUND,
  exposure: 1.6,
  // About the ten maps' mean (1.09; they range 0.6–1.8), for a map with a bake and no entry.
  bakedExposure: 1.1,
  skyIntensity: 1,
});

const at = (a: Partial<Atmosphere>): Readonly<Atmosphere> =>
  Object.freeze({ ...DEFAULT_ATMOSPHERE, ...a });

/**
 * The maps with a world: Active Duty and Cache. Each map's sun, sky light, bounce and exposure
 * were fitted on 2026-10-22 so that the average colour of views at its spawns and bomb sites
 * (the lower 60 % of each frame, at the high preset) matches that of CS2's own screenshots of
 * the map (`panorama/images/map_icons/screenshots/1080p` in pak01) within a few levels;
 * Vertigo, whose rooftop views are mostly sky, by eye. The skies are CS2's clear blue, but for
 * Cache's overcast grey (fitted 2026-10-23 from POV views, relative to Mirage's fit).
 *
 * `bakedExposure` was refitted on 2026-10-25 with all ten maps built with their bake, at the high
 * preset (with the bake's bloom threshold, post.ts BAKED_BLOOM_WHITE), against the map's own
 * screenshot (`hero.png`, CS2's 1080p map screenshot): the exposure at which the median sRGB
 * luminance of the matched region of the viewer's frame equals the screenshot's, interpolated in
 * log exposure between four exposures. Free-camera pose (`at`: x,y,z,yaw,pitch,fov) and region:
 * - From about where CS2 took the screenshot, lower 60 % of the frame: Mirage's A site
 *   (-49.04,-3.2,-7.64,-118,-8,59: 1.37), Anubis's B site obelisk (7.59,1.15,-33.66,76,-10,68:
 *   1.11), Dust2's road past the gate, from higher (-8,13,28,165,15,66: 1.17); Overpass's canal
 *   tunnels (-31,2.2,-9,98,-6,68, lower 45 %, without CS2's graffiti: its lightmap's deep shade
 *   under the bridge puts the median at 0.68 and the mean at 1.06; 0.85 between them). Anubis,
 *   Dust2, Overpass and Inferno refitted with the lightmap they ship since 2026-10-25 (tier H2).
 * - Nuke, from across the canal (-108,2,-15,80,0,62): the sunlit wall of the building with three
 *   pipe bends, the one surface both frames show alike (1.38); its cooling towers are CS2's 3D
 *   skybox, not drawn, its domes read darker and its water is not CS2's.
 * - Inferno's arch passage (-2,1.8,-12.5,-6,-10,74, found 2026-10-25 by scanning the map for covered
 *   passages): by the sunlit white wall beyond the arch (0.93), the one surface both frames light
 *   alike; the frame's median would need about 1.9, CS2's screenshot being exposed for the shaded
 *   passage (its eye adaptation), which one fixed exposure cannot follow. Train's yard by the
 *   level crossing (41,-3.6,2,160,-4,66, the screenshot's building, gantry and locomotive, from a
 *   few metres back; CS2's train there is another): the frame's median (1.82), between its
 *   building's facade (2.2) and its wet road (1.4).
 * - Where the screenshot is not something the viewer draws (Cache: beyond the map's edge;
 *   Ancient, Vertigo: in front of 3D-skybox buildings), an eye-level view of the same kind, by
 *   eye: Cache's yard (-25,42.6,50,95,-3,66) and Vertigo's A site (-15,300.1,-8,45,-12,70), their
 *   numbers comparing white brick and containers with CS2's grey concrete and orange containers
 *   (Cache 0.8 since its runtime sun took light.json's brightness on 2026-10-25, its white walls
 *   sunlit); Ancient, CS2's screenshot being a view in deep shade darker than any of its sites
 *   at any exposure here.
 * `medium`, without the post stack's vignette and AO, reads 5–8 % brighter.
 */
export const ATMOSPHERES: Readonly<Record<string, Readonly<Atmosphere>>> =
  Object.freeze({
    // Warm sand under a hard sun.
    de_mirage: at({
      sky: '#8fc0ee',
      // The fog takes the sky's cream horizon: farther out than the default's 120–420 m, so the
      // whole-map view (about 200 m off) is not washed in it.
      fogNear: 200,
      fogFar: 700,
      sunColor: '#fdcc99',
      hemiSky: '#fdeadf',
      hemiGround: '#d7ab7c',
      exposure: 1.6,
      bakedExposure: 1.35,
    }),
    // Whitewashed plaster in a bright haze.
    de_dust2: at({
      sky: '#9cc8f0',
      sunColor: '#f7e0cf',
      hemiSky: '#ebecfb',
      hemiGround: '#c5b09e',
      exposure: 2.05,
      bakedExposure: 1.15,
    }),
    de_inferno: at({
      sky: '#9ec4e6',
      sunColor: '#fed7b7',
      hemiSky: '#efe5ed',
      hemiGround: '#b89983',
      exposure: 1.59,
      bakedExposure: 0.9,
    }),
    // Industrial grey under a cool sky.
    de_nuke: at({
      sky: '#a9c8e6',
      sunColor: '#fbf5e8',
      hemiSky: '#d8e9f7',
      hemiGround: '#8d979e',
      exposure: 1.81,
      bakedExposure: 1.4,
    }),
    de_train: at({
      sky: '#aab9c8',
      sunColor: '#ffeee8',
      hemiSky: '#e1e4f5',
      hemiGround: '#7e7a7d',
      exposure: 0.98,
      bakedExposure: 1.8,
    }),
    // Shaded jungle stone.
    de_ancient: at({
      sky: '#a8c8dc',
      sunColor: '#f9eff2',
      hemiSky: '#ddebf9',
      hemiGround: '#7a8a76',
      exposure: 1.24,
      bakedExposure: 0.9,
    }),
    de_anubis: at({
      sky: '#9fc6ea',
      sunColor: '#ffc78d',
      hemiSky: '#ffdfc3',
      hemiGround: '#d59f6c',
      exposure: 1.12,
      bakedExposure: 1.1,
    }),
    de_overpass: at({
      sky: '#a9c3db',
      sunColor: '#ffe8ce',
      hemiSky: '#ede8e6',
      hemiGround: '#928473',
      exposure: 2.9,
      bakedExposure: 0.85,
    }),
    // Weathered concrete under an overcast sky: a pale grey sky, light mostly from it, a weak sun.
    de_cache: at({
      sky: '#c3ccd5',
      sunColor: '#a9aaac',
      hemiSky: '#eef5ff',
      hemiGround: '#9fa9b6',
      exposure: 3.25,
      bakedExposure: 0.8,
    }),
    de_vertigo: at({
      sky: '#a8c9ec',
      sunColor: '#fff6ea',
      hemiSky: '#dfe9f6',
      hemiGround: '#8e9298',
      exposure: 1.7,
      bakedExposure: 0.6,
    }),
  });

export function atmosphereFor(map: string): Readonly<Atmosphere> {
  const key = map.toLowerCase();
  return Object.hasOwn(ATMOSPHERES, key)
    ? ATMOSPHERES[key]
    : DEFAULT_ATMOSPHERE;
}
