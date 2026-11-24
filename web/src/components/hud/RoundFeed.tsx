// Bottom right: what just happened in the round, in words: throws, the plant, the defuse (the
// kills are the killfeed's, on screen with it). The newest is brightest.

import { countRender, useDerived } from '../../state/derive';
import { timelineFor } from '../../sim/timeline';
import { roundFeedRows } from './models';
import styles from './hud.module.css';

export default function RoundFeed() {
  countRender('RoundFeed');
  // Changes when an event comes in or ages out. A row's brightness is by its place in the
  // list, not its age, so it changes only with the rows.
  const rows = useDerived(
    (s) =>
      s.pack
        ? roundFeedRows(timelineFor(s.pack), s.round, s.tick, s.playing, false)
        : [],
    []
  );
  if (rows.length === 0) return null;
  return (
    <ol className={styles.roundFeed} aria-label="Round events">
      {rows.map((r, i) => (
        <li
          key={r.key}
          className={styles.feedRow}
          data-team={r.team ?? 0}
          data-kind={r.kind}
          style={{ opacity: 0.45 + (0.55 * (i + 1)) / rows.length }}
        >
          {r.text}
        </li>
      ))}
    </ol>
  );
}
