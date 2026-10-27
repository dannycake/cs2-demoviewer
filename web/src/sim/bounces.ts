// Where a grenade bounces, read from its track: the pack has no `grenade_bounce`, so a bounce is
// a sample where the grenade's velocity turns sharply. Gravity changes it by 25 u/s a sample
// at 32 Hz and the whole-unit positions by at most ~110, both under the threshold. Pure.

import type { Vec3 } from '../audio/manifest';
import type { Grenade, MatchHeader } from '../pack/types';

/**
 * A bounce changes the velocity by more than `dv` units/s, coming in at more than `minSpeed`
 * units/s (not a grenade at rest, jittering by a unit), and is `gapS` or more after the last
 * (a bounce between two samples turns both).
 */
export const BOUNCE = { dv: 150, minSpeed: 50, gapS: 0.15 };

/**
 * The grenade's bounces in tick order, each where the grenade was at the sample: the samples
 * where the velocity between consecutive samples changes as `BOUNCE` says, before the sample of
 * the detonation (a molotov bursting where it lands, an HE going off, is not a bounce).
 */
export function grenadeBounces(
  g: Grenade,
  header: MatchHeader
): (Vec3 & { tick: number })[] {
  const out: (Vec3 & { tick: number })[] = [];
  const step = header.tick_step;
  const hz = header.tick_rate / step;
  const end =
    g.detonate_tick === null
      ? g.samples
      : Math.min(g.samples, Math.ceil((g.detonate_tick - g.start_tick) / step));
  const gap = BOUNCE.gapS * header.tick_rate;
  let last = -Infinity;
  for (let k = 1; k < end && k + 1 < g.samples; k++) {
    const ix = g.x[k] - g.x[k - 1];
    const iy = g.y[k] - g.y[k - 1];
    const iz = g.z[k] - g.z[k - 1];
    if (Math.hypot(ix, iy, iz) * hz <= BOUNCE.minSpeed) continue;
    const dv =
      Math.hypot(
        g.x[k + 1] - g.x[k] - ix,
        g.y[k + 1] - g.y[k] - iy,
        g.z[k + 1] - g.z[k] - iz
      ) * hz;
    const tick = g.start_tick + k * step;
    if (dv <= BOUNCE.dv || tick - last < gap) continue;
    out.push({ x: g.x[k], y: g.y[k], z: g.z[k], tick });
    last = tick;
  }
  return out;
}
