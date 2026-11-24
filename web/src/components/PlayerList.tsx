// The players at the current sample, CT then T: name, team colour, kills this match, health,
// armour, the weapon's silhouette and dead / flashed / bomb / defusing badges. A click follows
// the player. As a column (the wide layout), in Free it stands back until hovered, and under
// 900 px it collapses behind a toggle. As a sheet (the narrow layout), it is a "Players"
// button that opens the list from the bottom of the screen, with larger rows for a finger;
// picking a row follows that player and closes it, as do the close button, the button again,
// Escape and a press outside it.

import { useRef, useState } from 'react';
import { sampleIndex } from '../sim/sample';
import { statsThrough } from '../sim/stats';
import { countRender, useDerived } from '../state/derive';
import { useDismiss } from '../state/dismiss';
import { playbackStore, shownAt, type Playback } from '../state/store';
import Digits from './hud/Digits';
import WeaponIcon from './hud/WeaponIcon';
import { playerRows, sortRows, type PlayerRow } from './player-rows';
import styles from './PlayerList.module.css';

const TEAM_NAME: Record<number, string> = {
  3: 'Counter-Terrorists',
  2: 'Terrorists',
  0: 'Not playing',
};

function ShieldIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M8 1.5 2.5 3.5v4c0 3.2 2.3 5.8 5.5 7 3.2-1.2 5.5-3.8 5.5-7v-4z"
        fill="currentColor"
      />
    </svg>
  );
}

function Row({
  row,
  followed,
  kills,
  onPick,
}: {
  row: PlayerRow;
  followed: boolean;
  kills: number;
  /** After the row's player is followed. */
  onPick?: () => void;
}) {
  const dead = row.inRound && !row.alive;
  return (
    <li>
      <button
        type="button"
        className={styles.row}
        data-testid="player-row"
        data-team={row.team}
        data-dead={dead}
        data-out={!row.inRound}
        aria-pressed={followed}
        title={
          row.key ? `Follow ${row.name} (${row.key})` : `Follow ${row.name}`
        }
        onClick={() => {
          playbackStore.getState().setFollow(row.index);
          onPick?.();
        }}
      >
        <span className={styles.key}>{row.key}</span>
        <span className={styles.main}>
          <span className={styles.top}>
            <span className={styles.name}>{row.name}</span>
            {kills > 0 && (
              <span className={styles.kills} title={`${kills} kills`}>
                {kills}
              </span>
            )}
            <span className={styles.badges}>
              {dead && <span className={styles.badge}>Dead</span>}
              {row.bomb && (
                <span className={styles.badge} data-kind="bomb" title="Bomb">
                  C4
                </span>
              )}
              {row.defusing && (
                <span className={styles.badge} data-kind="defuse">
                  Defusing
                </span>
              )}
              {row.flashed && (
                <span className={styles.badge} data-kind="flash">
                  Flashed
                </span>
              )}
            </span>
          </span>
          <span className={styles.bottom}>
            <span
              className={styles.hp}
              role="meter"
              aria-label="Health"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={row.health}
            >
              <span
                className={styles.hpFill}
                style={{ width: `${Math.min(100, row.health)}%` }}
              />
              <span className={styles.hpText}>
                {row.alive ? row.health : ''}
              </span>
            </span>
            <span
              className={styles.armor}
              data-on={row.armor > 0}
              title={row.armor > 0 ? `Armor ${row.armor}` : 'No armor'}
            >
              <ShieldIcon />
            </span>
            <span className={styles.weapon}>
              {row.icon ? (
                <WeaponIcon name={row.icon} label={row.weapon} height={1.2} />
              ) : (
                row.weapon
              )}
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

interface ListModel {
  /** Players in the pack. */
  count: number;
  free: boolean;
  groups: {
    team: number;
    rows: { row: PlayerRow; followed: boolean; kills: number }[];
  }[];
}

function listModel(s: Playback): ListModel {
  const { pack } = s;
  const info = pack?.header.rounds[s.round];
  const out: ListModel = {
    count: pack?.header.players.length ?? 0,
    free: s.camera === 'free',
    groups: [],
  };
  if (!pack || !info) return out;
  // Who the camera shows: after a death and its hold, the killer the camera cut to.
  const follow = shownAt(s);
  // The match's kills, as counted at the end of the current second.
  const rate = pack.header.tick_rate;
  const kills = statsThrough(
    pack,
    s.round,
    (Math.floor(s.tick / rate) + 1) * rate
  ).map((x) => x.kills);
  // The rows at the sample, which the `u8` columns hold until the next one.
  const step = pack.header.tick_step;
  const k = sampleIndex(info, s.tick, step).k;
  for (const row of sortRows(
    playerRows(pack, s.round, info.start_tick + k * step)
  )) {
    const team = row.inRound ? row.team : 0;
    if (out.groups.at(-1)?.team !== team) out.groups.push({ team, rows: [] });
    out.groups.at(-1)!.rows.push({
      row,
      followed: row.index === follow,
      kills: kills[row.index] ?? 0,
    });
  }
  return out;
}

export default function PlayerList({
  mode = 'column',
}: {
  mode?: 'column' | 'sheet';
}) {
  countRender('PlayerList');
  // Changes when a row does (a sample changes someone's health, weapon or state), not with
  // the frame.
  const { count, free, groups } = useDerived(listModel, []);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const sheet = mode === 'sheet';
  const shown = sheet && open;

  // The open sheet closes on Escape or a press outside it (the toggle is inside).
  useDismiss(shown, root, () => setOpen(false));

  const close = sheet ? () => setOpen(false) : undefined;
  return (
    <aside
      ref={root}
      className={styles.list}
      data-mode={mode}
      data-open={open}
      data-free={free}
      aria-label="Players"
    >
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Digits text={`Players${count ? ` (${count})` : ''}`} />
      </button>
      <div className={styles.body}>
        {sheet && (
          <div className={styles.sheetHead}>
            <span>Follow a player</span>
            <button
              type="button"
              className={styles.close}
              aria-label="Close the player list"
              onClick={() => setOpen(false)}
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                aria-hidden="true"
              >
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.team} className={styles.group} data-team={g.team}>
            <h2 className={styles.heading}>{TEAM_NAME[g.team] ?? ''}</h2>
            <ol className={styles.rows}>
              {g.rows.map(({ row, followed, kills }) => (
                <Row
                  key={row.index}
                  row={row}
                  followed={followed}
                  kills={kills}
                  onPick={close}
                />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </aside>
  );
}
