#!/usr/bin/env node
// node tools/check-weapons.mjs
//
// Checks assets/weapons/<name>.glb for every MODEL_PATHS name (the 45 weapons of
// WEAPON_MODELS and the kit of GROUND_MODELS) against the phase 3c budgets and prints a
// table of actual vs budget. Exits 0 only when every row holds. Per model: present with
// its `.glb.gz` sibling and `.shrink.json`; size ≤ 250 KB; ≤ 12 000 triangles; no skin,
// no animation; at least one mesh node; for a weapon, the scene's `extras.attach` (the
// `weapon` bone's rest pose, shrink-weapon.mjs; a ground-only model is never held and
// has none). Across all: raw ≤ 4 MB and gz ≤ 3 MB. Sizes are decimal (1 KB = 1,000
// bytes). The viewer loads a weapon the first time a player holds it or it lies in the
// round, so a match downloads a dozen or so, not the set. Measured 2026-10-22 (CS2 build
// 2000934, VRF 20.1): 45 weapons, 3.43 MB raw, 2.55 MB gz; the biggest is the SSG08 at
// 202 KB and 10,765 triangles even after shrink-weapon's second simplify pass (simplify
// is topology-bound: a bolt, scope and strap in many separate pieces), then the XM1014
// at 7,752.
import fs from 'node:fs';
import path from 'node:path';
import { createIO, countTris } from './lib/gltf.mjs';
import { isMain } from './lib/cli.mjs';
import { collector, exitWithReport } from './lib/report.mjs';
import { GROUND_MODELS, MODEL_NAMES, weaponPaths } from './lib/weapons.mjs';

export const BUDGET = Object.freeze({
  bytes: 250e3,
  tris: 12000,
  totalBytes: 4e6,
  totalGzBytes: 3e6,
});

/** The rows for assets/weapons/ (under ASSETS_DIR, read on the call), as the header says. */
export async function checkWeapons() {
  const { rows, row } = collector();
  const kb = (n) => `${(n / 1e3).toFixed(0)} KB`;
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

  const io = await createIO();
  let total = 0;
  let totalGz = 0;
  let present = 0;
  for (const name of MODEL_NAMES) {
    const P = weaponPaths(name);
    const held = !(name in GROUND_MODELS);
    if (!fs.existsSync(P.glb)) { row(`${name}`, 'missing', 'present', false); continue; }
    present++;
    const size = fs.statSync(P.glb).size;
    total += size;
    const gzOk = fs.existsSync(P.gz);
    if (gzOk) totalGz += fs.statSync(P.gz).size;
    const doc = await io.read(P.glb);
    const root = doc.getRoot();
    const tris = countTris(doc);
    const meshes = root.listNodes().filter((n) => n.getMesh()).length;
    const problems = [];
    if (size > BUDGET.bytes) problems.push(`size ${kb(size)}`);
    if (tris > BUDGET.tris) problems.push(`${tris} tris`);
    if (!gzOk) problems.push('no .gz');
    if (!fs.existsSync(P.shrinkJson)) problems.push('no shrink.json');
    if (root.listSkins().length) problems.push(`${root.listSkins().length} skin(s)`);
    if (root.listAnimations().length) problems.push(`${root.listAnimations().length} clip(s)`);
    if (meshes === 0) problems.push('no mesh');
    if (held && !root.listScenes()[0]?.getExtras()?.attach) problems.push('no extras.attach');
    row(name, `${kb(size)}${gzOk ? ` (${kb(fs.statSync(P.gz).size)} gz)` : ''}, ${tris} tris, ${root.listTextures().length} tex${problems.length ? `: ${problems.join(', ')}` : ''}`,
      `≤ ${kb(BUDGET.bytes)}, ≤ ${BUDGET.tris} tris, .gz, no skin/clip${held ? ', attach' : ''}`, problems.length === 0);
  }
  row('models present', `${present}/${MODEL_NAMES.length}`, `${MODEL_NAMES.length}`, present === MODEL_NAMES.length);
  row('total size', mb(total), `≤ ${mb(BUDGET.totalBytes)}`, total <= BUDGET.totalBytes);
  row('total gz size', mb(totalGz), `≤ ${mb(BUDGET.totalGzBytes)}`, totalGz <= BUDGET.totalGzBytes);
  return rows;
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) { console.error('usage: node tools/check-weapons.mjs'); process.exit(1); }
  exitWithReport(`weapons  (${path.relative(process.cwd(), weaponPaths().out) || '.'})`, await checkWeapons());
}
