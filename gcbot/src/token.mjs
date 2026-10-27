// The alt's Steam refresh token: a JWT (about 200 days) that gcbot logs on with. It comes from
// two places, the env (STEAM_REFRESH_TOKEN, rendered from gcbot.env.tpl or written by hand) and
// the state volume (where login.mjs --state and every renewal write it); the later expiry wins.
// Never logged, never in argv.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'refresh-token';

/** The JWT's payload, or null when it is not one. */
function claims(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** When the token expires (its `exp`), or null when it is malformed. */
export function expiresAt(jwt) {
  const exp = claims(jwt)?.exp;
  return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null;
}

/**
 * A Steam client refresh token that has not expired: what steam-user's `logOn` accepts. Anything
 * else would make it throw from a timer (an unhandled rejection), so it is never handed over.
 */
export function usableToken(jwt, now = Date.now()) {
  const c = claims(jwt);
  const expiry = expiresAt(jwt);
  return (
    c?.iss === 'steam' &&
    Array.isArray(c.aud) &&
    c.aud.includes('client') &&
    expiry !== null &&
    expiry.getTime() > now
  );
}

/**
 * The token to log on with: the one that expires later; a malformed one loses to a readable
 * one; null when there is neither.
 */
export function chooseToken(envToken, stateToken) {
  const env = envToken || null;
  const state = stateToken || null;
  const envExp = expiresAt(env);
  const stateExp = expiresAt(state);
  if (envExp && stateExp) return stateExp > envExp ? state : env;
  if (envExp) return env;
  if (stateExp) return state;
  return env ?? state;
}

/** The token saved in `dir`, or null when none is. */
export function loadToken(dir) {
  try {
    return fs.readFileSync(path.join(dir, FILE), 'utf8').trim() || null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Writes `dir/refresh-token` (mode 600) through `refresh-token.tmp`, fsynced and renamed, so a
 * crash leaves the old token or the new one and never half of either. Synchronous on purpose: a
 * renewed token is on disk before any other code runs.
 */
export function saveToken(dir, token) {
  const tmp = path.join(dir, `${FILE}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600); // open's mode only applies to a new file, not a leftover .tmp
    fs.writeFileSync(fd, token);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path.join(dir, FILE));
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}
