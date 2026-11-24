// The site's colours (site/tokens.css): every grey that small text is set in reads at 4.5:1 or
// more on the black, and the dim grey stays brighter than the mute one, so the two still tell a
// label from a quieter note.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom's import.meta.url is not a file's: the path is from web/, where the tests run.
const css = readFileSync('src/site/tokens.css', 'utf8');

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`no --${name}`);
  return m[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('the site’s greys', () => {
  it('set small text at 4.5:1 or more on the black', () => {
    const bg = token('bg');
    for (const name of ['tx', 'dim', 'mute'])
      expect(contrast(token(name), bg), name).toBeGreaterThanOrEqual(4.5);
  });

  it('keep the dim grey brighter than the mute one', () => {
    expect(luminance(token('dim'))).toBeGreaterThan(
      luminance(token('mute')) * 1.4
    );
  });
});
