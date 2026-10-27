// The highlights panel (`H`, or "Highlights" in the camera bar), under the camera row: the
// match's highlights by round, the current round's group scrolled into view. A row plays its
// highlight; "play all" plays every highlight in the reel from that round on (the spec's
// "auto-director, highlights only"). "Opening kills" adds the plain opening kills, which the
// reel leaves out. It closes on a row, "play all", `H`, Escape (the key map) or a click
// outside it.

import { useLayoutEffect, useRef, useState } from 'react';
import type { Pack } from '../../pack/types';
import { highlightsOf } from '../../sim/highlights';
import { countRender, useDerived } from '../../state/derive';
import { useDismiss } from '../../state/dismiss';
import { highlightSegment, highlightSegments } from '../../state/reel';
import { playbackStore } from '../../state/store';
import { highlightRows, type HighlightRow } from './models';
import styles from './Highlights.module.css';

interface Group {
  round: number;
  /** The round's number, from 1. */
  number: number;
  rows: HighlightRow[];
  /** Whether "play all" from here has anything to play. */
  canPlay: boolean;
}

/**
 * The panel's groups, made once per pack and choice: the panel derives at every store change
 * while open, and the same object keeps its model equal.
 */
const made = new WeakMap<Pack, Map<boolean, Group[]>>();

function groupsOf(pack: Pack, withOpenings: boolean): Group[] {
  let byChoice = made.get(pack);
  if (!byChoice) made.set(pack, (byChoice = new Map()));
  let groups = byChoice.get(withOpenings);
  if (!groups) {
    // "Play all" from a round after the last highlight in the reel plays nothing.
    let last = -1;
    for (const h of highlightsOf(pack)) if (h.reel) last = h.round;
    groups = highlightRows(pack, withOpenings).map((g) => ({
      ...g,
      number: pack.header.rounds[g.round]?.number ?? g.round + 1,
      canPlay: g.round <= last,
    }));
    byChoice.set(withOpenings, groups);
  }
  return groups;
}

/** Plays one row's highlight (`highlightSegment`), and plays on from there after it. */
function playRow(row: HighlightRow): void {
  const s = playbackStore.getState();
  const h = s.pack ? highlightsOf(s.pack)[row.index] : undefined;
  if (!s.pack || !h) return;
  s.startReel('highlights', highlightSegment(s.pack, h), 'continue');
  s.setHighlights(false);
}

/** Plays the highlights reel from `round` on. */
function playAll(round: number): void {
  const s = playbackStore.getState();
  if (!s.pack) return;
  s.startReel(
    'highlights',
    highlightSegments(s.pack, highlightsOf(s.pack), round),
    'continue'
  );
  s.setHighlights(false);
}

function closeHighlights(): void {
  playbackStore.getState().setHighlights(false);
}

function onHighlightsToggle(t: Element): boolean {
  return t.closest('[data-highlights-toggle]') !== null;
}

export default function Highlights() {
  countRender('Highlights');
  const [openings, setOpenings] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Closed, nothing. Open, the groups (the same object until the choice or the pack changes)
  // and the round being played, which changes only with the round.
  const view = useDerived(
    (s) =>
      s.highlights && s.pack
        ? { round: s.round, groups: groupsOf(s.pack, openings) }
        : null,
    [openings]
  );
  const open = view !== null;
  // The round's group, or the next one with highlights (else the last).
  const anchor = view
    ? (view.groups.find((g) => g.round >= view.round) ?? view.groups.at(-1))
        ?.round
    : undefined;

  // On opening, and when the round moves on, that group comes to the top of the list.
  useLayoutEffect(() => {
    const el = list.current;
    if (!open || !el || anchor === undefined) return;
    const group = el.querySelector<HTMLElement>(`[data-round="${anchor}"]`);
    if (group) el.scrollTop = group.offsetTop;
  }, [open, anchor]);

  // A press outside the panel closes it, except on the camera bar's button, which toggles it.
  // Its Escape is the key map's.
  useDismiss(open, root, closeHighlights, {
    escape: false,
    ignore: onHighlightsToggle,
  });

  if (!view) return null;
  return (
    <div
      ref={root}
      className={styles.panel}
      role="dialog"
      aria-label="Highlights"
    >
      <div className={styles.head}>
        <span className={styles.title}>Highlights</span>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={openings}
            onChange={(e) => setOpenings(e.currentTarget.checked)}
          />
          Opening kills
        </label>
      </div>
      {view.groups.length === 0 ? (
        <p className={styles.empty}>No highlights in this match</p>
      ) : (
        <div ref={list} className={styles.list}>
          {view.groups.map((g) => (
            <section
              key={g.round}
              className={styles.group}
              data-round={g.round}
              data-current={g.round === view.round}
              aria-label={`Round ${g.number}`}
            >
              <div className={styles.groupHead}>
                <span className={styles.round}>Round {g.number}</span>
                <button
                  type="button"
                  className={styles.playAll}
                  disabled={!g.canPlay}
                  title="Play all from this round"
                  aria-label={`Play all from round ${g.number}`}
                  onClick={() => playAll(g.round)}
                >
                  Play all
                </button>
              </div>
              <ul className={styles.rows}>
                {g.rows.map((r) => (
                  <li key={r.key}>
                    <button
                      type="button"
                      className={styles.row}
                      data-team={r.player.team}
                      data-reel={r.reel}
                      onClick={() => playRow(r)}
                    >
                      <span className={styles.clock}>{r.clock}</span>
                      <span className={styles.name}>{r.player.name}</span>
                      <span className={styles.label}>{r.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
