// First person: which of the held weapon's viewmodel clips (tools/shrink-viewmodel-clips.mjs:
// `idle`, `draw`, `shoot`, `reload`, the grenades' `pullpin` and throws, the c4's `plant`) the
// arms play at a tick, at what time and weight. Pure in its input: the player's recent actions
// (`ActionIndex.recent`) and the tick, never the previous frame, so scrubbing or seeking
// backwards gives the same pose. No three.js.

import type { Action } from './actions';
import { SPEED_RUN } from './locomotion';
import { familyOf } from './weapons';

/** The clip names a weapon's viewmodel file uses. */
export type ViewmodelClip =
  | 'idle'
  | 'draw'
  | 'shoot'
  | 'shoot_left'
  | 'reload'
  | 'pullpin'
  | 'throw'
  | 'throw_underhand'
  | 'plant';

/** Seconds of each clip the weapon's file has; a clip it lacks is absent. */
export type ClipLengths = Readonly<Partial<Record<ViewmodelClip, number>>>;

/** How long a new clip blends in over the one before, and a finished one out into the idle. */
export const FADE_S = 0.1;
/**
 * How far back the actions are looked at (`ActionIndex.recent`): the longest viewmodel clip
 * (the Negev's and the M249's reloads, 5.7 s) and its fade.
 */
export const LOOKBACK_S = 6;
/** The bob with the stride, up and down, metres. */
export const BOB = 0.006;
/** One bob up and down per this many units walked: a run's stride (0.7 s at 195 u/s). */
export const BOB_UNITS = 136;

/**
 * The bob's phase (`stride`, 0..1) and size (`bobWeight`, 0..1) for a player who has walked
 * `distance` units and moves at `speed` u/s: the phase runs with the distance, so a change of
 * gait does not jump it, and the size grows with the speed, full from SPEED_RUN, so starting
 * and stopping do not snap the gun to the middle. Written into `out` (a caller that runs every
 * frame passes its own, so nothing is allocated).
 */
export function strideBob(
  distance: number,
  speed: number,
  out: { stride: number; bobWeight: number } = { stride: 0, bobWeight: 0 }
): { stride: number; bobWeight: number } {
  const turns = distance / BOB_UNITS;
  out.stride = turns - Math.floor(turns);
  out.bobWeight = Math.min(1, Math.max(0, speed / SPEED_RUN));
  return out;
}

export interface FirstPersonInput {
  /** The weapon held, normalised (`sim/weapons.ts`). */
  weapon: string;
  /** Actions that started in the last LOOKBACK_S up to `tick`, finished or not, newest first. */
  actions: readonly Action[];
  tick: number;
  tickRate: number;
  /** Seconds since the round's start: the idle's clock. */
  clock: number;
  /** The stride's phase, 0 to 1. */
  stride: number;
  /** How much of the bob shows, 0 to 1 (`strideBob`); all of it when left out. */
  bobWeight?: number;
  scoped: boolean;
  alive: boolean;
}

export interface ClipLayer {
  clip: ViewmodelClip;
  /** Seconds into the clip, within its length. */
  time: number;
  weight: number;
}

export interface FirstPersonPose {
  visible: boolean;
  /** Distinct clips, weights summing to 1. */
  layers: ClipLayer[];
  /** Metres up, the walk bob. */
  bob: number;
}

const HIDDEN: FirstPersonPose = { visible: false, layers: [], bob: 0 };

const smooth = (p: number) => p * p * (3 - 2 * p);

/**
 * The clip an action plays on the held weapon, or null: a shot, reload or draw only for the
 * weapon it was made with (a draw is scheduled a sample before the track shows the new
 * weapon), a pin pull or throw only with a grenade out, a plant only with the c4. The Dual
 * Berettas fire the right pistol on even ticks and the left one on odd ones.
 */
export function actionClip(a: Action, weapon: string): ViewmodelClip | null {
  const own = a.data?.weapon === undefined || a.data.weapon === weapon;
  switch (a.kind) {
    case 'shoot':
      if (!own) return null;
      return weapon === 'elite' && a.startTick % 2 === 1
        ? 'shoot_left'
        : 'shoot';
    case 'reload':
      return own ? 'reload' : null;
    case 'draw':
      return own ? 'draw' : null;
    case 'pullpin':
      return familyOf(weapon) === 'grenade' ? 'pullpin' : null;
    case 'throw':
      if (familyOf(weapon) !== 'grenade') return null;
      return a.clip.includes('underhand') ? 'throw_underhand' : 'throw';
    case 'plant':
      return weapon === 'c4' ? 'plant' : null;
    default:
      return null;
  }
}

interface Playing {
  index: number;
  clip: ViewmodelClip;
  /** Seconds since the action started. */
  t: number;
  /** How long the clip plays: its length; a plant also stops when the planting does. */
  end: number;
}

/** The newest action from `from` on that has started and that the weapon has a clip for. */
function newest(
  i: FirstPersonInput,
  lengths: ClipLengths,
  from: number
): Playing | null {
  for (let k = from; k < i.actions.length; k++) {
    const a = i.actions[k];
    const t = (i.tick - a.startTick) / i.tickRate;
    if (t < 0) continue;
    const clip = actionClip(a, i.weapon);
    const len = clip ? lengths[clip] : undefined;
    if (!clip || len === undefined) continue;
    const end =
      clip === 'plant' ? Math.min(len, a.durationTicks / i.tickRate) : len;
    return { index: k, clip, t, end: Math.max(0, end) };
  }
  return null;
}

/** `t` within a looping clip of length `len` (a single pose has length 0). */
function loopTime(t: number, len: number): number {
  return len > 0 ? t - len * Math.floor(t / len) : 0;
}

/**
 * The clips the arms play for `i`, or null when the weapon's file has no `idle` (not loaded,
 * or missing: the caller draws the gun alone). The newest action with a clip plays from its
 * start; it blends in over FADE_S from what played before it (the action before, or the idle),
 * except a draw, which starts below the view; once it ends it holds its last frame and blends
 * into the idle over FADE_S. With no action playing, the idle runs on the round clock.
 */
export function firstPersonPose(
  i: FirstPersonInput,
  lengths: ClipLengths
): FirstPersonPose | null {
  const idleLen = lengths.idle;
  if (idleLen === undefined) return null;
  if (!i.alive || i.scoped) return HIDDEN;
  const bob = BOB * (i.bobWeight ?? 1) * Math.sin(2 * Math.PI * i.stride);
  const idle: ClipLayer = {
    clip: 'idle',
    time: loopTime(i.clock, idleLen),
    weight: 1,
  };
  const cur = newest(i, lengths, 0);
  if (!cur || cur.t >= cur.end + FADE_S)
    return { visible: true, layers: [idle], bob };
  if (cur.t >= cur.end) {
    const k = smooth((cur.t - cur.end) / FADE_S);
    return {
      visible: true,
      layers: [
        { clip: cur.clip, time: cur.end, weight: 1 - k },
        { ...idle, weight: k },
      ],
      bob,
    };
  }
  const layer: ClipLayer = { clip: cur.clip, time: cur.t, weight: 1 };
  if (cur.clip === 'draw' || cur.t >= FADE_S)
    return { visible: true, layers: [layer], bob };
  // Blending in: from the action before it while that still played, else from the idle.
  const prev = newest(i, lengths, cur.index + 1);
  const from: ClipLayer =
    prev && prev.t < prev.end
      ? { clip: prev.clip, time: prev.t, weight: 1 }
      : idle;
  // A clip restarting over itself (a spray) snaps back to its start, as the game's does.
  if (from.clip === cur.clip) return { visible: true, layers: [layer], bob };
  const k = smooth(cur.t / FADE_S);
  return {
    visible: true,
    layers: [
      { ...from, weight: 1 - k },
      { ...layer, weight: k },
    ],
    bob,
  };
}
