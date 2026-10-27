// The scoped field of view, from the game's weapon scripts: degrees across a 4:3 screen, the
// game's own measure (`fov` 90 unscoped), which wider screens extend sideways.

/** Each zoom level's field of view, by normalised weapon name (`sim/weapons.ts`). */
const ZOOM: Readonly<Record<string, readonly number[]>> = {
  awp: [40, 10],
  ssg08: [40, 15],
  scar20: [40, 15],
  g3sg1: [40, 15],
  aug: [45],
  sg556: [45],
};

/** The unscoped field of view. */
export const BASE_FOV = 90;

/** The 4:3 field of view of `weapon` at zoom level `zoom` (1 or 2), or null when not scoped. */
export function scopeFov(weapon: string, zoom: number): number | null {
  const levels = ZOOM[weapon];
  if (!levels || zoom < 1) return null;
  return levels[Math.min(zoom, levels.length) - 1];
}

/** The vertical field of view of a 4:3 one, in degrees (three.js cameras take this). */
export function verticalFov(fov43: number): number {
  const half = (fov43 * Math.PI) / 360;
  return (2 * Math.atan(Math.tan(half) * 0.75) * 180) / Math.PI;
}
