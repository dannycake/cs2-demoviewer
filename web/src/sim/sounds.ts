// A round's sounds as data: every cue (what sounds, when, where, with which seed) built once
// from the pack, so a round played, sought into or played again sounds the same. The keys are
// the sounds manifest's (`tools/lib/sounds.mjs`); a cue whose key the manifest lacks is skipped
// where it is played. What the pack has no event for is read from the tracks: footsteps and
// landings (`footsteps.ts`), grenade bounces (`bounces.ts`), the bomb's beeps (its light's
// blink), the defuse's start (the defusing flag) and a decoy's shots (a seeded pattern). Pure:
// a function of (pack, round, the step set under a point).

import type { Vec3 } from '../audio/manifest';
import {
  FLAG,
  GEAR,
  type Grenade,
  type MatchHeader,
  type Pack,
} from '../pack/types';
import { SeededRandom } from './random';
import { ActionIndex } from './actions';
import { grenadeBounces } from './bounces';
import { footfalls } from './footsteps';
import { newPlayerState, playerStateAt } from './sample';
import {
  blinkOn,
  BOMB_S,
  timelineFor,
  type Effect,
  type Shot,
} from './timeline';
import { muzzleClass, normaliseWeapon } from './weapons';

/** Where in a reload its clip comes out, goes in and the bolt is worked, as shares of it. */
export const RELOAD_PARTS = { out: 0.2, in: 0.55, bolt: 0.8 } as const;

/**
 * A decoy fires bursts of `shots` (inclusive) shots `shotS` apart, `gapS` seconds between a
 * burst's last shot and the next's first, drawn from the decoy's seed.
 */
export const DECOY = { gapS: [1.5, 3], shots: [1, 4], shotS: 0.12 } as const;

export interface Cue {
  tick: number;
  /** The sound's key in the manifest: `shot:ak47`, `step:concrete:ct`, `round:go`. */
  key: string;
  /**
   * Source units, at the source's origin (a player's feet: the sound's layers lift a shot to the
   * gun); null for a sound heard the same everywhere (the announcer, the countdown).
   */
  at: Vec3 | null;
  /** Fixes the clip and the random volume and pitch: a hash of (tick, source, key). */
  seed: number;
  /** A loop: it sounds from `tick` until this tick (exclusive). A one-shot has none. */
  until?: number;
}

/** The step set (`step:<set>:…`, `land:<set>`) of the surface under a point, Source units. */
export type StepSetAt = (x: number, y: number, z: number) => string;

/** A grenade's weapon name → its sounds' kind (`throw:he`). */
const THROW: Readonly<Record<string, string>> = {
  hegrenade: 'he',
  flashbang: 'flash',
  smokegrenade: 'smoke',
  molotov: 'molotov',
  incendiary: 'incendiary',
  decoy: 'decoy',
};

/**
 * Guns whose silencer comes off, whose silenced shot is a sound of its own. The MP5-SD's one
 * shot (`shot:mp5sd`) is already its suppressed one.
 */
const SILENCER_OFF: ReadonlySet<string> = new Set(['usp', 'm4a1s']);

/** A fire's grenade bursts within this of the fire's start, seconds (on Mirage, on its tick). */
const FIRE_GRENADE_S = 0.5;

/** The seed source of the bomb's and the round's cues: no player's or entity's. */
const NOBODY = -1;

const actionIndexes = new WeakMap<Pack, ActionIndex>();

/** The actions of `pack`, made once per pack. */
function actionsFor(pack: Pack): ActionIndex {
  let a = actionIndexes.get(pack);
  if (!a) {
    a = new ActionIndex(pack);
    actionIndexes.set(pack, a);
  }
  return a;
}

/**
 * The round's cues, sorted by tick (same-tick cues in the order below):
 * - each shot, `shot:<weapon>` (`shot:<weapon>:silenced` from a silenced USP-S or M4A1-S), or
 *   for a grenade its `throw:<kind>`, at the shooter;
 * - each reload's `reload:<weapon>:out|in|bolt` at its `RELOAD_PARTS`, where the player is then;
 *   a death or a switch to another weapon ends it;
 * - each footfall, `step:<set>:<ct|t>` or `land:<set>` with the set `stepSetAt` gives its spot;
 * - each hit from a gun or knife, `hit:` (or `death:` for the killing one) and `head` / `helmet`
 *   (a headshot on a helmet the victim wore a sample before) / `body` / `armor` (armour a
 *   sample before), at the victim;
 * - each grenade bounce, `bounce:<kind>`;
 * - effects: `explode:he`, `explode:flash`, `smoke:emit`; a fire's `fire:start:<kind>` (of its
 *   grenade), its `fire:loop` until it ends and `fire:out` then; a decoy's shots of the gun
 *   its thrower last fired before the throw (else the side's pistol) in `DECOY` bursts
 *   (`decoyShotTicks`) until it ends, or the round does;
 * - the bomb: `bomb:initiate` at the planter, `bomb:plant` at the bomb and `round:planted` (the
 *   round's first `bomb_planted`; a round has one, and a later one is ignored), a
 *   `bomb:beep` on each blink of its light until the defuse or the blast, `bomb:defuse` (from
 *   `bomb_begindefuse`, else the defusing flag), `bomb:defused` and `round:defused`,
 *   `bomb:explode`;
 * - the round: `round:beep` on each countdown beep, `round:go` on the last, `round:ct|t|draw`
 *   for the winner.
 * Players not in the round (no side) sound nothing. Events count from `start_tick` to
 * `post_end_tick`, as the timeline's do.
 */
export function roundCues(
  pack: Pack,
  round: number,
  stepSetAt: StepSetAt
): Cue[] {
  const { header } = pack;
  const info = header.rounds[round];
  if (!info) return [];
  const rate = header.tick_rate;
  const tracks = pack.rounds[round]?.players ?? [];
  const tl = timelineFor(pack);
  const s = newPlayerState();
  const cues: Cue[] = [];
  const add = (
    tick: number,
    key: string,
    at: Vec3 | null,
    source: number,
    until?: number
  ) => {
    const cue: Cue = { tick, key, at, seed: cueSeed(tick, source, key) };
    if (until !== undefined) cue.until = until;
    cues.push(cue);
  };
  const side = (p: number) => {
    const team = header.players[p]?.team_by_round[round];
    return team === 2 ? 't' : team === 3 ? 'ct' : null;
  };
  const playing = (p: number | null): p is number =>
    p !== null && side(p) !== null && tracks[p] !== undefined;
  /** The last sample before `tick` (clamped to the round). */
  const sampleBefore = (tick: number) =>
    Math.min(
      info.samples - 1,
      Math.max(0, Math.ceil((tick - info.start_tick) / header.tick_step) - 1)
    );
  /** Where player `p` stands at `tick`; their last sample before it when they are not alive. */
  const origin = (p: number, tick: number): Vec3 => {
    const track = tracks[p];
    playerStateAt(track, info, tick, header, s);
    if (s.present) return { x: s.x, y: s.y, z: s.z };
    const k = sampleBefore(tick);
    return { x: track.x[k], y: track.y[k], z: track.z[k] };
  };

  const shots = tl.shots(round);
  for (const shot of shots) {
    if (!playing(shot.player)) continue;
    const kind = THROW[shot.weapon];
    add(
      shot.tick,
      kind ? `throw:${kind}` : shotKey(shot.weapon, shot.suppressed),
      origin(shot.player, shot.tick),
      shot.player
    );
  }

  const actions = actionsFor(pack).build(round);
  for (let p = 0; p < actions.length; p++) {
    if (!playing(p)) continue;
    for (const a of actions[p]) {
      const w = a.data?.weapon;
      if (a.kind !== 'reload' || !w) continue;
      for (const part of ['out', 'in', 'bolt'] as const) {
        const tick =
          a.startTick + Math.round(RELOAD_PARTS[part] * a.durationTicks);
        playerStateAt(tracks[p], info, tick, header, s);
        if (
          !s.present ||
          normaliseWeapon(header.weapons[s.weapon] ?? 'none') !== w
        )
          break;
        add(tick, `reload:${w}:${part}`, { x: s.x, y: s.y, z: s.z }, p);
      }
    }
  }

  for (let p = 0; p < header.players.length; p++) {
    const team = side(p);
    if (!team || !tracks[p]) continue;
    for (const f of footfalls(tracks[p], info, header)) {
      const set = stepSetAt(f.x, f.y, f.z);
      add(
        f.tick,
        f.kind === 'step' ? `step:${set}:${team}` : `land:${set}`,
        { x: f.x, y: f.y, z: f.z },
        p
      );
    }
  }

  for (const h of tl.hits(round)) {
    if (!gunOrKnife(h.weapon) || !playing(h.victim)) continue;
    const track = tracks[h.victim];
    const k = sampleBefore(h.tick);
    const part = h.headshot
      ? track.gear[k] & GEAR.helmet
        ? 'helmet'
        : 'head'
      : track.armor[k] > 0
        ? 'armor'
        : 'body';
    add(
      h.tick,
      `${h.fatal ? 'death' : 'hit'}:${part}`,
      origin(h.victim, h.tick),
      h.victim
    );
  }

  const grenades = pack.grenades.filter(
    (g) => g.start_tick >= info.start_tick && g.start_tick <= info.post_end_tick
  );
  for (const g of grenades)
    for (const b of grenadeBounces(g, header))
      add(b.tick, `bounce:${g.kind}`, { x: b.x, y: b.y, z: b.z }, g.entity_id);

  const decoyShot = decoyGuns(shots, side);
  const fireKind = fireKinds(grenades, header);
  for (const e of tl.effects(round)) {
    const at = { x: e.x, y: e.y, z: e.z };
    switch (e.kind) {
      case 'he':
        add(e.startTick, 'explode:he', at, e.entityId);
        break;
      case 'flash':
        add(e.startTick, 'explode:flash', at, e.entityId);
        break;
      case 'smoke':
        add(e.startTick, 'smoke:emit', at, e.entityId);
        break;
      case 'fire':
        add(e.startTick, `fire:start:${fireKind(e)}`, at, e.entityId);
        add(e.startTick, 'fire:loop', at, e.entityId, e.endTick);
        add(e.endTick, 'fire:out', at, e.entityId);
        break;
      case 'decoy': {
        const key = decoyShot(
          e.thrower !== null && playing(e.thrower) ? e.thrower : null,
          e.startTick
        );
        // The decoy_detonate that ends it can lie anywhere: no further than the round.
        const end = Math.min(e.endTick, info.post_end_tick + 1);
        const seed = cueSeed(e.startTick, e.entityId, 'decoy');
        for (const tick of decoyShotTicks(e.startTick, end, rate, seed))
          add(tick, key, at, e.entityId);
        break;
      }
    }
  }

  const events = pack.events
    .filter((e) => e.tick >= info.start_tick && e.tick <= info.post_end_tick)
    .sort((a, b) => a.tick - b.tick);
  /** The round's plant: its first `bomb_planted` (a round has one; a later one is ignored). */
  let plant: { tick: number; at: Vec3 } | null = null;
  /** Where the planted bomb is at `tick`, or null before the plant. */
  const bombAt = (tick: number): Vec3 | null =>
    plant && plant.tick <= tick ? plant.at : null;
  /** Ticks the beeping stops: a defuse, a blast. */
  const silenced: number[] = [];
  let ended = false;
  const begins = events.some((e) => e.kind === 'bomb_begindefuse');
  for (const e of events) {
    const who = idx(e.data.user_idx);
    switch (e.kind) {
      case 'cs_round_start_beep':
        add(e.tick, 'round:beep', null, NOBODY);
        break;
      case 'cs_round_final_beep':
        add(e.tick, 'round:go', null, NOBODY);
        break;
      case 'round_end': {
        if (e.data.reason === 'bomb_defused') silenced.push(e.tick);
        if (ended) break;
        ended = true;
        const winner =
          typeof e.data.winner === 'number' ? e.data.winner : info.winner;
        add(
          e.tick,
          `round:${winner === 3 ? 'ct' : winner === 2 ? 't' : 'draw'}`,
          null,
          NOBODY
        );
        break;
      }
      case 'bomb_beginplant':
        if (playing(who))
          add(e.tick, 'bomb:initiate', origin(who, e.tick), who);
        break;
      case 'bomb_planted': {
        if (plant) break;
        const b = tl.bombAt(round, e.tick);
        const at =
          b.kind === 'planted'
            ? { x: b.x, y: b.y, z: b.z }
            : playing(who)
              ? origin(who, e.tick)
              : null;
        if (at) {
          plant = { tick: e.tick, at };
          add(e.tick, 'bomb:plant', at, NOBODY);
        }
        add(e.tick, 'round:planted', null, NOBODY);
        break;
      }
      case 'bomb_begindefuse': {
        const at =
          bombAt(e.tick) ?? (playing(who) ? origin(who, e.tick) : null);
        if (at) add(e.tick, 'bomb:defuse', at, who ?? NOBODY);
        break;
      }
      case 'bomb_defused': {
        silenced.push(e.tick);
        const at = bombAt(e.tick);
        if (at) add(e.tick, 'bomb:defused', at, NOBODY);
        add(e.tick, 'round:defused', null, NOBODY);
        break;
      }
      case 'bomb_exploded': {
        silenced.push(e.tick);
        const at = bombAt(e.tick);
        if (at) add(e.tick, 'bomb:explode', at, NOBODY);
        break;
      }
    }
  }
  if (plant) {
    const { tick: planted, at } = plant;
    let end = Math.min(
      planted + Math.round(BOMB_S * rate),
      info.post_end_tick + 1
    );
    for (const t of silenced) if (t > planted) end = Math.min(end, t);
    for (const t of bombBeepTicks(planted, end, rate))
      add(t, 'bomb:beep', at, NOBODY);
  }
  // Defuse starts from the defusing flag when the pack has no bomb_begindefuse.
  if (!begins)
    for (let p = 0; p < header.players.length; p++) {
      if (!playing(p)) continue;
      const track = tracks[p];
      let was = false;
      for (let k = 0; k < info.samples; k++) {
        const on =
          (track.flags[k] & FLAG.defusing) !== 0 &&
          (track.flags[k] & FLAG.alive) !== 0;
        if (on && !was) {
          const tick = info.start_tick + k * header.tick_step;
          add(tick, 'bomb:defuse', bombAt(tick) ?? origin(p, tick), p);
        }
        was = on;
      }
    }

  // Stable: same-tick cues keep the order they were made in.
  return cues.sort((a, b) => a.tick - b.tick);
}

/** The most shots one decoy fires: a backstop for a decoy no round could hold. */
export const DECOY_MAX_SHOTS = 200;

/**
 * The ticks of a decoy's shots from `start` until `end` (exclusive) at `rate` ticks a second:
 * bursts on `DECOY`'s pattern drawn from `seed`, the first at `start`; none at a rate that does
 * not move time forward, and at most `DECOY_MAX_SHOTS`.
 */
export function decoyShotTicks(
  start: number,
  end: number,
  rate: number,
  seed: number
): number[] {
  const out: number[] = [];
  const apart = DECOY.shotS * rate;
  if (!(apart > 0)) return out;
  const random = new SeededRandom().reset(seed);
  const [fewest, most] = DECOY.shots;
  const [shortest, longest] = DECOY.gapS;
  for (let t = start; t < end && out.length < DECOY_MAX_SHOTS;) {
    const n = fewest + Math.floor(random.next() * (most - fewest + 1));
    for (let i = 0; i < n && out.length < DECOY_MAX_SHOTS; i++) {
      const tick = Math.round(t + i * apart);
      if (tick >= end) break;
      out.push(tick);
    }
    const advance =
      (n - 1) * apart +
      (shortest + random.next() * (longest - shortest)) * rate;
    if (!(advance > 0)) break;
    t += advance;
  }
  return out;
}

/**
 * The ticks in `(plantTick, endTick)` where the planted bomb's light turns on (`blinkOn`): its
 * beeps, a second apart at the plant and ever closer to the end of the fuse.
 */
export function bombBeepTicks(
  plantTick: number,
  endTick: number,
  rate: number
): number[] {
  const out: number[] = [];
  let was = blinkOn(0);
  for (let t = plantTick + 1; t < endTick; t++) {
    const on = blinkOn((t - plantTick) / rate);
    if (on && !was) out.push(t);
    was = on;
  }
  return out;
}

/** The one-shots of `cues` (sorted by tick) with `from < tick ≤ to`, into `out`. */
export function crossed(
  cues: readonly Cue[],
  from: number,
  to: number,
  out: Cue[] = []
): Cue[] {
  out.length = 0;
  for (let i = after(cues, from); i < cues.length && cues[i].tick <= to; i++)
    if (cues[i].until === undefined) out.push(cues[i]);
  return out;
}

/** The loops of `cues` (sorted by tick) sounding at `tick` (`cue.tick ≤ tick < until`), into `out`. */
export function loopsAt(
  cues: readonly Cue[],
  tick: number,
  out: Cue[] = []
): Cue[] {
  out.length = 0;
  const hi = after(cues, tick);
  for (let i = 0; i < hi; i++) {
    const c = cues[i];
    if (c.until !== undefined && tick < c.until) out.push(c);
  }
  return out;
}

/** The index of the first cue after `tick`. */
function after(cues: readonly Cue[], tick: number): number {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function shotKey(weapon: string, suppressed: boolean): string {
  return suppressed && SILENCER_OFF.has(weapon)
    ? `shot:${weapon}:silenced`
    : `shot:${weapon}`;
}

/** Guns (the taser with them) and knives make a hit's sound; grenades, fire and falls do not. */
function gunOrKnife(weapon: string): boolean {
  return (
    weapon === 'knife' || weapon === 'taser' || muzzleClass(weapon) !== null
  );
}

/**
 * The shot key of a round's decoy, by its thrower `p` (null: unknown) and the tick it started:
 * the gun `p` last fired before the throw (their last decoy thrown by that tick), else the
 * side's pistol (the Glock for a T or an unknown thrower, the P2000 for a CT). Each player's
 * throws and gunshots are indexed once from `shots` (in tick order), so a decoy costs a search,
 * not a pass over the round's shots.
 */
function decoyGuns(
  shots: readonly Shot[],
  side: (p: number) => 't' | 'ct' | null
): (p: number | null, tick: number) => string {
  /** Each player's decoy throws, in tick order. */
  const throws = new Map<number, number[]>();
  /** Each player's gunshots, in tick order, and their keys. */
  const guns = new Map<number, { ticks: number[]; keys: string[] }>();
  for (const shot of shots) {
    if (shot.weapon === 'decoy') listOf(throws, shot.player).push(shot.tick);
    if (muzzleClass(shot.weapon) === null) continue;
    let g = guns.get(shot.player);
    if (!g) guns.set(shot.player, (g = { ticks: [], keys: [] }));
    g.ticks.push(shot.tick);
    g.keys.push(shotKey(shot.weapon, shot.suppressed));
  }
  return (p, tick) => {
    if (p === null) return 'shot:glock';
    const mine = throws.get(p) ?? [];
    const n = countBefore(mine, tick, true);
    const thrown = n > 0 ? mine[n - 1] : tick;
    const g = guns.get(p);
    const i = g ? countBefore(g.ticks, thrown, false) : 0;
    if (g && i > 0) return g.keys[i - 1];
    return side(p) === 'ct' ? 'shot:hkp2000' : 'shot:glock';
  };
}

/** A molotov or incendiary of a round, by when it burst and its place in the round's list. */
interface Burst {
  tick: number;
  order: number;
  grenade: Grenade;
}

/**
 * The kind of grenade that lit a round's fire. The inferno is an entity of its own, its id not
 * the grenade's (on the Mirage pack none of 47 is, while ids are reused across the match): the
 * grenade is the thrower's molotov or incendiary that burst nearest the fire's start, within
 * `FIRE_GRENADE_S` (the later in `grenades` of two as near); else the one with the fire's id;
 * else a molotov. The molotovs and incendiaries are indexed once, by thrower and by when they
 * burst, so a fire costs a search, not a pass over the round's grenades.
 */
function fireKinds(
  grenades: readonly Grenade[],
  header: MatchHeader
): (e: Effect) => 'molotov' | 'incendiary' {
  const reach = FIRE_GRENADE_S * header.tick_rate;
  /** Each thrower's, and under null everyone's, by burst tick, then order. */
  const bursts = new Map<number | null, Burst[]>();
  /** The first of each entity id. */
  const byId = new Map<number, Grenade>();
  grenades.forEach((grenade, order) => {
    if (grenade.kind !== 'molotov' && grenade.kind !== 'incendiary') return;
    if (!byId.has(grenade.entity_id)) byId.set(grenade.entity_id, grenade);
    const tick =
      grenade.detonate_tick ??
      grenade.start_tick + (grenade.samples - 1) * header.tick_step;
    // A burst at no tick is never the nearest.
    if (!Number.isFinite(tick)) return;
    listOf(bursts, grenade.thrower).push({ tick, order, grenade });
    listOf(bursts, null).push({ tick, order, grenade });
  });
  const ticks = new Map<number | null, number[]>();
  for (const [thrower, list] of bursts) {
    list.sort((a, b) => a.tick - b.tick || a.order - b.order);
    ticks.set(
      thrower,
      list.map((b) => b.tick)
    );
  }
  return (e) => {
    const list = bursts.get(e.thrower) ?? [];
    const at = ticks.get(e.thrower) ?? [];
    const start = e.startTick;
    // The nearest bursts are the last at or before the start and the first at or after it;
    // of several at one tick, the last in the round's order.
    const before = countBefore(at, start, true) - 1;
    const first = countBefore(at, start, false);
    const after = first < at.length ? countBefore(at, at[first], true) - 1 : -1;
    let best: Burst | null = null;
    let bestGap = reach;
    for (const i of [before, after]) {
      if (i < 0) continue;
      const b = list[i];
      const gap = Math.abs(b.tick - start);
      if (gap < bestGap || (gap === bestGap && b.order > (best?.order ?? -1))) {
        best = b;
        bestGap = gap;
      }
    }
    const g = best?.grenade ?? byId.get(e.entityId);
    return g?.kind === 'incendiary' ? 'incendiary' : 'molotov';
  };
}

/** `key`'s list in `m`, made empty the first time. */
function listOf<K, V>(m: Map<K, V[]>, key: K): V[] {
  let list = m.get(key);
  if (!list) m.set(key, (list = []));
  return list;
}

/** How many of `ticks` (ascending) are before `tick`, or with `orAt`, at it or before. */
function countBefore(
  ticks: readonly number[],
  tick: number,
  orAt: boolean
): number {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] < tick || (orAt && ticks[mid] === tick)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The cue's seed: FNV-1a over the key, then the tick and the source (a player's index, an
 * entity's id, or `NOBODY`), finished with murmur3's mix; a uint32.
 */
function cueSeed(tick: number, source: number, key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++)
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ tick, 0x01000193);
  h = Math.imul(h ^ source, 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function idx(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}
