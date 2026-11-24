import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { accountIdOf } from '../src/steamid.mjs';

describe('accountIdOf', () => {
  it('gives the account id of a SteamID64, from the first to the last', () => {
    assert.equal(accountIdOf('76561198000000001'), 39_734_273);
    assert.equal(accountIdOf('76561197960265729'), 1);
    assert.equal(accountIdOf('76561202255233023'), 2 ** 32 - 1);
  });

  it('rejects account 0, ids past the last, other lengths and anything but a string of digits', () => {
    for (const bad of [
      '76561197960265728',
      '76561202255233024',
      '76561197960265727',
      '7656119800000000',
      '765611980000000010',
      ' 76561198000000001',
      '76561198000000001\n',
      '+6561198000000001',
      '[U:1:39734273]',
      'STEAM_1:1:19867136',
      'https://steamcommunity.com/profiles/76561198000000001',
      '',
      76561198000000001,
      76561198000000001n,
      null,
      undefined,
      { steamid: '76561198000000001' },
    ]) {
      assert.equal(accountIdOf(bad), null, String(bad));
    }
  });

  it("takes exactly the ids globaloffensive's requestRecentGames takes, as steamid reads them", () => {
    // requestRecentGames sends nothing unless the id is valid, in the public universe, an
    // individual account and on the desktop instance.
    const SteamID = createRequire(import.meta.url)('steamid');
    const player = (s) => {
      const id = new SteamID(s);
      return id.isValid() &&
        id.universe === SteamID.Universe.PUBLIC &&
        id.type === SteamID.Type.INDIVIDUAL &&
        id.instance === SteamID.Instance.DESKTOP
        ? id.accountid
        : null;
    };
    const first = 76561197960265728n;
    const last = first + 2n ** 32n - 1n;
    const ids = [];
    for (const edge of [first, last, first + 2n ** 32n, 76561197960265728n - 2n ** 32n]) {
      for (let d = -3n; d <= 3n; d++) ids.push(edge + d);
    }
    let seed = 5;
    for (let i = 0; i < 200; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      // Spread over every 17-digit number, and over the players' range.
      ids.push(10n ** 16n + ((BigInt(seed) * 4_190_000_000n) % (9n * 10n ** 16n)));
      ids.push(first + ((BigInt(seed) * 3n) % 2n ** 32n));
    }
    for (const id of ids)
      assert.equal(accountIdOf(id.toString()), player(id.toString()), String(id));
  });
});
