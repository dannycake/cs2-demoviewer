// @vitest-environment jsdom
// The site's shell around its pages (site/SiteBar, site/SiteFoot) and the site's own images
// (api/site-assets: the rank icons, the Steam logo, the homepage video, from /site/manifest.json).

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  homeVideo,
  rankIconUrl,
  siteAssets,
  steamLogoUrl,
  type SiteAssets,
} from '../src/api/site-assets';
import SiteBar from '../src/site/SiteBar';
import SiteFoot from '../src/site/SiteFoot';

const entry = (file: string, sha: string) => ({
  file,
  sha256: sha.repeat(64 / sha.length),
  bytes: 1,
});
const ranks = Object.fromEntries(
  [...Array.from({ length: 19 }, (_, i) => String(i)), 'none'].map((k) => [
    k,
    entry(`ranks/skillgroup${k === 'none' ? '_none' : k}.webp`, 'ab'),
  ])
);
const assets: SiteAssets = {
  ranks,
  steamLogo: entry('steam-logo.svg', 'cd'),
  home: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the site shell', () => {
  it('the bar names the site and offers Steam sign-in', () => {
    render(<SiteBar />);
    const home = screen.getByRole('link', { name: /skunk\.club/ });
    expect(home.getAttribute('href')).toBe('/');
    const signIn = screen.getByRole('link', { name: 'Sign in through Steam' });
    expect(signIn.getAttribute('href')).toBe('/auth/steam');
  });

  it('the footer says not affiliated with Valve and links Contact, and nothing else', () => {
    render(<SiteFoot />);
    expect(screen.getByText(/Not affiliated with Valve/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Contact' }).getAttribute('href')
    ).toBe('/legal');
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(
      screen.getByRole('link', { name: 'Guides' }).getAttribute('href')
    ).toBe('/guides');
    expect(
      screen.getByRole('link', { name: 'Events' }).getAttribute('href')
    ).toBe('/events');
    expect(screen.queryByRole('link', { name: /Source/ })).toBeNull();
  });
});

describe('site assets', () => {
  it('a missing rank or 0 shows the unranked icon', () => {
    expect(rankIconUrl(assets, 0)).toContain('skillgroup_none');
    expect(rankIconUrl(assets, null)).toContain('skillgroup_none');
    expect(rankIconUrl(assets, 7)).toBe(
      '/site/ranks/skillgroup7.webp?v=abababab'
    );
    expect(rankIconUrl(assets, 19)).toContain('skillgroup_none');
  });

  it('names the logo and the homepage video with their versions', () => {
    expect(steamLogoUrl(assets)).toBe('/site/steam-logo.svg?v=cdcdcdcd');
    expect(homeVideo(assets)).toBeNull();
    const withVideo = {
      ...assets,
      home: {
        mp4: entry('home/hero.mp4', '11'),
        webm: entry('home/hero.webm', '22'),
        poster: entry('home/poster.jpg', '33'),
      },
    };
    expect(homeVideo(withVideo)).toEqual({
      mp4: '/site/home/hero.mp4?v=11111111',
      webm: '/site/home/hero.webm?v=22222222',
      poster: '/site/home/poster.jpg?v=33333333',
    });
  });

  it('reads /site/manifest.json, and null when there is none', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(assets)));
    vi.stubGlobal('fetch', fetchFn);
    expect((await siteAssets({ fresh: true }))?.steamLogo.file).toBe(
      'steam-logo.svg'
    );
    expect(fetchFn).toHaveBeenCalledWith('/site/manifest.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    );
    expect(await siteAssets({ fresh: true })).toBeNull();
  });
});
