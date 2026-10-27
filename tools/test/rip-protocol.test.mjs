// The rip protocol (lib/rip.sh) as each of the seven rip scripts uses it, against a stand-in CS2
// install and a stub Source2Viewer-CLI that "exports" from a fake VPK: a whole export is
// swapped into place; a CLI failure, a SIGTERM mid-export and a SIGKILL mid-export all leave
// the previous export exactly as it was, and nothing but (after a SIGKILL) the temp dir, which
// the build's sweep reclaims. ASSETS_DIR is a fresh directory each time: the real raw tree is
// shared between checkouts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EFFECT_SOURCES } from '../lib/effects.mjs';
import { PLAYER_MODELS } from '../lib/players.mjs';
import { SOUND_DIRS, SOUNDEVENT_FILES } from '../lib/sounds.mjs';
import { sweepLeftovers } from '../lib/stage.mjs';
import { VIEWMODEL_DIR_LIST } from '../lib/viewmodels.mjs';
import { MODEL_NAMES, MODEL_PATHS } from '../lib/weapons.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = '2000935';
const MAP = 'de_x';

// The stub: `--version`; `-l -f <path>` prints each listed path the fake VPK has; an export copies
// the fake VPK's export of each path in -f into -o. STUB_FAIL names a path whose export fails,
// after printing a line; STUB_HANG one whose export touches STUB_HANG_MARK and sleeps, after
// copying what it exports. The fake VPK keeps each path's export under the path with its
// slashes as %, so a folder's export (`sounds/weapons/`) does not hold the paths below it.
const STUB = `#!/usr/bin/env bash
if [[ "\${1:-}" == --version ]]; then echo 'Version: 9.9.1+stub'; exit 0; fi
filter="" out="" list=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) filter="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -i|-e|--game|--threads|--gltf_export_format|--gltf_animation_list) shift 2 ;;
    -l) list=1; shift ;;
    *) shift ;;
  esac
done
IFS=, read -r -a files <<< "$filter"
if [[ "$list" -eq 1 ]]; then
  for f in "\${files[@]}"; do [[ ! -e "$STUB_VPK/\${f//\\//%}" ]] || printf '%s\\n' "$f"; done
  exit 0
fi
echo "stub: export $filter"
for f in "\${files[@]}"; do
  if [[ "$f" == "\${STUB_FAIL:-}" ]]; then echo "stub: failing on $f"; exit 3; fi
  src="$STUB_VPK/\${f//\\//%}"
  [[ ! -d "$src" ]] || cp -R -- "$src/." "$out/"
  if [[ "$f" == "\${STUB_HANG:-}" ]]; then : > "$STUB_HANG_MARK"; sleep 60; fi
done
echo "stub: done"
`;

const KV3 = '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->';
const SKY_ENTS = '====0====\nskyname resource_name:"materials/skybox/sky_test.vmat"\nclassname "env_sky"\nangles [ 0.0, 0.0, 0.0 ]\n';
const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
const baseOf = (p, ext) => path.basename(p, ext);
const last = (a) => a[a.length - 1];

/**
 * Each script: its arguments, the export it swaps in (`dest`, under ASSETS_DIR) and the file
 * that records the build there, the fake VPK (path → { export's files }), the path whose export
 * fails or hangs (late in the run, so a partial export is there), and what else it reads.
 */
const SCRIPTS = {
  'rip-map.sh': {
    args: [MAP], dest: `raw/${MAP}`, json: 'rip.json', at: `resource/overviews/${MAP}.txt`,
    vpk: () => ({
      [`maps/${MAP}/world.vwrld_c`]: { [`maps/${MAP}/world.glb`]: 'glb', [`maps/${MAP}/world_physics.glb`]: 'glb', [`maps/${MAP}/tex_color.png`]: 'png' },
      [`maps/${MAP}/world_physics.vmdl_c`]: { [`maps/${MAP}/world_physics_physics.glb`]: 'glb', [`maps/${MAP}/world_physics.glb`]: '' },
      [`panorama/images/overheadmaps/${MAP}_radar_psd.vtex_c`]: { [`panorama/images/overheadmaps/${MAP}_radar_psd.png`]: 'png' },
      [`resource/overviews/${MAP}.txt`]: { [`resource/overviews/${MAP}.txt`]: `"${MAP}" {}` },
      [`maps/${MAP}/entities/default_ents.vents_c`]: { [`maps/${MAP}/entities/default_ents.vents`]: SKY_ENTS },
    }),
    shipped: ['world.glb', 'world_physics.glb', 'world_collision.glb', 'radar.png', 'overview.txt', 'tex_color.png', 'entities/default_ents.vents'],
  },
  'rip-lighting.sh': {
    args: [MAP], dest: `raw/${MAP}/lightmaps`, json: 'lightmaps.json', at: `maps/${MAP}/lightmaps/debug_chart_color.vtex_c`,
    setup: (assets) => put(path.join(assets, 'raw', MAP, 'entities', 'default_ents.vents'), SKY_ENTS),
    vpk: () => {
      const lm = `maps/${MAP}/lightmaps`;
      const z = (n, base, ext) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${lm}/${base}_z${String(i).padStart(3, '0')}.${ext}`, ext]));
      return {
        [`maps/${MAP}/entities/default_ents.vents_c`]: {},
        [`resource/overviews/${MAP}.txt`]: {},
        'materials/skybox/sky_test.vmat_c': { 'materials/skybox/sky_test.vmat': 'vmat', 'materials/skybox/sky_test_png.exr': 'exr' },
        [`${lm}/irradiance.vtex_c`]: { [`${lm}/irradiance.exr`]: 'exr' },
        [`${lm}/env_light_probe_volume_atlas.vtex_c`]: z(12, 'env_light_probe_volume_atlas', 'exr'),
        [`${lm}/env_light_probe_volume_atlas_dlshd.vtex_c`]: z(2, 'env_light_probe_volume_atlas_dlshd', 'png'),
        [`${lm}/debug_chart_color.vtex_c`]: { [`${lm}/debug_chart_color.png`]: 'png' },
      };
    },
    shipped: ['irradiance.exr', 'debug_chart_color.png', 'env_light_probe_volume_atlas_z011.exr', 'env_light_probe_volume_atlas_dlshd_z001.png'],
  },
  'rip-players.sh': {
    args: [], dest: 'raw/players', json: 'rip.json', at: PLAYER_MODELS.t,
    vpk: () => Object.fromEntries(Object.values(PLAYER_MODELS).map((v) => [v, { [`${dirOf(v)}/${baseOf(v, '.vmdl_c')}.glb`]: 'glb', [`${dirOf(v)}/skin_color.png`]: 'png' }])),
    shipped: Object.entries(PLAYER_MODELS).map(([side, v]) => `${side}/${baseOf(v, '.vmdl_c')}.glb`),
  },
  'rip-weapons.sh': {
    args: [], dest: 'raw/weapons', json: 'rip.json', at: MODEL_PATHS[last(MODEL_NAMES)],
    vpk: () => Object.fromEntries(MODEL_NAMES.map((n) => [MODEL_PATHS[n], { [`${dirOf(MODEL_PATHS[n])}/${baseOf(MODEL_PATHS[n], '.vmdl_c')}.glb`]: 'glb' }])),
    shipped: MODEL_NAMES.map((n) => `${n}/${baseOf(MODEL_PATHS[n], '.vmdl_c')}.glb`),
  },
  'rip-viewmodels.sh': {
    args: [], dest: 'raw/viewmodels', json: 'rip.json', at: `animation/anims/viewmodel/${last(VIEWMODEL_DIR_LIST)}/`,
    vpk: () => Object.fromEntries(VIEWMODEL_DIR_LIST.map((d) => [`animation/anims/viewmodel/${d}/`, { [`animation/anims/viewmodel/${d}/idle.glb`]: 'glb' }])),
    shipped: VIEWMODEL_DIR_LIST.map((d) => `${d}/idle.glb`),
  },
  'rip-effects.sh': {
    args: [], dest: 'raw/effects', json: 'rip.json', at: `${last(EFFECT_SOURCES)}.vtex_c`,
    vpk: () => Object.fromEntries(EFFECT_SOURCES.map((v) => [`${v}.vtex_c`, { [`${v}.png`]: 'png' }])),
    shipped: EFFECT_SOURCES.map((v) => `${v}.png`),
  },
  'rip-sounds.sh': {
    args: [], dest: 'raw/sounds', json: 'rip.json', at: SOUND_DIRS[0],
    vpk: () => ({
      ...Object.fromEntries(SOUNDEVENT_FILES.map((f) => [`${f}.vsndevts_c`, { [`${f}.vsndevts`]: `${KV3}\n{\n}\n` }])),
      'surfaceproperties/surfaceproperties.vsurf_c': { 'surfaceproperties/surfaceproperties.vsurf': `${KV3}\n{ SurfacePropertiesList = [ ] }\n` },
      'scripts/surfaceproperties_footsteps.txt': { 'scripts/surfaceproperties_footsteps.txt': `${KV3}\n{ ct_player = { SurfacePropertiesList = [ ] } t_player = { SurfacePropertiesList = [ ] } }\n` },
      ...Object.fromEntries(SOUND_DIRS.map((d) => [d, { [`${d}one.wav`]: 'wav' }])),
    }),
    shipped: [...SOUNDEVENT_FILES.map((f) => `${f}.vsndevts`), ...SOUND_DIRS.map((d) => `${d}one.wav`)],
  },
};

let root;
let assets;
let env;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rip-protocol-test-'));
  assets = path.join(root, 'assets');
  const csgo = path.join(root, 'cs2', 'game', 'csgo');
  put(path.join(csgo, 'gameinfo.gi'), '');
  put(path.join(csgo, 'steam.inf'), `ClientVersion=${BUILD}\n`);
  put(path.join(csgo, 'pak01_dir.vpk'), '');
  put(path.join(csgo, 'maps', `${MAP}.vpk`), '');
  const stub = path.join(root, 'Source2Viewer-CLI');
  fs.writeFileSync(stub, STUB, { mode: 0o755 });
  env = {
    ...process.env, CS2_DIR: path.join(root, 'cs2'), S2V_CLI: stub, ASSETS_DIR: assets, TMPDIR: root,
    STUB_VPK: path.join(root, 'vpk'), STUB_HANG_MARK: path.join(root, 'hanging'),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Writes the fake VPK: each path's export under the path with its slashes as %. */
function writeVpk(vpk) {
  for (const [p, files] of Object.entries(vpk)) {
    const dir = path.join(root, 'vpk', p.replaceAll('/', '%'));
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(files)) put(path.join(dir, rel), text);
  }
}

/** Every file under `dir` with its bytes. */
function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) out[f] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

/** Every leftover name under ASSETS_DIR (a temp dir or an export moved aside), relative. */
const leftovers = () => fs.readdirSync(assets, { recursive: true }).map(String).filter((p) => /\.(tmp|old)-\d+$/.test(p)).sort();

/** The previous export at `dest`: from another CS2 build, so the script exports again. */
function previous(s) {
  const dest = path.join(assets, s.dest);
  put(path.join(dest, s.json), JSON.stringify({ cs2Build: '1' }));
  put(path.join(dest, 'previous.txt'), 'the export before this run');
  return snapshot(dest);
}

const run = (script, s, extra = {}) => spawnSync('bash', [path.join(TOOLS, script), ...s.args], { env: { ...env, ...extra }, encoding: 'utf8' });

/** Starts `script` in its own process group, hanging in the stub at `s.at`; resolves once it hangs. */
async function startHanging(script, s) {
  const child = spawn('bash', [path.join(TOOLS, script), ...s.args], {
    env: { ...env, STUB_HANG: s.at }, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stderr })));
  for (let i = 0; i < 400 && !fs.existsSync(env.STUB_HANG_MARK); i++) {
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(fs.existsSync(env.STUB_HANG_MARK), `${script} never reached ${s.at}: ${stderr}`).toBe(true);
  return { child, exited };
}

describe.each(Object.entries(SCRIPTS))('%s', (script, s) => {
  beforeEach(() => {
    writeVpk(s.vpk());
    s.setup?.(assets);
  });

  test('commits a whole export, and leaves nothing beside it', () => {
    const r = run(script, s);
    expect(r.status, r.stderr).toBe(0);
    const dest = path.join(assets, s.dest);
    expect(JSON.parse(fs.readFileSync(path.join(dest, s.json), 'utf8'))).toMatchObject({ cs2Build: BUILD, vrfVersion: '9.9.1+stub' });
    for (const f of s.shipped) expect(fs.existsSync(path.join(dest, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'rip.log'), 'utf8')).toMatch(/=== .*\n=== .*Source2Viewer-CLI.*\nstub: export /);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(`${dest}.rip-failed.log`)).toBe(false);
  }, 60_000);

  test('a failing CLI leaves the previous export as it was and keeps the CLI output', () => {
    const before = previous(s);
    const dest = path.join(assets, s.dest);
    const r = run(script, s, { STUB_FAIL: s.at });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Source2Viewer-CLI exited 3 exporting /);
    expect(r.stderr).toMatch(/stub: failing on/);
    expect(snapshot(dest)).toEqual(before);
    expect(fs.readFileSync(`${dest}.rip-failed.log`, 'utf8')).toMatch(/stub: failing on/);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  test('a run stopped by SIGTERM mid-export leaves the previous export and no temp dir', async () => {
    const before = previous(s);
    const { child, exited } = await startHanging(script, s);
    process.kill(-child.pid, 'SIGTERM');
    const { code } = await exited;
    expect(code).toBe(143);
    expect(snapshot(path.join(assets, s.dest))).toEqual(before);
    expect(leftovers()).toEqual([]);
  }, 60_000);

  test('a run killed outright mid-export leaves the previous export and its temp dir, which the sweep reclaims', async () => {
    const before = previous(s);
    const { child, exited } = await startHanging(script, s);
    const tmp = `${s.dest}.tmp-${child.pid}`;
    expect(fs.existsSync(path.join(assets, tmp))).toBe(true);
    process.kill(-child.pid, 'SIGKILL');
    expect((await exited).signal).toBe('SIGKILL');
    expect(snapshot(path.join(assets, s.dest))).toEqual(before);
    expect(leftovers()).toEqual([tmp]);
    expect(sweepLeftovers(assets)).toEqual([`removing leftover ${path.join(assets, tmp)}`]);
    expect(leftovers()).toEqual([]);
    expect(snapshot(path.join(assets, s.dest))).toEqual(before);
  }, 60_000);
});

describe('rip-map.sh and what other scripts export beside the rip', () => {
  const map = SCRIPTS['rip-map.sh'];
  const lighting = SCRIPTS['rip-lighting.sh'];
  beforeEach(() => {
    writeVpk(lighting.vpk());
    writeVpk(map.vpk());
  });

  /** What of `snapshot(dest)` other scripts own: rip-lighting.sh's groups, model-poses.json. */
  const theirs = (snap) => Object.fromEntries(Object.entries(snap).filter(([f]) => /^(lightmaps|sky)\/|^model-poses\.json$/.test(f)));

  test("a re-rip carries rip-lighting.sh's and model-poses.sh's exports across the swap, so a lighting rip that then fails keeps the last bake", () => {
    // A rip, its bake and sky and its pose table, all from the CS2 build before an update.
    const dest = path.join(assets, map.dest);
    put(path.join(dest, 'rip.json'), JSON.stringify({ cs2Build: '1' }));
    put(path.join(dest, 'previous.txt'), 'the rip before this run');
    put(path.join(dest, 'lightmaps', 'lightmaps.json'), JSON.stringify({ cs2Build: '1', textures: ['irradiance'] }));
    put(path.join(dest, 'lightmaps', 'irradiance.exr'), 'the last good bake');
    put(path.join(dest, 'sky', 'sky.json'), JSON.stringify({ cs2Build: '1' }));
    put(path.join(dest, 'sky', 'sky.exr'), 'the sky');
    put(path.join(dest, 'model-poses.json'), '{"models": {}}');
    const kept = theirs(snapshot(dest));
    expect(Object.keys(kept).sort()).toEqual(['lightmaps/irradiance.exr', 'lightmaps/lightmaps.json', 'model-poses.json', 'sky/sky.exr', 'sky/sky.json']);

    const r = run('rip-map.sh', map);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dest, 'rip.json'), 'utf8'))).toMatchObject({ cs2Build: BUILD });
    for (const f of map.shipped) expect(fs.existsSync(path.join(dest, f)), f).toBe(true);
    expect(fs.existsSync(path.join(dest, 'previous.txt'))).toBe(false);
    expect(theirs(snapshot(dest))).toEqual(kept);
    expect(leftovers()).toEqual([]);

    // rip-lighting.sh, as build-assets.sh runs it next, re-exports both groups (another build's)
    // and fails on the lightmaps: the bake carried across is still the last good one.
    const lit = run('rip-lighting.sh', lighting, { STUB_FAIL: lighting.at });
    expect(lit.status).toBe(1);
    expect(lit.stderr).toMatch(/Source2Viewer-CLI exited 3 exporting lightmaps/);
    const after = theirs(snapshot(dest));
    expect(Object.fromEntries(Object.entries(after).filter(([f]) => !f.startsWith('sky/')))).toEqual(
      Object.fromEntries(Object.entries(kept).filter(([f]) => !f.startsWith('sky/'))),
    );
    expect(JSON.parse(after['sky/sky.json'])).toMatchObject({ cs2Build: BUILD });
    expect(leftovers()).toEqual([]);
  }, 60_000);
});

describe("rip-lighting.sh's groups and the installed VRF", () => {
  const lighting = SCRIPTS['rip-lighting.sh'];
  beforeEach(() => {
    writeVpk(lighting.vpk());
    lighting.setup(assets);
  });

  test('a group from this CS2 build and VRF is skipped; one from another VRF only is exported again, without --force', () => {
    const raw = path.join(assets, 'raw', MAP);
    const group = (vrfVersion) => {
      for (const [g, json] of [['lightmaps', 'lightmaps.json'], ['sky', 'sky.json']]) {
        put(path.join(raw, g, json), JSON.stringify({ map: MAP, cs2Build: BUILD, vrfVersion }));
        put(path.join(raw, g, 'previous.txt'), 'the export before this run');
      }
    };
    // The stub CLI is VRF 9.9.1+stub (lib/vrf.mjs reads its --version).
    group('9.9.1+stub');
    let r = run('rip-lighting.sh', lighting);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/de_x sky already exported from CS2 build 2000935 and VRF 9\.9\.1\+stub/);
    expect(r.stderr).toMatch(/de_x lightmaps already exported from CS2 build 2000935 and VRF 9\.9\.1\+stub/);
    for (const g of ['lightmaps', 'sky']) expect(fs.existsSync(path.join(raw, g, 'previous.txt')), g).toBe(true);

    // The same CS2 build from an older VRF: a VRF update, which rip-map.sh's swap no longer clears.
    group('9.9.0+older');
    r = run('rip-lighting.sh', lighting);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/already exported/);
    for (const [g, json] of [['lightmaps', 'lightmaps.json'], ['sky', 'sky.json']]) {
      expect(JSON.parse(fs.readFileSync(path.join(raw, g, json), 'utf8')), g).toMatchObject({ cs2Build: BUILD, vrfVersion: '9.9.1+stub' });
      expect(fs.existsSync(path.join(raw, g, 'previous.txt')), g).toBe(false);
    }
    expect(fs.existsSync(path.join(raw, 'lightmaps', 'irradiance.exr'))).toBe(true);
    expect(leftovers()).toEqual([]);
  }, 60_000);
});

describe('lib/rip.sh', () => {
  /** Runs `body` in bash after lib/env.sh and lib/rip.sh, against the stand-in install. */
  const bash = (body) => spawnSync('bash', ['-c', `set -euo pipefail\nsource "${TOOLS}/lib/env.sh"\nsource "${TOOLS}/lib/rip.sh"\n${body}`], { env, encoding: 'utf8' });

  test('a failure mid-swap puts the previous export back', () => {
    put(path.join(assets, 'raw', 'x', 'rip.json'), 'previous');
    const r = bash(`
      rip_begin "$ASSETS_DIR/raw/x"
      echo new > "$rip_tmp/rip.json"
      mv -- "$rip_dest" "$rip_old"  # rip_commit's first move, then the failure
      echo "moved aside"
      exit 1
    `);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('moved aside\n');
    expect(r.status).toBe(1);
    expect(fs.readFileSync(path.join(assets, 'raw', 'x', 'rip.json'), 'utf8')).toBe('previous');
    expect(leftovers()).toEqual([]);
  });

  test('rip_field and rip_fresh read a rip.json, and are empty or false without one', () => {
    put(path.join(assets, 'rip.json'), JSON.stringify({ cs2Build: BUILD, vrfVersion: 'v' }));
    put(path.join(assets, 'old.json'), JSON.stringify({ cs2Build: '1' }));
    put(path.join(assets, 'bad.json'), '{');
    const r = bash(`
      printf '%s|%s|%s|%s\\n' "$(rip_field "$ASSETS_DIR/rip.json" vrfVersion)" "$(rip_field "$ASSETS_DIR/rip.json" none)" "$(rip_field "$ASSETS_DIR/bad.json" cs2Build)" "$(rip_field "$ASSETS_DIR/missing.json" cs2Build)"
      for f in rip old bad missing; do if rip_fresh "$ASSETS_DIR/$f.json"; then echo "$f fresh"; else echo "$f stale"; fi; done
      for v in v w; do if rip_fresh "$ASSETS_DIR/rip.json" "$v"; then echo "vrf $v fresh"; else echo "vrf $v stale"; fi; done
    `);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('v|||\nrip fresh\nold stale\nbad stale\nmissing stale\nvrf v fresh\nvrf w stale\n');
  });
});
