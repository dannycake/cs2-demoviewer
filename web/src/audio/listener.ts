// Where the sound is heard from when no camera is drawn (the full radar is up, or the browser
// has no 3D view): the eye of a player, read from the track, looking along their view.

import { eyePoint, viewDir, type Vector3Like } from '../geo/coords';
import type { Pack } from '../pack/types';
import { newPlayerState, playerStateAt } from '../sim/sample';
import type { ListenerPose } from './engine';

const DEG = Math.PI / 180;
const state = newPlayerState();
const v: Vector3Like = { x: 0, y: 0, z: 0 };

/**
 * Player `player`'s eye at `tick` of `round`, into `out`: the eye point (`eyePoint`, scene
 * metres), forward along their view (`viewDir`), and up at right angles to it, tipped back as
 * far as the view is tipped down. False, with `out` left alone, without the round or the
 * player's track, or when the player has no live sample at the tick.
 */
export function eyeListener(
  pack: Pack,
  round: number,
  tick: number,
  player: number,
  out: ListenerPose
): boolean {
  const info = pack.header.rounds[round];
  const track = pack.rounds[round]?.players[player];
  if (!info || !track) return false;
  playerStateAt(track, info, tick, pack.header, state);
  if (!state.present) return false;
  eyePoint(state, v);
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
  viewDir(state.yaw, state.pitch, v);
  out.fx = v.x;
  out.fy = v.y;
  out.fz = v.z;
  // `viewDir` turned a quarter turn up: its derivative by the upward pitch.
  const t = state.yaw * DEG;
  const p = -state.pitch * DEG;
  out.ux = -Math.sin(p) * Math.sin(t);
  out.uy = Math.cos(p);
  out.uz = -Math.sin(p) * Math.cos(t);
  return true;
}
