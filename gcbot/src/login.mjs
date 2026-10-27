// Signs the alt in by QR code and stores its refresh token, by default in 1Password at the
// op://<vault>/<item>/<field> reference that gcbot.env.tpl's STEAM_REFRESH_TOKEN line names
// (the template that renders gcbot.env, so the token goes where the render reads it), or with
// `--state <dir>` in <dir>/refresh-token, the file gcbot reads from its state volume. Run it
// on a desktop with the alt's Steam app at hand:
// `cd gcbot && node src/login.mjs [--png <file>] [--state <dir>]` (`--png` also writes each code
// as an image, to show on another screen). The token is never printed and never in argv: it
// reaches `op` as a JSON item on stdin.
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { EAuthTokenPlatformType, LoginSession } from 'steam-session';
import { expiresAt, saveToken } from './token.mjs';

/** The env template whose STEAM_REFRESH_TOKEN reference says where 1Password keeps the token. */
export const TEMPLATE = fileURLToPath(new URL('../gcbot.env.tpl', import.meta.url));
const USAGE = 'usage: node src/login.mjs [--png <file>] [--state <dir>]';
const NOTE =
  "The demoviewer alt's Steam refresh token (about 200 days), from gcbot/src/login.mjs. " +
  'gcbot.env.tpl renders it into gcbot.env as STEAM_REFRESH_TOKEN.';

/**
 * `{ vault, item, field }` from the `STEAM_REFRESH_TOKEN=op://<vault>/<item>/<field>` line of an
 * env template's text, or null when it has none.
 */
export function opReference(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*STEAM_REFRESH_TOKEN\s*=\s*op:\/\/([^/]+)\/([^/]+)\/([^/]+?)\s*$/.exec(line);
    if (m) return { vault: m[1], item: m[2], field: m[3] };
  }
  return null;
}

const FLAGS = new Map([
  ['--png', 'png'],
  ['--state', 'state'],
]);

/** `--png <file>` and `--state <dir>` from the arguments; anything else throws the usage. */
export function parseArgs(args) {
  const opts = { png: undefined, state: undefined };
  for (let i = 0; i < args.length; i++) {
    const key = FLAGS.get(args[i]);
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(USAGE);
    opts[key] = args[++i];
  }
  return opts;
}

/**
 * Runs `op` (or `bin`, for tests) with `input` on stdin; resolves to its exit code and output.
 * `op` reads stdin only from a real pipe, and Node hands a child a socket ("expected data on stdin
 * but none found", or `item create` asking for --category), so the input goes through `cat |`.
 */
export function runOp(args, input = '', { bin = 'op' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', 'cat | exec "$0" "$@"', bin, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** `item` with its `field` set to `token` (concealed), added when missing. */
function withToken(item, field, token) {
  const fields = Array.isArray(item.fields) ? item.fields.map((f) => ({ ...f })) : [];
  const found = fields.find((f) => f.label === field || f.id === field);
  if (found) Object.assign(found, { type: 'CONCEALED', value: token });
  else fields.push({ id: field, label: field, type: 'CONCEALED', value: token });
  return { ...item, fields };
}

/** Creates or updates the vault item `ref` (`opReference`'s) names. `op` is for tests. */
export async function storeToken(token, { vault, item: title, field }, { op = runOp } = {}) {
  const got = await op(['item', 'get', title, '--vault', vault, '--format', 'json']);
  let result;
  if (got.code === 0) {
    const item = withToken(JSON.parse(got.stdout), field, token);
    result = await op(['item', 'edit', title, '--vault', vault], JSON.stringify(item));
  } else if (/isn't an item/.test(got.stderr)) {
    const item = withToken(
      {
        title,
        category: 'SECURE_NOTE',
        fields: [
          { id: 'notesPlain', label: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: NOTE },
        ],
      },
      field,
      token
    );
    result = await op(['item', 'create', '--vault', vault, '-'], JSON.stringify(item));
  } else {
    throw new Error(`op item get failed: ${got.stderr.trim()}`);
  }
  if (result.code !== 0) throw new Error(`op failed: ${result.stderr.trim()}`);
}

/**
 * Calls `show(url)` each time Steam replaces the QR challenge. Steam rotates the code while the
 * sign-in waits, and a code shown once stops scanning ("failed to scan" in the app) after that;
 * steam-session reports the new one only in its poll answers, through 'debug'.
 */
export function followQr(session, first, show) {
  let current = first;
  session.on('debug', (what, response) => {
    const url = what === 'poll response' ? response?.newChallengeUrl : undefined;
    if (url && url !== current) {
      current = url;
      show(url);
    }
  });
}

/**
 * Throws unless `op` can read the vault now. Run before the QR is shown: 1Password's approval
 * prompt then comes first, and a dismissed or locked 1Password is found out before anyone scans.
 */
export async function checkVault(vault, { op = runOp } = {}) {
  const got = await op(['vault', 'get', vault, '--format', 'json']);
  if (got.code !== 0) {
    throw new Error(`1Password cannot read the ${vault} vault: ${got.stderr.trim()}`);
  }
}

/** The template's text, or '' when the checkout has none. */
function readTemplate() {
  try {
    return readFileSync(TEMPLATE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function main() {
  const { png, state } = parseArgs(process.argv.slice(2));
  // Where the token goes, checked before the QR is shown so a sign-in is never thrown away.
  let ref = null;
  if (state) {
    accessSync(state, constants.W_OK);
  } else {
    ref = opReference(readTemplate());
    if (!ref) {
      throw new Error(
        `${TEMPLATE} has no STEAM_REFRESH_TOKEN=op://<vault>/<item>/<field> line: write one, ` +
          'or pass --state <dir> to keep the token in <dir>/refresh-token'
      );
    }
    await checkVault(ref.vault);
  }
  const where = state ? path.join(state, 'refresh-token') : `${ref.vault}/${ref.item}`;
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  session.loginTimeout = 300_000;
  const show = async (url) => {
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    if (png) await QRCode.toFile(png, url, { scale: 12, margin: 4 });
    console.log("Scan this with the ALT's Steam app (Steam Guard → the QR icon).");
  };
  const { qrChallengeUrl } = await session.startWithQR();
  await show(qrChallengeUrl);
  console.log('Waiting 5 minutes; Steam changes the code now and then, and the newest one is below.');
  followQr(session, qrChallengeUrl, (url) =>
    show(url).catch((err) => console.error(`login: could not draw the new code: ${err.message}`))
  );

  const token = await new Promise((resolve, reject) => {
    session.on('remoteInteraction', () => console.log('Scanned: approve the sign-in in the app.'));
    session.on('authenticated', () => resolve(session.refreshToken));
    session.on('timeout', () => reject(new Error('Nobody approved the sign-in in 5 minutes')));
    session.on('error', reject);
  });

  // Only the alt belongs here: the main account logs into nothing.
  const who = `${session.accountName} (${session.steamID?.getSteamID64?.() ?? '?'})`;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Signed in as ${who}. Store this in ${where}? [y/N] `);
  if (answer.trim().toLowerCase() !== 'y') {
    rl.close();
    console.log('Not stored.');
    return 1;
  }
  // The token lives only in this process: a failed store (a 1Password prompt dismissed or timed
  // out, a full disk) is asked again rather than thrown away with the sign-in.
  for (;;) {
    try {
      if (state) saveToken(state, token);
      else await storeToken(token, ref);
      break;
    } catch (err) {
      const again = await rl.question(`Storing failed: ${err.message}. Try again? [Y/n] `);
      if (again.trim().toLowerCase() === 'n') {
        rl.close();
        console.log('Not stored.');
        return 1;
      }
    }
  }
  rl.close();
  console.log(
    `Stored in ${where}${ref ? ` (${ref.field})` : ''}; it expires ${expiresAt(token)?.toISOString() ?? '?'}.`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`login: ${err.message}`);
      process.exit(1);
    }
  );
}
