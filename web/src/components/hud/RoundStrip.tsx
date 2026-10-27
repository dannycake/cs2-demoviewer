// Above the transport: one cell per round in the winner's colour with how it was won, the
// current round outlined and a gap at each half. A click goes to that round.

import { playbackStore, usePlayback } from '../../state/store';
import { Bomb, Defuse, Eliminated, TimeRanOut } from './icons';
import { REASON_TEXT, roundStripModel, type ReasonGlyph } from './models';
import styles from './hud.module.css';

const GLYPH: Record<Exclude<ReasonGlyph, ''>, typeof Bomb> = {
  elim: Eliminated,
  bomb: Bomb,
  defuse: Defuse,
  time: TimeRanOut,
};

export default function RoundStrip() {
  const pack = usePlayback((s) => s.pack);
  const round = usePlayback((s) => s.round);
  if (!pack) return null;
  const cells = roundStripModel(pack, round);
  return (
    <ol className={styles.strip} aria-label="Rounds">
      {cells.map((c) => {
        const Glyph = c.glyph ? GLYPH[c.glyph] : null;
        const who = c.winner === 2 ? 'T' : c.winner === 3 ? 'CT' : 'nobody';
        return (
          <li key={c.index} data-half={c.halfStart}>
            <button
              type="button"
              className={styles.cell}
              data-winner={c.winner}
              aria-current={c.current ? 'true' : undefined}
              title={`Round ${c.number}: ${who} won ${REASON_TEXT[c.glyph]}`.trim()}
              onClick={() => playbackStore.getState().seekRound(c.index)}
            >
              {Glyph ? <Glyph /> : <span>{c.number}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
