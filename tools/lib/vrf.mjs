// Source2Viewer-CLI's (VRF's) version, as `--version` prints it. rip-map.sh writes it into
// raw/<map>/rip.json and model-poses.mjs into raw/<map>/model-poses.json, and shrink-map.mjs
// stops when the two differ, so both read it through this one parser.
//
// node tools/lib/vrf.mjs <cli>: prints <cli>'s version (rip-map.sh), or exits 1 naming why not.
import { execFileSync } from 'node:child_process';
import { isMain } from './cli.mjs';

/**
 * The version in `--version` output: the rest of its first line that starts with `Version:`,
 * trimmed (`20.1.7467+9e2e6c7f…`). Null without such a line, or with nothing after it.
 */
export function parseVrfVersion(text) {
  const line = String(text ?? '').split('\n').find((l) => l.startsWith('Version:'));
  return line?.slice('Version:'.length).trim() || null;
}

/** `cli --version`, parsed; throws naming `cli` when it does not run or prints no version. */
export function vrfVersion(cli) {
  let out;
  try {
    out = execFileSync(cli, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    throw new Error(`${cli} --version failed: ${e.message}`);
  }
  const version = parseVrfVersion(out);
  if (!version) throw new Error(`${cli} printed no 'Version:' line for --version`);
  return version;
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node tools/lib/vrf.mjs <Source2Viewer-CLI>');
    process.stdout.write(`${vrfVersion(process.argv[2])}\n`);
  } catch (e) {
    console.error(`vrf.mjs: ${e.message}`);
    process.exit(1);
  }
}
