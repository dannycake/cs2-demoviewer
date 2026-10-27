// What the scene derives from the pack it draws, a part of the scene (Scene.ts): the players'
// poses (FrameSolver), the match's timeline of grenades, shots and the bomb, what lies on the
// ground, how the doors and breakables stand, and who killed whom in a round. Each is made once
// per pack, the first time a draw needs it, so a pack the scene is handed again costs nothing;
// the scene makes a new context when the pack changes.

import type { Pack } from '../pack/types';
import { GroundIndex } from '../sim/ground';
import { MapEntityIndex } from '../sim/mapents';
import { timelineFor, type Timeline } from '../sim/timeline';
import { killersOf } from '../sim/follow';
import type { CameraContext } from './cameras';
import { FrameSolver } from './frame';

export class PackContext {
  readonly pack: Pack;
  /** Every player's pose and clips at any tick, made with the context. */
  readonly solver: FrameSolver;
  private groundIndex: GroundIndex | null = null;
  private timelineOf: Timeline | null = null;
  private entityIndex: MapEntityIndex | null = null;
  /** `killerOf` for the POV camera, made once per round. */
  private killers: {
    round: number;
    of: CameraContext['killerOf'];
  } | null = null;

  constructor(pack: Pack) {
    this.pack = pack;
    this.solver = new FrameSolver(pack);
  }

  /** What lies on the ground at any tick, laid out the first time it is asked for. */
  get ground(): GroundIndex {
    return (this.groundIndex ??= new GroundIndex(this.pack));
  }

  /** The grenades, shots, hits and bomb of every round (`timelineFor`). */
  get timeline(): Timeline {
    return (this.timelineOf ??= timelineFor(this.pack));
  }

  /** The poses of the map's doors and breakables at any tick. */
  get entities(): MapEntityIndex {
    return (this.entityIndex ??= new MapEntityIndex(this.pack));
  }

  /** `CameraContext.killerOf` for round index `round` (`killersOf`), kept for that round. */
  killerOf(round: number): CameraContext['killerOf'] {
    let k = this.killers;
    if (!k || k.round !== round) {
      k = { round, of: killersOf(this.pack, round) };
      this.killers = k;
    }
    return k.of;
  }
}
