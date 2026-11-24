#!/usr/bin/env node
// node tools/manifest.mjs <map>|<kind>|root   (the kinds: lib/kinds.mjs KINDS)
//
// <map>    → assets/maps/<map>/manifest.json   every served file with bytes and sha256,
//            cs2Build/vrf from assets/raw/<map>/rip.json, world tris and texture sizes
//            from shrink.json, section names from overview.json, with sky.webp
//            `sky.horizon` from sky.json (sky.mjs; required when sky.webp is there), and with
//            world_lo.glb (phone-tier.mjs) `lo.textureSize` from world_lo.json
// players  → assets/players/manifest.json      ct.glb and t.glb with model, clips, bytes
//            and sha256, and each side's phone tier (<side>_lo.glb, phone-tier.mjs) as `lo`
//            where it was built; cs2Build/vrf from assets/raw/players/rip.json
// weapons  → assets/weapons/manifest.json      every weapon model and the kit with bytes, sha256 and tris
// viewmodels → assets/viewmodels/manifest.json  the two arms models and every weapon's clip
//            file with bytes, sha256 and clip names; cs2Build/vrf from raw/viewmodels/rip.json
// effects  → assets/effects/manifest.json      every effect atlas with bytes, sha256, size,
//            grid and sequences from build.json; cs2Build/vrf from raw/effects/rip.json
// sounds   → assets/sounds/manifest.json (and its .gz)  every bank with bytes, sha256 and
//            seconds, the sounds and the surfaces from build.json; cs2Build/vrf from
//            raw/sounds/rip.json
// root     → assets/manifest.json              one line per assets/maps/<map>/manifest.json
//            that exists, plus each asset kind's build (lib/kinds.mjs KINDS: its `root` entry)
//
// A manifest is written only when everything it describes agrees: the four required
// map files exist, every overview section's image exists and every radar image has a
// section, light.json and the bake files it names are there together or not at all (and
// there, for a map of lib/maps.mjs LIGHTMAP_MAPS, which ships CS2's baked light), and
// the GLB sizes match shrink.json (a stale shrink.json would lie about tris), entities.glb
// among them on maps that have one (and on no other), and a phone tier (world_lo.glb,
// <side>_lo.glb) is the file its record (world_lo.json, <side>_lo.json) describes, made from
// the world.glb or <side>.glb beside it: the two are there together or not at all (without
// them the viewer's `low` preset loads the desktop's files). Otherwise exit 1 naming the
// file, and the old manifest is left alone. Each manifest is written to <file>.tmp-<pid> and
// renamed into place (lib/stage.mjs writeJsonAtomic); the sounds manifest's gzip -9 `.gz`
// sibling (which the server sends a client that accepts gzip) is renamed into place just before
// it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isMain } from './lib/cli.mjs';
import { EFFECT_KEYS } from './lib/effects.mjs';
import { KINDS, kindOf, kindPaths } from './lib/kinds.mjs';
import { LIGHTMAP_MAPS, MAP_BAKE_FILES } from './lib/maps.mjs';
import { assetsDir, paths } from './lib/paths.mjs';
import { SIDES } from './lib/players.mjs';
import { writeJsonAtomic } from './lib/stage.mjs';
import { armsPaths, VIEWMODEL_DIRS } from './lib/viewmodels.mjs';
import { MODEL_NAMES, WEAPON_NAMES } from './lib/weapons.mjs';
import { HOME_FILES, RANK_KEYS, sitePaths } from './lib/site.mjs';
import { PHONE_WORLD, phonePlayer } from './phone-tier.mjs';

export const SCHEMA = 1;

/**
 * Served map files, in manifest order. world_lo.glb is there only when phone-tier.mjs built
 * the map's phone tier, radar_lower.png only for a map with a lower level, entities.glb only for
 * a map with doors or breakable windows, sky.webp only when sky.mjs found the map's sky (the
 * viewer keeps its colour sky without it), and the bake files (lib/maps.mjs MAP_BAKE_FILES) only
 * when shrink-map.mjs baked the map's light: light.json names the others it uses (no
 * lightmap.webp under tier V). The rest are required.
 */
export const MAP_FILES = Object.freeze(['world.glb', PHONE_WORLD.to, 'hull.glb', 'entities.glb', 'radar.png', 'radar_lower.png', 'sky.webp', ...MAP_BAKE_FILES, 'overview.json']);
const MAP_OPTIONAL = new Set([PHONE_WORLD.to, 'radar_lower.png', 'entities.glb', 'sky.webp', ...MAP_BAKE_FILES]);
/** shrink.json `bytes` key per GLB; an optional one is in shrink.json exactly when it was built. */
const SHRINK_BYTES = Object.freeze({ 'world.glb': 'world', 'hull.glb': 'hull', 'entities.glb': 'entities' });
const RADAR_IMAGE = /^radar(_[a-z0-9]+)?\.png$/;

/** `2026-10-21T20:00:00Z`: UTC, whole seconds. */
export function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `20.0.6980+a068…` → `20.0.6980`. */
export function vrfShort(version) {
  return String(version).split('+')[0];
}

/** `{ bytes, sha256 }` of a file; sha256 is hex of its bytes. */
export async function fileEntry(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return { bytes: fs.statSync(file).size, sha256: hash.digest('hex') };
}

function readJson(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing${hint ? `; ${hint}` : ''}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

/**
 * The phone tier `target` (phone-tier.mjs PHONE_WORLD, phonePlayer) in `dir` against its record:
 * null when neither its GLB nor its record is there, else `{ entry, record }` (`entry` the GLB's
 * bytes and sha256) once the record describes this GLB, made from the source whose entry is
 * `source`. Throws naming `rerun` otherwise: a GLB without its record or a record without its
 * GLB, other bytes than the record's, or a record of another source (a phone tier left from
 * before the source was rebuilt).
 */
async function phoneTierEntry(dir, target, source, rerun) {
  const file = path.join(dir, target.to);
  const recordFile = path.join(dir, target.record);
  if (!fs.existsSync(file)) {
    if (fs.existsSync(recordFile)) throw new Error(`${file} is missing but ${recordFile} records it; rerun ${rerun}`);
    return null;
  }
  const record = readJson(recordFile, `rerun ${rerun}`);
  const entry = await fileEntry(file);
  if (entry.bytes !== record.bytes) throw new Error(`${target.to} is ${entry.bytes} bytes but ${recordFile} records ${record.bytes}; rerun ${rerun}`);
  if (entry.sha256 !== record.sha256) throw new Error(`${target.to} is not the file ${recordFile} records (its sha256 differs); rerun ${rerun}`);
  if (record.source?.file !== target.from || record.source?.sha256 !== source.sha256) {
    throw new Error(`${target.to} was made from another ${target.from} than ${path.join(dir, target.from)} (${recordFile}); rerun ${rerun}`);
  }
  return { entry, record };
}

function ripBuild(rip, file) {
  if (typeof rip.cs2Build !== 'string' || !rip.cs2Build) throw new Error(`${file} has no cs2Build`);
  if (typeof rip.vrfVersion !== 'string' || !rip.vrfVersion) throw new Error(`${file} has no vrfVersion`);
  return { cs2Build: rip.cs2Build, vrf: vrfShort(rip.vrfVersion) };
}

/**
 * The manifest of one shrunk map (not written).
 * @param {string} map     e.g. 'de_mirage'
 * @param {string} outDir  assets/maps/<map>/ (GLBs, radars, overview.json, shrink.json)
 * @param {string} rawDir  assets/raw/<map>/ (rip.json)
 */
export async function mapManifest(map, outDir, rawDir) {
  const ripFile = path.join(rawDir, 'rip.json');
  const rip = readJson(ripFile, `run tools/rip-map.sh ${map}`);
  if (rip.map !== undefined && rip.map !== map) throw new Error(`${ripFile} is for ${rip.map}, not ${map}`);
  const build = ripBuild(rip, ripFile);

  const shrinkFile = path.join(outDir, 'shrink.json');
  const shrink = readJson(shrinkFile, `run tools/shrink-map.mjs ${map}`);
  const overviewFile = path.join(outDir, 'overview.json');
  const overview = readJson(overviewFile, `run tools/radar.mjs ${map}`);
  if (!Array.isArray(overview.sections) || overview.sections.length === 0) throw new Error(`${overviewFile} has no sections`);

  const present = new Set(MAP_FILES.filter((f) => fs.existsSync(path.join(outDir, f))));
  for (const f of MAP_FILES) {
    if (!MAP_OPTIONAL.has(f) && !present.has(f)) throw new Error(`${path.join(outDir, f)} is missing`);
  }
  // Every section's image is served, and every radar image served belongs to a section.
  const named = new Set(overview.sections.map((s) => s.image));
  for (const s of overview.sections) {
    if (!present.has(s.image)) throw new Error(`${overviewFile} section "${s.name}" names ${s.image}, which ${outDir} lacks`);
  }
  for (const f of fs.readdirSync(outDir)) {
    if (RADAR_IMAGE.test(f) && !named.has(f)) throw new Error(`${path.join(outDir, f)} is named by no section of ${overviewFile}`);
  }

  // The baked light is whole or absent: light.json and every file it names, or none of them.
  if (present.has('light.json')) {
    const lightFile = path.join(outDir, 'light.json');
    const light = readJson(lightFile);
    for (const f of [light.lightmap?.file, light.probes?.file].filter(Boolean)) {
      if (!present.has(f)) throw new Error(`${lightFile} names ${f}, which ${outDir} lacks; rerun tools/shrink-map.mjs ${map}`);
    }
  } else {
    const stray = MAP_BAKE_FILES.find((f) => present.has(f));
    if (stray) throw new Error(`${path.join(outDir, stray)} is there without its light.json; rerun tools/shrink-map.mjs ${map}`);
    // Built with AO, which a map in LIGHTMAP_MAPS never ships. check-map.mjs fails such a map
    // before build-assets.sh gets here; this holds a manifest run by hand to the same.
    if (LIGHTMAP_MAPS.includes(map)) {
      throw new Error(`${path.join(outDir, 'light.json')} is missing: ${map} is in LIGHTMAP_MAPS (tools/lib/maps.mjs), so it ships CS2's baked light, not AO; rerun tools/shrink-map.mjs ${map}`);
    }
  }

  const files = {};
  for (const f of MAP_FILES) if (present.has(f)) files[f] = await fileEntry(path.join(outDir, f));
  for (const [f, key] of Object.entries(SHRINK_BYTES)) {
    const recorded = shrink.bytes?.[key];
    if (!files[f]) {
      // Only an optional GLB can be absent here; shrink.json must not record it either.
      if (recorded !== undefined) throw new Error(`${path.join(outDir, f)} is missing but ${shrinkFile} records ${recorded} bytes; rerun tools/shrink-map.mjs ${map}`);
      continue;
    }
    if (files[f].bytes !== recorded) {
      throw new Error(`${f} is ${files[f].bytes} bytes but ${shrinkFile} records ${recorded}; rerun tools/shrink-map.mjs ${map}`);
    }
  }
  if (!Number.isInteger(shrink.trisOut)) throw new Error(`${shrinkFile} has no trisOut`);
  const lo = await phoneTierEntry(outDir, PHONE_WORLD, files['world.glb'], `tools/phone-tier.mjs ${map}`);
  // The sky's horizon colour, which the viewer gives the fog and the sky below the horizon.
  let sky = null;
  if (present.has('sky.webp')) {
    const skyFile = path.join(outDir, 'sky.json');
    const record = readJson(skyFile, `run tools/sky.mjs ${map}`);
    if (typeof record.horizon !== 'string' || !/^#[0-9a-f]{6}$/.test(record.horizon)) {
      throw new Error(`${skyFile} has no horizon colour; run tools/sky.mjs ${map}`);
    }
    sky = { horizon: record.horizon };
  }

  return {
    map,
    schema: SCHEMA,
    cs2Build: build.cs2Build,
    vrf: build.vrf,
    generated: now(),
    files,
    // The size world.glb's textures shipped at: a bake's ladder may have taken them below the
    // parameter's (H2 or V at 192 px), and records the size it shipped.
    world: { tris: shrink.trisOut, textureSize: shrink.bake?.worldTextureSize ?? shrink.params?.world?.size, ao: shrink.aoVertices > 0 },
    // The phone tier, which the viewer's `low` preset loads in place of world.glb.
    ...(lo ? { lo: { textureSize: lo.record.params?.size } } : {}),
    sections: overview.sections.map((s) => s.name),
    ...(sky ? { sky } : {}),
  };
}

/**
 * The manifest of assets/players/ (not written).
 * @param {string} outDir  assets/players/ (<side>.glb, <side>.shrink.json)
 * @param {string} rawDir  assets/raw/players/ (rip.json)
 */
export async function playersManifest(outDir, rawDir) {
  const ripFile = path.join(rawDir, 'rip.json');
  const rip = readJson(ripFile, 'run tools/rip-players.sh');
  const build = ripBuild(rip, ripFile);
  const out = { schema: SCHEMA, cs2Build: build.cs2Build, vrf: build.vrf, generated: now() };
  for (const side of SIDES) {
    const vmdl = rip.models?.[side]?.vmdl;
    if (typeof vmdl !== 'string') throw new Error(`${ripFile} has no models.${side}.vmdl`);
    const shrinkFile = path.join(outDir, `${side}.shrink.json`);
    const shrink = readJson(shrinkFile, `run tools/shrink-player.mjs ${side}`);
    const glb = path.join(outDir, `${side}.glb`);
    if (!fs.existsSync(glb)) throw new Error(`${glb} is missing; run tools/shrink-player.mjs ${side}`);
    if (shrink.raw?.cs2Build !== build.cs2Build) {
      throw new Error(`${shrinkFile} was made from CS2 build ${shrink.raw?.cs2Build}, ${ripFile} is ${build.cs2Build}; rerun tools/shrink-player.mjs ${side}`);
    }
    const entry = await fileEntry(glb);
    if (entry.bytes !== shrink.bytes) {
      throw new Error(`${side}.glb is ${entry.bytes} bytes but ${shrinkFile} records ${shrink.bytes}; rerun tools/shrink-player.mjs ${side}`);
    }
    if (!Array.isArray(shrink.clips)) throw new Error(`${shrinkFile} has no clips`);
    const gzFile = `${glb}.gz`;
    if (!fs.existsSync(gzFile)) throw new Error(`${gzFile} is missing; rerun tools/shrink-player.mjs ${side}`);
    const gz = await fileEntry(gzFile);
    // The side's phone tier, which the viewer's `low` preset loads in place of <side>.glb.
    const target = phonePlayer(side);
    const lo = await phoneTierEntry(outDir, target, entry, 'tools/phone-tier.mjs players');
    const loGz = path.join(outDir, `${target.to}.gz`);
    if (lo && !fs.existsSync(loGz)) throw new Error(`${loGz} is missing; rerun tools/phone-tier.mjs players`);
    out[side] = {
      model: path.basename(vmdl, '.vmdl_c'), clips: shrink.clips, ...entry, gz,
      ...(lo ? { lo: { file: target.to, textureSize: lo.record.params?.size, ...lo.entry, gz: await fileEntry(loGz) } } : {}),
    };
  }
  return out;
}

/**
 * The manifest of assets/weapons/ (not written): one entry per MODEL_PATHS name (the
 * weapons and the ground-only models such as the kit) with the model's short name, bytes,
 * sha256, triangles and the `.glb.gz` sibling.
 * @param {string} outDir  assets/weapons/ (<name>.glb, <name>.glb.gz, <name>.shrink.json)
 * @param {string} rawDir  assets/raw/weapons/ (rip.json)
 */
export async function weaponsManifest(outDir, rawDir) {
  const ripFile = path.join(rawDir, 'rip.json');
  const rip = readJson(ripFile, 'run tools/rip-weapons.sh');
  const build = ripBuild(rip, ripFile);
  const weapons = {};
  for (const name of MODEL_NAMES) {
    const vmdl = rip.models?.[name]?.vmdl;
    if (typeof vmdl !== 'string') throw new Error(`${ripFile} has no models.${name}.vmdl; run tools/rip-weapons.sh --force`);
    const shrinkFile = path.join(outDir, `${name}.shrink.json`);
    const shrink = readJson(shrinkFile, `run tools/shrink-weapon.mjs ${name}`);
    const glb = path.join(outDir, `${name}.glb`);
    if (!fs.existsSync(glb)) throw new Error(`${glb} is missing; run tools/shrink-weapon.mjs ${name}`);
    if (shrink.raw?.cs2Build !== build.cs2Build) {
      throw new Error(`${shrinkFile} was made from CS2 build ${shrink.raw?.cs2Build}, ${ripFile} is ${build.cs2Build}; rerun tools/shrink-weapon.mjs ${name}`);
    }
    const entry = await fileEntry(glb);
    if (entry.bytes !== shrink.bytes) {
      throw new Error(`${name}.glb is ${entry.bytes} bytes but ${shrinkFile} records ${shrink.bytes}; rerun tools/shrink-weapon.mjs ${name}`);
    }
    const gzFile = `${glb}.gz`;
    if (!fs.existsSync(gzFile)) throw new Error(`${gzFile} is missing; rerun tools/shrink-weapon.mjs ${name}`);
    weapons[name] = { model: path.basename(vmdl, '.vmdl_c'), tris: shrink.trisOut, ...entry, gz: await fileEntry(gzFile) };
  }
  return { schema: SCHEMA, cs2Build: build.cs2Build, vrf: build.vrf, generated: now(), weapons };
}

/**
 * The manifest of assets/viewmodels/ (not written): the first-person arms per side
 * (`arms_<side>.glb`, `{ model, bytes, sha256, gz }`, `model` the agent's short name) and one
 * entry per WEAPON_MODELS name (`<name>.glb`, `{ dir, clips, bytes, sha256, gz }`, `clips` the
 * sorted clip names from its shrink.json). Refuses a GLB whose size differs from its
 * shrink.json, a missing `.gz`, and a shrink.json made from another rip.
 * @param {string} outDir  assets/viewmodels/
 * @param {string} rawDir  assets/raw/viewmodels/ (rip.json)
 */
export async function viewmodelsManifest(outDir, rawDir) {
  const ripFile = path.join(rawDir, 'rip.json');
  const rip = readJson(ripFile, 'run tools/rip-viewmodels.sh');
  const build = ripBuild(rip, ripFile);
  const checked = async (glb, shrinkFile, rerun) => {
    if (!fs.existsSync(glb)) throw new Error(`${glb} is missing; run ${rerun}`);
    const shrink = readJson(shrinkFile, `run ${rerun}`);
    const entry = await fileEntry(glb);
    if (entry.bytes !== shrink.bytes) throw new Error(`${path.basename(glb)} is ${entry.bytes} bytes but ${shrinkFile} records ${shrink.bytes}; rerun ${rerun}`);
    const gzFile = `${glb}.gz`;
    if (!fs.existsSync(gzFile)) throw new Error(`${gzFile} is missing; rerun ${rerun}`);
    return { shrink, entry: { ...entry, gz: await fileEntry(gzFile) } };
  };
  const arms = {};
  for (const side of SIDES) {
    const P = armsPaths(side);
    const { shrink, entry } = await checked(path.join(outDir, path.basename(P.glb)), path.join(outDir, path.basename(P.shrinkJson)), `tools/shrink-arms.mjs ${side}`);
    if (shrink.raw?.viewmodelsBuild !== build.cs2Build) {
      throw new Error(`arms_${side}.shrink.json took its skeleton from CS2 build ${shrink.raw?.viewmodelsBuild}, ${ripFile} is ${build.cs2Build}; rerun tools/shrink-arms.mjs ${side}`);
    }
    arms[side] = { model: path.basename(String(shrink.model), '.vmdl_c'), ...entry };
  }
  const weapons = {};
  for (const name of WEAPON_NAMES) {
    const { shrink, entry } = await checked(path.join(outDir, `${name}.glb`), path.join(outDir, `${name}.shrink.json`), `tools/shrink-viewmodel-clips.mjs ${name}`);
    if (shrink.raw?.cs2Build !== build.cs2Build) {
      throw new Error(`${name}.shrink.json was made from CS2 build ${shrink.raw?.cs2Build}, ${ripFile} is ${build.cs2Build}; rerun tools/shrink-viewmodel-clips.mjs ${name}`);
    }
    if (shrink.dir !== VIEWMODEL_DIRS[name]) throw new Error(`${name}.shrink.json is from ${shrink.dir}, not ${VIEWMODEL_DIRS[name]}; rerun tools/shrink-viewmodel-clips.mjs ${name}`);
    weapons[name] = { dir: shrink.dir, clips: Object.keys(shrink.clips ?? {}).sort(), ...entry };
  }
  return { schema: SCHEMA, cs2Build: build.cs2Build, vrf: build.vrf, generated: now(), arms, weapons };
}

/**
 * The manifest of assets/effects/ (not written): one entry per EFFECTS key, in table order,
 * `{ file, bytes, sha256, width, height, cell, cols, frames, sequences }` (`sequences` as
 * `[firstFrame, count]`), what the viewer needs to cut frames from each atlas. Refuses a missing
 * atlas, one whose size differs from build.json, and a build.json made from another rip.
 * @param {string} outDir  assets/effects/ (<key>.webp, build.json)
 * @param {string} rawDir  assets/raw/effects/ (rip.json)
 */
export async function effectsManifest(outDir, rawDir) {
  const ripFile = path.join(rawDir, 'rip.json');
  const rip = readJson(ripFile, 'run tools/rip-effects.sh');
  const build = ripBuild(rip, ripFile);
  const buildFile = path.join(outDir, 'build.json');
  const built = readJson(buildFile, 'run tools/build-effects.mjs');
  if (built.cs2Build !== build.cs2Build) {
    throw new Error(`${buildFile} was made from CS2 build ${built.cs2Build}, ${ripFile} is ${build.cs2Build}; rerun tools/build-effects.mjs`);
  }
  const atlases = {};
  for (const key of EFFECT_KEYS) {
    const b = built.atlases?.[key];
    if (!b) throw new Error(`${buildFile} has no atlas ${key}; rerun tools/build-effects.mjs`);
    const file = path.join(outDir, b.file);
    if (!fs.existsSync(file)) throw new Error(`${file} is missing; run tools/build-effects.mjs`);
    const entry = await fileEntry(file);
    if (entry.bytes !== b.bytes) throw new Error(`${b.file} is ${entry.bytes} bytes but ${buildFile} records ${b.bytes}; rerun tools/build-effects.mjs`);
    atlases[key] = {
      file: b.file, ...entry, width: b.width, height: b.height, cell: b.cell, cols: b.cols, frames: b.frames, sequences: b.sequences,
    };
  }
  return { schema: SCHEMA, cs2Build: build.cs2Build, vrf: build.vrf, generated: now(), atlases };
}

/**
 * The manifest of assets/site/ (not written): each rank icon and the Steam logo as
 * `{ file, bytes, sha256 }` (paths under site/), each map's strip by map (`maps`, sorted; none
 * from a build.json made before them), and the homepage video's three files once all three
 * are there (`home`, else null). Refuses a missing icon or strip, one whose size differs from
 * build.json, and a build.json made from another rip.
 */
export async function siteManifest(outDir, rawDir) {
  const P = { ...sitePaths(), out: outDir, raw: rawDir, buildJson: path.join(outDir, 'build.json'), ripJson: path.join(rawDir, 'rip.json') };
  const rip = readJson(P.ripJson, 'run tools/rip-site.sh');
  const build = ripBuild(rip, P.ripJson);
  const built = readJson(P.buildJson, 'run tools/build-site.mjs');
  if (built.cs2Build !== build.cs2Build) {
    throw new Error(`${P.buildJson} was made from CS2 build ${built.cs2Build}, ${P.ripJson} is ${build.cs2Build}; rerun tools/build-site.mjs`);
  }
  const entry = async (file, bytes) => {
    const full = path.join(outDir, file);
    if (!fs.existsSync(full)) throw new Error(`${full} is missing; run tools/build-site.mjs`);
    const e = await fileEntry(full);
    if (bytes !== undefined && e.bytes !== bytes) throw new Error(`${file} is ${e.bytes} bytes but ${P.buildJson} records ${bytes}; rerun tools/build-site.mjs`);
    return { file, ...e };
  };
  const ranks = {};
  for (const key of RANK_KEYS) {
    const b = built.ranks?.[key];
    if (!b) throw new Error(`${P.buildJson} has no rank ${key}; rerun tools/build-site.mjs`);
    ranks[key] = await entry(b.file, b.bytes);
  }
  const steamLogo = await entry(built.steamLogo.file, built.steamLogo.bytes);
  // A build.json from before the strips has none.
  const maps = {};
  for (const map of Object.keys(built.maps ?? {}).sort()) maps[map] = await entry(built.maps[map].file, built.maps[map].bytes);
  const homeThere = Object.values(HOME_FILES).every((f) => fs.existsSync(path.join(outDir, f)));
  const home = homeThere
    ? { mp4: await entry(HOME_FILES.mp4), webm: await entry(HOME_FILES.webm), poster: await entry(HOME_FILES.poster) }
    : null;
  return { schema: SCHEMA, cs2Build: build.cs2Build, vrf: build.vrf, generated: now(), ranks, steamLogo, maps, home };
}

/**
 * The manifest of assets/sounds/ (not written): per bank of build.json, sorted, `{ bytes, sha256,
 * seconds }`, and build.json's `sounds` (each key's bank and layers, the clips as `[offset,
 * duration]` seconds into the bank) and `surfaces` (surface name → step set) as they are.
 * Refuses a missing bank, one whose size differs from build.json, a sound whose bank build.json
 * does not list, and a build.json made from another rip (its `raw` CS2 build or VRF version not
 * rip.json's).
 * @param {string} outDir  assets/sounds/ (<bank>.webm, build.json)
 * @param {string} rawDir  assets/raw/sounds/ (rip.json)
 */
export async function soundsManifest(outDir, rawDir) {
  const ripFile = path.join(rawDir, 'rip.json');
  const rip = readJson(ripFile, 'run tools/rip-sounds.sh');
  const build = ripBuild(rip, ripFile);
  const buildFile = path.join(outDir, 'build.json');
  const built = readJson(buildFile, 'run tools/build-sounds.mjs');
  if (built.raw?.cs2Build !== rip.cs2Build || built.raw?.vrf !== rip.vrfVersion) {
    throw new Error(`${buildFile} was made from CS2 build ${built.raw?.cs2Build} (VRF ${built.raw?.vrf}), ${ripFile} is ${rip.cs2Build} (VRF ${rip.vrfVersion}); rerun tools/build-sounds.mjs`);
  }
  for (const k of ['banks', 'sounds', 'surfaces']) {
    if (!built[k] || typeof built[k] !== 'object' || Array.isArray(built[k])) throw new Error(`${buildFile} has no ${k}; rerun tools/build-sounds.mjs`);
  }
  const banks = {};
  for (const bank of Object.keys(built.banks).sort()) {
    const b = built.banks[bank];
    const file = path.join(outDir, `${bank}.webm`);
    if (!fs.existsSync(file)) throw new Error(`${file} is missing; run tools/build-sounds.mjs`);
    const entry = await fileEntry(file);
    if (entry.bytes !== b.bytes) throw new Error(`${bank}.webm is ${entry.bytes} bytes but ${buildFile} records ${b.bytes}; rerun tools/build-sounds.mjs`);
    banks[bank] = { ...entry, seconds: b.seconds };
  }
  for (const [key, sound] of Object.entries(built.sounds)) {
    if (!Object.hasOwn(banks, sound?.bank)) throw new Error(`${buildFile} plays ${key} from bank ${sound?.bank}, which it does not list; rerun tools/build-sounds.mjs`);
  }
  return { schema: SCHEMA, cs2Build: build.cs2Build, vrf: build.vrf, generated: now(), banks, sounds: built.sounds, surfaces: built.surfaces };
}

/**
 * assets/manifest.json (not written): the per-map manifests under <root>/maps/ that
 * exist, sorted by map name, then each asset kind's build in lib/kinds.mjs KINDS order (its
 * `root` entry; null without its manifest).
 * @param {string} root  ASSETS_DIR
 */
export async function rootManifest(root) {
  const mapsDir = path.join(root, 'maps');
  const maps = {};
  const names = fs.existsSync(mapsDir)
    ? fs.readdirSync(mapsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.includes('.tmp-')).map((d) => d.name).sort()
    : [];
  for (const name of names) {
    const file = path.join(mapsDir, name, 'manifest.json');
    if (!fs.existsSync(file)) continue;
    const m = readJson(file);
    if (m.schema !== SCHEMA) throw new Error(`${file} has schema ${m.schema}, expected ${SCHEMA}`);
    if (m.map !== name) throw new Error(`${file} is for ${m.map}, not ${name}`);
    maps[name] = {
      cs2Build: m.cs2Build,
      bytes: Object.values(m.files).reduce((n, f) => n + f.bytes, 0),
      sections: m.sections,
    };
  }
  // Each kind's line (lib/kinds.mjs), null without its manifest.
  const kinds = {};
  for (const k of KINDS) {
    const file = path.join(root, k.name, 'manifest.json');
    if (!fs.existsSync(file)) {
      kinds[k.name] = null;
      continue;
    }
    const m = readJson(file);
    if (m.schema !== SCHEMA) throw new Error(`${file} has schema ${m.schema}, expected ${SCHEMA}`);
    kinds[k.name] = k.root(m);
  }
  return { schema: SCHEMA, generated: now(), maps, ...kinds };
}

const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

/**
 * Each asset kind's (lib/kinds.mjs KINDS) manifest builder, `build(out, raw)`, and the line
 * `manifest.mjs <kind>` logs after writing it, `line(m, file)`.
 */
export const KIND_MANIFESTS = Object.freeze({
  players: {
    build: playersManifest,
    line: (m) => `${SIDES.map((s) => `${s} ${m[s].model} ${mb(m[s].bytes)} ${m[s].clips.length} clips`).join(', ')}; build ${m.cs2Build}, VRF ${m.vrf}`,
  },
  weapons: {
    build: weaponsManifest,
    line: (m) => {
      const list = Object.values(m.weapons);
      return `${list.length} weapons, ${mb(list.reduce((n, w) => n + w.bytes, 0))} (${mb(list.reduce((n, w) => n + w.gz.bytes, 0))} gz); build ${m.cs2Build}, VRF ${m.vrf}`;
    },
  },
  viewmodels: {
    build: viewmodelsManifest,
    line: (m) => {
      const list = [...Object.values(m.arms), ...Object.values(m.weapons)];
      return `${Object.keys(m.arms).length} arms, ${Object.keys(m.weapons).length} clip files, ${mb(list.reduce((n, w) => n + w.bytes, 0))} (${mb(list.reduce((n, w) => n + w.gz.bytes, 0))} gz); build ${m.cs2Build}, VRF ${m.vrf}`;
    },
  },
  effects: {
    build: effectsManifest,
    line: (m) => `${Object.keys(m.atlases).length} atlases, ${mb(Object.values(m.atlases).reduce((n, a) => n + a.bytes, 0))}; build ${m.cs2Build}, VRF ${m.vrf}`,
  },
  sounds: {
    build: soundsManifest,
    line: (m, file) => {
      const kb = (f) => `${(fs.statSync(f).size / 1e3).toFixed(1)} KB`;
      return `${Object.keys(m.banks).length} banks, ${mb(Object.values(m.banks).reduce((n, b) => n + b.bytes, 0))}, ${Object.keys(m.sounds).length} sounds (the manifest ${kb(file)}, ${kb(`${file}.gz`)} gz); build ${m.cs2Build}, VRF ${m.vrf}`;
    },
  },
  site: {
    build: siteManifest,
    line: (m) => `${Object.keys(m.ranks).length} rank icons, ${(Object.values(m.ranks).reduce((n, r) => n + r.bytes, 0) / 1e3).toFixed(1)} KB, the Steam logo, ${Object.keys(m.maps).length} map strips, ${(Object.values(m.maps).reduce((n, r) => n + r.bytes, 0) / 1e3).toFixed(1)} KB, ${m.home ? `the homepage video (${mb(m.home.mp4.bytes)} mp4)` : 'no homepage video'}; build ${m.cs2Build}, VRF ${m.vrf}`,
  },
});

const usage = `usage: node tools/manifest.mjs <map>|${KINDS.map((k) => k.name).join('|')}|root`;

function fail(msg) {
  console.error(`manifest: ${msg}`);
  process.exit(1);
}

async function main() {
  const arg = process.argv[2];
  if (!arg || process.argv.length > 3) fail(usage);
  const root = assetsDir();
  const kind = kindOf(arg);
  let file;
  let m;
  try {
    if (kind) {
      const P = kindPaths(kind);
      file = P.manifest;
      m = await KIND_MANIFESTS[kind.name].build(P.out, P.raw);
    } else if (arg === 'root') {
      file = path.join(root, 'manifest.json');
      m = await rootManifest(root);
    } else {
      let P;
      try { P = paths(arg); } catch (e) { throw new Error(`${e.message}; ${usage}`); }
      file = P.manifest;
      m = await mapManifest(arg, P.out, P.raw);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, m, { gz: !!kind?.gz });
  } catch (e) {
    if (process.env.DEBUG) console.error(e?.stack);
    fail(String(e?.message ?? e).split('\n')[0]);
  }
  const rel = path.relative(process.cwd(), file) || file;
  if (arg === 'root') {
    const names = Object.keys(m.maps);
    const kinds = KINDS.map((k) => `${k.name} ${m[k.name] ? k.rootLine(m[k.name]) : 'absent'}`);
    console.log(`manifest: ${rel}: ${names.length} map(s)${names.length ? ` (${names.join(', ')})` : ''}, ${kinds.join(', ')}`);
  } else if (kind) {
    console.log(`manifest: ${rel}: ${KIND_MANIFESTS[kind.name].line(m, file)}`);
  } else {
    const total = Object.values(m.files).reduce((n, f) => n + f.bytes, 0);
    console.log(`manifest: ${rel}: ${Object.keys(m.files).length} files, ${mb(total)}, ${m.world.tris} tris, sections ${m.sections.join(', ')}; build ${m.cs2Build}, VRF ${m.vrf}`);
  }
}

if (isMain(import.meta.url)) await main();
