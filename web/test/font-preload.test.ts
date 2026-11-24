// The site's text waits for its fonts; the page names the four every site page sets in, so the
// browser fetches them with the scripts instead of after the CSS has been read and the page laid
// out. Each is a file the build ships, preloaded as a font (CORS mode, as @font-face asks for it).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(
  new URL('../src/styles/global.css', import.meta.url),
  'utf8'
);
const FONTS = [400, 600, 700, 800].map(
  (w) => `/fonts/archivo-latin-${w}-normal.woff2`
);

describe('font preloads', () => {
  it('preloads the four Archivo faces every site page uses', () => {
    const links = [...html.matchAll(/<link\s+rel="preload"[^>]*>/g)].map(
      (m) => m[0]
    );
    for (const href of FONTS) {
      const link = links.find((l) => l.includes(`href="${href}"`));
      expect(link, href).toBeTruthy();
      expect(link).toContain('as="font"');
      expect(link).toContain('type="font/woff2"');
      expect(link).toContain('crossorigin');
    }
  });

  it('preloads only files the build ships and the CSS uses', () => {
    const hrefs = [
      ...html.matchAll(/<link\s+rel="preload"[^>]*href="([^"]+)"/g),
    ].map((m) => m[1]);
    for (const href of hrefs) {
      expect(
        existsSync(new URL(`../public${href}`, import.meta.url)),
        href
      ).toBe(true);
      expect(css, href).toContain(`url('${href}')`);
    }
  });
});
