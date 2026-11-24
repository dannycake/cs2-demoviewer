// @vitest-environment jsdom
// The guides (site/GuideView): the title, the shared fragment, the unknown-slug page, and titles
// that match the server's (guides.rs).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GuideView from '../src/site/GuideView';
import { GUIDES } from '../src/site/guides';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GuideView', () => {
  it('takes the server\'s copy away, so the page holds one guide and one heading', () => {
    const pre = document.createElement('div');
    pre.id = 'pre';
    pre.innerHTML = '<h1>The server copy</h1>';
    document.body.append(pre);
    render(<GuideView slug="track-your-cs2-matches" />);
    expect(document.getElementById('pre')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('lists every guide at /guides', () => {
    render(<GuideView />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'CS2 demo guides'
    );
    for (const g of GUIDES) {
      expect(
        screen.getByRole('link', { name: g.title }).getAttribute('href')
      ).toBe(`/guides/${g.slug}`);
    }
    expect(document.title).toBe('CS2 demo guides · skunk.club');
  });

  it('shows the guide, its title and its body', () => {
    render(<GuideView slug="track-your-cs2-matches" />);
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'How to get your CS2 match history tracked automatically',
      })
    ).toBeTruthy();
    expect(document.title).toBe(
      'How to get your CS2 match history tracked automatically · skunk.club'
    );
    expect(
      screen.getByRole('link', { name: 'Set up tracking' }).getAttribute('href')
    ).toBe('/track');
  });

  it('says so for an unknown guide', () => {
    render(<GuideView slug="nope" />);
    expect(
      screen.getByRole('heading', { name: 'Guide not found' })
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'See all the guides' })
        .getAttribute('href')
    ).toBe('/guides');
  });

  it('titles every guide as the server does', () => {
    const server = readFileSync(
      join(__dirname, '../../server/crates/server/src/guides.rs'),
      'utf8'
    );
    expect(GUIDES).toHaveLength(4);
    for (const g of GUIDES) {
      expect(server, g.slug).toContain(`slug: "${g.slug}"`);
      expect(server, g.slug).toContain(`title: "${g.title}"`);
      expect(g.body.length).toBeGreaterThan(100);
    }
  });
});
