// Share code → replay URL, one Game Coordinator request at a time and at least `minIntervalMs`
// apart: the GC throttles an account that asks faster and then answers nothing. Lookups wait in
// a queue of at most `maxWaiting`; while Steam or the GC is down every lookup, queued or in
// flight, fails as `offline` within a second instead of waiting out `timeoutMs`. After a
// timeout the GC is left alone for QUIET_AFTER_TIMEOUT_MS before the next request, and an answer
// counts only for the whole code it was asked about (match id, reservation id and TV port).
import { decodeShareCode } from './sharecode.mjs';

const MESSAGES = {
  invalid: 'That is not a match share code',
  expired: 'Valve knows this match but no longer has its replay (they keep them about a month)',
  not_found: 'Valve has no match for this code (crosshair codes look the same)',
  offline: 'Not connected to Steam and the CS2 Game Coordinator',
  busy: 'Too many share codes are waiting to be looked up',
  timeout: 'The Game Coordinator did not answer',
};

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
// (`isFor`). An empty matchList (an unknown code) cannot say which request it answers, so a late
// one for a timed-out lookup would fail the next lookup as not_found: it arrives in this quiet,
// with no lookup listening. An answer later still than timeout + quiet can do it.
const QUIET_AFTER_TIMEOUT_MS = 10_000;

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

/**
 * The answer in one `matchList` for the code with these `details`: a value or an error, or null
 * when the list is about another code (not ours to take). The URL is the last round's `map`; a
 * known match without one has expired.
 */
function answerFor(matches, details) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return { error: new ResolveError('not_found') };
  }
  const match = matches.find((m) => isFor(m, details));
  if (!match) return null;
  const url = match.roundstatsall.at(-1).map;
  if (typeof url !== 'string' || url === '') return { error: new ResolveError('expired') };
  const playedAt =
    Number.isInteger(match.matchtime) && match.matchtime > 0 ? match.matchtime : null;
  return { value: { matchId: details.matchId, url, playedAt } };
}

/**
 * `request(code, details, onList)` sends one GC request and calls `onList(matches)` for every
 * `matchList` the GC sends until the function it returns is called; it throws when it cannot
 * send. `isOnline()` says whether Steam and the GC are connected. `clock` is for tests.
 *
 * Returns `{ resolve(code, { signal }), pending() }`: `resolve` gives
 * `{ matchId, url, playedAt }` or rejects with a ResolveError; `signal` drops a lookup whose
 * caller has gone while it still waits; `pending()` counts lookups not yet answered.
 */
export function createResolver({
  request,
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
    timer = clock.setTimeout(() => {
      nextSendAt = Math.max(nextSendAt, clock.now() + QUIET_AFTER_TIMEOUT_MS);
      finish(new ResolveError('timeout'));
    }, timeoutMs);
    watch = clock.setTimeout(checkOnline, ONLINE_CHECK_MS);
    try {
      const stop = request(job.code, job.details, (matches) => {
        const answer = answerFor(matches, job.details);
        if (answer) finish(answer.error, answer.value);
      });
      cancel = typeof stop === 'function' ? stop : () => {};
      if (job.done) cancel(); // answered before `request` returned
    } catch {
      finish(new ResolveError('offline'));
    }
  }

  function resolve(code, { signal } = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      const job = {
        code,
        details: decodeShareCode(code),
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
      if (!job.details) return fail(job, 'invalid');
      if (!isOnline()) return fail(job, 'offline');
      if (waiting.length >= maxWaiting) return fail(job, 'busy');
      if (signal?.aborted) return job.settle(signal.reason ?? new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(job);
      pump();
    });
  }

  return {
    resolve,
    pending: () => waiting.length + (current && !current.done ? 1 : 0),
  };
}
