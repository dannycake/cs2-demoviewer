// @vitest-environment jsdom
// A tracked player's FACEIT history on their profile (site/profile/FaceitHistory): the "On
// FACEIT" block, labelled as FACEIT's data, one row a match (date, map, score, result,
// competition) and its links: its Replay alone when the site holds the demo; else its room on
// FACEIT, in a new tab, after Upload the demo when an upload of it would attach to the row (the
// player is tracked and FACEIT gave its map and score). None without a match.

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FaceitRow } from '../src/api/players';
import { formatDay } from '../src/site/format';
import FaceitHistory from '../src/site/profile/FaceitHistory';

const room = (id: string) => `https://www.faceit.com/en/cs2/room/${id}`;
const row = (over: Partial<FaceitRow>): FaceitRow => ({
  matchId: '1-a',
  finishedUnix: 1_790_000_000,
  map: 'de_mirage',
  score: [13, 9],
  won: true,
  competition: 'CS2 5v5',
  replay: null,
  roomUrl: room('1-a'),
  ...over,
});

afterEach(cleanup);

/** Each row's cells' text, and each of its links as [text, href, target, rel]. */
function rows() {
  return screen.getAllByTestId('faceit-row').map((r) => ({
    cells: [...r.querySelectorAll('[data-cell]')].map((c) => c.textContent),
    links: within(r)
      .getAllByRole('link')
      .map((a) => [
        a.textContent,
        a.getAttribute('href'),
        a.getAttribute('target'),
        a.getAttribute('rel'),
      ]),
  }));
}

/** A row's room on FACEIT, as its link is. */
const watch = (id: string) => [
  'Watch on FACEIT',
  room(id),
  '_blank',
  'noopener noreferrer',
];
const UPLOAD = ['Upload the demo', '/?hint=faceit', null, null];

describe('FaceitHistory', () => {
  it('shows nothing without a match', () => {
    const { container } = render(<FaceitHistory rows={[]} tracking="on" />);
    expect(container.innerHTML).toBe('');
  });

  it("heads the block On FACEIT, labelled as FACEIT's data, each match's facts in its row", () => {
    render(
      <FaceitHistory
        rows={[
          row({ matchId: '1-a', replay: 'Jnv7rxggBidutAQ2kv4DRv' }),
          row({
            matchId: '1-b',
            finishedUnix: 1_789_000_000,
            map: null,
            score: null,
            won: null,
            competition: null,
          }),
          row({ matchId: '1-c', won: false, score: [7, 13] }),
        ]}
        tracking="on"
      />
    );
    const block = screen.getByTestId('faceit-history');
    // The label at the heading's end, as the replays' "‹n› of ‹m› matches" is.
    const heading = within(block).getByRole('heading');
    expect(heading.firstChild?.textContent).toBe('On FACEIT');
    expect(within(heading).getByText("FACEIT's data")).toBeTruthy();
    const now = new Date();
    expect(rows().map((r) => r.cells)).toEqual([
      [formatDay(1_790_000_000, now), 'Mirage', '13–9', 'W', 'CS2 5v5'],
      [formatDay(1_789_000_000, now), '—', '—', '—', '—'],
      [formatDay(1_790_000_000, now), 'Mirage', '7–13', 'L', 'CS2 5v5'],
    ]);
  });

  it('links a held match to its replay here, and to nothing else', () => {
    render(
      <FaceitHistory
        rows={[row({ replay: 'Jnv7rxggBidutAQ2kv4DRv' })]}
        tracking="on"
      />
    );
    expect(rows()[0].links).toEqual([
      ['Replay', '/d/Jnv7rxggBidutAQ2kv4DRv', null, null],
    ]);
  });

  it("offers a tracked player's match without a replay to be uploaded, then its room on FACEIT", () => {
    render(<FaceitHistory rows={[row({})]} tracking="on" />);
    expect(rows()[0].links).toEqual([UPLOAD, watch('1-a')]);
  });

  it('links a match an upload would not attach to its room on FACEIT alone, in a new tab', () => {
    // Not tracked: the attach pass never looks at their history.
    for (const tracking of ['stopped', 'off'] as const) {
      render(<FaceitHistory rows={[row({})]} tracking={tracking} />);
      expect(rows()[0].links, tracking).toEqual([watch('1-a')]);
      cleanup();
    }
    // Tracked, but FACEIT gave no map or no score: an upload is told by them.
    render(
      <FaceitHistory
        rows={[
          row({ matchId: '1-b', map: null, roomUrl: room('1-b') }),
          row({ matchId: '1-c', score: null, roomUrl: room('1-c') }),
        ]}
        tracking="on"
      />
    );
    expect(rows().map((x) => x.links)).toEqual([
      [watch('1-b')],
      [watch('1-c')],
    ]);
  });

  it('keeps a row to six cells, the links sharing the last', () => {
    render(<FaceitHistory rows={[row({})]} tracking="on" />);
    const [r] = screen.getAllByTestId('faceit-row');
    expect(r.children).toHaveLength(6);
    expect(
      within(r.children[5] as HTMLElement).getAllByRole('link')
    ).toHaveLength(2);
  });
});
