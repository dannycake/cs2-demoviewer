// The figures under the stat strip, in white, over the same matches: KAST, rounds survived,
// assists and the record; rounds of 2, 3, 4 and 5 kills; rounds, kills, deaths and the hours in
// game in those matches, as against the account's hours in CS2 at the top of the page (a dash when
// matches say nothing of their length, as a game's own row does: ./row-totals). Four a row, two on
// a phone.

import type { ReactNode } from 'react';
import type { Totals } from '../../api/players';
import { DASH, formatHours, plural } from '../format';
import Pct from '../Pct';
import s from './profile.module.css';

export default function StatGrid({ totals: t }: { totals: Totals }) {
  const decided = t.wins + t.losses + t.ties;
  const [k2, k3, k4, k5] = t.multiKills;
  const hours =
    t.matches > 0 && t.seconds === 0 ? DASH : formatHours(t.seconds);
  const figures: [ReactNode, string, ReactNode?][] = [
    [<Pct value={t.kastPct} />, 'KAST'],
    [<Pct value={t.survivalPct} />, 'survived'],
    [t.assists, plural(t.assists, 'assist', 'assists')],
    [
      `${t.wins}–${t.losses}–${t.ties}`,
      'record',
      decided > 0 && (
        <>
          <span className="n">
            <Pct value={(100 * t.wins) / decided} />
          </span>{' '}
          won
        </>
      ),
    ],
    [k2, '2K'],
    [k3, '3K'],
    [k4, '4K'],
    [k5, plural(k5, 'ace', 'aces')],
    [t.rounds, plural(t.rounds, 'round', 'rounds')],
    [t.kills, plural(t.kills, 'kill', 'kills')],
    [t.deaths, plural(t.deaths, 'death', 'deaths')],
    [hours, plural(hours, 'hour in game', 'hours in game')],
  ];
  return (
    <div className={`g ${s.figs}`} data-testid="stat-grid">
      {figures.map(([value, label, sub]) => (
        <div key={label} className={s.stat}>
          <span className="n">{value}</span>
          {/* 2K, 3K, 4K: a number, so in the numbers' face. */}
          <span data-label className={/\d/.test(label) ? s.labN : undefined}>
            {label}
          </span>
          {sub && <span className={s.sub}>{sub}</span>}
        </div>
      ))}
    </div>
  );
}
