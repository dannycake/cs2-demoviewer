#!/usr/bin/env node
// node tools/check-site.mjs
//
// Checks assets/site/ and prints a table of actual vs expected. Exits 0 only when every row
// holds: build.json present; each rank icon (lib/site.mjs RANK_KEYS) a WebP of the size
// build.json records; the Steam logo an SVG with no script; each map's strip (MAP_STRIP) a
// WebP of the size and dimensions build.json records, within its budget, made from the hero.png
// now beside the map, and a strip for every map with a hero.png; the shrunk chicken
// (raw/site/chicken.glb) present and within CHICKEN_BUDGET; the homepage video either absent
// or all three of its files there.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isMain } from './lib/cli.mjs';
import { collector, exitWithReport } from './lib/report.mjs';
import { CHICKEN_BUDGET, CHICKEN_FILE, HOME_FILES, heroSha256, MAP_HERO, MAP_STRIP, mapsWithHero, RANK_KEYS, rankFile, sitePaths, STEAM_LOGO_FILE } from './lib/site.mjs';

/** The rows for the kind at `P` (lib/site.mjs sitePaths), as the header says. */
export async function checkSite(P = sitePaths()) {
  const { rows, row } = collector();
  let build = null;
  try { build = JSON.parse(fs.readFileSync(P.buildJson, 'utf8')); } catch { /* reported below */ }
  row('build.json', build ? `CS2 build ${build.cs2Build}` : 'missing', 'present', !!build);
  for (const key of RANK_KEYS) {
    const file = path.join(P.out, rankFile(key));
    const name = path.basename(file);
    if (!fs.existsSync(file)) { row(name, 'missing', 'present', false); continue; }
    const bytes = fs.statSync(file).size;
    const meta = await sharp(file).metadata().catch(() => ({}));
    const problems = [];
    if (meta.format !== 'webp') problems.push(`a ${meta.format ?? 'unreadable'} file`);
    if (build?.ranks?.[key]?.bytes !== bytes) problems.push('not the size build.json records');
    row(name, problems.join(', ') || `${(bytes / 1e3).toFixed(1)} KB, ${meta.width}×${meta.height}`, 'a WebP as built', !problems.length);
  }
  const logo = path.join(P.out, STEAM_LOGO_FILE);
  const svg = fs.existsSync(logo) ? fs.readFileSync(logo, 'utf8') : null;
  const logoOk = svg !== null && /<svg[\s>]/.test(svg) && !/<script|\son[a-z]+=/i.test(svg);
  row(STEAM_LOGO_FILE, svg === null ? 'missing' : logoOk ? `${svg.length} bytes` : 'not a plain SVG', 'an SVG without script', logoOk);
  const strips = build?.maps ?? {};
  for (const [map, b] of Object.entries(strips)) {
    const file = path.join(P.out, b.file);
    if (!fs.existsSync(file)) { row(b.file, 'missing', 'present', false); continue; }
    const bytes = fs.statSync(file).size;
    const meta = await sharp(file).metadata().catch(() => ({}));
    const problems = [];
    if (meta.format !== 'webp') problems.push(`a ${meta.format ?? 'unreadable'} file`);
    if (b.bytes !== bytes) problems.push('not the size build.json records');
    if (meta.width !== MAP_STRIP.width || meta.height !== MAP_STRIP.height) problems.push(`${meta.width}×${meta.height}`);
    if (bytes > MAP_STRIP.budget) problems.push('over its budget');
    const hero = path.join(P.maps, map, MAP_HERO);
    if (!fs.existsSync(hero)) problems.push(`no ${MAP_HERO} beside ${map}`);
    else if (heroSha256(P.maps, map) !== b.hero) problems.push(`made from an older ${MAP_HERO}`);
    row(
      b.file,
      problems.join(', ') || `${(bytes / 1e3).toFixed(1)} KB, ${meta.width}×${meta.height}`,
      `a WebP as built, ≤ ${(MAP_STRIP.budget / 1e3).toFixed(0)} KB`,
      !problems.length,
    );
  }
  const unstripped = mapsWithHero(P.maps).filter((m) => !Object.hasOwn(strips, m));
  row(
    'map strips',
    unstripped.length ? `none for ${unstripped.join(', ')}` : `${Object.keys(strips).length} maps`,
    `one for each map with a ${MAP_HERO}`,
    !unstripped.length,
  );
  const chicken = path.join(P.raw, CHICKEN_FILE);
  const chickenBytes = fs.existsSync(chicken) ? fs.statSync(chicken).size : null;
  row(
    `raw/site/${CHICKEN_FILE}`,
    chickenBytes === null ? 'missing' : `${(chickenBytes / 1e6).toFixed(2)} MB`,
    `≤ ${(CHICKEN_BUDGET / 1e6).toFixed(1)} MB`,
    chickenBytes !== null && chickenBytes <= CHICKEN_BUDGET,
  );
  const home = Object.values(HOME_FILES).filter((f) => fs.existsSync(path.join(P.out, f)));
  row('home video', `${home.length} of 3 files`, 'none or all 3', home.length === 0 || home.length === 3);
  return rows;
}

if (isMain(import.meta.url)) exitWithReport('check-site', await checkSite());
