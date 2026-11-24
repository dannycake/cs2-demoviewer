// @vitest-environment jsdom
// The tournaments pages (site/EventsView): the list, one event's matches, and a missing event.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventsView from '../src/site/EventsView';
import { dropPre, preShown, putPre } from './helpers/pre';

const EVENT = {
  slug: 'iem_cologne_2025',
  name: 'IEM Cologne 2025',
  matches: 2,
  firstUnix: 1761091200,
  lastUnix: 1761696000,
};

/** `/api/events…` answers with `body`; the bar's own requests (`/api/me`, the assets) find nothing. */
function answer(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).startsWith('/api/events')
        ? Response.json(body, { status })
        : new Response('', { status: 404 })
    )
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  dropPre();
});

describe('EventsView', () => {
  it('lists the tournaments, each linking to its page', async () => {
    answer([EVENT]);
    render(<EventsView />);
    const link = await screen.findByRole('link', { name: 'IEM Cologne 2025' });
    expect(link.getAttribute('href')).toBe('/events/iem_cologne_2025');
    expect(
      screen.getByText((_, el) => el?.textContent === '2 matches')
    ).toBeTruthy();
    expect(screen.getByText(/Oct 22, 2025/)).toBeTruthy();
    expect(document.title).toBe('CS2 tournament demos · skunk.club');
  });

  it('shows an event as a table with replay links', async () => {
    answer({
      event: EVENT,
      matches: [
        {
          demoId: 'abc',
          map: 'de_mirage',
          title: 'Mirage 13-9',
          score: [13, 9],
          playedUnix: 1761091200,
          top: 'Alpha1',
        },
      ],
    });
    render(<EventsView slug="iem_cologne_2025" />);
    expect(
      await screen.findByRole('heading', { name: 'IEM Cologne 2025' })
    ).toBeTruthy();
    expect(screen.getByText('Mirage')).toBeTruthy();
    expect(screen.getByText('13–9')).toBeTruthy();
    expect(screen.getByText('Alpha1')).toBeTruthy();
    const replay = screen.getByRole('link', { name: 'Replay Mirage 13-9' });
    expect(
      screen.getByRole('link', { name: 'Mirage' }).getAttribute('href')
    ).toBe('/d/abc');
    expect(replay.getAttribute('href')).toBe('/d/abc');
    expect(replay.querySelector('svg.play')).not.toBeNull();
    expect(document.title).toBe('IEM Cologne 2025 CS2 demos · skunk.club');
  });

  it('shows the tournament\'s own dates, and no Date column when no match has a day', async () => {
    const row = {
      demoId: 'abc',
      map: 'de_mirage',
      title: 'Mirage 13–9',
      score: [13, 9],
      playedUnix: null,
      top: 'Alpha1',
    };
    answer({ event: EVENT, matches: [row] });
    render(<EventsView slug="iem_cologne_2025" />);
    const dates = await screen.findByTestId('event-span');
    expect(dates.textContent).toContain('Oct 22, 2025 – Oct 29, 2025');
    const [head, match] = [
      document.querySelector('[data-match]')!.previousElementSibling!,
      document.querySelector('[data-match]')!,
    ];
    expect(head.className).toMatch(/undated/);
    expect(match.className).toMatch(/undated/);
  });

  it('keeps the Date column when a match has a day', async () => {
    answer({
      event: EVENT,
      matches: [
        {
          demoId: 'abc',
          map: 'de_mirage',
          title: 'Mirage 13–9',
          score: [13, 9],
          playedUnix: 1761091200,
          top: 'Alpha1',
        },
      ],
    });
    render(<EventsView slug="iem_cologne_2025" />);
    await screen.findByTestId('event-span');
    expect(document.querySelector('[data-match]')!.className).not.toMatch(
      /undated/
    );
  });

  it('adds a Teams column only when a match has teams', async () => {
    const row = {
      demoId: 'abc',
      map: 'de_dust2',
      title: 'Dust II 13-9',
      score: [13, 9] as [number, number],
      playedUnix: 1761091200,
      top: 'Alpha1',
    };
    answer({
      event: EVENT,
      matches: [
        { ...row, teams: ['Spirit', 'Falcons'] },
        { ...row, demoId: 'b' },
      ],
    });
    const { unmount } = render(<EventsView slug="iem_cologne_2025" />);
    expect(await screen.findByText('Spirit vs Falcons')).toBeTruthy();
    expect(screen.getByText('Teams')).toBeTruthy();
    unmount();
    answer({ event: EVENT, matches: [row] });
    render(<EventsView slug="iem_cologne_2025" />);
    await screen.findByText('Dust II');
    expect(screen.queryByText('Teams')).toBeNull();
  });

  it('says so for an event that does not exist, titled as the server titles it', async () => {
    answer({ error: 'no such event' }, 404);
    render(<EventsView slug="nope" />);
    expect(await screen.findByText('No such tournament')).toBeTruthy();
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/')
    ).toBe(true);
    // The title is set in an effect after the view renders.
    await waitFor(() =>
      expect(document.title).toBe('Tournament not found · skunk.club')
    );
  });

  it('shows the error of a failed fetch', async () => {
    answer({ error: 'database is down' }, 500);
    render(<EventsView />);
    expect(await screen.findByText('database is down')).toBeTruthy();
  });

  it("removes the server's body once the list is in", async () => {
    putPre();
    answer([EVENT]);
    render(<EventsView />);
    expect(preShown()).toBe(true);
    await screen.findByRole('link', { name: 'IEM Cologne 2025' });
    await waitFor(() => expect(preShown()).toBe(false));
  });

  it("removes the server's body once the event is in", async () => {
    putPre();
    answer({ event: EVENT, matches: [] });
    render(<EventsView slug="iem_cologne_2025" />);
    await screen.findByRole('heading', { name: 'IEM Cologne 2025' });
    await waitFor(() => expect(preShown()).toBe(false));
  });

  it("over the server's body, a failed fetch is one slim line, the body kept, and Try again loads it", async () => {
    putPre();
    answer({ error: 'database is down' }, 500);
    render(<EventsView />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The live list did not load.'
    );
    expect(screen.queryByText('database is down')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(preShown()).toBe(true);
    answer([EVENT]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: 'IEM Cologne 2025' });
    await waitFor(() => expect(preShown()).toBe(false));
  });

  it("over the server's body, shows only the bar and a loading bar while it loads", async () => {
    putPre();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('/api/events')
          ? new Promise<Response>(() => {})
          : new Response('', { status: 404 })
      )
    );
    const { container } = render(<EventsView slug="iem_cologne_2025" />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeTruthy();
    // The app draws no heading of its own: the server's body is the page.
    expect(within(container).queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(preShown()).toBe(true);
  });

  it("keeps the server's title while loading and after a failed fetch, as a renderer without the API sees it", async () => {
    document.title = 'IEM Cologne 2025 · skunk.club';
    answer({ error: 'database is down' }, 500);
    render(<EventsView slug="iem_cologne_2025" />);
    expect(document.title).toBe('IEM Cologne 2025 · skunk.club');
    await screen.findByText('database is down');
    expect(document.title).toBe('IEM Cologne 2025 · skunk.club');
  });
});
