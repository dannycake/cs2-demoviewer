// Where the app's links point (links.ts): a player's profile on the site, on Steam and on FACEIT,
// for players only, never a bot.

import { describe, expect, it } from 'vitest';
import { faceitProfileUrl, profilePath, steamProfileUrl } from '../src/links';

/** The first and last account numbers, and a newer account's 7656120… id. */
const PLAYERS = ['76561197960265729', '76561200000000001', '76561202255233023'];
/** A bot's, and anything else that is not a player's SteamID64. */
const NOT_PLAYERS = [
  '0',
  '',
  'BOT',
  '7656119800000000',
  '765611980000000000',
  '86561198000000000',
  '76561198000000000/../x',
  '76561197960265728',
  '76561202255233024',
];

describe('steamProfileUrl', () => {
  it('is the profile of a SteamID64 and nothing else', () => {
    for (const id of PLAYERS)
      expect(steamProfileUrl(id), id).toBe(
        `https://steamcommunity.com/profiles/${id}`
      );
    for (const id of NOT_PLAYERS) expect(steamProfileUrl(id), id).toBeNull();
  });
});

describe('profilePath', () => {
  it('is the player’s profile on the site, and none for a bot', () => {
    for (const id of PLAYERS)
      expect(profilePath(id), id).toBe(`/profiles/${id}`);
    for (const id of NOT_PLAYERS) expect(profilePath(id), id).toBeNull();
  });
});

describe('faceitProfileUrl', () => {
  it('is the profile of the nickname, which keeps to its path', () => {
    expect(faceitProfileUrl('alphafaceit')).toBe(
      'https://www.faceit.com/en/players/alphafaceit'
    );
    expect(faceitProfileUrl('a/../b ?#')).toBe(
      'https://www.faceit.com/en/players/a%2F..%2Fb%20%3F%23'
    );
  });
});
