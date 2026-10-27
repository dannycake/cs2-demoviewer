// The time curves of what a hit or a blast does to the view: the flash whiteout of a blinded
// player and the camera shake of the bomb going off. Pure functions of the tick.

/** A blinded player's view is fully white for this share of the blindness. */
export const WHITEOUT_HOLD = 0.4;

/** The bomb's camera shake: peak offset in metres, rise and total length in seconds. */
export const SHAKE = { amplitude: 0.05, riseS: 0.05, seconds: 0.6 };

/**
 * How white the view of a player blinded over `[startTick, endTick)` is at `tick`: 1 for the
 * first 40 %, then `0.5·(1 + cos(π·u))` over the rest, 0 outside.
 */
export function blindAlpha(
  startTick: number,
  endTick: number,
  tick: number
): number {
  const d = endTick - startTick;
  if (d <= 0 || tick < startTick || tick >= endTick) return 0;
  const u = (tick - startTick) / d;
  if (u <= WHITEOUT_HOLD) return 1;
  return (
    0.5 * (1 + Math.cos((Math.PI * (u - WHITEOUT_HOLD)) / (1 - WHITEOUT_HOLD)))
  );
}

/** The shake's size in metres at `tick` after an explosion at `explodedTick` (null: none). */
export function shakeAt(
  explodedTick: number | null,
  tick: number,
  tickRate: number
): number {
  if (explodedTick === null) return 0;
  const t = (tick - explodedTick) / tickRate;
  if (t < 0 || t >= SHAKE.seconds) return 0;
  if (t < SHAKE.riseS) return (SHAKE.amplitude * t) / SHAKE.riseS;
  const fall = 1 - (t - SHAKE.riseS) / (SHAKE.seconds - SHAKE.riseS);
  return SHAKE.amplitude * fall * fall;
}

/** The camera offset of the shake at `tick`: `shakeAt` long, in a direction set by the tick. */
export function shakeOffset<T extends { x: number; y: number; z: number }>(
  explodedTick: number | null,
  tick: number,
  tickRate: number,
  out: T
): T {
  const a = shakeAt(explodedTick, tick, tickRate);
  const t = explodedTick === null ? 0 : (tick - explodedTick) / tickRate;
  const x = Math.sin(t * 71);
  const y = Math.sin(t * 53 + 1);
  const z = Math.sin(t * 61 + 2);
  const len = Math.hypot(x, y, z) || 1;
  out.x = (a * x) / len;
  out.y = (a * y) / len;
  out.z = (a * z) / len;
  return out;
}
