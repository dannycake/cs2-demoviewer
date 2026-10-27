#!/usr/bin/env node
// node tools/shrink-viewmodel-clips.mjs <name>|all
//
// assets/raw/viewmodels/<VIEWMODEL_DIRS[name]>/<clip>.glb → assets/viewmodels/<name>.glb
//                                                       + assets/viewmodels/<name>.glb.gz
//                                                       + assets/viewmodels/<name>.shrink.json
//
// One file per weapon model name (lib/weapons.mjs WEAPON_MODELS; the T knife is `knife_t`):
// the viewmodel skeleton (lib/viewmodels.mjs copySkeleton: no meshes, the IK helper bones
// left out) and the weapon's clips on it, each named by its kind (`idle`, `draw`, `shoot`,
// `reload`, ...; selectClips picks them from the folder). A channel on a helper bone, on the
// weapon's own skeleton (WEAPON_BONES_KEPT aside: the Dual Berettas' left pistol) or that never
// leaves its bone's rest pose is dropped; then dedup → prune → resample(1e-3) → dedup → prune →
// meshopt → a gzip -9 sibling. The arms (shrink-arms.mjs) carry the same bone names, which is
// how three.js puts these clips on them. Files are written into assets/viewmodels/<name>.tmp-<pid>/
// and renamed beside it (lib/stage.mjs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Document, Logger } from '@gltf-transform/core';
import { dedup, meshopt, prune, resample } from '@gltf-transform/functions';
import { isMain } from './lib/cli.mjs';
import { createIO, MeshoptEncoder } from './lib/gltf.mjs';
import { staging } from './lib/stage.mjs';
import { copyClip, copySkeleton, listClips, selectClips, viewmodelPaths, VIEWMODEL_DIRS, WEAPON_BONES_KEPT } from './lib/viewmodels.mjs';
import { WEAPON_NAMES } from './lib/weapons.mjs';

export const PARAMS = Object.freeze({
  steps: ['copySkeleton', 'copyClip', 'dedup', 'prune', 'resample', 'dedup', 'prune', 'meshopt', 'gzip'],
  // ≈ 0.06° of a quaternion component, 1 mm of a translation: the arms are a metre from the eye.
  resample: { tolerance: 1e-3 },
  meshopt: { level: 'high' },
  gzip: { level: 9 },
});

const usage = 'usage: node tools/shrink-viewmodel-clips.mjs <name>|all';

function fail(msg, code = 1) {
  console.error(`shrink-viewmodel-clips: ${msg}`);
  process.exit(code);
}

/** Shrinks one weapon's clips; returns its report. Throws on any failure. */
export async function shrinkViewmodelClips(name, io, rip, log = () => {}) {
  const P = viewmodelPaths(name);
  const dirName = VIEWMODEL_DIRS[name];
  const listed = rip.dirs?.[dirName];
  if (!Array.isArray(listed)) throw new Error(`rip.json has no dirs["${dirName}"]; run tools/rip-viewmodels.sh --force`);
  const names = listClips(P.dir);
  const picks = selectClips(name, names);
  const weaponBones = WEAPON_BONES_KEPT[name] ?? [];
  const t0 = performance.now();

  // meshopt's reorder step warns about the missing meshes on every file: errors only.
  const doc = new Document().setLogger(new Logger(Logger.Verbosity.ERROR));
  doc.createBuffer();
  doc.createScene('viewmodel');
  let bones = null;
  const clips = {};
  for (const [kind, source] of Object.entries(picks)) {
    const src = await io.read(path.join(P.dir, `${source}.glb`));
    if (!bones) bones = copySkeleton(doc, src, weaponBones).bones;
    const c = copyClip(doc, bones, src, kind, weaponBones);
    if (c.kept === 0 && kind !== 'idle') throw new Error(`${source} moves no bone`);
    clips[kind] = { source, seconds: +c.seconds.toFixed(4), channels: c.kept, atRest: c.atRest, skipped: c.skipped };
  }
  await doc.transform(dedup(), prune({ keepLeaves: true }), resample(PARAMS.resample), dedup(), prune({ keepLeaves: true }), meshopt({ encoder: MeshoptEncoder, ...PARAMS.meshopt }));

  const bytes = await io.writeBinary(doc);
  const gz = zlib.gzipSync(bytes, PARAMS.gzip);
  const back = await io.readBinary(bytes);
  const got = back.getRoot().listAnimations().map((a) => a.getName()).sort();
  const want = Object.keys(picks).sort();
  if (got.join() !== want.join()) throw new Error(`the written GLB has clips ${got.join(', ')}, not ${want.join(', ')}`);
  if (back.getRoot().listMeshes().length) throw new Error('the written GLB has a mesh');
  let keys = 0;
  for (const a of back.getRoot().listAnimations()) for (const s of a.listSamplers()) keys += s.getInput().getCount();

  const report = {
    name, dir: dirName, clips, weaponBones, bones: bones.size, keys, bytes: bytes.byteLength, gzBytes: gz.byteLength,
    raw: { cs2Build: rip.cs2Build, vrfVersion: rip.vrfVersion },
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    params: PARAMS,
  };

  const stage = staging(path.join(P.out, name));
  try {
    stage.write(`${name}.glb`, bytes);
    stage.write(`${name}.glb.gz`, gz);
    stage.write(`${name}.shrink.json`, JSON.stringify(report, null, 2) + '\n');
    stage.commit(P.out, [`${name}.glb`, `${name}.glb.gz`, `${name}.shrink.json`]);
  } finally {
    stage.abort();
  }
  log(`${name.padEnd(13)} ${dirName.padEnd(27)} ${Object.keys(picks).join(' ').padEnd(48)} ${keys} keys, ${(bytes.byteLength / 1e3).toFixed(0)} KB (${(gz.byteLength / 1e3).toFixed(1)} KB gz), ${report.seconds}s`);
  return report;
}

async function main() {
  const arg = process.argv[2];
  if (!arg || process.argv.length > 3) fail(usage);
  const names = arg === 'all' ? WEAPON_NAMES : [arg];
  let P;
  try { P = viewmodelPaths(names[0]); } catch (e) { fail(`${e.message}; ${usage}`); }
  if (!fs.existsSync(P.ripJson)) fail(`${P.ripJson} is missing; run tools/rip-viewmodels.sh`);
  const rip = JSON.parse(fs.readFileSync(P.ripJson, 'utf8'));
  const io = await createIO();
  const t0 = performance.now();
  let total = 0;
  let totalGz = 0;
  for (const name of names) {
    try {
      const r = await shrinkViewmodelClips(name, io, rip, (m) => console.log(m));
      total += r.bytes;
      totalGz += r.gzBytes;
    } catch (e) {
      if (process.env.DEBUG) console.error(e?.stack);
      fail(`${name}: ${String(e?.message ?? e).split('\n')[0]} (DEBUG=1 for the stack)`);
    }
  }
  console.log(`done: ${names.length} weapon(s), ${(total / 1e6).toFixed(2)} MB (${(totalGz / 1e6).toFixed(2)} MB gz) in ${((performance.now() - t0) / 1000).toFixed(0)}s → ${path.relative(process.cwd(), P.out)}`);
}

if (isMain(import.meta.url)) await main();
