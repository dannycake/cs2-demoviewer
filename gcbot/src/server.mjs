// gcbot's HTTP API, on the stack network only (never published):
//   GET  /health  → 200 {"steam":"online"|"offline","gc":bool,"tokenExpiresAt":ISO|null,"queued":n}
//   POST /resolve {"sharecode":"CSGO-…"} → 200 {"matchId","url","playedAt","info"}
//                 (`info`: the GC's whole match object, 64-bit numbers as strings, bytes dropped)
//                 or {"error","message"}: 400 invalid, 404 expired, 404 not_found,
//                 503 offline, 503 busy, 504 timeout.
//   POST /recent  {"steamid":"7656119…"} → 200 {"matches":[{"matchId","sharecode","url",
//                 "playedAt","map"}…]} (the GC's recent matches for that player, newest first;
//                 maybe none)
//                 or {"error","message"}: 400 invalid, 503 offline, 503 busy, 504 timeout.
// `node src/server.mjs` runs it: env STEAM_REFRESH_TOKEN, GCBOT_STATE (/state), GCBOT_PORT (8097),
// GCBOT_HOST (0.0.0.0).
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createResolver, ResolveError } from './resolver.mjs';
import { extractShareCode } from './sharecode.mjs';
import { accountIdOf } from './steamid.mjs';

/** Request bodies are a share code or a SteamID in JSON: anything bigger is not one. */
export const MAX_BODY = 1024;

const STATUS = {
  invalid: 400,
  expired: 404,
  not_found: 404,
  offline: 503,
  busy: 503,
  timeout: 504,
};

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

const invalid = (message) => ({ error: 'invalid', message });

/** The body as a string, or null once it passes MAX_BODY (the rest is discarded). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume();
      return resolve(null);
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// What readField gives once it has answered a body over MAX_BODY itself.
const TOO_BIG = Symbol('too big');

/** The JSON body's `field` (undefined when the body is not such JSON), or TOO_BIG, answered. */
async function readField(req, res, field) {
  const body = await readBody(req);
  if (body === null) {
    res.setHeader('connection', 'close');
    send(res, 400, invalid(`The body is over ${MAX_BODY} bytes`));
    return TOO_BIG;
  }
  try {
    return JSON.parse(body)?.[field];
  } catch {
    return undefined;
  }
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const tags = ({ msgrequestid, accountid }) =>
  `msgrequestid ${msgrequestid ?? null}, accountid ${accountid ?? null}`;

/** A failure's log line: its code and, for a timeout, the GC's lists the lookup did not take. */
function failed(err, ms) {
  const ignored = Array.isArray(err.ignored) ? err.ignored : [];
  const lists = ignored.map((l) => `${tags(l)}, ${count(l.matches, 'match', 'matches')}`);
  const also = lists.length
    ? `; ignored ${count(lists.length, 'list', 'lists')}: ${lists.join('; ')}`
    : '';
  return `${err.code} after ${ms} ms${also}`;
}

/**
 * Sends `lookup(signal)`'s value as `body(value)` makes it, or its ResolveError with the status
 * STATUS gives, and logs one line `<prefix>: …` either way (`said(value, ms)` on success). A
 * caller that hangs up while its lookup still waits takes it out of the queue (`signal`).
 */
async function answer(res, log, prefix, lookup, { said, body }) {
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  const started = Date.now();
  try {
    const value = await lookup(gone.signal);
    log(`${prefix}: ${said(value, Date.now() - started)}`);
    send(res, 200, body(value));
  } catch (err) {
    if (gone.signal.aborted) return;
    if (err instanceof ResolveError && STATUS[err.code]) {
      log(`${prefix}: ${failed(err, Date.now() - started)}`);
      return send(res, STATUS[err.code], { error: err.code, message: err.message });
    }
    log(`${prefix}: unexpected ${err?.stack ?? err}`);
    send(res, 500, { error: 'internal', message: 'gcbot failed; see its log' });
  }
}

async function handleResolve(req, res, resolver, log) {
  const sharecode = await readField(req, res, 'sharecode');
  if (sharecode === TOO_BIG) return;
  const code = extractShareCode(sharecode);
  if (!code) {
    return send(res, 400, invalid('Send {"sharecode":"CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"}'));
  }
  await answer(res, log, 'resolve', (signal) => resolver.resolve(code, { signal }), {
    said: (found, ms) => `match ${found.matchId} in ${ms} ms`,
    body: (found) => found,
  });
}

async function handleRecent(req, res, resolver, log) {
  const steamid = await readField(req, res, 'steamid');
  if (steamid === TOO_BIG) return;
  if (accountIdOf(steamid) === null) {
    return send(res, 400, invalid('Send {"steamid":"<a player\'s 17-digit SteamID64>"}'));
  }
  await answer(res, log, `recent: ${steamid}`, (signal) => resolver.recent(steamid, { signal }), {
    said: ({ matches, list }, ms) =>
      `${count(matches.length, 'match', 'matches')} in ${ms} ms (${tags(list)})`,
    body: ({ matches }) => ({ matches }),
  });
}

const ROUTES = {
  '/health': { method: 'GET' },
  '/resolve': { method: 'POST', handle: handleResolve },
  '/recent': { method: 'POST', handle: handleRecent },
};

/**
 * The HTTP server over a resolver (`resolve`, `recent`, `pending`) and `health()` (steam.mjs's).
 */
export function createServer({ resolver, health, log = () => {} }) {
  const server = http.createServer((req, res) => {
    // The target as sent, not `new URL(req.url, …)`: that throws on one like `http://[`, and a
    // throw here would end the process.
    const pathname = req.url.split('?')[0];
    const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : null;
    if (!route) return send(res, 404, { error: 'no_route', message: `No route ${pathname}` });
    if (req.method !== route.method) {
      res.setHeader('allow', route.method);
      return send(res, 405, { error: 'method', message: `${pathname} takes ${route.method}` });
    }
    if (pathname === '/health') return send(res, 200, { ...health(), queued: resolver.pending() });
    route.handle(req, res, resolver, log).catch((err) => {
      log(`${pathname.slice(1)}: ${err?.stack ?? err}`);
      if (!res.headersSent)
        send(res, 500, { error: 'internal', message: 'gcbot failed; see its log' });
    });
  });
  // Bodies are tiny; a lookup's own wait (up to the queue's length in GC answers) is not limited
  // by these, which cover only receiving the request.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

async function main() {
  const { startSteam } = await import('./steam.mjs');
  const stateDir = process.env.GCBOT_STATE || '/state';
  const port = Number(process.env.GCBOT_PORT || 8097);
  const host = process.env.GCBOT_HOST || '0.0.0.0';
  const envToken = process.env.STEAM_REFRESH_TOKEN || null;
  delete process.env.STEAM_REFRESH_TOKEN;

  const steam = startSteam({ envToken, stateDir, log });
  const resolver = createResolver({
    request: steam.request,
    requestRecent: steam.requestRecent,
    isOnline: steam.isOnline,
  });
  const server = createServer({ resolver, health: steam.health, log });
  server.listen(port, host, () => log(`gcbot: listening on ${host}:${port}`));

  // PID 1 in the container: Node installs no default SIGTERM handler there.
  const shutdown = (signal) => {
    log(`gcbot: ${signal}, logging off`);
    steam.stop();
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    log(`gcbot: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
