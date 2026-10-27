#!/usr/bin/env node
// node tools/check-map.mjs <map> [--budget-override]
//
// Checks a map's assets/maps/<map>/ against the plan's budgets (lib/budgets.mjs
// BUDGET, the Mirage acceptance) and prints a table of actual vs budget. With
// --budget-override the map's BUDGET_OVERRIDES entry (the design doc's per-map
// ladder) replaces the budgets it names, marked "(override)" in the table; a map
// without an entry, Mirage among them, is checked against BUDGET either way.
// Exits 0 only when every row holds. The materials rows apply the map's
// filters.mjs PER_MAP entry as well as the global rule. The radar rows are
// required: overview.json must be valid with a "lower" section exactly when the map
// is in LOWER_RADAR, every section's image must be a 1024×1024 PNG, and no radar
// image may lack a section. The entities.glb rows hold it to the map's doors and breakables
// (lib/entities.mjs movableEntities of raw/<map>/entities/default_ents.vents): absent on a
// map with none; otherwise ≤ 500 KB, one root per entity named by its hammer id at its spawn
// with its extras, COLOR_0 on every primitive (AO, or on a baked map the probes' vertex light)
// and a .gz. sky.webp is optional (a map without an enabled env_sky has none, a SKIP row);
// when there, it is a 2048×1024 (2:1) WebP of at most 1 MB, for every map. The bake rows
// (lib/light.mjs lightChecks, litCheck) apply when shrink-map.mjs baked the map's light:
// light.json valid, lightmap.webp within its budget and of the size light.json says (none
// under tier V), probes.bin decoding with light.json's range, their gz siblings (probes.bin.gz at
// most 0.4 MB), and every
// primitive of world.glb lit by TEXCOORD_1 or COLOR_0. A map in LIGHTMAP_MAPS
// (lib/maps.mjs: every map the pipeline builds) must have its bake: without light.json it fails.
// Any other map built without a bake has a SKIP row and keeps the "every primitive has COLOR_0"
// (AO) rows. The first load
// (lib/maps.mjs firstLoadBytes, entities.glb included) is held to the map's cap
// (lib/budgets.mjs: its first load before M2a + 2.5 MB, or + 5.0 MB in place of the 2.5 on the maps
// in FULL_LIGHTING_EXTRA). world_lo.glb, the phone tier (phone-tier.mjs), is optional (a SKIP
// row without it); when there, its record must name this world.glb and itself, it must be
// world.glb with every texture over 128 px fitted within it and every other byte the same
// (phoneProblems), no larger than world.glb, with a .gz. Sizes are decimal MB (1 MB =
// 1,000,000 bytes).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { paths } from './lib/paths.mjs';
import { createIO, countTris, listMaterialsFailing } from './lib/gltf.mjs';
import { LIGHTMAP_MAPS, LOWER_RADAR, firstLoadBytes } from './lib/maps.mjs';
import { overviewProblem } from './lib/overview.mjs';
import { budgetFor, kb, mb } from './lib/budgets.mjs';
import { isMain } from './lib/cli.mjs';
import { collector, exitWithReport } from './lib/report.mjs';
import { gzSiblingState } from './lib/gz.mjs';
import { entityChecks, movableEntities, parseEntities } from './lib/entities.mjs';
import { lightChecks, litCheck } from './lib/light.mjs';
import { PHONE_WORLD, phoneRows } from './phone-tier.mjs';
import { SKY_HEIGHT, SKY_MAX_BYTES, SKY_WIDTH } from './sky.mjs';

/**
 * The rows for map `map` in `P` (lib/paths.mjs paths(map)) against `BUDGET` (lib/budgets.mjs
 * budgetFor; an `overridden` key list marks the replaced budgets), as the header says.
 */
export async function checkMap(map, { paths: P = paths(map), budget: BUDGET = budgetFor(map, false) } = {}) {
  // " (override)" after a budget that BUDGET_OVERRIDES replaced for this map.
  const tag = (key) => ((BUDGET.overridden ?? []).includes(key) ? ' (override)' : '');
  // A WARN row (warnRow) is printed but never fails the check: for measurements that depend on
  // the machine's load rather than on the artefact (the shrink wall time).
  const { rows, row, skipRow, warnRow } = collector();
  const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : null);

  const io = await createIO();
  const read = async (f) => (fs.existsSync(f) ? io.read(f) : null);
  // The bake's light.json (shrink-map.mjs), when there is a valid one; lightChecks rows below.
  const lightFile = path.join(P.out, 'light.json');
  let light = null;
  try { light = fs.existsSync(lightFile) ? JSON.parse(fs.readFileSync(lightFile, 'utf8')) : null; } catch { light = null; }
  const litRow = (name, doc) => {
    const lit = litCheck(doc, light);
    row(`${name} ${lit.check}`, lit.actual, lit.budget, lit.ok);
  };

  // world.glb
  const world = await read(P.world);
  if (!world) {
    row('world.glb', 'missing', 'present', false);
  } else {
    row('world.glb size', mb(size(P.world)), `≤ ${mb(BUDGET.worldBytes)}${tag('worldBytes')}`, size(P.world) <= BUDGET.worldBytes);
    const tris = countTris(world);
    row('world.glb triangles', tris, `${BUDGET.worldTris[0]}–${BUDGET.worldTris[1]}${tag('worldTris')}`, tris >= BUDGET.worldTris[0] && tris <= BUDGET.worldTris[1]);
    litRow('world.glb', world);
  }

  // hull.glb
  const hull = await read(P.hull);
  if (!hull) row('hull.glb', 'missing', 'present', false);
  else row('hull.glb size', mb(size(P.hull)), `≤ ${mb(BUDGET.hullBytes)}${tag('hullBytes')}`, size(P.hull) <= BUDGET.hullBytes);

  // entities.glb: the doors and breakable windows shrink-map.mjs takes out of the world
  const vents = path.join(P.raw, 'entities', 'default_ents.vents');
  const ents = await read(P.entities);
  const movables = fs.existsSync(vents) ? movableEntities(parseEntities(fs.readFileSync(vents, 'utf8'))) : null;
  // entityChecks's ok is null for its one row that checks nothing (no entity lump).
  for (const [check, actual, budget, ok] of entityChecks({ movables, doc: ents, bytes: size(P.entities), budget: BUDGET.entitiesBytes })) {
    if (ok === null) skipRow(check, actual, budget);
    else row(check, actual, budget, ok);
  }

  // world_lo.glb, the phone tier (phone-tier.mjs), when built: world.glb with its textures within
  // 128 px and every other byte the same, made from this world.glb, with its .gz.
  for (const r of await phoneRows(P.out, PHONE_WORLD, `tools/phone-tier.mjs ${map}`)) rows.push(r);

  // The gzip siblings the server sends instead (shrink-map.mjs, or tools/gzip-maps.mjs).
  for (const f of [P.world, P.hull, P.entities]) {
    if (!fs.existsSync(f)) continue;
    const state = gzSiblingState(f);
    row(`${path.basename(f)}.gz`, state === 'ok' ? (f === P.entities ? kb : mb)(size(`${f}.gz`)) : state, 'inflates to the .glb', state === 'ok');
  }

  // tool/dev/black-unlit materials in any GLB
  for (const [name, doc] of [['world.glb', world], ['hull.glb', hull], ['entities.glb', ents]]) {
    if (!doc) continue;
    const bad = listMaterialsFailing(doc, map);
    row(`${name} materials`, bad.length ? `${bad.length} failing, e.g. ${bad[0].vmat || bad[0].shader}` : '0 failing', 'none dropped by filters.mjs', bad.length === 0);
  }

  // overview.json and the radar image of each of its sections (radar.mjs)
  let ov = null;
  if (!fs.existsSync(P.overview)) {
    row('overview.json', 'missing', 'present', false);
  } else {
    try {
      ov = JSON.parse(fs.readFileSync(P.overview, 'utf8'));
      const problem = overviewProblem(ov, map);
      if (problem) { row('overview.json', problem, 'valid Overview', false); ov = null; }
    } catch (e) {
      row('overview.json', `unparseable: ${e.message}`, 'valid JSON', false);
    }
  }
  if (ov) {
    const names = ov.sections.map((s) => s.name);
    const wantLower = LOWER_RADAR.has(map);
    row('overview.json sections', names.join(', '), wantLower ? 'default and lower' : 'no lower', names.includes('default') && names.includes('lower') === wantLower);
  }
  const images = ov ? ov.sections.map((s) => s.image) : ['radar.png'];
  for (const f of images) {
    const file = path.join(P.out, f);
    if (!fs.existsSync(file)) { row(`${f} dimensions`, 'missing', '1024×1024', false); continue; }
    const { width, height, format } = await sharp(file).metadata();
    row(`${f} dimensions`, `${width}×${height}${format === 'png' ? '' : ` ${format}`}`, '1024×1024', format === 'png' && width === BUDGET.radarSize[0] && height === BUDGET.radarSize[1]);
  }
  if (ov && fs.existsSync(P.out)) {
    for (const f of fs.readdirSync(P.out).sort()) {
      if (/^radar(_[a-z0-9_]+)?\.png$/i.test(f) && !images.includes(f)) row(f, 'no section in overview.json', 'every radar image has a section', false);
    }
  }

  // sky.webp (sky.mjs), when the map has a sky
  if (!fs.existsSync(P.sky)) {
    skipRow('sky.webp', 'none (the colour sky)', 'optional');
  } else {
    row('sky.webp size', mb(size(P.sky)), `≤ ${mb(SKY_MAX_BYTES)}`, size(P.sky) <= SKY_MAX_BYTES);
    const { width, height, format } = await sharp(P.sky).metadata();
    row('sky.webp dimensions', `${width}×${height}${format === 'webp' ? '' : ` ${format}`}`, `${SKY_WIDTH}×${SKY_HEIGHT} (2:1)`, format === 'webp' && width === SKY_WIDTH && height === SKY_HEIGHT);
  }

  // The baked light: light.json, lightmap.webp, probes.bin and their gz siblings; required on a
  // map in LIGHTMAP_MAPS, which must not ship the AO world in place of CS2's light.
  for (const r of await lightChecks(P.out, BUDGET, tag, { required: LIGHTMAP_MAPS.includes(map) })) rows.push(r);

  // What the viewer downloads to open the map.
  const firstLoad = firstLoadBytes(P.out);
  row('first load', mb(firstLoad), `≤ ${mb(BUDGET.firstLoadBytes)}${tag('firstLoadBytes')}`, firstLoad <= BUDGET.firstLoadBytes);

  // shrink-map.mjs wall time, from shrink.json
  const shrinkJson = path.join(P.out, 'shrink.json');
  if (fs.existsSync(shrinkJson)) {
    const s = JSON.parse(fs.readFileSync(shrinkJson, 'utf8'));
    warnRow('shrink-map.mjs wall', `${s.seconds} s`, `≤ ${BUDGET.shrinkSeconds} s${tag('shrinkSeconds')}`, typeof s.seconds === 'number' && s.seconds <= BUDGET.shrinkSeconds);
  } else {
    row('shrink-map.mjs wall', 'no shrink.json', `≤ ${BUDGET.shrinkSeconds} s${tag('shrinkSeconds')}`, false);
  }
  return rows;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const override = args.includes('--budget-override');
  const positional = args.filter((a) => a !== '--budget-override');
  const map = positional[0];
  if (positional.length !== 1 || map.startsWith('-') || args.length - positional.length > 1) {
    console.error('usage: node tools/check-map.mjs <map> [--budget-override]');
    process.exit(1);
  }
  let P;
  try { P = paths(map); } catch (e) { console.error(`check-map: ${e.message}`); process.exit(1); }
  exitWithReport(`${map}  (${path.relative(process.cwd(), P.out) || '.'})`, await checkMap(map, { paths: P, budget: budgetFor(map, override) }));
}
