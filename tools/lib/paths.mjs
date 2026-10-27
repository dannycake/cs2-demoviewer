// Where every pipeline artefact lives under ASSETS_DIR. The names under maps/ and
// players/ are what the server serves and what the web app fetches.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** ASSETS_DIR from the environment (read on every call), default <repo>/assets. */
export function assetsDir() {
  return path.resolve(process.env.ASSETS_DIR || path.join(REPO_DIR, 'assets'));
}

const MAP_NAME = /^[a-z0-9_]+$/;

/**
 * @param {string} map  e.g. 'de_mirage'
 * @returns {{raw: string, out: string, world: string, hull: string,
 *   entities: string, radar: string, radarLower: string, overview: string, manifest: string,
 *   sky: string, rawSky: string, rawLightmaps: string}}
 */
export function paths(map) {
  if (typeof map !== 'string' || !MAP_NAME.test(map)) {
    throw new Error(`invalid map name: ${JSON.stringify(map)}`);
  }
  const root = assetsDir();
  const out = path.join(root, 'maps', map);
  return {
    raw: path.join(root, 'raw', map),
    out,
    world: path.join(out, 'world.glb'),
    hull: path.join(out, 'hull.glb'),
    entities: path.join(out, 'entities.glb'),
    radar: path.join(out, 'radar.png'),
    radarLower: path.join(out, 'radar_lower.png'),
    overview: path.join(out, 'overview.json'),
    manifest: path.join(out, 'manifest.json'),
    sky: path.join(out, 'sky.webp'),
    /** rip-lighting.sh's sky export: sky.json, sky.vmat, sky.exr, skybox_ents.vents. */
    rawSky: path.join(root, 'raw', map, 'sky'),
    /** rip-lighting.sh's lightmaps export: irradiance.exr, the probe atlas, lightmaps.json, … */
    rawLightmaps: path.join(root, 'raw', map, 'lightmaps'),
  };
}

/** assets/players/ (ct.glb, t.glb, manifest.json); resolved when this module loads. */
export const PLAYERS_DIR = path.join(assetsDir(), 'players');

/** assets/manifest.json; resolved when this module loads. */
export const ROOT_MANIFEST = path.join(assetsDir(), 'manifest.json');

/** assets/sounds/ (one <bank>.webm per family, build.json, manifest.json); resolved when this module loads. */
export const SOUNDS_DIR = path.join(assetsDir(), 'sounds');

/** assets/raw/sounds/, rip-sounds.sh's export at the VPK's paths; resolved when this module loads. */
export const RAW_SOUNDS_DIR = path.join(assetsDir(), 'raw', 'sounds');
