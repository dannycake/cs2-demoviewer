// What the player list shows for each player at a tick, read straight from the round's
// tracks at the sample at or before the tick (the `u8` columns do not interpolate).

import { FLAG, type Pack } from '../pack/types';
import { sampleIndex } from '../sim/sample';
import { weaponIcon } from './hud/models';

export interface PlayerRow {
  /** Index into `header.players`. */
  index: number;
  name: string;
  /** The key that follows this player (`1`..`9`, `0`), or '' past the tenth. */
  key: string;
  /** 2 = T, 3 = CT, 0 = not in this round. */
  team: number;
  inRound: boolean;
  alive: boolean;
  health: number;
  armor: number;
  /** Display name of the held weapon; '' when dead or empty-handed. */
  weapon: string;
  /** The held weapon's silhouette (`hud/weapon-sprite.ts`); '' when none. */
  icon: string;
  flashed: boolean;
  bomb: boolean;
  defusing: boolean;
}

export function followKey(index: number): string {
  if (index < 0 || index > 9) return '';
  return index === 9 ? '0' : String(index + 1);
}

/** The pack's weapon names are already display names, except the knives. */
export function weaponLabel(name: string | undefined): string {
  if (!name || name === 'none') return '';
  if (name === 'knife' || name.startsWith('knife_')) return 'Knife';
  return name;
}

/** One row per `header.players` entry, in header order, at `tick` of round index `round`. */
export function playerRows(
  pack: Pack,
  round: number,
  tick: number
): PlayerRow[] {
  const { header } = pack;
  const info = header.rounds[round];
  const tracks = pack.rounds[round]?.players;
  const k =
    info && info.samples > 0 ? sampleIndex(info, tick, header.tick_step).k : -1;
  return header.players.map((p, i) => {
    const team = info ? (p.team_by_round[round] ?? 0) : 0;
    const row: PlayerRow = {
      index: i,
      name: p.name,
      key: followKey(i),
      team,
      inRound: team === 2 || team === 3,
      alive: false,
      health: 0,
      armor: 0,
      weapon: '',
      icon: '',
      flashed: false,
      bomb: false,
      defusing: false,
    };
    const t = tracks?.[i];
    if (!t || k < 0) return row;
    const flags = t.flags[k];
    if (!(flags & FLAG.alive)) return row;
    row.alive = true;
    row.health = t.health[k];
    row.armor = t.armor[k];
    row.weapon = weaponLabel(header.weapons[t.weapon[k]]);
    row.icon = weaponIcon(header.weapons[t.weapon[k]] ?? '', team);
    row.flashed = (flags & FLAG.flashed) !== 0;
    row.bomb = (flags & FLAG.bomb) !== 0;
    row.defusing = (flags & FLAG.defusing) !== 0;
    return row;
  });
}

const TEAM_ORDER: Record<number, number> = { 3: 0, 2: 1 };

/** CT first, then T, then players not in the round; header order within each. */
export function sortRows(rows: readonly PlayerRow[]): PlayerRow[] {
  return [...rows].sort(
    (a, b) =>
      (TEAM_ORDER[a.team] ?? 2) - (TEAM_ORDER[b.team] ?? 2) || a.index - b.index
  );
}
