// What the viewer says over the scene when a demo cannot be watched the usual way: a map it
// has no world or radar for, or a demo without a single round.

import { MAP_NAMES, mapName } from '../components/hud/models';

export interface Notice {
  title: string;
  text: string;
}

/** `a, b and c`. */
function list(names: readonly string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A match on a map the server has no assets for. */
export function mapNotice(map: string): Notice {
  const supported = Object.values(MAP_NAMES).sort();
  return {
    title: `${mapName(map)} is not supported yet`,
    text: `The 3D view and the radar have ${list(supported)}. The scoreboard, the kill feed and the rounds of this match still work.`,
  };
}

/** A demo that parsed to no rounds at all. */
export function noRoundsNotice(): Notice {
  return {
    title: 'This demo has no rounds',
    text: 'It ends during warmup, or the recording stops before the first round started. Upload the demo of a played match.',
  };
}
