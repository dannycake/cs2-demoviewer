// Small numeric helpers the scene's layers share.

/** `v` clamped to [0, 1]. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
