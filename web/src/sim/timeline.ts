// The round's story as data: utility effects and their lifetimes, grenades in flight, shots,
// hits, blinds, kills, the bomb's state, the round timer and the round feed. Every query is a
// pure function of (round, tick), built once per round from `pack.events`, `pack.grenades` and
// the track columns, so the scene and the HUD look the same whether a tick was reached by
// playing or by seeking. Timings are from the phase 3c design ("Utility", "Playback HUD").

import {
  FLAG,
  type Grenade,
  type Pack,
  type PackEvent,
  type RoundInfo,
} from '../pack/types';
import { newPlayerState, playerStateAt } from './sample';
import { isSuppressed, normaliseWeapon } from './weapons';

export type EffectKind = 'smoke' | 'fire' | 'flash' | 'he' | 'decoy';

export interface Effect {
  kind: EffectKind;
  /** Source units. */
  x: number;
  y: number;
  z: number;
  startTick: number;
  /** Exclusive. */
  endTick: number;
  thrower: number | null;
  entityId: number;
}

export type GrenadeLabel = 'SMOKE' | 'FLASH' | 'HE' | 'MOLLY' | 'INC' | 'DECOY';

export interface Projectile {
  grenade: Grenade;
  label: GrenadeLabel;
  /** Exclusive: the detonation, or the end of the track. */
  endTick: number;
}

export interface Shot {
  tick: number;
  player: number;
  /** Normalised (`weapons.ts`). */
  weapon: string;
  suppressed: boolean;
  /**
   * Where the shot left from, the shooter's eye at the moment of firing, Source units
   * (`fire_bullets` origin); null when the demo did not log the shot.
   */
  from: { x: number; y: number; z: number } | null;
  /** The shot's aim, degrees (`fire_bullets` angles): the recoil is already in it. */
  aim: { pitch: number; yaw: number } | null;
  /**
   * For a shot that hit a player (`bullet_damage`): the bullet's own direction, its spread
   * included (a Source unit vector), how far it flew to the player, units, and how many walls
   * it went through on the way (`num_penetrations`, 0 when not logged).
   */
  hit: {
    dir: [number, number, number];
    distance: number;
    penetrations: number;
  } | null;
}

export interface Hit {
  tick: number;
  victim: number;
  /** Null for the world (fall damage) or an unknown attacker. */
  attacker: number | null;
  damage: number;
  hitgroup: string;
  headshot: boolean;
  weapon: string;
  /** The killing hit: it left the victim no health. */
  fatal: boolean;
}

export interface Kill {
  tick: number;
  attacker: number | null;
  victim: number;
  assister: number | null;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  smoke: boolean;
  noscope: boolean;
  blind: boolean;
  flashAssist: boolean;
}

export type BombState =
  | { kind: 'none' }
  | { kind: 'carried'; by: number }
  | { kind: 'dropped'; x: number; y: number; z: number; tick: number }
  | {
      kind: 'planted';
      x: number;
      y: number;
      z: number;
      tick: number;
      site: number;
      by: number | null;
    }
  | { kind: 'exploded'; tick: number; x: number; y: number; z: number }
  | { kind: 'defused'; tick: number; by: number | null };

export interface Blind {
  player: number;
  startTick: number;
  endTick: number;
  attacker: number | null;
}

export type FeedKind =
  'throw' | 'plant' | 'defuse' | 'defused' | 'exploded' | 'kill';

export interface FeedItem {
  tick: number;
  kind: FeedKind;
  text: string;
  /** The actor's team that round (2 T, 3 CT), or null. */
  team: number | null;
}

export type RoundPhase = 'freeze' | 'live' | 'planted' | 'over';

/** Competitive round time from the end of the freeze, seconds. */
export const ROUND_S = 115;
/** The bomb's fuse, seconds. */
export const BOMB_S = 40;
/**
 * The planted bomb's light, as the scene and the radar draw it and the beeps follow it: blinks
 * per second at the plant and at the end of the fuse, and the part of each blink it is lit.
 */
export const BOMB_BLINK = { from: 1, to: 8, on: 0.18 };
/** Effect lifetimes when no matching end event exists, seconds. */
export const SMOKE_S = 18;
export const FIRE_S = 7;
export const DECOY_S = 15;
/** A smoke's and a fire's radius, metres, as the scene draws them and the radar rings them. */
export const SMOKE_RADIUS = 3.66;
export const FIRE_RADIUS = 3.4;
/** Flash: the burst grows over 80 ms and fades over 250 ms. */
export const FLASH_S = 0.33;
/** HE: the blast, its fireball and the dust ring fading after it, as the radar draws it. */
export const HE_BLAST_S = 0.6;
/**
 * HE: as long as anything of it is drawn in the scene: CS2's fireball (0.8 s) and the smoke
 * rising and fading after it (2.5 s), `HE.explosionS` and `HE.smokeS` in `scene/utility.ts`.
 */
export const HE_S = 3.3;

/** Whether the planted bomb's light is on `seconds` after the plant. */
export function blinkOn(seconds: number): boolean {
  if (seconds < 0) return false;
  // The rate climbs linearly from `from` to `to` over the fuse: the phase is its integral.
  const phase =
    BOMB_BLINK.from * seconds +
    ((BOMB_BLINK.to - BOMB_BLINK.from) * seconds * seconds) / (2 * BOMB_S);
  return phase - Math.floor(phase) < BOMB_BLINK.on;
}

export const GRENADE_LABEL: Readonly<Record<Grenade['kind'], GrenadeLabel>> = {
  smoke: 'SMOKE',
  flash: 'FLASH',
  he: 'HE',
  molotov: 'MOLLY',
  incendiary: 'INC',
  decoy: 'DECOY',
};

interface RoundData {
  info: RoundInfo;
  effects: Effect[];
  projectiles: Projectile[];
  shots: Shot[];
  hits: Hit[];
  blinds: Blind[];
  kills: Kill[];
  /** Bomb events in tick order. */
  bomb: PackEvent[];
  /** The bomb's state after each of `bomb`, made the first time it is asked (`bombByEvents`). */
  bombStates?: BombState[];
  roundEnd: number | null;
  feed: FeedItem[];
}

function idx(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The events that end an effect, for `endOf`. */
const END_KINDS: ReadonlySet<string> = new Set([
  'smokegrenade_expired',
  'inferno_expire',
  'decoy_detonate',
]);

/** Index of the first element with `key(e) > tick` in an array sorted by key. */
function upperBound<T>(
  list: readonly T[],
  tick: number,
  key: (e: T) => number
): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const timelines = new WeakMap<Pack, Timeline>();
const NO_SHOTS: readonly Shot[] = Object.freeze([]);
const NO_HITS: readonly Hit[] = Object.freeze([]);
const NO_EFFECTS: readonly Effect[] = Object.freeze([]);
const NO_BOMB: BombState = Object.freeze({ kind: 'none' });

/** The timeline of `pack`, made once per pack and shared by the scene and the HUD. */
export function timelineFor(pack: Pack): Timeline {
  let t = timelines.get(pack);
  if (!t) {
    t = new Timeline(pack);
    timelines.set(pack, t);
  }
  return t;
}

export class Timeline {
  readonly pack: Pack;
  private rounds = new Map<number, RoundData>();
  private s = newPlayerState();

  constructor(pack: Pack) {
    this.pack = pack;
  }

  /** The round's kills in tick order. */
  kills(round: number): Kill[] {
    return this.data(round)?.kills ?? [];
  }

  /** Effects alive at `tick` (start ≤ tick < end). */
  effectsAt(round: number, tick: number, out: Effect[] = []): Effect[] {
    out.length = 0;
    for (const e of this.data(round)?.effects ?? []) {
      if (e.startTick > tick) break;
      if (tick < e.endTick) out.push(e);
    }
    return out;
  }

  /** Grenades in flight at `tick`. */
  projectilesAt(
    round: number,
    tick: number,
    out: Projectile[] = []
  ): Projectile[] {
    out.length = 0;
    for (const p of this.data(round)?.projectiles ?? []) {
      if (p.grenade.start_tick > tick) break;
      if (tick < p.endTick) out.push(p);
    }
    return out;
  }

  /** The round's shots by tick (the same list each call; none for a round not there). */
  shots(round: number): readonly Shot[] {
    return this.data(round)?.shots ?? NO_SHOTS;
  }

  /** The round's hits by tick (the same list each call; none for a round not there). */
  hits(round: number): readonly Hit[] {
    return this.data(round)?.hits ?? NO_HITS;
  }

  /** The round's effects by start tick (the same list each call; none for a round not there). */
  effects(round: number): readonly Effect[] {
    return this.data(round)?.effects ?? NO_EFFECTS;
  }

  /** Shots fired in `(tick − windowTicks, tick]`, oldest first. */
  shotsAt(round: number, tick: number, windowTicks: number): Shot[] {
    return this.window(this.data(round)?.shots ?? [], tick, windowTicks);
  }

  /** Hits taken in `(tick − windowTicks, tick]`, oldest first. */
  hitsAt(round: number, tick: number, windowTicks: number): Hit[] {
    return this.window(this.data(round)?.hits ?? [], tick, windowTicks);
  }

  /** Players blind at `tick`. */
  blindsAt(round: number, tick: number): Blind[] {
    const out: Blind[] = [];
    for (const b of this.data(round)?.blinds ?? []) {
      if (b.startTick > tick) break;
      if (tick < b.endTick) out.push(b);
    }
    return out;
  }

  /** Where the bomb is at `tick`: a new object each call. */
  bombAt(round: number, tick: number): BombState {
    const d = this.data(round);
    if (!d) return { kind: 'none' };
    const { header } = this.pack;
    const tracks = this.pack.rounds[round]?.players ?? [];
    const state = this.bombByEvents(round, d, tick);
    // Before the plant, the track's has-bomb flag beats the events (a pickup event can be
    // missing, and the spawn carrier has none); with nobody flagged the events stand.
    if (
      state.kind === 'none' ||
      state.kind === 'carried' ||
      state.kind === 'dropped'
    ) {
      for (let p = 0; p < tracks.length; p++) {
        const track = tracks[p];
        if (!track) continue;
        const s = playerStateAt(track, d.info, tick, header, this.s);
        if (s.present && s.flags & FLAG.bomb && s.flags & FLAG.alive)
          return { kind: 'carried', by: p };
      }
    }
    // A copy: the states the events give are the round's own.
    return { ...state };
  }

  /**
   * The tick the bomb went off at when it has by `tick` (`bombAt` says `exploded`), or null.
   * It makes nothing, for a caller that asks at every draw (the camera's shake in POV).
   */
  explodedAt(round: number, tick: number): number | null {
    const d = this.data(round);
    if (!d) return null;
    // The tracks' has-bomb flag only counts before the plant: an explosion is the events'.
    const state = this.bombByEvents(round, d, tick);
    return state.kind === 'exploded' ? state.tick : null;
  }

  /** The bomb's state at `tick` by the round's bomb events alone, the round's own object. */
  private bombByEvents(round: number, d: RoundData, tick: number): BombState {
    const states = (d.bombStates ??= this.bombStates(round, d));
    let k = 0;
    while (k < d.bomb.length && d.bomb[k].tick <= tick) k++;
    return k > 0 ? states[k - 1] : NO_BOMB;
  }

  /** The bomb's state after each of the round's bomb events (`d.bomb`), by the events alone. */
  private bombStates(round: number, d: RoundData): BombState[] {
    const out: BombState[] = [];
    let state: BombState = NO_BOMB;
    for (const e of d.bomb) {
      const who = idx(e.data.user_idx);
      switch (e.kind) {
        case 'bomb_pickup':
          if (who !== null) state = { kind: 'carried', by: who };
          break;
        case 'bomb_dropped': {
          const p = who !== null ? this.position(round, who, e.tick) : null;
          state = p ? { kind: 'dropped', ...p, tick: e.tick } : NO_BOMB;
          break;
        }
        case 'bomb_planted': {
          const p = who !== null ? this.position(round, who, e.tick) : null;
          state = {
            kind: 'planted',
            x: p?.x ?? 0,
            y: p?.y ?? 0,
            z: p?.z ?? 0,
            tick: e.tick,
            site: num(e.data.site),
            by: who,
          };
          break;
        }
        case 'bomb_exploded': {
          const at: { x: number; y: number; z: number } =
            state.kind === 'planted' ? state : { x: 0, y: 0, z: 0 };
          state = { kind: 'exploded', tick: e.tick, x: at.x, y: at.y, z: at.z };
          break;
        }
        case 'bomb_defused':
          state = { kind: 'defused', tick: e.tick, by: who };
          break;
        case 'round_end':
          if (state.kind === 'planted' && e.data.reason === 'bomb_defused')
            state = { kind: 'defused', tick: e.tick, by: null };
          break;
      }
      out.push(state);
    }
    return out;
  }

  /** The round clock as the HUD shows it. */
  roundTimer(
    round: number,
    tick: number
  ): { phase: RoundPhase; secondsLeft: number } {
    const d = this.data(round);
    if (!d) return { phase: 'over', secondsLeft: 0 };
    const rate = this.pack.header.tick_rate;
    const end = d.roundEnd ?? d.info.end_tick;
    if (tick >= end) return { phase: 'over', secondsLeft: 0 };
    const bomb = this.bombAt(round, tick);
    if (bomb.kind === 'exploded' || bomb.kind === 'defused')
      return { phase: 'over', secondsLeft: 0 };
    if (bomb.kind === 'planted')
      return {
        phase: 'planted',
        secondsLeft: Math.max(0, BOMB_S - (tick - bomb.tick) / rate),
      };
    if (tick < d.info.freeze_end_tick)
      return {
        phase: 'freeze',
        secondsLeft: (d.info.freeze_end_tick - tick) / rate,
      };
    return {
      phase: 'live',
      secondsLeft: Math.max(
        0,
        ROUND_S - (tick - d.info.freeze_end_tick) / rate
      ),
    };
  }

  /** The last `n` feed items at or before `tick`, oldest first. */
  feed(round: number, tick: number, n: number): FeedItem[] {
    const list = this.data(round)?.feed ?? [];
    const hi = upperBound(list, tick, (f) => f.tick);
    return list.slice(Math.max(0, hi - n), hi);
  }

  /** The round's whole feed (for markers), in tick order. */
  allFeed(round: number): readonly FeedItem[] {
    return this.data(round)?.feed ?? [];
  }

  private window<T extends { tick: number }>(
    list: readonly T[],
    tick: number,
    windowTicks: number
  ): T[] {
    const hi = upperBound(list, tick, (e) => e.tick);
    let lo = hi;
    while (lo > 0 && list[lo - 1].tick > tick - windowTicks) lo--;
    return list.slice(lo, hi);
  }

  private position(
    round: number,
    p: number,
    tick: number
  ): { x: number; y: number; z: number } | null {
    const info = this.pack.header.rounds[round];
    const track = this.pack.rounds[round]?.players[p];
    if (!info || !track) return null;
    const s = playerStateAt(track, info, tick, this.pack.header, this.s);
    return { x: s.x, y: s.y, z: s.z };
  }

  private data(round: number): RoundData | null {
    const cached = this.rounds.get(round);
    if (cached) return cached;
    const { header, events, grenades } = this.pack;
    const info = header.rounds[round];
    if (!info) return null;
    const rate = header.tick_rate;
    const secs = (s: number) => Math.max(1, Math.round(s * rate));
    const inRound = events
      .filter((e) => e.tick >= info.start_tick && e.tick <= info.post_end_tick)
      .sort((a, b) => a.tick - b.tick);
    const players = header.players;
    const valid = (p: number | null): p is number =>
      p !== null && p < players.length;
    const team = (p: number | null) =>
      valid(p) ? (players[p].team_by_round[round] ?? null) : null;
    const name = (p: number | null) => (valid(p) ? players[p].name : 'someone');

    const d: RoundData = {
      info,
      effects: [],
      projectiles: [],
      shots: [],
      hits: [],
      blinds: [],
      kills: [],
      bomb: [],
      roundEnd: null,
      feed: [],
    };
    // The ticks of each end event (`kind:entity`), in order: an effect finds its end by a
    // search, not a pass over the round, so a round of many effects stays linear.
    const ends = new Map<string, number[]>();
    for (const e of inRound)
      if (END_KINDS.has(e.kind)) {
        const key = `${e.kind}:${num(e.data.entityid, -1)}`;
        const ticks = ends.get(key);
        if (ticks) ticks.push(e.tick);
        else ends.set(key, [e.tick]);
      }
    /** The tick of the first `kind` event of `entity` at `from` or after, or null. */
    const endOf = (
      kind: string,
      entity: number,
      from: number
    ): number | null => {
      const ticks = ends.get(`${kind}:${entity}`);
      if (!ticks) return null;
      let lo = 0;
      let hi = ticks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ticks[mid] < from) lo = mid + 1;
        else hi = mid;
      }
      return lo < ticks.length ? ticks[lo] : null;
    };
    const effect = (kind: EffectKind, e: PackEvent, endTick: number) => {
      d.effects.push({
        kind,
        x: num(e.data.x),
        y: num(e.data.y),
        z: num(e.data.z),
        startTick: e.tick,
        endTick,
        thrower: idx(e.data.user_idx),
        entityId: num(e.data.entityid, -1),
      });
    };

    // A shot's own record and its hit are logged at the shot's tick, in any order beside its
    // weapon_fire: keyed by tick and player, taken by the weapon_fire in turn.
    const fired = new Map<string, PackEvent[]>();
    const struck = new Map<string, PackEvent[]>();
    const file = (
      m: Map<string, PackEvent[]>,
      e: PackEvent,
      who: number | null
    ) => {
      if (who === null) return;
      const key = `${e.tick}:${who}`;
      const list = m.get(key);
      if (list) list.push(e);
      else m.set(key, [e]);
    };
    for (const e of inRound) {
      if (e.kind === 'fire_bullets') file(fired, e, idx(e.data.user_idx));
      else if (e.kind === 'bullet_damage')
        file(struck, e, idx(e.data.attacker_idx));
    }

    for (const e of inRound) {
      const data = e.data;
      const who = idx(data.user_idx);
      switch (e.kind) {
        case 'smokegrenade_detonate':
          effect(
            'smoke',
            e,
            endOf('smokegrenade_expired', num(data.entityid, -1), e.tick) ??
              e.tick + secs(SMOKE_S)
          );
          break;
        case 'inferno_startburn':
          effect(
            'fire',
            e,
            endOf('inferno_expire', num(data.entityid, -1), e.tick) ??
              e.tick + secs(FIRE_S)
          );
          break;
        case 'flashbang_detonate':
          effect('flash', e, e.tick + secs(FLASH_S));
          break;
        case 'hegrenade_detonate':
          effect('he', e, e.tick + secs(HE_S));
          break;
        case 'decoy_started':
          effect(
            'decoy',
            e,
            endOf('decoy_detonate', num(data.entityid, -1), e.tick) ??
              e.tick + secs(DECOY_S)
          );
          break;
        case 'weapon_fire':
          if (valid(who)) {
            const w = normaliseWeapon(String(data.weapon ?? ''));
            const f = fired.get(`${e.tick}:${who}`)?.shift()?.data;
            const b = struck.get(`${e.tick}:${who}`)?.shift()?.data;
            const has = (o: Record<string, unknown> | undefined, k: string) =>
              typeof o?.[k] === 'number' && Number.isFinite(o[k]);
            d.shots.push({
              tick: e.tick,
              player: who,
              weapon: w,
              suppressed: isSuppressed(w) || data.silenced === true,
              from:
                f &&
                has(f, 'origin_x') &&
                has(f, 'origin_y') &&
                has(f, 'origin_z')
                  ? {
                      x: num(f.origin_x),
                      y: num(f.origin_y),
                      z: num(f.origin_z),
                    }
                  : null,
              aim:
                f && has(f, 'angles_x') && has(f, 'angles_y')
                  ? { pitch: num(f.angles_x), yaw: num(f.angles_y) }
                  : null,
              hit:
                b && has(b, 'damage_dir_x') && has(b, 'distance')
                  ? {
                      dir: [
                        num(b.damage_dir_x),
                        num(b.damage_dir_y),
                        num(b.damage_dir_z),
                      ],
                      distance: num(b.distance),
                      penetrations: Math.max(0, num(b.num_penetrations)),
                    }
                  : null,
            });
          }
          break;
        case 'player_hurt':
          if (valid(who)) {
            const hitgroup =
              typeof data.hitgroup === 'string' ? data.hitgroup : 'generic';
            const attacker = idx(data.attacker_idx);
            d.hits.push({
              tick: e.tick,
              victim: who,
              attacker: valid(attacker) ? attacker : null,
              damage: num(data.dmg_health),
              hitgroup,
              headshot: hitgroup === 'head',
              weapon: normaliseWeapon(String(data.weapon ?? '')),
              fatal: data.health === 0,
            });
          }
          break;
        case 'player_blind': {
          const secsBlind = num(data.blind_duration);
          if (valid(who) && secsBlind > 0) {
            const attacker = idx(data.attacker_idx);
            d.blinds.push({
              player: who,
              startTick: e.tick,
              endTick: e.tick + secs(secsBlind),
              attacker: valid(attacker) ? attacker : null,
            });
          }
          break;
        }
        case 'player_death': {
          if (!valid(who)) break;
          const attacker = idx(data.attacker_idx);
          const assister = idx(data.assister_idx);
          const k: Kill = {
            tick: e.tick,
            attacker: valid(attacker) ? attacker : null,
            victim: who,
            assister: valid(assister) ? assister : null,
            weapon: normaliseWeapon(String(data.weapon ?? '')),
            headshot: data.headshot === true,
            wallbang: num(data.penetrated) > 0,
            smoke: data.thrusmoke === true,
            noscope: data.noscope === true,
            blind: data.attackerblind === true,
            flashAssist: data.assistedflash === true,
          };
          d.kills.push(k);
          const self = k.attacker === null || k.attacker === k.victim;
          d.feed.push({
            tick: e.tick,
            kind: 'kill',
            team: self ? team(k.victim) : team(k.attacker),
            text: self
              ? `${name(k.victim)} died`
              : `${name(k.attacker)} killed ${name(k.victim)}`,
          });
          break;
        }
        case 'bomb_pickup':
        case 'bomb_dropped':
        case 'bomb_exploded':
        case 'bomb_defused':
          d.bomb.push(e);
          if (e.kind === 'bomb_exploded')
            d.feed.push({
              tick: e.tick,
              kind: 'exploded',
              team: 2,
              text: 'The bomb exploded',
            });
          if (e.kind === 'bomb_defused')
            d.feed.push({
              tick: e.tick,
              kind: 'defused',
              team: team(who),
              text: `${name(who)} defused the bomb`,
            });
          break;
        case 'bomb_planted':
          d.bomb.push(e);
          d.feed.push({
            tick: e.tick,
            kind: 'plant',
            team: team(who),
            text: `${name(who)} planted the bomb`,
          });
          break;
        case 'round_end':
          if (d.roundEnd === null) d.roundEnd = e.tick;
          d.bomb.push(e);
          break;
      }
    }

    for (const g of grenades) {
      if (g.start_tick < info.start_tick || g.start_tick > info.post_end_tick)
        continue;
      const trackEnd =
        g.start_tick + Math.max(0, g.samples - 1) * header.tick_step;
      const endTick = g.detonate_tick ?? trackEnd;
      const label = GRENADE_LABEL[g.kind];
      d.projectiles.push({
        grenade: g,
        label,
        endTick: Math.max(g.start_tick + 1, endTick),
      });
      const thrower = valid(g.thrower) ? g.thrower : null;
      d.feed.push({
        tick: g.start_tick,
        kind: 'throw',
        team: team(thrower),
        text: `${name(thrower)} threw ${label}`,
      });
    }

    // Defuse starts from the defusing flag (the pack carries no bomb_begindefuse).
    const tracks = this.pack.rounds[round]?.players ?? [];
    for (let p = 0; p < tracks.length && p < players.length; p++) {
      const t = tracks[p];
      if (!t) continue;
      let was = false;
      for (let k = 0; k < info.samples; k++) {
        const on =
          (t.flags[k] & FLAG.defusing) !== 0 && (t.flags[k] & FLAG.alive) !== 0;
        if (on && !was)
          d.feed.push({
            tick: info.start_tick + k * header.tick_step,
            kind: 'defuse',
            team: team(p),
            text: `${name(p)} started defusing`,
          });
        was = on;
      }
    }

    d.effects.sort((a, b) => a.startTick - b.startTick);
    d.projectiles.sort((a, b) => a.grenade.start_tick - b.grenade.start_tick);
    d.blinds.sort((a, b) => a.startTick - b.startTick);
    // Stable: same-tick items keep event order (a throw before the kill it caused).
    d.feed.sort((a, b) => a.tick - b.tick);
    this.rounds.set(round, d);
    return d;
  }
}
