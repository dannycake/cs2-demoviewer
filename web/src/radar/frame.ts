// What the radar shows at one tick, as plain data in radar pixels: players, deaths, kill lines,
// utility, grenades in flight and the bomb. A pure function of (pack, round, tick) through the
// shared `Timeline`, so the radar and the 3D scene agree whether a tick was played or sought.
// Lifetimes and radii are the 3D scene's (`sim/timeline.ts`).

import { UNIT, worldToRadar } from '../geo/coords';
import { FLAG, type Pack } from '../pack/types';
import { blindAlpha } from '../sim/impacts';
import { newPlayerState, playerStateAt } from '../sim/sample';
import {
  blinkOn,
  FIRE_RADIUS,
  HE_BLAST_S,
  SMOKE_RADIUS,
  timelineFor,
  type EffectKind,
} from '../sim/timeline';
import { sectionAt, type Overview } from './overview';

/** A kill's line from the killer to the victim lasts this long, seconds. */
export const KILL_LINE_S = 1;
/** A hit's red ring fades over this, seconds. */
export const HIT_S = 0.3;
/** A shot's tick shows for this, seconds. */
export const SHOT_S = 0.1;
/** A grenade in flight trails this much of its track, seconds. */
export const TRAIL_S = 1;
/** Effect radii, Source units: the 3D smoke and fire's, an HE's reach, a flash's burst. */
export const RADIUS_U: Readonly<Record<EffectKind, number>> = {
  smoke: Math.round(SMOKE_RADIUS / UNIT),
  fire: Math.round(FIRE_RADIUS / UNIT),
  he: 350,
  flash: 160,
  decoy: 48,
};

export interface RadarPlayer {
  index: number;
  /** The digit that follows them: `1`…`9`, `0`; empty past ten players. */
  label: string;
  team: 2 | 3;
  /** Radar pixels. */
  x: number;
  y: number;
  /** Where they look on the canvas: radians from +x, clockwise (the radar's y points down). */
  dir: number;
  /** Index into `Overview.sections`. */
  level: number;
  /** 0–1: how white the disc is while blind. */
  blind: number;
  /** 0–1: a hit's ring, fading. */
  hit: number;
  shot: boolean;
  /** Carrying the bomb. */
  bomb: boolean;
  shown: boolean;
}

export interface RadarDeath {
  x: number;
  y: number;
  team: number;
  level: number;
}

export interface RadarKill {
  from: [number, number];
  to: [number, number];
  /** The killer's team. */
  team: number;
  headshot: boolean;
  /** 0 at the kill, 1 when the line is gone. */
  age: number;
  level: number;
}

export interface RadarEffect {
  kind: EffectKind;
  x: number;
  y: number;
  level: number;
  /** Radar pixels. */
  radius: number;
  /** 0 at the start of its life, 1 at its end. */
  progress: number;
  /** Seconds since it started. */
  age: number;
  /** The thrower's team, or null. */
  team: number | null;
}

export interface RadarProjectile {
  team: number | null;
  level: number;
  /** Radar pixels, oldest first; the last point is the grenade. */
  trail: [number, number][];
}

export interface RadarBomb {
  state: 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';
  x: number;
  y: number;
  level: number;
  /** Planted: whether the light is on at this tick. */
  blink: boolean;
  /** Seconds since the bomb came to this state (0 while carried). */
  age: number;
}

export interface RadarSite {
  label: 'A' | 'B';
  /** Radar pixels. */
  x: number;
  y: number;
}

export interface RadarFrame {
  sites: RadarSite[];
  /** By index, the shown player last. */
  players: RadarPlayer[];
  deaths: RadarDeath[];
  kills: RadarKill[];
  effects: RadarEffect[];
  projectiles: RadarProjectile[];
  bomb: RadarBomb | null;
}

const DEG = Math.PI / 180;
const state = newPlayerState();

function labelOf(index: number): string {
  return index < 9 ? String(index + 1) : index === 9 ? '0' : '';
}

/** Where player `p` last stood alive at or before `tick` (Source units), or null. */
function lastAlive(
  pack: Pack,
  round: number,
  p: number,
  tick: number
): { x: number; y: number; z: number } | null {
  const info = pack.header.rounds[round];
  const track = pack.rounds[round]?.players[p];
  if (!info || !track) return null;
  const step = pack.header.tick_step;
  let k = Math.min(
    info.samples - 1,
    Math.floor((tick - info.start_tick) / step)
  );
  while (k >= 0 && !(track.flags[k] & FLAG.alive)) k--;
  return k < 0 ? null : { x: track.x[k], y: track.y[k], z: track.z[k] };
}

/** The radar at `tick` of `round`; `shown` is the player the camera shows (`shownAt`). */
export function radarFrame(
  pack: Pack,
  round: number,
  tick: number,
  ov: Overview,
  shown: number | null
): RadarFrame {
  const { header } = pack;
  const info = header.rounds[round];
  const out: RadarFrame = {
    sites: sitesOf(ov),
    players: [],
    deaths: [],
    kills: [],
    effects: [],
    projectiles: [],
    bomb: null,
  };
  if (!info) return out;
  const rate = header.tick_rate;
  const tl = timelineFor(pack);
  const teamOf = (p: number | null) =>
    p !== null ? (header.players[p]?.team_by_round[round] ?? 0) : 0;
  const at = (x: number, y: number) => worldToRadar(x, y, ov);
  const px = (units: number) => units / ov.scale;

  const blind = new Map<number, number>();
  for (const b of tl.blindsAt(round, tick))
    blind.set(
      b.player,
      Math.max(
        blind.get(b.player) ?? 0,
        blindAlpha(b.startTick, b.endTick, tick)
      )
    );
  const hit = new Map<number, number>();
  for (const h of tl.hitsAt(round, tick, HIT_S * rate))
    hit.set(
      h.victim,
      Math.max(hit.get(h.victim) ?? 0, 1 - (tick - h.tick) / (HIT_S * rate))
    );
  const shot = new Set(
    tl.shotsAt(round, tick, SHOT_S * rate).map((s) => s.player)
  );
  const bomb = tl.bombAt(round, tick);

  const tracks = pack.rounds[round]?.players ?? [];
  let last: RadarPlayer | null = null;
  for (let p = 0; p < tracks.length; p++) {
    const team = teamOf(p);
    if (team !== 2 && team !== 3) continue;
    const s = playerStateAt(tracks[p], info, tick, header, state);
    if (!s.present) continue;
    const [x, y] = at(s.x, s.y);
    const player: RadarPlayer = {
      index: p,
      label: labelOf(p),
      team,
      x,
      y,
      dir: -s.yaw * DEG,
      level: sectionAt(ov, s.z),
      blind: blind.get(p) ?? 0,
      hit: hit.get(p) ?? 0,
      shot: shot.has(p),
      bomb: bomb.kind === 'carried' && bomb.by === p,
      shown: p === shown,
    };
    if (player.shown) last = player;
    else out.players.push(player);
  }
  if (last) out.players.push(last);

  for (const k of tl.kills(round)) {
    if (k.tick > tick) break;
    const fell = lastAlive(pack, round, k.victim, k.tick);
    if (!fell) continue;
    const to = at(fell.x, fell.y);
    const level = sectionAt(ov, fell.z);
    out.deaths.push({ x: to[0], y: to[1], team: teamOf(k.victim), level });
    const age = (tick - k.tick) / (KILL_LINE_S * rate);
    if (age >= 1 || k.attacker === null || k.attacker === k.victim) continue;
    const from = lastAlive(pack, round, k.attacker, k.tick);
    if (!from) continue;
    out.kills.push({
      from: at(from.x, from.y),
      to,
      team: teamOf(k.attacker),
      headshot: k.headshot,
      age,
      level,
    });
  }

  // An HE is in the timeline as long as the scene draws its smoke; the radar rings its blast.
  const blast = Math.round(HE_BLAST_S * rate);
  for (const e of tl.effectsAt(round, tick)) {
    const life = e.kind === 'he' ? blast : e.endTick - e.startTick;
    if (tick - e.startTick >= life) continue;
    const [x, y] = at(e.x, e.y);
    out.effects.push({
      kind: e.kind,
      x,
      y,
      level: sectionAt(ov, e.z),
      radius: px(RADIUS_U[e.kind]),
      progress: Math.min(
        1,
        Math.max(0, (tick - e.startTick) / Math.max(1, life))
      ),
      age: Math.max(0, (tick - e.startTick) / rate),
      team: e.thrower !== null ? teamOf(e.thrower) || null : null,
    });
  }

  const step = header.tick_step;
  for (const { grenade: g } of tl.projectilesAt(round, tick)) {
    const head = Math.min(
      g.samples - 1,
      Math.max(0, (tick - g.start_tick) / step)
    );
    const k0 = Math.floor(head);
    const k1 = Math.min(g.samples - 1, k0 + 1);
    const f = head - k0;
    const hx = g.x[k0] + (g.x[k1] - g.x[k0]) * f;
    const hy = g.y[k0] + (g.y[k1] - g.y[k0]) * f;
    const hz = g.z[k0] + (g.z[k1] - g.z[k0]) * f;
    const trail: [number, number][] = [];
    const from = Math.max(0, Math.ceil(head - (TRAIL_S * rate) / step));
    for (let k = from; k <= k0; k++) trail.push(at(g.x[k], g.y[k]));
    trail.push(at(hx, hy));
    const team = g.thrower < header.players.length ? teamOf(g.thrower) : 0;
    out.projectiles.push({
      team: team || null,
      level: sectionAt(ov, hz),
      trail,
    });
  }

  out.bomb = bombOf(pack, round, tick, ov, bomb);
  return out;
}

function sitesOf(ov: Overview): RadarSite[] {
  const out: RadarSite[] = [];
  if (ov.bombA)
    out.push({
      label: 'A',
      x: ov.bombA[0] * ov.size,
      y: ov.bombA[1] * ov.size,
    });
  if (ov.bombB)
    out.push({
      label: 'B',
      x: ov.bombB[0] * ov.size,
      y: ov.bombB[1] * ov.size,
    });
  return out;
}

function bombOf(
  pack: Pack,
  round: number,
  tick: number,
  ov: Overview,
  b: ReturnType<ReturnType<typeof timelineFor>['bombAt']>
): RadarBomb | null {
  const rate = pack.header.tick_rate;
  const place = (
    st: RadarBomb['state'],
    p: { x: number; y: number; z: number },
    since: number
  ): RadarBomb => {
    const [x, y] = worldToRadar(p.x, p.y, ov);
    return {
      state: st,
      x,
      y,
      level: sectionAt(ov, p.z),
      blink: st === 'planted' && blinkOn((tick - since) / rate),
      age: Math.max(0, (tick - since) / rate),
    };
  };
  switch (b.kind) {
    case 'none':
      return null;
    case 'carried': {
      const info = pack.header.rounds[round];
      const track = pack.rounds[round]?.players[b.by];
      if (!info || !track) return null;
      const s = playerStateAt(track, info, tick, pack.header, state);
      return place('carried', s, tick);
    }
    case 'dropped':
      return place('dropped', b, b.tick);
    case 'planted':
      return place('planted', b, b.tick);
    case 'exploded':
      return place('exploded', b, b.tick);
    case 'defused': {
      const before = timelineFor(pack).bombAt(round, b.tick - 1);
      return before.kind === 'planted'
        ? place('defused', before, b.tick)
        : null;
    }
  }
}
