import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verdict } from '../src/status.mjs';

const STATUS = fileURLToPath(new URL('../src/status.mjs', import.meta.url));
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-22T12:00:00Z');
const healthy = {
  steam: 'online',
  gc: true,
  tokenExpiresAt: new Date(NOW + 100 * DAY).toISOString(),
  queued: 0,
};

/** Runs status.mjs against a port; resolves to its exit code and output. */
const run = (port, ...args) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [STATUS, ...args],
      { env: { ...process.env, GCBOT_PORT: String(port) } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
    );
  });

/** A loopback port nothing listens on (bound, then closed). */
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('verdict', () => {
  it('is healthy with Steam and the GC up and the token good for more than a week', () => {
    assert.deepEqual(verdict(healthy, NOW), []);
  });

  it('names each problem', () => {
    assert.equal(verdict({ ...healthy, steam: 'offline' }, NOW).length, 1);
    assert.equal(verdict({ ...healthy, gc: false }, NOW).length, 1);
    const soon = new Date(NOW + 6 * DAY).toISOString();
    assert.match(verdict({ ...healthy, tokenExpiresAt: soon }, NOW)[0], /expires/);
    assert.equal(verdict({ ...healthy, tokenExpiresAt: null }, NOW).length, 1);
    assert.equal(verdict({ steam: 'offline', gc: false, tokenExpiresAt: null }, NOW).length, 3);
  });
});

describe('status.mjs', () => {
  it('exits 2 when nothing answers, with or without --alive', async () => {
    const port = await freePort();
    for (const args of [[], ['--alive']]) {
      const r = await run(port, ...args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.stderr, /not answering/);
    }
  });

  it('prints the health and exits 0 healthy, 1 not; --alive only checks it answers', async () => {
    let health = { ...healthy, tokenExpiresAt: new Date(Date.now() + 100 * DAY).toISOString() };
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      let r = await run(port);
      assert.equal(r.code, 0);
      assert.deepEqual(JSON.parse(r.stdout), health);
      health = { ...health, gc: false };
      r = await run(port);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Game Coordinator/);
      r = await run(port, '--alive');
      assert.equal(r.code, 0);
    } finally {
      server.close();
    }
  });
});
