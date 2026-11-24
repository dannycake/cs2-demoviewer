// @vitest-environment jsdom
// The links under the home page's upload (site/HomeLinks): recent tournaments, and no players.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomeLinks from '../src/site/HomeLinks';
import { dropPre, preShown, putPre } from './helpers/pre';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  dropPre();
});

describe('HomeLinks', () => {
  it('links the tournaments, and lists no players', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        events: [
          {
            slug: 'iem_x',
            name: 'IEM X',
            matches: 3,
            firstUnix: 1,
            lastUnix: 2,
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchFn);
    render(<HomeLinks />);
    const ev = await screen.findByRole('link', { name: 'IEM X' });
    expect(ev.getAttribute('href')).toBe('/events/iem_x');
    expect(screen.getByRole('link', { name: 'All' }).getAttribute('href')).toBe(
      '/events'
    );
    expect(screen.queryByText('Players')).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the fetch fails', async () => {
    const fetchFn = vi.fn(async () => new Response('x', { status: 500 }));
    vi.stubGlobal('fetch', fetchFn);
    const { container } = render(<HomeLinks />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
  });

  it("removes the server's body once the links are in", async () => {
    putPre();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          events: [
            {
              slug: 'iem_x',
              name: 'IEM X',
              matches: 3,
              firstUnix: 1,
              lastUnix: 2,
            },
          ],
        })
      )
    );
    render(<HomeLinks />);
    expect(preShown()).toBe(true);
    await screen.findByRole('link', { name: 'IEM X' });
    await waitFor(() => expect(preShown()).toBe(false));
  });

  it("keeps the server's body when the fetch fails", async () => {
    putPre();
    const fetchFn = vi.fn(async () => new Response('x', { status: 500 }));
    vi.stubGlobal('fetch', fetchFn);
    render(<HomeLinks />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(preShown()).toBe(true);
  });

  it('renders nothing when there are no tournaments, and the server’s body goes: none is an answer', async () => {
    putPre();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ events: [] }))
    );
    const { container } = render(<HomeLinks />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe('');
    await waitFor(() => expect(preShown()).toBe(false));
  });
});
