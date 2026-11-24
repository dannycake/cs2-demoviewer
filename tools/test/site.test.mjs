// The site kind: the rank icons and the Steam logo the site shows, the chicken the homepage
// video is rendered with, and the homepage video once tools/home-video.sh made it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KINDS } from '../lib/kinds.mjs';
import { CHICKEN_RAW, MAP_STRIP, RANK_KEYS, sitePaths } from '../lib/site.mjs';
import { buildSite } from '../build-site.mjs';
import { shrinkChicken } from '../shrink-chicken.mjs';
import { Document, NodeIO } from '@gltf-transform/core';
import { siteManifest } from '../manifest.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vi.setConfig({ testTimeout: 60_000 });

let root;
let P;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-test-'));
  P = sitePaths(root);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A raw export like rip-site.sh's: 20 icons, the logo, rip.json. */
async function ripped() {
  const icons = path.join(P.raw, 'panorama/images/econ/status_icons');
  fs.mkdirSync(icons, { recursive: true });
  const png = await sharp({ create: { width: 200, height: 80, channels: 4, background: { r: 200, g: 30, b: 60, alpha: 0.8 } } }).png().toBuffer();
  for (const key of RANK_KEYS) fs.writeFileSync(path.join(icons, `skillgroup${key === 'none' ? '_none' : key}_png.png`), png);
  fs.mkdirSync(path.join(P.raw, 'panorama/images/icons/ui'), { recursive: true });
  fs.writeFileSync(path.join(P.raw, 'panorama/images/icons/ui/steam_logo_white.svg'), '<svg width="32" height="33" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z" fill="white"/></svg>\n');
  fs.writeFileSync(path.join(P.raw, 'rip.json'), JSON.stringify({ cs2Build: '2000935', vrfVersion: '20.1+abc', exportedAt: '2026-10-27T00:00:00Z' }));
}

/** A map's hero.png as tools/hero.sh writes it: 1200×630, here noise over a colour. */
async function hero(map, seed = 0) {
  const dir = path.join(P.maps, map);
  fs.mkdirSync(dir, { recursive: true });
  const png = await sharp({
    create: { width: 1200, height: 630, channels: 3, background: { r: 120 + seed, g: 90, b: 60 }, noise: { type: 'gaussian', mean: 120 + seed, sigma: 40 } },
  }).png().toBuffer();
  fs.writeFileSync(path.join(dir, 'hero.png'), png);
}

const checkSite = () => spawnSync(process.execPath, [path.join(TOOLS, 'check-site.mjs')], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });

describe('the site kind', () => {
  test('lists the site kind last, after the sounds', () => {
    expect(KINDS.at(-1).name).toBe('site');
    expect(KINDS.at(-2).name).toBe('sounds');
    expect(KINDS.at(-1).steps.map(([s]) => s)).toEqual(['rip-site.sh', 'build-site.mjs', 'shrink-chicken.mjs']);
  });

  test('builds a manifest of 20 rank icons and the logo, home null without a video', async () => {
    await ripped();
    await buildSite(P);
    const m = await siteManifest(P.out, P.raw);
    expect(Object.keys(m.ranks).sort()).toEqual([...RANK_KEYS].sort());
    expect(Object.keys(m.ranks)).toHaveLength(20);
    expect(m.ranks['7']).toMatchObject({ file: 'ranks/skillgroup7.webp', bytes: fs.statSync(path.join(P.out, 'ranks/skillgroup7.webp')).size });
    expect(m.ranks['7'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.ranks.none.file).toBe('ranks/skillgroup_none.webp');
    expect(m.steamLogo.file).toBe('steam-logo.svg');
    expect(m.home).toBeNull();
    expect(m.maps).toEqual({});
    expect(m.vrf).toBe('20.1');
    expect(m.cs2Build).toBe('2000935');
    expect((await sharp(path.join(P.out, 'ranks/skillgroup7.webp')).metadata()).format).toBe('webp');
  });

  test('lists the home video once its three files exist', async () => {
    await ripped();
    await buildSite(P);
    fs.mkdirSync(path.join(P.out, 'home'), { recursive: true });
    fs.writeFileSync(path.join(P.out, 'home/hero.mp4'), 'mp4');
    fs.writeFileSync(path.join(P.out, 'home/hero.webm'), 'webm');
    expect((await siteManifest(P.out, P.raw)).home).toBeNull();
    fs.writeFileSync(path.join(P.out, 'home/poster.jpg'), 'jpg');
    const { home } = await siteManifest(P.out, P.raw);
    expect(home.mp4).toMatchObject({ file: 'home/hero.mp4', bytes: 3 });
    expect(home.webm.file).toBe('home/hero.webm');
    expect(home.poster.file).toBe('home/poster.jpg');
    // A rebuild of the icons leaves the video alone.
    await buildSite(P);
    expect(fs.existsSync(path.join(P.out, 'home/hero.mp4'))).toBe(true);
  });

  test('check-site fails when an icon is missing', async () => {
    await ripped();
    await buildSite(P);
    fs.mkdirSync(P.raw, { recursive: true });
    fs.writeFileSync(path.join(P.raw, 'chicken.glb'), Buffer.alloc(600_000));
    const check = () => spawnSync(process.execPath, [path.join(TOOLS, 'check-site.mjs')], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });
    const ok = check();
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    fs.rmSync(path.join(P.out, 'ranks/skillgroup12.webp'));
    const missing = check();
    expect(missing.status).not.toBe(0);
    expect(missing.stdout + missing.stderr).toMatch(/skillgroup12/);
  });

  test("builds a strip of each map's hero.png, listed with its sha256; a map without one has none", async () => {
    await ripped();
    await hero('de_nuke');
    await hero('de_mirage', 20);
    fs.mkdirSync(path.join(P.maps, 'de_cache'), { recursive: true });
    const built = await buildSite(P);
    expect(Object.keys(built.maps)).toEqual(['de_mirage', 'de_nuke']);
    const file = path.join(P.out, 'maps/de_nuke.webp');
    const meta = await sharp(file).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', MAP_STRIP.width, MAP_STRIP.height]);
    expect(MAP_STRIP.width / MAP_STRIP.height).toBeGreaterThanOrEqual(4);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(MAP_STRIP.budget);
    const m = await siteManifest(P.out, P.raw);
    expect(Object.keys(m.maps)).toEqual(['de_mirage', 'de_nuke']);
    expect(m.maps.de_nuke).toEqual({ file: 'maps/de_nuke.webp', bytes: fs.statSync(file).size, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(KINDS.at(-1).root(m)).toMatchObject({ ranks: 20, maps: 2 });
    expect(KINDS.at(-1).rootLine(KINDS.at(-1).root(m))).toMatch(/2 map strips/);
    // The same hero.png makes the same bytes.
    const before = fs.readFileSync(file);
    await buildSite(P);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  test("a map's strip goes with its hero.png", async () => {
    await ripped();
    await hero('de_nuke');
    await hero('de_anubis');
    await buildSite(P);
    fs.rmSync(path.join(P.maps, 'de_anubis/hero.png'));
    const built = await buildSite(P);
    expect(Object.keys(built.maps)).toEqual(['de_nuke']);
    expect(fs.existsSync(path.join(P.out, 'maps/de_anubis.webp'))).toBe(false);
    expect(Object.keys((await siteManifest(P.out, P.raw)).maps)).toEqual(['de_nuke']);
  });

  test('a build.json from before the strips lists none; a strip of another size is refused', async () => {
    await ripped();
    await hero('de_nuke');
    await buildSite(P);
    const built = JSON.parse(fs.readFileSync(P.buildJson, 'utf8'));
    fs.writeFileSync(P.buildJson, JSON.stringify({ ...built, maps: undefined }));
    expect((await siteManifest(P.out, P.raw)).maps).toEqual({});
    fs.writeFileSync(P.buildJson, JSON.stringify(built));
    fs.appendFileSync(path.join(P.out, 'maps/de_nuke.webp'), 'x');
    await expect(siteManifest(P.out, P.raw)).rejects.toThrow(/maps\/de_nuke\.webp .*rerun tools\/build-site\.mjs/);
  });

  test('check-site fails on a map with a hero.png and no strip, and on a strip made from an older hero.png', async () => {
    await ripped();
    fs.writeFileSync(path.join(P.raw, 'chicken.glb'), Buffer.alloc(600_000));
    await hero('de_nuke');
    await buildSite(P);
    const ok = checkSite();
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/de_nuke\.webp/);
    await hero('de_nuke', 30);
    const stale = checkSite();
    expect(stale.status).not.toBe(0);
    expect(stale.stdout).toMatch(/de_nuke\.webp.*older hero\.png/);
    await buildSite(P);
    await hero('de_dust2');
    const missing = checkSite();
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toMatch(/de_dust2/);
  });

  test("shrink-chicken keeps the world chicken's three clips, not the viewmodel's of the same name", async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const node = doc.createNode('root');
    doc.createScene().addChild(node);
    for (const name of [
      'animation/anims/chicken/world/chick_idle01',
      'animation/anims/chicken/world/chick_idle01_water',
      'animation/anims/chicken/world/chick_walk',
      'animation/anims/chicken/world/chick_runflap',
      'animation/anims/viewmodel/chicken/chick_idle01',
    ]) {
      const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer);
      const output = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0])).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
      doc.createAnimation(name).addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath('translation').setSampler(sampler));
    }
    const src = path.join(P.raw, CHICKEN_RAW);
    fs.mkdirSync(path.dirname(src), { recursive: true });
    await new NodeIO().write(src, doc);
    const before = fs.readdirSync(P.raw).sort();
    const { clips } = await shrinkChicken(P);
    expect(clips).toEqual(['chick_idle01', 'chick_runflap', 'chick_walk']);
    // A binary GLB, one file: nothing written beside it (a .gltf's buffer or images).
    expect(fs.readFileSync(path.join(P.raw, 'chicken.glb')).subarray(0, 4).toString()).toBe('glTF');
    expect(fs.readdirSync(P.raw).sort()).toEqual([...before, 'chicken.glb'].sort());
  });
});
