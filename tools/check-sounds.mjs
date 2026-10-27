#!/usr/bin/env node
// node tools/check-sounds.mjs
//
// Checks assets/sounds/ against the sound budget (spec §12) and prints a table of actual vs
// budget. Exits 0 only when every row holds. Sizes are decimal (1 KB = 1,000 bytes); a bank is
// fetched as it is (Opus does not gzip), so the budgets are on the `.webm` files.
// build.json present. Per bank of build.json: <bank>.webm present, its size what build.json
// records, ≤ 400 KB. Across all: ≤ 12 MB; every STATIC_SOUNDS key in build.json's sounds, and
// every TYPICAL_MATCH weapon's shot (and silenced shot) with none of its keys left out (build.json
// `missing`); a typical match ≤ 3,000,000 B: the banks typicalMatchBanks (lib/sounds.mjs) names,
// the step sets those of the surfaces assets/maps/de_mirage/hull.glb's nodes name when that hull
// is built (none without it).
// Measured 2026-10-25 (CS2 build 2000935, VRF 20.1.7467): 90 banks 5,647,134 B, the largest
// grenade_fire 389,757 B; a typical match on Mirage 2,883,973 B (20 step sets).
import fs from 'node:fs';
import path from 'node:path';
import { createIO } from './lib/gltf.mjs';
import { isMain } from './lib/cli.mjs';
import { assetsDir, paths } from './lib/paths.mjs';
import { collector, exitWithReport } from './lib/report.mjs';
import { STATIC_SOUNDS, WEAPON_SOUNDS, typicalMatchBanks } from './lib/sounds.mjs';
import { TYPICAL_MATCH } from './lib/viewmodels.mjs';

const BUDGET = Object.freeze({ bankBytes: 400e3, totalBytes: 12e6, typicalBytes: 3e6 });
/** The map whose hull names the step sets of the typical match. */
const TYPICAL_MAP = 'de_mirage';

/** The rows for the sounds build in `dir` (assets/sounds/), as the header says. */
export async function checkSounds(dir = path.join(assetsDir(), 'sounds')) {
  const { rows, row } = collector();
  const kb = (n) => `${(n / 1e3).toFixed(1)} KB`;
  const bytes = (n) => `${n.toLocaleString('en-US')} B`;
  let build = null;
  try { build = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8')); } catch { /* reported below */ }
  row('build.json', build ? `CS2 build ${build.raw?.cs2Build}, VRF ${String(build.raw?.vrf).split('+')[0]}` : 'missing', 'present', !!build);
  const sounds = build?.sounds ?? {};

  let total = 0;
  const sizeOf = new Map();
  for (const [bank, b] of Object.entries(build?.banks ?? {}).sort(([a], [z]) => a.localeCompare(z))) {
    const file = path.join(dir, `${bank}.webm`);
    if (!fs.existsSync(file)) { row(bank, 'missing', 'present', false); continue; }
    const size = fs.statSync(file).size;
    sizeOf.set(bank, size);
    total += size;
    const problems = [];
    if (size > BUDGET.bankBytes) problems.push(`over by ${kb(size - BUDGET.bankBytes)}`);
    if (b.bytes !== size) problems.push(`build.json records ${b.bytes} bytes`);
    row(bank, `${kb(size)}, ${Number(b.seconds).toFixed(1)} s, ${b.clips} clips${problems.length ? `: ${problems.join(', ')}` : ''}`, `≤ ${kb(BUDGET.bankBytes)}`, problems.length === 0);
  }
  row('total', `${bytes(total)} in ${sizeOf.size} banks`, `≤ ${bytes(BUDGET.totalBytes)}`, sizeOf.size > 0 && total <= BUDGET.totalBytes);

  const lacking = (keys) => keys.filter((k) => !Object.hasOwn(sounds, k));
  /** The first 8 of `keys`, and how many more. */
  const some = (keys) => keys.slice(0, 8).join(' ') + (keys.length > 8 ? ` and ${keys.length - 8} more` : '');
  const staticKeys = Object.keys(STATIC_SOUNDS);
  const staticLacking = lacking(staticKeys);
  row('static keys', `${staticKeys.length - staticLacking.length}/${staticKeys.length}${staticLacking.length ? `, lacking ${some(staticLacking)}` : ''}`, 'all', staticLacking.length === 0);
  // A weapon's shot must be there; its reloads exist only when CS2 has their events, and one that
  // does but whose files the rip lacks is in build.json's `missing`.
  const typical = TYPICAL_MATCH.filter((w) => Object.hasOwn(WEAPON_SOUNDS, w));
  const shotKeys = typical.flatMap((w) => [`shot:${w}`, ...(WEAPON_SOUNDS[w].silenced ? [`shot:${w}:silenced`] : [])]);
  const ofTypical = (k) => /^(shot|reload):/.test(k) && typical.includes(k.split(':')[1]);
  const weaponLacking = [...new Set([...lacking(shotKeys), ...(build?.missing ?? []).filter(ofTypical)])].sort();
  const weaponKeys = Object.keys(sounds).filter(ofTypical).length;
  row(`typical weapon keys (${typical.length} weapons)`, `${weaponKeys} present${weaponLacking.length ? `, lacking ${some(weaponLacking)}` : ''}`, 'every shot, none left out', weaponLacking.length === 0);
  const others = (build?.missing ?? []).filter((k) => !ofTypical(k) && !Object.hasOwn(STATIC_SOUNDS, k));
  if (others.length) row('other keys left out', some(others), 'any', true);

  // The typical match: what a Mirage match loads, the steps by the surfaces of Mirage's hull.
  const hull = paths(TYPICAL_MAP).hull;
  let nodeNames = null;
  if (fs.existsSync(hull)) {
    const io = await createIO();
    nodeNames = (await io.read(hull)).getRoot().listNodes().map((n) => n.getName());
  }
  const banks = typicalMatchBanks({ sounds, surfaces: build?.surfaces ?? {} }, TYPICAL_MATCH, nodeNames);
  const sum = (list) => list.reduce((n, b) => n + (sizeOf.get(b) ?? 0), 0);
  const all = [...banks.weapons, ...banks.fixed, ...banks.steps];
  const typicalBytes = sum(all);
  const absent = all.filter((b) => !sizeOf.has(b));
  const n = (x) => x.toLocaleString('en-US');
  const parts = [
    `${banks.weapons.length} weapon ${n(sum(banks.weapons))}`,
    `${banks.fixed.length} grenade/bomb/player/round ${n(sum(banks.fixed))}`,
    nodeNames ? `${banks.steps.length} steps ${n(sum(banks.steps))} (${TYPICAL_MAP} hull)` : `no steps (no ${TYPICAL_MAP} hull)`,
  ];
  row('typical match', `${bytes(typicalBytes)} = ${parts.join(' + ')}${absent.length ? `; missing ${absent.join(' ')}` : ''}`,
    `≤ ${bytes(BUDGET.typicalBytes)}`, build !== null && absent.length === 0 && typicalBytes <= BUDGET.typicalBytes);
  return rows;
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) { console.error('usage: node tools/check-sounds.mjs'); process.exit(1); }
  const dir = path.join(assetsDir(), 'sounds');
  exitWithReport(`sounds  (${path.relative(process.cwd(), dir) || '.'})`, await checkSounds(dir));
}
