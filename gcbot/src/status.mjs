// gcbot's health from inside its container (or anywhere it is reachable): prints /health's JSON
// and exits 0 when healthy, 1 when Steam or the GC is down or the token expires within 7 days
// (the problems go to stderr), 2 when gcbot does not answer. `--alive` only checks that it
// answers (the image's HEALTHCHECK: a signed-out gcbot is still a running one).
// Env: GCBOT_PORT (8097).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WEEK_MS = 7 * 86_400_000;

/** What is wrong with `health` at `now`: an empty list when nothing is. */
export function verdict(health, now = Date.now()) {
  const problems = [];
  if (health.steam !== 'online') problems.push('Steam is offline');
  if (health.gc !== true) problems.push('no Game Coordinator session');
  const expires = health.tokenExpiresAt ? Date.parse(health.tokenExpiresAt) : NaN;
  if (Number.isNaN(expires)) {
    problems.push('no refresh token (or one gcbot cannot read)');
  } else if (expires - now < WEEK_MS) {
    problems.push(`the refresh token expires ${health.tokenExpiresAt}: sign the alt in again`);
  }
  return problems;
}

async function main() {
  const alive = process.argv.includes('--alive');
  const url = `http://127.0.0.1:${process.env.GCBOT_PORT || 8097}/health`;
  let health;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    health = await res.json();
  } catch (err) {
    console.error(`gcbot is not answering on ${url} (${err.cause?.code ?? err.message})`);
    return 2;
  }
  if (alive) return 0;
  console.log(JSON.stringify(health));
  const problems = verdict(health);
  for (const p of problems) console.error(`gcbot: ${p}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then((code) => process.exit(code));
}
