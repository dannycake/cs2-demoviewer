#!/usr/bin/env node
// node tools/check-effects.mjs
//
// Checks assets/effects/ against the effects budget (spec §7.6) and prints a table of actual vs
// budget. Exits 0 only when every row holds. Per EFFECTS key: <key>.webp present, with alpha
// unless every cell is full, ≤ its budget; its size what build.json records, a whole number of
// cells, 1024 px wide; its frames fit its cols × rows. Across all: ≤ EFFECTS_BUDGET bytes.
// Measured 2026-10-22 (CS2 build 2000935, VRF 20.1): 11 atlases, 910.9 KB.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isMain } from './lib/cli.mjs';
import { ATLAS_WIDTH, EFFECT_KEYS, EFFECTS, EFFECTS_BUDGET, effectsPaths } from './lib/effects.mjs';
import { collector, exitWithReport } from './lib/report.mjs';

/** The rows for assets/effects/ (`P`, lib/effects.mjs effectsPaths()), as the header says. */
export async function checkEffects(P = effectsPaths()) {
  const { rows, row } = collector();
  const kb = (n) => `${(n / 1e3).toFixed(1)} KB`;
  let build = null;
  try { build = JSON.parse(fs.readFileSync(P.buildJson, 'utf8')); } catch { /* reported below */ }
  row('build.json', build ? `CS2 build ${build.cs2Build}` : 'missing', 'present', !!build);

  let total = 0;
  for (const key of EFFECT_KEYS) {
    const effect = EFFECTS[key];
    const file = path.join(P.out, `${key}.webp`);
    if (!fs.existsSync(file)) { row(key, 'missing', 'present', false); continue; }
    const bytes = fs.statSync(file).size;
    total += bytes;
    const meta = await sharp(file).metadata();
    const b = build?.atlases?.[key];
    const problems = [];
    if (bytes > effect.budget) problems.push(`over by ${kb(bytes - effect.budget)}`);
    if (!b) problems.push('not in build.json');
    else {
      if (b.bytes !== bytes) problems.push(`build.json records ${b.bytes} bytes`);
      if (b.width !== meta.width || b.height !== meta.height) problems.push(`build.json records ${b.width}×${b.height}`);
      if (b.frames > b.cols * b.rows) problems.push(`${b.frames} frames in ${b.cols}×${b.rows} cells`);
      if (b.cell[0] !== effect.cell[0] || b.cell[1] !== effect.cell[1]) problems.push(`cell ${b.cell.join('×')}, the table says ${effect.cell.join('×')}`);
      const full = b.frames === b.cols * b.rows;
      if (!meta.hasAlpha && !full) problems.push('no alpha');
    }
    if (meta.width !== ATLAS_WIDTH) problems.push(`${meta.width} px wide`);
    if (meta.width % effect.cell[0] || meta.height % effect.cell[1]) problems.push(`not a whole number of ${effect.cell.join('×')} cells`);
    row(key, `${kb(bytes)}, ${meta.width}×${meta.height}, ${b?.frames ?? '?'} frames, q${b?.quality ?? '?'}${problems.length ? `: ${problems.join(', ')}` : ''}`,
      `≤ ${kb(effect.budget)}`, problems.length === 0);
  }
  row('total', kb(total), `≤ ${kb(EFFECTS_BUDGET)}`, total <= EFFECTS_BUDGET);
  return rows;
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) { console.error('usage: node tools/check-effects.mjs'); process.exit(1); }
  const P = effectsPaths();
  exitWithReport(`effects  (${path.relative(process.cwd(), P.out) || '.'})`, await checkEffects(P));
}
