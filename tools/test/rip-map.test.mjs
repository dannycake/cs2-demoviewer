// rip-map.sh's skip of a map already ripped from the installed CS2 build, against a stand-in CS2
// install and Source2Viewer-CLI: after a VRF-only upgrade the skip names --force, the one way to a
// rip (and so a pose table) from the new VRF.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const RIP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rip-map.sh');
const BUILD = '2000935';
const VERSION = '9.9.1+fake build 7';

let root, env, raw, calls;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rip-map-test-'));
  const csgo = path.join(root, 'cs2', 'game', 'csgo');
  fs.mkdirSync(path.join(csgo, 'maps'), { recursive: true });
  for (const f of ['gameinfo.gi', 'pak01_dir.vpk', 'maps/de_nuke.vpk']) fs.writeFileSync(path.join(csgo, f), '');
  fs.writeFileSync(path.join(csgo, 'steam.inf'), `ClientVersion=${BUILD}\n`);
  calls = path.join(root, 'calls.txt');
  const cli = path.join(root, 'cli.sh');
  // --version as the real CLI prints it; any export is only logged (a skip makes none).
  fs.writeFileSync(cli, `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then printf 'Version: ${VERSION}\\nOS: Fake\\n'; exit 0; fi
echo "$*" >> "$RIP_CALLS"
exit 1
`, { mode: 0o755 });
  raw = path.join(root, 'assets', 'raw', 'de_nuke');
  fs.mkdirSync(raw, { recursive: true });
  env = { ...process.env, CS2_DIR: path.join(root, 'cs2'), S2V_CLI: cli, ASSETS_DIR: path.join(root, 'assets'), RIP_CALLS: calls };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const ripped = (vrfVersion) => fs.writeFileSync(path.join(raw, 'rip.json'), JSON.stringify({ map: 'de_nuke', cs2Build: BUILD, vrfVersion, exportedAt: '2026-10-24T00:00:00Z' }));
const rip = () => spawnSync('bash', [RIP, 'de_nuke'], { env, encoding: 'utf8' });

describe('rip-map.sh on a rip from the installed CS2 build', () => {
  test('skips it quietly when the CLI is the VRF that exported it', () => {
    ripped(VERSION);
    const r = rip();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/de_nuke already ripped from CS2 build 2000935/);
    expect(r.stderr).not.toMatch(/VRF/);
    expect(fs.existsSync(calls)).toBe(false);
  });

  test('skips it, naming both VRF versions and --force, when the CLI is another VRF', () => {
    ripped('9.9.0+old');
    const r = rip();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/VRF 9\.9\.0\+old.*VRF 9\.9\.1\+fake build 7.*tools\/rip-map\.sh de_nuke --force/s);
    expect(fs.existsSync(calls)).toBe(false);
  });
});
