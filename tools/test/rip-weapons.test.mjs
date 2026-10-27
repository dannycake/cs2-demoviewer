// rip-weapons.sh against a stand-in CS2 install and Source2Viewer-CLI: a model whose raw folder
// is missing is exported on its own, beside the others, which are left exactly as they were
// (the raw tree is shared between checkouts, and --force would re-export 1.9 GB of it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MODEL_NAMES, MODEL_PATHS } from '../lib/weapons.mjs';

const RIP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rip-weapons.sh');
const BUILD = '2000935';

// Answers --version, and for an export writes <out>/<vmdl dir>/<file>.glb and logs the model.
const CLI = `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo 'Version: 9.9.1+fake'; exit 0; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) vmdl="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$vmdl" >> "$RIP_CALLS"
dir="$out/\${vmdl%/*}"
mkdir -p "$dir"
printf 'glb of %s' "$vmdl" > "$dir/$(basename "$vmdl" .vmdl_c).glb"
echo "exported $vmdl"
`;

let root;
let env;
let calls;
let raw;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rip-weapons-test-'));
  const csgo = path.join(root, 'cs2', 'game', 'csgo');
  fs.mkdirSync(csgo, { recursive: true });
  fs.writeFileSync(path.join(csgo, 'gameinfo.gi'), '');
  fs.writeFileSync(path.join(csgo, 'steam.inf'), `ClientVersion=${BUILD}\n`);
  fs.writeFileSync(path.join(csgo, 'pak01_dir.vpk'), '');
  const cli = path.join(root, 'cli.sh');
  fs.writeFileSync(cli, CLI, { mode: 0o755 });
  calls = path.join(root, 'calls.txt');
  raw = path.join(root, 'assets', 'raw', 'weapons');
  env = { ...process.env, CS2_DIR: path.join(root, 'cs2'), S2V_CLI: cli, ASSETS_DIR: path.join(root, 'assets'), RIP_CALLS: calls };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const rip = (...args) => spawnSync('bash', [RIP, ...args], { env, encoding: 'utf8' });
const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);
const glbOf = (name) => `${name}/${path.basename(MODEL_PATHS[name], '.vmdl_c')}.glb`;

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

describe('rip-weapons.sh', () => {
  test('with no rip, exports every model, the weapons and the kit', () => {
    const r = rip();
    expect(r.status, r.stderr).toBe(0);
    expect(called().sort()).toEqual(MODEL_NAMES.map((n) => MODEL_PATHS[n]).sort());
    const json = JSON.parse(fs.readFileSync(path.join(raw, 'rip.json'), 'utf8'));
    expect(json.cs2Build).toBe(BUILD);
    expect(Object.keys(json.models)).toEqual([...MODEL_NAMES]);
    expect(json.models.defuser).toEqual({ vmdl: MODEL_PATHS.defuser, glb: glbOf('defuser') });
  });

  test('a rip of this build missing a model exports that model alone and adds it, touching nothing else', () => {
    expect(rip().status).toBe(0);
    fs.rmSync(path.join(raw, 'defuser'), { recursive: true });
    const json = JSON.parse(fs.readFileSync(path.join(raw, 'rip.json'), 'utf8'));
    delete json.models.defuser;
    fs.writeFileSync(path.join(raw, 'rip.json'), JSON.stringify(json, null, 2) + '\n');
    fs.writeFileSync(path.join(raw, 'ak47', 'keep.png'), 'a texture');
    const before = snapshot(raw);
    fs.rmSync(calls);

    const r = rip();
    expect(r.status, r.stderr).toBe(0);
    expect(called()).toEqual([MODEL_PATHS.defuser]);
    expect(r.stderr).toMatch(/1 missing model\(s\) \(defuser\) ripped/);
    expect(fs.readFileSync(path.join(raw, glbOf('defuser')), 'utf8')).toBe(`glb of ${MODEL_PATHS.defuser}`);
    const after = snapshot(raw);
    for (const [f, v] of Object.entries(before)) {
      if (f === 'rip.json' || f === 'rip.log') continue;
      expect(after[f], f).toEqual(v);
    }
    // rip.log grows; rip.json gains the kit, everything it held as it was.
    expect(after['rip.log'].bytes.startsWith(before['rip.log'].bytes)).toBe(true);
    expect(after['rip.log'].bytes.slice(before['rip.log'].bytes.length)).toMatch(/=== defuser/);
    const merged = JSON.parse(after['rip.json'].bytes);
    const { defuser, ...rest } = merged.models;
    expect({ ...merged, models: rest }).toEqual(json);
    expect(defuser).toMatchObject({ vmdl: MODEL_PATHS.defuser, glb: glbOf('defuser'), vrfVersion: '9.9.1+fake' });
    expect(defuser.exportedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Object.keys(merged.models)).toEqual([...MODEL_NAMES]);
    expect(fs.readdirSync(path.dirname(raw)).filter((f) => f !== 'weapons')).toEqual([]);

    // Nothing missing now: nothing exported.
    fs.rmSync(calls);
    const again = rip();
    expect(again.status).toBe(0);
    expect(again.stderr).toMatch(/already ripped/);
    expect(called()).toEqual([]);
  });

  test('a model rip.json lists whose folder is gone is exported again, and its entry renewed', () => {
    expect(rip().status).toBe(0);
    fs.rmSync(path.join(raw, 'defuser'), { recursive: true });
    fs.rmSync(calls);
    const r = rip();
    expect(r.status, r.stderr).toBe(0);
    expect(called()).toEqual([MODEL_PATHS.defuser]);
    expect(fs.existsSync(path.join(raw, glbOf('defuser')))).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(raw, 'rip.json'), 'utf8'));
    expect(json.models.defuser).toMatchObject({ vmdl: MODEL_PATHS.defuser, vrfVersion: '9.9.1+fake' });
  });

  test('a folder rip.json does not list is not replaced: the run stops, naming the move that fixes it', () => {
    expect(rip().status).toBe(0);
    const json = JSON.parse(fs.readFileSync(path.join(raw, 'rip.json'), 'utf8'));
    delete json.models.defuser;
    fs.writeFileSync(path.join(raw, 'rip.json'), JSON.stringify(json, null, 2) + '\n');
    const before = snapshot(raw);
    fs.rmSync(calls);

    const r = rip();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${path.join(raw, 'defuser')} is there but rip.json does not list it`);
    expect(r.stderr).toContain(`mv -- '${path.join(raw, 'defuser')}' '${path.join(raw, 'defuser')}.unlisted'`);
    expect(r.stderr).not.toMatch(/--force/);
    expect(called()).toEqual([]);
    expect(snapshot(raw)).toEqual(before);
    expect(fs.readdirSync(path.dirname(raw)).filter((f) => f !== 'weapons')).toEqual([]);
  });
});
