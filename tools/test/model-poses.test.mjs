// model-poses.mjs against a stand-in Source2Viewer-CLI and raw tree: each skinned model's trouble
// stays that model's error, and the table records the CLI's version as rip-map.sh does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createIO } from '../lib/gltf.mjs';
import { skinnedModel } from './skinned-model.mjs';

const MODEL_POSES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'model-poses.mjs');
const VERSION = '9.9.1+fake build 7';

// Like the real CLI: --version prints a `Version:` line. An export of <dir>/<name>.vmdl_c copies
// $FAKE_FIXTURES/<name>.glb to <out>/<dir>/<name>.glb when there is one, prints <name>.stderr to
// stderr and, when it does, writes exceptions.txt into its working directory, then exits with
// <name>.status (0 without one). Every export's working directory goes to $FAKE_CWDS.
const CLI = `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then printf 'Version: ${VERSION}\\nOS: Fake\\n'; exit 0; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) file="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$PWD" >> "$FAKE_CWDS"
name="$(basename "$file" .vmdl_c)"
fx="$FAKE_FIXTURES/$name"
if [[ -f "$fx.glb" ]]; then
  rel="\${file%.vmdl_c}.glb"
  mkdir -p "$out/$(dirname "$rel")"
  cp "$fx.glb" "$out/$rel"
fi
if [[ -f "$fx.stderr" ]]; then
  cat "$fx.stderr" >&2
  cp "$fx.stderr" exceptions.txt
fi
exit "$(cat "$fx.status" 2> /dev/null || echo 0)"
`;

// The bind pose holds a quarter turn about z that the clip does not: the export is not the drawn pose.
const QUARTER = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const MODEL = { bind: [{ name: 'root', r: QUARTER }, { name: 'tip', t: [0, 1, 0] }], clips: { idle: [{ r: [0, 0, 0, 1] }, { t: [0, 1, 0] }] } };

// What the real CLI printed for an unreadable file (scratch probe, 2026-10-24), stack and all.
const EXCEPTION = `File: /tmp/x/models/test/bad.vmdl_c
ValveResourceFormat.Utils.UnexpectedMagicException: Unexpected header. for variable 'HeaderVersion': 61530 (0xF05A)
${Array.from({ length: 6 }, (_, i) => `   at ValveResourceFormat.Frame${i}() in /_/Resource.cs:line ${i}`).join('\n')}
`;

let root, work, fixtures, cwds, env;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-poses-test-'));
  work = path.join(root, 'work');
  fixtures = path.join(root, 'fixtures');
  for (const d of [work, fixtures]) fs.mkdirSync(d);
  const cli = path.join(root, 'cli.sh');
  fs.writeFileSync(cli, CLI, { mode: 0o755 });
  cwds = path.join(root, 'cwds.txt');
  env = {
    ...process.env, CS2_DIR: path.join(root, 'cs2'), S2V_CLI: cli, CS2_BUILD: '2000935',
    ASSETS_DIR: path.join(root, 'assets'), FAKE_FIXTURES: fixtures, FAKE_CWDS: cwds,
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A GLB holding only `json`: model-poses reads a raw world's JSON chunk alone. */
function jsonGlb(json) {
  let text = JSON.stringify(json);
  text += ' '.repeat((4 - (text.length % 4)) % 4);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, Buffer.from(text)]);
}

/** raw/<map>/: a world drawing each of `models` skinned without a skin, and a prop_dynamic of each. */
function rawMap(map, models) {
  const raw = path.join(root, 'assets', 'raw', map);
  fs.mkdirSync(path.join(raw, 'entities'), { recursive: true });
  fs.writeFileSync(path.join(raw, 'world.glb'), jsonGlb({
    asset: { version: '2.0' },
    nodes: models.map((m, i) => ({ name: `${m}.lod0`, mesh: i })),
    meshes: models.map(() => ({ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] })),
  }));
  fs.writeFileSync(path.join(raw, 'entities', 'default_ents.vents'), models.map((m, i) => `====${i}====
classname                      "prop_dynamic"
model                          resource_name:"models/test/${m}.vmdl"
origin                         [ ${i}.0, 0.0, 0.0 ]
`).join(''));
  return raw;
}

const fixture = async (name, doc) => fs.writeFileSync(path.join(fixtures, `${name}.glb`), await (await createIO()).writeBinary(doc));
const run = (...maps) => spawnSync('node', [MODEL_POSES, ...maps], { cwd: work, env, encoding: 'utf8' });
const table = (map) => JSON.parse(fs.readFileSync(path.join(root, 'assets', 'raw', map, 'model-poses.json'), 'utf8'));

describe('model-poses.mjs', () => {
  test('records the CLI\'s version as rip-map.sh does: the whole rest of its Version: line', async () => {
    rawMap('de_one', ['good']);
    await fixture('good', skinnedModel(MODEL));
    const r = run('de_one');
    expect(r.status, r.stderr).toBe(0);
    expect(table('de_one')).toMatchObject({ map: 'de_one', cs2Build: '2000935', vrfVersion: VERSION });
    expect(table('de_one').models.good.pose).not.toBeNull();
  });

  test('runs the CLI in its own folder, where the CLI\'s exceptions.txt goes with it', async () => {
    rawMap('de_one', ['good']);
    await fixture('good', skinnedModel(MODEL));
    fs.writeFileSync(path.join(fixtures, 'good.stderr'), 'a warning\n');
    expect(run('de_one').status).toBe(0);
    const [cwd] = fs.readFileSync(cwds, 'utf8').split('\n');
    expect(path.basename(cwd)).toMatch(/^model-poses-/);
    expect(fs.existsSync(cwd)).toBe(false);
    expect(fs.readdirSync(work)).toEqual([]);
  });

  test('keeps the exception a failed export names, not only the last lines of its stack', async () => {
    rawMap('de_one', ['bad']);
    fs.writeFileSync(path.join(fixtures, 'bad.stderr'), EXCEPTION);
    fs.writeFileSync(path.join(fixtures, 'bad.status'), '1');
    expect(run('de_one').status).toBe(0);
    const { error } = table('de_one').models.bad;
    expect(error).toMatch(/exited 1 .*UnexpectedMagicException: Unexpected header/);
    expect(error).not.toMatch(/ at /);
  });

  test('an export it cannot read is that model\'s error; the map\'s other models and the other maps go on', async () => {
    rawMap('de_one', ['broken', 'good']);
    rawMap('de_two', ['good']);
    fs.writeFileSync(path.join(fixtures, 'broken.glb'), 'not a glb');
    await fixture('good', skinnedModel(MODEL));
    const r = run('de_one', 'de_two');
    expect(r.status, r.stderr).toBe(0);
    expect(table('de_one').models.broken.error).toMatch(/could not read models\/test\/broken\.glb/);
    expect(table('de_one').models.good.pose).not.toBeNull();
    expect(table('de_two').models.good.pose).not.toBeNull();
  });

  test('a vertex weighed on a joint its skin lacks is that model\'s error', async () => {
    rawMap('de_one', ['stray', 'good']);
    await fixture('stray', skinnedModel({ ...MODEL, joints: [7, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0] }));
    await fixture('good', skinnedModel(MODEL));
    const r = run('de_one');
    expect(r.status, r.stderr).toBe(0);
    expect(table('de_one').models.stray.error).toMatch(/joint 7/);
    expect(table('de_one').models.good.pose).not.toBeNull();
  });

  test('an export without clips is left as exported, unless the CLI reported an exception', async () => {
    rawMap('de_one', ['still']);
    await fixture('still', skinnedModel({ ...MODEL, clips: {} }));
    expect(run('de_one').status).toBe(0);
    expect(table('de_one').models.still).toEqual({ vmdl: 'models/test/still.vmdl', entities: 1, anim: null, pose: null });
    fs.writeFileSync(path.join(fixtures, 'still.stderr'), EXCEPTION);
    expect(run('de_one').status).toBe(0);
    const entry = table('de_one').models.still;
    expect(entry.pose).toBeUndefined();
    expect(entry.error).toMatch(/no animation.*UnexpectedMagicException/);
  });
});
