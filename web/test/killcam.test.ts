// The kill cam's window and player (`sim/killcam.ts`): five seconds before a death and one
// after, in POV on a living attacker, else in POV on the victim, ending on their death view.

import { describe, expect, it } from 'vitest';
import type { Pack, PackEvent } from '../src/pack/types';
import { DEATH_VIEW_S } from '../src/sim/deathview';
import {
  KILLCAM,
  autoKillcamAt,
  killcamSegment,
  lastDeath,
} from '../src/sim/killcam';
import { timelineFor, type Kill } from '../src/sim/timeline';
import { playbackPack } from './helpers/playback-pack';
import { event } from './helpers/track-pack';

function death(
  tick: number,
  victim: number,
  attacker: number | null,
  weapon = 'ak47'
): PackEvent {
  return event('player_death', tick, {
    user_idx: victim,
    attacker_idx: attacker,
    assister_idx: null,
    weapon,
    headshot: false,
    noscope: false,
    penetrated: 0,
  });
}

/** 64 tick, ten players (0–4 T, 5–9 CT); round 0 freezes until 4900, round 1 until 9900. */
function pack(events: PackEvent[]): Pack {
  return playbackPack({
    rounds: [
      { start: 4000, freeze: 4900, end: 8000, post: 8500 },
      { start: 9000, freeze: 9900, end: 13000, post: 13500 },
    ],
    events,
  });
}

/** The kill of `victim` in `round`. */
function killOf(p: Pack, round: number, victim: number): Kill {
  const k = timelineFor(p)
    .kills(round)
    .find((x) => x.victim === victim);
  if (!k) throw new Error(`no kill of ${victim} in round ${round}`);
  return k;
}

describe('killcamSegment', () => {
  it('is 5 s before the death to 1 s after, from the freeze end at the earliest, in POV on a living attacker', () => {
    expect(KILLCAM).toEqual({ beforeS: 5, afterS: 1 });
    const p = pack([death(5000, 5, 0)]);
    expect(killcamSegment(p, 0, killOf(p, 0, 5))).toEqual({
      round: 0,
      from: 4900,
      to: 5064,
      follow: 0,
      title: 'Kill cam · player1 killed player6',
    });
    // Well after the freeze end: the whole five seconds.
    const later = pack([death(6000, 5, 0)]);
    expect(killcamSegment(later, 0, killOf(later, 0, 5))).toMatchObject({
      from: 6000 - 320,
      to: 6064,
    });
  });

  it('ends at the after-round at the latest', () => {
    const p = pack([death(8480, 5, 0)]);
    expect(killcamSegment(p, 0, killOf(p, 0, 5))).toMatchObject({
      from: 8480 - 320,
      to: 8500,
    });
  });

  it('starts at the death for a death in the freeze time', () => {
    const p = pack([death(4800, 5, null, 'world')]);
    expect(killcamSegment(p, 0, killOf(p, 0, 5))).toMatchObject({
      from: 4800,
      to: 4864,
    });
  });

  it('is POV on the victim, ending on their death view, when the attacker died first (a grenade that killed after its thrower)', () => {
    const p = pack([death(4990, 0, 6), death(5000, 5, 0, 'hegrenade')]);
    expect(killcamSegment(p, 0, killOf(p, 0, 5))).toEqual({
      round: 0,
      from: 4900,
      to: 5064,
      follow: 5,
      title: 'Kill cam · player1 killed player6',
    });
    // A thrower dead before the window starts has no eyes to see it either.
    const fire = pack([death(5500, 0, 6), death(7000, 5, 0, 'inferno')]);
    expect(killcamSegment(fire, 0, killOf(fire, 0, 5))).toMatchObject({
      follow: 5,
    });
    // Nor does one who falls at the same tick (a trade).
    const trade = pack([death(5000, 0, 5), death(5000, 5, 0)]);
    expect(killcamSegment(trade, 0, killOf(trade, 0, 5))).toMatchObject({
      follow: 5,
    });
    // A death after the kill does not matter.
    const after = pack([death(5000, 5, 0), death(5010, 0, 6)]);
    expect(killcamSegment(after, 0, killOf(after, 0, 5))).toMatchObject({
      follow: 0,
    });
  });

  it('is POV on the victim for a world death or a suicide', () => {
    const world = pack([death(5000, 5, null, 'world')]);
    expect(killcamSegment(world, 0, killOf(world, 0, 5))).toEqual({
      round: 0,
      from: 4900,
      to: 5064,
      follow: 5,
      title: 'Kill cam · player6 died',
    });
    const suicide = pack([death(5000, 5, 5, 'hegrenade')]);
    expect(killcamSegment(suicide, 0, killOf(suicide, 0, 5))).toEqual({
      round: 0,
      from: 4900,
      to: 5064,
      follow: 5,
      title: 'Kill cam · player6 died',
    });
  });

  it('plays a team kill through the eyes of the living teammate who did it', () => {
    const p = pack([death(5000, 1, 0)]);
    expect(killcamSegment(p, 0, killOf(p, 0, 1))).toEqual({
      round: 0,
      from: 4900,
      to: 5064,
      follow: 0,
      title: 'Kill cam · player1 killed player2',
    });
  });
});

describe('lastDeath', () => {
  const p = pack([death(5000, 5, 0), death(6000, 6, 0), death(10000, 5, 1)]);

  it("is the player's death at or before the tick in the round", () => {
    expect(lastDeath(p, 0, 5, 5000)).toMatchObject({ tick: 5000, victim: 5 });
    expect(lastDeath(p, 0, 5, 7000)).toMatchObject({ tick: 5000, victim: 5 });
    expect(lastDeath(p, 1, 5, 10000)).toMatchObject({
      tick: 10000,
      victim: 5,
      attacker: 1,
    });
  });

  it('ignores deaths after the tick and deaths in other rounds', () => {
    expect(lastDeath(p, 0, 5, 4999)).toBeNull();
    // Round 1's death at 10000 is not round 0's, whatever the tick.
    expect(lastDeath(p, 0, 5, 20000)).toMatchObject({ tick: 5000 });
    expect(lastDeath(p, 1, 5, 9999)).toBeNull();
    expect(lastDeath(p, 1, 6, 13000)).toBeNull();
    expect(lastDeath(p, 0, 2, 8000)).toBeNull();
  });
});

describe('autoKillcamAt', () => {
  const p = pack([death(5000, 5, 0), death(5050, 6, 0)]);

  it("finds the followed player's death once its hold has passed, in (prevTick, tick]", () => {
    // 2 s at 64 tick: the death view's hold.
    expect(DEATH_VIEW_S * 64).toBe(128);
    expect(autoKillcamAt(p, 0, 5, 5120, 5130)).toMatchObject({
      tick: 5000,
      victim: 5,
    });
    expect(autoKillcamAt(p, 0, 5, 5127, 5128)).toMatchObject({ tick: 5000 });
    expect(autoKillcamAt(p, 0, 5, 5128, 5200)).toBeNull();
    expect(autoKillcamAt(p, 0, 5, 5000, 5127)).toBeNull();
  });

  it('is null with nobody followed, for another player, or in another round', () => {
    expect(autoKillcamAt(p, 0, null, 5120, 5130)).toBeNull();
    expect(autoKillcamAt(p, 0, 7, 5120, 5130)).toBeNull();
    expect(autoKillcamAt(p, 1, 5, 5120, 5130)).toBeNull();
    expect(autoKillcamAt(p, 0, 6, 5170, 5180)).toMatchObject({ victim: 6 });
  });
});
