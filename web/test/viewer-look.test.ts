// The replay viewer wears the skunk.club look, as the site's pages do: pure black and #262626
// hairlines, crimson for what is primary or active, square boxes, Archivo for words and JetBrains
// Mono for numbers, sentence case. Most of it is the viewer's tokens (styles/tokens.css); this
// holds the modules to them, so a colour or a corner written by hand cannot bring the old look
// back.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, SRC), 'utf8');

/** The viewer's CSS modules (the site's, under site/, have their own tokens). */
const MODULES = ['components/', 'components/hud/', 'views/'].flatMap((dir) =>
  readdirSync(new URL(dir, SRC))
    .filter((f) => f.endsWith('.module.css'))
    .map((f) => [`${dir}${f}`, read(`${dir}${f}`)] as const)
);
const TOKENS = read('styles/tokens.css');
const GLOBAL = read('styles/global.css');

/** The rule blocks of `css`, as `selector { body }` strings. */
const rules = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/[^{}]+\{[^{}]*\}/g)].map(
    (m) => m[0]
  );

/** `css` without its `@media (hover: hover) { … }` blocks. */
function withoutHoverMedia(css: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const start = css.indexOf('@media (hover: hover)', at);
    if (start < 0) return out + css.slice(at);
    out += css.slice(at, start);
    let i = css.indexOf('{', start);
    let depth = 0;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    at = i + 1;
  }
}

describe('the viewer look', () => {
  it('is set by the tokens: crimson, square, Archivo with JetBrains Mono', () => {
    expect(TOKENS).toMatch(/--brand:\s*#e4163a;/);
    expect(TOKENS).toMatch(/--r:\s*0;/);
    expect(TOKENS).toMatch(/--surface-1:\s*#000000;/);
    expect(TOKENS).toMatch(/--line:\s*#262626;/);
    expect(TOKENS).toMatch(/--sans:\s*'Archivo'/);
    expect(TOKENS).toMatch(/--font-family-sans:\s*var\(--sans\);/);
    const body = rules(GLOBAL).find((r) => /^\s*body\s*\{/.test(r))!;
    expect(body).toMatch(/font-family:\s*var\(--sans\)/);
  });

  it('writes no colour of the old look by hand', () => {
    const old =
      /rgba\(\s*9,\s*8,\s*6|#ff7a1a|#ff8c3a|rgba\(\s*30,\s*16,\s*54|#ff5f52/i;
    for (const [path, css] of MODULES) expect(css, path).not.toMatch(old);
  });

  it('writes no chrome in lowercase', () => {
    for (const [path, css] of MODULES)
      expect(css, path).not.toMatch(/text-transform:\s*lowercase/);
  });

  it('rounds nothing but dots', () => {
    for (const [path, css] of MODULES)
      for (const m of css.matchAll(/border-radius:\s*([^;]+);/g))
        for (const corner of m[1].trim().split(/\s+/))
          expect(
            ['0', 'var(--r)', '50%', 'var(--radius-full)'],
            `${path}: ${m[0]}`
          ).toContain(corner);
  });

  it('takes its colours from the tokens: only black and white are written by hand', () => {
    for (const [path, css] of MODULES) {
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of bare.matchAll(/#[0-9a-f]{3,8}\b/gi))
        expect(
          ['#000', '#000000', '#fff', '#ffffff'],
          `${path}: ${m[0]}`
        ).toContain(m[0].toLowerCase());
      for (const m of bare.matchAll(
        /rgba?\(\s*(var\(--[\w-]+\)|\d+\s*,\s*\d+\s*,\s*\d+)/g
      ))
        expect(
          ['0,0,0', '255,255,255', 'var(--brand-rgb)'],
          `${path}: ${m[0]}`
        ).toContain(m[1].replace(/\s+/g, ''));
    }
  });

  it('rings keyboard focus one way: the system ring (tokens.css), or none where a part draws it', () => {
    expect(TOKENS).toMatch(
      /:focus-visible\s*\{\s*outline:\s*2px solid var\(--brand-ink\);\s*outline-offset:\s*2px;/
    );
    for (const [path, css] of MODULES)
      for (const rule of rules(css).filter((r) =>
        r.split('{')[0].includes(':focus-visible')
      ))
        for (const m of rule.matchAll(/outline:\s*([^;]+);/g))
          expect(
            ['none', '2px solid var(--brand-ink)'],
            `${path}: ${rule}`
          ).toContain(m[1].trim());
  });

  it('hovers for a mouse only: a hover rule on a touch screen sticks after a tap', () => {
    for (const [path, css] of [...MODULES, ['styles/tokens.css', TOKENS]]) {
      const rest = withoutHoverMedia(css.replace(/\/\*[\s\S]*?\*\//g, ''));
      // Standing back until pointed at (`:not(:hover)`) is no hover fill.
      expect(rest.replace(/:not\(:hover\)/g, ''), path).not.toMatch(/:hover/);
    }
    expect(TOKENS).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
  });

  it("sets no HUD text below the site's smallest size step (--fs-micro, 10.5 px)", () => {
    // The HUD's base size has the step for a floor, whatever the HUD size setting.
    expect(read('views/DemoView.module.css')).toMatch(
      /--hud-size:\s*max\(\s*var\(--fs-micro\),/
    );
    for (const [path, css] of MODULES)
      for (const m of css.matchAll(/font-size:\s*([^;]+);/g)) {
        const v = m[1].trim();
        // Floored (`max(var(--fs-…), …)`), a step of the scale, or the HUD's size and up.
        if (v.startsWith('max(var(--fs-') || v.startsWith('var(--')) continue;
        const em = /^([\d.]+)em$/.exec(v);
        const px = /^([\d.]+)px$/.exec(v);
        const hud = /^calc\(var\(--hud-size[^)]*\)\s*\*\s*([\d.]+)\)$/.exec(v);
        const scale = Number((em ?? hud)?.[1] ?? NaN);
        if (em || hud)
          expect(scale, `${path}: ${m[0]}`).toBeGreaterThanOrEqual(1);
        else if (px)
          expect(Number(px[1]), `${path}: ${m[0]}`).toBeGreaterThanOrEqual(
            10.5
          );
        else expect(v, `${path}: ${m[0]}`).toMatch(/^(inherit|1em)$/);
      }
  });

  it('sets words in Archivo: a table of names is not set in mono, only its figures', () => {
    for (const path of [
      'components/hud/hud.module.css',
      'components/hud/RoundSummary.module.css',
    ]) {
      const table = rules(read(path)).find((r) => /^\s*\.table\s*\{/.test(r))!;
      expect(table, path).not.toMatch(/font-family:\s*var\(--mono\)/);
      const cells = rules(read(path)).find((r) =>
        /^\s*\.table td\s*\{/.test(r)
      )!;
      expect(cells, path).toMatch(/font-family:\s*var\(--mono\)/);
    }
  });

  it('sets every number in JetBrains Mono', () => {
    for (const [path, css] of MODULES)
      for (const rule of rules(css).filter((r) => r.includes('tabular-nums')))
        expect(rule, path).toMatch(/font-family:\s*var\(--mono\)/);
  });
});
