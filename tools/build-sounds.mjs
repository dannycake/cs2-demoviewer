#!/usr/bin/env node
// node tools/build-sounds.mjs [--list-missing]
//
// Packs every sound the viewer plays (lib/sounds.mjs: STATIC_SOUNDS, each weapon's shot and
// reload keys, and per footstep set a CT step, a T step and a landing) from rip-sounds.sh's
// export into one mono Opus/WebM bank per family (lib/sound-bank.mjs):
//   assets/sounds/<bank>.webm   the bank's clips end to end, 0.05 s apart, each without its tail
//                               under -80 dBFS (trimTail); a file several keys play is in it
//                               once, the files in the order the keys first name them
//   assets/sounds/build.json    { raw: { cs2Build, vrf }, params, banks: { <bank>: { bytes,
//                               seconds, clips } }, sounds: { <key>: { bank, layers: [{ clips:
//                               [[offset, duration]], volume, volumeRandom, pitch, pitchRandom,
//                               curve, offset, loop }] } }, surfaces, missing }
// Numbers are rounded to 4 decimals; a layer's clips are its file variants as slices of the
// bank, in seconds. A key whose event has no layer, or one of whose files the rip lacks, is
// listed in `missing` and left out. A clip with no sample at or above -80 dBFS (CS2 ships
// sounds/ui/counter_beep_done silent) is kept as one sample, its span 0 s once rounded, and
// named in a warning. Everything is written into assets/sounds.tmp-<pid>/ (lib/stage.mjs) and
// renamed into place, the banks first and build.json last; a bank this build did not make is
// removed and anything else there (the manifest) left alone. The same rip gives the same bytes.
//
// --list-missing prints, sorted and one per line, the VPK path of each file the build needs and
// the raw dir lacks, for rip-sounds.sh to export: the soundevents and surface files when any of
// them is missing (the sounds cannot be named without them), else each sound file a key plays,
// less those rip.json lists as `absent` (the VPK gave nothing for them). Every path it prints
// matches VPK_PATH, which rip-sounds.sh checks each line against too.
//
// The raw dir is SOUNDS_RAW_DIR when set (rip-sounds.sh points it at its export), else
// assets/raw/sounds. Exit 1 naming the file when the rip lacks a soundevent or surface file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './lib/cli.mjs';
import { parseKv3 } from './lib/kv3.mjs';
import { RAW_SOUNDS_DIR, SOUNDS_DIR } from './lib/paths.mjs';
import { BANK_PARAMS, decodeClip, encodeBank, packBank, trimTail } from './lib/sound-bank.mjs';
import { SOUNDEVENT_FILES, STATIC_SOUNDS, resolveLayers, stepSets, weaponSoundKeys } from './lib/sounds.mjs';
import { staging } from './lib/stage.mjs';

const VSURF = 'surfaceproperties/surfaceproperties.vsurf';
const FOOTSTEPS = 'scripts/surfaceproperties_footsteps.txt';

/** The files the keys are read from: where the rip puts each (`file`) and its path in the VPK. */
const SOURCES = Object.freeze([
  ...SOUNDEVENT_FILES.map((f) => ({ file: `${f}.vsndevts`, vpk: `${f}.vsndevts_c` })),
  { file: VSURF, vpk: `${VSURF}_c` },
  { file: FOOTSTEPS, vpk: FOOTSTEPS },
]);

/**
 * A path --list-missing may print and rip-sounds.sh may export: relative, plain characters, in
 * POSIX ERE as well as JS syntax (the rip matches its `source` with bash's `=~`). A path with a
 * `..` segment is refused besides, here and in the rip.
 */
export const VPK_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/** What VRF decompiles a `.vsnd` to, by the format inside it. */
const AUDIO_EXTENSIONS = Object.freeze(['.wav', '.mp3']);

/** Banks encoded at once, each by its own ffmpeg. */
const PARALLEL = Math.max(1, Math.min(8, os.availableParallelism()));

const round4 = (x) => Math.round(x * 1e4) / 1e4 || 0; // never -0
const sortedObject = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/**
 * @typedef {object} SoundsBuild
 * @property {{cs2Build: string, vrf: string}} raw
 * @property {{rate: number, bitrate: string, gapS: number}} params
 * @property {Record<string, {bytes: number, seconds: number, clips: number}>} banks
 * @property {Record<string, {bank: string, layers: {clips: [number, number][], volume: number,
 *   volumeRandom: [number, number], pitch: number, pitchRandom: [number, number],
 *   curve: [number, number][] | null, offset: [number, number, number], loop: boolean}[]}>} sounds
 * @property {Record<string, string>} surfaces  surface name (and vrf_unknown_key_<hash>) → step set
 * @property {string[]} missing  the keys left out
 */

/** The soundevents (every file's events in one object), the footsteps and the surfaces. */
function readSources(rawDir) {
  const read = (rel) => {
    const file = path.join(rawDir, rel);
    if (!fs.existsSync(file)) throw new Error(`${file} is missing; run tools/rip-sounds.sh`);
    try {
      return parseKv3(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${file}: ${e.message}`);
    }
  };
  // No prototype: an event named __proto__ stays an event.
  const events = Object.create(null);
  for (const f of SOUNDEVENT_FILES) {
    for (const [name, event] of Object.entries(read(`${f}.vsndevts`))) events[name] = event;
  }
  return { events, footsteps: read(FOOTSTEPS), vsurf: read(VSURF) };
}

/** Every key the build packs, in the tables' order, with its event, bank and loop flag; and the surfaces. */
function soundKeys({ events, footsteps, vsurf }) {
  const steps = stepSets(footsteps, vsurf, events);
  return { keys: { ...STATIC_SOUNDS, ...weaponSoundKeys(events), ...steps.keys }, surfaces: steps.surfaces };
}

/** A soundevent's `.vsnd` path without its extension; null unless it is a `.vsnd` path VPK_PATH allows. */
function vsndBase(vsnd) {
  if (typeof vsnd !== 'string' || !vsnd.endsWith('.vsnd') || !VPK_PATH.test(vsnd) || vsnd.split('/').includes('..')) return null;
  return vsnd.slice(0, -'.vsnd'.length);
}

/** The VPK paths rip.json lists as `absent`: sound files the VPK gave nothing for. */
function absentFiles(rawDir) {
  const file = path.join(rawDir, 'rip.json');
  if (!fs.existsSync(file)) return new Set();
  try {
    const { absent } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(Array.isArray(absent) ? absent : []);
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

/** The `.wav` or `.mp3` the rip made of a `.vsnd`, or null when it is not there. */
function audioFile(rawDir, vsnd) {
  const base = vsndBase(vsnd);
  if (!base) return null;
  for (const ext of AUDIO_EXTENSIONS) {
    const file = path.join(rawDir, base + ext);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * The VPK paths rip-sounds.sh should export so the build has every file it needs, sorted: the
 * missing soundevent and surface files when there are any, else every `.vsnd_c` a key plays
 * whose `.wav` or `.mp3` the raw dir lacks and rip.json does not list as `absent`. Empty when
 * nothing is missing. Each matches VPK_PATH.
 * @param {string} rawDir
 * @returns {string[]}
 */
export function missingFiles(rawDir) {
  const sources = SOURCES.filter((s) => !fs.existsSync(path.join(rawDir, s.file))).map((s) => s.vpk);
  if (sources.length) return sources.sort();
  const src = readSources(rawDir);
  const absent = absentFiles(rawDir);
  const out = new Set();
  for (const { event } of Object.values(soundKeys(src).keys)) {
    for (const layer of resolveLayers(src.events, event)) {
      for (const f of layer.files) if (vsndBase(f) && !audioFile(rawDir, f) && !absent.has(`${f}_c`)) out.add(`${f}_c`);
    }
  }
  return [...out].sort();
}

/**
 * Runs `fn` over `items`, `n` at a time; the results in the items' order. The first failure
 * stops new work and is thrown once the items already running have finished.
 */
async function inPool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(n, items.length) }, worker));
  const bad = settled.find((s) => s.status === 'rejected');
  if (bad) throw bad.reason;
  return results;
}

/** Renames `files` from `stage` into `outDir`, in order, then removes any bank there this build did not make. */
function install(stage, outDir, files) {
  stage.commit(outDir, files);
  for (const f of fs.readdirSync(outDir)) {
    if (f.endsWith('.webm') && !files.includes(f)) fs.rmSync(path.join(outDir, f), { force: true });
  }
}

/**
 * Builds every bank and build.json from the rip in `rawDir` into `outDir` (see the header).
 * Throws, leaving `outDir` as it was, when rip.json or a soundevent or surface file is missing
 * or ffmpeg fails.
 * @param {string} rawDir
 * @param {string} outDir
 * @returns {Promise<SoundsBuild>}
 */
export async function buildSounds(rawDir, outDir) {
  const ripFile = path.join(rawDir, 'rip.json');
  if (!fs.existsSync(ripFile)) throw new Error(`${ripFile} is missing; run tools/rip-sounds.sh`);
  let rip;
  try {
    rip = JSON.parse(fs.readFileSync(ripFile, 'utf8'));
  } catch (e) {
    throw new Error(`${ripFile}: ${e.message}`);
  }
  const src = readSources(rawDir);
  const { keys, surfaces } = soundKeys(src);

  // Per bank: its files in the order the keys first name them, and each key's layers with
  // their files as indices into that list.
  const plan = new Map();
  const missing = [];
  for (const [key, { event, bank, loop }] of Object.entries(keys)) {
    const layers = resolveLayers(src.events, event);
    const files = layers.map((l) => l.files.map((f) => audioFile(rawDir, f)));
    if (!layers.length || files.flat().includes(null)) {
      missing.push(key);
      continue;
    }
    if (!plan.has(bank)) plan.set(bank, { files: [], index: new Map(), keys: [] });
    const b = plan.get(bank);
    const indexOf = (file) => {
      if (!b.index.has(file)) b.index.set(file, b.files.push(file) - 1);
      return b.index.get(file);
    };
    b.keys.push({ key, layers: layers.map((l, i) => ({ ...l, files: files[i].map(indexOf), loop: loop === true })) });
  }

  const stage = staging(outDir);
  try {
    const names = [...plan.keys()].sort();
    const floor = 10 ** (BANK_PARAMS.tailDb / 20);
    const silent = [];
    const made = await inPool(names, PARALLEL, async (bank) => {
      const clips = [];
      for (const file of plan.get(bank).files) {
        const clip = trimTail(await decodeClip(file));
        if (clip.length <= 1 && !(Math.abs(clip[0]) >= floor)) silent.push(`${path.relative(rawDir, file)} (${bank})`);
        clips.push(clip);
      }
      const { pcm, spans } = packBank(clips);
      const bytes = await encodeBank(pcm, stage.file(`${bank}.webm`));
      return { bytes, seconds: round4(pcm.length / BANK_PARAMS.rate), clips: clips.length, spans };
    });
    if (silent.length) {
      console.warn(`build-sounds: ${silent.length} clip(s) silent in the rip, each kept as one sample: ${silent.sort().join(', ')}`);
    }

    const banks = {};
    const sounds = {};
    names.forEach((bank, i) => {
      const { spans, ...info } = made[i];
      banks[bank] = info;
      for (const { key, layers } of plan.get(bank).keys) {
        sounds[key] = {
          bank,
          layers: layers.map((l) => ({
            clips: l.files.map((f) => spans[f].map(round4)),
            volume: round4(l.volume),
            volumeRandom: l.volumeRandom.map(round4),
            pitch: round4(l.pitch),
            pitchRandom: l.pitchRandom.map(round4),
            curve: l.curve && l.curve.map((p) => p.map(round4)),
            offset: l.offset.map(round4),
            loop: l.loop,
          })),
        };
      }
    });
    const build = {
      raw: { cs2Build: rip.cs2Build, vrf: rip.vrfVersion },
      params: { ...BANK_PARAMS },
      banks,
      sounds: sortedObject(sounds),
      surfaces: sortedObject(surfaces),
      missing: missing.sort(),
    };
    stage.write('build.json', JSON.stringify(build, null, 2) + '\n');
    install(stage, outDir, [...names.map((b) => `${b}.webm`), 'build.json']);
    return build;
  } finally {
    stage.abort();
  }
}

function fail(msg) {
  console.error(`build-sounds: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const list = args[0] === '--list-missing';
  if (args.length > (list ? 1 : 0)) fail('usage: node tools/build-sounds.mjs [--list-missing]');
  const raw = process.env.SOUNDS_RAW_DIR || RAW_SOUNDS_DIR;
  try {
    if (list) {
      const files = missingFiles(raw);
      if (files.length) process.stdout.write(`${files.join('\n')}\n`);
      return;
    }
    const t0 = performance.now();
    const build = await buildSounds(raw, SOUNDS_DIR);
    const kb = (n) => `${(n / 1e3).toFixed(1)} KB`;
    for (const [bank, b] of Object.entries(build.banks)) {
      const clips = `${String(b.clips).padStart(3)} clips`;
      console.log(`build-sounds: ${`${bank}.webm`.padEnd(30)} ${clips} ${b.seconds.toFixed(1).padStart(6)} s ${kb(b.bytes).padStart(9)}`);
    }
    const { missing } = build;
    if (missing.length) console.error(`build-sounds: ${missing.length} key(s) left out, an event or file missing: ${missing.join(' ')}`);
    const total = Object.values(build.banks).reduce((n, b) => n + b.bytes, 0);
    const counts = `${Object.keys(build.banks).length} bank(s), ${Object.keys(build.sounds).length} sound(s)`;
    const where = path.relative(process.cwd(), SOUNDS_DIR) || '.';
    console.log(`build-sounds: ${counts}, ${kb(total)} in ${where} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    if (process.env.DEBUG) console.error(e?.stack);
    fail(String(e?.message ?? e).split('\n')[0]);
  }
}

if (isMain(import.meta.url)) await main();
