// Top centre, under the round bar, from a round's end through its after-round (with "Round
// summary" on, and never during a reel, when the reel's banner is there): who won and how,
// the MVP, each player's kills and damage in the round (the winners first), and each one's
// money and buys at the start of the next round. Without money data or purchases those
// columns are left out, not shown as zeros. The close button hides it until the next round.

import { useEffect, useState } from 'react';
import {
  roundSummary,
  summaryShown,
  type RoundSummary as Summary,
  type SummaryPlayer,
} from '../../sim/summary';
import { countRender, useDerived } from '../../state/derive';
import { useSettings } from '../../state/settings';
import { playbackStore } from '../../state/store';
import { REASON_TEXT, reasonGlyph } from './models';
import WeaponIcon from './WeaponIcon';
import styles from './RoundSummary.module.css';

const SIDE: Record<number, string> = { 2: 'T', 3: 'CT' };

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Why the MVP is the MVP, after their name. */
function why(mvp: NonNullable<Summary['mvp']>, p: SummaryPlayer): string {
  if (mvp.why === 'bomb') return 'planted the bomb';
  if (mvp.why === 'defuse') return 'defused the bomb';
  return `${count(p.kills, 'kill')}, ${Math.round(p.damage)} damage`;
}

export default function RoundSummary() {
  countRender('RoundSummary');
  const on = useSettings((s) => s.settings.roundSummary);
  /** The round whose summary was closed; forgotten when the round or the pack changes. */
  const [closed, setClosed] = useState<number | null>(null);
  useEffect(
    () =>
      playbackStore.subscribe((s, prev) => {
        if (s.round !== prev.round || s.pack !== prev.pack) setClosed(null);
      }),
    []
  );
  // Changes when the panel shows or hides; not with the frame.
  const view = useDerived(
    (s) =>
      s.pack &&
      s.round !== closed &&
      summaryShown(s.pack, s.round, s.tick, s.reel !== null, on)
        ? {
            summary: roundSummary(s.pack, s.round),
            number: s.pack.header.rounds[s.round].number,
          }
        : null,
    [on, closed]
  );
  if (!view) return null;
  const { summary: s, number } = view;
  const mvp = s.players.find((p) => p.index === s.mvp?.index) ?? null;
  const next = new Map(s.next?.map((n) => [n.index, n]));
  const money = s.next?.some((n) => n.money !== null) ?? false;
  const buys = s.next?.some((n) => n.buys.length > 0) ?? false;
  const sides = s.winner === 2 ? [2, 3] : [3, 2];
  return (
    <section
      className={styles.panel}
      aria-label={`Round ${number} summary`}
      data-testid="round-summary"
    >
      <header className={styles.head}>
        <span className={styles.round}>Round {number}</span>
        <span className={styles.result} data-team={s.winner || undefined}>
          {s.winner ? `${SIDE[s.winner]} win` : 'No winner'}
        </span>
        <span className={styles.reason}>
          {REASON_TEXT[reasonGlyph(s.reason)]}
        </span>
        <button
          type="button"
          className={styles.close}
          title="Hide until the next round"
          aria-label="Hide the round summary until the next round"
          onClick={() => setClosed(playbackStore.getState().round)}
        >
          <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              d="M4 4l8 8M12 4l-8 8"
            />
          </svg>
        </button>
      </header>
      {mvp && s.mvp && (
        <p className={styles.mvp} data-team={mvp.team}>
          <span className={styles.mvpLabel}>MVP</span>
          <span className={styles.mvpName}>{mvp.name}</span>
          <span className={styles.why}>{why(s.mvp, mvp)}</span>
        </p>
      )}
      <div className={styles.body}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col" title="Kills">
                K
              </th>
              <th scope="col" title="Damage">
                Dmg
              </th>
              {(money || buys) && (
                <th
                  scope="colgroup"
                  colSpan={Number(money) + Number(buys)}
                  className={styles.nextHead}
                >
                  Next round
                </th>
              )}
            </tr>
          </thead>
          {sides.map((team) => (
            <tbody key={team} data-team={team}>
              {s.players
                .filter((p) => p.team === team)
                .map((p) => {
                  const n = next.get(p.index);
                  return (
                    <tr key={p.index} data-alive={p.alive}>
                      <th scope="row" className={styles.name}>
                        <span className={styles.nameText}>{p.name}</span>
                        {p.index === mvp?.index && (
                          <span className={styles.tag}>MVP</span>
                        )}
                      </th>
                      <td>{p.kills}</td>
                      <td>{Math.round(p.damage)}</td>
                      {money && (
                        <td className={styles.money}>
                          {n && n.money !== null
                            ? `$${n.money.toLocaleString('en-US')}`
                            : ''}
                        </td>
                      )}
                      {buys && (
                        <td className={styles.buys}>
                          <span className={styles.icons}>
                            {n?.buys.map((b, i) => (
                              <WeaponIcon
                                key={i}
                                name={b.icon}
                                label={b.label}
                                height={1}
                              />
                            ))}
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}
