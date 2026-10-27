// lib/stage.mjs: the one temp name (<target>.tmp-<pid>), the atomic writes and staging
// directories built on it, and the sweep that reads the pid back from it; and build-assets.sh,
// which runs that sweep when a build starts, against a stand-in install whose CLI fails every
// export (so nothing past the sweep writes anything but the build's own log and root manifest).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { leftoverOf, pidAlive, staging, sweepLeftovers, tmpPath, writeFileAtomic, writeFilesAtomic, writeJsonAtomic } from '../lib/stage.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let root;
let sleeper;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-test-')); });
afterEach(() => {
  sleeper?.kill('SIGKILL');
  sleeper = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A pid no process has: one that has exited. */
const deadPid = () => spawnSync('true').pid;
/** A pid that stays alive until the test ends. */
function livePid() {
  sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  return sleeper.pid;
}
const put = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
/** Every path under `dir`, relative and sorted; symlinks not followed. */
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

describe('the temp name', () => {
  test('is <target>.tmp-<pid>, and leftoverOf reads the target and the pid back', () => {
    expect(tmpPath('/a/weapons/ak47', 123)).toBe('/a/weapons/ak47.tmp-123');
    expect(tmpPath('x')).toBe(`x.tmp-${process.pid}`);
    expect(leftoverOf(path.basename(tmpPath('/a/manifest.json.gz', 77)))).toEqual({ target: 'manifest.json.gz', kind: 'tmp', pid: 77 });
    expect(leftoverOf('de_mirage.old-9')).toEqual({ target: 'de_mirage', kind: 'old', pid: 9 });
  });

  test('anything else is not a leftover, the old per-item shape (<out>.tmp-<pid>-<name>) among them', () => {
    for (const name of ['world.glb', 'viewmodels.tmp-123-arms_ct', 'weapons.tmp-', 'x.tmp-12a', 'x.tmp-12.glb', 'x.rip-failed.log']) {
      expect(leftoverOf(name), name).toBeNull();
    }
  });

  test('pidAlive tells a running process from one that has exited', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(deadPid())).toBe(false);
  });
});

describe('atomic writes', () => {
  test('writeFileAtomic replaces the file and leaves no temp file', () => {
    const file = path.join(root, 'sky.json');
    put(file, 'old');
    writeFileAtomic(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readdirSync(root)).toEqual(['sky.json']);
  });

  test('a failed write leaves the file as it was and no temp file', () => {
    const dir = path.join(root, 'hero.png');
    fs.mkdirSync(dir);
    expect(() => writeFileAtomic(dir, 'png')).toThrow();
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.readdirSync(root)).toEqual(['hero.png']);
  });

  test('writeFilesAtomic writes every file before it renames any', () => {
    const a = path.join(root, 'a.json');
    put(a, 'old');
    // The second file's directory does not exist, so its write fails after the first's.
    expect(() => writeFilesAtomic([[a, 'new'], [path.join(root, 'missing', 'b.json'), 'b']])).toThrow();
    expect(fs.readFileSync(a, 'utf8')).toBe('old');
    expect(fs.readdirSync(root)).toEqual(['a.json']);
  });

  test('writeJsonAtomic writes the JSON, and with gz its gzip -9 sibling', () => {
    const file = path.join(root, 'manifest.json');
    writeJsonAtomic(file, { b: 1, a: [2] }, { gz: true });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toBe('{\n  "b": 1,\n  "a": [\n    2\n  ]\n}\n');
    expect(zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8')).toBe(text);
    writeJsonAtomic(path.join(root, 'build.json'), {});
    expect(fs.readdirSync(root).sort()).toEqual(['build.json', 'manifest.json', 'manifest.json.gz']);
  });
});

describe('staging', () => {
  test('stages beside the target, commits only the names given, and abort removes what is left', () => {
    const out = path.join(root, 'weapons');
    put(path.join(out, 'm4a4.glb'), 'm4a4');
    put(tmpPath(path.join(out, 'ak47')) + '/stale', 'from a run of this pid that died');
    const stage = staging(path.join(out, 'ak47'));
    expect(stage.dir).toBe(tmpPath(path.join(out, 'ak47')));
    expect(fs.readdirSync(stage.dir)).toEqual([]);
    stage.write('ak47.glb', 'glb');
    fs.writeFileSync(stage.file('ak47.glb.gz'), 'gz');
    stage.write('scratch.bin', 'not shipped');
    stage.commit(out, ['ak47.glb', 'ak47.glb.gz']);
    stage.abort();
    expect(tree(root)).toEqual(['weapons', 'weapons/ak47.glb', 'weapons/ak47.glb.gz', 'weapons/m4a4.glb']);
  });

  test('commit makes the directory it renames into', () => {
    const stage = staging(path.join(root, 'players'));
    stage.write('ct.glb', 'ct');
    stage.commit(path.join(root, 'players'), ['ct.glb']);
    stage.abort();
    expect(tree(root)).toEqual(['players', 'players/ct.glb']);
  });
});

/** A leftover of every shape the tools write, as they name it: a staging dir or a single file. */
const SHAPES = [
  ['maps/de_x', 'dir'], // shrink-map, radar, phone-tier
  ['maps/de_x/hero.png', 'file'], // hero.mjs
  ['maps/de_x/sky.webp', 'file'], // sky.mjs
  ['maps/de_x/manifest.json', 'file'], // manifest.mjs
  ['players', 'dir'], // shrink-player, phone-tier players
  ['weapons/ak47', 'dir'], // shrink-weapon
  ['weapons/manifest.json', 'file'],
  ['viewmodels/arms_ct', 'dir'], // shrink-arms
  ['viewmodels/idle_ak', 'dir'], // shrink-viewmodel-clips
  ['effects/smoke.webp', 'file'], // build-effects
  ['sounds', 'dir'], // build-sounds
  ['sounds/manifest.json.gz', 'file'],
  ['manifest.json', 'file'],
  ['raw/de_x', 'dir'], // rip-map (lib/rip.sh)
  ['raw/de_x/lightmaps', 'dir'], // rip-lighting
  ['raw/de_x/model-poses.json', 'file'], // model-poses
  ['raw/weapons', 'dir'], // rip-weapons, and the others' raw/<kind>
];

/** Plants SHAPES under `assets` for `pid`, with the targets' own trees beside them. */
function plant(assets, pid) {
  for (const [target, kind] of SHAPES) {
    const left = tmpPath(path.join(assets, target), pid);
    if (kind === 'dir') put(path.join(left, 'half.glb'));
    else put(left);
  }
  put(path.join(assets, 'maps/de_x/world.glb'));
  put(path.join(assets, 'raw/weapons/rip.json'));
  return SHAPES.map(([target]) => tmpPath(target, pid));
}

describe('sweepLeftovers', () => {
  test("removes every shape a dead process left, at every depth, and nothing else", () => {
    const assets = path.join(root, 'assets');
    const pid = deadPid();
    const left = plant(assets, pid);
    const said = sweepLeftovers(assets);
    expect(said.sort()).toEqual(left.map((l) => `removing leftover ${path.join(assets, l)}`).sort());
    expect(tree(assets).filter((p) => p.includes('.tmp-'))).toEqual([]);
    expect(fs.existsSync(path.join(assets, 'maps/de_x/world.glb'))).toBe(true);
    expect(fs.existsSync(path.join(assets, 'raw/weapons/rip.json'))).toBe(true);
  });

  test("leaves every shape a running process is writing, the per-item staging dirs the old sweep deleted among them", () => {
    const assets = path.join(root, 'assets');
    const pid = livePid();
    const left = plant(assets, pid);
    const before = tree(assets);
    expect(sweepLeftovers(assets)).toEqual([]);
    expect(tree(assets)).toEqual(before);
    for (const l of left) expect(fs.existsSync(path.join(assets, l)), l).toBe(true);
  });

  test('puts a previous export moved aside back when the swap never ended, and drops it when it did', () => {
    const raw = path.join(root, 'assets', 'raw');
    const pid = deadPid();
    put(path.join(raw, `de_x.old-${pid}`, 'rip.json'), 'previous');
    put(path.join(raw, `de_x.tmp-${pid}`, 'rip.json'), 'half');
    put(path.join(raw, `weapons.old-${pid}`, 'rip.json'), 'previous');
    put(path.join(raw, 'weapons', 'rip.json'), 'new');
    const said = sweepLeftovers(path.join(root, 'assets'));
    expect(said).toContain(`restoring leftover ${path.join(raw, `de_x.old-${pid}`)} to ${path.join(raw, 'de_x')}`);
    expect(said).toContain(`removing leftover ${path.join(raw, `weapons.old-${pid}`)}`);
    expect(tree(raw)).toEqual(['de_x', 'de_x/rip.json', 'weapons', 'weapons/rip.json']);
    expect(fs.readFileSync(path.join(raw, 'de_x', 'rip.json'), 'utf8')).toBe('previous');
    expect(fs.readFileSync(path.join(raw, 'weapons', 'rip.json'), 'utf8')).toBe('new');
  });

  test("does not follow a symlink: a checkout whose raw/ links another's leaves that tree alone", () => {
    const shared = path.join(root, 'shared-raw');
    const pid = deadPid();
    put(path.join(shared, `de_x.tmp-${pid}`, 'half.glb'));
    const assets = path.join(root, 'assets');
    fs.mkdirSync(assets);
    fs.symlinkSync(shared, path.join(assets, 'raw'));
    expect(sweepLeftovers(assets)).toEqual([]);
    expect(fs.existsSync(path.join(shared, `de_x.tmp-${pid}`))).toBe(true);
  });

  test('a missing root is nothing to sweep', () => {
    expect(sweepLeftovers(path.join(root, 'nothing'))).toEqual([]);
  });
});

describe('build-assets.sh', () => {
  // A stand-in install and a CLI that fails everything, so every step after the sweep fails at
  // once; ASSETS_DIR is a fresh directory.
  function build(assets) {
    const csgo = path.join(root, 'cs2', 'game', 'csgo');
    put(path.join(csgo, 'gameinfo.gi'), '');
    put(path.join(csgo, 'steam.inf'), 'ClientVersion=1234567\n');
    const cli = path.join(root, 'cli.sh');
    fs.writeFileSync(cli, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    return spawnSync('bash', [path.join(TOOLS, 'build-assets.sh'), 'de_x'], {
      env: { ...process.env, CS2_DIR: path.join(root, 'cs2'), S2V_CLI: cli, ASSETS_DIR: assets },
      encoding: 'utf8',
    });
  }

  test('reclaims the leftovers of dead processes, of every shape, and keeps a running one', () => {
    const assets = path.join(root, 'assets');
    const dead = deadPid();
    const live = livePid();
    const gone = plant(assets, dead);
    put(path.join(assets, `viewmodels/arms_t.tmp-${live}`, 'half.glb'));
    // The old per-item shape, which the old sweep read as pid "<pid>-arms_ct" and so removed
    // from under a running shrink-arms.mjs.
    put(path.join(assets, `viewmodels.tmp-${live}-arms_ct`, 'half.glb'));
    put(path.join(assets, `raw/players.old-${dead}`, 'rip.json'), 'previous');
    const r = build(assets);
    expect(r.status, r.stderr).toBe(1);
    for (const l of gone) expect(r.stdout).toContain(`removing leftover ${path.join(assets, l)}\n`);
    expect(r.stdout).toContain(`restoring leftover ${path.join(assets, `raw/players.old-${dead}`)} to ${path.join(assets, 'raw/players')}\n`);
    expect(fs.readFileSync(path.join(assets, 'build.log'), 'utf8')).toContain(`removing leftover ${path.join(assets, gone[0])}\n`);
    const left = tree(assets).filter((p) => /\.(tmp|old)-\d+$/.test(p));
    expect(left).toEqual([`viewmodels/arms_t.tmp-${live}`]);
    expect(fs.existsSync(path.join(assets, `viewmodels.tmp-${live}-arms_ct`, 'half.glb'))).toBe(true);
    expect(fs.readFileSync(path.join(assets, 'raw/players/rip.json'), 'utf8')).toBe('previous');
  });
});
