// What every page's head names besides its fonts: a description (the homepage's words, which the
// server puts each page's own in place of), the home-screen icon (the skunk mark in crimson on
// black, 180 pixels square, as iOS asks for it) and a web manifest naming the site and its icons,
// each a file the build ships.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOME_TITLE, pageTitle } from '../src/router';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pub = (path: string) => new URL(`../public${path}`, import.meta.url);

/** A PNG's width and height, from its header. */
function pngSize(path: string): [number, number] {
  const png = readFileSync(pub(path));
  expect([...png.subarray(1, 4)].map((b) => String.fromCharCode(b))).toEqual([
    'P',
    'N',
    'G',
  ]);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

function link(rel: string): string | undefined {
  const tag = html.match(new RegExp(`<link\\s+rel="${rel}"[^>]*>`))?.[0];
  return tag?.match(/href="([^"]+)"/)?.[1];
}

describe('the page head', () => {
  it('titles the home page as the app does once it mounts', () => {
    expect(html.match(/<title>([^<]*)<\/title>/)?.[1]).toBe(
      pageTitle(HOME_TITLE)
    );
  });

  it('describes the site', () => {
    const description = html.match(
      /<meta\s+name="description"\s+content="([^"]+)"/
    )?.[1];
    expect(description).toBe(
      'Watch any CS2 demo in 3D, right in your browser, no install. Pro tournament replays, your own matches and your friends&#39; stats.'
    );
  });

  it('names a home-screen icon of 180 pixels square', () => {
    const href = link('apple-touch-icon');
    expect(href).toBe('/apple-touch-icon.png');
    expect(pngSize(href!)).toEqual([180, 180]);
  });

  it('names a manifest whose icons the build ships', () => {
    const href = link('manifest');
    expect(href).toBe('/site.webmanifest');
    const manifest = JSON.parse(readFileSync(pub(href!), 'utf8')) as {
      name: string;
      short_name: string;
      start_url: string;
      background_color: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.name).toBe('skunk.club');
    expect(manifest.start_url).toBe('/');
    expect(manifest.background_color).toBe('#000000');
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      expect(existsSync(pub(icon.src)), icon.src).toBe(true);
      expect(icon.type).toBe('image/png');
      const [w, h] = pngSize(icon.src);
      expect(icon.sizes).toBe(`${w}x${h}`);
    }
    expect(manifest.icons.some((i) => i.sizes === '512x512')).toBe(true);
  });
});
