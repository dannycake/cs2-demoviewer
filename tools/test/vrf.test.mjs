// The one parser of Source2Viewer-CLI's --version, which rip-map.sh (rip.json) and model-poses.mjs
// (model-poses.json) share: shrink-map.mjs compares what the two wrote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseVrfVersion, vrfVersion } from '../lib/vrf.mjs';

const VRF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'vrf.mjs');

describe('parseVrfVersion', () => {
  test('is the rest of the first line that starts with Version:, trimmed', () => {
    const real = 'Version: 20.1.7467+9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304\nOS: Arch Linux (X64)\nWebsite: https://valveresourceformat.github.io\n';
    expect(parseVrfVersion(real)).toBe('20.1.7467+9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304');
    expect(parseVrfVersion('Version:   21.0 preview 3  \r\nVersion: 2\n')).toBe('21.0 preview 3');
    expect(parseVrfVersion('Source2Viewer\nVersion: 9.9\n')).toBe('9.9');
  });

  test('is null without such a line, or with nothing after it', () => {
    for (const text of ['', 'OS: Arch\n', 'OS Version: 6.18\n', '  Version: 1\n', 'Version:   \n', undefined]) {
      expect(parseVrfVersion(text)).toBeNull();
    }
  });
});

describe('vrfVersion and node lib/vrf.mjs <cli>', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrf-test-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = (body) => {
    const file = path.join(root, 'cli.sh');
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    return file;
  };

  test('runs the CLI\'s --version and parses it', () => {
    const file = cli('[[ "$1" == --version ]] && printf "Version: 9.9.1+fake build 7\\nOS: Fake\\n"');
    expect(vrfVersion(file)).toBe('9.9.1+fake build 7');
    const r = spawnSync('node', [VRF, file], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('9.9.1+fake build 7\n');
  });

  test('fails naming the CLI when it prints no version or does not run', () => {
    const quiet = cli('echo "OS: Fake"');
    expect(() => vrfVersion(quiet)).toThrow(/cli\.sh printed no 'Version:' line for --version/);
    const r = spawnSync('node', [VRF, quiet], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/cli\.sh printed no 'Version:' line/);
    expect(() => vrfVersion(path.join(root, 'missing'))).toThrow(/missing --version failed/);
  });
});
