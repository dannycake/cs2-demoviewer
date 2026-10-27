import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_DUTY, LIGHTMAP_MAPS, LOWER_RADAR, MAP_BAKE_FILES, MAP_FIRST_LOAD, MAPS, MAP_GLBS, MAP_OPTIONAL_GLBS, MAP_RETIRED, firstLoadBytes } from '../lib/maps.mjs';
import { paths } from '../lib/paths.mjs';
test('lib/env.sh lists the same maps as lib/maps.mjs, for the bash scripts', () => {
  // env.sh dies without a CS2 install, so its two lines are read rather than sourced.
  const env = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'env.sh'), 'utf8');
  expect(/^ACTIVE_DUTY="([^"]*)"$/m.exec(env)?.[1].split(' ')).toEqual([...ACTIVE_DUTY]);
  expect(/^MAPS="([^"]*)"$/m.exec(env)?.[1]).toBe('$ACTIVE_DUTY de_cache');
  expect(new Set(ACTIVE_DUTY).size).toBe(ACTIVE_DUTY.length);
  expect([...LOWER_RADAR].every((m) => ACTIVE_DUTY.includes(m))).toBe(true);
});
test('the pipeline builds Active Duty and de_cache', () => {
  expect(MAPS).toEqual([...ACTIVE_DUTY, 'de_cache']);
});
test('paths follow the served layout', () => {
  process.env.ASSETS_DIR = '/a';
  const p = paths('de_mirage');
  expect(p.world).toBe('/a/maps/de_mirage/world.glb');
  expect(p.radarLower).toBe('/a/maps/de_mirage/radar_lower.png');
  expect(p.raw).toBe('/a/raw/de_mirage');
  expect(p.entities).toBe('/a/maps/de_mirage/entities.glb');
  expect(p.rawLightmaps).toBe('/a/raw/de_mirage/lightmaps');
  expect(p).not.toHaveProperty('worldHd');
});
test('every map serves world and hull; entities.glb only where it has doors or breakables; world_hd.glb is retired', () => {
  expect(MAP_GLBS).toEqual(['world.glb', 'hull.glb']);
  expect(MAP_OPTIONAL_GLBS).toEqual(['entities.glb']);
  expect(MAP_RETIRED).toEqual(['world_hd.glb']);
});
test('every map ships its baked light; the bake files are the lightmap, the light grid and light.json', () => {
  expect(LIGHTMAP_MAPS).toEqual(MAPS);
  expect(MAP_BAKE_FILES).toEqual(['lightmap.webp', 'probes.bin', 'light.json']);
});
test('the first load is what the viewer fetches to open a map, entities.glb with the world, without the hull (M2a and M2b leave it alone) or manifest.json (written last)', () => {
  expect(MAP_FIRST_LOAD).toEqual(['world.glb', 'entities.glb', 'radar.png', 'radar_lower.png', 'overview.json', 'sky.webp', ...MAP_BAKE_FILES]);
});
test('firstLoadBytes counts each first-load file as its .gz sibling where it has one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maps-test-'));
  try {
    const put = (f, n) => fs.writeFileSync(path.join(dir, f), Buffer.alloc(n));
    put('world.glb', 1000); put('world.glb.gz', 400);
    put('world_hd.glb', 5000); put('world_hd.glb.gz', 3000); put('hull.glb.gz', 70);
    put('radar.png', 50); put('overview.json', 7); put('manifest.json', 9);
    put('lightmap.webp', 200); put('probes.bin', 90); put('probes.bin.gz', 30); put('light.json', 11);
    put('entities.glb', 60); put('entities.glb.gz', 20);
    expect(firstLoadBytes(dir)).toBe(400 + 20 + 50 + 7 + 200 + 30 + 11);
    expect(firstLoadBytes(dir, ['world.glb', 'lightmap.webp', 'sky.webp'])).toBe(600);
    expect(firstLoadBytes(path.join(dir, 'nothing'))).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
