// Where the app points outside itself, and a player's profile on the site. The source link
// (`components/SourceLink`) on the upload page and in the viewer's settings reads its address from
// here; a profile links the player's Steam and FACEIT profiles, and the viewer each player's
// profile on the site.

/** The project's source code. */
export const SOURCE_URL = 'https://github.com/dannycake/cs2-demoviewer';

/**
 * The SteamID64s of individual accounts: 76561197960265728 plus the account number, 1 to
 * 2^32 − 1. From account 2,039,734,272 on they start 7656120…, so it is a range, not a
 * prefix. A bot's is 0.
 */
const STEAMID64_MIN = 76561197960265729n;
const STEAMID64_MAX = 76561202255233023n;

/** Whether `steamid` is a player's SteamID64: not a bot's, nor any other text. */
export function isPlayerSteamId(steamid: string): boolean {
  if (!/^\d{17}$/.test(steamid)) return false;
  const id = BigInt(steamid);
  return id >= STEAMID64_MIN && id <= STEAMID64_MAX;
}

/** The player's profile on the site, or null when `steamid` is not a player's (a bot). */
export function profilePath(steamid: string): string | null {
  return isPlayerSteamId(steamid) ? `/profiles/${steamid}` : null;
}

/** The Steam Community profile of `steamid`, or null when it is not a player's (a bot). */
export function steamProfileUrl(steamid: string): string | null {
  return isPlayerSteamId(steamid)
    ? `https://steamcommunity.com/profiles/${steamid}`
    : null;
}

/** The FACEIT profile of the account named `nickname`. */
export function faceitProfileUrl(nickname: string): string {
  return `https://www.faceit.com/en/players/${encodeURIComponent(nickname)}`;
}
