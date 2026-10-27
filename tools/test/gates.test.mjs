// The check-*.mjs gates, which decide that a build may be listed and synced (build-assets.sh
// writes a manifest only after its gate exits 0): each one's rows over small fixture trees in a
// temp ASSETS_DIR, a whole tree passing where one can be made small, and each known-bad change
// failing the row it should. Their command lines are run too: exit 1 and the FAILED line on a bad
// tree, 0 on a good one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkEffects } from '../check-effects.mjs';
import { checkMap } from '../check-map.mjs';
import { checkPlayers } from '../check-players.mjs';
import { checkSounds } from '../check-sounds.mjs';
import { checkViewmodels } from '../check-viewmodels.mjs';
import { BUDGET as WEAPON_BUDGET, checkWeapons } from '../check-weapons.mjs';
import { BUDGET, budgetFor } from '../lib/budgets.mjs';
import { ATLAS_WIDTH, EFFECT_KEYS, EFFECTS } from '../lib/effects.mjs';
import { createIO } from '../lib/gltf.mjs';
import { paths } from '../lib/paths.mjs';
import { collector, failures, reportLines, row, skipRow } from '../lib/report.mjs';
import { STATIC_SOUNDS, WEAPON_SOUNDS } from '../lib/sounds.mjs';
import { TYPICAL_MATCH } from '../lib/viewmodels.mjs';
import { GROUND_MODELS, MODEL_NAMES, weaponPaths } from '../lib/weapons.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// These run build-assets.sh or the gates as subprocesses, dozens of node starts a test: slow on
// a loaded machine, so past vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });

let root, was;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-test-'));
  was = process.env.ASSETS_DIR;
  process.env.ASSETS_DIR = root;
});
afterEach(() => {
  if (was === undefined) delete process.env.ASSETS_DIR;
  else process.env.ASSETS_DIR = was;
  fs.rmSync(root, { recursive: true, force: true });
});

const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const gz = (file) => put(`${file}.gz`, zlib.gzipSync(fs.readFileSync(file)));
/** Each row's status by its check (the last row of a name wins). */
const status = (rows) => Object.fromEntries(rows.map(([check, , , s]) => [check, s]));
/** The checks that failed. */
const failed = (rows) => rows.filter((r) => r[3] === 'FAIL').map((r) => r[0]);

/** `script` run as build-assets.sh runs it, against this test's ASSETS_DIR. */
const cli = (script, ...args) =>
  spawnSync(process.execPath, [path.join(TOOLS, script), ...args], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });

/**
 * A GLB of one triangle-list mesh of `tris` triangles (with COLOR_0 unless `colour` is false), a
 * skin with `joints` joints when given, `clips` animations, and scene `extras`.
 */
async function glb(file, { tris = 1, colour = true, joints = 0, clips = [], extras = null, mesh = true } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  if (extras) scene.setExtras(extras);
  if (mesh) {
    const pos = new Float32Array(9 * tris);
    for (let t = 0; t < tris; t++) pos.set([t, 0, 0, t + 1, 0, 0, t, 0, 1], 9 * t);
    const prim = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer));
    if (colour) prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(new Uint8Array(12 * tris).fill(255)).setNormalized(true).setBuffer(buffer));
    const node = doc.createNode('mesh').setMesh(doc.createMesh().addPrimitive(prim));
    scene.addChild(node);
    if (joints) {
      const bones = Array.from({ length: joints }, (_, i) => doc.createNode(`bone${i}`));
      for (const b of bones) scene.addChild(b);
      node.setSkin(doc.createSkin().setSkeleton(bones[0]));
      for (const b of bones) node.getSkin().addJoint(b);
    }
  }
  for (const name of clips) {
    const target = doc.createNode(`${name}_target`);
    scene.addChild(target);
    const sampler = doc.createAnimationSampler()
      .setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer))
      .setOutput(doc.createAccessor().setType('VEC3').setArray(new Float32Array(6)).setBuffer(buffer));
    doc.createAnimation(name).addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath('translation').setSampler(sampler));
  }
  put(file, await (await createIO()).writeBinary(doc));
}

describe('row and skipRow', () => {
  test('row is OK for true and FAIL for anything else, null and undefined too; only skipRow says SKIP', () => {
    // A `x && cond` with x missing is null or undefined: such a check fails, never skips.
    expect([true, false, null, undefined].map((ok) => row('c', 1, 'b', ok)[3])).toEqual(['OK', 'FAIL', 'FAIL', 'FAIL']);
    expect(skipRow('sky.webp', 'none', 'optional')).toEqual(['sky.webp', 'none', 'optional', 'SKIP']);
    const c = collector();
    c.row('a', 1, 'b', null);
    c.skipRow('s', 'none', 'optional');
    c.warnRow('w', 2, 'b', false);
    expect(c.rows.map((r) => r[3])).toEqual(['FAIL', 'SKIP', 'WARN']);
  });
});

describe('reportLines', () => {
  test('prints every row padded, and says how many failed', () => {
    const rows = [['a', '1', '≤ 2', 'OK'], ['longer check', '3', '≤ 2', 'FAIL'], ['sky', 'none', 'optional', 'SKIP'], ['wall', '9 s', '≤ 5 s', 'WARN']];
    expect(failures(rows)).toBe(1);
    expect(reportLines('t', rows)).toEqual([
      't',
      'check         actual  budget',
      'a             1       ≤ 2       OK',
      'longer check  3       ≤ 2       FAIL',
      'sky           none    optional  SKIP',
      'wall          9 s     ≤ 5 s     WARN',
      '1 check(s) FAILED',
    ]);
    expect(reportLines('t', [rows[0], rows[2], rows[3]]).at(-1)).toBe('all checks OK');
  });
});

describe('check-map.mjs', () => {
  const MAP = 'de_test'; // outside LIGHTMAP_MAPS and LOWER_RADAR: no bake, one radar
  const budget = { ...budgetFor(MAP, false), worldTris: [1, 100] };
  const ov = (map, sections = [{ name: 'default', image: 'radar.png', altitudeMin: -10000, altitudeMax: 10000 }]) => ({
    map, posX: -3230, posY: 1713, scale: 5, size: 1024, sections, ctSpawn: null, tSpawn: null, bombA: null, bombB: null,
    inset: { left: 0, top: 0, right: 0, bottom: 0 },
  });
  const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#203040' } }).png().toBuffer();

  /** A whole map that passes: world and hull with their .gz, overview and radar, shrink.json. */
  async function wholeMap(map = MAP) {
    const P = paths(map);
    await glb(P.world, { tris: 10 });
    gz(P.world);
    await glb(P.hull, { tris: 10, colour: false });
    gz(P.hull);
    put(P.overview, JSON.stringify(ov(map)));
    put(P.radar, await png(1024, 1024));
    put(path.join(P.out, 'shrink.json'), JSON.stringify({ seconds: 12.5 }));
    return P;
  }
  const check = (map = MAP, b = budget) => checkMap(map, { paths: paths(map), budget: b });

  test('passes a whole map, the optional rows skipped', async () => {
    await wholeMap();
    const rows = await check();
    expect(failed(rows)).toEqual([]);
    expect(status(rows)).toMatchObject({
      'world.glb size': 'OK', 'world.glb triangles': 'OK', 'world.glb COLOR_0': 'OK', 'hull.glb size': 'OK',
      'world.glb.gz': 'OK', 'hull.glb.gz': 'OK', 'overview.json sections': 'OK', 'radar.png dimensions': 'OK',
      'first load': 'OK', 'shrink-map.mjs wall': 'OK', 'sky.webp': 'SKIP', 'light.json': 'SKIP', 'world_lo.glb': 'SKIP',
      'entities.glb': 'SKIP',
    });
  });

  test('fails a missing radar, a radar of the wrong size or format, and a radar image without a section', async () => {
    const P = await wholeMap();
    fs.rmSync(P.radar);
    expect(failed(await check())).toEqual(['radar.png dimensions']);
    put(P.radar, await png(512, 512));
    expect(failed(await check())).toEqual(['radar.png dimensions']);
    put(P.radar, await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#000' } }).jpeg().toBuffer());
    expect(failed(await check())).toEqual(['radar.png dimensions']);
    put(P.radar, await png(1024, 1024));
    put(P.radarLower, await png(1024, 1024));
    const rows = await check();
    expect(failed(rows)).toEqual(['radar_lower.png']);
    expect(rows.find((r) => r[0] === 'radar_lower.png')[1]).toBe('no section in overview.json');
  });

  test('fails an overview of another map, one the viewer could not read, and a lower-level map without its lower section', async () => {
    const P = await wholeMap();
    put(P.overview, JSON.stringify(ov('de_dust2')));
    expect(failed(await check())).toEqual(['overview.json']);
    put(P.overview, JSON.stringify(ov(MAP, [{ name: 'Default', image: 'radar_Default.png', altitudeMin: 0, altitudeMax: 1 }])));
    expect(failed(await check())).toEqual(['overview.json']);
    put(P.overview, '{');
    expect(failed(await check())).toEqual(['overview.json']);
    // Nuke has a lower level (LOWER_RADAR): an overview without one fails, as does its missing
    // bake (it is in LIGHTMAP_MAPS).
    await wholeMap('de_nuke');
    put(paths('de_nuke').overview, JSON.stringify(ov('de_nuke')));
    const nuke = await check('de_nuke', { ...budgetFor('de_nuke', true), worldTris: [1, 100] });
    expect(failed(nuke)).toEqual(['overview.json sections', 'light.json']);
    expect(nuke.find((r) => r[0] === 'overview.json sections')).toEqual(['overview.json sections', 'default', 'default and lower', 'FAIL']);
  });

  test('fails a first load over the cap, a world over its triangles or unlit, a stale .gz, a sky of the wrong size', async () => {
    const P = await wholeMap();
    expect(failed(await check(MAP, { ...budget, firstLoadBytes: 1000 }))).toEqual(['first load']);
    expect(failed(await check(MAP, { ...budget, worldTris: [1, 5] }))).toEqual(['world.glb triangles']);
    await glb(P.world, { tris: 10, colour: false });
    expect(failed(await check())).toEqual(['world.glb COLOR_0', 'world.glb.gz']);
    await glb(P.world, { tris: 10 });
    gz(P.world);
    put(P.sky, await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#88a' } }).webp().toBuffer());
    expect(failed(await check())).toEqual(['sky.webp dimensions']);
  });

  test("holds an override's budgets and marks them; a slow shrink only warns, a missing shrink.json fails", async () => {
    const P = await wholeMap();
    const rows = await check(MAP, { ...budget, overridden: ['worldBytes'] });
    expect(rows.find((r) => r[0] === 'world.glb size')[2]).toMatch(/ \(override\)$/);
    put(path.join(P.out, 'shrink.json'), JSON.stringify({ seconds: BUDGET.shrinkSeconds + 1 }));
    const slow = await check();
    expect(status(slow)['shrink-map.mjs wall']).toBe('WARN');
    expect(failed(slow)).toEqual([]);
    fs.rmSync(path.join(P.out, 'shrink.json'));
    expect(failed(await check())).toEqual(['shrink-map.mjs wall']);
  });

  test('the command line exits 1 with the table on a bad map, and refuses a bad name', async () => {
    await wholeMap();
    fs.rmSync(paths(MAP).radar);
    const r = cli('check-map.mjs', MAP);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^radar\.png dimensions +missing +1024×1024 +FAIL$/m);
    expect(r.stdout).toMatch(/check\(s\) FAILED\n$/);
    expect(cli('check-map.mjs', '../x').status).toBe(1);
    expect(cli('check-map.mjs').status).toBe(1);
  });
});

describe('check-weapons.mjs', () => {
  /** Every model as shrink-weapon.mjs writes it: a mesh, a held weapon's attach, .gz and shrink.json. */
  async function allWeapons() {
    for (const name of MODEL_NAMES) {
      const P = weaponPaths(name);
      await glb(P.glb, { extras: name in GROUND_MODELS ? null : { attach: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } } });
      gz(P.glb);
      put(P.shrinkJson, '{}');
    }
  }

  test('passes every model; the command line exits 0', async () => {
    await allWeapons();
    expect(failed(await checkWeapons())).toEqual([]);
    const r = cli('check-weapons.mjs');
    expect(r.stdout).toMatch(/all checks OK\n$/);
    expect(r.status).toBe(0);
  });

  test('fails a model with a skin, over its triangles, without its .gz or its attach, and a missing one', async () => {
    await allWeapons();
    const held = MODEL_NAMES.find((n) => !(n in GROUND_MODELS));
    const [a, b, c, d] = MODEL_NAMES.filter((n) => n !== held);
    await glb(weaponPaths(a).glb, { joints: 2, extras: { attach: {} } });
    gz(weaponPaths(a).glb);
    await glb(weaponPaths(b).glb, { tris: WEAPON_BUDGET.tris + 1, extras: { attach: {} } });
    gz(weaponPaths(b).glb);
    fs.rmSync(weaponPaths(c).gz);
    fs.rmSync(weaponPaths(d).glb);
    await glb(weaponPaths(held).glb);
    gz(weaponPaths(held).glb);
    const rows = await checkWeapons();
    expect(failed(rows).sort()).toEqual([a, b, c, d, held, 'models present'].sort());
    const actual = (n) => rows.find((r) => r[0] === n)[1];
    expect(actual(a)).toMatch(/1 skin\(s\)/);
    expect(actual(b)).toMatch(new RegExp(`${WEAPON_BUDGET.tris + 1} tris`));
    expect(actual(c)).toMatch(/no \.gz/);
    expect(actual(d)).toBe('missing');
    expect(actual(held)).toMatch(/no extras\.attach/);
    expect(cli('check-weapons.mjs').status).toBe(1);
  });
});

describe('check-effects.mjs', () => {
  /** Every atlas as build-effects.mjs writes it: one row of cells, with alpha, and build.json. */
  async function allEffects() {
    const atlases = {};
    for (const key of EFFECT_KEYS) {
      const { cell } = EFFECTS[key];
      const cols = ATLAS_WIDTH / cell[0];
      const file = path.join(root, 'effects', `${key}.webp`);
      put(file, await sharp({ create: { width: ATLAS_WIDTH, height: cell[1], channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer());
      atlases[key] = { bytes: fs.statSync(file).size, width: ATLAS_WIDTH, height: cell[1], frames: cols - 1, cols, rows: 1, cell: [...cell], quality: 80 };
    }
    put(path.join(root, 'effects', 'build.json'), JSON.stringify({ cs2Build: '1', atlases }));
    return atlases;
  }

  test('passes every atlas; the command line exits 0', async () => {
    await allEffects();
    expect(failed(await checkEffects())).toEqual([]);
    expect(cli('check-effects.mjs').status).toBe(0);
  });

  test('fails an atlas build.json misdescribes, one of another width or without alpha, and no build.json', async () => {
    const atlases = await allEffects();
    const [a, b, c] = EFFECT_KEYS;
    atlases[a] = { ...atlases[a], bytes: atlases[a].bytes + 1 };
    put(path.join(root, 'effects', 'build.json'), JSON.stringify({ cs2Build: '1', atlases }));
    put(path.join(root, 'effects', `${b}.webp`), await sharp({ create: { width: ATLAS_WIDTH / 2, height: EFFECTS[b].cell[1], channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer());
    put(path.join(root, 'effects', `${c}.webp`), await sharp({ create: { width: ATLAS_WIDTH, height: EFFECTS[c].cell[1], channels: 3, background: '#000' } }).webp().toBuffer());
    const rows = await checkEffects();
    expect(failed(rows)).toEqual([a, b, c]);
    expect(rows.find((r) => r[0] === c)[1]).toMatch(/no alpha/);
    fs.rmSync(path.join(root, 'effects', 'build.json'));
    expect(failed(await checkEffects())).toContain('build.json');
    expect(cli('check-effects.mjs').status).toBe(1);
  });
});

describe('check-sounds.mjs', () => {
  /** A sounds build: one bank holding every static key and every typical weapon's shots. */
  function soundsBuild({ bankBytes = 1000 } = {}) {
    const sounds = {};
    for (const k of Object.keys(STATIC_SOUNDS)) sounds[k] = { bank: 'all', layers: [] };
    for (const w of TYPICAL_MATCH.filter((x) => Object.hasOwn(WEAPON_SOUNDS, x))) {
      sounds[`shot:${w}`] = { bank: 'all', layers: [] };
      if (WEAPON_SOUNDS[w].silenced) sounds[`shot:${w}:silenced`] = { bank: 'all', layers: [] };
    }
    const build = { raw: { cs2Build: '1', vrf: '20.1' }, banks: { all: { bytes: bankBytes, seconds: 1, clips: 1 } }, sounds, surfaces: {}, missing: [] };
    put(path.join(root, 'sounds', 'all.webm'), Buffer.alloc(bankBytes));
    put(path.join(root, 'sounds', 'build.json'), JSON.stringify(build));
    return build;
  }
  const writeBuild = (build) => put(path.join(root, 'sounds', 'build.json'), JSON.stringify(build));

  test('passes a whole build; the command line exits 0', async () => {
    soundsBuild();
    const rows = await checkSounds();
    expect(failed(rows)).toEqual([]);
    expect(rows.find((r) => r[0] === 'typical match')[1]).toMatch(/no steps \(no de_mirage hull\)/);
    expect(cli('check-sounds.mjs').status).toBe(0);
  });

  test('fails a bank over its budget or not the size build.json says, a missing static key, a typical weapon left out', async () => {
    soundsBuild({ bankBytes: 400_001 });
    expect(failed(await checkSounds())).toEqual(['all']);
    const build = soundsBuild();
    put(path.join(root, 'sounds', 'all.webm'), Buffer.alloc(999));
    expect(failed(await checkSounds())).toEqual(['all']);
    soundsBuild();
    const [firstStatic] = Object.keys(STATIC_SOUNDS);
    const { [firstStatic]: _, ...fewer } = build.sounds;
    writeBuild({ ...build, sounds: fewer });
    expect(failed(await checkSounds())).toEqual(['static keys']);
    writeBuild({ ...build, missing: ['reload:ak47'] });
    expect(failed(await checkSounds())).toContain('typical weapon keys (' + TYPICAL_MATCH.filter((x) => Object.hasOwn(WEAPON_SOUNDS, x)).length + ' weapons)');
    fs.rmSync(path.join(root, 'sounds', 'build.json'));
    expect(failed(await checkSounds())).toContain('build.json');
    expect(cli('check-sounds.mjs').status).toBe(1);
  });
});

describe('check-players.mjs', () => {
  test('fails sides that are missing, and one with no skin, no clips and no .gz', async () => {
    let rows = await checkPlayers();
    expect(failed(rows)).toEqual(['ct.glb', 't.glb']);
    await glb(path.join(root, 'players', 'ct.glb'), { clips: ['idle_rifle'] });
    put(path.join(root, 'players', 'ct.shrink.json'), JSON.stringify({ joints: 3 }));
    rows = await checkPlayers();
    expect(failed(rows)).toEqual(['ct.glb.gz', 'ct.glb clips', 'ct.glb skins', 'ct.glb joints', 'ct.glb skinned primitives', 't.glb']);
    const r = cli('check-players.mjs');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/6 check\(s\) FAILED\n$/);
  });
});

describe('check-viewmodels.mjs', () => {
  test('fails a missing build, and a clip file that carries a mesh and lacks its draw', async () => {
    let rows = await checkViewmodels();
    expect(failed(rows)).toEqual(expect.arrayContaining(['arms_ct', 'arms_t', 'clip files present', 'typical match (arms + ' + TYPICAL_MATCH.length + ' weapons)']));
    const name = TYPICAL_MATCH[0];
    const file = path.join(root, 'viewmodels', `${name}.glb`);
    await glb(file, { clips: ['idle'] });
    gz(file);
    put(path.join(root, 'viewmodels', `${name}.shrink.json`), JSON.stringify({ clips: { idle: {} } }));
    rows = await checkViewmodels();
    const row = rows.find((r) => r[0] === name);
    expect(row[3]).toBe('FAIL');
    expect(row[1]).toMatch(/has a mesh/);
    expect(row[1]).toMatch(/no draw/);
    expect(cli('check-viewmodels.mjs').status).toBe(1);
  });
});
