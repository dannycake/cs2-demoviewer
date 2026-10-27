// shrink-map.mjs as build-assets.sh runs it, against a synthetic raw world in a temp ASSETS_DIR:
// a map in LIGHTMAP_MAPS that cannot bake stops before anything is read or written, and a map
// outside it builds the AO world (and no world_hd.glb, which retired with the HD toggle).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createIO, countTris } from '../lib/gltf.mjs';
import { LIGHTMAP_MAPS } from '../lib/maps.mjs';

const SHRINK_MAP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shrink-map.mjs');
/** A map on LIGHTMAP_MAPS (every map the pipeline builds), and one outside it. */
const BAKED = 'de_mirage';
const UNBAKED = 'de_test';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-map-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const raw = (map, ...f) => path.join(root, 'raw', map, ...f);
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

/**
 * A raw world as VRF exports one: a 4 m floor (8×8 quads) and a 1 m box on it, one textured
 * material with its vmat extras. Written as world.glb and, with the material gone, as
 * world_collision.glb.
 */
async function rawWorld(map) {
  const io = await createIO();
  const make = async (textured) => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    let material = null;
    if (textured) {
      const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 140, g: 110, b: 80 } } }).png().toBuffer();
      material = doc.createMaterial('floor')
        .setExtras({ vmat: { Name: 'materials/test/floor.vmat', ShaderName: 'csgo_environment.vfx' } })
        .setBaseColorTexture(doc.createTexture('floor').setImage(png).setMimeType('image/png'));
    }
    const mesh = (name, pos, idx) => {
      const p = doc.createPrimitive()
        .setAttribute('POSITION', acc('VEC3', new Float32Array(pos)))
        .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(pos.flatMap((v, i) => (i % 3 === 1 ? [] : [v / 4 + 0.5])))))
        .setIndices(acc('SCALAR', new Uint32Array(idx)))
        .setMaterial(material);
      return doc.createMesh(name).addPrimitive(p);
    };
    const fpos = [], fidx = [];
    for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) fpos.push(-2 + i * 0.5, 0, -2 + j * 0.5);
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const a = j * 9 + i;
      fidx.push(a, a + 9, a + 1, a + 1, a + 9, a + 10);
    }
    const bpos = [], bidx = [];
    for (const [ax, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
      const u = (ax + 1) % 3, v = (ax + 2) % 3, base = bpos.length / 3;
      for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = [0, 0, 0]; p[ax] = 0.5 * s; p[u] = 0.5 * du; p[v] = 0.5 * dv; bpos.push(...p);
      }
      if (s > 0) bidx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else bidx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const scene = doc.createScene();
    scene.addChild(doc.createNode('floor').setMesh(mesh('floor', fpos, fidx)));
    scene.addChild(doc.createNode('box').setTranslation([0, 0.5, 0]).setMesh(mesh('box', bpos, bidx)));
    return io.writeBinary(doc);
  };
  write(raw(map, 'world.glb'), await make(true));
  write(raw(map, 'world_collision.glb'), await make(false));
}

/** Files that only a gate failing before the read leaves alone: world.glb is not a GLB at all. */
const unreadable = (map) => {
  write(raw(map, 'world.glb'), 'not read');
  write(raw(map, 'world_collision.glb'), 'not read');
};

const SUN = '====0====\nbakedshadowindex "0"\nenabled true\ncolor [ 255, 255, 255 ]\nbrightness 2.0\ndirectlight "1"\nclassname "light_environment"\nangles [ 60.0, 0.0, 0.0 ]\n';
const WHOLE = ['irradiance', 'env_light_probe_volume_atlas', 'env_light_probe_volume_atlas_dlshd', 'debug_chart_color', 'direct_light_shadows'];

const shrink = (map) => spawnSync(process.execPath, [SHRINK_MAP, map], { cwd: root, env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });

test('a map in LIGHTMAP_MAPS that cannot bake fails before anything is read or written, naming why and the way out', () => {
  expect(LIGHTMAP_MAPS).toContain(BAKED);
  unreadable(BAKED);
  // No entity lump, so neither a sun nor probe volumes.
  let r = shrink(BAKED);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/^shrink-map: de_mirage cannot bake: no entity lump .*It is in LIGHTMAP_MAPS \(tools\/lib\/maps\.mjs\), so it ships CS2's baked light, not AO; .*take it off LIGHTMAP_MAPS to build it with AO/);
  // rip-lighting.sh's record of a VPK without baked light (what it writes for a map off the list).
  write(raw(BAKED, 'entities', 'default_ents.vents'), SUN);
  write(raw(BAKED, 'lightmaps', 'lightmaps.json'), JSON.stringify({ map: BAKED, sunBaked: true, textures: [] }));
  r = shrink(BAKED);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/de_mirage cannot bake: no whole lightmaps export in raw\/de_mirage\/lightmaps \(tools\/rip-lighting\.sh\)\. It is in LIGHTMAP_MAPS/);
  // A whole export, but the entity lump has no light probe volumes.
  write(raw(BAKED, 'lightmaps', 'lightmaps.json'), JSON.stringify({ map: BAKED, sunBaked: true, textures: WHOLE }));
  r = shrink(BAKED);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/de_mirage cannot bake: the map has no light probe volumes\. It is in LIGHTMAP_MAPS/);
  expect(r.stdout).toBe('');
  expect(fs.existsSync(path.join(root, 'maps'))).toBe(false);
});

test("a lightmaps.json that does not parse stops the map before anything is read or written, with shrink-map's message, not a stack", () => {
  unreadable(BAKED);
  write(raw(BAKED, 'entities', 'default_ents.vents'), SUN);
  write(raw(BAKED, 'lightmaps', 'lightmaps.json'), '{"map": "de_mirage", "textures": [');
  const r = shrink(BAKED);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/^shrink-map: .*JSON/);
  expect(r.stderr).not.toMatch(/^\s+at /m);
  expect(r.stderr.trim().split('\n')).toHaveLength(1);
  expect(fs.existsSync(path.join(root, 'maps'))).toBe(false);
});

test('a map outside LIGHTMAP_MAPS builds the AO world, its hull and shrink.json, saying why there is no bake; no world_hd.glb', async () => {
  expect(LIGHTMAP_MAPS).not.toContain(UNBAKED);
  await rawWorld(UNBAKED);
  // The HD world of a build before it retired goes; the radar beside it stays.
  const out = path.join(root, 'maps', UNBAKED);
  for (const f of ['world_hd.glb', 'world_hd.glb.gz', 'radar.png']) write(path.join(out, f), 'earlier');
  const r = shrink(UNBAKED);
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/no bake: de_test is not in LIGHTMAP_MAPS; AO in COLOR_0 as before/);
  expect(r.stdout).not.toMatch(/world_hd|1024 px/);
  expect(fs.readdirSync(out).sort()).toEqual(['hull.glb', 'hull.glb.gz', 'radar.png', 'shrink.json', 'world.glb', 'world.glb.gz']);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'shrink.json'), 'utf8'));
  expect(report).toMatchObject({ map: UNBAKED, bake: null, bakeSkipped: 'de_test is not in LIGHTMAP_MAPS', trisIn: 140 });
  expect(Object.keys(report.bytes)).toEqual(['world', 'hull']);
  expect(Object.keys(report.gzBytes)).toEqual(['world', 'hull']);
  expect(report.params).not.toHaveProperty('worldHd');
  expect(Object.keys(report.stages).filter((k) => k.startsWith('world'))).toEqual(['world']);
  expect(report.aoVertices).toBeGreaterThan(0);
  expect(report.bytes.world).toBe(fs.statSync(path.join(out, 'world.glb')).size);
  const world = await (await createIO()).read(path.join(out, 'world.glb'));
  expect(countTris(world)).toBeGreaterThan(0);
  for (const p of world.getRoot().listMeshes().flatMap((m) => m.listPrimitives())) expect(p.getAttribute('COLOR_0')).not.toBeNull();
});
