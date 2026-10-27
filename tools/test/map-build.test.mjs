// shrink-map.mjs's build context (lib/map-build.mjs MapBuild) and its tier ladder (walkTiers),
// driven with a stub lit document and stub texture shipping in a scratch maps/<map>/: what is
// staged, logged, gzipped and installed, the first load each try counts, the tiers and sizes the
// walk tries against the cap, and shrink.json's `fallback`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Document } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MeshoptEncoder } from '../lib/gltf.mjs';
import { MapBuild } from '../lib/map-build.mjs';
import { MAP_BAKE_FILES, MAP_FIRST_LOAD } from '../lib/maps.mjs';
import { PARAMS, walkTiers } from '../shrink-map.mjs';

let root, out;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-build-test-'));
  out = path.join(root, 'maps', 'de_mirage');
  fs.mkdirSync(out, { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A build of de_mirage into `out` whose lines go to `lines` and whose clock is `clock.t` ms. */
function newBuild() {
  const lines = [];
  const clock = { t: 1000 };
  const build = new MapBuild('de_mirage', { out }, { log: (l) => lines.push(l), now: () => clock.t });
  return { build, lines, clock };
}

/** `n` bytes that gzip cannot shrink, so a file's first-load share is about its size. */
const noise = (n) => crypto.randomBytes(n);
const gzSize = (file) => fs.statSync(`${file}.gz`).size;

describe('MapBuild', () => {
  test('stages in <out>.tmp-<pid>, tracks what it wrote, and installs only that', () => {
    fs.writeFileSync(path.join(out, 'radar.png'), 'radar');
    fs.writeFileSync(path.join(out, 'entities.glb'), 'a door from an earlier build');
    fs.writeFileSync(path.join(out, 'world_hd.glb'), 'retired');
    const { build } = newBuild();
    expect(build.dir).toBe(`${out}.tmp-${process.pid}`);
    expect(fs.statSync(build.dir).isDirectory()).toBe(true);

    build.write('world.glb', 'world');
    build.write('lightmap.webp', 'lightmap');
    build.write('light.json', '{}');
    build.unwrite('lightmap.webp');
    expect(fs.existsSync(build.file('lightmap.webp'))).toBe(false);
    build.gzip(['world.glb', 'light.json']);
    expect([...build.written].sort()).toEqual(['light.json', 'light.json.gz', 'world.glb', 'world.glb.gz']);
    expect(build.has('world.glb.gz')).toBe(true);
    expect(build.has('lightmap.webp')).toBe(false);
    expect(build.gzBytes['world.glb']).toBe(gzSize(build.file('world.glb')));
    expect(zlib.gunzipSync(fs.readFileSync(build.file('world.glb.gz'))).toString()).toBe('world');

    build.install();
    expect(fs.readdirSync(out).sort()).toEqual(['light.json', 'light.json.gz', 'radar.png', 'world.glb', 'world.glb.gz']);
    expect(fs.existsSync(build.dir)).toBe(false);
  });

  test('stage logs the time since the start and records each stage\'s own seconds', () => {
    const { build, lines, clock } = newBuild();
    clock.t += 1500;
    build.stage('read', 'the raw world');
    clock.t += 250;
    build.stage('drop', '3 nodes');
    expect(lines).toEqual([
      '[   1.5s] read      the raw world (+1.5s)',
      '[   1.8s] drop      3 nodes (+0.3s)',
    ]);
    expect(build.stages).toEqual({ read: 1.5, drop: 0.3 });
    expect(Object.keys(build.stages)).toEqual(['read', 'drop']);
    clock.t += 10_000;
    expect(build.seconds()).toBe(11.8);
    build.abort();
  });

  test('firstLoad counts what is staged, each file by its .gz where it has one', () => {
    const { build } = newBuild();
    build.write('world.glb', noise(5000));
    build.write('probes.bin', Buffer.alloc(4000));
    build.gzip(['probes.bin']);
    const want = 5000 + gzSize(build.file('probes.bin'));
    expect(build.firstLoad(MAP_FIRST_LOAD)).toBe(want);
    build.abort();
    expect(fs.existsSync(build.dir)).toBe(false);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  test('a new build removes the staging directory a killed run of this pid left', () => {
    const left = `${out}.tmp-${process.pid}`;
    fs.mkdirSync(left);
    fs.writeFileSync(path.join(left, 'world.glb'), 'stale');
    const { build } = newBuild();
    expect(fs.readdirSync(build.dir)).toEqual([]);
    build.abort();
  });
});

describe('walkTiers', () => {
  // The radars, overview and sky already in <out> (radar.mjs and sky.mjs run first); the first
  // load counts them beside what the build stages.
  const OTHERS = { 'radar.png': 30_000, 'overview.json': 1_000, 'sky.webp': 9_000 };
  // world.glb's bytes per tier and texture size, and H2's lightmap.
  const WORLD = { H2: { 256: 400_000, 192: 300_000 }, V: { 256: 250_000, 192: 150_000 } };
  const LIGHTMAP = 60_000;

  /**
   * walkTiers over a stub bake: probes.bin staged as bakeWorld stages it, `light` stages light.json
   * (and H2's lightmap.webp; tier V takes it back) as lightTier does, `textures` writes a world.glb
   * of WORLD's size. Returns the walk, the build, its lines and what each call saw.
   */
  async function walk(cap) {
    for (const [f, n] of Object.entries(OTHERS)) fs.writeFileSync(path.join(out, f), noise(n));
    // A lightmap.webp from an earlier H2 build: tier V must leave none.
    fs.writeFileSync(path.join(out, 'lightmap.webp'), 'stale');
    const { build, lines } = newBuild();
    build.write('probes.bin', noise(2_000));
    const lit = [];
    const shipped = [];
    const docs = {};
    const result = await walkTiers(build, {
      cap,
      light: async (tier) => {
        lit.push(tier);
        const d = new Document();
        docs[tier] = d;
        const light = { version: 2, range: 8, lightmap: tier === 'V' ? null : { file: 'lightmap.webp', size: [1024, 1024] } };
        build.write('light.json', JSON.stringify(light));
        if (tier === 'V') build.unwrite('lightmap.webp');
        else build.write('lightmap.webp', noise(LIGHTMAP));
        return { d, suffix: tier === 'V' ? '_v' : '', pruned: () => prune(), meshoptOptions: { encoder: MeshoptEncoder }, light, tier };
      },
      textures: async (d, finish, suffix, size) => {
        const tier = suffix.startsWith('_v') ? 'V' : 'H2';
        shipped.push({ tier, suffix, size, lit: d === docs[tier], finish: finish().length });
        const worldBytes = noise(WORLD[tier][size]);
        build.write('world.glb', worldBytes);
        return { worldBytes };
      },
    });
    return { result, build, lines, lit, shipped };
  }

  /** The first load of a try that staged world.glb and the bake (lightmap.webp only for H2). */
  const firstLoadOf = (build) => build.firstLoad(['world.glb', 'entities.glb', ...MAP_BAKE_FILES]) + Object.values(OTHERS).reduce((a, b) => a + b, 0);

  test('ships H2 at 256 px when it fits, with no fallback', async () => {
    const { result, build, lit, shipped } = await walk(10e6);
    expect(lit).toEqual(['H2']);
    expect(shipped).toEqual([{ tier: 'H2', suffix: '', size: PARAMS.world.size, lit: false, finish: 2 }]);
    expect(result.tier).toBe('H2');
    expect(result.fallback).toBeNull();
    expect(result.tries.map((t) => [t.tier, t.size])).toEqual([['H2', null]]);
    expect(result.shipped.worldSize).toBe(256);
    expect(result.shipped.light.lightmap).not.toBeNull();
    expect(result.shipped.firstLoad).toBe(firstLoadOf(build));
    // world.glb, light.json and probes.bin are gzipped with each try.
    for (const f of ['world.glb', 'light.json', 'probes.bin']) expect(build.has(`${f}.gz`)).toBe(true);
    expect(build.stages).toHaveProperty('firstload');
    build.install();
    expect(fs.existsSync(path.join(out, 'lightmap.webp'))).toBe(true);
  });

  test('tries H2 at 192 px next, on a copy of the lit world only while a size is left', async () => {
    const h2At256 = 400_000 + LIGHTMAP + 2_000 + 41_000;
    const { result, lit, shipped, lines } = await walk(h2At256 - 50_000);
    expect(lit).toEqual(['H2']);
    expect(shipped.map((s) => [s.tier, s.size, s.lit])).toEqual([['H2', 256, false], ['H2', 192, true]]);
    expect(result.tier).toBe('H2');
    expect(result.shipped.worldSize).toBe(192);
    expect(result.fallback).toMatch(/^H2's fits \(\d+ B at 256 px, \d+ B at 192 px\)$/);
    expect(lines.some((l) => /is over the cap \d+ B: world\.glb's textures at 192 px/.test(l))).toBe(true);
  });

  test('falls to tier V, built once, which takes back the lightmap', async () => {
    const { result, build, lit, shipped, lines } = await walk(320_000);
    expect(lit).toEqual(['H2', 'V']);
    expect(shipped.map((s) => [s.tier, s.suffix, s.size, s.lit])).toEqual([
      ['H2', '', 256, false], ['H2', '_192', 192, true], ['V', '_v', 256, false],
    ]);
    expect(result.tier).toBe('V');
    expect(result.shipped.light.lightmap).toBeNull();
    expect(result.shipped.firstLoad).toBeLessThanOrEqual(320_000);
    expect(result.fallback).toMatch(/^H2's first load \(\d+ B at 256 px, \d+ B at 192 px\) is over the cap 320000 B; V's fits \(\d+ B at 256 px\)$/);
    expect(lines.some((l) => l.includes(': tier V (vertex light only, no lightmap)'))).toBe(true);
    expect(build.has('lightmap.webp')).toBe(false);
    build.install();
    expect(fs.existsSync(path.join(out, 'lightmap.webp'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'lightmap.webp.gz'))).toBe(false);
  });

  test('past the last try ships it and says check-map.mjs will fail the map', async () => {
    const { result, lit, shipped, lines } = await walk(1_000);
    expect(lit).toEqual(['H2', 'V']);
    expect(shipped.map((s) => [s.tier, s.size, s.lit])).toEqual([['H2', 256, false], ['H2', 192, true], ['V', 256, false], ['V', 192, true]]);
    expect(result.tries).toHaveLength(4);
    expect(result.tier).toBe('V');
    expect(result.shipped.worldSize).toBe(192);
    expect(result.fallback).toMatch(/^H2's first load \(.*\) is over the cap 1000 B; V's first load \(.*\) is over the cap 1000 B: check-map\.mjs will fail the map$/);
    expect(lines.at(-1)).toBe(`           ${result.fallback}`);
  });
});
