#!/usr/bin/env node
// node tools/shrink-weapon.mjs <name>|all
//
// assets/raw/weapons/<rip.json models[name].glb> → assets/weapons/<name>.glb
//                                               + assets/weapons/<name>.glb.gz
//                                               + assets/weapons/<name>.shrink.json
//
// takeModelAttach (lib/weapons.mjs: the `weapon` bone's rest pose onto the scene's
// `extras.attach`, then the skeleton, skin and clips dropped; a GROUND_MODELS item, never
// held, has no `weapon` bone and gets no attach) → selectWeaponBody (drop
// `body_hd` when `body_legacy` exists) → dedup → prune → weld → simplify(ratio 0.1,
// error 0.01; topology-bound, an AK stops at 2.2 k of 13.5 k triangles) →
// textureCompress(WebP 128 px, q70) → prune → meshopt → a gzip -9 sibling. Nothing is
// checked against the raw file beyond "one mesh node left". Files are written into
// assets/weapons/<name>.tmp-<pid>/ and renamed beside it (lib/stage.mjs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { isMain } from './lib/cli.mjs';
import { createIO, countTris, MeshoptEncoder, MeshoptSimplifier } from './lib/gltf.mjs';
import { staging } from './lib/stage.mjs';
import { MODEL_NAMES, selectWeaponBody, takeModelAttach, weaponPaths } from './lib/weapons.mjs';
import { fitTextures } from './lib/alpha.mjs';

export const PARAMS = Object.freeze({
  steps: ['takeModelAttach', 'selectWeaponBody', 'dedup', 'prune', 'weld', 'simplify', 'textureCompress', 'prune', 'meshopt', 'gzip'],
  simplify: { ratio: 0.1, error: 0.01 },
  // A model still over this after the first pass gets a second, looser one. Only the
  // SSG08 needs it (12,609 of 38.6 k triangles after the first pass; a bolt, scope and
  // strap in many separate pieces) and it reaches 10,765, not 8,000: simplify cannot
  // merge separate components, so check-weapons allows 12,000.
  trisTarget: 8000,
  simplifyAgain: { ratio: 0.5, error: 0.05 },
  texture: { format: 'webp', size: 128, quality: 70 },
  meshopt: { level: 'high' },
  gzip: { level: 9 },
});

const usage = 'usage: node tools/shrink-weapon.mjs <name>|all';

function fail(msg, code = 1) {
  console.error(`shrink-weapon: ${msg}`);
  process.exit(code);
}

/** Shrinks one weapon; returns its report. Throws on any failure. */
export async function shrinkWeapon(name, io, rip, log = () => {}) {
  const P = weaponPaths(name);
  const entry = rip.models?.[name];
  if (!entry?.glb || !entry?.vmdl) throw new Error(`rip.json has no models.${name}; run tools/rip-weapons.sh --force`);
  const rawGlb = path.join(P.raw, entry.glb);
  if (!fs.existsSync(rawGlb)) throw new Error(`${rawGlb} is missing; run tools/rip-weapons.sh --force`);
  const t0 = performance.now();

  const doc = await io.read(rawGlb);
  const root = doc.getRoot();
  const trisIn = countTris(doc);
  const attach = takeModelAttach(name, doc);
  const sel = selectWeaponBody(doc);
  await doc.transform(dedup(), prune(), weld());
  const trisKept = countTris(doc);
  await doc.transform(simplify({ simplifier: MeshoptSimplifier, ...PARAMS.simplify }));
  let simplifyRounds = 1;
  if (countTris(doc) > PARAMS.trisTarget) {
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ...PARAMS.simplifyAgain }));
    simplifyRounds = 2;
  }
  // Fitted first, colour and alpha apart (lib/alpha.mjs), so textureCompress only encodes.
  await fitTextures(doc, [PARAMS.texture.size, PARAMS.texture.size]);
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: PARAMS.texture.format, resize: [PARAMS.texture.size, PARAMS.texture.size], quality: PARAMS.texture.quality }),
    prune(),
    meshopt({ encoder: MeshoptEncoder, ...PARAMS.meshopt }),
  );
  const bytes = await io.writeBinary(doc);
  const gz = zlib.gzipSync(bytes, PARAMS.gzip);
  const back = await io.readBinary(bytes);
  const trisOut = countTris(back);
  if (back.getRoot().listNodes().filter((n) => n.getMesh()).length === 0) throw new Error('the written GLB has no mesh node');
  if (attach && !back.getRoot().listScenes()[0]?.getExtras()?.attach) throw new Error('the written GLB lost extras.attach');

  const report = {
    model: entry.vmdl, name, attach, trisIn, trisKept, trisOut, simplifyRounds, bytes: bytes.byteLength, gzBytes: gz.byteLength,
    groups: sel, textures: back.getRoot().listTextures().length, materials: back.getRoot().listMaterials().map((m) => m.getName()).sort(),
    // A model added to an older rip (rip-weapons.sh) carries the VRF that exported it.
    raw: { glb: entry.glb, cs2Build: rip.cs2Build, vrfVersion: entry.vrfVersion ?? rip.vrfVersion },
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
  log(`${name.padEnd(13)} ${trisIn} → ${trisKept} → ${trisOut} tris, ${(bytes.byteLength / 1e3).toFixed(0)} KB (${(gz.byteLength / 1e3).toFixed(0)} KB gz), ${report.textures} textures, dropped ${sel.dropped.join(' ') || 'nothing'}, ${report.seconds}s`);
  return report;
}

async function main() {
  const arg = process.argv[2];
  if (!arg || process.argv.length > 3) fail(usage);
  const names = arg === 'all' ? MODEL_NAMES : [arg];
  let P;
  try { P = weaponPaths(names[0]); } catch (e) { fail(`${e.message}; ${usage}`); }
  if (!fs.existsSync(P.ripJson)) fail(`${P.ripJson} is missing; run tools/rip-weapons.sh`);
  const rip = JSON.parse(fs.readFileSync(P.ripJson, 'utf8'));
  const io = await createIO();
  const t0 = performance.now();
  let total = 0;
  let totalGz = 0;
  for (const name of names) {
    try {
      const r = await shrinkWeapon(name, io, rip, (m) => console.log(m));
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
