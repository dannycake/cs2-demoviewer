import { describe, expect, it } from 'vitest';
import type { Action } from '../src/sim/actions';
import {
  actionClip,
  BOB,
  BOB_UNITS,
  FADE_S,
  firstPersonPose,
  LOOKBACK_S,
  strideBob,
  type ClipLengths,
  type FirstPersonInput,
} from '../src/sim/firstperson';
import { SPEED_RUN } from '../src/sim/locomotion';

const RATE = 64;
const T = 10_000;

/** The AK's clip file (seconds, from tools/shrink-viewmodel-clips.mjs): a single-pose idle. */
const AK: ClipLengths = { idle: 0, draw: 1, shoot: 0.77, reload: 2.43 };
const HE: ClipLengths = {
  idle: 1,
  draw: 1,
  pullpin: 0.93,
  throw: 0.47,
  throw_underhand: 0.5,
};
const C4: ClipLengths = { idle: 0, draw: 1.23, plant: 4 };

function act(
  kind: Action['kind'],
  startTick: number,
  o: Partial<Action> = {}
): Action {
  return {
    kind,
    clip: kind,
    startTick,
    durationTicks: 13,
    additive: false,
    upperBody: true,
    ...o,
  };
}

const shot = (tick: number, weapon = 'ak47') =>
  act('shoot', tick, { data: { weapon } });

function at(o: Partial<FirstPersonInput> = {}): FirstPersonInput {
  return {
    weapon: 'ak47',
    actions: [],
    tick: T,
    tickRate: RATE,
    clock: 12.5,
    stride: 0,
    scoped: false,
    alive: true,
    ...o,
  };
}

/** `clip@time×weight` per layer, rounded. */
function layers(i: FirstPersonInput, lengths: ClipLengths = AK): string[] {
  const p = firstPersonPose(i, lengths);
  if (!p) return ['null'];
  return p.layers.map(
    (l) => `${l.clip}@${+l.time.toFixed(3)}×${+l.weight.toFixed(3)}`
  );
}

describe('actionClip', () => {
  it('plays a shot, reload or draw only for the weapon it was made with', () => {
    expect(actionClip(shot(T), 'ak47')).toBe('shoot');
    expect(actionClip(shot(T, 'glock'), 'ak47')).toBeNull();
    expect(
      actionClip(act('reload', T, { data: { weapon: 'ak47' } }), 'ak47')
    ).toBe('reload');
    // A draw is scheduled a sample before the track shows the new weapon.
    expect(
      actionClip(act('draw', T, { data: { weapon: 'm4a1s' } }), 'ak47')
    ).toBeNull();
    expect(
      actionClip(act('draw', T, { data: { weapon: 'm4a1s' } }), 'm4a1s')
    ).toBe('draw');
    // An action without a weapon is the held one's.
    expect(actionClip(act('shoot', T), 'knife')).toBe('shoot');
  });

  it('pulls pins and throws only with a grenade out, plants only with the c4', () => {
    const pin = act('pullpin', T, { clip: 'pullpin_grenade' });
    expect(actionClip(pin, 'hegrenade')).toBe('pullpin');
    expect(actionClip(pin, 'ak47')).toBeNull();
    expect(
      actionClip(
        act('throw', T, { clip: 'throw_overhand_grenade' }),
        'flashbang'
      )
    ).toBe('throw');
    expect(
      actionClip(
        act('throw', T, { clip: 'throw_underhand_grenade' }),
        'molotov'
      )
    ).toBe('throw_underhand');
    expect(
      actionClip(act('throw', T, { clip: 'throw_overhand_grenade' }), 'glock')
    ).toBeNull();
    expect(actionClip(act('plant', T, { clip: 'planting' }), 'c4')).toBe(
      'plant'
    );
    expect(
      actionClip(act('plant', T, { clip: 'planting' }), 'ak47')
    ).toBeNull();
  });

  it('fires the Dual Berettas right on even ticks, left on odd ones; flinches play nothing', () => {
    expect(actionClip(shot(T, 'elite'), 'elite')).toBe('shoot');
    expect(actionClip(shot(T + 1, 'elite'), 'elite')).toBe('shoot_left');
    for (const kind of ['flinch', 'flashed', 'defuse', 'death'] as const)
      expect(actionClip(act(kind, T), 'ak47')).toBeNull();
  });
});

describe('firstPersonPose', () => {
  it('is null without an idle clip (the file is not in): the gun is drawn alone', () => {
    expect(firstPersonPose(at(), {})).toBeNull();
    expect(firstPersonPose(at(), { draw: 1 })).toBeNull();
  });

  it('shows nothing while scoped or dead', () => {
    expect(firstPersonPose(at({ scoped: true }), AK)).toEqual({
      visible: false,
      layers: [],
      bob: 0,
    });
    expect(firstPersonPose(at({ alive: false }), AK)?.visible).toBe(false);
  });

  it('idles on the round clock, looping; a single-pose idle at 0', () => {
    expect(layers(at())).toEqual(['idle@0×1']);
    expect(layers(at({ weapon: 'hegrenade', clock: 12.25 }), HE)).toEqual([
      'idle@0.25×1',
    ]);
    expect(layers(at({ weapon: 'hegrenade', clock: 3 }), HE)).toEqual([
      'idle@0×1',
    ]);
  });

  it('plays the newest action from its start, blending in from the idle over FADE_S', () => {
    const a = [shot(T)];
    expect(layers(at({ actions: a }))).toEqual(['idle@0×1', 'shoot@0×0']);
    const half = layers(at({ actions: a, tick: T + (FADE_S / 2) * RATE }));
    expect(half).toEqual(['idle@0×0.5', `shoot@${FADE_S / 2}×0.5`]);
    expect(layers(at({ actions: a, tick: T + 0.5 * RATE }))).toEqual([
      'shoot@0.5×1',
    ]);
    expect(FADE_S).toBe(0.1);
  });

  it('runs its own length, longer than the action, then holds its end and blends into the idle', () => {
    // The shot action lasts 0.2 s; the AK's clip 0.77 s.
    const a = [shot(T)];
    expect(layers(at({ actions: a, tick: T + 0.7 * RATE }))).toEqual([
      'shoot@0.7×1',
    ]);
    const out = layers(
      at({ actions: a, tick: T + (0.77 + FADE_S / 2) * RATE })
    );
    expect(out).toEqual(['shoot@0.77×0.5', 'idle@0×0.5']);
    expect(
      layers(at({ actions: a, tick: T + (0.77 + FADE_S) * RATE }))
    ).toEqual(['idle@0×1']);
  });

  it('blends a new clip in from the one still playing; a clip restarting over itself snaps', () => {
    // A reload 0.5 s in, then a draw of the same weapon is not a blend (it starts below the view).
    const reload = act('reload', T - 32, { data: { weapon: 'ak47' } });
    const draw = act('draw', T, { data: { weapon: 'ak47' } });
    expect(layers(at({ actions: [draw, reload], tick: T + 2 }))).toEqual([
      'draw@0.031×1',
    ]);
    // A shot over a reload blends from the reload's current time.
    const s = shot(T);
    expect(layers(at({ actions: [s, reload], tick: T + 3.2 }))).toEqual([
      'reload@0.55×0.5',
      'shoot@0.05×0.5',
    ]);
    // A spray: each shot restarts the shot clip.
    expect(
      layers(at({ actions: [shot(T + 6), shot(T)], tick: T + 8 }))
    ).toEqual(['shoot@0.031×1']);
  });

  it('skips actions the weapon has no clip for, and the newest one wins over older ones', () => {
    // The Medi-Shot has no shot clip.
    const hs: ClipLengths = { idle: 0, draw: 1 };
    expect(
      layers(at({ weapon: 'healthshot', actions: [act('shoot', T - 10)] }), hs)
    ).toEqual(['idle@0×1']);
    // An action that has not started yet is not shown.
    expect(layers(at({ actions: [shot(T + 5)] }))).toEqual(['idle@0×1']);
    // A shot with another weapon (before a switch) does not stop the draw.
    const draw = act('draw', T - 20, { data: { weapon: 'ak47' } });
    expect(layers(at({ actions: [shot(T - 10, 'glock'), draw] }))).toEqual([
      'draw@0.313×1',
    ]);
  });

  it('throws: the pin, then the throw blending in over it', () => {
    const pin = act('pullpin', T - 32, {
      clip: 'pullpin_grenade',
      durationTicks: 32,
    });
    const thr = act('throw', T, {
      clip: 'throw_overhand_grenade',
      durationTicks: 29,
    });
    const he = (tick: number) =>
      layers(
        at({
          weapon: 'hegrenade',
          clock: 0,
          actions: tick >= T ? [thr, pin] : [pin],
          tick,
        }),
        HE
      );
    expect(he(T - 16)).toEqual(['pullpin@0.25×1']);
    expect(he(T + 3.2)).toEqual(['pullpin@0.55×0.5', 'throw@0.05×0.5']);
    expect(he(T + 0.3 * RATE)).toEqual(['throw@0.3×1']);
  });

  it('plants until the planting stops', () => {
    const plant = act('plant', T, {
      clip: 'planting',
      upperBody: false,
      durationTicks: 3.2 * RATE,
    });
    const c4 = (tick: number) =>
      layers(at({ weapon: 'c4', actions: [plant], tick }), C4);
    expect(c4(T + 3 * RATE)).toEqual(['plant@3×1']);
    expect(c4(T + 3.25 * RATE)).toEqual(['plant@3.2×0.5', 'idle@0×0.5']);
  });

  it('bobs with the stride', () => {
    expect(firstPersonPose(at({ stride: 0.25 }), AK)!.bob).toBeCloseTo(BOB, 9);
    expect(firstPersonPose(at({ stride: 0.75 }), AK)!.bob).toBeCloseTo(-BOB, 9);
    expect(
      firstPersonPose(at({ stride: 0.25, bobWeight: 0.5 }), AK)!.bob
    ).toBeCloseTo(BOB / 2, 9);
    expect(BOB).toBe(0.006);
  });

  describe('strideBob', () => {
    it('runs the phase with the distance walked, one bob per BOB_UNITS', () => {
      expect(strideBob(0, 250).stride).toBe(0);
      expect(strideBob(BOB_UNITS / 4, 250).stride).toBeCloseTo(0.25, 9);
      expect(strideBob(BOB_UNITS * 3.5, 250).stride).toBeCloseTo(0.5, 9);
    });

    it('fills the object it is given, nothing new per frame', () => {
      const out = { stride: 0, bobWeight: 0 };
      expect(strideBob(BOB_UNITS * 3.5, SPEED_RUN / 2, out)).toBe(out);
      expect(out.stride).toBeCloseTo(0.5, 9);
      expect(out.bobWeight).toBeCloseTo(0.5, 9);
    });

    it('grows the bob with the speed, full from a run, none standing', () => {
      expect(strideBob(1000, 0).bobWeight).toBe(0);
      expect(strideBob(1000, SPEED_RUN / 2).bobWeight).toBeCloseTo(0.5, 9);
      expect(strideBob(1000, 250).bobWeight).toBe(1);
    });

    it('moves the gun a little each frame through starting, stopping and a change of gait', () => {
      // Walking up to a run and stopping, 60 frames a second: the bob in metres never moves
      // more than its speed allows. Snapping the phase to 0 under 20 u/s, or taking it from
      // the walk's or the run's own clip time, moved it up to 2 · BOB at once.
      let d = 0;
      let last: number | null = null;
      let most = 0;
      for (let i = 0; i < 400; i++) {
        const speed =
          i < 300 ? Math.min(250, i * 4) : Math.max(0, 250 - (i - 300) * 10);
        d += speed / 60;
        const { stride, bobWeight } = strideBob(d, speed);
        const bob = BOB * bobWeight * Math.sin(2 * Math.PI * stride);
        if (last !== null) most = Math.max(most, Math.abs(bob - last));
        last = bob;
      }
      // At 250 u/s a bob takes 0.54 s: its fastest is 2π · BOB / 0.54 s, 1.2 mm a frame.
      expect(most).toBeLessThan(0.0015);
    });
  });

  it('depends on the tick alone: scrubbing back gives the same pose', () => {
    const acts = [shot(T + 40), act('reload', T, { data: { weapon: 'ak47' } })];
    const ticks = [T - 10, T + 1, T + 30, T + 41, T + 90, T + 200];
    const forward = ticks.map((tick) =>
      firstPersonPose(at({ actions: acts, tick }), AK)
    );
    const back = [...ticks]
      .reverse()
      .map((tick) => firstPersonPose(at({ actions: acts, tick }), AK));
    expect(back.reverse()).toEqual(forward);
  });

  it('looks back far enough for the longest clip and its fade', () => {
    expect(LOOKBACK_S).toBeGreaterThanOrEqual(5.7 + FADE_S);
  });
});
