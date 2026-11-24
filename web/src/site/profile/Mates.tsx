// Who the player played with: those on their team most often, over all their matches, each name
// linking to their profile, with their matches together, the wins and the share won. The server
// never lists a hidden player. Left out when there is no one.

import type { Mate } from '../../api/players';
import Pct from '../Pct';
import SiteLink from '../SiteLink';
import s from './profile.module.css';

export default function Mates({ mates }: { mates: Mate[] }) {
  if (!mates.length) return null;
  return (
    <div className={s.mates} data-testid="mates">
      <h2 className={s.head}>Played with</h2>
      {mates.map((m) => (
        <div key={m.steamid} className={s.mrow} data-mate>
          <div className={`${s.m} ${s.mateCell}`}>
            <SiteLink className={s.mateName} href={`/profiles/${m.steamid}`}>
              {m.name}
            </SiteLink>
          </div>
          <div>
            <span className="n">{m.matches}</span>
            <span className={s.lab}>
              {m.matches === 1 ? 'match' : 'matches'}
            </span>
          </div>
          <div>
            <span className="n">{m.wins}</span>
            <span className={s.lab}>{m.wins === 1 ? 'win' : 'wins'}</span>
          </div>
          <div className={s.across}>
            <span className="n">
              <Pct value={m.matches ? (100 * m.wins) / m.matches : null} />
            </span>
            <span className={s.lab}>won</span>
          </div>
        </div>
      ))}
    </div>
  );
}
