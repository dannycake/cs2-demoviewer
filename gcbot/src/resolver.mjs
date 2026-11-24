// Share code → replay URL, and SteamID64 → that player's recent matches, one Game Coordinator
// request at a time and at least `minIntervalMs` apart: the GC throttles an account that asks
// faster and then answers nothing. Lookups of both kinds wait in one queue of at most
// `maxWaiting`; while Steam or the GC is down every lookup, queued or in flight, fails as
// `offline` within a second instead of waiting out `timeoutMs`. After a timeout the GC is left
// alone for QUIET_AFTER_TIMEOUT_MS before the next request. An answer counts only for the whole
// code it was asked about (match id, reservation id and TV port), and a recent-games list only
// for a recent-games request about the same player.
import { decodeShareCode, encodeShareCode } from './sharecode.mjs';
import { accountIdOf } from './steamid.mjs';

const MESSAGES = {
  invalid: 'That is not a match share code',
  expired: 'Valve knows this match but no longer has its replay (they keep them about a month)',
  not_found: 'Valve has no match for this code (crosshair codes look the same)',
  offline: 'Not connected to Steam and the CS2 Game Coordinator',
  busy: 'Too many lookups are waiting for the Game Coordinator',
  timeout: 'The Game Coordinator did not answer',
};

/** `invalid`'s message for /recent. */
export const NOT_A_STEAMID = "That is not a player's SteamID64 (17 digits, 7656119…)";

/** A failed lookup; `code` is one of MESSAGES' keys (the HTTP API's `error`). */
export class ResolveError extends Error {
  constructor(code, message = MESSAGES[code] ?? code) {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

// How often a lookup in flight checks that Steam and the GC are still there.
const ONLINE_CHECK_MS = 1000;
// globaloffensive hands every `matchList` to every listener, so an answer to a lookup that timed
// out reaches the next one. A list about a match is taken only by the lookup for its whole code
// (`isFor`). An empty matchList (an unknown code) says which request it answers only through its
// msgrequestid, when the GC fills that in, so a late one for a timed-out lookup could fail the
// next lookup as not_found: it arrives in this quiet, with no lookup listening. An answer later
// still than timeout + quiet can do it.
const QUIET_AFTER_TIMEOUT_MS = 10_000;

/**
 * The request a MatchList answers, in its `msgrequestid` (globaloffensive's language.js): a share
 * code's (MatchListRequestFullGameInfo) or a player's recent games
 * (MatchListRequestRecentUserGames). The GC is not known to fill it in, and a list without it may
 * answer either; a list that names the other kind is never taken.
 */
export const FULL_GAME_INFO = 9147;
export const RECENT_GAMES = 9141;

/**
 * Whether the GC's match info `m` is about the code with these `details` as a whole: its match
 * id, its reservation id (the code's outcome id, on the last round's stats) and its TV port
 * (whose low 16 bits are the code's token, on the watchable match info). Anyone can write a code
 * naming a real match with another outcome id and token, which Valve refuses; taken by the match
 * id alone, the real code's late answer would hand that forgery the replay (security review
 * 2026-10-23).
 */
function isFor(m, { matchId, outcomeId, token }) {
  if (!m || String(m.matchid) !== matchId) return false;
  const rounds = Array.isArray(m.roundstatsall) ? m.roundstatsall : [];
  const port = m.watchablematchinfo?.tv_port;
  return (
    String(rounds.at(-1)?.reservationid) === outcomeId &&
    Number.isInteger(port) &&
    port % 0x10000 === token
  );
}

/** Whether `v` is a protobufjs Long, as globaloffensive decodes 64-bit fields. */
const isLong = (v) =>
  typeof v.low === 'number' &&
  typeof v.high === 'number' &&
  typeof v.unsigned === 'boolean' &&
  typeof v.toString === 'function';

/**
 * `v` as JSON can carry it: 64-bit Longs and bigints as decimal strings, bytes (Buffers, typed
 * arrays) and functions dropped, a non-finite number null; null for the whole when it cannot be
 * (a cycle).
 */
export function jsonSafe(v) {
  try {
    return safe(v, new Set()) ?? null;
  } catch {
    return null;
  }
}

function safe(v, seen) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'object') return undefined;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return undefined;
  if (isLong(v)) return v.toString();
  if (seen.has(v)) throw new Error('a cycle');
  seen.add(v);
  let out;
  if (Array.isArray(v)) {
    out = v.map((x) => safe(x, seen)).filter((x) => x !== undefined);
  } else {
    out = {};
    for (const [k, x] of Object.entries(v)) {
      const s = safe(x, seen);
      if (s !== undefined) out[k] = s;
    }
  }
  seen.delete(v);
  return out;
}

/**
 * The answer in one `matchList` for the code with these `details`: a value or an error, or null
 * when the list is about another code or answers a recent-games request (not ours to take). The
 * URL is the last round's `map`; a known match without one has expired.
 */
function answerFor(matches, data, details) {
  if (data?.msgrequestid === RECENT_GAMES) return null;
  if (!Array.isArray(matches) || matches.length === 0) {
    return { error: new ResolveError('not_found') };
  }
  const match = matches.find((m) => isFor(m, details));
  if (!match) return null;
  const url = match.roundstatsall.at(-1).map;
  if (typeof url !== 'string' || url === '') return { error: new ResolveError('expired') };
  const playedAt =
    Number.isInteger(match.matchtime) && match.matchtime > 0 ? match.matchtime : null;
  return { value: { matchId: details.matchId, url, playedAt, info: jsonSafe(match) } };
}

const playedAtOf = (m) => (Number.isInteger(m.matchtime) && m.matchtime > 0 ? m.matchtime : null);
const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

/**
 * One match of a recent-games list as /recent gives it: its share code is made from the very
 * fields isFor checks (the match id, the last round's reservation id, the TV port's low 16 bits),
 * so /resolve takes it for this match; null when the GC leaves one out.
 */
function recentMatch(m) {
  const matchId = String(m.matchid);
  const last = Array.isArray(m.roundstatsall) ? m.roundstatsall.at(-1) : undefined;
  const port = m.watchablematchinfo?.tv_port;
  const sharecode =
    last?.reservationid != null && Number.isInteger(port) && port >= 0
      ? encodeShareCode({ matchId, outcomeId: String(last.reservationid), token: port % 0x10000 })
      : null;
  return {
    matchId,
    sharecode,
    url: nonEmpty(last?.map),
    playedAt: playedAtOf(m),
    map: nonEmpty(m.watchablematchinfo?.game_map),
  };
}

/**
 * The answer in one `matchList` for the recent games of `accountId`, or null when it does not
 * name that player in its `accountid` (as the GC does for these, seen in production): a share
 * code's answer, another player's games, or a late list of anything else. Every match with an
 * id, newest first; an empty list is an answer too.
 */
function recentFor(matches, data, accountId) {
  if (data?.msgrequestid === FULL_GAME_INFO) return null;
  if (!data?.accountid || Number(data.accountid) !== accountId) return null;
  const listed = (Array.isArray(matches) ? matches : []).filter((m) => m?.matchid != null);
  const recent = listed.map(recentMatch);
  // Stable: matches without a time keep the GC's order, after the rest.
  recent.sort((a, b) => (b.playedAt ?? -1) - (a.playedAt ?? -1));
  const list = { msgrequestid: data?.msgrequestid ?? null, accountid: data?.accountid ?? null };
  return { value: { matches: recent, list } };
}

/** What a lookup's log says about a `matchList` it did not take. */
const ignoredList = (matches, data) => ({
  msgrequestid: data?.msgrequestid ?? null,
  accountid: data?.accountid ?? null,
  matches: Array.isArray(matches) ? matches.length : 0,
});

/**
 * `request(code, details, onList)` sends one share code's GC request and
 * `requestRecent(steamid, onList)` one player's recent games; each calls `onList(matches, data)`
 * for every `matchList` the GC sends until the function it returns is called (`data` the whole
 * message), and throws when it cannot send. `isOnline()` says whether Steam and the GC are
 * connected. `clock` is for tests.
 *
 * Returns `{ resolve(code, { signal }), recent(steamid, { signal }), pending() }`: `resolve`
 * gives `{ matchId, url, playedAt, info }` (`info` the GC's whole match object, `jsonSafe`);
 * `recent` gives `{ matches: [{ matchId, sharecode, url, playedAt, map }], list }` (`list` the
 * answer's msgrequestid and accountid, for the log); either rejects with a ResolveError, and a
 * timeout's `ignored` lists the matchLists it did not take. `signal` drops a lookup whose caller
 * has gone while it still waits; `pending()` counts lookups of both kinds not yet answered.
 */
export function createResolver({
  request,
  requestRecent,
  minIntervalMs = 2000,
  timeoutMs = 20000,
  maxWaiting = 20,
  isOnline = () => true,
  clock = realClock,
}) {
  const waiting = [];
  let current = null; // the lookup sent (or about to be, once the spacing allows)
  let nextSendAt = -Infinity;

  const fail = (job, code) => job.settle(new ResolveError(code));

  function pump() {
    if (current || waiting.length === 0) return;
    if (!isOnline()) {
      for (const job of waiting.splice(0)) fail(job, 'offline');
      return;
    }
    current = waiting.shift();
    const job = current;
    clock.setTimeout(() => send(job), Math.max(0, nextSendAt - clock.now()));
  }

  function next() {
    current = null;
    pump();
  }

  function send(job) {
    if (job.done) return next();
    if (!isOnline()) {
      fail(job, 'offline');
      return next();
    }
    job.sent = true;
    nextSendAt = clock.now() + minIntervalMs;
    let cancel = null;
    let timer = null;
    let watch = null;
    const finish = (error, value) => {
      if (job.done) return;
      clock.clearTimeout(timer);
      clock.clearTimeout(watch);
      cancel?.();
      job.settle(error, value);
      next();
    };
    const checkOnline = () => {
      if (!isOnline()) return finish(new ResolveError('offline'));
      watch = clock.setTimeout(checkOnline, ONLINE_CHECK_MS);
    };
    const ignored = [];
    timer = clock.setTimeout(() => {
      nextSendAt = Math.max(nextSendAt, clock.now() + QUIET_AFTER_TIMEOUT_MS);
      finish(Object.assign(new ResolveError('timeout'), { ignored }));
    }, timeoutMs);
    watch = clock.setTimeout(checkOnline, ONLINE_CHECK_MS);
    try {
      const stop = job.ask((matches, data) => {
        const answer = job.answer(matches, data);
        if (answer) finish(answer.error, answer.value);
        else ignored.push(ignoredList(matches, data));
      });
      cancel = typeof stop === 'function' ? stop : () => {};
      if (job.done) cancel(); // answered before `request` returned
    } catch {
      finish(new ResolveError('offline'));
    }
  }

  // Queues a lookup: `ask(onList)` sends its request, `answer(matches, data)` is its answer in
  // a matchList or null; `invalid`, when set, fails it at once.
  function enqueue({ ask, answer, invalid }, signal) {
    return new Promise((resolvePromise, rejectPromise) => {
      const job = {
        ask,
        answer,
        sent: false,
        done: false,
        settle(error, value) {
          if (job.done) return;
          job.done = true;
          signal?.removeEventListener('abort', onAbort);
          if (error) rejectPromise(error);
          else resolvePromise(value);
        },
      };
      const onAbort = () => {
        // Once sent, the GC's answer (or the timeout) still paces the next lookup.
        if (job.sent) return;
        const i = waiting.indexOf(job);
        if (i >= 0) waiting.splice(i, 1);
        job.settle(signal.reason ?? new Error('aborted'));
      };
      if (invalid) return job.settle(invalid);
      if (!isOnline()) return fail(job, 'offline');
      if (waiting.length >= maxWaiting) return fail(job, 'busy');
      if (signal?.aborted) return job.settle(signal.reason ?? new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(job);
      pump();
    });
  }

  function resolve(code, { signal } = {}) {
    const details = decodeShareCode(code);
    return enqueue(
      {
        ask: (onList) => request(code, details, onList),
        answer: (matches, data) => answerFor(matches, data, details),
        invalid: details ? null : new ResolveError('invalid'),
      },
      signal
    );
  }

  function recent(steamid, { signal } = {}) {
    const accountId = accountIdOf(steamid);
    return enqueue(
      {
        ask: (onList) => requestRecent(steamid, onList),
        answer: (matches, data) => recentFor(matches, data, accountId),
        invalid: accountId === null ? new ResolveError('invalid', NOT_A_STEAMID) : null,
      },
      signal
    );
  }

  return {
    resolve,
    recent,
    pending: () => waiting.length + (current && !current.done ? 1 : 0),
  };
}
