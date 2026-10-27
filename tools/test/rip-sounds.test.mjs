// rip-sounds.sh against a stand-in CS2 install and Source2Viewer-CLI that "exports" from a fake
// VPK tree of already-decompiled files: the first run exports and writes rip.json, a second run
// of the same build exports nothing, a file the VPK lacks is remembered and never asked for
// again, and a failing CLI leaves the rip as it was (the raw tree is shared between checkouts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SOUNDEVENT_FILES } from '../lib/sounds.mjs';

const RIP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rip-sounds.sh');
const BUILD = '2000935';

// Answers --version; for an export logs its -f filter and copies what the filter names from
// $RIP_VPK into -o: a folder (`x/`) whole, a `.vsnd_c` as its `.wav` and `.vsnd`, another
// `_c` file under its decompiled name, anything else as it is. A name the fake VPK lacks gives
// nothing, as VRF does. With RIP_FAIL set, every export fails.
const CLI = `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo 'Version: 9.9.1+fake'; exit 0; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) filter="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -i|-e|--threads) shift 2 ;;
    *) shift ;;
  esac
done
echo "$filter" >> "$RIP_CALLS"
if [[ -n "\${RIP_FAIL:-}" ]]; then echo "fake failure exporting $filter"; exit 3; fi
put() { [[ -f "$RIP_VPK/$1" ]] || return 0; mkdir -p "$out/$(dirname "$1")"; cp "$RIP_VPK/$1" "$out/$1"; }
IFS=, read -ra parts <<< "$filter"
for f in "\${parts[@]}"; do
  case "$f" in
    */) [[ -d "$RIP_VPK/$f" ]] && mkdir -p "$out/$f" && cp -R "$RIP_VPK/$f." "$out/$f" ;;
    *.vsnd_c) put "\${f%.vsnd_c}.wav"; put "\${f%.vsnd_c}.vsnd" ;;
    *_c) put "\${f%_c}" ;;
    *) put "$f" ;;
  esac
done
echo "exported $filter"
`;

const HEADER = '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->';
// shot:ak47 plays a sound under SOUND_DIRS, throw:he one outside them, throw:flash one the VPK lacks.
const WEAPON_EVENTS = `${HEADER}
{
	Weapon_AK47.Single = { vsnd_files_track_01 = [ "sounds/weapons/ak47/shot.vsnd", ] }
	HEGrenade.Throw = { vsnd_files_track_01 = [ "sounds/items/throw.vsnd", ] }
	Flashbang.Throw = { vsnd_files_track_01 = [ "sounds/items/gone.vsnd", ] }
}
`;
const SOURCES = [
  ...SOUNDEVENT_FILES.map((f) => `${f}.vsndevts_c`),
  'surfaceproperties/surfaceproperties.vsurf_c',
  'scripts/surfaceproperties_footsteps.txt',
].join(',');

let root;
let env;
let calls;
let raw;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rip-sounds-test-'));
  const csgo = path.join(root, 'cs2', 'game', 'csgo');
  fs.mkdirSync(csgo, { recursive: true });
  fs.writeFileSync(path.join(csgo, 'gameinfo.gi'), '');
  fs.writeFileSync(path.join(csgo, 'steam.inf'), `ClientVersion=${BUILD}\n`);
  fs.writeFileSync(path.join(csgo, 'pak01_dir.vpk'), '');
  const cli = path.join(root, 'cli.sh');
  fs.writeFileSync(cli, CLI, { mode: 0o755 });

  const vpk = path.join(root, 'vpk');
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(vpk, rel)), { recursive: true });
    fs.writeFileSync(path.join(vpk, rel), text);
  };
  for (const f of SOUNDEVENT_FILES) put(`${f}.vsndevts`, `${HEADER}\n{\n}\n`);
  put('soundevents/game_sounds_weapons.vsndevts', WEAPON_EVENTS);
  put('surfaceproperties/surfaceproperties.vsurf', `${HEADER}\n{ SurfacePropertiesList = [ { surfacePropertyName = "default" m_nameHash = 1 }, ] }\n`);
  put('scripts/surfaceproperties_footsteps.txt', `${HEADER}\n{ ct_player = { SurfacePropertiesList = [ ] } t_player = { SurfacePropertiesList = [ ] } }\n`);
  put('sounds/weapons/ak47/shot.wav', 'wav of shot');
  put('sounds/weapons/ak47/shot.vsnd', 'sidecar of shot');
  put('sounds/player/step.wav', 'wav of step');
  put('sounds/items/throw.wav', 'wav of throw');

  calls = path.join(root, 'calls.txt');
  raw = path.join(root, 'assets', 'raw', 'sounds');
  env = {
    ...process.env, CS2_DIR: path.join(root, 'cs2'), S2V_CLI: cli, ASSETS_DIR: path.join(root, 'assets'),
    RIP_CALLS: calls, RIP_VPK: vpk,
  };
  delete env.RIP_FAIL;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const rip = (args = [], extra = {}) => spawnSync('bash', [RIP, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);
const ripJson = () => JSON.parse(fs.readFileSync(path.join(raw, 'rip.json'), 'utf8'));

/** Every file under `dir` with its bytes and mtime. */
function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isFile()) out[f] = { bytes: fs.readFileSync(p, 'utf8'), mtimeMs: st.mtimeMs };
  }
  return out;
}

describe('rip-sounds.sh', () => {
  test('with no rip, exports the sources, the folders and each file outside them, and remembers what the VPK lacks', () => {
    const r = rip();
    expect(r.status, r.stderr).toBe(0);
    expect(called()).toEqual([SOURCES, 'sounds/weapons/,sounds/player/', 'sounds/items/gone.vsnd_c', 'sounds/items/throw.vsnd_c']);
    for (const f of ['soundevents/game_sounds_weapons.vsndevts', 'scripts/surfaceproperties_footsteps.txt',
      'sounds/weapons/ak47/shot.wav', 'sounds/weapons/ak47/shot.vsnd', 'sounds/player/step.wav', 'sounds/items/throw.wav']) {
      expect(fs.existsSync(path.join(raw, f)), f).toBe(true);
    }
    const json = ripJson();
    expect(json).toMatchObject({ cs2Build: BUILD, vrfVersion: '9.9.1+fake', absent: ['sounds/items/gone.vsnd_c'] });
    expect(json.exportedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(r.stderr).toMatch(/the VPK gave nothing for 1 file\(s\); rip\.json lists them as absent.*sounds\/items\/gone\.vsnd_c/);
    expect(fs.readFileSync(path.join(raw, 'rip.log'), 'utf8')).toMatch(/=== sounds\/items\/throw\.vsnd_c/);
    expect(fs.readdirSync(path.dirname(raw))).toEqual(['sounds']);
  });

  test('a second run of the same build is already ripped and exports nothing, the absent file included', () => {
    expect(rip().status).toBe(0);
    const before = snapshot(raw);
    fs.rmSync(calls);
    const r = rip();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/already ripped from CS2 build 2000935/);
    expect(called()).toEqual([]);
    expect(snapshot(raw)).toEqual(before);
  });

  test('a file gone from the rip is exported alone and added; a newly absent one is tried once and remembered', () => {
    expect(rip().status).toBe(0);
    const json = ripJson();
    fs.rmSync(path.join(raw, 'sounds/items/throw.wav'));
    const events = path.join(raw, 'soundevents/game_sounds_weapons.vsndevts');
    fs.writeFileSync(events, fs.readFileSync(events, 'utf8').replace(/}\s*$/, '\tDecoy.Throw = { vsnd_files_track_01 = "sounds/items/gone2.vsnd" }\n}\n'));
    const log = fs.readFileSync(path.join(raw, 'rip.log'), 'utf8');
    fs.rmSync(calls);

    const r = rip();
    expect(r.status, r.stderr).toBe(0);
    expect(called()).toEqual(['sounds/items/gone2.vsnd_c', 'sounds/items/throw.vsnd_c']);
    expect(r.stderr).toMatch(/2 missing file\(s\) exported/);
    expect(fs.readFileSync(path.join(raw, 'sounds/items/throw.wav'), 'utf8')).toBe('wav of throw');
    expect(ripJson()).toEqual({ ...json, absent: ['sounds/items/gone.vsnd_c', 'sounds/items/gone2.vsnd_c'] });
    const grown = fs.readFileSync(path.join(raw, 'rip.log'), 'utf8');
    expect(grown.startsWith(log)).toBe(true);
    expect(grown.slice(log.length)).toMatch(/=== sounds\/items\/gone2\.vsnd_c/);
    expect(fs.readdirSync(path.dirname(raw))).toEqual(['sounds']);

    fs.rmSync(calls);
    const again = rip();
    expect(again.status).toBe(0);
    expect(again.stderr).toMatch(/already ripped/);
    expect(called()).toEqual([]);
  });

  test('a run whose CLI fails leaves the rip as it was and keeps the CLI output', () => {
    expect(rip().status).toBe(0);
    const before = snapshot(raw);
    fs.rmSync(calls);
    const r = rip(['--force'], { RIP_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Source2Viewer-CLI exited 3 exporting soundevents and surface properties/);
    expect(called()).toEqual([SOURCES]);
    expect(snapshot(raw)).toEqual(before);
    expect(fs.readdirSync(path.dirname(raw)).sort()).toEqual(['sounds', 'sounds.rip-failed.log']);
    expect(fs.readFileSync(path.join(path.dirname(raw), 'sounds.rip-failed.log'), 'utf8')).toMatch(/fake failure exporting/);
  });
});
