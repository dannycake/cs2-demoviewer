// How the site writes what it shows: a Premier rating's tier and digits, ratings, percentages,
// hours, days, bans, countries, match modes and tournaments' names. "—" is the site's word for
// unknown.

import type { MatchRow, SteamFacts } from '../api/players';

export const DASH = '—';

/** The stat strip's colours, rating first (the owner: "make the rating / opening / k/d / adr /
 * hs% / matches rainbow"). */
export const RAINBOW = [
  '#ff4d5e',
  '#ff9a3c',
  '#ffd84d',
  '#4be08a',
  '#4cc3ff',
  '#b98cff',
] as const;

/** A Premier rating's colour band, as CS2 shows it: every 5,000. */
export function premierTier(rating: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  if (rating < 5000) return 1;
  if (rating < 10000) return 2;
  if (rating < 15000) return 3;
  if (rating < 20000) return 4;
  if (rating < 25000) return 5;
  if (rating < 30000) return 6;
  return 7;
}

/** The tiers' colours, 1 to 7. */
export const PREMIER_COLOURS = [
  '#b0c3d9',
  '#8cc6ff',
  '#6a7dff',
  '#c166ff',
  '#f03cff',
  '#eb4b4b',
  '#fed700',
] as const;

/** A rating split as CS2 draws it, the thousands large: `8058` → `['8', ',058']`. */
export function premierParts(rating: number): [string, string] {
  const r = Math.max(0, Math.round(rating));
  if (r < 1000) return [String(r), ''];
  return [
    String(Math.floor(r / 1000)),
    `,${String(r % 1000).padStart(3, '0')}`,
  ];
}

export function formatRating(r: number | null): string {
  return r === null ? DASH : r.toFixed(2);
}

export function formatPct(p: number | null): string {
  return p === null ? DASH : `${Math.round(p)}%`;
}

/** A whole number, or a dash. */
export function formatInt(n: number | null): string {
  return n === null ? DASH : String(Math.round(n));
}

/** What a profile is called in its tab and its preview: "‹name›'s CS2 stats" ("‹name›' CS2
 * stats" after a final s), as `stats_title` in pages.rs writes it. */
export function statsTitle(name: string): string {
  return `${name}${/[sS]$/.test(name) ? "'" : "'s"} CS2 stats`;
}

/** `one` when `n` is written as 1, else `many`: `plural(1, 'kill', 'kills')`. */
export function plural(n: number | string, one: string, many: string): string {
  return String(n) === '1' ? one : many;
}

/** Seconds as hours: to a tenth under ten (`1.5`), else whole (`17`). */
export function formatHours(seconds: number): string {
  const h = seconds / 3600;
  return String(h < 9.95 ? Math.round(h * 10) / 10 : Math.round(h));
}

/** `Oct 14`, with the year when it is not `now`'s; empty when unknown. UTC, as the server. */
export function formatDay(unix: number | null, now: Date): string {
  if (unix === null) return '';
  const d = new Date(unix * 1000);
  const day = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return d.getUTCFullYear() === now.getUTCFullYear()
    ? day
    : `${day} ${d.getUTCFullYear()}`;
}

/** `Oct 22, 2025` (UTC, as the server); empty when unknown. */
export function formatDate(unix: number | null): string {
  if (unix === null) return '';
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** One of Steam's facts about bans: a count, which the page sets in figures, and the words
 * after it, or words alone. */
export interface BanFact {
  n: number | null;
  words: string;
}

/** Steam's bans, each a fact of its own: `1 VAC ban`, `2 game bans`, `Community ban`, `Trade
 * ban` or `Trade probation`; `No bans` when there are none, a dash when Steam did not say. */
export function banFacts(
  steam: Pick<
    SteamFacts,
    'vacBans' | 'gameBans' | 'communityBanned' | 'tradeBan'
  >
): BanFact[] {
  const { vacBans: vac, gameBans: game } = steam;
  if (vac === null && game === null) return [{ n: null, words: DASH }];
  const out: BanFact[] = [];
  if (vac) out.push({ n: vac, words: vac === 1 ? 'VAC ban' : 'VAC bans' });
  if (game) out.push({ n: game, words: game === 1 ? 'game ban' : 'game bans' });
  if (steam.communityBanned) out.push({ n: null, words: 'Community ban' });
  if (steam.tradeBan === 'banned') out.push({ n: null, words: 'Trade ban' });
  if (steam.tradeBan === 'probation')
    out.push({ n: null, words: 'Trade probation' });
  return out.length ? out : [{ n: null, words: 'No bans' }];
}

let regions: Intl.DisplayNames | null | undefined;

/** The country's English name from its ISO code; a dash when unknown. */
export function countryName(code: string | null): string {
  if (!code) return DASH;
  if (regions === undefined) {
    try {
      regions = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regions = null;
    }
  }
  try {
    return regions?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Competitive skill groups, 0 (unranked) to 18, as CS2 names them. */
export const RANK_NAMES = [
  'Unranked',
  'Silver I',
  'Silver II',
  'Silver III',
  'Silver IV',
  'Silver Elite',
  'Silver Elite Master',
  'Gold Nova I',
  'Gold Nova II',
  'Gold Nova III',
  'Gold Nova Master',
  'Master Guardian I',
  'Master Guardian II',
  'Master Guardian Elite',
  'Distinguished Master Guardian',
  'Legendary Eagle',
  'Legendary Eagle Master',
  'Supreme Master First Class',
  'The Global Elite',
] as const;

/** A Competitive rank's name; unranked for 0, null or any other number. */
export function rankName(rank: number | null): string {
  return (rank !== null && RANK_NAMES[rank]) || RANK_NAMES[0];
}

/** Words of a tournament's name that are written otherwise than capitalised, by their lower
 * case: the organisers' and leagues' letters, and names with a capital inside. */
const EVENT_WORDS: Readonly<Record<string, string>> = {
  betboom: 'BetBoom',
  blast: 'BLAST',
  cac2026: 'CS Asia Championships 2026',
  cct: 'CCT',
  cs: 'CS',
  cs2: 'CS2',
  csgo: 'CS:GO',
  dreamhack: 'DreamHack',
  eleague: 'ELEAGUE',
  epl: 'EPL',
  esea: 'ESEA',
  esl: 'ESL',
  ewc: 'EWC',
  faceit: 'FACEIT',
  fissure: 'FISSURE',
  iem: 'IEM',
  krakow: 'Kraków',
  mlg: 'MLG',
  pgl: 'PGL',
  rmr: 'RMR',
  starladder: 'StarLadder',
  tv: 'TV',
};

/** A tournament's name from the slug its demos came under (`iem_cologne_major_2026` → `IEM
 * Cologne Major 2026`): words split at `_` and `-`, the letters of a known organiser or league in
 * capitals, numbers as they are, every other word capitalised; a word already holding a capital
 * is left as it is. The server names events the same way (pages.rs `event_name`): both are held to
 * server/crates/server/tests/fixtures/events.json. */
export function eventName(slug: string): string {
  return slug
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) =>
      /[A-Z]/.test(w)
        ? w
        : Object.hasOwn(EVENT_WORDS, w)
          ? EVENT_WORDS[w]
          : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join(' ');
}

/** What kind of match a row is: the mode or a tournament's event; empty when unknown. */
export function modeLabel(row: Pick<MatchRow, 'mode' | 'event'>): string {
  switch (row.mode) {
    case 'premier':
      return 'Premier';
    case 'competitive':
      return 'Competitive';
    case 'wingman':
      return 'Wingman';
    case 'faceit':
      return 'FACEIT';
    case 'other':
      return row.event ? eventName(row.event) : 'Match';
    default:
      return '';
  }
}
