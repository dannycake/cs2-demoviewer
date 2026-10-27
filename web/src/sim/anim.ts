// Timing of the layered player rig: how long blends take, how an action fades in and out, how
// far a stride carries, and how a death plays out. Pure; the rig (scene/PlayerRig.ts) and the
// frame solver (scene/frame.ts) read these. Values from the phase 3c animation plan.

/** Locomotion changes (walk to run, standing to crouching, landing) blend over this window. */
export const CROSS_FADE_S = 0.15;

/** An upper- or full-body action fades in and out over these, seconds. */
export const ACTION_IN_S = 0.08;
export const ACTION_OUT_S = 0.15;
/** A shot kicks at once and settles quickly. */
export const SHOOT_IN_S = 0.02;
export const SHOOT_OUT_S = 0.1;
/** Arms up over the eyes when flashed, and slowly down as the sight comes back. */
export const FLASH_IN_S = 0.1;
export const FLASH_OUT_S = 0.3;
/** A flinch is an additive jolt. */
export const FLINCH_IN_S = 0.02;
export const FLINCH_OUT_S = 0.12;

/**
 * Units per second at which each gait's clip plays at its own speed. A stride clip's time is
 * the distance travelled divided by this, so feet keep pace with the ground instead of
 * sliding: a player walking at half the speed plays the walk at half the rate. Each is how
 * fast a planted foot moves back in its clip, measured on the models (the median over the
 * frames an ankle is within 1.5 cm of its lowest: run 197 forward and 193 back, walk 109 and
 * 112, crouch 86 and 85); at the earlier 230 and 125 the feet slid forward by a seventh of
 * the body's speed.
 */
export const STRIDE_SPEED = { run: 195, walk: 110, crouch: 85 } as const;

/**
 * A death, in seconds: the body starts to go down at the kill (a CS2 ragdoll goes limp at
 * once), the knees giving and the hit's jolt on top, lies flat at `DEATH_COLLAPSE_S`, lies,
 * then fades. The jolt overlaps the fall; nothing waits for it.
 */
export const DEATH_FLINCH_S = 0.15;
export const DEATH_COLLAPSE_S = 0.5;
export const DEATH_HOLD_S = 6;
export const DEATH_FADE_S = 1.5;
export const DEATH_TOTAL_S = DEATH_COLLAPSE_S + DEATH_HOLD_S + DEATH_FADE_S;
/** The knees are gone this long after the kill. */
const BUCKLE_S = 0.2;
/** A hit turns the model red for this long, fading. */
export const HIT_FLASH_S = 0.25;
/** How far a lying body is lifted so its back rests on the floor, metres. */
export const DEATH_LIFT_M = 0.12;
/** A headshot snaps the head back this far, degrees. */
export const HEAD_SNAP_DEG = 25;

/**
 * 0..1 weight of an action `t` seconds into a play of `duration` seconds: rising over `fadeIn`,
 * falling over the last `fadeOut`, 0 outside the play.
 */
export function envelope(
  t: number,
  duration: number,
  fadeIn: number,
  fadeOut: number
): number {
  if (!(t >= 0) || !(t < duration)) return 0;
  const up = fadeIn > 0 ? Math.min(1, t / fadeIn) : 1;
  const down = fadeOut > 0 ? Math.min(1, (duration - t) / fadeOut) : 1;
  return Math.max(0, Math.min(up, down));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface DeathPhase {
  /** 0..1: blend towards the crouched pose (the knees giving). */
  buckle: number;
  /** 0..1: how far the body has fallen, 1 = lying flat (90°). */
  topple: number;
  /** Metres the body is raised so it lies on the floor rather than in it. */
  lift: number;
  /** 0..1: how far a headshot has snapped the head back. */
  headSnap: number;
  /** 0..1 jolt weight of the hit's flinch. */
  flinch: number;
  opacity: number;
  hidden: boolean;
}

export const LIVING: Readonly<DeathPhase> = Object.freeze({
  buckle: 0,
  topple: 0,
  lift: 0,
  headSnap: 0,
  flinch: 0,
  opacity: 1,
  hidden: false,
});

/**
 * 0..1 strength of the red flash `t` seconds after a hit: 1 at the hit, easing out to 0 at
 * `HIT_FLASH_S` ((1 − u)²), so it is sharp at the hit and gone without lingering.
 */
export function hitFlash(t: number): number {
  if (!(t >= 0) || t >= HIT_FLASH_S) return 0;
  const u = 1 - t / HIT_FLASH_S;
  return u * u;
}

/**
 * The death `t` seconds after it happened. The fall starts with the hit's push and
 * accelerates under gravity (0.3u + 0.7u²), then settles with a small bounce; nothing
 * depends on earlier frames.
 */
export function deathPhase(t: number, headshot = false): DeathPhase {
  if (!(t >= 0)) return { ...LIVING };
  if (t >= DEATH_TOTAL_S)
    return {
      buckle: 1,
      topple: 1,
      lift: DEATH_LIFT_M,
      headSnap: headshot ? 1 : 0,
      flinch: 0,
      opacity: 0,
      hidden: true,
    };
  const fallEnd = DEATH_COLLAPSE_S;
  const u = Math.min(1, t / DEATH_COLLAPSE_S);
  let topple = 0.3 * u + 0.7 * u * u;
  // A 4% bounce in the 0.2 s after landing.
  if (t > fallEnd && t < fallEnd + 0.2)
    topple = 1 - 0.04 * Math.sin((Math.PI * (t - fallEnd)) / 0.2);
  const fadeFrom = fallEnd + DEATH_HOLD_S;
  return {
    buckle: smoothstep(0, BUCKLE_S, t),
    topple,
    lift: DEATH_LIFT_M * Math.min(1, topple),
    headSnap: headshot ? Math.min(1, t / 0.1) : 0,
    flinch: envelope(t, DEATH_FLINCH_S + 0.15, FLINCH_IN_S, 0.15),
    opacity: t < fadeFrom ? 1 : Math.max(0, 1 - (t - fadeFrom) / DEATH_FADE_S),
    hidden: false,
  };
}
