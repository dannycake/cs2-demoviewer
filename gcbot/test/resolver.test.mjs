import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createResolver } from '../src/resolver.mjs';
import { decodeShareCode } from '../src/sharecode.mjs';
import { encodeShareCode, fakeClock } from './fixtures.mjs';

const CODES = [
  'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK',
  'CSGO-a2Ldn-UV5dC-xcA4b-tEeYt-7A2hP',
  'CSGO-Wn7xq-PQkbh-cDvzR-Y8mKd-HhTjB',
];
const DETAILS = decodeShareCode(CODES[0]);
const MATCH = DETAILS.matchId;

/** A TV port of the match `details` names: one whose low 16 bits are the code's token. */
const tvPort = (details) => 24_602 * 65_536 + details.token;

/** Valve's replay URL for the match `details` names: `/730/<reservation id>_<TV port>`. */
const replayUrl = (details) =>
  `http://replay183.valve.net/730/${details.outcomeId.padStart(21, '0')}_${String(
    tvPort(details)
  ).padStart(10, '0')}.dem.bz2`;
const URL = replayUrl(DETAILS);

/**
 * The GC's answer for the match a code names (`details` as decodeShareCode gives them), in the
 * shape globaloffensive decodes a real one into (as in CS2's `.dem.info` files): the reservation
 * id (the code's outcome id) and the URL ride on the last round's stats, the TV port on the
 * watchable match info.
 */
const match = (
  details,
  {
    map = replayUrl(details),
    matchtime = 1_760_000_000,
    reservationid = details.outcomeId,
    tv_port = tvPort(details),
  } = {}
) => ({
  matchid: details.matchId,
  matchtime,
  watchablematchinfo: { server_ip: 183, tv_port, tv_spectators: 0 },
  roundstatsall: [
    { reservationid: null, map: null },
    { reservationid, map },
  ],
});

/**
 * A fake GC: records each request and hands the test the request's `onList` so it can answer
 * (or not) whenever it likes. `broadcast` is what globaloffensive does with a `matchList`: it
 * reaches every listener still registered, whichever request it answers.
 */
function fakeGc(clock) {
  const sent = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const request = (code, details, onList) => {
    const entry = { code, details, at: clock.now(), onList, cancelled: false };
    sent.push(entry);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return () => {
      entry.cancelled = true;
      inFlight--;
    };
  };
  const broadcast = (matches) => {
    for (const entry of sent) if (!entry.cancelled) entry.onList(matches);
  };
  return { request, sent, broadcast, maxInFlight: () => maxInFlight };
}

/** Captures a promise's outcome without leaving a rejection unhandled. */
function outcome(promise) {
  const o = { done: false, value: undefined, error: undefined };
  promise.then(
    (value) => Object.assign(o, { done: true, value }),
    (error) => Object.assign(o, { done: true, error })
  );
  return o;
}

describe('createResolver', () => {
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
    assert.deepEqual(results[0].value, { matchId: MATCH, url: URL, playedAt: 1_760_000_000 });
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
    assert.deepEqual(r.value, { matchId: MATCH, url: URL, playedAt: null });
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
    assert.deepEqual(r.value, { matchId: MATCH, url: URL, playedAt: 1_760_000_000 });
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
