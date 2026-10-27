import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/pack/types';
import {
  directionBlend,
  locomotionBlend,
  locomotionInputAt,
  playerVelocityAt,
  type LocomotionInput,
} from '../src/sim/locomotion';
import { trackPack } from './helpers/track-pack';

const base: LocomotionInput = {
  speed: 0,
  velocityAngle: 0,
  vertical: 0,
  duck: 0,
  flags: FLAG.alive,
  yawRate: 0,
  family: 'rifle',
};
const input = (o: Partial<LocomotionInput>): LocomotionInput => ({
  ...base,
  ...o,
});
const weights = (list: { clip: string; weight: number }[]) =>
  Object.fromEntries(list.map((c) => [c.clip, +c.weight.toFixed(3)]));
const sum = (list: { weight: number }[]) =>
  list.reduce((n, c) => n + c.weight, 0);

describe('directionBlend', () => {
  it('hits one clip on a direction and splits linearly between two', () => {
    const d8 = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    expect(directionBlend(45, d8)).toEqual([{ dir: 'ne', weight: 1 }]);
    expect(directionBlend(22.5, d8)).toEqual([
      { dir: 'n', weight: 0.5 },
      { dir: 'ne', weight: 0.5 },
    ]);
    expect(directionBlend(-90, d8)).toEqual([{ dir: 'w', weight: 1 }]);
    // Across the wrap: 337.5° is halfway from nw to n.
    expect(directionBlend(337.5, d8)).toEqual([
      { dir: 'nw', weight: 0.5 },
      { dir: 'n', weight: 0.5 },
    ]);
  });

  it('works on four-, two- and one-direction sets', () => {
    expect(directionBlend(90, ['n', 'e', 's', 'w'])).toEqual([
      { dir: 'e', weight: 1 },
    ]);
    expect(directionBlend(45, ['n', 'e', 's', 'w'])).toEqual([
      { dir: 'n', weight: 0.5 },
      { dir: 'e', weight: 0.5 },
    ]);
    expect(directionBlend(90, ['n', 's'])).toEqual([
      { dir: 'n', weight: 0.5 },
      { dir: 's', weight: 0.5 },
    ]);
    expect(directionBlend(170, ['n'])).toEqual([{ dir: 'n', weight: 1 }]);
  });
});

describe('locomotionBlend', () => {
  it('runs in eight directions and blends between them', () => {
    expect(
      weights(locomotionBlend(input({ speed: 250, velocityAngle: 45 })))
    ).toEqual({ run_ne_rifle: 1 });
    expect(
      weights(locomotionBlend(input({ speed: 250, velocityAngle: 22.5 })))
    ).toEqual({ run_n_rifle: 0.5, run_ne_rifle: 0.5 });
    expect(
      weights(locomotionBlend(input({ speed: 250, velocityAngle: 180 })))
    ).toEqual({ run_s_rifle: 1 });
  });

  it('walks below the run speed or with the walking flag', () => {
    expect(
      weights(locomotionBlend(input({ speed: 100, velocityAngle: 0 })))
    ).toEqual({ walk_n_rifle: 1 });
    expect(
      weights(
        locomotionBlend(
          input({
            speed: 250,
            velocityAngle: 0,
            flags: FLAG.alive | FLAG.walking,
          })
        )
      )
    ).toEqual({ walk_n_rifle: 1 });
  });

  it("blends stand and crouch sets by the duck amount, with the crouch set's own directions", () => {
    const w = weights(
      locomotionBlend(input({ speed: 250, velocityAngle: 0, duck: 128 }))
    );
    expect(w.run_n_rifle).toBeCloseTo(0.498, 2);
    expect(w.crouch_n_rifle).toBeCloseTo(0.502, 2);
    const w2 = weights(
      locomotionBlend(input({ speed: 250, velocityAngle: 45, duck: 255 }))
    );
    expect(w2).toEqual({ crouch_n_rifle: 0.5, crouch_e_rifle: 0.5 });
    expect(weights(locomotionBlend(input({ speed: 0, duck: 255 })))).toEqual({
      idle_crouch_rifle: 1,
    });
  });

  it("uses each family's own sets, and the pistol set for grenades and the c4", () => {
    expect(
      weights(
        locomotionBlend(
          input({ speed: 250, velocityAngle: 90, family: 'pistol' })
        )
      )
    ).toEqual({ run_e_pistol: 1 });
    expect(
      weights(
        locomotionBlend(
          input({ speed: 100, velocityAngle: 90, family: 'pistol' })
        )
      )
    ).toEqual({ walk_e_pistol: 1 });
    expect(
      weights(
        locomotionBlend(
          input({ speed: 100, velocityAngle: 90, family: 'knife' })
        )
      )
    ).toEqual({ walk_n_knife: 0.5, walk_s_knife: 0.5 });
    expect(
      weights(
        locomotionBlend(
          input({ speed: 250, velocityAngle: 45, family: 'knife' })
        )
      )
    ).toEqual({ run_n_knife: 0.5, run_e_knife: 0.5 });
    expect(
      weights(
        locomotionBlend(
          input({ speed: 250, velocityAngle: 0, family: 'grenade' })
        )
      )
    ).toEqual({ run_n_pistol: 1 });
    expect(weights(locomotionBlend(input({ speed: 0, family: 'c4' })))).toEqual(
      { idle_pistol: 1 }
    );
  });

  it('airborne, ladder and turning in place override the gait', () => {
    expect(
      weights(
        locomotionBlend(
          input({ speed: 250, flags: FLAG.alive | FLAG.airborne })
        )
      )
    ).toEqual({ inair_stand_rifle: 1 });
    expect(
      weights(
        locomotionBlend(
          input({ speed: 250, duck: 200, flags: FLAG.alive | FLAG.airborne })
        )
      )
    ).toEqual({ inair_crouch_stand_rifle: 1 });
    expect(
      weights(
        locomotionBlend(
          input({
            speed: 250,
            flags: FLAG.alive | FLAG.airborne,
            family: 'pistol',
          })
        )
      )
    ).toEqual({ inair_stand_pistol: 1 });
    expect(
      weights(locomotionBlend(input({ speed: 10, vertical: 100 })))
    ).toEqual({ ladder_facing_fast_rifle: 1 });
    expect(
      weights(locomotionBlend(input({ speed: 10, vertical: -100, duck: 200 })))
    ).toEqual({ ladder_facing_crouch_rifle: 1 });
    expect(weights(locomotionBlend(input({ speed: 0, yawRate: 200 })))).toEqual(
      { turn_right_loop_45_rifle: 1 }
    );
    expect(
      weights(locomotionBlend(input({ speed: 0, yawRate: -300 })))
    ).toEqual({ turn_left_loop_90_rifle: 1 });
    expect(weights(locomotionBlend(input({ speed: 0, yawRate: 50 })))).toEqual({
      idle_rifle: 1,
    });
  });

  it('always sums to one', () => {
    for (const o of [
      { speed: 250, velocityAngle: 100, duck: 77 },
      { speed: 60, velocityAngle: -140, duck: 255, family: 'knife' as const },
      { speed: 0, duck: 30 },
      { speed: 300, velocityAngle: 359, family: 'pistol' as const },
    ]) {
      expect(sum(locomotionBlend(input(o)))).toBeCloseTo(1, 6);
    }
  });
});

describe('playerVelocityAt', () => {
  it('reads speed, direction relative to the yaw, vertical speed and yaw rate from the track', () => {
    // 2 ticks per sample at 64 Hz: 1/32 s per sample. Moving +y at 8 units per sample = 256 u/s
    // (world angle 90°) while the yaw turns 1°/sample: at sample 10 the yaw is 10°, so +y is
    // 80° to the left (−80°). Climbing 2 u per sample.
    const pack = trackPack({
      players: [(k) => ({ x: 100, y: k * 8, z: k * 2, yaw: k })],
    });
    const info = pack.header.rounds[0];
    const v = playerVelocityAt(
      pack.rounds[0].players[0],
      info,
      info.start_tick + 20,
      pack.header
    );
    expect(v.speed).toBeCloseTo(256, 3);
    expect(v.velocityAngle).toBeCloseTo(-80, 3);
    expect(v.vertical).toBeCloseTo(64, 3);
    expect(v.yawRate).toBeCloseTo(32, 3);
  });

  it('is one-sided at the round start and zero for a dead or absent player', () => {
    const pack = trackPack({
      players: [(k) => ({ x: k * 4, y: 0, yaw: 0 }), () => ({ flags: 0 })],
    });
    const info = pack.header.rounds[0];
    const v = playerVelocityAt(
      pack.rounds[0].players[0],
      info,
      info.start_tick,
      pack.header
    );
    expect(v.speed).toBeCloseTo(128, 3);
    expect(v.velocityAngle).toBeCloseTo(0, 3);
    expect(
      playerVelocityAt(
        pack.rounds[0].players[1],
        info,
        info.start_tick + 10,
        pack.header
      )
    ).toEqual({ speed: 0, velocityAngle: 0, vertical: 0, yawRate: 0 });
  });

  it('locomotionInputAt bundles the state and the velocity, or null when absent', () => {
    const pack = trackPack({
      players: [
        (k) => ({ x: k * 8, y: 0, yaw: 0, duck: 40 }),
        () => ({ flags: 0 }),
      ],
    });
    const info = pack.header.rounds[0];
    const i = locomotionInputAt(pack, 0, 0, info.start_tick + 20, 'pistol');
    expect(i).toMatchObject({ duck: 40, family: 'pistol', flags: FLAG.alive });
    expect(i!.speed).toBeCloseTo(256, 3);
    expect(i!.velocityAngle).toBeCloseTo(0, 3);
    expect(
      locomotionInputAt(pack, 0, 1, info.start_tick + 20, 'rifle')
    ).toBeNull();
    expect(locomotionInputAt(pack, 3, 0, 0, 'rifle')).toBeNull();
  });
});
