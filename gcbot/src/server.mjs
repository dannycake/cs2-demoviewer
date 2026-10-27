// gcbot's HTTP API, on the stack network only (never published):
//   GET  /health  → 200 {"steam":"online"|"offline","gc":bool,"tokenExpiresAt":ISO|null,"queued":n}
//   POST /resolve {"sharecode":"CSGO-…"} → 200 {"matchId","url","playedAt"}
//                 or {"error","message"}: 400 invalid, 404 expired, 404 not_found,
//                 503 offline, 503 busy, 504 timeout.
// `node src/server.mjs` runs it: env STEAM_REFRESH_TOKEN, GCBOT_STATE (/state), GCBOT_PORT (8097),
// GCBOT_HOST (0.0.0.0).
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createResolver, ResolveError } from './resolver.mjs';
import { extractShareCode } from './sharecode.mjs';

/** Request bodies are a share code in JSON: anything bigger is not one. */
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

async function handleResolve(req, res, resolver, log) {
  const body = await readBody(req);
  if (body === null) {
    res.setHeader('connection', 'close');
    return send(res, 400, invalid(`The body is over ${MAX_BODY} bytes`));
  }
  let sharecode;
  try {
    sharecode = JSON.parse(body)?.sharecode;
  } catch {
    sharecode = undefined;
  }
  const code = extractShareCode(sharecode);
  if (!code) {
    return send(res, 400, invalid('Send {"sharecode":"CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"}'));
  }
  // A caller that hangs up while its lookup still waits takes it out of the queue.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  const started = Date.now();
  try {
    const answer = await resolver.resolve(code, { signal: gone.signal });
    log(`resolve: match ${answer.matchId} in ${Date.now() - started} ms`);
    send(res, 200, answer);
  } catch (err) {
    if (gone.signal.aborted) return;
    if (err instanceof ResolveError && STATUS[err.code]) {
      log(`resolve: ${err.code} after ${Date.now() - started} ms`);
      return send(res, STATUS[err.code], { error: err.code, message: err.message });
    }
    log(`resolve: unexpected ${err?.stack ?? err}`);
    send(res, 500, { error: 'internal', message: 'gcbot failed; see its log' });
  }
}

/** The HTTP server over a resolver (`resolve`, `pending`) and `health()` (steam.mjs's). */
export function createServer({ resolver, health, log = () => {} }) {
  const server = http.createServer((req, res) => {
    // The target as sent, not `new URL(req.url, …)`: that throws on one like `http://[`, and a
    // throw here would end the process.
    const pathname = req.url.split('?')[0];
    const route = { '/health': 'GET', '/resolve': 'POST' }[pathname];
    if (!route) return send(res, 404, { error: 'no_route', message: `No route ${pathname}` });
    if (req.method !== route) {
      res.setHeader('allow', route);
      return send(res, 405, { error: 'method', message: `${pathname} takes ${route}` });
    }
    if (pathname === '/health') return send(res, 200, { ...health(), queued: resolver.pending() });
    handleResolve(req, res, resolver, log).catch((err) => {
      log(`resolve: ${err?.stack ?? err}`);
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
  const resolver = createResolver({ request: steam.request, isOnline: steam.isOnline });
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
