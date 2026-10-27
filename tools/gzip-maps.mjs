#!/usr/bin/env node
// node tools/gzip-maps.mjs <map>... | all
//
// Writes the gzip -9 `.gz` siblings of a built map's world.glb and hull.glb,
// and its entities.glb where it has one (what shrink-map.mjs writes since 2026-10-22), for
// maps shrunk before that, without shrinking them again. `all` is every map under
// ASSETS_DIR/maps with a world.glb.
import fs from 'node:fs';
import path from 'node:path';
import { assetsDir } from './lib/paths.mjs';
import { writeGzSiblings } from './lib/gz.mjs';
import { MAP_GLBS, MAP_OPTIONAL_GLBS } from './lib/maps.mjs';

const GLBS = [...MAP_GLBS, ...MAP_OPTIONAL_GLBS];

const args = process.argv.slice(2);
if (args.length === 0 || args.some((a) => a.startsWith('-'))) {
  console.error('usage: node tools/gzip-maps.mjs <map>... | all');
  process.exit(2);
}
const root = path.join(assetsDir(), 'maps');
const maps = args.includes('all')
  ? fs.readdirSync(root).filter((m) => fs.existsSync(path.join(root, m, 'world.glb'))).sort()
  : args;
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
let failed = false;
for (const map of maps) {
  const dir = path.join(root, map);
  const names = GLBS.filter((f) => fs.existsSync(path.join(dir, f)));
  if (!names.length) {
    console.error(`${map}: no built map in ${dir}`);
    failed = true;
    continue;
  }
  const out = writeGzSiblings(dir, names);
  console.log(`${map}: ${out.map((o) => `${o.name} ${mb(o.bytes)} → ${mb(o.gzBytes)}`).join(', ')}`);
}
process.exit(failed ? 1 : 0);
