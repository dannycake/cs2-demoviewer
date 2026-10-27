// The death view, as CS2's death cam: once the player POV shows is dead, the camera stays
// where their eye was at their last live sample, looking where they looked, for
// `DEATH_VIEW_S`. Then it cuts away (to the killer, else the nearest living teammate, or to the
// director's next pick), unless the user picked that player, who is held on to the end of the
// round. A function of the tick, so a scrub lands on the view that playing to it gives. It runs
// every frame POV shows a dead player, so it allocates nothing.

import {
  FLAG,
  type MatchHeader,
  type PlayerTrack,
  type RoundInfo,
} from '../pack/types';
import { sampleAt, sampleIndex, type PlayerState } from './sample';

/** Seconds the camera holds a dead player's death view before cutting away. */
export const DEATH_VIEW_S = 2;

/** `sampleIndex`'s answer, reused. */
const at = { k: 0, f: 0 };

function live(track: PlayerTrack, k: number): boolean {
  return (track.flags[k] & FLAG.alive) !== 0;
}

/**
 * `out` ← `track`'s last live sample before `tick` of `round`, when the player is dead at
 * `tick` after being alive earlier in the round: where their death view is (`present` true,
 * `speed` 0). Null while they are alive at `tick` (`present`, the interval into the first dead
 * sample included), and when they were never alive before it.
 */
export function deathView(
  track: PlayerTrack,
  round: RoundInfo,
  tick: number,
  header: MatchHeader,
  out: PlayerState
): PlayerState | null {
  if (round.samples === 0) return null;
  const { k, f } = sampleIndex(round, tick, header.tick_step, at);
  if (live(track, k) || (f > 0 && live(track, k + 1))) return null;
  for (let j = k - 1; j >= 0; j--)
    if (live(track, j)) {
      sampleAt(track, j, out);
      out.present = true;
      out.speed = 0;
      return out;
    }
  return null;
}
