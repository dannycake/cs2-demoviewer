// Shared test helpers (not a test file: package.json runs test/*.test.mjs only).
import { ALPHABET } from '../src/sharecode.mjs';

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

/**
 * The share code for `{ matchId, outcomeId, token }` (decimal strings and a number, the shape
 * decodeShareCode gives): its inverse, for codes a test makes up, such as a forgery naming a
 * real match with another outcome id and token.
 */
export function encodeShareCode({ matchId, outcomeId, token }) {
  const bytes = Buffer.alloc(18);
  bytes.writeBigUInt64LE(BigInt(matchId), 0);
  bytes.writeBigUInt64LE(BigInt(outcomeId), 8);
  bytes.writeUInt16LE(token, 16);
  // Big endian, least significant digit first.
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let digits = '';
  for (let i = 0; i < 25; i++) {
    digits += ALPHABET[Number(n % 57n)];
    n /= 57n;
  }
  return `CSGO-${digits.match(/.{5}/g).join('-')}`;
}
