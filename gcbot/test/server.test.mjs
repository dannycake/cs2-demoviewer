import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { ResolveError } from '../src/resolver.mjs';
import { createServer } from '../src/server.mjs';

const CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
const ANSWER = {
  matchId: '3230642215713767580',
  url: 'http://replay183.valve.net/730/003230642215713767580_1612365234.dem.bz2',
  playedAt: 1_760_000_000,
};

describe('server', () => {
  const calls = [];
  let fail = null;
  const resolver = {
    async resolve(code) {
      calls.push(code);
      if (fail) throw new ResolveError(fail);
      return ANSWER;
    },
    pending: () => 3,
  };
  const health = () => ({ steam: 'online', gc: true, tokenExpiresAt: '2027-05-01T00:00:00.000Z' });
  let server;
  let base;

  before(async () => {
    server = createServer({ resolver, health, log: () => {} });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const post = (body, headers = { 'content-type': 'application/json' }) =>
    fetch(`${base}/resolve`, { method: 'POST', headers, body });

  it('answers /health with the Steam state and the queue', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ...health(), queued: 3 });
  });

  it('resolves a share code, also from inside a steam:// link', async () => {
    fail = null;
    calls.length = 0;
    let res = await post(JSON.stringify({ sharecode: CODE }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), ANSWER);
    const link = `steam://rungame/730/76561202255233023/+csgo_download_match%20${CODE}`;
    res = await post(JSON.stringify({ sharecode: link }));
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [CODE, CODE]);
  });

  it('answers 400 to a 2 KiB body without looking it up', async () => {
    calls.length = 0;
    const res = await post(JSON.stringify({ sharecode: CODE, pad: 'x'.repeat(2048) }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid');
    assert.equal(calls.length, 0);
  });

  it('answers 400 to a non-code and to a body that is not the JSON it wants', async () => {
    calls.length = 0;
    for (const body of [
      JSON.stringify({ sharecode: 'not a code' }),
      JSON.stringify({ sharecode: 'CSGO-GADqf-jjyJ8' }),
      JSON.stringify({ sharecode: 42 }),
      JSON.stringify({ url: CODE }),
      JSON.stringify([CODE]),
      'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK',
      '',
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, body);
      const json = await res.json();
      assert.equal(json.error, 'invalid', body);
      assert.equal(typeof json.message, 'string');
    }
    assert.equal(calls.length, 0);
  });

  it("maps the resolver's errors to statuses", async () => {
    const expected = {
      invalid: 400,
      expired: 404,
      not_found: 404,
      offline: 503,
      busy: 503,
      timeout: 504,
    };
    for (const [code, status] of Object.entries(expected)) {
      fail = code;
      const res = await post(JSON.stringify({ sharecode: CODE }));
      assert.equal(res.status, status, code);
      const json = await res.json();
      assert.equal(json.error, code);
      assert.ok(json.message.length > 0);
    }
    fail = null;
  });

  it('answers 404 to other paths and 405 to other methods', async () => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/resolve`)).status, 405);
    assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 405);
  });

  it('answers 404 to a request target no URL parser takes, and keeps running', async () => {
    const statusLine = await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1', () =>
        socket.write('GET http://[ HTTP/1.1\r\nHost: gcbot\r\nConnection: close\r\n\r\n')
      );
      let got = '';
      socket.on('data', (chunk) => (got += chunk));
      socket.on('end', () => resolve(got.split('\r\n')[0]));
      socket.on('error', reject);
    });
    assert.equal(statusLine, 'HTTP/1.1 404 Not Found');
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});
