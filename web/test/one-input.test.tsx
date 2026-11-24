// @vitest-environment jsdom
// The one input (site/OneInput): any player or match identifier, tagged as it is typed; a player
// opens their profile (through /api/lookup), a match its replay.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OneInput from '../src/site/OneInput';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let fetchFn: ReturnType<typeof vi.fn>;
beforeEach(() => {
  history.replaceState(null, '', '/');
  fetchFn = vi.fn();
  vi.stubGlobal('fetch', fetchFn);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const type = (text: string) =>
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });

describe('OneInput', () => {
  it('tags a share code as a match and offers to watch it', () => {
    render(<OneInput variant="hero" />);
    type('CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK');
    expect(screen.getByText('match')).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Watch replay',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it('marks only the button that opens a replay with the play icon', () => {
    render(<OneInput variant="hero" />);
    type('https://skunk.club/d/Jnv7rxggBidutAQ2kv4DRv');
    expect(
      screen
        .getByRole('button', { name: 'Watch replay' })
        .querySelector('svg.play')
    ).not.toBeNull();
    type('[U:1:39734273]');
    expect(screen.getByRole('button').querySelector('svg.play')).toBeNull();
  });

  it('tags [U:1:39734273] as a profile and opens it', async () => {
    fetchFn.mockResolvedValue(
      json({ kind: 'profile', steamid: '76561198000000001' })
    );
    render(<OneInput variant="hero" />);
    type('[U:1:39734273]');
    expect(screen.getByText('profile')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
    await waitFor(() =>
      expect(location.pathname).toBe('/profiles/76561198000000001')
    );
    expect(fetchFn.mock.calls[0][0]).toBe(
      '/api/lookup?q=%5BU%3A1%3A39734273%5D'
    );
  });

  it('lists display-name hits when the vanity does not resolve', async () => {
    fetchFn.mockResolvedValue(
      json({
        kind: 'players',
        players: [
          { steamid: '76561198000000001', name: 'skunk', matches: 12 },
          { steamid: '76561198000000002', name: 'skunky', matches: 1 },
        ],
      })
    );
    render(<OneInput variant="hero" />);
    type('skunk');
    fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
    const first = await screen.findByRole('link', {
      name: /skunk\b.*12 matches/,
    });
    expect(first.getAttribute('href')).toBe('/profiles/76561198000000001');
    expect(
      screen.getByRole('link', { name: /skunky.*1 match\b/ })
    ).toBeTruthy();
    expect(location.pathname).toBe('/');
    // The count is a figure (the numbers' face), its word a label (the words' face).
    expect([...first.querySelectorAll('.n')].map((n) => n.textContent)).toEqual(
      ['12']
    );
  });

  // A player's name is words, set as words; a code, an ID or a link is set in the numbers' face.
  it.each([
    ['Alpha1', false],
    ['hello there !!', false],
    ['76561198000000001', true],
    ['STEAM_1:1:19867136', true],
    ['[U:1:39734273]', true],
    ['39734273', true],
    ['ABCDE-FGHJ', true],
    ['CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK', true],
    ['https://steamcommunity.com/id/Alpha1', true],
    ['skunk.club/profiles/76561198000000001', true],
  ])('sets "%s" in the numbers\' face: %s', (text, code) => {
    const { container } = render(<OneInput variant="hero" />);
    type(text);
    const form = container.querySelector('form')!;
    expect(form.dataset.code === 'true', text).toBe(code);
  });

  it("shows the server's answer when nobody is found", async () => {
    fetchFn.mockResolvedValue(
      json({ error: 'No Steam account or player called “zzz”' }, 404)
    );
    render(<OneInput variant="bar" />);
    type('zzz');
    fireEvent.click(screen.getByRole('button', { name: 'Open profile' }));
    expect(
      await screen.findByText('No Steam account or player called “zzz”')
    ).toBeTruthy();
  });

  it('opens a demo link without asking the server', async () => {
    render(<OneInput variant="hero" />);
    type('https://skunk.club/d/Jnv7rxggBidutAQ2kv4DRv');
    fireEvent.click(screen.getByRole('button', { name: 'Watch replay' }));
    await waitFor(() =>
      expect(location.pathname).toBe('/d/Jnv7rxggBidutAQ2kv4DRv')
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches the match of a FACEIT room link and opens its replay', async () => {
    fetchFn.mockResolvedValue(json({ demoId: 'fromfaceit' }, 202));
    render(<OneInput variant="hero" />);
    type(
      'https://www.faceit.com/en/cs2/room/1-2F3E4D5C-6B7A-4980-8F1E-2D3C4B5A6978/scoreboard'
    );
    expect(screen.getByText('match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Watch replay' }));
    await waitFor(() => expect(location.pathname).toBe('/d/fromfaceit'));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/demos');
    expect(JSON.parse(init.body)).toEqual({
      faceitMatch: '1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978',
    });
  });

  it("shows the server's answer when a FACEIT demo cannot be fetched", async () => {
    fetchFn.mockResolvedValue(
      json({ error: 'FACEIT demos must be uploaded' }, 422)
    );
    render(<OneInput variant="hero" />);
    type('faceit.com/de/cs2/room/2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978');
    fireEvent.click(screen.getByRole('button', { name: 'Watch replay' }));
    expect(
      await screen.findByText('FACEIT demos must be uploaded')
    ).toBeTruthy();
    expect(location.pathname).toBe('/');
  });

  it('shows no tag before anything is typed, and asks in sentence case', () => {
    const { container } = render(<OneInput variant="hero" />);
    expect(container.textContent).not.toContain('—');
    expect(container.querySelector('[aria-live]')?.textContent).toBe('');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.placeholder).toBe('Player name, Steam ID or match link');
    type('[U:1:39734273]');
    expect(container.querySelector('[aria-live]')?.textContent).toBe('profile');
  });

  it('asks in fewer words where the input is narrow', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
    );
    render(<OneInput variant="bar" />);
    expect((screen.getByRole('textbox') as HTMLInputElement).placeholder).toBe(
      'Player or match link'
    );
  });

  it('says unknown for "hello world" and keeps the button idle', () => {
    render(<OneInput variant="hero" />);
    type('hello world');
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});

describe('OneInput ?q=', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('starts with q, trimmed and cut to 200 characters', () => {
    window.history.replaceState(
      null,
      '',
      `/?q=${encodeURIComponent('  ' + 'a'.repeat(250) + ' ')}`
    );
    render(<OneInput variant="hero" />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(
      'a'.repeat(200)
    );
  });

  it('starts empty without q', () => {
    render(<OneInput variant="hero" />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });
});
