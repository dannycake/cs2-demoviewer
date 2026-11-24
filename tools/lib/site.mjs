// The site kind (lib/kinds.mjs): what the site shows beside the viewer, from CS2's own files
// (and each map's strip, from the hero.png tools/hero.sh made of CS2's screenshot of it).
// One source of truth for the rip, the build, the check and the manifest.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assetsDir } from './paths.mjs';

/** Competitive skill groups 0 (unranked) to 18 (Global Elite), and the "none" icon. */
export const RANK_KEYS = Object.freeze([...Array.from({ length: 19 }, (_, i) => String(i)), 'none']);

/** The VPK path (without `.vtex_c`) of a rank's icon. */
export const rankSource = (key) => `panorama/images/econ/status_icons/skillgroup${key === 'none' ? '_none' : key}_png`;
/** Where VRF writes a rank's icon, under the raw export. */
export const rankRaw = (key) => `${rankSource(key)}.png`;
/** Where the build puts a rank's icon, under site/. */
export const rankFile = (key) => `ranks/skillgroup${key === 'none' ? '_none' : key}.webp`;

export const STEAM_LOGO_SOURCE = 'panorama/images/icons/ui/steam_logo_white';
export const STEAM_LOGO_RAW = `${STEAM_LOGO_SOURCE}.svg`;
export const STEAM_LOGO_FILE = 'steam-logo.svg';

export const CHICKEN_SOURCE = 'models/chicken/chicken';
/** VRF's GLB of the chicken, every clip, under the raw export. */
export const CHICKEN_RAW = `${CHICKEN_SOURCE}.glb`;
/** The chicken the homepage video is rendered with (never served), under the raw export. */
export const CHICKEN_FILE = 'chicken.glb';
/** The clips the homepage video plays, and the folder of the export they are in (the viewmodel
 * chicken's clips share some of their names). */
export const CHICKEN_CLIPS = Object.freeze(['chick_idle01', 'chick_walk', 'chick_runflap']);
export const CHICKEN_CLIP_DIR = 'animation/anims/chicken/world/';
/** The shrunk chicken's budget (117 MB as exported, about 0.6 MB shrunk). */
export const CHICKEN_BUDGET = 1_500_000;

/** The homepage video (tools/home-video.sh writes it; the build never touches home/). */
export const HOME_FILES = Object.freeze({ mp4: 'home/hero.mp4', webm: 'home/hero.webm', poster: 'home/poster.jpg' });

/**
 * The strip of a map's screenshot behind its rows on a profile: CS2's own screenshot
 * (maps/<map>/hero.png, tools/hero.sh) cut to its middle band at four to one, a WebP of
 * `width` × `height` at `quality` (as wide as a map's cell at twice a desktop's pixels; the page
 * darkens it to a fifth, which hides what the quality loses). `budget` is the most bytes one
 * may be, so a phone never fetches the megabyte hero.png.
 */
export const MAP_STRIP = Object.freeze({ width: 640, height: 160, quality: 70, budget: 32_000 });
/** The screenshot a map's strip is made from, in its folder under maps/. */
export const MAP_HERO = 'hero.png';
/** Where the build puts a map's strip, under site/. */
export const mapStripFile = (map) => `maps/${map}.webp`;
/** A map folder's name, as tools/hero.sh takes it. */
export const MAP_NAME = /^[a-z0-9_]+$/;

/** Where the kind lives under ASSETS_DIR (`root`, default the environment's); `maps` is the
 * maps' folder, whose hero.png each strip is made from. */
export function sitePaths(root = assetsDir()) {
  const out = path.join(root, 'site');
  const raw = path.join(root, 'raw', 'site');
  return { out, raw, maps: path.join(root, 'maps'), manifest: path.join(out, 'manifest.json'), buildJson: path.join(out, 'build.json'), ripJson: path.join(raw, 'rip.json') };
}

/** The sha256 (hex) of `map`'s hero.png under `mapsDir`: what its strip was made from. */
export const heroSha256 = (mapsDir, map) =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(mapsDir, map, MAP_HERO))).digest('hex');

/** The maps under `mapsDir` with a hero.png, sorted. */
export function mapsWithHero(mapsDir) {
  if (!fs.existsSync(mapsDir)) return [];
  return fs.readdirSync(mapsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && MAP_NAME.test(d.name) && fs.existsSync(path.join(mapsDir, d.name, MAP_HERO)))
    .map((d) => d.name)
    .sort();
}
