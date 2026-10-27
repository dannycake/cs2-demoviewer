// The Web Audio engine (`audio/engine.ts`) against a context that records what it is asked
// (`helpers/fake-audio.ts`): nothing before the first gesture, nor while the context does not
// run; each layer a source into its gain (the layer's volume, CS2's curve at the distance) and an
// HRTF panner where the sound is; at most 32 voices, the quietest dropped first; loops as state;
// the master's volume and mute; the gestures that unlock it, and the low preset's sample rate.

import { describe, expect, it, vi } from 'vitest';
import {
  contextFor,
  FADE_S,
  GESTURES,
  listenForGestures,
  LOW_SAMPLE_RATE,
  MAX_VOICES,
  MIN_GAIN,
  SoundEngine,
  type ListenerPose,
} from '../src/audio/engine';
import {
  curveGain,
  pickClip,
  seeded,
  type SoundEntry,
  type SoundLayer,
} from '../src/audio/manifest';
import { toScene, UNIT } from '../src/geo/coords';
import type { Quality } from '../src/scene/quality';
import {
  FakeAudioContext,
  fakeBuffer,
  type FakeContextOptions,
  type FakeSource,
} from './helpers/fake-audio';

const layer = (l: Partial<SoundLayer>): SoundLayer => ({
  clips: [[0, 1]],
  volume: 1,
  volumeRandom: [0, 0],
  pitch: 1,
  pitchRandom: [0, 0],
  curve: null,
  offset: [0, 0, 0],
  loop: false,
  ...l,
});

/** `shot:ak47` as the manifest has it: three close variants; a distant layer silent to 800 u. */
const AK_CLOSE = layer({
  clips: [
    [0, 1.9429],
    [1.9929, 2.1562],
    [4.1992, 2.1233],
  ],
  volume: 1.1,
  curve: [
    [25, 0.8],
    [30, 1],
    [175.7143, 1],
    [440, 0.7353],
    [1288, 0.3309],
    [2500, 0.0147],
  ],
  offset: [0, 0, 60],
});
const AK_DISTANT = layer({
  clips: [[6.3724, 3.8978]],
  volume: 0.5,
  pitchRandom: [-0.02, 0.02],
  curve: [
    [800, 0],
    [2335.8369, 0.5404],
    [2868.5715, 0.0956],
  ],
  offset: [0, 0, 60],
});
const AK: SoundEntry = { bank: 'weapon_ak47', layers: [AK_CLOSE, AK_DISTANT] };

/** A footstep: silent past 1,100 units. */
const STEP: SoundEntry = {
  bank: 'steps_concrete',
  layers: [
    layer({
      clips: [
        [0, 0.3],
        [0.35, 0.3],
      ],
      volume: 0.5,
      curve: [
        [0, 1],
        [1100, 0],
      ],
      offset: [0, 0, 20],
    }),
  ],
};

/** `round:beep`: heard the same everywhere (played with no position). */
const BEEP: SoundEntry = {
  bank: 'round',
  layers: [
    layer({
      volume: 0.2,
      curve: [
        [0, 1],
        [148.2857, 1],
        [300, 1],
      ],
    }),
  ],
};

/** `fire:loop`: a burning fire, 0.3 at its heart to nothing at 1,200 units. */
const FIRE_LAYER = layer({
  clips: [[59.1669, 4.5463]],
  volume: 0.3,
  curve: [
    [0, 1],
    [1200, 0],
  ],
  loop: true,
});
const FIRE: SoundEntry = { bank: 'grenade_fire', layers: [FIRE_LAYER] };

/** Full at the source, nothing at 3,200 units: a voice's loudness is 1 − d/3200. */
const RAMP: SoundEntry = {
  bank: 'ramp',
  layers: [
    layer({
      curve: [
        [0, 1],
        [3200, 0],
      ],
    }),
  ],
};

const BUFFER = fakeBuffer(70);

/** The listener at the scene's origin, looking down Source +X (scene +Z), head up. */
const AHEAD: ListenerPose = {
  x: 0,
  y: 0,
  z: 0,
  fx: 0,
  fy: 0,
  fz: 1,
  ux: 0,
  uy: 1,
  uz: 0,
};

/** `units` ahead of `AHEAD`, Source units, lifted so that `offset` brings it to eye level. */
const ahead = (units: number, lift = 0) => ({ x: units, y: 0, z: -lift });

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(options?: FakeContextOptions) {
  const ctx = new FakeAudioContext(options);
  const create = vi.fn(() => ctx);
  const engine = new SoundEngine(create);
  return { ctx, create, engine };
}

function unlocked(options?: { legacyListener?: boolean }) {
  const s = setup(options);
  s.engine.unlock();
  s.engine.setListener(AHEAD);
  return s;
}

describe('SoundEngine before the first gesture', () => {
  it('makes no context; play returns false and setLoop starts nothing', async () => {
    const { create, engine } = setup();
    engine.setListener(AHEAD);
    engine.setVolume(0.5, false);
    expect(engine.play(AK, BUFFER, ahead(300, 60), 7)).toBe(false);
    engine.setLoop('fire', FIRE, BUFFER, ahead(100));
    engine.stopAll();
    expect(create).not.toHaveBeenCalled();
    expect(engine.unlocked).toBe(false);
    expect(engine.canDecode).toBe(false);
    expect(engine.voices).toBe(0);
    await expect(engine.decode(new ArrayBuffer(8))).rejects.toThrow(
      'sound is locked until a click or key'
    );
  });

  it('unlock makes one context, master → compressor → destination, and resumes it', () => {
    const { ctx, create, engine } = setup();
    engine.unlock();
    expect(create).toHaveBeenCalledTimes(1);
    expect(engine.unlocked).toBe(true);
    expect(ctx.path(ctx.master())).toEqual([
      'gain',
      'compressor',
      'destination',
    ]);
    expect(ctx.resumes).toBe(1);
    // Later gestures: the same context, resumed only if something suspended it.
    engine.unlock();
    expect(ctx.resumes).toBe(1);
    ctx.state = 'suspended';
    engine.unlock();
    expect(create).toHaveBeenCalledTimes(1);
    expect(ctx.resumes).toBe(2);
  });

  it('a browser without Web Audio: one warning, still locked, never tried again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi.fn((): FakeAudioContext => {
      throw new Error('AudioContext is not defined');
    });
    const engine = new SoundEngine(create);
    engine.unlock();
    engine.unlock();
    expect(create).toHaveBeenCalledTimes(1);
    expect(engine.unlocked).toBe(false);
    expect(engine.play(BEEP, BUFFER, null, 1)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^sounds: no Web Audio/);
  });

  it('decodes through the context once unlocked', async () => {
    const { ctx, engine } = unlocked();
    const buffer = fakeBuffer(3, 'decoded');
    const data = new ArrayBuffer(4);
    const seen: ArrayBuffer[] = [];
    ctx.decodeResult = (d) => {
      seen.push(d);
      return Promise.resolve(buffer);
    };
    await expect(engine.decode(data)).resolves.toBe(buffer);
    expect(seen).toEqual([data]);
  });
});

describe('SoundEngine in a context that does not run', () => {
  it('a press the browser does not count leaves it suspended: banks decode, but play and setLoop start nothing and make no node', async () => {
    const { ctx, engine } = setup({ resumeAs: 'suspended' });
    engine.unlock();
    engine.setListener(AHEAD);
    expect(ctx.state).toBe('suspended');
    expect(engine.unlocked).toBe(false);
    expect(engine.canDecode).toBe(true);
    // The master chain only.
    const chain = ctx.nodes.length;
    expect(engine.play(AK, BUFFER, ahead(300, 60), 7)).toBe(false);
    expect(engine.play(BEEP, BUFFER, null, 1)).toBe(false);
    engine.setLoop('fire', FIRE, BUFFER, ahead(100));
    expect(ctx.nodes).toHaveLength(chain);
    expect(engine.voices).toBe(0);
    const buffer = fakeBuffer(2, 'decoded');
    ctx.decodeResult = () => Promise.resolve(buffer);
    await expect(engine.decode(new ArrayBuffer(4))).resolves.toBe(buffer);
  });

  it('each gesture resumes it until one runs it; from then on cues play, and none missed plays late', () => {
    const { ctx, engine } = setup({ resumeAs: 'suspended' });
    // A finger's pointerdown, then Esc: neither counts.
    engine.unlock();
    engine.setListener(AHEAD);
    engine.unlock();
    expect(ctx.resumes).toBe(2);
    expect(engine.play(BEEP, BUFFER, null, 1)).toBe(false);
    // The finger's pointerup does.
    ctx.resumeAs = 'running';
    engine.unlock();
    expect(ctx.resumes).toBe(3);
    expect(engine.unlocked).toBe(true);
    expect(ctx.sources()).toEqual([]);
    expect(engine.play(BEEP, BUFFER, null, 2)).toBe(true);
    engine.setLoop('fire', FIRE, BUFFER, ahead(100));
    expect(ctx.sources()).toHaveLength(2);
    expect(engine.voices).toBe(2);
    // Running: a gesture resumes nothing.
    engine.unlock();
    expect(ctx.resumes).toBe(3);
  });

  it('a resume the browser rejects is caught, and the next gesture tries again', async () => {
    const { ctx, engine } = setup({ resumeAs: 'rejected' });
    engine.unlock();
    await settle();
    expect(engine.unlocked).toBe(false);
    expect(engine.play(BEEP, BUFFER, null, 1)).toBe(false);
    ctx.resumeAs = 'running';
    engine.unlock();
    expect(ctx.resumes).toBe(2);
    expect(engine.unlocked).toBe(true);
    expect(engine.play(BEEP, BUFFER, null, 2)).toBe(true);
  });

  it('a context that stops running (a phone call) starts nothing until a gesture runs it again', () => {
    const { ctx, engine } = unlocked();
    expect(engine.play(BEEP, BUFFER, null, 1)).toBe(true);
    ctx.state = 'interrupted';
    expect(engine.unlocked).toBe(false);
    const made = ctx.nodes.length;
    expect(engine.play(BEEP, BUFFER, null, 2)).toBe(false);
    engine.setLoop('fire', FIRE, BUFFER, ahead(100));
    expect(ctx.nodes).toHaveLength(made);
    // What was playing is the context's to hold and carry on with.
    expect(engine.voices).toBe(1);
    engine.unlock();
    expect(engine.unlocked).toBe(true);
    expect(engine.play(BEEP, BUFFER, null, 3)).toBe(true);
  });
});

describe('listenForGestures', () => {
  it('unlocks on each press that may start audio, a finger’s pointerup, touchend and click among them, until let go', () => {
    expect([...GESTURES].sort()).toEqual([
      'click',
      'keydown',
      'pointerdown',
      'pointerup',
      'touchend',
    ]);
    const target = new EventTarget();
    let unlocks = 0;
    const stop = listenForGestures(target, () => unlocks++);
    for (const type of GESTURES) target.dispatchEvent(new Event(type));
    expect(unlocks).toBe(GESTURES.length);
    target.dispatchEvent(new Event('pointermove'));
    expect(unlocks).toBe(GESTURES.length);
    stop();
    for (const type of GESTURES) target.dispatchEvent(new Event(type));
    expect(unlocks).toBe(GESTURES.length);
  });
});

describe('contextFor', () => {
  it(`asks for ${LOW_SAMPLE_RATE} Hz on the low preset, and for no rate on the others`, () => {
    const low = contextFor('low', FakeAudioContext) as FakeAudioContext;
    expect(LOW_SAMPLE_RATE).toBe(24000);
    expect(low.options).toEqual({ sampleRate: 24000 });
    expect(low.sampleRate).toBe(24000);
    for (const q of ['medium', 'high'] as const) {
      const ctx = contextFor(q, FakeAudioContext) as FakeAudioContext;
      expect(ctx.options).toEqual({});
      expect(ctx.sampleRate).toBe(48000);
    }
  });

  it('a browser that refuses the rate gets a context at its own', () => {
    const asked: (number | undefined)[] = [];
    class Picky extends FakeAudioContext {
      constructor(options: FakeContextOptions = {}) {
        asked.push(options.sampleRate);
        if (options.sampleRate !== undefined)
          throw new Error(
            'NotSupportedError: the sample rate is not supported'
          );
        super(options);
      }
    }
    const ctx = contextFor('low', Picky) as FakeAudioContext;
    expect(asked).toEqual([24000, undefined]);
    expect(ctx.sampleRate).toBe(48000);
  });

  it('the engine makes its context at the first gesture, at the preset of that moment', () => {
    let quality: Quality = 'medium';
    const made: FakeAudioContext[] = [];
    const engine = new SoundEngine(() => {
      const ctx = contextFor(quality, FakeAudioContext) as FakeAudioContext;
      made.push(ctx);
      return ctx;
    });
    // A phone's preset is set after the engine is made (`deviceQuality`), before any tap.
    quality = 'low';
    engine.unlock();
    expect(made.map((c) => c.sampleRate)).toEqual([24000]);
  });
});

describe('SoundEngine.play', () => {
  it('an AK 300 units ahead: its close layer at volume × curve, through an HRTF panner at the gun', () => {
    const { ctx, engine } = unlocked();
    ctx.currentTime = 2;
    const seed = 12345;
    expect(engine.play(AK, BUFFER, ahead(300, 60), seed)).toBe(true);
    // The distant layer is silent under 800 units (its curve's first gain is 0): not started.
    const [close, ...rest] = ctx.sources();
    expect(rest).toHaveLength(0);
    const clip = pickClip(AK_CLOSE, seed);
    expect(close.buffer).toBe(BUFFER);
    expect(close.loop).toBe(false);
    expect(close.starts).toEqual([[2, clip[0], clip[1]]]);
    expect(close.playbackRate.value).toBe(1);
    expect(ctx.gainOf(close).gain.value).toBeCloseTo(
      1.1 * curveGain(AK_CLOSE.curve, 300),
      9
    );
    const panner = ctx.pannerOf(close)!;
    expect(panner.panningModel).toBe('HRTF');
    expect(panner.distanceModel).toBe('linear');
    expect(panner.rolloffFactor).toBe(0);
    // At the shot's origin plus the layer's offset: (300, 0, −60) + (0, 0, 60).
    const at = toScene(300, 0, 0);
    expect(panner.positionX.value).toBeCloseTo(at.x, 9);
    expect(panner.positionY.value).toBeCloseTo(at.y, 9);
    expect(panner.positionZ.value).toBeCloseTo(at.z, 9);
    expect(ctx.path(close)).toEqual([
      'source',
      'gain',
      'panner',
      'gain',
      'compressor',
      'destination',
    ]);
    expect(engine.voices).toBe(1);
  });

  it('an AK 1,500 units ahead: both layers, each at its own gain and the distant one at its pitch spread', () => {
    const { ctx, engine } = unlocked();
    const seed = 99;
    expect(engine.play(AK, BUFFER, ahead(1500, 60), seed)).toBe(true);
    const [close, distant] = ctx.sources();
    expect(ctx.sources()).toHaveLength(2);
    expect(ctx.gainOf(close).gain.value).toBeCloseTo(
      1.1 * curveGain(AK_CLOSE.curve, 1500),
      9
    );
    expect(ctx.gainOf(distant).gain.value).toBeCloseTo(
      0.5 * curveGain(AK_DISTANT.curve, 1500),
      9
    );
    expect(distant.starts).toEqual([[0, 6.3724, 3.8978]]);
    // Layer 1's pitch is draw 2·1 + 2 of the seed, apart from the clip's (draw 0).
    expect(distant.playbackRate.value).toBeCloseTo(
      1 - 0.02 + 0.04 * seeded(seed, 4),
      12
    );
    expect(ctx.pannerOf(close)).not.toBe(ctx.pannerOf(distant));
    // One sound, one voice, however many layers.
    expect(engine.voices).toBe(1);
  });

  it('draws the volume and pitch spread from the seed (draws 1 + 2i, 2 + 2i), apart from the clip', () => {
    const spread = layer({
      clips: [
        [0, 1],
        [2, 1],
        [4, 1],
      ],
      volume: 0.8,
      volumeRandom: [-0.2, 0.2],
      pitch: 1,
      pitchRandom: [-0.1, 0.1],
    });
    const entry: SoundEntry = { bank: 'b', layers: [spread, spread] };
    for (const seed of [1, 2, 3, 1000, 4294967295]) {
      const { ctx, engine } = unlocked();
      expect(engine.play(entry, BUFFER, null, seed)).toBe(true);
      ctx.sources().forEach((s, i) => {
        const clip = pickClip(spread, seed);
        expect(s.starts).toEqual([[0, clip[0], clip[1]]]);
        expect(ctx.gainOf(s).gain.value).toBeCloseTo(
          0.8 - 0.2 + 0.4 * seeded(seed, 1 + 2 * i),
          12
        );
        expect(s.playbackRate.value).toBeCloseTo(
          1 - 0.1 + 0.2 * seeded(seed, 2 + 2 * i),
          12
        );
      });
    }
  });

  it('a sound beyond every layer’s curve starts nothing', () => {
    const { ctx, engine } = unlocked();
    const before = ctx.nodes.length;
    expect(engine.play(STEP, BUFFER, ahead(1200, 20), 3)).toBe(false);
    expect(ctx.nodes).toHaveLength(before);
    expect(engine.voices).toBe(0);
    // Just inside: 0.5 × (1 − 1095/1100) = 0.0023 is still under MIN_GAIN.
    expect(0.5 * curveGain(STEP.layers[0].curve, 1095)).toBeLessThan(MIN_GAIN);
    expect(engine.play(STEP, BUFFER, ahead(1095, 20), 3)).toBe(false);
    expect(engine.play(STEP, BUFFER, ahead(1000, 20), 3)).toBe(true);
  });

  it('a sound with no position has no panner and takes its curve’s first gain', () => {
    const { ctx, engine } = unlocked();
    expect(engine.play(BEEP, BUFFER, null, 5)).toBe(true);
    const [beep] = ctx.sources();
    expect(ctx.panners()).toHaveLength(0);
    expect(ctx.path(beep)).toEqual([
      'source',
      'gain',
      'gain',
      'compressor',
      'destination',
    ]);
    expect(ctx.gainOf(beep).gain.value).toBeCloseTo(0.2, 12);
  });

  it('a voice that ends frees its place and lets go of its nodes', () => {
    const { ctx, engine } = unlocked();
    engine.play(AK, BUFFER, ahead(1500, 60), 1);
    expect(engine.voices).toBe(1);
    const [close, distant] = ctx.sources();
    const gains = [ctx.gainOf(close), ctx.gainOf(distant)];
    close.end();
    expect(engine.voices).toBe(1);
    distant.end();
    expect(engine.voices).toBe(0);
    for (const n of [close, distant, ...gains, ...ctx.panners()])
      expect(n.disconnected).toBe(true);
    expect(ctx.master().disconnected).toBe(false);
  });
});

describe('SoundEngine voice cap', () => {
  /** 32 voices at 50·k units, k = 0…31: loudness 1 − 50k/3200, the quietest 0.516 (k = 31). */
  function full() {
    const s = unlocked();
    for (let k = 0; k < MAX_VOICES; k++)
      expect(s.engine.play(RAMP, BUFFER, ahead(50 * k), k)).toBe(true);
    expect(s.engine.voices).toBe(MAX_VOICES);
    return s;
  }

  it('a quieter 33rd voice returns false and starts nothing', () => {
    const { ctx, engine } = full();
    const before = ctx.nodes.length;
    expect(engine.play(RAMP, BUFFER, ahead(1600), 99)).toBe(false);
    expect(ctx.nodes).toHaveLength(before);
    expect(engine.voices).toBe(MAX_VOICES);
    expect(ctx.sources().every((s) => s.stops.length === 0)).toBe(true);
  });

  it('a louder 33rd voice fades the quietest out over FADE_S and takes its place', () => {
    const { ctx, engine } = full();
    ctx.currentTime = 1;
    const quietest = ctx.sources()[MAX_VOICES - 1];
    expect(engine.play(RAMP, BUFFER, ahead(0), 99)).toBe(true);
    expect(engine.voices).toBe(MAX_VOICES);
    expect(quietest.stops).toEqual([1 + FADE_S]);
    const gain = ctx.gainOf(quietest).gain;
    expect(gain.events.slice(-3)).toEqual([
      { kind: 'cancel', value: expect.any(Number), time: 1 },
      { kind: 'set', value: expect.closeTo(1 - 1550 / 3200, 9), time: 1 },
      { kind: 'ramp', value: 0, time: 1 + FADE_S },
    ]);
    const others = ctx.sources().filter((s) => s !== quietest);
    expect(others.every((s) => s.stops.length === 0)).toBe(true);
    // Its end, when it comes, does not free a second place.
    quietest.end();
    expect(engine.voices).toBe(MAX_VOICES);
  });

  it('a crowd of 300 sounds keeps at most 32 voices, always the loudest', () => {
    const { ctx, engine } = unlocked();
    const levels = new Map<FakeSource, number>();
    for (let i = 0; i < 300; i++) {
      const units = Math.floor(seeded(77, i) * 3000);
      const started = engine.play(RAMP, BUFFER, ahead(units), i);
      if (started) levels.set(ctx.sources().at(-1)!, 1 - units / 3200);
      expect(engine.voices).toBeLessThanOrEqual(MAX_VOICES);
    }
    const sounding = [...levels]
      .filter(([s]) => s.stops.length === 0)
      .map(([, l]) => l)
      .sort((a, b) => b - a);
    expect(sounding).toHaveLength(MAX_VOICES);
    // Every voice dropped was no louder than every voice kept.
    const dropped = [...levels]
      .filter(([s]) => s.stops.length > 0)
      .map(([, l]) => l);
    expect(Math.max(...dropped)).toBeLessThanOrEqual(sounding.at(-1)!);
  });

  it('loops share the cap: a quieter one does not start, a louder one takes the quietest place', () => {
    // 32 voices at 2,969–3,000 units: loudness 0.0625–0.0722.
    const { ctx, engine } = unlocked();
    for (let k = 0; k < MAX_VOICES; k++)
      engine.play(RAMP, BUFFER, ahead(3000 - k), k);
    const quietest = ctx.sources()[0];
    // 0.3 × (1 − 1150/1200) = 0.0125: quieter than all of them.
    engine.setLoop('far', FIRE, BUFFER, ahead(1150));
    expect(ctx.sources()).toHaveLength(MAX_VOICES);
    // At the fire's heart (0.3) it is louder: the quietest voice makes room.
    engine.setLoop('near', FIRE, BUFFER, ahead(0));
    expect(engine.voices).toBe(MAX_VOICES);
    expect(quietest.stops).toHaveLength(1);
    const fire = ctx.sources().at(-1)!;
    expect(fire.loop).toBe(true);
    // 1,100 units away the fire is the quietest voice (0.025): a louder sound drops it.
    engine.setListener({ ...AHEAD, z: -1100 * UNIT });
    expect(engine.play(RAMP, BUFFER, ahead(0), 500)).toBe(true);
    expect(fire.stops).toHaveLength(1);
    expect(engine.voices).toBe(MAX_VOICES);
  });
});

describe('SoundEngine master, loops and the listener', () => {
  it('the master gain: the volume, 0 when muted, clamped, and kept from before unlock', () => {
    const { ctx, engine } = setup();
    engine.setVolume(0.6, false);
    engine.unlock();
    expect(ctx.master().gain.value).toBeCloseTo(0.6, 12);
    engine.setVolume(0.6, true);
    expect(ctx.master().gain.value).toBe(0);
    engine.setVolume(1.7, false);
    expect(ctx.master().gain.value).toBe(1);
    engine.setVolume(-1, false);
    expect(ctx.master().gain.value).toBe(0);
    // The same setting again schedules nothing more.
    const n = ctx.master().gain.events.length;
    engine.setVolume(-1, false);
    engine.setVolume(0.3, true);
    expect(ctx.master().gain.events).toHaveLength(n);
  });

  it('setLoop twice with one id starts one looping source; keepLoops without it fades it out', () => {
    const { ctx, engine } = unlocked();
    ctx.currentTime = 3;
    engine.setLoop('fire:1', FIRE, BUFFER, ahead(600));
    engine.setLoop('fire:1', FIRE, BUFFER, ahead(600));
    const [fire, ...rest] = ctx.sources();
    expect(rest).toHaveLength(0);
    expect(fire.loop).toBe(true);
    expect(fire.loopStart).toBe(59.1669);
    expect(fire.loopEnd).toBeCloseTo(59.1669 + 4.5463, 9);
    expect(fire.starts).toEqual([[3, 59.1669, undefined]]);
    expect(ctx.gainOf(fire).gain.value).toBeCloseTo(0.3 * (1 - 600 / 1200), 9);
    expect(engine.voices).toBe(1);
    engine.keepLoops(new Set(['fire:1']));
    expect(fire.stops).toEqual([]);
    engine.keepLoops(new Set());
    expect(fire.stops).toEqual([3 + FADE_S]);
    expect(ctx.gainOf(fire).gain.events.at(-1)).toEqual({
      kind: 'ramp',
      value: 0,
      time: 3 + FADE_S,
    });
    expect(engine.voices).toBe(0);
    // Asked for again, it starts again.
    engine.setLoop('fire:1', FIRE, BUFFER, ahead(600));
    expect(ctx.sources()).toHaveLength(2);
  });

  it('a loop’s gain follows the listener', () => {
    const { ctx, engine } = unlocked();
    engine.setLoop('fire', FIRE, BUFFER, ahead(600));
    const gain = ctx.gainOf(ctx.sources()[0]).gain;
    expect(gain.value).toBeCloseTo(0.15, 9);
    // 300 units nearer.
    engine.setListener({ ...AHEAD, z: 300 * UNIT });
    expect(gain.value).toBeCloseTo(0.3 * (1 - 300 / 1200), 9);
    expect(gain.events.at(-1)?.kind).toBe('target');
  });

  it('a loop too far to hear starts once the listener comes near', () => {
    const { ctx, engine } = unlocked();
    engine.setLoop('fire', FIRE, BUFFER, ahead(1300));
    expect(ctx.sources()).toHaveLength(0);
    engine.setListener({ ...AHEAD, z: 400 * UNIT });
    engine.setLoop('fire', FIRE, BUFFER, ahead(1300));
    expect(ctx.sources()).toHaveLength(1);
    expect(ctx.gainOf(ctx.sources()[0]).gain.value).toBeCloseTo(0.075, 9);
  });

  it('stopAll fades every voice and loop out over FADE_S', () => {
    const { ctx, engine } = unlocked();
    engine.play(AK, BUFFER, ahead(1500, 60), 1);
    engine.play(BEEP, BUFFER, null, 2);
    engine.setLoop('fire', FIRE, BUFFER, ahead(100));
    ctx.currentTime = 5;
    engine.stopAll();
    expect(engine.voices).toBe(0);
    for (const s of ctx.sources()) {
      expect(s.stops).toEqual([5 + FADE_S]);
      expect(ctx.gainOf(s).gain.events.at(-1)).toEqual({
        kind: 'ramp',
        value: 0,
        time: 5 + FADE_S,
      });
    }
    // A loop stopped this way starts afresh when asked for again.
    engine.setLoop('fire', FIRE, BUFFER, ahead(100));
    expect(engine.voices).toBe(1);
  });

  it('close stops everything and closes the context; no later gesture makes another', async () => {
    const { ctx, create, engine } = unlocked();
    engine.play(BEEP, BUFFER, null, 2);
    engine.close();
    expect(ctx.closed).toBe(true);
    expect(ctx.sources()[0].stops).toEqual([FADE_S]);
    expect(engine.unlocked).toBe(false);
    expect(engine.voices).toBe(0);
    engine.unlock();
    expect(create).toHaveBeenCalledTimes(1);
    expect(engine.play(BEEP, BUFFER, null, 3)).toBe(false);
    expect(engine.canDecode).toBe(false);
    await expect(engine.decode(new ArrayBuffer(8))).rejects.toThrow(
      'sound is closed'
    );
    // Never unlocked: closing makes nothing, and no gesture after does either.
    const never = setup();
    never.engine.close();
    never.engine.unlock();
    expect(never.create).not.toHaveBeenCalled();
  });

  it('places the listener with positionX… and forwardX… where the browser has them', () => {
    const { ctx, engine } = unlocked();
    engine.setListener({
      x: 1,
      y: 2,
      z: 3,
      fx: 0,
      fy: 0,
      fz: -1,
      ux: 0,
      uy: 1,
      uz: 0,
    });
    const l = ctx.listener;
    expect(
      [l.positionX, l.positionY, l.positionZ].map((p) => p!.value)
    ).toEqual([1, 2, 3]);
    expect([l.forwardX, l.forwardY, l.forwardZ].map((p) => p!.value)).toEqual([
      0, 0, -1,
    ]);
    expect([l.upX, l.upY, l.upZ].map((p) => p!.value)).toEqual([0, 1, 0]);
    expect(l.positions).toHaveLength(0);
  });

  it('places the listener with setPosition and setOrientation otherwise, from the pose set before unlock', () => {
    const { ctx, engine } = setup({ legacyListener: true });
    engine.setListener({
      x: 4,
      y: 5,
      z: 6,
      fx: 1,
      fy: 0,
      fz: 0,
      ux: 0,
      uy: 1,
      uz: 0,
    });
    engine.unlock();
    expect(ctx.listener.positions.at(-1)).toEqual([4, 5, 6]);
    expect(ctx.listener.orientations.at(-1)).toEqual([1, 0, 0, 0, 1, 0]);
  });
});
