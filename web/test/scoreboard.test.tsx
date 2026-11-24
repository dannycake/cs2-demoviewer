// @vitest-environment jsdom
// The scoreboard's names (components/hud/Scoreboard): each player's links to their profile on the
// site, followed in the same tab as the site's own links are, and opened in a new one by the
// browser on a ctrl, shift or middle click; a bot's is not a link.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Scoreboard from '../src/components/hud/Scoreboard';
import { useScoreboard } from '../src/components/hud/scoreboard-state';
import { playbackStore } from '../src/state/store';
import { trackPack } from './helpers/track-pack';

const PLAYER = '76561198000000000';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const pack = trackPack({ players: [() => ({}), () => ({})], samples: 10 });
  // The second is a bot.
  pack.header.players[1].steamid = '0';
  playbackStore.getState().setPack(pack);
  render(<Scoreboard />);
  act(() => useScoreboard.getState().togglePinned());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  playbackStore.getState().setPack(null);
  useScoreboard.getState().close();
  history.replaceState(null, '', '/');
});

describe('the scoreboard’s names', () => {
  it('link a player’s profile on the site, in this tab, and leave a bot’s a name', () => {
    const name = screen.getByRole('link', { name: 'player1' });
    expect(name.getAttribute('href')).toBe(`/profiles/${PLAYER}`);
    expect(name.hasAttribute('target')).toBe(false);
    expect(screen.queryByRole('link', { name: 'player2' })).toBeNull();
    expect(screen.getByText('player2')).toBeTruthy();
  });

  it('are followed without a page load on a plain click', () => {
    const name = screen.getByRole('link', { name: 'player1' });
    const followed = fireEvent.click(name, { button: 0 });
    expect(followed).toBe(false);
    expect(location.pathname).toBe(`/profiles/${PLAYER}`);
  });

  it('leave the viewer, which closes the scoreboard, so it is not open on the way back', () => {
    act(() => useScoreboard.getState().setHeld(true));
    expect(useScoreboard.getState()).toMatchObject({
      pinned: true,
      held: true,
    });
    fireEvent.click(screen.getByRole('link', { name: 'player1' }), {
      button: 0,
    });
    // The viewer goes, and the scoreboard with it.
    cleanup();
    expect(useScoreboard.getState()).toMatchObject({
      pinned: false,
      held: false,
    });
  });

  it('are left to the browser on a ctrl, shift or middle click, for a new tab', () => {
    const name = screen.getByRole('link', { name: 'player1' });
    expect(fireEvent.click(name, { button: 0, ctrlKey: true })).toBe(true);
    expect(fireEvent.click(name, { button: 0, metaKey: true })).toBe(true);
    expect(fireEvent.click(name, { button: 0, shiftKey: true })).toBe(true);
    expect(fireEvent.click(name, { button: 1 })).toBe(true);
    expect(location.pathname).toBe('/');
  });
});
