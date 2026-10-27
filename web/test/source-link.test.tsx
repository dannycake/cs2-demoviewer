// @vitest-environment jsdom
// The link to the project's source (components/SourceLink, `SOURCE_URL`): the upload page's
// footer and the viewer's settings both show it, opening the repository in a new tab without
// handing it this page. In the settings it leaves the keys to playback: Space on it plays and
// pauses, and its click gives focus back to the page.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from '../src/components/hud/Settings';
import { SOURCE_URL } from '../src/links';
import { handleKey } from '../src/state/keys';
import UploadView from '../src/views/UploadView';
import { threeRoundStore } from './helpers/playback-pack';

vi.mock('../src/api/site', () => ({
  getSite: async () => ({ sharecodes: false }),
}));

afterEach(cleanup);

/** The source link in `within`, checked to open `SOURCE_URL` in a new tab, no opener. */
function sourceLink(within: HTMLElement = document.body): HTMLAnchorElement {
  const link = screen.getAllByRole('link', { name: 'Source on GitHub' });
  const mine = link.filter((l) => within.contains(l));
  expect(mine).toHaveLength(1);
  const a = mine[0] as HTMLAnchorElement;
  expect(a.getAttribute('href')).toBe(SOURCE_URL);
  expect(a.getAttribute('target')).toBe('_blank');
  expect(a.getAttribute('rel')?.split(/\s+/).sort()).toEqual([
    'noopener',
    'noreferrer',
  ]);
  // The mark is decoration: the words are the link's name.
  expect(a.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  return a;
}

describe('the source link', () => {
  it('is the repository', () => {
    expect(SOURCE_URL).toBe('https://github.com/dannycake/cs2-demoviewer');
  });

  it('is in the upload page’s footer', async () => {
    await act(async () => {
      render(<UploadView />);
    });
    const footer = screen.getByRole('contentinfo');
    sourceLink(footer);
  });

  it('is in the settings, and leaves Space and the arrows to playback', () => {
    render(<Settings />);
    expect(screen.queryByRole('link', { name: 'Source on GitHub' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const link = sourceLink(screen.getByRole('dialog', { name: 'Settings' }));

    // Focused, Space on it plays and the arrows change the round, as anywhere on the page.
    const store = threeRoundStore();
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(handleKey({ key: ' ', code: 'Space', target: link }, store)).toBe(
      true
    );
    expect(store.getState().playing).toBe(true);
    expect(
      handleKey({ key: 'ArrowRight', code: 'ArrowRight', target: link }, store)
    ).toBe(true);
    expect(store.getState().round).toBe(1);

    // Its click gives focus back to the page. jsdom would try to open the tab: not here.
    const noTab = (e: Event) => e.preventDefault();
    document.addEventListener('click', noTab);
    try {
      fireEvent.click(link);
    } finally {
      document.removeEventListener('click', noTab);
    }
    expect(document.activeElement).toBe(document.body);
  });
});
