// The stat strip: the rating first and largest, then opening duels, K/D, ADR, HS% and matches,
// each number in its rainbow colour with its label after it.

import type { ReactNode } from 'react';
import type { Totals } from '../../api/players';
import { DASH, formatInt, formatRating, plural, RAINBOW } from '../format';
import Pct from '../Pct';
import s from './profile.module.css';

export default function StatStrip({ totals }: { totals: Totals }) {
  const duels = totals.openingWon + totals.openingLost;
  const stats: [ReactNode, string][] = [
    [formatRating(totals.rating), 'rating'],
    [
      <Pct value={duels ? (100 * totals.openingWon) / duels : null} />,
      'opening',
    ],
    [totals.kd === null ? DASH : totals.kd.toFixed(2), 'K/D'],
    [formatInt(totals.adr), 'ADR'],
    [formatInt(totals.hsPct), 'HS%'],
    [String(totals.matches), plural(totals.matches, 'match', 'matches')],
  ];
  return (
    <div className={`g ${s.stats}`} data-testid="stat-strip">
      {stats.map(([value, label], i) => (
        <div key={label} className={`${s.stat} ${i === 0 ? s.lead : ''}`}>
          <span className="n" style={{ color: RAINBOW[i] }}>
            {value}
          </span>
          <span data-label>{label}</span>
          {i === 1 && duels > 0 && (
            <span className={s.sub}>
              <span className="n">
                {totals.openingWon}–{totals.openingLost}
              </span>{' '}
              won–lost
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
