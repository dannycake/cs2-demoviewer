import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { FULL_GAME_INFO, RECENT_GAMES, ResolveError, createResolver } from '../src/resolver.mjs';
import { decodeShareCode } from '../src/sharecode.mjs';
import { createServer } from '../src/server.mjs';
import { fakeGc, listData, match, replayUrl } from './fixtures.mjs';

const CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
const ANSWER = {
  matchId: '3230642215713767580',
  url: 'http://replay183.valve.net/730/003230642215713767580_1612365234.dem.bz2',
  playedAt: 1_760_000_000,
  info: { matchid: '3230642215713767580', roundstatsall: [{ reservation: { game_type: 8 } }] },
};
const STEAMID = '76561198000000001';
const RECENT = {
  matches: [
    {
      matchId: '3230642215713767580',
      sharecode: CODE,
      url: ANSWER.url,
      playedAt: 1_760_000_000,
      map: 'de_mirage',
    },
    { matchId: '3230642215713767000', sharecode: null, url: null, playedAt: null, map: null },
  ],
  list: { msgrequestid: 9141, accountid: 39_734_273 },
};

describe('server', () => {
  const calls = [];
  const lines = [];
  let fail = null;
  const resolver = {
    async resolve(code) {
      calls.push(code);
      if (fail) throw new ResolveError(fail);
      return ANSWER;
    },
    async recent(steamid) {
      calls.push(steamid);
      if (fail) throw Object.assign(new ResolveError(fail), { ignored: [] });
      return RECENT;
    },
    pending: () => 3,
  };
  const health = () => ({ steam: 'online', gc: true, tokenExpiresAt: '2027-05-01T00:00:00.000Z' });
  let server;
  let base;

  before(async () => {
    server = createServer({ resolver, health, log: (line) => lines.push(line) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const post = (body, headers = { 'content-type': 'application/json' }) =>
    fetch(`${base}/resolve`, { method: 'POST', headers, body });
  const postRecent = (body) =>
    fetch(`${base}/recent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

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

  it("lists a player's recent matches, and logs the id, the count and the time", async () => {
    fail = null;
    calls.length = 0;
    lines.length = 0;
    const res = await postRecent(JSON.stringify({ steamid: STEAMID }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { matches: RECENT.matches });
    assert.deepEqual(calls, [STEAMID]);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^recent: 76561198000000001: 2 matches in \d+ ms \(msgrequestid 9141, accountid 39734273\)$/
    );
  });

  it('answers 400 to anything but a SteamID64 without asking', async () => {
    fail = null;
    calls.length = 0;
    for (const body of [
      JSON.stringify({ steamid: '123' }),
      JSON.stringify({ steamid: '76561197960265728' }),
      JSON.stringify({ steamid: 76561198000000001 }),
      JSON.stringify({ steamid: `https://steamcommunity.com/profiles/${STEAMID}` }),
      JSON.stringify({ sharecode: CODE }),
      JSON.stringify([STEAMID]),
      JSON.stringify({ steamid: STEAMID, pad: 'x'.repeat(2048) }),
      STEAMID,
      '',
    ]) {
      const res = await postRecent(body);
      assert.equal(res.status, 400, body.slice(0, 80));
      const json = await res.json();
      assert.equal(json.error, 'invalid');
      assert.equal(typeof json.message, 'string');
    }
    assert.equal(calls.length, 0);
  });

  it("maps recent's errors to statuses and logs each, with the lists a timeout ignored", async () => {
    for (const [code, status] of Object.entries({
      invalid: 400,
      offline: 503,
      busy: 503,
      timeout: 504,
    })) {
      fail = code;
      const res = await postRecent(JSON.stringify({ steamid: STEAMID }));
      assert.equal(res.status, status, code);
      const json = await res.json();
      assert.equal(json.error, code);
      assert.ok(json.message.length > 0);
    }
    lines.length = 0;
    const ignoring = resolver.recent;
    resolver.recent = async () => {
      throw Object.assign(new ResolveError('timeout'), {
        ignored: [{ msgrequestid: 9147, accountid: null, matches: 1 }],
      });
    };
    await (await postRecent(JSON.stringify({ steamid: STEAMID }))).json();
    resolver.recent = ignoring;
    fail = null;
    assert.match(
      lines[0],
      /^recent: 76561198000000001: timeout after \d+ ms; ignored 1 list: msgrequestid 9147, accountid null, 1 match$/
    );
  });

  it('answers 404 to other paths and 405 to other methods', async () => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/resolve`)).status, 405);
    assert.equal((await fetch(`${base}/recent`)).status, 405);
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

describe('server over the resolver', () => {
  it('answers a /resolve and a /recent in flight together, each with its own answer', async () => {
    // A fake GC that answers every request with the other kind's answer first (on the next
    // turn, as Steam would): each must still get its own.
    const gc = fakeGc({ now: () => Date.now() });
    const details = decodeShareCode(CODE);
    const later = (fn) => setImmediate(fn);
    const request = (...args) => {
      const stop = gc.request(...args);
      later(() => {
        gc.broadcast([], listData(RECENT_GAMES, 39_734_273));
        gc.broadcast([match(details)], listData(FULL_GAME_INFO));
      });
      return stop;
    };
    const requestRecent = (...args) => {
      const stop = gc.requestRecent(...args);
      later(() => {
        gc.broadcast([], listData(FULL_GAME_INFO));
        gc.broadcast(
          [match(details, { game_map: 'de_mirage' })],
          listData(RECENT_GAMES, 39_734_273)
        );
      });
      return stop;
    };
    const resolver = createResolver({ request, requestRecent, minIntervalMs: 0, timeoutMs: 5000 });
    const server = createServer({ resolver, health: () => ({}) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ask = (path, body) =>
      fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) }).then(async (res) => [
        res.status,
        await res.json(),
      ]);
    try {
      const [[resolveStatus, game], [recentStatus, recent]] = await Promise.all([
        ask('/resolve', { sharecode: CODE }),
        ask('/recent', { steamid: STEAMID }),
      ]);
      assert.equal(resolveStatus, 200);
      assert.equal(game.matchId, details.matchId);
      assert.equal(game.url, replayUrl(details));
      assert.equal(recentStatus, 200);
      assert.deepEqual(recent, {
        matches: [
          {
            matchId: details.matchId,
            sharecode: CODE,
            url: replayUrl(details),
            playedAt: 1_760_000_000,
            map: 'de_mirage',
          },
        ],
      });
      assert.equal(gc.sent.length, 2);
      assert.equal(gc.maxInFlight(), 1);
    } finally {
      server.close();
    }
  });
});
