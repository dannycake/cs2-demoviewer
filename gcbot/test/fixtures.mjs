// Shared test helpers (not a test file: package.json runs test/*.test.mjs only).
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A JWT with these claims, unsigned: nothing in gcbot checks signatures, Steam does. */
export const jwt = (claims) => `${b64({ typ: 'JWT', alg: 'EdDSA' })}.${b64(claims)}.c2ln`;

/** A Steam client refresh token's shape, expiring at `exp` (unix seconds). */
export const steamJwt = (exp) =>
  jwt({ iss: 'steam', sub: '76561198000000001', aud: ['client', 'web'], exp });

/**
 * A clock the resolver can run on: timers fire only from `advance`, in time order, with
 * pending promise callbacks run between them.
 */
export function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const t of timers.values()) {
          if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) {
            next = t;
          }
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = end;
      await flush();
    },
  };
}

/** A TV port of the match `details` names: one whose low 16 bits are the code's token. */
export const tvPort = (details) => 24_602 * 65_536 + details.token;

/** Valve's replay URL for the match `details` names: `/730/<reservation id>_<TV port>`. */
export const replayUrl = (details) =>
  `http://replay183.valve.net/730/${details.outcomeId.padStart(21, '0')}_${String(
    tvPort(details)
  ).padStart(10, '0')}.dem.bz2`;

/**
 * The GC's answer for the match a code names (`details` as decodeShareCode gives them), in the
 * shape globaloffensive decodes a real one into (as in CS2's `.dem.info` files): the reservation
 * id (the code's outcome id) and the URL ride on the last round's stats, the TV port and the map
 * on the watchable match info.
 */
export const match = (
  details,
  {
    map = replayUrl(details),
    matchtime = 1_760_000_000,
    reservationid = details.outcomeId,
    tv_port = tvPort(details),
    game_map = null,
  } = {}
) => ({
  matchid: details.matchId,
  matchtime,
  watchablematchinfo: { server_ip: 183, tv_port, tv_spectators: 0, game_map },
  roundstatsall: [
    { reservationid: null, map: null },
    { reservationid, map },
  ],
});

/**
 * The rest of a MatchList beside its matches, as globaloffensive hands it over (`data`):
 * `msgrequestid` the request it answers (resolver.mjs's FULL_GAME_INFO or RECENT_GAMES), and
 * `accountid` whose recent games it lists.
 */
export const listData = (msgrequestid, accountid = null) => ({
  msgrequestid,
  accountid,
  servertime: 1_760_100_000,
  matches: [],
  streams: [],
  tournamentinfo: null,
});

/**
 * A fake GC: records each request (a share code's or a player's recent games) and hands the
 * test the request's `onList` so it can answer (or not) whenever it likes. `broadcast` is what
 * globaloffensive does with a `matchList`: it reaches every listener still registered, whichever
 * request it answers.
 */
export function fakeGc(clock) {
  const sent = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const record = (entry) => {
    sent.push(entry);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return () => {
      entry.cancelled = true;
      inFlight--;
    };
  };
  const request = (code, details, onList) =>
    record({ code, details, at: clock.now(), onList, cancelled: false });
  const requestRecent = (steamid, onList) =>
    record({ steamid, at: clock.now(), onList, cancelled: false });
  const broadcast = (matches, data = listData(null)) => {
    for (const entry of sent) if (!entry.cancelled) entry.onList(matches, data);
  };
  return { request, requestRecent, sent, broadcast, maxInFlight: () => maxInFlight };
}
