#!/usr/bin/env node
// node tools/model-poses.mjs <map>... | all   (run through tools/model-poses.sh, which sets CS2_DIR,
// S2V_CLI and CS2_BUILD from lib/env.sh; build-assets.sh runs it between rip-map.sh and
// shrink-map.mjs)
//
// Writes assets/raw/<map>/model-poses.json beside each map's rip: the table lib/poses.mjs
// poseSkinnedProps reads. It lists every model the map's raw world draws skinned, from the GLB's
// JSON chunk alone: a mesh node with JOINTS_n and no skin, named `<model>.<mesh>`. For each:
// - its entities in raw/<map>/entities/default_ents.vents (by model file name) give the vmdl and
//   the animation the game draws it in: their starting or idle animation, else the model's first
//   (its default sequence; a door's `ref`).
// - Source2Viewer-CLI exports the vmdl with its animations; `pose` is each used joint's skinning
//   matrix in that animation's first frame (animationPose), rounded to 1e-6, or null when every
//   one is within 0.01 of the identity: the exported pose is the drawn one.
// - a model no entity names (Vertigo's intro helicopter, which a point_template spawns; its
//   PER_MAP rule drops it anyway) or one without animations keeps a null pose.
// - a model it cannot work out gets `error` instead (two vmdls under one file name, entities that
//   play different animations, a clip the model lacks, a vertex on a joint its skin lacks, a
//   failed or unreadable export, or one without a skin or clips whose stderr shows an exception;
//   with the CLI's stderr less its stack frames). shrink-map.mjs stops on it only for a map that
//   still draws the model after its drop.
// `cs2Build` and `vrfVersion` are the install's and the CLI's (lib/vrf.mjs, the parser rip-map.sh
// uses); shrink-map.mjs stops when they are not the rip's. The CLI runs in the run's export folder:
// it writes exceptions.txt into its working directory (and still exits 0). The run fails only on
// what stops every map: no CS2 install or CLI, or a named map without a raw world. The table is
// Valve-derived data, so it stays out of git. It is written through <file>.tmp-<pid> and a rename
// (lib/stage.mjs),
// and replaces only its own earlier table.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './lib/cli.mjs';
import { createIO } from './lib/gltf.mjs';
import { parseEntities } from './lib/entities.mjs';
import { MAPS } from './lib/maps.mjs';
import { paths } from './lib/paths.mjs';
import { MODEL_POSES_FILE, animationPose, usedJoints } from './lib/poses.mjs';
import { writeFileAtomic } from './lib/stage.mjs';
import { vrfVersion as cliVersion } from './lib/vrf.mjs';

/** The largest |element − identity| of a pose matrix that still counts as the exported pose. */
const TOLERANCE = 0.01;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const usage = 'usage: node tools/model-poses.mjs <map>... | all   (through tools/model-poses.sh)';

/** Stops the run; thrown, so the export folder is still removed. */
function fail(msg) {
  throw new Error(msg);
}

/** The JSON chunk of a GLB, read without its binary chunk. */
function glbJson(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    if (head.readUInt32LE(0) !== 0x46546c67 || head.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${file} is not a GLB`);
    const json = Buffer.alloc(head.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 20);
    return JSON.parse(json.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** The models a world GLB draws skinned without a skin (see the header). */
function skinlessSkinned(json) {
  const out = new Set();
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined || node.skin !== undefined) continue;
    if (json.meshes[node.mesh].primitives.some((p) => Object.keys(p.attributes).some((a) => /^JOINTS_\d+$/.test(a)))) {
      out.add((node.name ?? '').split('.')[0]);
    }
  }
  return out;
}

const round = (x) => +x.toFixed(6) || 0;

/**
 * A stderr for an error message: its first five lines that are not a stack frame ("at …"), which
 * keeps an exception's name and message ('' when it said nothing else).
 */
const stderrNote = (text) => {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('at ')).slice(0, 5);
  return lines.length ? `; stderr: ${lines.join(' / ')}` : '';
};

/** Whether a stderr shows an exception: the CLI prints one for a file it fails on, and exits 0. */
const showsException = (text) => /exception/i.test(String(text ?? ''));

async function main() {
  const { CS2_DIR, S2V_CLI, CS2_BUILD } = process.env;
  if (!CS2_DIR || !S2V_CLI || !CS2_BUILD) fail('CS2_DIR, S2V_CLI and CS2_BUILD are unset; run tools/model-poses.sh');
  const args = process.argv.slice(2);
  if (!args.length) fail(usage);
  const all = args.includes('all');
  const maps = all ? [...MAPS] : args;
  const game = path.join(CS2_DIR, 'game', 'csgo');
  const vrfVersion = cliVersion(S2V_CLI);

  const io = await createIO();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-poses-'));
  /** vmdl → its export ({ doc, stderr } or { error }), once per run */
  const exports = new Map();
  const exportModel = async (vmdl) => {
    if (exports.has(vmdl)) return exports.get(vmdl);
    const r = spawnSync(S2V_CLI, [
      '-i', path.join(game, 'pak01_dir.vpk'), '-f', `${vmdl}_c`, '-d', '-o', tmp,
      '--gltf_export_format', 'glb', '--gltf_export_animations', '--game', path.join(game, 'gameinfo.gi'),
    ], { cwd: tmp, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    const glb = path.join(tmp, vmdl.replace(/\.vmdl$/, '.glb'));
    let out;
    if (r.error) out = { error: `Source2Viewer-CLI did not run: ${r.error.message}` };
    else if (r.status !== 0 || !fs.existsSync(glb)) {
      out = { error: `Source2Viewer-CLI exited ${r.status} and wrote no ${path.relative(tmp, glb)} from pak01_dir.vpk${stderrNote(r.stderr)}` };
    } else {
      try {
        out = { doc: await io.read(glb), stderr: r.stderr };
      } catch (e) {
        out = { error: `could not read ${path.relative(tmp, glb)}, which Source2Viewer-CLI exported: ${e.message}${stderrNote(r.stderr)}` };
      }
    }
    exports.set(vmdl, out);
    return out;
  };

  let missing = 0;
  try {
    for (const map of maps) {
      const P = paths(map);
      const world = path.join(P.raw, 'world.glb');
      if (!fs.existsSync(world)) {
        if (!all) { console.error(`model-poses: ${map}: no ${world}; run tools/rip-map.sh ${map}`); missing++; }
        continue;
      }
      const vents = path.join(P.raw, 'entities', 'default_ents.vents');
      const entities = fs.existsSync(vents) ? parseEntities(fs.readFileSync(vents, 'utf8')) : [];
      const models = {};
      for (const model of [...skinlessSkinned(glbJson(world))].sort()) {
        const mine = entities.filter((e) => e.model && path.basename(e.model, '.vmdl') === model);
        const entry = { vmdl: null, entities: mine.length, anim: null, pose: null };
        models[model] = entry;
        const said = (what) => console.log(`${map} ${model}: ${what}`);
        const failed = (error) => { delete entry.anim; delete entry.pose; entry.error = error; said(`ERROR ${error}`); };
        // Whatever goes wrong with one model is its error: the other models and maps go on.
        try {
          if (!mine.length) { said('no entity names it; left as exported'); continue; }
          const vmdls = [...new Set(mine.map((e) => e.model))];
          if (vmdls.length > 1) { failed(`its entities name ${vmdls.join(', ')}; the world names nodes by file name only`); continue; }
          entry.vmdl = vmdls[0];
          const exported = await exportModel(entry.vmdl);
          if (exported.error) { failed(exported.error); continue; }
          const { doc, stderr } = exported;
          const clips = doc.getRoot().listAnimations().map((a) => a.getName());
          if (!doc.getRoot().listSkins().length || !clips.length) {
            const lacks = `${entry.vmdl} has no ${clips.length ? 'skin' : 'animation'}`;
            // A model the CLI failed on part way also lacks them: not what the model is.
            if (showsException(stderr)) failed(`${lacks}, and Source2Viewer-CLI reported an exception exporting it${stderrNote(stderr)}`);
            else said(`${lacks}; left as exported`);
            continue;
          }
          // '' is the model's default sequence, its first.
          const anims = [...new Set(mine.map((e) => e.animation || clips[0]))];
          if (anims.length > 1) { failed(`its entities play different animations (${anims.join(', ')}); one pose cannot serve them`); continue; }
          const pose = animationPose(doc, anims[0]);
          const used = [...usedJoints(doc)].sort((a, b) => a - b);
          const stray = used.find((j) => !pose.joints.has(j));
          if (stray !== undefined) { failed(`a vertex is weighed on joint ${stray}, which its skin (${pose.joints.size} joints) does not have`); continue; }
          entry.anim = pose.anim;
          const off = Math.max(0, ...used.map((j) => Math.max(...pose.joints.get(j).map((x, i) => Math.abs(x - IDENTITY[i])))));
          if (off > TOLERANCE) entry.pose = Object.fromEntries(used.map((j) => [j, pose.joints.get(j).map(round)]));
          said(`${entry.vmdl} "${pose.anim}", ${used.length} joint(s) used, ${off.toFixed(4)} off the identity: ${entry.pose ? 'POSED' : 'as exported'}`);
        } catch (e) {
          failed(e.message);
        }
      }
      const table = { map, cs2Build: CS2_BUILD, vrfVersion, models };
      // One matrix per line.
      const text = JSON.stringify(table, null, 2)
        .replace(/\[\s+([-\d.e,\s]+?)\s+\]/g, (_, inner) => `[${inner.split(/,\s*/).join(', ')}]`);
      const file = path.join(P.raw, MODEL_POSES_FILE);
      writeFileAtomic(file, `${text}\n`);
      const list = Object.values(models);
      console.log(`${map}: ${file}: ${list.length} skinned model(s), ${list.filter((m) => m.pose).length} posed, ${list.filter((m) => m.error).length} with an error`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (missing) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  await main().catch((e) => {
    console.error(`model-poses: ${e.message}`);
    process.exit(1);
  });
}
