// A tracked player's FACEIT history (the server's `faceitHistory`): their newest FACEIT matches as
// FACEIT gave them, labelled as FACEIT's data, never counted with the site's. One row a match:
// its day, map, score, result and competition (a dash where FACEIT said none), then its links.
// Its Replay alone when the site holds its demo. Else its room on FACEIT, in a new tab (where its
// demo can be downloaded), after Upload the demo, the home page's upload with the FACEIT hint,
// when an upload of it would attach to the row: the server's attach pass looks only at tracked
// players' histories, and tells a match's demo by its map, score and players. Left out when
// there is no match.

import type { FaceitRow, Profile } from '../../api/players';
import { mapName } from '../../components/hud/models';
import { DASH, formatDay } from '../format';
import PlayIcon from '../PlayIcon';
import SiteLink from '../SiteLink';
import { Away } from './Who';
import s from './profile.module.css';

/** The home page's upload, saying that a FACEIT demo attaches to its match here (HomeView). */
export const FACEIT_UPLOAD = '/?hint=faceit';

/** Whether an upload of `row`'s demo would attach to it: the player is tracked, and FACEIT gave
 * the facts an upload is told by. */
function attachable(row: FaceitRow, tracking: Profile['tracking']): boolean {
  return tracking === 'on' && row.map !== null && row.score !== null;
}

/** A row's links, in one cell: its Replay alone when the site holds its demo; else Upload the
 * demo when an upload would attach to the row, and always its room on FACEIT. */
function Links({
  row,
  tracking,
}: {
  row: FaceitRow;
  tracking: Profile['tracking'];
}) {
  if (row.replay)
    return (
      <SiteLink className={s.replay} href={`/d/${row.replay}`}>
        <PlayIcon />
        Replay
      </SiteLink>
    );
  return (
    <div className={s.fgo}>
      {attachable(row, tracking) && (
        <SiteLink className={s.faceitGo} href={FACEIT_UPLOAD}>
          Upload the demo
        </SiteLink>
      )}
      <a
        className={s.faceitGo}
        href={row.roomUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Watch on FACEIT
        <Away />
      </a>
    </div>
  );
}

export default function FaceitHistory({
  rows,
  tracking,
}: {
  rows: FaceitRow[];
  tracking: Profile['tracking'];
}) {
  if (!rows.length) return null;
  const now = new Date();
  return (
    <div className={s.faceit} data-testid="faceit-history">
      <h2 className={s.head}>
        On FACEIT
        <span className={s.headNote}>FACEIT&apos;s data</span>
      </h2>
      {rows.map((r) => (
        <div key={r.matchId} className={s.frow} data-testid="faceit-row">
          <div className={s.fday} data-cell>
            {formatDay(r.finishedUnix, now)}
          </div>
          <div className={s.m} data-cell>
            {r.map ? mapName(r.map) : DASH}
          </div>
          <div data-cell>
            <span className="n">
              {r.score ? `${r.score[0]}–${r.score[1]}` : DASH}
            </span>
          </div>
          <div
            className={`${s.fres} ${r.won === true ? s.res_w : ''}`}
            data-cell
          >
            {r.won === null ? DASH : r.won ? 'W' : 'L'}
          </div>
          <div className={s.fcomp} data-cell>
            {r.competition ?? DASH}
          </div>
          <Links row={r} tracking={tracking} />
        </div>
      ))}
    </div>
  );
}
