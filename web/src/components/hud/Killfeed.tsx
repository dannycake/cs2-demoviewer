// Top right: the latest kills, `attacker [weapon] badges victim`, names in team colour, the
// assister after the attacker, as many as the layout has rows for (five; three narrow, where
// it sits over the player card). Rows with the followed player are outlined. A row plays its
// kill's kill cam.

import type { ReactNode } from 'react';
import { countRender, useDerived } from '../../state/derive';
import { playbackStore, shownAt } from '../../state/store';
import { timelineFor } from '../../sim/timeline';
import {
  BlindKill,
  FlashAssist,
  Headshot,
  NoScope,
  ThroughSmoke,
  Wallbang,
} from './icons';
import {
  KILLFEED_ROWS,
  killfeedRows,
  type Badge,
  type KillRow,
  type Named,
} from './models';
import WeaponIcon from './WeaponIcon';
import styles from './hud.module.css';

const BADGE: Record<Badge, (p: { title: string }) => ReactNode> = {
  blind: (p) => <BlindKill {...p} />,
  noscope: (p) => <NoScope {...p} />,
  wallbang: (p) => <Wallbang {...p} />,
  smoke: (p) => <ThroughSmoke {...p} />,
  headshot: (p) => <Headshot {...p} />,
  flash: (p) => <FlashAssist {...p} />,
};

const BADGE_TITLE: Record<Badge, string> = {
  blind: 'Killer was blind',
  noscope: 'No scope',
  wallbang: 'Through a wall',
  smoke: 'Through smoke',
  headshot: 'Headshot',
  flash: 'Flash assist',
};

function Name({ who }: { who: Named }) {
  return (
    <span className={styles.name} data-team={who.team}>
      {who.name}
    </span>
  );
}

/** Plays the kill cam of a row's kill: a kill of the round being played. */
function killcamOf(row: KillRow): void {
  const s = playbackStore.getState();
  if (!s.pack) return;
  const kill = timelineFor(s.pack)
    .kills(s.round)
    .find((k) => k.tick === row.tick && k.victim === row.victimIndex);
  if (kill) s.killcam(kill);
}

export default function Killfeed({
  rows: count = KILLFEED_ROWS,
}: {
  rows?: number;
}) {
  countRender('Killfeed');
  // Changes when a kill comes in or ages out, or the camera shows someone else.
  const rows = useDerived(
    (s) => {
      if (!s.pack) return [];
      const follow = shownAt(s);
      const followed =
        follow !== null ? s.pack.header.players[follow]?.name : undefined;
      return killfeedRows(
        timelineFor(s.pack),
        s.round,
        s.tick,
        s.playing,
        count
      ).map((r) => ({
        ...r,
        mine:
          followed !== undefined &&
          (r.attacker?.name === followed || r.victim.name === followed),
      }));
    },
    [count]
  );
  if (rows.length === 0) return null;
  return (
    <ol className={styles.killfeed} aria-label="Kills">
      {rows.map((r) => {
        const front = r.badges.filter((b) => b === 'blind');
        const back = r.badges.filter((b) => b !== 'blind' && b !== 'flash');
        return (
          <li key={r.key}>
            <button
              type="button"
              className={styles.kill}
              data-mine={r.mine}
              title="Kill cam"
              onClick={() => killcamOf(r)}
            >
              {r.attacker && <Name who={r.attacker} />}
              {r.assister && (
                <span className={styles.assist}>
                  +{' '}
                  {r.badges.includes('flash') &&
                    BADGE.flash({ title: BADGE_TITLE.flash })}
                  <Name who={r.assister} />
                </span>
              )}
              {front.map((b) => (
                <span key={b} className={styles.badge}>
                  {BADGE[b]({ title: BADGE_TITLE[b] })}
                </span>
              ))}
              <WeaponIcon name={r.weapon} label={r.weapon} height={1.35} />
              {back.map((b) => (
                <span key={b} className={styles.badge} data-badge={b}>
                  {BADGE[b]({ title: BADGE_TITLE[b] })}
                </span>
              ))}
              <Name who={r.victim} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
