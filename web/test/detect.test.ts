// What the one input says a text is, as the server's resolver (identity.rs) would: both are held
// to server/crates/server/tests/fixtures/inputs.json. The browser only needs the kind, and a
// FACEIT room link's match.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectInput, faceitMatch, INPUT_WORDS } from '../src/site/detect';

const cases: {
  input: string;
  kind: string;
  steamid?: string;
  faceitMatch?: string;
}[] = JSON.parse(
  readFileSync(
    new URL(
      '../../server/crates/server/tests/fixtures/inputs.json',
      import.meta.url
    ),
    'utf8'
  )
);

describe('detectInput', () => {
  it('agrees with the server on every shared case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    for (const c of cases)
      expect(detectInput(c.input), c.input).toBe(
        c.kind === 'none' && !c.input.trim() ? 'empty' : c.kind
      );
  });

  it('takes the FACEIT match from a room link, as the server does', () => {
    expect(cases.some((c) => c.faceitMatch)).toBe(true);
    for (const c of cases)
      expect(faceitMatch(c.input), c.input).toBe(c.faceitMatch ?? null);
  });

  it('reads spaces alone as empty', () => {
    expect(detectInput('   ')).toBe('empty');
  });

  it('refuses a share code outside the alphabet', () => {
    expect(detectInput('CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x0')).toBe('none');
  });

  it('refuses a profile link with no account and an id past 32 bits', () => {
    expect(
      detectInput('https://steamcommunity.com/profiles/76561190000000000')
    ).toBe('none');
    expect(detectInput('4294967296')).toBe('none');
    expect(detectInput('[U:1:0]')).toBe('none');
  });

  it('has the words for every kind', () => {
    expect(INPUT_WORDS.match).toEqual(['match', 'Watch replay']);
    expect(INPUT_WORDS.profile).toEqual(['profile', 'Open profile']);
    // Short, so a phone's input keeps its room beside it.
    expect(INPUT_WORDS.none[0]).toBe('unknown');
    // Nothing typed: no tag, not a dash standing in for one.
    expect(INPUT_WORDS.empty).toEqual(['', 'Open']);
  });
});
