// The Premier badge (CS2's slanted rating, coloured by its band), a Competitive rank's icon, and
// the ranks block: Premier on the left, one Competitive rank on the right. No rank (none held,
// unrated or unranked) looks one way: a word in an outline in the block, a plain dash in a table.

import type { CSSProperties, ReactNode } from 'react';
import type { CompetitiveRank, PremierRank } from '../../api/players';
import { rankIconUrl } from '../../api/site-assets';
import { mapName } from '../../components/hud/models';
import {
  DASH,
  PREMIER_COLOURS,
  premierParts,
  premierTier,
  rankName,
} from '../format';
import { useSiteAssets } from '../use-site-assets';
import s from './profile.module.css';

/** No rank in a table's cell: a plain dash, as any unknown there. */
export function NoRank() {
  return <span className={s.none}>{DASH}</span>;
}

/** No rank in the ranks block: its word in an outline the size of a badge. */
function NoRankBox({ word }: { word: string }) {
  return <span className={`${s.badge} ${s.badgeNone}`}>{word}</span>;
}

/** A Premier rating as CS2 draws it; none or unrated (0) as no rank is. */
export function PremierBadge({
  rating,
  small,
}: {
  rating: number | null;
  small?: boolean;
}) {
  const size = small ? s.badgeSmall : '';
  if (!rating) return small ? <NoRank /> : <NoRankBox word="Unrated" />;
  const [big, rest] = premierParts(rating);
  const tier = {
    '--tier': PREMIER_COLOURS[premierTier(rating) - 1],
  } as CSSProperties;
  return (
    <span
      className={`${s.badge} ${size}`}
      style={tier}
      title={`Premier ${rating}`}
    >
      {big}
      {rest && <small>{rest}</small>}
    </span>
  );
}

/** A Competitive rank's icon (the unranked one for 0 or none); a dash before the icons are in. */
export function RankIcon({
  rank,
  small,
}: {
  rank: number | null;
  small?: boolean;
}) {
  const assets = useSiteAssets();
  const url = assets && rankIconUrl(assets, rank);
  const cls = small ? s.iconSmall : s.icon;
  if (!url) return <span className={`${cls} ${s.iconNone}`}>{DASH}</span>;
  return <img className={cls} src={url} alt={rankName(rank)} />;
}

export default function Ranks({
  premier,
  competitive,
}: {
  premier: PremierRank | null;
  competitive: CompetitiveRank | null;
}) {
  let premierLine: ReactNode;
  if (!premier) premierLine = 'No Premier matches here';
  else if (premier.rating > 0) premierLine = 'Rated';
  else
    premierLine = (
      <>
        <span className="n">{premier.wins}</span> of{' '}
        <span className={s.labN}>10</span> wins
      </>
    );
  return (
    <div className={`g ${s.ranks}`} data-testid="ranks">
      <div className={s.rank}>
        <PremierBadge rating={premier?.rating ?? null} />
        <div>
          <div className={s.rankTitle}>Premier</div>
          <div className={s.rankSub}>{premierLine}</div>
        </div>
      </div>
      <div className={s.rank}>
        {competitive?.rank ? (
          <RankIcon rank={competitive.rank} />
        ) : (
          <NoRankBox word="Unranked" />
        )}
        <div>
          <div className={s.rankTitle}>Competitive</div>
          <div className={s.rankSub}>
            {competitive
              ? mapName(competitive.map)
              : 'No Competitive matches here'}
          </div>
        </div>
      </div>
    </div>
  );
}
