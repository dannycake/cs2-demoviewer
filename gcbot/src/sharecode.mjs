// Match share codes (`CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`): finding one in pasted text,
// decoding it to the ids the Game Coordinator is asked about, and encoding a match the GC lists
// back into one. The decoding is akiver/csgo-sharecode's: the 25 characters, read last to first,
// are a base-57 number whose 18 bytes (big endian) hold the match id and outcome id (u64) and the
// token (u16), each little endian. Crosshair codes have the same shape and alphabet: they decode,
// and Valve has no match.

/** The share-code alphabet: letters and digits without I, g, l, 0 or 1. */
export const ALPHABET = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';

// Anywhere in the text, so CS2's "copy share link"
// (`steam://rungame/730/…/+csgo_download_match%20CSGO-…`) works as is. The server
// (server/crates/server/src/sharecode.rs) and the web app (web/src/sharecode.ts) use the same rule.
const FIND = /CSGO(-[A-Za-z0-9]{5}){5}/;
const WHOLE = /^CSGO(-[A-Za-z0-9]{5}){5}$/;

/** The first share code in `text`, or null. */
export function extractShareCode(text) {
  if (typeof text !== 'string') return null;
  const m = FIND.exec(text);
  return m ? m[0] : null;
}

/**
 * `{ matchId, outcomeId, token }` (the ids as decimal strings, the shape globaloffensive's
 * `requestGame` takes), or null for a letter outside the alphabet, the wrong shape, or a number
 * too big for 18 bytes (which no encoder produces).
 */
export function decodeShareCode(code) {
  if (typeof code !== 'string' || !WHOLE.test(code)) return null;
  const chars = code.slice(5).replaceAll('-', '');
  let n = 0n;
  for (let i = chars.length - 1; i >= 0; i--) {
    const digit = ALPHABET.indexOf(chars[i]);
    if (digit < 0) return null;
    n = n * 57n + BigInt(digit);
  }
  const bytes = Buffer.alloc(18);
  for (let i = 17; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) return null;
  return {
    matchId: bytes.readBigUInt64LE(0).toString(),
    outcomeId: bytes.readBigUInt64LE(8).toString(),
    token: bytes.readUInt16LE(16),
  };
}

const U64 = /^\d{1,20}$/;

/**
 * The share code for `{ matchId, outcomeId, token }` (decimal strings and a number, the shape
 * decodeShareCode gives): its inverse, which /recent gives each match the GC lists. Null when an
 * id is not a decimal string that fits in 64 bits or the token not an integer that fits in 16.
 * globaloffensive-sharecode only decodes.
 */
export function encodeShareCode({ matchId, outcomeId, token } = {}) {
  const fits = (id) => typeof id === 'string' && U64.test(id) && BigInt(id) < 2n ** 64n;
  if (!fits(matchId) || !fits(outcomeId)) return null;
  if (!Number.isInteger(token) || token < 0 || token > 0xffff) return null;
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
