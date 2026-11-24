// Held Tab with no control focused, or Tab held down on one (a press on one moves the focus on, as
// Tab does; or a click on the player card): both teams, CT first, with the stat columns in
// `SCORE_COLUMNS` order (kills, assists, deaths, the difference, ADR, KAST, headshot share,
// utility damage, flash assists, rating), money and equipment, for the match up to now. Each
// player's name links to their profile on the site, followed in this tab as the site's own
// links are (a ctrl or middle click opens a new one); a bot's is no link. Compact (the narrow
// layout), the columns are kills, deaths, ADR and rating, without money and equipment. Opened
// by a click on the player card, a press anywhere but on it or the card closes it (on a phone,
// the one way to close it besides the card).

import { useEffect, useRef } from 'react';
import { countRender, useDerived } from '../../state/derive';
import { escapeCloses, useDismiss } from '../../state/dismiss';
import { shownAt } from '../../state/store';
import { statsThrough } from '../../sim/stats';
import { timelineFor } from '../../sim/timeline';
import { isTextEntry } from '../../state/focus';
import {
  scoreCell,
  scoreColumns,
  scoreboardRows,
  type ScoreColumn,
} from './models';
import { scoreboardKey, useScoreboard } from './scoreboard-state';
import SiteLink from '../../site/SiteLink';
import WeaponIcon from './WeaponIcon';
import styles from './hud.module.css';

const TEAM_NAME: Record<number, string> = {
  2: 'Terrorists',
  3: 'Counter-Terrorists',
};

/** Each stat column's header tooltip. */
const TITLE: Record<ScoreColumn, string> = {
  K: 'Kills',
  A: 'Assists',
  D: 'Deaths',
  '+/−': 'Kills minus deaths',
  ADR: 'Average damage per round',
  KAST: 'Rounds with a kill, assist, survival or trade',
  'HS%': 'Kills that were headshots',
  UD: 'Utility damage',
  FA: 'Flash assists',
  Rating: 'Rating, as on profiles (1.00 is the average)',
};

function closeScoreboard(): void {
  useScoreboard.getState().close();
}

function onScoreboardToggle(t: Element): boolean {
  return t.closest('[data-scoreboard-toggle]') !== null;
}

export default function Scoreboard({
  columns = 'all',
}: {
  columns?: 'all' | 'compact';
}) {
  countRender('Scoreboard');
  const held = useScoreboard((s) => s.held);
  const pinned = useScoreboard((s) => s.pinned);
  const open = held || pinned;
  const root = useRef<HTMLDivElement>(null);
  const cols = scoreColumns(columns);
  const all = columns === 'all';
  // Closed, nothing. Open, both teams as at the end of the current second (so it changes at
  // most once a second), and who the camera shows.
  const board = useDerived(
    (s) => {
      if (!open || !s.pack) return null;
      const rate = s.pack.header.tick_rate;
      const t = (Math.floor(s.tick / rate) + 1) * rate;
      return {
        teams: scoreboardRows(
          statsThrough(s.pack, s.round, t),
          s.pack,
          timelineFor(s.pack),
          s.round,
          t
        ),
        follow: shownAt(s),
      };
    },
    [open]
  );

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      const focused = document.activeElement;
      const onPage =
        !focused ||
        focused === document.body ||
        focused === document.documentElement ||
        focused instanceof HTMLCanvasElement;
      const k = scoreboardKey(e, onPage);
      if (!k) return;
      const s = useScoreboard.getState();
      if (k === 'hold') {
        e.preventDefault();
        s.setHeld(true);
      } else if (k === 'release') s.setHeld(false);
      else if (escapeCloses(e, s.held || s.pinned)) {
        // Spent here: the key map does not also close the highlights or leave a reel.
        e.preventDefault();
        s.close();
      }
    };
    const blur = () => useScoreboard.getState().setHeld(false);
    // Capture: before the key map (DemoView), so it sees whether the scoreboard took Escape.
    window.addEventListener('keydown', on, true);
    window.addEventListener('keyup', on, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', on, true);
      window.removeEventListener('keyup', on, true);
      window.removeEventListener('blur', blur);
      // Leaving the viewer (a name followed to its profile) closes it: it is not open on the
      // way back, nor held by a Tab let go of on another page.
      useScoreboard.getState().close();
    };
  }, []);

  // Opened by a click, a press outside it closes it; the player card toggles it itself. Its
  // Escape is read with Tab above.
  useDismiss(pinned, root, closeScoreboard, {
    escape: false,
    ignore: onScoreboardToggle,
  });

  if (!board) return null;
  const { teams, follow } = board;

  return (
    <div
      ref={root}
      className={styles.scoreboard}
      data-columns={columns}
      role="dialog"
      aria-label="Scoreboard"
    >
      {teams.map((team) => (
        <table key={team.team} className={styles.table} data-team={team.team}>
          <caption>
            <span className={styles.caption}>
              <span className={styles.teamScore}>{team.score}</span>
              {TEAM_NAME[team.team]}
            </span>
          </caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              {cols.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className={styles.stat}
                  data-col={c}
                  title={TITLE[c]}
                >
                  {c}
                </th>
              ))}
              {all && (
                <>
                  <th scope="col" className={styles.moneyHead}>
                    Money
                  </th>
                  <th scope="col" className={styles.kitHead}>
                    Equipment
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {team.rows.map((r) => (
              <tr key={r.index} data-followed={r.index === follow}>
                <th scope="row">
                  {r.profile ? (
                    <SiteLink
                      className={styles.profile}
                      href={r.profile}
                      title="Player profile"
                    >
                      {r.name}
                    </SiteLink>
                  ) : (
                    r.name
                  )}
                </th>
                {cols.map((c) => (
                  <td
                    key={c}
                    data-sign={c === '+/−' ? Math.sign(r.diff) : undefined}
                  >
                    {scoreCell(r, c)}
                  </td>
                ))}
                {all && (
                  <>
                    <td className={styles.cash}>
                      {r.money !== null
                        ? `$${r.money.toLocaleString('en-US')}`
                        : ''}
                    </td>
                    <td className={styles.kit}>
                      <span className={styles.kitIcons}>
                        {r.gun && (
                          <WeaponIcon name={r.gun} label={r.gun} height={1.1} />
                        )}
                        {r.grenades.map((g, i) => (
                          <WeaponIcon
                            key={`${g}${i}`}
                            name={g}
                            label={g}
                            height={1}
                          />
                        ))}
                      </span>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
