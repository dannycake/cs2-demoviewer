// The asset-kind registry (lib/kinds.mjs) and the three places that read it: build-assets.sh
// runs each kind's plan (here against stand-in scripts that only log their command lines),
// manifest.mjs has a builder for each kind, and kindPaths places them under ASSETS_DIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KINDS, buildPlan, kindOf, kindPaths } from '../lib/kinds.mjs';
import { KIND_MANIFESTS } from '../manifest.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// These run build-assets.sh or the gates as subprocesses, dozens of node starts a test: slow on
// a loaded machine, so past vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinds-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('KINDS', () => {
  test('names each kind once, with scripts that exist: a rip first, a check-*.mjs gate', () => {
    const names = KINDS.map((k) => k.name);
    expect(new Set(names).size).toBe(names.length);
    for (const k of KINDS) {
      expect(k.name).toMatch(/^[a-z0-9_]+$/);
      expect(k.steps[0][0]).toMatch(/^rip-[a-z]+\.sh$/);
      expect(k.steps.slice(1).every(([s]) => !/^rip-/.test(s))).toBe(true);
      expect(k.check).toBe(`check-${k.name}.mjs`);
      for (const script of [...k.steps.map(([s]) => s), k.check]) expect(fs.existsSync(path.join(TOOLS, script)), script).toBe(true);
      expect(Object.isFrozen(k) && Object.isFrozen(k.steps)).toBe(true);
    }
  });

  test('manifest.mjs builds every kind and nothing else', () => {
    expect(Object.keys(KIND_MANIFESTS)).toEqual(KINDS.map((k) => k.name));
    for (const k of KINDS) expect(typeof KIND_MANIFESTS[k.name].build).toBe('function');
  });

  test('kindPaths puts a kind and its raw export under ASSETS_DIR, read on every call', () => {
    const was = process.env.ASSETS_DIR;
    process.env.ASSETS_DIR = root;
    try {
      const sounds = kindPaths(kindOf('sounds'));
      expect(sounds).toEqual({
        out: path.join(root, 'sounds'),
        raw: path.join(root, 'raw', 'sounds'),
        manifest: path.join(root, 'sounds', 'manifest.json'),
        manifests: [path.join(root, 'sounds', 'manifest.json'), path.join(root, 'sounds', 'manifest.json.gz')],
      });
      expect(kindPaths(kindOf('players')).manifests).toEqual([path.join(root, 'players', 'manifest.json')]);
    } finally {
      if (was === undefined) delete process.env.ASSETS_DIR;
      else process.env.ASSETS_DIR = was;
    }
  });

  test("buildPlan: the manifests removed, the steps (a rip-*.sh a `rip`), the check, then manifest.mjs", () => {
    const k = { name: 'hats', steps: [['rip-hats.sh'], ['shrink-hat.mjs', 'all', '--fast']], check: 'check-hats.mjs', gz: true };
    expect(buildPlan([k, { ...k, name: 'caps', gz: false, steps: [['rip-caps.sh']], check: 'check-caps.mjs' }])).toEqual([
      'hats rm hats/manifest.json',
      'hats rm hats/manifest.json.gz',
      'hats rip rip-hats.sh',
      'hats step shrink-hat.mjs all --fast',
      'hats step check-hats.mjs',
      'hats step manifest.mjs hats',
      'caps rm caps/manifest.json',
      'caps rip rip-caps.sh',
      'caps step check-caps.mjs',
      'caps step manifest.mjs caps',
    ]);
  });

  test('`node lib/kinds.mjs plan` prints buildPlan, and names the kinds', () => {
    const plan = spawnSync(process.execPath, [path.join(TOOLS, 'lib', 'kinds.mjs'), 'plan'], { encoding: 'utf8' });
    expect(plan.status).toBe(0);
    expect(plan.stdout).toBe(`${buildPlan().join('\n')}\n`);
    const names = spawnSync(process.execPath, [path.join(TOOLS, 'lib', 'kinds.mjs'), 'names'], { encoding: 'utf8' });
    expect(names.stdout).toBe(`${KINDS.map((k) => k.name).join(' ')}\n`);
    expect(spawnSync(process.execPath, [path.join(TOOLS, 'lib', 'kinds.mjs'), 'other']).status).toBe(2);
  });
});

describe('build-assets.sh by the registry', () => {
  /** The steps build_map runs for one map, in order. */
  const mapSteps = (map) => [
    `rip-map.sh ${map}`, `rip-lighting.sh ${map}`, `model-poses.sh ${map}`, `radar.mjs ${map}`, `sky.mjs ${map}`,
    `shrink-map.mjs ${map}`, `phone-tier.mjs ${map}`, `hero.sh ${map}`, `check-map.mjs ${map} --budget-override`, `manifest.mjs ${map}`,
  ];
  /** What each kind runs, from the registry, with `force` after a rip. */
  const kindSteps = (k, force = []) => [...k.steps.map(([s, ...a]) => [s, ...a, ...(/^rip-/.test(s) ? force : [])].join(' ')), k.check, `manifest.mjs ${k.name}`];

  /**
   * build-assets.sh and lib/ copied into a tools/ of stand-ins: every script it runs appends its
   * command line to `calls` and exits 0, but `FAIL` (a command line) exits 1, and `EAT` (a
   * script name) also reads its stdin to the end.
   */
  function run(args, env = {}) {
    const tools = path.join(root, 'tools');
    fs.mkdirSync(tools);
    fs.cpSync(path.join(TOOLS, 'build-assets.sh'), path.join(tools, 'build-assets.sh'));
    fs.cpSync(path.join(TOOLS, 'lib'), path.join(tools, 'lib'), { recursive: true });
    fs.symlinkSync(path.join(TOOLS, 'node_modules'), path.join(tools, 'node_modules'));
    const scripts = new Set([...mapSteps('x').map((s) => s.split(' ')[0]), ...KINDS.flatMap((k) => [...k.steps.map(([s]) => s), k.check]), 'manifest.mjs']);
    for (const s of scripts) {
      const body = s.endsWith('.sh')
        ? '#!/usr/bin/env bash\nline="$(basename -- "$0") $*"; line="${line% }"\nprintf \'%s\\n\' "$line" >> "$CALLS"\n[[ "$EAT" != "$(basename -- "$0")" ]] || cat > /dev/null\n[[ "$line" != "$FAIL" ]]\n'
        : "import fs from 'node:fs';\nimport path from 'node:path';\nconst line = [path.basename(process.argv[1]), ...process.argv.slice(2)].join(' ');\nfs.appendFileSync(process.env.CALLS, `${line}\\n`);\nif (process.env.EAT === path.basename(process.argv[1])) fs.readFileSync(0);\nif (line === process.env.FAIL) process.exit(1);\n";
      fs.writeFileSync(path.join(tools, s), body, { mode: 0o755 });
    }
    const csgo = path.join(root, 'cs2', 'game', 'csgo');
    fs.mkdirSync(csgo, { recursive: true });
    fs.writeFileSync(path.join(csgo, 'gameinfo.gi'), '');
    fs.writeFileSync(path.join(csgo, 'steam.inf'), 'ClientVersion=1234567\n');
    const cli = path.join(root, 'cli.sh');
    fs.writeFileSync(cli, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const calls = path.join(root, 'calls');
    fs.writeFileSync(calls, '');
    const assets = path.join(root, 'assets');
    const r = spawnSync('bash', [path.join(tools, 'build-assets.sh'), ...args], {
      env: { ...process.env, CS2_DIR: path.join(root, 'cs2'), S2V_CLI: cli, ASSETS_DIR: assets, CALLS: calls, FAIL: '', EAT: '', ...env },
      encoding: 'utf8',
      input: 'stdin a step could swallow\n',
    });
    return { ...r, calls: fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean), assets };
  }

  test('runs each kind after the maps, in the registry order, its rip with --force, then the root manifest', () => {
    const r = run(['de_x', '--force']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.calls).toEqual([
      ...mapSteps('de_x').map((s) => (/^rip-/.test(s) ? `${s} --force` : s)),
      ...KINDS.flatMap((k) => kindSteps(k, ['--force'])),
      'manifest.mjs root',
    ]);
    for (const k of KINDS) expect(r.stdout).toContain(`OK ${k.name} (`);
    expect(r.stdout).toContain(`de_x${KINDS.map((k) => ` + ${k.name}`).join('')}; CS2 build 1234567`);
  });

  test('a failing step stops its kind before its check and manifest; the next kinds still build', () => {
    const [first, second, ...rest] = KINDS;
    const failing = kindSteps(first)[1];
    // The next kind's last build step reads all of its stdin: the plan is not there to take.
    const r = run(['de_x'], { FAIL: failing, EAT: second.steps.at(-1)[0] });
    expect(r.status).toBe(1);
    const steps = kindSteps(first);
    expect(r.calls).toEqual([
      ...mapSteps('de_x'),
      ...steps.slice(0, 2),
      ...[second, ...rest].flatMap((k) => kindSteps(k)),
      'manifest.mjs root',
    ]);
    expect(r.stdout).toContain(`FAIL ${first.name} at ${failing} (`);
    expect(r.stdout).toContain(`  ${failing}: FAILED, exit 1`);
    expect(r.stdout).toContain(`OK ${second.name} (`);
    expect(r.stdout).toMatch(new RegExp(`failed ${first.name}; log `));
  });

  test("removes each kind's manifest (and its .gz) before the kind's first step", () => {
    const assets = path.join(root, 'assets');
    const planted = KINDS.flatMap((k) => (k.gz ? [`${k.name}/manifest.json`, `${k.name}/manifest.json.gz`] : [`${k.name}/manifest.json`]));
    for (const f of planted) {
      fs.mkdirSync(path.dirname(path.join(assets, f)), { recursive: true });
      fs.writeFileSync(path.join(assets, f), '{}');
    }
    // The stand-in manifest.mjs writes none, and the first kind fails at its rip: each manifest is
    // gone because its kind's build removed it first.
    const r = run(['de_x'], { FAIL: kindSteps(KINDS[0])[0] });
    expect(r.status).toBe(1);
    expect(planted.filter((f) => fs.existsSync(path.join(assets, f)))).toEqual([]);
  });
});
