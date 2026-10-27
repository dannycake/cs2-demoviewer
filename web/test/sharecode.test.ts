import { describe, expect, it } from 'vitest';
import { extractShareCode } from '../src/sharecode';

const CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';

// The same cases as gcbot's (gcbot/test/sharecode.test.mjs) and the server's
// (server/crates/server/tests/sharecode.rs).
describe('extractShareCode', () => {
  it('takes a bare code', () => {
    expect(extractShareCode(CODE)).toBe(CODE);
    expect(extractShareCode(`  ${CODE}\n`)).toBe(CODE);
  });

  it("takes the code out of CS2's copy share link", () => {
    const link = `steam://rungame/730/76561202255233023/+csgo_download_match%20${CODE}`;
    expect(extractShareCode(link)).toBe(CODE);
    expect(extractShareCode(`watch this: ${link} gg`)).toBe(CODE);
  });

  it('takes the first code, cut where the pattern ends', () => {
    expect(extractShareCode(`${CODE} CSGO-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE`)).toBe(
      CODE
    );
    expect(extractShareCode(`CSGO-x ${CODE}`)).toBe(CODE);
    expect(extractShareCode(`${CODE}K`)).toBe(CODE);
  });

  it('rejects a short code, a URL and anything else', () => {
    for (const bad of [
      'CSGO-GADqf-jjyJ8',
      'http://replay183.valve.net/730/003710983364429447230_1612365234.dem.bz2',
      'https://cs.skunk.to/d/4f9Kq',
      '',
      'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x',
      'csgo-GADqf-jjyJ8-cSP2r-smZRo-TO2xK',
      'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x東',
    ])
      expect(extractShareCode(bad), bad).toBeNull();
  });
});
