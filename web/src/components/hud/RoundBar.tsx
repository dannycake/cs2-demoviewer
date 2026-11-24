// Top centre: CT score, the round clock, T score; under each score one pip per player, solid
// while alive. The bomb timer replaces the clock once it is planted.

import { countRender, useDerived } from '../../state/derive';
import { timelineFor } from '../../sim/timeline';
import Digits from './Digits';
import { Bomb } from './icons';
import { roundBarModel, type Side } from './models';
import styles from './hud.module.css';

function Score({ side, label }: { side: Side; label: string }) {
  const alive = side.alive.filter(Boolean).length;
  return (
    <div className={styles.score} data-team={side.team}>
      <span className={styles.scoreNum} aria-label={`${label} ${side.score}`}>
        {side.score}
      </span>
      <span
        className={styles.pips}
        aria-label={`${alive} of ${side.alive.length} alive`}
      >
        {side.alive.map((a, i) => (
          <i key={i} data-alive={a} />
        ))}
      </span>
    </div>
  );
}

export default function RoundBar() {
  countRender('RoundBar');
  // The clock reads whole seconds: this changes once a second, and with a death.
  const m = useDerived(
    (s) =>
      s.pack && s.pack.header.rounds[s.round]
        ? roundBarModel(s.pack, timelineFor(s.pack), s.round, s.tick)
        : null,
    []
  );
  if (!m) return null;
  const { phase, text } = m.timer;
  return (
    <div className={styles.roundBar} role="group" aria-label="Round">
      <Score side={m.ct} label="CT" />
      <div className={styles.clock} data-phase={phase}>
        <span className={styles.time}>
          {phase === 'planted' && <Bomb className={styles.clockBomb} />}
          {phase === 'over' ? 'Round over' : text}
        </span>
        <span className={styles.clockMeta}>
          {phase === 'freeze' ? (
            'Buy time'
          ) : (
            <Digits text={`Round ${m.round}`} />
          )}
          <span className={styles.half}>
            <Digits text={m.half} />
          </span>
        </span>
      </div>
      <Score side={m.t} label="T" />
    </div>
  );
}
