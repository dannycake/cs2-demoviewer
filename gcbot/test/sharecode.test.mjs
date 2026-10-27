import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { ALPHABET, decodeShareCode, extractShareCode } from '../src/sharecode.mjs';

const CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';

describe('extractShareCode', () => {
  it('takes a bare code', () => {
    assert.equal(extractShareCode(CODE), CODE);
    assert.equal(extractShareCode(`  ${CODE}\n`), CODE);
  });

  it("takes the code out of CS2's copy share link", () => {
    const link = `steam://rungame/730/76561202255233023/+csgo_download_match%20${CODE}`;
    assert.equal(extractShareCode(link), CODE);
    assert.equal(extractShareCode(`watch this: ${link} gg`), CODE);
  });

  it('rejects a short code, a URL and anything else', () => {
    assert.equal(extractShareCode('CSGO-GADqf-jjyJ8'), null);
    assert.equal(
      extractShareCode('http://replay183.valve.net/730/003710983364429447230_1612365234.dem.bz2'),
      null
    );
    assert.equal(extractShareCode('https://cs.skunk.to/d/4f9Kq'), null);
    assert.equal(extractShareCode(''), null);
    assert.equal(extractShareCode(undefined), null);
    assert.equal(extractShareCode({ sharecode: CODE }), null);
  });
});

describe('decodeShareCode', () => {
  it("decodes akiver/csgo-sharecode's README vector", () => {
    assert.deepEqual(decodeShareCode(CODE), {
      matchId: '3230642215713767580',
      outcomeId: '3230647599455273103',
      token: 55788,
    });
  });

  it('rejects letters outside the alphabet and the wrong shape', () => {
    for (const bad of ['I', 'l', 'g', '0', '1']) {
      assert.equal(decodeShareCode(`CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x${bad}`), null, bad);
    }
    assert.equal(decodeShareCode('CSGO-GADqf-jjyJ8'), null);
    assert.equal(decodeShareCode(`${CODE}-AAAAA`), null);
    assert.equal(decodeShareCode(`x${CODE}`), null);
  });

  it('rejects a code whose number does not fit in 18 bytes', () => {
    // 57^25 > 2^144: the largest digits everywhere overflow, so no encoder produced this.
    assert.equal(decodeShareCode('CSGO-99999-99999-99999-99999-99999'), null);
  });

  it("agrees with globaloffensive's own decoder", () => {
    const { ShareCode } = createRequire(import.meta.url)('globaloffensive-sharecode');
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % ALPHABET.length;
    let compared = 0;
    for (let n = 0; n < 200; n++) {
      const groups = Array.from({ length: 5 }, () =>
        Array.from({ length: 5 }, () => ALPHABET[rand()]).join('')
      );
      const code = `CSGO-${groups.join('-')}`;
      const ours = decodeShareCode(code);
      if (!ours) continue;
      const theirs = new ShareCode(code).decode();
      assert.deepEqual(ours, { ...theirs, token: Number(theirs.token) }, code);
      compared++;
    }
    assert.ok(compared > 50, `only ${compared} codes fit`);
  });
});
