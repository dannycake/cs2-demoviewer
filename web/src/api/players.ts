// Players: `GET /api/players/{steamid}` (a profile from the matches the server holds, with
// Steam's facts, the FACEIT account and a tracked player's FACEIT history), `/matches?offset=` (more of them) and `GET /api/lookup?q=` (what the one input
// names). Field for field the server's (server/crates/server/src/profile.rs); null is unknown.

import { ApiError, errorOf, type GameMode, type PlayerRank } from './demos';

export type MatchResult = 'w' | 'l' | 't';

/** Steam's facts. Those after the hours and bans are null in a profile kept before Steam was
 * asked for them. */
export interface SteamFacts {
  sinceYear: number | null;
  country: string | null;
  cs2Hours: number | null;
  /** Minutes of CS2 in the last two weeks. */
  cs2RecentMinutes: number | null;
  level: number | null;
  vacBans: number | null;
  gameBans: number | null;
  communityBanned: boolean | null;
  /** None without a trade ban. */
  tradeBan: 'probation' | 'banned' | null;
  /** Days since the last VAC or game ban; none without one. */
  daysSinceLastBan: number | null;
}

/** The FACEIT account linked to the player's, as FACEIT said with Steam's facts
 * (server/crates/server/src/faceit.rs). */
export interface FaceitAccount {
  /** What its profile's address is made of. */
  nickname: string;
  /** The CS2 skill level, 1 to 10; null when FACEIT gives none. */
  level: number | null;
  /** The CS2 Elo; null when FACEIT gives none. */
  elo: number | null;
  /** FACEIT's id of the player; null when FACEIT's Data API was not asked (no key). */
  playerId: string | null;
  /** The share of their CS2 matches won, in percent; null as for `playerId`, or when FACEIT
   * gives none. */
  winsPct: number | null;
  /** How many CS2 matches they have played there; null as for `winsPct`. */
  matches: number | null;
}

/** After the player's latest Premier match: 0 unrated, with `wins` of the ten it takes. */
export interface PremierRank {
  rating: number;
  wins: number;
  demoId: string;
}

/** The latest rank on the player's most-played Competitive map; 0 unranked. */
export interface CompetitiveRank {
  map: string;
  rank: number;
}

/** Over the matches that count: full 5v5, never Wingman. */
export interface Totals {
  rating: number | null;
  openingWon: number;
  openingLost: number;
  kd: number | null;
  adr: number | null;
  hsPct: number | null;
  matches: number;
  kills: number;
  deaths: number;
  assists: number;
  /** Rounds played. */
  rounds: number;
  kastPct: number | null;
  /** Rounds survived, of the rounds played. */
  survivalPct: number | null;
  /** Rounds with 2, 3, 4 and 5 or more kills. */
  multiKills: [number, number, number, number];
  wins: number;
  losses: number;
  ties: number;
  /** Time played: the matches' lengths. */
  seconds: number;
}

/** A weapon as the kills name it (`ak47`, `m4a1_silencer`, `knife`, `inferno`), and the kills
 * with it. */
export interface WeaponKills {
  weapon: string;
  kills: number;
}

/** The player's rounds on one side, their kills and deaths, K/D and damage per round. */
export interface SideTotals {
  rounds: number;
  kills: number;
  deaths: number;
  kd: number | null;
  adr: number | null;
}

/** What the replays' events add, over the counted matches whose summary has them: `matches` of
 * the totals' (none for summaries from before them). Per round is over the player's own rounds
 * in those matches. */
export interface ReplayTotals {
  matches: number;
  /** The player's kills in those matches, which a weapon's share is of. */
  kills: number;
  /** The weapons with most kills, most first, at most eight. */
  weapons: WeaponKills[];
  /** Clutches 1v1 to 1v5, and of those the ones won. */
  clutches: [number, number, number, number, number];
  clutchesWon: [number, number, number, number, number];
  tradeKills: number;
  tradedDeaths: number;
  flashAssists: number;
  enemiesFlashed: number;
  /** Seconds enemies were blind from the player's flashes, a round. */
  blindPerRound: number | null;
  /** Damage to enemies by HE grenades and fire, a round. */
  utilityAdr: number | null;
  plants: number;
  defuses: number;
  t: SideTotals;
  ct: SideTotals;
  /** Kills through a wall, through smoke, without a scope and while blind; null when no
   * match's kills say. */
  wallbangs: number | null;
  throughSmoke: number | null;
  noScopes: number | null;
  blindKills: number | null;
}

/** A player who was on the player's team, over all their matches: never a hidden one. */
export interface Mate {
  steamid: string;
  /** Their name in the latest match together. */
  name: string;
  matches: number;
  wins: number;
}

export interface MapLine {
  map: string;
  matches: number;
  winPct: number | null;
  rating: number | null;
  rank: number | null;
  /** The totals over this map's counted matches alone. */
  totals: Totals;
  /** The replay figures over those of this map's counted matches that have them. */
  replay: ReplayTotals;
}

export interface MatchRow {
  demoId: string;
  map: string;
  mode: GameMode | null;
  event: string | null;
  playedUnix: number | null;
  result: MatchResult | null;
  /** The player's team's, then the other's. */
  score: [number, number] | null;
  kills: number;
  deaths: number;
  assists: number;
  adr: number | null;
  hsPct: number | null;
  kastPct: number | null;
  rating: number | null;
  rank: PlayerRank | null;
  /** Whether it counts towards the totals (a Competitive, Premier or similar 5v5 match). */
  counted: boolean;
  /** Opening duels the player won and lost. */
  openingWon: number;
  openingLost: number;
  /** Rounds with two, three, four and five kills. */
  multiKills: [number, number, number, number];
  /** Rounds the player played, and of those the rounds they were in a kill, assist, survival or trade. */
  rounds: number;
  kastRounds: number;
  /** What the replay tells of this game alone; null for a summary from before it did. */
  replay: ReplayTotals | null;
}

/** A match of a tracked player's FACEIT history, as FACEIT gave it (map, score and result are
 * null where it did not say), with where to watch it. */
export interface FaceitRow {
  /** FACEIT's id of the match. */
  matchId: string;
  finishedUnix: number;
  map: string | null;
  /** The player's team's, then the other's. */
  score: [number, number] | null;
  won: boolean | null;
  /** The competition it was played in (`CS2 5v5`, a hub's or a league's name). */
  competition: string | null;
  /** The demo id of its replay, when the site holds its demo. */
  replay: string | null;
  /** Its room on FACEIT. */
  roomUrl: string;
}

export interface Profile {
  steamid: string;
  name: string | null;
  avatar: string | null;
  steam: SteamFacts;
  /** Null without one; absent from a server from before FACEIT was asked. */
  faceit?: FaceitAccount | null;
  tracking: 'off' | 'on' | 'stopped';
  premier: PremierRank | null;
  competitive: CompetitiveRank | null;
  totals: Totals;
  replay: ReplayTotals;
  maps: MapLine[];
  /** Who was on their team most often, at most ten. */
  mates: Mate[];
  /** The newest 100. */
  matches: MatchRow[];
  matchCount: number;
  /** Steam's facts are being fetched: asked again shortly, the profile has them. */
  steamPending?: boolean;
  /** A tracked player's newest 20 FACEIT matches, newest first; absent without any. */
  faceitHistory?: FaceitRow[];
}

export type LookupResult =
  | { kind: 'profile'; steamid: string }
  | {
      kind: 'players';
      players: { steamid: string; name: string; matches: number }[];
    };

/** A profile its owner had taken off the site (410). */
export class HiddenProfileError extends ApiError {
  readonly hidden = true;
}

const enc = encodeURIComponent;

export async function getProfile(
  steamid: string,
  signal?: AbortSignal
): Promise<Profile> {
  const res = await fetch(`/api/players/${enc(steamid)}`, { signal });
  if (res.status === 410)
    throw new HiddenProfileError('This profile is hidden.', 410);
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as Profile;
}

export async function getMatches(
  steamid: string,
  offset: number
): Promise<MatchRow[]> {
  const res = await fetch(
    `/api/players/${enc(steamid)}/matches?offset=${offset}`
  );
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as MatchRow[];
}

export async function lookup(q: string): Promise<LookupResult> {
  const res = await fetch(`/api/lookup?q=${enc(q)}`);
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as LookupResult;
}
