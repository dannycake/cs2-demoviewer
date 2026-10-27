import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildRadar } from '../radar.mjs';

const RADAR_MJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'radar.mjs');

const MIRAGE = `"de_mirage"
{
\t"material"\t"overviews/de_mirage"\t// texture file
\t"pos_x"\t\t"-3230"\t// X coordinate,
\t"pos_y"\t\t"1713"\t// Y coordinate,
\t"scale"\t\t"5.00" \t// and used scale used when taking the screenshot
\t"rotate"\t"0"
\t"zoom"\t\t"0"
\t"CTSpawn_x"\t"0.28"
\t"CTSpawn_y"\t"0.70"
\t"TSpawn_x"\t"0.87"
\t"TSpawn_y"\t"0.36"
\t"bombA_x"\t"0.54"
\t"bombA_y"\t"0.76"
\t"bombB_x"\t"0.23"
\t"bombB_y"\t"0.28"
}`;

const NUKE = `// HLTV overview description file for de_nuke.bsp
"de_nuke"
{
\t"pos_x"\t\t"-3453"\t// upper left world coordinate
\t"pos_y"\t\t"2887"
\t"scale"\t\t"7"
\t"verticalsections"
\t{
\t\t"default" // use the primary radar image
\t\t{
\t\t\t"AltitudeMax" "10000"
\t\t\t"AltitudeMin" "-495"
\t\t}
\t\t"lower" // i.e. de_nuke_lower_radar.dds
\t\t{
\t\t\t"AltitudeMax" "-495"
\t\t\t"AltitudeMin" "-10000"
\t\t}
\t}
\t"CTSpawn_x"\t"0.82"
\t"CTSpawn_y"\t"0.45"
}`;

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A PNG made by sharp, half-transparent so the alpha channel is observable. */
async function png(file, width = 1024, height = width) {
  await sharp({ create: { width, height, channels: 4, background: { r: 40, g: 90, b: 160, alpha: 0.5 } } })
    .png()
    .toFile(file);
}

/** assets/raw/<map>/ with overview.txt and the given radar files. */
async function raw(map, kv, images = ['radar.png']) {
  const dir = path.join(root, 'raw', map);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'overview.txt'), kv);
  for (const f of images) await png(path.join(dir, f));
  return dir;
}

const out = (map) => path.join(root, 'maps', map);
const names = (ov) => ov.sections.map((s) => s.name);
const leftovers = () => (fs.existsSync(path.join(root, 'maps')) ? fs.readdirSync(path.join(root, 'maps')).filter((f) => f.includes('.tmp-')) : []);

test('Mirage: one section, radar.png re-encoded 1024x1024 with alpha, overview.json written', async () => {
  const rawDir = await raw('de_mirage', MIRAGE);
  const ov = await buildRadar('de_mirage', rawDir, out('de_mirage'));
  expect(names(ov)).toEqual(['default']);
  expect([ov.posX, ov.posY, ov.scale]).toEqual([-3230, 1713, 5]);
  expect(fs.readdirSync(out('de_mirage')).sort()).toEqual(['overview.json', 'radar.png']);
  expect(JSON.parse(fs.readFileSync(path.join(out('de_mirage'), 'overview.json'), 'utf8'))).toEqual(ov);
  const meta = await sharp(path.join(out('de_mirage'), 'radar.png')).metadata();
  expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(['png', 1024, 1024, true]);
  const pixels = async (f) => (await sharp(f).raw().toBuffer()).subarray(0, 4);
  const px = await pixels(path.join(out('de_mirage'), 'radar.png'));
  expect(px[3]).toBeGreaterThan(0);
  expect(px[3]).toBeLessThan(255);
  expect(px).toEqual(await pixels(path.join(rawDir, 'radar.png')));
  expect(leftovers()).toEqual([]);
});

test('Nuke with radar_lower.png: two sections and both images', async () => {
  const ov = await buildRadar('de_nuke', await raw('de_nuke', NUKE, ['radar.png', 'radar_lower.png']), out('de_nuke'));
  expect(names(ov)).toEqual(['default', 'lower']);
  expect(ov.sections.map((s) => s.image)).toEqual(['radar.png', 'radar_lower.png']);
  expect(ov.sections[1]).toMatchObject({ altitudeMin: -10000, altitudeMax: -495 });
  expect(fs.readdirSync(out('de_nuke')).sort()).toEqual(['overview.json', 'radar.png', 'radar_lower.png']);
  for (const f of ['radar.png', 'radar_lower.png']) {
    const { width, height } = await sharp(path.join(out('de_nuke'), f)).metadata();
    expect([width, height]).toEqual([1024, 1024]);
  }
});

test('Nuke without radar_lower.png rejects naming the file and writes nothing', async () => {
  const rawDir = await raw('de_nuke', NUKE, ['radar.png']);
  await expect(buildRadar('de_nuke', rawDir, out('de_nuke'))).rejects.toThrow(/radar_lower\.png/);
  expect(fs.existsSync(out('de_nuke'))).toBe(false);
  expect(leftovers()).toEqual([]);
});

test('a radar_lower.png with no lower section is a mismatch, not a silent extra file', async () => {
  const rawDir = await raw('de_mirage', MIRAGE, ['radar.png', 'radar_lower.png']);
  await expect(buildRadar('de_mirage', rawDir, out('de_mirage'))).rejects.toThrow(/lower/);
  expect(fs.existsSync(out('de_mirage'))).toBe(false);
});

test('missing overview.txt or radar.png rejects naming the file', async () => {
  const noOverview = await raw('de_mirage', MIRAGE);
  fs.rmSync(path.join(noOverview, 'overview.txt'));
  await expect(buildRadar('de_mirage', noOverview, out('de_mirage'))).rejects.toThrow(/overview\.txt/);
  const noRadar = await raw('de_dust2', MIRAGE.replace('"de_mirage"', '"de_dust2"'), []);
  await expect(buildRadar('de_dust2', noRadar, out('de_dust2'))).rejects.toThrow(/radar\.png/);
  expect(leftovers()).toEqual([]);
});

test('a rerun replaces the radar files, removes a stale radar_lower.png and leaves other files alone', async () => {
  const dir = out('de_mirage');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.glb'), 'glb');
  fs.writeFileSync(path.join(dir, 'radar_lower.png'), 'stale');
  fs.writeFileSync(path.join(dir, 'radar.png'), 'old');
  await buildRadar('de_mirage', await raw('de_mirage', MIRAGE), dir);
  expect(fs.readdirSync(dir).sort()).toEqual(['overview.json', 'radar.png', 'world.glb']);
  expect(fs.readFileSync(path.join(dir, 'world.glb'), 'utf8')).toBe('glb');
  expect((await sharp(path.join(dir, 'radar.png')).metadata()).width).toBe(1024);
});

test('output is byte-identical across runs', async () => {
  const rawDir = await raw('de_nuke', NUKE, ['radar.png', 'radar_lower.png']);
  await buildRadar('de_nuke', rawDir, out('de_nuke'));
  const first = ['radar.png', 'radar_lower.png', 'overview.json'].map((f) => fs.readFileSync(path.join(out('de_nuke'), f)));
  await buildRadar('de_nuke', rawDir, out('de_nuke'));
  const second = ['radar.png', 'radar_lower.png', 'overview.json'].map((f) => fs.readFileSync(path.join(out('de_nuke'), f)));
  expect(second.map((b, i) => b.equals(first[i]))).toEqual([true, true, true]);
});

test('a square radar of another size is resized to 1024, a non-square one rejects', async () => {
  const big = await raw('de_mirage', MIRAGE, []);
  await png(path.join(big, 'radar.png'), 2048);
  await buildRadar('de_mirage', big, out('de_mirage'));
  const { width, height } = await sharp(path.join(out('de_mirage'), 'radar.png')).metadata();
  expect([width, height]).toEqual([1024, 1024]);

  const odd = await raw('de_dust2', MIRAGE.replace('"de_mirage"', '"de_dust2"'), []);
  await png(path.join(odd, 'radar.png'), 1024, 512);
  await expect(buildRadar('de_dust2', odd, out('de_dust2'))).rejects.toThrow(/1024x512/);
  expect(fs.existsSync(out('de_dust2'))).toBe(false);
});

test('CLI: a missing section image exits 2 with one line naming the file and leaves no map directory', async () => {
  await raw('de_nuke', NUKE, ['radar.png']);
  const r = spawnSync(process.execPath, [RADAR_MJS, 'de_nuke'], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });
  expect(r.status).toBe(2);
  expect(r.stderr.trim().split('\n')).toHaveLength(1);
  expect(r.stderr).toMatch(/radar_lower\.png/);
  expect(fs.existsSync(out('de_nuke'))).toBe(false);
  expect(leftovers()).toEqual([]);
});

test('CLI: writes assets/maps/<map>/ under ASSETS_DIR; usage errors exit 1', async () => {
  await raw('de_nuke', NUKE, ['radar.png', 'radar_lower.png']);
  const r = spawnSync(process.execPath, [RADAR_MJS, 'de_nuke'], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(fs.readdirSync(out('de_nuke')).sort()).toEqual(['overview.json', 'radar.png', 'radar_lower.png']);
  expect(spawnSync(process.execPath, [RADAR_MJS], { encoding: 'utf8' }).status).toBe(1);
  expect(spawnSync(process.execPath, [RADAR_MJS, '../x'], { encoding: 'utf8' }).status).toBe(1);
});
