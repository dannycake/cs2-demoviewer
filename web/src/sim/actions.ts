// Actions: the one-shot clips a player's events schedule (shoot, reload, draw, pull pin and
// throw, plant, defuse, flinch, flashed, death), indexed per round so `at(round, p, tick)` is
// a pure function of the tick. Pure; built lazily from `pack.events`, `pack.grenades` and the
// track columns. Durations are from the phase 3c animation plan.

import {
  FLAG,
  type Grenade,
  type MatchHeader,
  type Pack,
  type PackEvent,
  type PlayerTrack,
  type RoundInfo,
} from '../pack/types';
import { DEATH_TOTAL_S } from './anim';
import { newPlayerState, playerStateAt, sampleIndex } from './sample';
import { familyOf, normaliseWeapon, weaponClip } from './weapons';

export type ActionKind =
  | 'shoot'
  | 'reload'
  | 'draw'
  | 'pullpin'
  | 'throw'
  | 'plant'
  | 'defuse'
  | 'flinch'
  | 'flashed'
  | 'death';

export interface ActionData {
  /** Degrees from the victim's yaw to the attacker, right positive. */
  bearing?: number;
  hitgroup?: string;
  headshot?: boolean;
  attacker?: number;
  weapon?: string;
}

export interface Action {
  kind: ActionKind;
  clip: string;
  startTick: number;
  durationTicks: number;
  /** Played as an additive layer over the locomotion. */
  additive: boolean;
  /** Masked to the spine, arms and hands; the legs keep walking. */
  upperBody: boolean;
  data?: ActionData;
}

/** Seconds a shot animation plays, by weapon or family. */
export const SHOOT_S: Readonly<Record<string, number>> = {
  rifle: 0.2,
  pistol: 0.25,
  knife: 0.6,
  awp: 0.8,
  ssg08: 0.8,
  scar20: 0.5,
  g3sg1: 0.5,
  revolver: 0.5,
};
/** Seconds a reload plays, by weapon or family (the known clip lengths). */
export const RELOAD_S: Readonly<Record<string, number>> = {
  rifle: 2.4,
  pistol: 2.2,
  awp: 3.7,
  m249: 5.5,
  negev: 5.7,
  nova: 2.5,
  xm1014: 2.5,
  sawedoff: 2.5,
  mag7: 2.5,
  glock: 2.3,
};
export const DRAW_S = 0.6;
export const PULLPIN_S = 0.5;
export const THROW_S = 0.45;
/** Launch speed (units/s) below which a throw is underhand. */
export const UNDERHAND_SPEED = 250;
export const PLANT_MAX_S = 4;
/** A planter who moves faster than this has stopped planting. */
export const PLANT_MOVE_SPEED = 20;
export const FLINCH_S = 0.3;
/** As long as the body lies: the fall, the hold and the fade (`DEATH_TOTAL_S`). */
export const DEATH_S = DEATH_TOTAL_S;
/** The longest action, so `at` knows how far back to look. */
const MAX_S = DEATH_S;

const HITGROUP_FLINCH: Readonly<Record<string, string>> = {
  head: 'head',
  neck: 'chest',
  chest: 'chest',
  stomach: 'stomach',
  generic: 'stomach',
  left_arm: 'arm_left',
  right_arm: 'arm_right',
  left_leg: 'leg_left',
  right_leg: 'leg_right',
};
/** Flinches with `_rear`, `_left` and `_right` variants. */
const SIDED = new Set(['head', 'chest']);
const REAR = new Set(['head', 'chest', 'stomach']);
const BURNS = new Set(['hegrenade', 'inferno', 'molotov', 'incendiary']);

function wrapDeg(d: number): number {
  const w = d - 360 * Math.floor((d + 180) / 360);
  return w === -180 ? 180 : w;
}

/** The flinch clip for a hit group, the weapon and where the attacker was. */
export function flinchClip(
  hitgroup: string | undefined,
  weapon: string,
  bearing: number | undefined
): string {
  if (BURNS.has(weapon)) return 'flinch_molotov';
  const part = HITGROUP_FLINCH[hitgroup ?? 'generic'] ?? 'stomach';
  if (bearing !== undefined) {
    const abs = Math.abs(bearing);
    if (abs > 135 && REAR.has(part)) return `flinch_${part}_rear`;
    if (abs >= 45 && SIDED.has(part))
      return `flinch_${part}_${bearing > 0 ? 'right' : 'left'}`;
  }
  return `flinch_${part}`;
}

export class ActionIndex {
  readonly pack: Pack;
  private rounds = new Map<number, Action[][]>();
  private a = newPlayerState();
  private b = newPlayerState();

  constructor(pack: Pack) {
    this.pack = pack;
  }

  /** Actions of player `p` active at `tick` in `round`, newest first. */
  at(round: number, p: number, tick: number, out: Action[] = []): Action[] {
    out.length = 0;
    const list = this.build(round)[p];
    if (!list) return out;
    const oldest = tick - MAX_S * this.pack.header.tick_rate;
    // Sorted by startTick: walk back from the last one that has started.
    let i = list.length - 1;
    while (i >= 0 && list[i].startTick > tick) i--;
    for (; i >= 0 && list[i].startTick >= oldest; i--) {
      const act = list[i];
      if (tick < act.startTick + act.durationTicks) out.push(act);
    }
    return out;
  }

  /**
   * Actions of player `p` that started in the `seconds` up to `tick` (later than
   * `tick − seconds`, not after `tick`) in `round`, finished or not, newest first: the first
   * person view plays its own clips, longer than the actions' durations, and needs to know
   * what came before the newest.
   */
  recent(
    round: number,
    p: number,
    tick: number,
    seconds: number,
    out: Action[] = []
  ): Action[] {
    out.length = 0;
    const list = this.build(round)[p];
    if (!list) return out;
    const oldest = tick - seconds * this.pack.header.tick_rate;
    let i = list.length - 1;
    while (i >= 0 && list[i].startTick > tick) i--;
    for (; i >= 0 && list[i].startTick > oldest; i--) out.push(list[i]);
    return out;
  }

  /** The whole round's actions per player, sorted by start tick (built once). */
  build(round: number): Action[][] {
    const cached = this.rounds.get(round);
    if (cached) return cached;
    const { header, events, grenades } = this.pack;
    const info = header.rounds[round];
    const tracks = this.pack.rounds[round]?.players ?? [];
    const per: Action[][] = header.players.map(() => []);
    if (info) {
      const inRound = events.filter(
        (e) => e.tick >= info.start_tick && e.tick <= info.post_end_tick
      );
      const deathTick = new Map<number, number>();
      for (const e of inRound) {
        if (e.kind !== 'player_death') continue;
        const who = idx(e.data.user_idx);
        if (who !== null && per[who] && !deathTick.has(who))
          deathTick.set(who, e.tick);
      }
      for (const e of inRound)
        this.fromEvent(e, info, tracks, per, deathTick, header);
      for (const g of grenades) this.fromGrenade(g, info, per, header);
      for (let p = 0; p < per.length; p++) {
        const track = tracks[p];
        if (track) this.defuses(track, info, per[p], header);
        per[p].sort((x, y) => x.startTick - y.startTick);
      }
    }
    this.rounds.set(round, per);
    return per;
  }

  private fromEvent(
    e: PackEvent,
    info: RoundInfo,
    tracks: PlayerTrack[],
    per: Action[][],
    deathTick: Map<number, number>,
    header: MatchHeader
  ): void {
    const d = e.data;
    const who = idx(d.user_idx);
    if (who === null || !per[who]) return;
    const died = deathTick.get(who);
    const ticks = (s: number) => Math.max(1, Math.round(s * header.tick_rate));
    const dead =
      died !== undefined && e.tick >= died && e.kind !== 'player_death';
    switch (e.kind) {
      case 'weapon_fire': {
        if (dead) return;
        const w = normaliseWeapon(String(d.weapon ?? ''));
        if (familyOf(w) === 'grenade') return; // the grenade's own track schedules the throw
        const clip = weaponClip('shoot', w);
        if (!clip) return;
        const secs = SHOOT_S[w] ?? SHOOT_S[familyOf(w)] ?? 0.2;
        per[who].push({
          kind: 'shoot',
          clip,
          startTick: e.tick,
          durationTicks: ticks(secs),
          additive: false,
          upperBody: true,
          data: { weapon: w },
        });
        return;
      }
      case 'weapon_reload': {
        if (dead) return;
        const w = this.weaponAt(tracks[who], info, e.tick, header);
        const clip = weaponClip('reload', w);
        if (!clip) return;
        const secs = RELOAD_S[w] ?? RELOAD_S[familyOf(w)] ?? 2.4;
        per[who].push({
          kind: 'reload',
          clip,
          startTick: e.tick,
          durationTicks: ticks(secs),
          additive: false,
          upperBody: true,
          data: { weapon: w },
        });
        return;
      }
      case 'item_equip': {
        if (dead) return;
        // The item name is ambiguous for silenced weapons: read what the track holds a sample
        // later, when the switch shows, and fall back to the item only without a track.
        const track = tracks[who];
        const w = track
          ? this.weaponAt(
              track,
              info,
              Math.min(info.post_end_tick, e.tick + header.tick_step),
              header
            )
          : normaliseWeapon(String(d.item ?? ''));
        const clip = weaponClip('draw', w);
        if (!clip) return;
        per[who].push({
          kind: 'draw',
          clip,
          startTick: e.tick,
          durationTicks: ticks(DRAW_S),
          additive: false,
          upperBody: true,
          data: { weapon: w },
        });
        return;
      }
      case 'bomb_beginplant': {
        if (dead) return;
        const track = tracks[who];
        const end = this.plantEnd(track, info, who, e.tick, header);
        const crouched = track
          ? this.stateAt(track, info, e.tick, header).duck >= 128
          : false;
        per[who].push({
          kind: 'plant',
          clip: crouched ? 'planting_crouch' : 'planting',
          startTick: e.tick,
          durationTicks: Math.max(1, end - e.tick),
          additive: false,
          upperBody: false,
        });
        return;
      }
      case 'player_hurt': {
        if (dead) return;
        const w = normaliseWeapon(String(d.weapon ?? ''));
        const attacker = idx(d.attacker_idx);
        const bearing = this.bearing(
          tracks,
          info,
          who,
          attacker,
          e.tick,
          header
        );
        const hitgroup =
          typeof d.hitgroup === 'string' ? d.hitgroup : undefined;
        per[who].push({
          kind: 'flinch',
          clip: flinchClip(hitgroup, w, bearing),
          startTick: e.tick,
          durationTicks: ticks(FLINCH_S),
          additive: true,
          upperBody: false,
          data: {
            bearing,
            hitgroup,
            attacker: attacker ?? undefined,
            weapon: w,
          },
        });
        return;
      }
      case 'player_blind': {
        if (dead) return;
        const secs =
          typeof d.blind_duration === 'number' ? d.blind_duration : 0;
        if (secs <= 0) return;
        const track = tracks[who];
        const crouched = track
          ? this.stateAt(track, info, e.tick, header).duck >= 128
          : false;
        per[who].push({
          kind: 'flashed',
          clip: crouched ? 'flashed_crouch' : 'flashed',
          startTick: e.tick,
          durationTicks: ticks(secs),
          additive: false,
          upperBody: false,
        });
        return;
      }
      case 'player_death': {
        if (died !== undefined && e.tick !== died) return; // a second death event in the round (a respawn's) is rare; the first wins the index
        const w = normaliseWeapon(String(d.weapon ?? ''));
        const attacker = idx(d.attacker_idx);
        const bearing = this.bearing(
          tracks,
          info,
          who,
          attacker,
          e.tick,
          header
        );
        const hitgroup =
          typeof d.hitgroup === 'string' ? d.hitgroup : undefined;
        per[who].push({
          kind: 'death',
          clip: flinchClip(hitgroup, w, bearing),
          startTick: e.tick,
          durationTicks: ticks(DEATH_S),
          additive: false,
          upperBody: false,
          data: {
            bearing,
            hitgroup,
            headshot: d.headshot === true,
            attacker: attacker ?? undefined,
            weapon: w,
          },
        });
        return;
      }
      default:
        return;
    }
  }

  private fromGrenade(
    g: Grenade,
    info: RoundInfo,
    per: Action[][],
    header: MatchHeader
  ): void {
    if (g.start_tick < info.start_tick || g.start_tick > info.end_tick) return;
    const who = g.thrower;
    if (!per[who]) return;
    const fire = g.kind === 'molotov' || g.kind === 'incendiary';
    const pin = Math.round(PULLPIN_S * header.tick_rate);
    per[who].push({
      kind: 'pullpin',
      clip: fire ? 'pullpin_molotov' : 'pullpin_grenade',
      startTick: g.start_tick - pin,
      durationTicks: pin,
      additive: false,
      upperBody: true,
    });
    let underhand = false;
    if (g.samples >= 2) {
      const d = Math.hypot(g.x[1] - g.x[0], g.y[1] - g.y[0], g.z[1] - g.z[0]);
      underhand = d * header.sample_hz < UNDERHAND_SPEED;
    }
    per[who].push({
      kind: 'throw',
      clip: underhand ? 'throw_underhand_grenade' : 'throw_overhand_grenade',
      startTick: g.start_tick,
      durationTicks: Math.max(1, Math.round(THROW_S * header.tick_rate)),
      additive: false,
      upperBody: true,
    });
  }

  /** Runs of the defusing flag in the track become defuse actions. */
  private defuses(
    track: PlayerTrack,
    info: RoundInfo,
    list: Action[],
    header: MatchHeader
  ): void {
    let start = -1;
    for (let k = 0; k <= info.samples; k++) {
      const on =
        k < info.samples &&
        (track.flags[k] & FLAG.defusing) !== 0 &&
        (track.flags[k] & FLAG.alive) !== 0;
      if (on && start < 0) start = k;
      if (!on && start >= 0) {
        const startTick = info.start_tick + start * header.tick_step;
        const crouched = track.duck[start] >= 128;
        list.push({
          kind: 'defuse',
          clip: crouched ? 'defuse_crouch_loop_rifle' : 'defuse_loop_rifle',
          startTick,
          durationTicks: (k - start) * header.tick_step,
          additive: false,
          upperBody: false,
        });
        start = -1;
      }
    }
  }

  private plantEnd(
    track: PlayerTrack | undefined,
    info: RoundInfo,
    who: number,
    begin: number,
    header: MatchHeader
  ): number {
    const cap = Math.min(
      info.end_tick,
      begin + Math.round(PLANT_MAX_S * header.tick_rate)
    );
    for (const e of this.pack.events) {
      if (e.kind !== 'bomb_planted' || e.tick < begin || e.tick > cap) continue;
      if (idx(e.data.user_idx) === who) return e.tick;
    }
    if (!track) return cap;
    const { k } = sampleIndex(info, begin, header.tick_step);
    for (let j = k + 1; j < info.samples; j++) {
      const tick = info.start_tick + j * header.tick_step;
      if (tick > cap) break;
      const s = this.stateAt(track, info, tick, header);
      if (!s.present || s.speed > PLANT_MOVE_SPEED) return tick;
    }
    return cap;
  }

  private weaponAt(
    track: PlayerTrack | undefined,
    info: RoundInfo,
    tick: number,
    header: MatchHeader
  ): string {
    if (!track) return 'none';
    const s = this.stateAt(track, info, tick, header);
    return normaliseWeapon(header.weapons[s.weapon] ?? 'none');
  }

  private stateAt(
    track: PlayerTrack,
    info: RoundInfo,
    tick: number,
    header: MatchHeader
  ) {
    return playerStateAt(track, info, tick, header, this.a);
  }

  /** Degrees from the victim's yaw to the attacker (right positive), or undefined. */
  private bearing(
    tracks: PlayerTrack[],
    info: RoundInfo,
    victim: number,
    attacker: number | null,
    tick: number,
    header: MatchHeader
  ): number | undefined {
    if (attacker === null || attacker === victim) return undefined;
    const tv = tracks[victim];
    const ta = tracks[attacker];
    if (!tv || !ta) return undefined;
    const v = playerStateAt(tv, info, tick, header, this.a);
    const at = playerStateAt(ta, info, tick, header, this.b);
    if (!v.present || !at.present) return undefined;
    const to = (Math.atan2(at.y - v.y, at.x - v.x) * 180) / Math.PI;
    // Source yaw is counterclockwise from +x seen from above; right of the view is negative.
    return -wrapDeg(to - v.yaw);
  }
}

function idx(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}
