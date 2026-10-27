// The free camera's pose for the Share button, which writes it into a link made in Free. The 3D
// view hands over how to read its scene's camera while it has one (`setFreePoseSource`); Share
// asks for the pose (`currentFreePose`). The debug global (`window.__demoviewer.camera`) reads
// the same camera for the e2e and the debug HUD, but a shipped feature does not go through it:
// renaming or gating that global must not change what a shared link says.

import type { FreePose } from '../router';

/** The camera drawn last: its pose, its field of view and whether it is Free. */
export interface CameraReading extends Required<FreePose> {
  mode: string;
}

let source: (() => CameraReading) | null = null;

/**
 * Makes `read` (the scene's camera as drawn last) the source of `currentFreePose`, replacing
 * any other. Returns its removal, which leaves a later source in place.
 */
export function setFreePoseSource(read: () => CameraReading): () => void {
  source = read;
  return () => {
    if (source === read) source = null;
  };
}

/**
 * The free camera's pose and field of view as drawn last, or null outside Free or without a
 * scene.
 */
export function currentFreePose(): FreePose | null {
  const c = source?.();
  if (!c || c.mode !== 'free') return null;
  return { x: c.x, y: c.y, z: c.z, yaw: c.yaw, pitch: c.pitch, fov: c.fov };
}
