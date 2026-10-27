import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installMapOutputs } from '../lib/install.mjs';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const write = (dir, names) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), `${path.basename(dir)}:${n}`);
};
const ls = (dir) => fs.readdirSync(dir).sort();

const written = (built, more = []) => [...built, ...built.map((f) => `${f}.gz`), ...more, 'shrink.json'];

test('moves what the build wrote into place and leaves the rest', () => {
  const tmp = path.join(root, 'de_nuke.tmp-1'), out = path.join(root, 'de_nuke');
  const built = ['world.glb', 'hull.glb', 'entities.glb'];
  const bake = ['lightmap.webp', 'probes.bin', 'probes.bin.gz', 'light.json', 'light.json.gz'];
  write(tmp, written(built, bake));
  write(out, ['world.glb', 'radar.png', 'overview.json', 'manifest.json', 'sky.webp']);
  installMapOutputs(tmp, out, written(built, bake));
  expect(ls(out)).toEqual([
    'entities.glb', 'entities.glb.gz', 'hull.glb', 'hull.glb.gz', 'light.json', 'light.json.gz', 'lightmap.webp', 'manifest.json',
    'overview.json', 'probes.bin', 'probes.bin.gz', 'radar.png', 'shrink.json', 'sky.webp', 'world.glb', 'world.glb.gz',
  ]);
  expect(fs.readFileSync(path.join(out, 'world.glb'), 'utf8')).toBe('de_nuke.tmp-1:world.glb');
  expect(ls(tmp)).toEqual([]);
});

test('an entities.glb this build did not make is removed with its .gz (the map lost its doors)', () => {
  const tmp = path.join(root, 'de_dust2.tmp-1'), out = path.join(root, 'de_dust2');
  const built = ['world.glb', 'hull.glb'];
  write(tmp, written(built));
  write(out, ['entities.glb', 'entities.glb.gz', 'radar.png']);
  installMapOutputs(tmp, out, written(built));
  expect(ls(out)).toEqual(['hull.glb', 'hull.glb.gz', 'radar.png', 'shrink.json', 'world.glb', 'world.glb.gz']);
});

test('bake files this build did not write are removed: all of them after a build without a bake, the lightmap after tier V', () => {
  const tmp = path.join(root, 'de_vertigo.tmp-1'), out = path.join(root, 'de_vertigo');
  const built = ['world.glb', 'hull.glb'];
  const bake = ['lightmap.webp', 'probes.bin', 'probes.bin.gz', 'light.json', 'light.json.gz'];
  write(tmp, written(built));
  write(out, [...bake, 'radar.png']);
  installMapOutputs(tmp, out, written(built));
  expect(ls(out)).toEqual(['hull.glb', 'hull.glb.gz', 'radar.png', 'shrink.json', 'world.glb', 'world.glb.gz']);

  const tierV = ['probes.bin', 'probes.bin.gz', 'light.json', 'light.json.gz'];
  write(tmp, written(built, tierV));
  write(out, bake);
  installMapOutputs(tmp, out, written(built, tierV));
  expect(ls(out)).toEqual([...tierV, 'hull.glb', 'hull.glb.gz', 'radar.png', 'shrink.json', 'world.glb', 'world.glb.gz'].sort());
});

test('a world_hd.glb and its .gz from a build before it retired are removed', () => {
  const tmp = path.join(root, 'de_mirage.tmp-1'), out = path.join(root, 'de_mirage');
  const built = ['world.glb', 'hull.glb'];
  write(tmp, written(built));
  write(out, ['world_hd.glb', 'world_hd.glb.gz', 'radar.png', 'manifest.json']);
  installMapOutputs(tmp, out, written(built));
  expect(ls(out)).toEqual(['hull.glb', 'hull.glb.gz', 'manifest.json', 'radar.png', 'shrink.json', 'world.glb', 'world.glb.gz']);
});
