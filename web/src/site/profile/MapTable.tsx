// The maps the player played, most first, under their heading: each name over a strip of the
// map's screenshot (./strip), as the match rows have it, then matches, wins, rating and the
// latest Competitive rank, and a toggle (./Toggle) that opens the map's own strip, figures and
// replay figures under its row (./Expansion). One map is open at a time.

import { Fragment, useId, useState } from 'react';
import type { MapLine } from '../../api/players';
import { mapName } from '../../components/hud/models';
import { DASH, formatRating } from '../format';
import Pct from '../Pct';
import { useSiteAssets } from '../use-site-assets';
import Expansion from './Expansion';
import { NoRank, RankIcon } from './Ranks';
import { stripCell } from './strip';
import Toggle from './Toggle';
import s from './profile.module.css';

export default function MapTable({ maps }: { maps: MapLine[] }) {
  const assets = useSiteAssets();
  const id = useId();
  /** The map whose figures are open. */
  const [open, setOpen] = useState<string | null>(null);
  const lines: (MapLine | null)[] = maps.length ? maps : [null];
  return (
    <section className={s.maps} data-testid="map-table">
      <h2 className={s.head}>Maps</h2>
      {lines.map((m, i) => {
        const shown = m !== null && m.map === open;
        const name = m ? mapName(m.map) : DASH;
        const panel = m ? `${id}-${m.map}` : '';
        return (
          <Fragment key={m?.map ?? i}>
            <div className={`${s.mrow} ${s.maprow}`} data-map>
              <div {...stripCell(assets, m?.map, s.m)}>{name}</div>
              <div>
                <span className="n">{m ? m.matches : DASH}</span>
                <span className={s.lab}>
                  {m?.matches === 1 ? 'match' : 'matches'}
                </span>
              </div>
              <div>
                <span className="n">
                  <Pct value={m?.winPct ?? null} />
                </span>
                <span className={s.lab}>wins</span>
              </div>
              <div>
                <span className="n">{formatRating(m?.rating ?? null)}</span>
                <span className={s.lab}>rating</span>
              </div>
              <div className={s.wide}>
                {m?.rank ? <RankIcon rank={m.rank} small /> : <NoRank />}
              </div>
              {m ? (
                <Toggle
                  open={shown}
                  controls={panel}
                  label={`${shown ? 'Hide' : 'Show'} ${name} stats`}
                  onToggle={() => setOpen(shown ? null : m.map)}
                />
              ) : (
                // The dash row has nothing to open; its cell keeps the row's black.
                <div />
              )}
            </div>
            {shown && (
              <Expansion
                id={panel}
                totals={m.totals}
                replay={m.replay}
                label={`${name} stats`}
              />
            )}
          </Fragment>
        );
      })}
    </section>
  );
}
