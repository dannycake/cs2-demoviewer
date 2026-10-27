#!/usr/bin/env node
// node tools/check-viewmodels.mjs
//
// Checks assets/viewmodels/ against the first-person budgets and prints a table of actual vs
// budget. Exits 0 only when every row holds. Sizes are decimal (1 KB = 1,000 bytes); what a
// browser downloads is the `.glb.gz`, so the budgets are on those.
// Per side, arms_<side>.glb: present with its `.glb.gz` and `.shrink.json`; ≤ 150 KB gz;
// ≤ 12,000 triangles; exactly one skin, with shrink.json's joint count, and JOINTS_0 +
// WEIGHTS_0 on every primitive of every skinned mesh node; no clip; the bones the viewer and the
// clips need (`root_motion`, `wpn`, both hands).
// Per weapon of WEAPON_MODELS, <name>.glb: present with `.glb.gz` and `.shrink.json`; ≤ 60 KB
// gz; no mesh; an `idle` and a `draw` clip and exactly shrink.json's clips; every channel on a
// bone the arms have (or one of the weapon's WEAPON_BONES_KEPT); the idle holds `wpn` at least
// 15 cm from the eye, or for a WEAPON_BONES_KEPT weapon moves those bones.
// Across all: every clip file ≤ 1.5 MB gz, and a typical match (both arms and the TYPICAL_MATCH
// clips) ≤ 1.0 MB gz. Measured 2026-10-22 (CS2 build 2000934, VRF 20.1): arms 85 + 79 KB gz,
// 45 clip files 1.10 MB gz (6–46 KB each, the M249 largest), a typical match 0.70 MB gz.
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './lib/cli.mjs';
import { createIO, countTris } from './lib/gltf.mjs';
import { collector, exitWithReport } from './lib/report.mjs';
import { SIDES } from './lib/players.mjs';
import { armsPaths, REQUIRED_KINDS, TYPICAL_MATCH, viewmodelPaths, WEAPON_BONES_KEPT } from './lib/viewmodels.mjs';
import { WEAPON_NAMES } from './lib/weapons.mjs';

export const BUDGET = Object.freeze({
  armsGzBytes: 150e3,
  armsTris: 12000,
  clipGzBytes: 60e3,
  totalClipGzBytes: 1.5e6,
  typicalGzBytes: 1.0e6,
  /** Metres from the eye (`root_motion`) the idle must hold `wpn` (the AK's: 0.41). */
  wpnReach: 0.15,
});

const ARMS_BONES = ['root_motion', 'wpn', 'hand_L', 'hand_R'];

/** The rows for assets/viewmodels/ (under ASSETS_DIR, read on the call), as the header says. */
export async function checkViewmodels() {
  const { rows, row } = collector();
  const kb = (n) => `${(n / 1e3).toFixed(1)} KB`;
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

  const io = await createIO();
  const gzOf = new Map();
  /** Bone names of the arms, for the clip rows; the union over both sides. */
  const armsBones = new Set();

  for (const side of SIDES) {
    const P = armsPaths(side);
    const label = `arms_${side}`;
    if (!fs.existsSync(P.glb)) { row(label, 'missing', 'present', false); continue; }
    const problems = [];
    const gz = fs.existsSync(P.gz) ? fs.statSync(P.gz).size : null;
    if (gz === null) problems.push('no .gz');
    else gzOf.set(label, gz);
    const shrink = readJson(P.shrinkJson);
    if (!shrink) problems.push('no shrink.json');
    const doc = await io.read(P.glb);
    const root = doc.getRoot();
    for (const n of root.listNodes()) armsBones.add(n.getName());
    const tris = countTris(doc);
    const skins = root.listSkins();
    if (gz !== null && gz > BUDGET.armsGzBytes) problems.push(`gz ${kb(gz)}`);
    if (tris > BUDGET.armsTris) problems.push(`${tris} tris`);
    if (skins.length !== 1) problems.push(`${skins.length} skins`);
    else if (shrink && skins[0].listJoints().length !== shrink.joints) problems.push(`${skins[0].listJoints().length} joints, shrink.json says ${shrink.joints}`);
    const skinned = root.listNodes().filter((n) => n.getMesh() && n.getSkin());
    if (skinned.length === 0) problems.push('no skinned mesh');
    for (const n of skinned)
      for (const p of n.getMesh().listPrimitives())
        if (!p.getAttribute('JOINTS_0') || !p.getAttribute('WEIGHTS_0')) problems.push(`${n.getName()} lacks JOINTS_0/WEIGHTS_0`);
    if (root.listAnimations().length) problems.push(`${root.listAnimations().length} clip(s)`);
    const names = new Set(root.listNodes().map((n) => n.getName()));
    const lacking = ARMS_BONES.filter((b) => !names.has(b));
    if (lacking.length) problems.push(`no ${lacking.join(', ')}`);
    row(label, `${kb(fs.statSync(P.glb).size)}${gz !== null ? ` (${kb(gz)} gz)` : ''}, ${tris} tris, ${skins[0]?.listJoints().length ?? 0} joints, ${root.listTextures().length} tex${problems.length ? `: ${problems.join(', ')}` : ''}`,
      `≤ ${kb(BUDGET.armsGzBytes)} gz, ≤ ${BUDGET.armsTris} tris, 1 skin, no clip`, problems.length === 0);
  }

  let totalGz = 0;
  let present = 0;
  for (const name of WEAPON_NAMES) {
    const P = viewmodelPaths(name);
    if (!fs.existsSync(P.glb)) { row(name, 'missing', 'present', false); continue; }
    present++;
    const problems = [];
    const gz = fs.existsSync(P.gz) ? fs.statSync(P.gz).size : null;
    if (gz === null) problems.push('no .gz');
    else { gzOf.set(name, gz); totalGz += gz; }
    if (gz !== null && gz > BUDGET.clipGzBytes) problems.push(`gz ${kb(gz)}`);
    const shrink = readJson(P.shrinkJson);
    if (!shrink) problems.push('no shrink.json');
    const doc = await io.read(P.glb);
    const root = doc.getRoot();
    if (root.listMeshes().length) problems.push('has a mesh');
    const clips = root.listAnimations().map((a) => a.getName()).sort();
    for (const k of REQUIRED_KINDS) if (!clips.includes(k)) problems.push(`no ${k}`);
    if (shrink && Object.keys(shrink.clips ?? {}).sort().join() !== clips.join()) problems.push('clips differ from shrink.json');
    const extra = new Set(WEAPON_BONES_KEPT[name] ?? []);
    const strays = new Set();
    for (const a of root.listAnimations())
      for (const ch of a.listChannels()) {
        const b = ch.getTargetNode()?.getName();
        if (armsBones.size && !armsBones.has(b) && !extra.has(b)) strays.add(b);
      }
    if (strays.size) problems.push(`channels on bones the arms lack: ${[...strays].join(', ')}`);
    // The gun hangs on `wpn`, so the idle must carry it out from the eye; the WEAPON_BONES_KEPT
    // weapons hang theirs on those bones instead, which the clips must move.
    const idleClip = root.listAnimations().find((a) => a.getName() === 'idle');
    if (idleClip) {
      for (const ch of idleClip.listChannels()) {
        const v = Array.from(ch.getSampler().getOutput().getElement(0, []));
        if (ch.getTargetPath() === 'translation') ch.getTargetNode().setTranslation(v);
        else if (ch.getTargetPath() === 'rotation') ch.getTargetNode().setRotation(v);
      }
      const wpnNode = root.listNodes().find((n) => n.getName() === 'wpn');
      const rm = root.listNodes().find((n) => n.getName() === 'root_motion');
      const at = (n) => { const m = n.getWorldMatrix(); return [m[12], m[13], m[14]]; };
      const reach = wpnNode && rm ? Math.hypot(...at(wpnNode).map((x, k) => x - at(rm)[k])) : 0;
      if (extra.size === 0 && reach < BUDGET.wpnReach) problems.push(`the idle holds wpn ${(reach * 100).toFixed(0)} cm from the eye`);
      for (const b of extra) if (!idleClip.listChannels().some((ch) => ch.getTargetNode()?.getName() === b)) problems.push(`the idle does not move ${b}`);
    }
    row(name, `${kb(fs.statSync(P.glb).size)}${gz !== null ? ` (${kb(gz)} gz)` : ''}, ${clips.join(' ')}${problems.length ? `: ${problems.join(', ')}` : ''}`,
      `≤ ${kb(BUDGET.clipGzBytes)} gz, idle + draw`, problems.length === 0);
  }
  row('clip files present', `${present}/${WEAPON_NAMES.length}`, `${WEAPON_NAMES.length}`, present === WEAPON_NAMES.length);
  row('clips total gz', mb(totalGz), `≤ ${mb(BUDGET.totalClipGzBytes)}`, totalGz <= BUDGET.totalClipGzBytes);
  const typical = [...SIDES.map((s) => `arms_${s}`), ...TYPICAL_MATCH];
  const typicalGz = typical.reduce((n, k) => n + (gzOf.get(k) ?? 0), 0);
  const typicalOk = typical.every((k) => gzOf.has(k));
  row(`typical match (arms + ${TYPICAL_MATCH.length} weapons)`, `${mb(typicalGz)}${typicalOk ? '' : ' (files missing)'}`, `≤ ${mb(BUDGET.typicalGzBytes)} gz`, typicalOk && typicalGz <= BUDGET.typicalGzBytes);
  return rows;
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) { console.error('usage: node tools/check-viewmodels.mjs'); process.exit(1); }
  exitWithReport(`viewmodels  (${path.relative(process.cwd(), viewmodelPaths().out) || '.'})`, await checkViewmodels());
}
