// The death view (`sim/deathview.ts`): once the watched player is dead, POV holds where their
// eye was at their last live sample, looking where they looked, whatever the pack holds for
// the dead samples after it.

import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/pack/types';
import { DEATH_VIEW_S, deathView } from '../src/sim/deathview';
import { newPlayerState } from '../src/sim/sample';
import { trackPack } from './helpers/track-pack';

/** trackPack's defaults: 64 ticks/s, a sample every 2 ticks, starting at tick 1000. */
const tickOf = (k: number) => 1000 + 2 * k;

describe('deathView', () => {
  // Player 0 walks along x, turning, crouches on sample 49 and is dead from sample 50 (tick
  // 1100) on, where the pack holds somewhere else entirely; then respawns on sample 150.
  const pack = trackPack({
    players: [
      (k) =>
        k < 50 || k >= 150
          ? {
              x: 10 * k,
              y: 20,
              z: 5,
              yaw: k,
              pitch: -k / 10,
              duck: k === 49 ? 255 : 0,
            }
          : { x: -999, y: 999, yaw: 170, pitch: 80, flags: 0 },
      // Player 1 is dead all round.
      () => ({ x: 0, y: 0, flags: 0 }),
    ],
  });
  const info = pack.header.rounds[0];
  const at = (player: number, tick: number) =>
    deathView(
      pack.rounds[0].players[player],
      info,
      tick,
      pack.header,
      newPlayerState()
    );

  it('is the last live sample once the player is dead: where the eye was and where it looked', () => {
    for (const t of [tickOf(50), tickOf(50) + 0.5, 1150, tickOf(149)]) {
      const v = at(0, t);
      expect(v, String(t)).not.toBeNull();
      expect(v).toMatchObject({
        x: 490,
        y: 20,
        z: 5,
        yaw: 49,
        pitch: -4.9,
        duck: 255,
      });
    }
  });

  it('is null while the player is alive, until the first dead sample, and after a respawn', () => {
    expect(at(0, tickOf(10))).toBeNull();
    expect(at(0, tickOf(49))).toBeNull();
    // Between the last live sample and the first dead one the live state still stands.
    expect(at(0, tickOf(49) + 1.5)).toBeNull();
    expect(at(0, tickOf(150))).toBeNull();
    expect(at(0, tickOf(180))).toBeNull();
  });

  it('is null for a player not alive before the tick', () => {
    expect(at(1, tickOf(100))).toBeNull();
    const late = trackPack({
      players: [(k) => ({ x: k, flags: k >= 20 ? FLAG.alive : 0 })],
    });
    expect(
      deathView(
        late.rounds[0].players[0],
        late.header.rounds[0],
        tickOf(10),
        late.header,
        newPlayerState()
      )
    ).toBeNull();
  });

  it('holds for 2 s', () => {
    expect(DEATH_VIEW_S).toBe(2);
  });

  it('fills the state it is given, nothing new per frame', () => {
    const out = newPlayerState();
    const track = pack.rounds[0].players[0];
    expect(deathView(track, info, 1150, pack.header, out)).toBe(out);
    expect(out).toMatchObject({ x: 490, present: true, speed: 0 });
  });

  it("is the second-last sample for a death on the round's last sample, to the round's end", () => {
    // 200 samples: alive to sample 198, dead on 199, the last.
    const last = trackPack({
      players: [(k) => ({ x: k, yaw: k / 2, flags: k < 199 ? FLAG.alive : 0 })],
    });
    const of = (tick: number) =>
      deathView(
        last.rounds[0].players[0],
        last.header.rounds[0],
        tick,
        last.header,
        newPlayerState()
      );
    expect(of(tickOf(198) + 1)).toBeNull();
    for (const t of [tickOf(199), tickOf(199) + 50])
      expect(of(t)).toMatchObject({ x: 198, yaw: 99 });
  });
});
