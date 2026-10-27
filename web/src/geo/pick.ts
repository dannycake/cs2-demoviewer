// Picking under a pointer, in CSS pixels: the nearest of some points within a radius (a
// finger's reach on the 3D view), and what counts as a tap rather than a drag or a hold.
// Imports nothing, so the radar and the scene can both use it.

/**
 * `radiusPx`: how far from a point a tap still picks it. A tap is a press let go within
 * `tapMs` and `tapPx` of where it went down.
 */
export const PICK = Object.freeze({ radiusPx: 40, tapMs: 250, tapPx: 10 });

/** The `index` of the point nearest (x, y) within `radius`, the first of equals; else null. */
export function nearestWithin(
  points: readonly { index: number; x: number; y: number }[],
  x: number,
  y: number,
  radius: number
): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= radius && d < bestD) {
      bestD = d;
      best = p.index;
    }
  }
  return best;
}

/** Whether a press from `down` to `up` (CSS pixels, ms) is a tap: short and nearly still. */
export function isTap(
  down: { x: number; y: number; t: number },
  up: { x: number; y: number; t: number }
): boolean {
  return (
    up.t - down.t <= PICK.tapMs &&
    Math.hypot(up.x - down.x, up.y - down.y) <= PICK.tapPx
  );
}
