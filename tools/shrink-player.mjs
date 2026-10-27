#!/usr/bin/env node
// node tools/shrink-player.mjs <ct|t>
//
// assets/raw/players/<rip.json models[side].glb> → assets/players/<side>.glb
//                                              + assets/players/<side>.shrink.json
//
// Required clips checked on the raw file (exit 2 if any of CLIPS_REQUIRED is
// missing) → selectThirdPerson (lib/players.mjs: drop the weapon skeletons and the
// first-person mesh groups, drop viewmodel clips, strip channels that animate the
// weapon skeletons, rename clips to short names) → stripBoneChannels (scale and
// non-root translation channels) → dedup → prune → textureCompress(WebP 1024 px,
// q80) → simplify(0.5, 0.001) on a clone, kept only if skinSurvives(before, after)
// → resample(3e-3) → dedup accessors → meshopt → a gzip -9 sibling. The written file is
// read back and must still pass skinSurvives against the pre-simplify document,
// with exactly one skin of the raw body skin's joint count; otherwise exit 1 and
// nothing is written. Files are written into assets/players.tmp-<pid>/ and renamed into
// assets/players/ (lib/stage.mjs); other files there are left alone.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { cloneDocument, dedup, meshopt, prune, resample, simplify, textureCompress } from '@gltf-transform/functions';
import { createIO, countTris, MeshoptEncoder, MeshoptSimplifier } from './lib/gltf.mjs';
import { skinSurvives, clipNames } from './lib/skin.mjs';
import { staging } from './lib/stage.mjs';
import { fitTextures } from './lib/alpha.mjs';
import { isMain } from './lib/cli.mjs';
import {
  playerPaths, selectThirdPerson, stripBoneChannels, worldClipBases, CLIPS_REQUIRED, CLIPS_OPTIONAL, PLAYER_DROP_NODE, WORLD_CLIP_PREFIX,
} from './lib/players.mjs';

export const PARAMS = Object.freeze({
  drop: { node: PLAYER_DROP_NODE.source, clipsOutside: WORLD_CLIP_PREFIX },
  steps: ['selectThirdPerson', 'stripBoneChannels', 'dedup', 'prune', 'textureCompress', 'simplify (if the skin survives)', 'resample', 'dedup accessors', 'meshopt', 'gzip'],
  texture: { format: 'webp', size: 1024, quality: 80 },
  simplify: { ratio: 0.5, error: 0.001 },
  // Drops animation keyframes a linear fit reproduces within the tolerance (scene
  // metres for the root/pelvis translations, quaternion components for rotations:
  // 3e-3 ≈ 0.35°). Measured 2026-10-22 on CT, 231 clips after stripBoneChannels:
  // 1e-3 → 2.05 MB gz, 3e-3 → 1.87 MB gz, 1e-2 → 1.64 MB gz.
  resample: { tolerance: 3e-3 },
  gzip: { level: 9 },
  // 'scene': one quantization volume for every mesh, so the skin's inverse bind
  // matrices get the same correction everywhere and stay one skin ('mesh' clones
  // a differently corrected skin per mesh node).
  meshopt: { level: 'high', quantizationVolume: 'scene' },
});

const usage = 'usage: node tools/shrink-player.mjs <ct|t>';

function fail(msg, code = 1) {
  console.error(`shrink-player: ${msg}`);
  process.exit(code);
}

/** Joint count of the skins on the mesh nodes selectThirdPerson keeps; throws unless they agree. */
function bodyJoints(doc) {
  const counts = new Set();
  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh() && node.getSkin() && !PLAYER_DROP_NODE.test(node.getName())) counts.add(node.getSkin().listJoints().length);
  }
  if (counts.size !== 1) throw new Error(`expected one body skin joint count, found ${counts.size ? [...counts].join(', ') : 'no skinned body mesh'}`);
  return [...counts][0];
}

async function main() {
  const side = process.argv[2];
  if (!side || process.argv.length > 3) fail(usage);
  let P;
  try { P = playerPaths(side); } catch (e) { fail(`${e.message}; ${usage}`); }
  if (!fs.existsSync(P.ripJson)) fail(`${P.ripJson} is missing; run tools/rip-players.sh`);
  const rip = JSON.parse(fs.readFileSync(P.ripJson, 'utf8'));
  const entry = rip.models?.[side];
  if (!entry?.glb || !entry?.vmdl) fail(`${P.ripJson} has no models.${side}; run tools/rip-players.sh --force`);
  const rawGlb = path.join(P.raw, entry.glb);
  if (!fs.existsSync(rawGlb)) fail(`${rawGlb} is missing; run tools/rip-players.sh --force`);

  const t0 = performance.now();
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
  const log = (msg) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);

  const io = await createIO();
  const doc = await io.read(rawGlb);
  const trisIn = countTris(doc);
  const rawClips = worldClipBases(doc);
  log(`read ${path.relative(process.cwd(), rawGlb)} ${mb(fs.statSync(rawGlb).size)}: ${trisIn} tris, ${doc.getRoot().listSkins().length} skins, clips ${rawClips.join(' ') || '(none)'}`);

  const missing = CLIPS_REQUIRED.filter((c) => !rawClips.includes(c));
  if (missing.length) fail(`${entry.glb} lacks required clip(s) ${missing.join(', ')} (VRF reported unmatched: ${(entry.unmatchedClips ?? []).join(', ') || 'none'})`, 2);

  const stage = staging(P.out);
  process.on('SIGINT', () => { stage.abort(); process.exit(130); });
  process.on('SIGTERM', () => { stage.abort(); process.exit(143); });

  try {
    const joints = bodyJoints(doc);
    const sel = selectThirdPerson(doc);
    const strippedChannels = stripBoneChannels(doc);
    await doc.transform(dedup(), prune());
    // Fitted first, colour and alpha apart (lib/alpha.mjs), so textureCompress only encodes.
    await fitTextures(doc, [PARAMS.texture.size, PARAMS.texture.size]);
    await doc.transform(
      textureCompress({ encoder: sharp, targetFormat: PARAMS.texture.format, resize: [PARAMS.texture.size, PARAMS.texture.size], quality: PARAMS.texture.quality }),
    );
    const trisKept = countTris(doc);
    const skins = doc.getRoot().listSkins();
    if (skins.length !== 1 || skins[0].listJoints().length !== joints) {
      throw new Error(`after selection and dedup expected one ${joints}-joint skin, found ${skins.map((s) => s.listJoints().length).join(', ') || 'none'}`);
    }
    log(`select   dropped ${sel.droppedNodes} nodes, ${sel.droppedClips.length} clip(s) outside ${WORLD_CLIP_PREFIX}, ${sel.strippedChannels} weapon-skeleton channel(s) and ${strippedChannels} scale/translation channel(s); ${trisKept} tris, ${doc.getRoot().listMeshes().length} meshes, one ${joints}-joint skin, ${doc.getRoot().listTextures().length} textures → WebP ${PARAMS.texture.size} px`);

    // `doc` stays untouched from here on: it is the reference both checks compare against.
    let out = null;
    let simplified = false;
    let simplifyNote;
    const trial = cloneDocument(doc);
    try {
      await trial.transform(simplify({ simplifier: MeshoptSimplifier, ...PARAMS.simplify }));
      if (skinSurvives(doc, trial)) { out = trial; simplified = true; simplifyNote = `kept: ${trisKept} → ${countTris(trial)} tris`; }
      else simplifyNote = `skipped: the skin did not survive (${countTris(trial)} tris)`;
    } catch (e) {
      simplifyNote = `skipped: simplify threw ${String(e?.message ?? e).split('\n')[0]}`;
    }
    log(`simplify ${simplifyNote}`);
    out ??= cloneDocument(doc);

    // dedup after resample: every channel of a clip shares the same key times before it, few
    // after. prune drops the accessors resample replaced (they would be written otherwise).
    await out.transform(resample(PARAMS.resample), dedup({ propertyTypes: ['Accessor'] }), prune(), meshopt({ encoder: MeshoptEncoder, ...PARAMS.meshopt }));
    const bytes = await io.writeBinary(out);
    const gz = zlib.gzipSync(bytes, PARAMS.gzip);

    // What the web app will load: read the bytes back and check them against the
    // pre-simplify document (which has the raw body skin's joint count).
    const back = await io.readBinary(bytes);
    if (!skinSurvives(doc, back)) throw new Error('the written GLB fails skinSurvives against the selected raw model');
    const clips = clipNames(back);
    const trisOut = countTris(back);
    let animSeconds = 0;
    for (const a of back.getRoot().listAnimations()) {
      let len = 0;
      for (const s of a.listSamplers()) len = Math.max(len, s.getInput()?.getMax([0])[0] ?? 0);
      animSeconds += len;
    }

    const report = {
      model: entry.vmdl, side, clips, joints, trisIn, trisKept, trisOut, simplified, bytes: bytes.byteLength,
      gzBytes: gz.byteLength, animSeconds: +animSeconds.toFixed(1),
      clipsOptionalAbsent: CLIPS_OPTIONAL.filter((c) => !clips.includes(c)),
      droppedNodes: sel.droppedNodes, droppedClips: sel.droppedClips,
      strippedChannels: { weaponSkeleton: sel.strippedChannels, scaleAndTranslation: strippedChannels },
      textures: back.getRoot().listTextures().length,
      raw: { glb: entry.glb, cs2Build: rip.cs2Build, vrfVersion: rip.vrfVersion },
      seconds: +((performance.now() - t0) / 1000).toFixed(1),
      params: PARAMS,
    };
    stage.write(`${side}.glb`, bytes);
    stage.write(`${side}.glb.gz`, gz);
    stage.write(`${side}.shrink.json`, JSON.stringify(report, null, 2) + '\n');
    stage.commit(P.out, [`${side}.glb`, `${side}.glb.gz`, `${side}.shrink.json`]);
    stage.abort();
    log(`done     ${path.relative(process.cwd(), P.glb)} ${mb(bytes.byteLength)} (${mb(gz.byteLength)} gz), ${trisOut} tris, ${joints} joints, ${clips.length} clips / ${animSeconds.toFixed(1)} s, simplified ${simplified}`);
    if (report.clipsOptionalAbsent.length) log(`absent   ${report.clipsOptionalAbsent.length} optional clip(s): ${report.clipsOptionalAbsent.join(' ')}`);
  } catch (e) {
    stage.abort();
    if (process.env.DEBUG) console.error(e?.stack);
    fail(`${String(e?.message ?? e).split('\n')[0]} (DEBUG=1 for the stack)`);
  }
}

if (isMain(import.meta.url)) await main();
