import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { FULL_GAME_INFO, RECENT_GAMES, createResolver } from '../src/resolver.mjs';
import { decodeShareCode, encodeShareCode } from '../src/sharecode.mjs';
import { fakeClock, fakeGc, listData, match, replayUrl, tvPort } from './fixtures.mjs';

const CODES = [
  'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK',
  'CSGO-a2Ldn-UV5dC-xcA4b-tEeYt-7A2hP',
  'CSGO-Wn7xq-PQkbh-cDvzR-Y8mKd-HhTjB',
];
const DETAILS = decodeShareCode(CODES[0]);
const MATCH = DETAILS.matchId;
const URL = replayUrl(DETAILS);

/** Captures a promise's outcome without leaving a rejection unhandled. */
function outcome(promise) {
  const o = { done: false, value: undefined, error: undefined };
  promise.then(
    (value) => Object.assign(o, { done: true, value }),
    (error) => Object.assign(o, { done: true, error })
  );
  return o;
}

/** An answer without its `info` (the GC's whole match object, checked on its own). */
const withoutInfo = ({ info: _info, ...rest }) => rest;

/** A protobufjs Long, as globaloffensive decodes 64-bit fields. */
const long = (s) => ({ low: 1, high: 2, unsigned: true, toString: () => s });

describe('createResolver', () => {
  it('answers with the whole match info, longs as strings', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const r = outcome(resolver.resolve(CODES[0]));
    await clock.advance(0);
    const m = match(DETAILS);
    m.matchid = long(MATCH);
    m.roundstatsall.at(-1).reservation = {
      account_ids: [39734273, 39734274],
      game_type: 8,
      server_id: long('90012345678901234'),
      tournament_event: null,
    };
    m.roundstatsall.at(-1).blob = Buffer.from('bytes');
    m.watchablematchinfo.cl_decryptdata_key_pub = long('123');
    gc.sent[0].onList([m]);
    await clock.advance(0);
    const { info } = r.value;
    assert.equal(info.matchid, MATCH);
    assert.equal(info.roundstatsall.at(-1).reservation.server_id, '90012345678901234');
    assert.deepEqual(info.roundstatsall.at(-1).reservation.account_ids, [39734273, 39734274]);
    assert.equal(info.roundstatsall.at(-1).reservation.game_type, 8);
    assert.equal('blob' in info.roundstatsall.at(-1), false, 'bytes are dropped');
    assert.equal(info.watchablematchinfo.cl_decryptdata_key_pub, '123');
    assert.doesNotThrow(() => JSON.stringify(info));
  });

  it('runs lookups one at a time, at least 2000 ms apart', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const results = CODES.map((code) => outcome(resolver.resolve(code)));
    const answer = (i) => gc.sent[i].onList([match(gc.sent[i].details)]);
    await clock.advance(0);
    assert.equal(gc.sent.length, 1);
    // The GC takes 3 s over the first: the second waits for that answer, not just the spacing.
    await clock.advance(2999);
    assert.equal(gc.sent.length, 1);
    await clock.advance(1);
    answer(0);
    await clock.advance(0);
    assert.equal(gc.sent.length, 2);
    // The second is answered in 100 ms: the third still waits out the 2000 ms spacing.
    await clock.advance(100);
    answer(1);
    await clock.advance(1899);
    assert.equal(gc.sent.length, 2);
    await clock.advance(1);
    assert.equal(gc.sent.length, 3);
    answer(2);
    await clock.advance(0);
    assert.deepEqual(
      gc.sent.map((r) => r.at),
      [0, 3000, 5000]
    );
    assert.equal(gc.maxInFlight(), 1);
    assert.deepEqual(
      gc.sent.map((r) => r.cancelled),
      [true, true, true]
    );
    for (const r of results) assert.equal(r.done && r.error, undefined);
    assert.deepEqual(withoutInfo(results[0].value), { matchId: MATCH, url: URL, playedAt: 1_760_000_000 });
  });

  it('rejects the 21st waiting lookup with busy', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const first = outcome(resolver.resolve(CODES[0])); // in flight, never answered
    const waiting = Array.from({ length: 20 }, () => outcome(resolver.resolve(CODES[1])));
    const over = outcome(resolver.resolve(CODES[2]));
    await clock.advance(0);
    assert.equal(over.error?.code, 'busy');
    assert.equal(first.done, false);
    assert.ok(waiting.every((w) => !w.done));
    assert.equal(resolver.pending(), 21);
  });

  it('times out at 20000 ms and moves on after 10 s of quiet', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const slow = outcome(resolver.resolve(CODES[0]));
    const next = outcome(resolver.resolve(CODES[1]));
    await clock.advance(19_999);
    assert.equal(slow.done, false);
    await clock.advance(1);
    assert.equal(slow.error?.code, 'timeout');
    assert.equal(gc.sent[0].cancelled, true);
    // A late answer for the abandoned lookup changes nothing.
    gc.sent[0].onList([match(DETAILS)]);
    await clock.advance(9_999);
    assert.equal(gc.sent.length, 1);
    await clock.advance(1);
    assert.equal(gc.sent.length, 2);
    assert.equal(gc.sent[1].at, 30_000);
    assert.equal(next.done, false);
  });

  it("does not take a late empty answer to a timed-out lookup as the next one's", async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const slow = outcome(resolver.resolve(CODES[0]));
    const next = outcome(resolver.resolve(CODES[1]));
    await clock.advance(20_000);
    assert.equal(slow.error?.code, 'timeout');
    // The GC answers the abandoned lookup 9 s late, empty as for an unknown code.
    await clock.advance(9_000);
    gc.broadcast([]);
    await clock.advance(1_000);
    assert.equal(gc.sent.length, 2);
    assert.equal(next.done, false);
    const details = gc.sent[1].details;
    gc.broadcast([match(details)]);
    await clock.advance(0);
    assert.equal(next.value?.matchId, details.matchId);
  });

  it('rejects at once with offline while offline', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => false });
    const r = outcome(resolver.resolve(CODES[0]));
    await clock.advance(0);
    assert.equal(r.error?.code, 'offline');
    assert.equal(gc.sent.length, 0);
  });

  it('fails the lookup in flight and all waiting within a second of going offline', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    let online = true;
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => online });
    const all = CODES.map((code) => outcome(resolver.resolve(code)));
    await clock.advance(500);
    online = false;
    await clock.advance(1000);
    assert.deepEqual(
      all.map((r) => r.error?.code),
      ['offline', 'offline', 'offline']
    );
    assert.equal(gc.sent.length, 1);
    assert.equal(resolver.pending(), 0);
  });

  it('maps a match without a URL to expired and an empty list to not_found', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const expired = outcome(resolver.resolve(CODES[0]));
    await clock.advance(0);
    gc.sent[0].onList([match(DETAILS, { map: null })]);
    const missing = outcome(resolver.resolve(CODES[1]));
    await clock.advance(2000);
    gc.sent[1].onList([]);
    await clock.advance(0);
    assert.equal(expired.error?.code, 'expired');
    assert.equal(missing.error?.code, 'not_found');
  });

  it('ignores a matchList for another match id', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const r = outcome(resolver.resolve(CODES[0]));
    await clock.advance(0);
    gc.sent[0].onList([match({ ...DETAILS, matchId: '1234567890' })]);
    await clock.advance(100);
    assert.equal(r.done, false);
    gc.sent[0].onList([match(DETAILS, { matchtime: null })]);
    await clock.advance(0);
    assert.deepEqual(withoutInfo(r.value), { matchId: MATCH, url: URL, playedAt: null });
  });

  it('encodes codes for the tests as decodeShareCode reads them', () => {
    for (const code of CODES) assert.equal(encodeShareCode(decodeShareCode(code)), code);
  });

  it('takes an answer only for the whole code: match id, reservation id and TV port', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const r = outcome(resolver.resolve(CODES[0]));
    await clock.advance(0);
    // The same match under another reservation id or TV port is another code's answer, also
    // when it says the match expired; so is one that leaves out either.
    const port = tvPort(DETAILS);
    for (const other of [
      match(DETAILS, { reservationid: '1' }),
      match(DETAILS, { tv_port: port + 1 }),
      match(DETAILS, { reservationid: '1', map: null }),
      match(DETAILS, { tv_port: port - 1, map: null }),
      match(DETAILS, { reservationid: null }),
      { ...match(DETAILS), watchablematchinfo: null },
      { ...match(DETAILS), roundstatsall: [] },
    ]) {
      gc.sent[0].onList([other]);
      await clock.advance(100);
      assert.equal(r.done, false, JSON.stringify(other));
    }
    // Only the TV port's low 16 bits are in the code.
    gc.sent[0].onList([match(DETAILS, { tv_port: port + 65_536 })]);
    await clock.advance(0);
    assert.deepEqual(withoutInfo(r.value), { matchId: MATCH, url: URL, playedAt: 1_760_000_000 });
  });

  it('does not give a late answer to one code to another code of the same match', async () => {
    // Security review 2026-10-23: a lookup times out; a code naming the same match with another
    // outcome id and token (anyone can write one) is sent after the quiet; the GC's late answer
    // to the first reaches it, and must not be taken as the forgery's.
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const real = outcome(resolver.resolve(CODES[0]));
    const forged = encodeShareCode({ ...DETAILS, outcomeId: '1', token: 1 });
    const forgery = outcome(resolver.resolve(forged));
    await clock.advance(20_000);
    assert.equal(real.error?.code, 'timeout');
    await clock.advance(10_000);
    assert.equal(gc.sent.length, 2);
    assert.equal(gc.sent[1].code, forged);
    assert.equal(gc.sent[1].details.matchId, MATCH);
    gc.broadcast([match(DETAILS)]);
    await clock.advance(100);
    assert.equal(forgery.done, false);
    // Valve sends nothing for the forgery, which times out without the real code's URL.
    await clock.advance(19_900);
    assert.equal(forgery.error?.code, 'timeout');
    assert.equal(forgery.value, undefined);
  });

  it('rejects a code that does not decode with invalid', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    const r = outcome(resolver.resolve('CSGO-IIIII-jjyJ8-cSP2r-smZRo-TO2xK'));
    await clock.advance(0);
    assert.equal(r.error?.code, 'invalid');
    assert.equal(gc.sent.length, 0);
  });

  it('treats a request the GC layer refuses as offline', async () => {
    const clock = fakeClock();
    const resolver = createResolver({
      request: () => {
        throw new Error('not connected to the GC');
      },
      clock,
      isOnline: () => true,
    });
    const r = outcome(resolver.resolve(CODES[0]));
    await clock.advance(0);
    assert.equal(r.error?.code, 'offline');
  });

  it('drops a waiting lookup whose caller gave up', async () => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({ request: gc.request, clock, isOnline: () => true });
    outcome(resolver.resolve(CODES[0]));
    const gone = new AbortController();
    const r = outcome(resolver.resolve(CODES[1], { signal: gone.signal }));
    await clock.advance(0);
    gone.abort();
    await clock.advance(0);
    assert.ok(r.error);
    assert.equal(resolver.pending(), 1);
    await clock.advance(30_000);
    assert.equal(gc.sent.length, 1);
  });
});

// The alt of fixtures.mjs's tokens: 76561197960265728 + its account id.
const STEAMID = '76561198000000001';
const ACCOUNT = 39_734_273;
const recentList = (accountid = ACCOUNT) => listData(RECENT_GAMES, accountid);
const gameList = () => listData(FULL_GAME_INFO);

describe('createResolver: recent matches', () => {
  const start = (isOnline = () => true) => {
    const clock = fakeClock();
    const gc = fakeGc(clock);
    const resolver = createResolver({
      request: gc.request,
      requestRecent: gc.requestRecent,
      clock,
      isOnline,
    });
    return { clock, gc, resolver };
  };

  it("names the GC's message ids as globaloffensive does", () => {
    const language = createRequire(import.meta.url)('globaloffensive/language.js');
    assert.equal(RECENT_GAMES, language.MatchListRequestRecentUserGames);
    assert.equal(FULL_GAME_INFO, language.MatchListRequestFullGameInfo);
  });

  it('lists the matches newest first, each with its share code, URL, time and map', async () => {
    const { clock, gc, resolver } = start();
    const r = outcome(resolver.recent(STEAMID));
    await clock.advance(0);
    assert.equal(gc.sent.length, 1);
    assert.equal(gc.sent[0].steamid, STEAMID);
    const older = decodeShareCode(CODES[1]);
    const expired = decodeShareCode(CODES[2]);
    gc.sent[0].onList(
      [
        match(older, { matchtime: 1_760_000_000, game_map: 'de_inferno' }),
        match(expired, { matchtime: 1_750_000_000, map: null }),
        // Only the TV port's low 16 bits are in the code.
        match(DETAILS, {
          matchtime: 1_760_050_000,
          tv_port: tvPort(DETAILS) + 65_536,
          game_map: 'de_mirage',
        }),
      ],
      recentList()
    );
    await clock.advance(0);
    // CODES[0] is akiver/csgo-sharecode's README vector: match 3230642215713767580, outcome
    // (reservation) 3230647599455273103, token 55788.
    assert.deepEqual(r.value.matches, [
      {
        matchId: '3230642215713767580',
        sharecode: 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK',
        url: URL,
        playedAt: 1_760_050_000,
        map: 'de_mirage',
      },
      {
        matchId: older.matchId,
        sharecode: CODES[1],
        url: replayUrl(older),
        playedAt: 1_760_000_000,
        map: 'de_inferno',
      },
      {
        matchId: expired.matchId,
        sharecode: CODES[2],
        url: null,
        playedAt: 1_750_000_000,
        map: null,
      },
    ]);
    assert.deepEqual(r.value.list, { msgrequestid: RECENT_GAMES, accountid: ACCOUNT });
    assert.equal(gc.sent[0].cancelled, true);
  });

  it('gives a match without a reservation id or TV port no share code, and drops one without an id', async () => {
    const { clock, gc, resolver } = start();
    const r = outcome(resolver.recent(STEAMID));
    await clock.advance(0);
    gc.sent[0].onList(
      [
        match(DETAILS, { reservationid: null, matchtime: null }),
        { ...match(decodeShareCode(CODES[1])), watchablematchinfo: null },
        { ...match(decodeShareCode(CODES[2])), matchid: null },
      ],
      recentList()
    );
    await clock.advance(0);
    assert.deepEqual(r.value.matches, [
      {
        matchId: decodeShareCode(CODES[1]).matchId,
        sharecode: null,
        url: replayUrl(decodeShareCode(CODES[1])),
        playedAt: 1_760_000_000,
        map: null,
      },
      { matchId: MATCH, sharecode: null, url: URL, playedAt: null, map: null },
    ]);
  });

  it('answers an empty list tagged with the player with no matches', async () => {
    const { clock, gc, resolver } = start();
    const r = outcome(resolver.recent(STEAMID));
    await clock.advance(0);
    gc.sent[0].onList([], recentList());
    await clock.advance(0);
    assert.deepEqual(r.value?.matches, []);
  });

  // The GC tags its answer to a recent-games request with the player's account id (seen in
  // production, 2026-10-28); a list without one may be a late answer to something else.
  it('takes no list that does not name the player', async () => {
    for (const data of [listData(null), listData(RECENT_GAMES)]) {
      const { clock, gc, resolver } = start();
      const r = outcome(resolver.recent(STEAMID));
      await clock.advance(0);
      gc.sent[0].onList([match(DETAILS)], data);
      await clock.advance(20_000);
      assert.equal(r.error?.code, 'timeout', JSON.stringify(data));
      assert.equal(r.error.ignored.length, 1, JSON.stringify(data));
    }
  });

  it('times out at 20000 ms when the GC sends nothing of its own, naming what it ignored', async () => {
    const { clock, gc, resolver } = start();
    const r = outcome(resolver.recent(STEAMID));
    const next = outcome(resolver.resolve(CODES[0]));
    await clock.advance(0);
    gc.sent[0].onList([match(DETAILS)], gameList());
    await clock.advance(19_999);
    assert.equal(r.done, false);
    await clock.advance(1);
    assert.equal(r.error?.code, 'timeout');
    assert.deepEqual(r.error.ignored, [
      { msgrequestid: FULL_GAME_INFO, accountid: null, matches: 1 },
    ]);
    assert.equal(gc.sent[0].cancelled, true);
    // The same quiet after it as after a share code's timeout.
    await clock.advance(9_999);
    assert.equal(gc.sent.length, 1);
    await clock.advance(1);
    assert.equal(gc.sent[1].code, CODES[0]);
    assert.equal(next.done, false);
  });

  it('runs share codes and recent games through one queue, each taking only its own answer', async () => {
    const { clock, gc, resolver } = start();
    const game = outcome(resolver.resolve(CODES[0]));
    const recent = outcome(resolver.recent(STEAMID));
    assert.equal(resolver.pending(), 2);
    await clock.advance(0);
    assert.equal(gc.sent.length, 1);
    // A recent-games list is never a share code's answer: empty, it would have been not_found;
    // naming the match, it is still not the answer to this request.
    gc.broadcast([], recentList());
    gc.broadcast([match(DETAILS)], recentList());
    await clock.advance(100);
    assert.equal(game.done, false);
    gc.broadcast([match(DETAILS)], gameList());
    await clock.advance(0);
    assert.equal(game.value?.matchId, MATCH);
    await clock.advance(1900);
    assert.equal(gc.sent.length, 2);
    assert.equal(gc.sent[1].steamid, STEAMID);
    // A share code's answer (here empty, as for an unknown code) and another player's list are
    // not this player's recent games.
    gc.broadcast([], gameList());
    gc.broadcast([match(DETAILS)], gameList());
    gc.broadcast([match(decodeShareCode(CODES[1]))], recentList(ACCOUNT + 1));
    await clock.advance(100);
    assert.equal(recent.done, false);
    gc.broadcast([match(decodeShareCode(CODES[2]))], recentList());
    await clock.advance(0);
    assert.deepEqual(
      recent.value?.matches.map((m) => m.sharecode),
      [CODES[2]]
    );
    assert.equal(gc.maxInFlight(), 1);
    assert.deepEqual(
      gc.sent.map((r) => r.at),
      [0, 2000]
    );
  });

  it('rejects what is not a SteamID64 with invalid, asking the GC nothing', async () => {
    const { clock, gc, resolver } = start();
    const all = ['76561197960265728', '7656119800000000', 76561198000000001, null].map((id) =>
      outcome(resolver.recent(id))
    );
    await clock.advance(0);
    assert.deepEqual(
      all.map((r) => r.error?.code),
      ['invalid', 'invalid', 'invalid', 'invalid']
    );
    assert.equal(gc.sent.length, 0);
  });

  it('shares the queue limit and the offline rule with share codes', async () => {
    const { clock, resolver } = start();
    outcome(resolver.resolve(CODES[0])); // in flight, never answered
    for (let i = 0; i < 20; i++) outcome(resolver.recent(STEAMID));
    const over = outcome(resolver.recent(STEAMID));
    await clock.advance(0);
    assert.equal(over.error?.code, 'busy');
    assert.equal(resolver.pending(), 21);

    const offline = start(() => false);
    const r = outcome(offline.resolver.recent(STEAMID));
    await offline.clock.advance(0);
    assert.equal(r.error?.code, 'offline');
    assert.equal(offline.gc.sent.length, 0);
  });
});
