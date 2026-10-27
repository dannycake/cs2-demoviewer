// lib/cli.mjs isMain, the one "is this the script node was started with" guard: right through a
// symlinked path, false for an import; and every tools/ script that exports anything can be
// imported without running, so a test or another script can read its PARAMS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PHONE_WORLD, phonePlayer } from '../phone-tier.mjs';
import { PARAMS as MAP_PARAMS } from '../shrink-map.mjs';
import { PARAMS as PLAYER_PARAMS } from '../shrink-player.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = pathToFileURL(path.join(TOOLS, 'lib', 'cli.mjs')).href;

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });

describe('isMain', () => {
  // A module that prints whether it is the entry module, and one that imports it.
  beforeEach(() => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'probe.mjs'), `import { isMain } from ${JSON.stringify(CLI)};\nconsole.log(isMain(import.meta.url));\n`);
    fs.writeFileSync(path.join(root, 'real', 'importer.mjs'), "import './probe.mjs';\n");
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'));
    fs.symlinkSync(path.join(root, 'real', 'probe.mjs'), path.join(root, 'probe-link.mjs'));
  });

  test('is true for the script node was started with, by any path to it', () => {
    for (const script of ['real/probe.mjs', 'linked/probe.mjs', 'probe-link.mjs']) {
      expect(node([path.join(root, script)]).stdout, script).toBe('true\n');
    }
    expect(node(['real/probe.mjs'], { cwd: root }).stdout).toBe('true\n');
    expect(node(['probe.mjs'], { cwd: path.join(root, 'linked') }).stdout).toBe('true\n');
  });

  test('is false for a module imported by another, and without a script', () => {
    expect(node([path.join(root, 'linked', 'importer.mjs')]).stdout).toBe('false\n');
    expect(node(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(root, 'real', 'probe.mjs')).href)})`]).stdout).toBe('false\n');
  });

  test('is false under node -e or -p given the module\'s own path as an argument, as the bash scripts import libs', () => {
    // process.argv[1] is that argument there: sync-assets.sh imports lib/kinds.mjs this way.
    const probe = path.join(root, 'real', 'probe.mjs');
    expect(node(['--input-type=module', '-e', 'await import(process.argv[1])', probe]).stdout).toBe('false\n');
    expect(node(['--input-type=module', '--eval=await import(process.argv[1])', probe]).stdout).toBe('false\n');
    expect(node(['-pe', `import(${JSON.stringify(pathToFileURL(probe).href)})`, probe]).stdout).toMatch(/^false\n/);
  });
});

test('hero.mjs, sky.mjs and lib/vrf.mjs run when started through a symlinked tools/ (they printed nothing and exited 0)', () => {
  const linked = path.join(root, 'tools');
  fs.symlinkSync(TOOLS, linked);
  const env = { ...process.env, ASSETS_DIR: path.join(root, 'assets') };
  // Without arguments each prints its usage and fails, which only a main that ran can do.
  for (const [script, status] of [['hero.mjs', 2], ['sky.mjs', 2], ['lib/vrf.mjs', 1]]) {
    const r = node([path.join(linked, script)], { env });
    expect(r.status, script).toBe(status);
    expect(r.stderr, script).toMatch(/usage/);
  }
  expect(fs.existsSync(path.join(root, 'assets'))).toBe(false);
});

test('no script guards its main another way', () => {
  const files = [
    ...fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs')),
    ...fs.readdirSync(path.join(TOOLS, 'lib')).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs').map((f) => `lib/${f}`),
  ];
  const others = files.filter((f) => /process\.argv\[1\]|import\.meta\.main/.test(fs.readFileSync(path.join(TOOLS, f), 'utf8')));
  expect(others).toEqual([]);
});

describe('importing a script', () => {
  // Every script with exports or a guarded main, each imported where its main would act at
  // once: no arguments (a usage error), ASSETS_DIR an empty directory. The check-*.mjs gates
  // are among them (their rows are exported for their tests); build-effects.mjs and
  // gzip-maps.mjs have neither: they are only ever run.
  const SCRIPTS = fs.readdirSync(TOOLS)
    .filter((f) => f.endsWith('.mjs') && /^export |isMain\(import\.meta\.url\)/m.test(fs.readFileSync(path.join(TOOLS, f), 'utf8')));

  test.each(SCRIPTS)('%s does nothing', (script) => {
    const assets = path.join(root, 'assets');
    fs.mkdirSync(assets);
    const url = pathToFileURL(path.join(TOOLS, script)).href;
    const r = node(['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('imported');`], {
      env: { ...process.env, ASSETS_DIR: assets },
      cwd: root,
    });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('imported\n');
    expect(r.status).toBe(0);
    expect(fs.readdirSync(assets)).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual(['assets']);
  });

  test('the list holds the shrinks', () => {
    expect(SCRIPTS).toEqual(expect.arrayContaining(['shrink-map.mjs', 'shrink-player.mjs', 'model-poses.mjs', 'shrink-weapon.mjs', 'phone-tier.mjs', 'hero.mjs', 'sky.mjs', 'check-map.mjs', 'check-players.mjs', 'check-weapons.mjs', 'check-viewmodels.mjs', 'check-effects.mjs', 'check-sounds.mjs']));
  });
});

test("the phone tiers encode at their sources' WebP qualities, read from the shrinks' PARAMS", () => {
  expect(PHONE_WORLD.quality).toBe(MAP_PARAMS.world.quality);
  expect(MAP_PARAMS.world.format).toBe('webp');
  expect(phonePlayer('ct').quality).toBe(PLAYER_PARAMS.texture.quality);
  expect(PLAYER_PARAMS.texture.format).toBe('webp');
});
