// SteamID64s, the 17-digit ids of steamcommunity.com/profiles/<id>, of which the Game
// Coordinator wants the 32-bit account id. A player's is 76561197960265728 (the public universe,
// an individual account, the desktop instance) plus an account id from 1 to 2^32 - 1: the ids
// globaloffensive's requestRecentGames takes.

const FIRST = 76561197960265728n;
const SEVENTEEN_DIGITS = /^\d{17}$/;

/** The account id in a player's SteamID64 (a string of 17 digits), or null for anything else. */
export function accountIdOf(steamid) {
  if (typeof steamid !== 'string' || !SEVENTEEN_DIGITS.test(steamid)) return null;
  const account = BigInt(steamid) - FIRST;
  return account >= 1n && account <= 0xffffffffn ? Number(account) : null;
}
