import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { effectsManifest, mapManifest, playersManifest, rootManifest, soundsManifest, viewmodelsManifest, weaponsManifest } from '../manifest.mjs';
import { EFFECT_KEYS } from '../lib/effects.mjs';
import { LIGHTMAP_MAPS } from '../lib/maps.mjs';
import { VIEWMODEL_DIRS } from '../lib/viewmodels.mjs';
import { MODEL_NAMES, MODEL_PATHS, WEAPON_NAMES } from '../lib/weapons.mjs';

const MANIFEST_MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'manifest.mjs');
const ISO_SECONDS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const VRF = '20.0.6980+a06886f7d06049052d32a7381ec05523064a2ca0';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
};
/** A file of `n` bytes whose content depends on its name, so every sha256 differs. */
const fake = (file, n) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(n, path.basename(file)));
};
const SECTION = {
  default: { name: 'default', image: 'radar.png', altitudeMin: -10000, altitudeMax: 10000 },
  lower: { name: 'lower', image: 'radar_lower.png', altitudeMin: -10000, altitudeMax: -495 },
};

/**
 * <root>/raw/<map>/rip.json and <root>/maps/<map>/ with small fake GLBs and radars, a
 * shrink.json whose byte counts match them, an overview.json with the given sections and, with
 * `bake`, a tier V bake (probes.bin and its light.json, no lightmap), which every map of
 * LIGHTMAP_MAPS ships.
 */
function fakeMap(map, { sections = ['default'], images = ['radar.png'], skip = [], entities = false, bake = true } = {}) {
  const rawDir = path.join(root, 'raw', map);
  const outDir = path.join(root, 'maps', map);
  writeJson(path.join(rawDir, 'rip.json'), { map, cs2Build: '2000934', vrfVersion: VRF, exportedAt: '2026-10-21T19:59:20Z' });
  const sizes = { 'world.glb': 3000, 'hull.glb': 500, ...(entities ? { 'entities.glb': 400 } : {}) };
  for (const [f, n] of Object.entries(sizes)) if (!skip.includes(f)) fake(path.join(outDir, f), n);
  for (const f of images) fake(path.join(outDir, f), 1200);
  writeJson(path.join(outDir, 'shrink.json'), {
    map, trisOut: 685376, aoVertices: 1046246,
    bytes: { world: sizes['world.glb'], hull: sizes['hull.glb'], ...(entities ? { entities: sizes['entities.glb'] } : {}) },
    params: { world: { format: 'webp', size: 256, quality: 60 } },
  });
  writeJson(path.join(outDir, 'overview.json'), { map, posX: -3230, posY: 1713, scale: 5, size: 1024, sections: sections.map((s) => SECTION[s]) });
  if (bake) {
    fake(path.join(outDir, 'probes.bin'), 36 + 10);
    writeJson(path.join(outDir, 'light.json'), { version: 2, range: 8, lightmap: null, sun: null, probes: { file: 'probes.bin' } });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), '{"stale": true}\n'); // an earlier manifest is not listed
  return { rawDir, outDir };
}

describe('mapManifest', () => {
  test('Mirage: lists exactly the files present with bytes and sha256; no radar_lower.png', async () => {
    const { rawDir, outDir } = fakeMap('de_mirage');
    const m = await mapManifest('de_mirage', outDir, rawDir);
    expect(Object.keys(m)).toEqual(['map', 'schema', 'cs2Build', 'vrf', 'generated', 'files', 'world', 'sections']);
    expect(m).toMatchObject({ map: 'de_mirage', schema: 1, cs2Build: '2000934', vrf: '20.0.6980' });
    expect(m.generated).toMatch(ISO_SECONDS);
    expect(Object.keys(m.files)).toEqual(['world.glb', 'hull.glb', 'radar.png', 'probes.bin', 'light.json', 'overview.json']);
    expect(m.files).not.toHaveProperty('radar_lower.png');
    for (const [name, entry] of Object.entries(m.files)) {
      const file = path.join(outDir, name);
      expect(entry).toEqual({ bytes: fs.statSync(file).size, sha256: sha256(file) });
    }
    expect(m.files['world.glb'].bytes).toBe(3000);
    expect(m.world).toEqual({ tris: 685376, textureSize: 256, ao: true });
    expect(m.sections).toEqual(['default']);
  });

  test('a world_hd.glb left from a build before it retired is not listed, nor is the shrink.json of then', async () => {
    const { rawDir, outDir } = fakeMap('de_mirage');
    fake(path.join(outDir, 'world_hd.glb'), 7000);
    const shrinkFile = path.join(outDir, 'shrink.json');
    const shrink = JSON.parse(fs.readFileSync(shrinkFile, 'utf8'));
    writeJson(shrinkFile, { ...shrink, bytes: { ...shrink.bytes, worldHd: 7000 }, params: { ...shrink.params, worldHd: { format: 'webp', size: 1024, quality: 75 } } });
    const m = await mapManifest('de_mirage', outDir, rawDir);
    expect(Object.keys(m.files)).toEqual(['world.glb', 'hull.glb', 'radar.png', 'probes.bin', 'light.json', 'overview.json']);
    expect(m).not.toHaveProperty('hd');
  });

  test("lists the map's sky.webp when it was built, after the radars, with its horizon colour; a map without one still builds", async () => {
    const { rawDir, outDir } = fakeMap('de_cache');
    fake(path.join(outDir, 'sky.webp'), 900);
    // sky.mjs's record of it; the viewer gives the fog and the sky below the horizon this colour.
    writeJson(path.join(outDir, 'sky.json'), { map: 'de_cache', material: 'materials/de_cache/sky/de_cache_sky_001.vmat', yaw: 116, exposure: 2.3, horizon: '#8a96a3' });
    const m = await mapManifest('de_cache', outDir, rawDir);
    expect(Object.keys(m.files)).toEqual(['world.glb', 'hull.glb', 'radar.png', 'sky.webp', 'probes.bin', 'light.json', 'overview.json']);
    expect(m.files['sky.webp']).toEqual({ bytes: 900, sha256: sha256(path.join(outDir, 'sky.webp')) });
    expect(m.sky).toEqual({ horizon: '#8a96a3' });
    expect(Object.keys(m)).toEqual(['map', 'schema', 'cs2Build', 'vrf', 'generated', 'files', 'world', 'sections', 'sky']);
    // A sky.webp without its sky.json (or with no colour in it) is a half-built sky.
    writeJson(path.join(outDir, 'sky.json'), { map: 'de_cache' });
    await expect(mapManifest('de_cache', outDir, rawDir)).rejects.toThrow(/sky\.json.*horizon.*sky\.mjs de_cache/);
    fs.rmSync(path.join(outDir, 'sky.json'));
    await expect(mapManifest('de_cache', outDir, rawDir)).rejects.toThrow(/sky\.json/);
    fs.rmSync(path.join(outDir, 'sky.webp'));
    const without = await mapManifest('de_cache', outDir, rawDir);
    expect(without.files).not.toHaveProperty('sky.webp');
    expect(without).not.toHaveProperty('sky');
  });

  test("lists the map's baked light (lightmap.webp, probes.bin, light.json) after the sky; tier V without a lightmap still builds, and no bake only off LIGHTMAP_MAPS", async () => {
    const { rawDir, outDir } = fakeMap('de_mirage', { bake: false });
    fake(path.join(outDir, 'lightmap.webp'), 600);
    fake(path.join(outDir, 'probes.bin'), 36 + 8);
    const light = { version: 1, range: 8, lightmap: { file: 'lightmap.webp', size: [1024, 1024] }, sun: null, probes: { file: 'probes.bin' } };
    writeJson(path.join(outDir, 'light.json'), light);
    const m = await mapManifest('de_mirage', outDir, rawDir);
    expect(Object.keys(m.files)).toEqual(['world.glb', 'hull.glb', 'radar.png', 'lightmap.webp', 'probes.bin', 'light.json', 'overview.json']);
    expect(m.files['light.json']).toEqual({ bytes: fs.statSync(path.join(outDir, 'light.json')).size, sha256: sha256(path.join(outDir, 'light.json')) });
    // Tier V: vertex light only, no lightmap.
    fs.rmSync(path.join(outDir, 'lightmap.webp'));
    writeJson(path.join(outDir, 'light.json'), { ...light, lightmap: null });
    expect(Object.keys((await mapManifest('de_mirage', outDir, rawDir)).files)).toEqual(['world.glb', 'hull.glb', 'radar.png', 'probes.bin', 'light.json', 'overview.json']);
    // A light.json naming a file the map lacks is a half-built bake.
    writeJson(path.join(outDir, 'light.json'), light);
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/light\.json names lightmap\.webp.*shrink-map\.mjs de_mirage/);
    // So are bake files without their light.json.
    fs.rmSync(path.join(outDir, 'light.json'));
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/probes\.bin.*without.*light\.json/);
    fs.rmSync(path.join(outDir, 'probes.bin'));
    // No bake at all is the AO world, which a map in LIGHTMAP_MAPS never ships (check-map.mjs
    // fails it too, but a manifest can be written by hand).
    expect(LIGHTMAP_MAPS).toContain('de_mirage');
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/light\.json is missing: de_mirage is in LIGHTMAP_MAPS \(tools\/lib\/maps\.mjs\), so it ships CS2's baked light, not AO; rerun tools\/shrink-map\.mjs de_mirage/);
    // A map off the list builds with AO, and lists no bake.
    expect(LIGHTMAP_MAPS).not.toContain('de_test');
    const off = fakeMap('de_test', { bake: false });
    expect(Object.keys((await mapManifest('de_test', off.outDir, off.rawDir)).files)).toEqual(['world.glb', 'hull.glb', 'radar.png', 'overview.json']);
  });

  test("world.textureSize is the size world.glb's textures shipped at: the bake's (a ladder's 192 px rung) over the parameter's 256, the parameter's without a bake", async () => {
    const { rawDir, outDir } = fakeMap('de_inferno');
    const shrinkFile = path.join(outDir, 'shrink.json');
    const shrink = JSON.parse(fs.readFileSync(shrinkFile, 'utf8'));
    expect(shrink.params.world.size).toBe(256);
    writeJson(shrinkFile, { ...shrink, bake: { tier: 'H2', worldTextureSize: 192 } });
    expect((await mapManifest('de_inferno', outDir, rawDir)).world).toEqual({ tris: 685376, textureSize: 192, ao: true });
    writeJson(shrinkFile, { ...shrink, bake: { tier: 'H2', worldTextureSize: 256 } });
    expect((await mapManifest('de_inferno', outDir, rawDir)).world.textureSize).toBe(256);
    writeJson(shrinkFile, shrink);
    expect((await mapManifest('de_inferno', outDir, rawDir)).world.textureSize).toBe(256);
  });

  test('Nuke: radar_lower.png listed and both sections named', async () => {
    const { rawDir, outDir } = fakeMap('de_nuke', { sections: ['default', 'lower'], images: ['radar.png', 'radar_lower.png'] });
    const m = await mapManifest('de_nuke', outDir, rawDir);
    expect(Object.keys(m.files)).toEqual(['world.glb', 'hull.glb', 'radar.png', 'radar_lower.png', 'probes.bin', 'light.json', 'overview.json']);
    const lower = path.join(outDir, 'radar_lower.png');
    expect(m.files['radar_lower.png']).toEqual({ bytes: 1200, sha256: sha256(lower) });
    expect(m.files['radar_lower.png'].sha256).not.toBe(m.files['radar.png'].sha256);
    expect(m.sections).toEqual(['default', 'lower']);
  });

  test('Nuke with doors and windows: entities.glb listed after hull.glb and checked against shrink.json', async () => {
    const { rawDir, outDir } = fakeMap('de_nuke', { sections: ['default', 'lower'], images: ['radar.png', 'radar_lower.png'], entities: true });
    const m = await mapManifest('de_nuke', outDir, rawDir);
    expect(Object.keys(m.files)).toEqual(['world.glb', 'hull.glb', 'entities.glb', 'radar.png', 'radar_lower.png', 'probes.bin', 'light.json', 'overview.json']);
    expect(m.files['entities.glb']).toEqual({ bytes: 400, sha256: sha256(path.join(outDir, 'entities.glb')) });
    fake(path.join(outDir, 'entities.glb'), 401);
    await expect(mapManifest('de_nuke', outDir, rawDir)).rejects.toThrow(/entities\.glb.*401.*400/);
  });

  test('an entities.glb shrink.json does not record, or one it records that is missing, is an error', async () => {
    const a = fakeMap('de_mirage');
    fake(path.join(a.outDir, 'entities.glb'), 400); // left from an earlier build
    await expect(mapManifest('de_mirage', a.outDir, a.rawDir)).rejects.toThrow(/entities\.glb.*400.*undefined/);
    const b = fakeMap('de_nuke', { sections: ['default', 'lower'], images: ['radar.png', 'radar_lower.png'], entities: true, skip: ['entities.glb'] });
    await expect(mapManifest('de_nuke', b.outDir, b.rawDir)).rejects.toThrow(/entities\.glb.*missing/);
  });

  test('a section whose image is missing, or a radar image no section names, is an error', async () => {
    const a = fakeMap('de_nuke', { sections: ['default', 'lower'], images: ['radar.png'] });
    await expect(mapManifest('de_nuke', a.outDir, a.rawDir)).rejects.toThrow(/radar_lower\.png/);
    const b = fakeMap('de_train', { sections: ['default'], images: ['radar.png', 'radar_lower.png'] });
    await expect(mapManifest('de_train', b.outDir, b.rawDir)).rejects.toThrow(/radar_lower\.png/);
  });

  test('a missing required file, rip.json or shrink.json is an error naming it', async () => {
    const a = fakeMap('de_mirage', { skip: ['hull.glb'] });
    await expect(mapManifest('de_mirage', a.outDir, a.rawDir)).rejects.toThrow(/hull\.glb/);
    const b = fakeMap('de_dust2');
    fs.rmSync(path.join(b.rawDir, 'rip.json'));
    await expect(mapManifest('de_dust2', b.outDir, b.rawDir)).rejects.toThrow(/rip\.json/);
    const c = fakeMap('de_inferno');
    fs.rmSync(path.join(c.outDir, 'shrink.json'));
    await expect(mapManifest('de_inferno', c.outDir, c.rawDir)).rejects.toThrow(/shrink\.json/);
  });

  test('a GLB whose size disagrees with shrink.json is an error (stale shrink.json)', async () => {
    const { rawDir, outDir } = fakeMap('de_mirage');
    fake(path.join(outDir, 'world.glb'), 3001);
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/world\.glb.*3001.*3000/);
  });

  test("world_lo.glb, when phone-tier.mjs built it, listed after world.glb with its record's texture size", async () => {
    const { rawDir, outDir } = fakeMap('de_mirage');
    fakePhone(outDir, 'world.glb', 'world_lo', 1800, 128);
    const m = await mapManifest('de_mirage', outDir, rawDir);
    expect(Object.keys(m)).toEqual(['map', 'schema', 'cs2Build', 'vrf', 'generated', 'files', 'world', 'lo', 'sections']);
    expect(Object.keys(m.files)).toEqual(['world.glb', 'world_lo.glb', 'hull.glb', 'radar.png', 'probes.bin', 'light.json', 'overview.json']);
    expect(m.files['world_lo.glb']).toEqual({ bytes: 1800, sha256: sha256(path.join(outDir, 'world_lo.glb')) });
    expect(m.lo).toEqual({ textureSize: 128 });
    expect(m.files).not.toHaveProperty('world_lo.json');
  });

  test('a phone tier made from another world.glb, of other bytes than its record, or without its record (or a record without it) is an error naming phone-tier.mjs', async () => {
    const { rawDir, outDir } = fakeMap('de_mirage');
    const lo = path.join(outDir, 'world_lo.glb');
    const record = path.join(outDir, 'world_lo.json');
    fakePhone(outDir, 'world.glb', 'world_lo', 1800, 128);
    fs.writeFileSync(path.join(outDir, 'world.glb'), Buffer.alloc(3000, 'rebuilt')); // shrink-map.mjs ran again
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/world_lo\.glb was made from another world\.glb.*phone-tier\.mjs de_mirage/);
    fakePhone(outDir, 'world.glb', 'world_lo', 1800, 128);
    fake(lo, 1801);
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/world_lo\.glb is 1801 bytes but .*world_lo\.json records 1800/);
    fakePhone(outDir, 'world.glb', 'world_lo', 1800, 128);
    fs.writeFileSync(lo, Buffer.alloc(1800, 'other'));
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/world_lo\.glb is not the file .*world_lo\.json records/);
    fakePhone(outDir, 'world.glb', 'world_lo', 1800, 128);
    fs.rmSync(record);
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/world_lo\.json is missing.*phone-tier\.mjs de_mirage/);
    fakePhone(outDir, 'world.glb', 'world_lo', 1800, 128);
    fs.rmSync(lo);
    await expect(mapManifest('de_mirage', outDir, rawDir)).rejects.toThrow(/world_lo\.glb is missing but .*world_lo\.json records it/);
    fs.rmSync(record);
    expect(await mapManifest('de_mirage', outDir, rawDir)).not.toHaveProperty('lo');
  });
});

/**
 * `<dir>/<name>.glb` (`n` bytes) and the record phone-tier.mjs writes beside it, `<name>.json`,
 * made from `<dir>/<from>` as it is now, at `size` px.
 */
function fakePhone(dir, from, name, n, size) {
  const glb = path.join(dir, `${name}.glb`);
  fake(glb, n);
  writeJson(path.join(dir, `${name}.json`), {
    file: `${name}.glb`, bytes: n, sha256: sha256(glb), gzBytes: Math.round(n / 2),
    source: { file: from, bytes: fs.statSync(path.join(dir, from)).size, sha256: sha256(path.join(dir, from)) },
    params: { size, format: 'webp', quality: 60 },
    textures: { count: 1, fitted: 1, copied: 0, maxSide: size, rgbaBytes: size * size * 4, sourceRgbaBytes: 4 * size * size * 4 },
  });
}

/** <root>/raw/players/rip.json and <root>/players/<side>.glb + <side>.shrink.json. */
function fakePlayers({ shrinkBuild = '2000934' } = {}) {
  const rawDir = path.join(root, 'raw', 'players');
  const outDir = path.join(root, 'players');
  writeJson(path.join(rawDir, 'rip.json'), {
    cs2Build: '2000934', vrfVersion: VRF, exportedAt: '2026-10-21T20:41:45Z',
    models: {
      ct: { vmdl: 'agents/models/ctm_sas/ctm_sas.vmdl_c', glb: 'ct/ctm_sas.glb' },
      t: { vmdl: 'agents/models/tm_phoenix/tm_phoenix.vmdl_c', glb: 't/tm_phoenix.glb' },
    },
  });
  const clips = ['crouch_n_rifle', 'idle_crouch_rifle', 'idle_rifle', 'inair_stand_rifle', 'run_n_rifle', 'walk_n_rifle'];
  for (const [side, n] of [['ct', 900], ['t', 800]]) {
    fake(path.join(outDir, `${side}.glb`), n);
    fake(path.join(outDir, `${side}.glb.gz`), Math.round(n / 2));
    writeJson(path.join(outDir, `${side}.shrink.json`), { side, clips, bytes: n, gzBytes: Math.round(n / 2), raw: { cs2Build: shrinkBuild, vrfVersion: VRF } });
  }
  return { rawDir, outDir, clips };
}

describe('playersManifest', () => {
  test('model short names, clips, bytes and sha256 per side', async () => {
    const { rawDir, outDir, clips } = fakePlayers();
    const m = await playersManifest(outDir, rawDir);
    expect(Object.keys(m)).toEqual(['schema', 'cs2Build', 'vrf', 'generated', 'ct', 't']);
    expect(m).toMatchObject({ schema: 1, cs2Build: '2000934', vrf: '20.0.6980' });
    expect(m.generated).toMatch(ISO_SECONDS);
    const glb = (side) => path.join(outDir, `${side}.glb`);
    const gz = (side) => `${glb(side)}.gz`;
    expect(m.ct).toEqual({ model: 'ctm_sas', clips, bytes: 900, sha256: sha256(glb('ct')), gz: { bytes: 450, sha256: sha256(gz('ct')) } });
    expect(m.t).toEqual({ model: 'tm_phoenix', clips, bytes: 800, sha256: sha256(glb('t')), gz: { bytes: 400, sha256: sha256(gz('t')) } });
  });

  test('a shrink.json from another rip is an error', async () => {
    const { rawDir, outDir } = fakePlayers({ shrinkBuild: '1999999' });
    await expect(playersManifest(outDir, rawDir)).rejects.toThrow(/1999999.*2000934/);
  });

  test("a side's phone tier, when phone-tier.mjs built it, as `lo` with its file, texture size, bytes, sha256 and gz", async () => {
    const { rawDir, outDir } = fakePlayers();
    fakePhone(outDir, 'ct.glb', 'ct_lo', 600, 512);
    fake(path.join(outDir, 'ct_lo.glb.gz'), 300);
    const m = await playersManifest(outDir, rawDir);
    const lo = path.join(outDir, 'ct_lo.glb');
    expect(m.ct.lo).toEqual({ file: 'ct_lo.glb', textureSize: 512, bytes: 600, sha256: sha256(lo), gz: { bytes: 300, sha256: sha256(`${lo}.gz`) } });
    expect(Object.keys(m.ct)).toEqual(['model', 'clips', 'bytes', 'sha256', 'gz', 'lo']);
    expect(m.t).not.toHaveProperty('lo'); // the `low` preset loads t.glb
  });

  test('a phone tier without its .gz, or made from another <side>.glb, is an error naming phone-tier.mjs players', async () => {
    const { rawDir, outDir } = fakePlayers();
    fakePhone(outDir, 't.glb', 't_lo', 600, 512);
    await expect(playersManifest(outDir, rawDir)).rejects.toThrow(/t_lo\.glb\.gz is missing.*phone-tier\.mjs players/);
    fake(path.join(outDir, 't_lo.glb.gz'), 300);
    fs.writeFileSync(path.join(outDir, 't.glb'), Buffer.alloc(800, 'rebuilt'));
    await expect(playersManifest(outDir, rawDir)).rejects.toThrow(/t_lo\.glb was made from another t\.glb.*phone-tier\.mjs players/);
  });
});

describe('rootManifest', () => {
  test('built from the per-map manifests that exist, plus the players build', async () => {
    for (const map of ['de_nuke', 'de_mirage']) {
      const { rawDir, outDir } = fakeMap(map, map === 'de_nuke' ? { sections: ['default', 'lower'], images: ['radar.png', 'radar_lower.png'] } : {});
      writeJson(path.join(outDir, 'manifest.json'), await mapManifest(map, outDir, rawDir));
    }
    fs.mkdirSync(path.join(root, 'maps', 'de_dust2'), { recursive: true }); // no manifest: not listed
    const { rawDir, outDir } = fakePlayers();
    writeJson(path.join(outDir, 'manifest.json'), await playersManifest(outDir, rawDir));

    const w = fakeWeapons();
    writeJson(path.join(w.outDir, 'manifest.json'), await weaponsManifest(w.outDir, w.rawDir));

    const v = fakeViewmodels();
    writeJson(path.join(v.outDir, 'manifest.json'), await viewmodelsManifest(v.outDir, v.rawDir));

    const e = fakeEffects();
    const em = await effectsManifest(e.outDir, e.rawDir);
    writeJson(path.join(e.outDir, 'manifest.json'), em);

    const s = fakeSounds();
    writeJson(path.join(s.outDir, 'manifest.json'), await soundsManifest(s.outDir, s.rawDir));

    const m = await rootManifest(root);
    expect(Object.keys(m)).toEqual(['schema', 'generated', 'maps', 'players', 'weapons', 'viewmodels', 'effects', 'sounds']);
    expect(m.sounds).toEqual({ cs2Build: '2000935', banks: 2 });
    expect(m.effects).toEqual({ cs2Build: '2000935', count: EFFECT_KEYS.length, bytes: Object.values(em.atlases).reduce((n, a) => n + a.bytes, 0) });
    expect(m.weapons).toEqual({ cs2Build: '2000934', count: MODEL_NAMES.length });
    expect(m.viewmodels).toEqual({ cs2Build: '2000934', arms: ['ct', 't'], count: WEAPON_NAMES.length });
    expect(m.schema).toBe(1);
    expect(m.generated).toMatch(ISO_SECONDS);
    expect(Object.keys(m.maps)).toEqual(['de_mirage', 'de_nuke']);
    const total = (map) => Object.values(JSON.parse(fs.readFileSync(path.join(root, 'maps', map, 'manifest.json'), 'utf8')).files)
      .reduce((n, f) => n + f.bytes, 0);
    expect(m.maps.de_mirage).toEqual({ cs2Build: '2000934', bytes: total('de_mirage'), sections: ['default'] });
    expect(m.maps.de_nuke).toEqual({ cs2Build: '2000934', bytes: total('de_nuke'), sections: ['default', 'lower'] });
    expect(m.players).toEqual({ cs2Build: '2000934' });
  });

  test('no maps and no players manifest: empty maps, players null', async () => {
    expect(await rootManifest(root)).toMatchObject({ schema: 1, maps: {}, players: null, weapons: null, viewmodels: null, effects: null, sounds: null });
  });
});

describe('CLI', () => {
  const run = (...args) => spawnSync(process.execPath, [MANIFEST_MJS, ...args], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });
  const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));

  test('<map>, players and root write their manifest.json under ASSETS_DIR', () => {
    fakeMap('de_mirage');
    fakePlayers();
    for (const arg of ['de_mirage', 'players', 'root']) {
      const r = run(arg);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    }
    const read = (...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));
    expect(read('maps', 'de_mirage', 'manifest.json')).toMatchObject({ map: 'de_mirage', sections: ['default'] });
    expect(read('players', 'manifest.json')).toMatchObject({ ct: { model: 'ctm_sas' } });
    expect(Object.keys(read('manifest.json').maps)).toEqual(['de_mirage']);
    expect(leftovers(path.join(root, 'maps', 'de_mirage'))).toEqual([]);
    expect(leftovers(root)).toEqual([]);
  });

  test('a map that cannot be described exits 1 and leaves the old manifest; usage errors exit 1', () => {
    const { outDir } = fakeMap('de_mirage', { skip: ['world.glb'] });
    const r = run('de_mirage');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^manifest: .*world\.glb/);
    expect(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).toBe('{"stale": true}\n');
    expect(run().status).toBe(1);
    expect(run('de_mirage', 'extra').status).toBe(1);
    expect(run('De Mirage').status).toBe(1);
  });

  test('sounds writes manifest.json and a manifest.json.gz of the same bytes; a refused one leaves both as they were', () => {
    const { outDir } = fakeSounds();
    const r = run('sounds');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^manifest: .*sounds\/manifest\.json: 2 banks, /);
    const json = fs.readFileSync(path.join(outDir, 'manifest.json'));
    expect(JSON.parse(json)).toMatchObject({ banks: { weapon_ak47: { bytes: 630 } } });
    expect(zlib.gunzipSync(fs.readFileSync(path.join(outDir, 'manifest.json.gz')))).toEqual(json);
    expect(leftovers(outDir)).toEqual([]);

    fake(path.join(outDir, 'weapon_ak47.webm'), 7);
    const refused = run('sounds');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^manifest: .*weapon_ak47\.webm is 7 bytes/);
    expect(fs.readFileSync(path.join(outDir, 'manifest.json'))).toEqual(json);
    expect(zlib.gunzipSync(fs.readFileSync(path.join(outDir, 'manifest.json.gz')))).toEqual(json);
    expect(leftovers(outDir)).toEqual([]);
  });
});

function fakeWeapons({ shrinkBuild = '2000934', skip = [] } = {}) {
  const rawDir = path.join(root, 'raw', 'weapons');
  const outDir = path.join(root, 'weapons');
  const models = {};
  for (const name of MODEL_NAMES) models[name] = { vmdl: MODEL_PATHS[name], glb: `${name}/${path.basename(MODEL_PATHS[name], '.vmdl_c')}.glb` };
  writeJson(path.join(rawDir, 'rip.json'), { cs2Build: '2000934', vrfVersion: VRF, exportedAt: '2026-10-22T06:00:00Z', models });
  let n = 50;
  for (const name of MODEL_NAMES) {
    n += 7;
    if (!skip.includes(`${name}.glb`)) fake(path.join(outDir, `${name}.glb`), n);
    if (!skip.includes(`${name}.glb.gz`)) fake(path.join(outDir, `${name}.glb.gz`), n - 20);
    if (!skip.includes(`${name}.shrink.json`)) {
      writeJson(path.join(outDir, `${name}.shrink.json`), { name, trisOut: 1000 + n, bytes: n, gzBytes: n - 20, raw: { cs2Build: shrinkBuild, vrfVersion: VRF } });
    }
  }
  return { rawDir, outDir };
}

/** <root>/raw/viewmodels/rip.json and <root>/viewmodels/ with both arms and every weapon's clips. */
function fakeViewmodels({ shrinkBuild = '2000934', armsBuild = '2000934', skip = [] } = {}) {
  const rawDir = path.join(root, 'raw', 'viewmodels');
  const outDir = path.join(root, 'viewmodels');
  writeJson(path.join(rawDir, 'rip.json'), { cs2Build: '2000934', vrfVersion: VRF, exportedAt: '2026-10-22T19:00:00Z', dirs: {} });
  const file = (base, n, shrink) => {
    if (!skip.includes(`${base}.glb`)) fake(path.join(outDir, `${base}.glb`), n);
    if (!skip.includes(`${base}.glb.gz`)) fake(path.join(outDir, `${base}.glb.gz`), n - 20);
    writeJson(path.join(outDir, `${base}.shrink.json`), { bytes: n, gzBytes: n - 20, ...shrink });
  };
  file('arms_ct', 900, { model: 'agents/models/ctm_sas/ctm_sas.vmdl_c', raw: { cs2Build: '2000934', viewmodelsBuild: armsBuild } });
  file('arms_t', 800, { model: 'agents/models/tm_phoenix/tm_phoenix.vmdl_c', raw: { cs2Build: '2000934', viewmodelsBuild: armsBuild } });
  let n = 50;
  for (const name of WEAPON_NAMES) {
    n += 3;
    file(name, n, { name, dir: VIEWMODEL_DIRS[name], clips: { shoot: {}, idle: {}, draw: {} }, raw: { cs2Build: shrinkBuild, vrfVersion: VRF } });
  }
  return { rawDir, outDir };
}

describe('viewmodelsManifest', () => {
  test('both arms and one entry per weapon with its folder, sorted clips, bytes, sha256 and gz', async () => {
    const { rawDir, outDir } = fakeViewmodels();
    const m = await viewmodelsManifest(outDir, rawDir);
    expect(Object.keys(m)).toEqual(['schema', 'cs2Build', 'vrf', 'generated', 'arms', 'weapons']);
    expect(m).toMatchObject({ schema: 1, cs2Build: '2000934', vrf: '20.0.6980' });
    const at = (f) => path.join(outDir, f);
    expect(m.arms.ct).toEqual({ model: 'ctm_sas', bytes: 900, sha256: sha256(at('arms_ct.glb')), gz: { bytes: 880, sha256: sha256(at('arms_ct.glb.gz')) } });
    expect(m.arms.t.model).toBe('tm_phoenix');
    expect(Object.keys(m.weapons)).toEqual([...WEAPON_NAMES]);
    expect(m.weapons.m4a1s).toMatchObject({ dir: 'rifle/_default_rifle', clips: ['draw', 'idle', 'shoot'], sha256: sha256(at('m4a1s.glb')) });
    expect(m.weapons.ak47.gz).toEqual({ bytes: m.weapons.ak47.bytes - 20, sha256: sha256(at('ak47.glb.gz')) });
  });

  test('stale or missing files are errors naming them', async () => {
    let v = fakeViewmodels({ shrinkBuild: '1999999' });
    await expect(viewmodelsManifest(v.outDir, v.rawDir)).rejects.toThrow(/1999999.*2000934/);
    fs.rmSync(root, { recursive: true, force: true });
    v = fakeViewmodels({ armsBuild: '1999999' });
    await expect(viewmodelsManifest(v.outDir, v.rawDir)).rejects.toThrow(/arms_ct.*1999999/);
    fs.rmSync(root, { recursive: true, force: true });
    v = fakeViewmodels({ skip: ['usp.glb.gz'] });
    await expect(viewmodelsManifest(v.outDir, v.rawDir)).rejects.toThrow(/usp\.glb\.gz/);
    fake(path.join(v.outDir, 'usp.glb.gz'), 10);
    fake(path.join(v.outDir, 'usp.glb'), 7);
    await expect(viewmodelsManifest(v.outDir, v.rawDir)).rejects.toThrow(/usp\.glb is 7 bytes/);
  });
});

describe('weaponsManifest', () => {
  test('one entry per model (the weapons and the kit) with model, tris, bytes, sha256 and the gz sibling', async () => {
    const { rawDir, outDir } = fakeWeapons();
    const m = await weaponsManifest(outDir, rawDir);
    expect(Object.keys(m)).toEqual(['schema', 'cs2Build', 'vrf', 'generated', 'weapons']);
    expect(m).toMatchObject({ schema: 1, cs2Build: '2000934', vrf: '20.0.6980' });
    expect(Object.keys(m.weapons)).toEqual([...MODEL_NAMES]);
    expect(m.weapons.defuser.model).toBe('defuser');
    const glb = path.join(outDir, 'ak47.glb');
    expect(m.weapons.ak47).toEqual({
      model: 'weapon_rif_ak47', tris: 1000 + fs.statSync(glb).size, bytes: fs.statSync(glb).size, sha256: sha256(glb),
      gz: { bytes: fs.statSync(`${glb}.gz`).size, sha256: sha256(`${glb}.gz`) },
    });
  });

  test('a missing GLB, gz or shrink.json, or one from another rip, is an error naming the fix', async () => {
    for (const [skip, re] of [['awp.glb', /awp\.glb is missing/], ['awp.glb.gz', /awp\.glb\.gz is missing/], ['awp.shrink.json', /awp\.shrink\.json/], ['defuser.glb', /defuser\.glb is missing/]]) {
      const { rawDir, outDir } = fakeWeapons({ skip: [skip] });
      await expect(weaponsManifest(outDir, rawDir)).rejects.toThrow(re);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    const { rawDir, outDir } = fakeWeapons({ shrinkBuild: '1999999' });
    await expect(weaponsManifest(outDir, rawDir)).rejects.toThrow(/made from CS2 build 1999999/);
  });
});

/** <root>/raw/effects/rip.json and <root>/effects/ with a fake atlas per key and its build.json. */
function fakeEffects({ buildBuild = '2000935', skip = [] } = {}) {
  const rawDir = path.join(root, 'raw', 'effects');
  const outDir = path.join(root, 'effects');
  writeJson(path.join(rawDir, 'rip.json'), { cs2Build: '2000935', vrfVersion: '20.1.7467+9e2e6c7f', exportedAt: '2026-10-22T19:00:00Z', files: {} });
  const atlases = {};
  let n = 100;
  for (const key of EFFECT_KEYS) {
    n += 11;
    if (!skip.includes(`${key}.webp`)) fake(path.join(outDir, `${key}.webp`), n);
    atlases[key] = { file: `${key}.webp`, bytes: n, width: 1024, height: 128, cell: [64, 64], cols: 16, rows: 2, frames: 20, sequences: [[0, 12], [12, 8]], quality: 80 };
  }
  writeJson(path.join(outDir, 'build.json'), { cs2Build: buildBuild, vrfVersion: '20.1.7467+9e2e6c7f', atlases });
  return { rawDir, outDir };
}

describe('effectsManifest', () => {
  test('one atlas per key with its file, bytes, sha256, size, grid and sequences', async () => {
    const { rawDir, outDir } = fakeEffects();
    const m = await effectsManifest(outDir, rawDir);
    expect(Object.keys(m)).toEqual(['schema', 'cs2Build', 'vrf', 'generated', 'atlases']);
    expect(m).toMatchObject({ schema: 1, cs2Build: '2000935', vrf: '20.1.7467' });
    expect(Object.keys(m.atlases)).toEqual(EFFECT_KEYS);
    expect(m.atlases.fire).toEqual({
      file: 'fire.webp', bytes: 111, sha256: sha256(path.join(outDir, 'fire.webp')), width: 1024, height: 128,
      cell: [64, 64], cols: 16, frames: 20, sequences: [[0, 12], [12, 8]],
    });
  });

  test('a missing atlas, or a build.json from another rip or of other bytes, is an error naming the fix', async () => {
    let e = fakeEffects({ skip: ['smoke.webp'] });
    await expect(effectsManifest(e.outDir, e.rawDir)).rejects.toThrow(/smoke\.webp is missing.*build-effects/);
    fs.rmSync(root, { recursive: true, force: true });
    e = fakeEffects({ buildBuild: '1999999' });
    await expect(effectsManifest(e.outDir, e.rawDir)).rejects.toThrow(/1999999.*2000935/);
    fs.rmSync(root, { recursive: true, force: true });
    e = fakeEffects();
    fake(path.join(e.outDir, 'dust.webp'), 7);
    await expect(effectsManifest(e.outDir, e.rawDir)).rejects.toThrow(/dust\.webp is 7 bytes/);
  });
});

const SOUNDS_VRF = '20.1.7467+9e2e6c7f';

/**
 * <root>/raw/sounds/rip.json and <root>/sounds/ with two fake banks and the build.json that
 * describes them (two sounds, a few surfaces), as build-sounds.mjs writes it.
 */
function fakeSounds({ buildBuild = '2000935', buildVrf = SOUNDS_VRF, skip = [] } = {}) {
  const rawDir = path.join(root, 'raw', 'sounds');
  const outDir = path.join(root, 'sounds');
  writeJson(path.join(rawDir, 'rip.json'), { cs2Build: '2000935', vrfVersion: SOUNDS_VRF, exportedAt: '2026-10-25T21:00:00Z', absent: [] });
  const banks = { steps_concrete: { bytes: 720, seconds: 10.5022, clips: 21 }, weapon_ak47: { bytes: 630, seconds: 11.3729, clips: 7 } };
  for (const [bank, b] of Object.entries(banks)) if (!skip.includes(`${bank}.webm`)) fake(path.join(outDir, `${bank}.webm`), b.bytes);
  const layer = (clips, offset) => ({
    clips, volume: 1, volumeRandom: [0, 0], pitch: 1, pitchRandom: [-0.02, 0.02], curve: [[30, 1], [2500, 0.015]], offset, loop: false,
  });
  const sounds = {
    'shot:ak47': { bank: 'weapon_ak47', layers: [layer([[0, 1.9429], [1.9929, 2.1562]], [0, 0, 60]), layer([[6.3724, 3.8978]], [0, 0, 60])] },
    'step:concrete:ct': { bank: 'steps_concrete', layers: [layer([[0, 0.4], [0.45, 0.39]], [0, 0, 20])] },
  };
  const surfaces = { concrete: 'concrete', default: 'default', plaster: 'concrete', vrf_unknown_key_2838185980: 'metalrailing' };
  writeJson(path.join(outDir, 'build.json'), {
    raw: { cs2Build: buildBuild, vrf: buildVrf },
    params: { rate: 48000, bitrate: '48k', gapS: 0.05, tailDb: -80 },
    banks, sounds, surfaces, missing: [],
  });
  return { rawDir, outDir, sounds, surfaces };
}

describe('soundsManifest', () => {
  test('one entry per bank with its bytes, sha256 and seconds; the sounds and surfaces as built', async () => {
    const { rawDir, outDir, sounds, surfaces } = fakeSounds();
    const m = await soundsManifest(outDir, rawDir);
    expect(Object.keys(m)).toEqual(['schema', 'cs2Build', 'vrf', 'generated', 'banks', 'sounds', 'surfaces']);
    expect(m).toMatchObject({ schema: 1, cs2Build: '2000935', vrf: '20.1.7467' });
    expect(m.generated).toMatch(ISO_SECONDS);
    expect(m.banks).toEqual({
      steps_concrete: { bytes: 720, sha256: sha256(path.join(outDir, 'steps_concrete.webm')), seconds: 10.5022 },
      weapon_ak47: { bytes: 630, sha256: sha256(path.join(outDir, 'weapon_ak47.webm')), seconds: 11.3729 },
    });
    expect(m.banks.steps_concrete.sha256).not.toBe(m.banks.weapon_ak47.sha256);
    expect(m.sounds).toEqual(sounds);
    expect(m.surfaces).toEqual(surfaces);
  });

  test('a bank of other bytes, a missing bank, a sound in no bank, or a build.json from another rip is an error naming the fix', async () => {
    const again = (opts) => {
      fs.rmSync(root, { recursive: true, force: true });
      return fakeSounds(opts);
    };
    let s = fakeSounds();
    fake(path.join(s.outDir, 'weapon_ak47.webm'), 7);
    await expect(soundsManifest(s.outDir, s.rawDir)).rejects.toThrow(/weapon_ak47\.webm is 7 bytes but .*build\.json records 630; rerun tools\/build-sounds\.mjs/);
    s = again({ skip: ['steps_concrete.webm'] });
    await expect(soundsManifest(s.outDir, s.rawDir)).rejects.toThrow(/steps_concrete\.webm is missing; run tools\/build-sounds\.mjs/);
    s = again({ buildBuild: '1999999' });
    await expect(soundsManifest(s.outDir, s.rawDir)).rejects.toThrow(/1999999.*2000935.*build-sounds/);
    s = again({ buildVrf: '20.0.6980+a06886f7' });
    await expect(soundsManifest(s.outDir, s.rawDir)).rejects.toThrow(/20\.0\.6980.*20\.1\.7467.*build-sounds/);
    s = again();
    const built = JSON.parse(fs.readFileSync(path.join(s.outDir, 'build.json'), 'utf8'));
    built.sounds['bomb:plant'] = { bank: 'bomb', layers: [] };
    writeJson(path.join(s.outDir, 'build.json'), built);
    await expect(soundsManifest(s.outDir, s.rawDir)).rejects.toThrow(/bomb:plant.*bank bomb.*build-sounds/);
    s = again();
    fs.rmSync(path.join(s.outDir, 'build.json'));
    await expect(soundsManifest(s.outDir, s.rawDir)).rejects.toThrow(/build\.json is missing; run tools\/build-sounds\.mjs/);
    fs.rmSync(path.join(s.rawDir, 'rip.json'));
    await expect(soundsManifest(s.outDir, s.rawDir)).rejects.toThrow(/rip\.json is missing; run tools\/rip-sounds\.sh/);
  });
});
