// What a text typed into the one input names, as the server's resolver says it
// (server/crates/server/src/identity.rs `classify`): a player, a match, nothing, or nothing typed
// yet; and, for a FACEIT match room link, which match. Both are held to
// server/crates/server/tests/fixtures/inputs.json. The server does the resolving
// (`/api/lookup`); the browser only needs the kind, so a friend code's check bits are not
// computed here: a text shaped like one is a player either way (the server falls back to a
// custom URL name).

import { extractShareCode } from '../sharecode';

export type InputKind = 'empty' | 'profile' | 'match' | 'none';

/** The tag shown beside the input (none before anything is typed) and the button's word, per
 * kind. */
export const INPUT_WORDS: Record<
  InputKind,
  readonly [tag: string, button: string]
> = {
  empty: ['', 'Open'],
  profile: ['profile', 'Open profile'],
  match: ['match', 'Watch replay'],
  none: ['unknown', 'Open'],
};

const STEAMID64_BASE = 76561197960265728n;
const MAX_ACCOUNT = 0xffffffffn;
const INVITE_ALPHABET = 'bcdfghjkmnpqrtvw';
const SHARE_ALPHABET =
  'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
/** A demo id (`Store::new_id`): 21 or 22 base58 characters. */
const DEMO_ID = /^[1-9A-HJ-NP-Za-km-z]{21,22}$/;
/** FACEIT's id of a CS2 match (identity.rs `faceit_match_id`): a UUID, any case, with or
 * without the `1-` FACEIT puts before it. */
const FACEIT_MATCH =
  /^(1-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Found = 'profile' | 'none';

const account = (a: bigint): Found =>
  a >= 1n && a <= MAX_ACCOUNT ? 'profile' : 'none';

/** `7656119` and 10 digits; any other text null. */
function steamid64(s: string): Found | null {
  return /^7656119\d{10}$/.test(s) ? account(BigInt(s) - STEAMID64_BASE) : null;
}

function steam2(s: string): Found | null {
  const m = /^STEAM_[0-5]:([01]):(\d+)$/.exec(s);
  return m ? account(BigInt(m[2]) * 2n + BigInt(m[1])) : null;
}

function steam3(s: string): Found | null {
  const m = /^\[U:1:(\d+)\]$/.exec(s);
  return m ? account(BigInt(m[1])) : null;
}

/** A Steam invite code (`dhv-grbc`): the account id in hex, in Steam's own letters. */
function invite(code: string): Found {
  const digits = code.trim().toLowerCase().replace(/-/g, '');
  if (!digits || digits.length > 8) return 'none';
  let a = 0n;
  for (const c of digits) {
    const d = INVITE_ALPHABET.indexOf(c);
    if (d < 0) return 'none';
    a = a * 16n + BigInt(d);
  }
  return account(a);
}

const vanityName = (s: string) => /^[A-Za-z0-9_.-]{2,32}$/.test(s);

/** Whether a share code's 25 letters are a number an encoder makes (18 bytes at most). */
function shareCodeDecodes(code: string): boolean {
  const letters = code.slice(5).replace(/-/g, '');
  let n = 0n;
  for (let i = letters.length - 1; i >= 0; i--) {
    const d = SHARE_ALPHABET.indexOf(letters[i]);
    if (d < 0) return false;
    n = n * 57n + BigInt(d);
  }
  return n < 1n << 144n;
}

const isReplayHost = (host: string) => /^replay\d+\.valve\.net$/.test(host);

/** `text` as a link, `https://` put before it when it names no scheme; null when it is none. */
function parseLink(text: string): URL | null {
  try {
    return new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
}

/** A link's host in lower case, without `www.`. */
const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');

/** A link's path segments, the empty ones dropped. */
const segmentsOf = (url: URL) => url.pathname.split('/').filter(Boolean);

/** The match of a FACEIT room link's path, `[<lang>/]cs2/room/<id>[/…]`, its id in lower case
 * (the language is not checked); null for any other path. */
function faceitRoom(segments: string[]): string | null {
  const [game, room, id = ''] =
    segments[0] === 'cs2' ? segments : segments.slice(1);
  return game === 'cs2' && room === 'room' && FACEIT_MATCH.test(id)
    ? id.toLowerCase()
    : null;
}

/** A link to Steam's or this site's pages, to a Valve replay, or to a FACEIT match room; null
 * for any other text. */
function siteLink(text: string): InputKind | null {
  const url = parseLink(text);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = hostOf(url);
  const segments = segmentsOf(url);
  const [first, second = ''] = segments;
  const profileSite = host === 'steamcommunity.com' || host === 'skunk.club';
  if (first === 'profiles' && profileSite) return steamid64(second) ?? 'none';
  if (first === 'id' && profileSite)
    return vanityName(second) ? 'profile' : 'none';
  if (first === 'user' && host === 'steamcommunity.com') return invite(second);
  if (first === 'p' && host === 's.team') return invite(second);
  if (first === 'd' && (host === 'skunk.club' || host === 'cs.skunk.to'))
    return DEMO_ID.test(second) ? 'match' : 'none';
  if (isReplayHost(host)) return 'match';
  if (host === 'faceit.com') return faceitRoom(segments) ? 'match' : 'none';
  return null;
}

/** The kind of `text` (spaces around it ignored), in the server's order of rules. */
export function detectInput(text: string): InputKind {
  const t = text.trim();
  if (!t) return 'empty';
  const link = siteLink(t);
  if (link) return link;
  const code = extractShareCode(t);
  if (code) return shareCodeDecodes(code) ? 'match' : 'none';
  const id = steamid64(t) ?? steam2(t) ?? steam3(t);
  if (id) return id;
  if (/^\d+$/.test(t)) return account(BigInt(t));
  if (/^[A-Za-z0-9]{5}-[A-Za-z0-9]{4}$/.test(t)) return 'profile';
  return vanityName(t) ? 'profile' : 'none';
}

/** Whether `text` (spaces around it ignored) is a code, an ID or a link, which the input sets in
 * the numbers' face, rather than a name or words, which it sets as words. */
export function inputIsCode(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes('://') || siteLink(t) !== null) return true;
  if (extractShareCode(t)) return true;
  if ((steamid64(t) ?? steam2(t) ?? steam3(t)) !== null) return true;
  return /^\d+$/.test(t) || /^[A-Za-z0-9]{5}-[A-Za-z0-9]{4}$/.test(t);
}

/** The demo id of a link to this site's replay page (`skunk.club/d/<id>`), with its query. */
export function demoLink(text: string): string | null {
  const url = parseLink(text.trim());
  if (!url) return null;
  const host = hostOf(url);
  if (host !== 'skunk.club' && host !== 'cs.skunk.to') return null;
  const m = /^\/d\/([^/]+)\/?$/.exec(url.pathname);
  return m && DEMO_ID.test(m[1]) ? `/d/${m[1]}${url.search}` : null;
}

/** FACEIT's id of the match a FACEIT room link (`faceit.com/<lang>/cs2/room/<id>`, spaces
 * around it ignored) names, in lower case; null for any other text. */
export function faceitMatch(text: string): string | null {
  const url = parseLink(text.trim());
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:'))
    return null;
  return hostOf(url) === 'faceit.com' ? faceitRoom(segmentsOf(url)) : null;
}
