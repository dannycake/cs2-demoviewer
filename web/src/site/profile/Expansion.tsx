// What a map's or a match's row opens to, directly under it (its ./Toggle): the profile's own
// stat strip, the figures under it and what the replays add, over that map's matches or that one
// game, set in one level from the table's edge. A note, when there is one, goes first in grey ("Not
// in the totals"). Without replay figures their blocks are left out, as the profile leaves them
// out for a player none of whose matches has them.

import type { ReplayTotals, Totals } from '../../api/players';
import FromReplays from './FromReplays';
import StatGrid from './StatGrid';
import StatStrip from './StatStrip';
import s from './profile.module.css';

export default function Expansion({
  id,
  totals,
  replay,
  note,
  label,
}: {
  id: string;
  totals: Totals;
  /** Null for a game whose summary is from before the replays were read for it. */
  replay: ReplayTotals | null;
  note?: string;
  /** Its name for screen readers: "Mirage stats". */
  label?: string;
}) {
  return (
    <div id={id} className={s.expansion} role="region" aria-label={label}>
      {note && <p className={s.note}>{note}</p>}
      <StatStrip totals={totals} />
      <StatGrid totals={totals} />
      {replay && <FromReplays replay={replay} matches={totals.matches} />}
    </div>
  );
}
