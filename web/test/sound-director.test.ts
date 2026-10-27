// The sound director (`audio/director.ts`): an advance of the clock plays the cues it crossed,
// once, at up to 2×; a seek, a pause or a faster speed plays nothing and stops what is playing;
// a fire's loop sounds while playing and its span holds the tick; nothing under /sounds/ is
// fetched before the first gesture or while muted, and a round's banks load when it is shown;
// a context the first press left suspended loads banks but plays nothing until a gesture runs it.
// Played through the real engine over a fake context, and the real banks over a fake fetch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundBanks } from '../src/audio/banks';
import {
  PREFETCH_S,
  SOUND_MAX_SPEED,
  SoundDirector,
} from '../src/audio/director';
import { FADE_S, SoundEngine, type ListenerPose } from '../src/audio/engine';
import { eyeListener } from '../src/audio/listener';
import { EYE_STANDING, UNIT } from '../src/geo/coords';
import { roundCues } from '../src/sim/sounds';
import type { ClockPosition } from '../src/state/clock';
import { createSettingsStore } from '../src/state/settings';
import { createPlaybackStore } from '../src/state/store';
import { FakeAudioContext, type ResumeAs } from './helpers/fake-audio';
import {
  event,
  trackPack,
  withSecondRound,
  type SampleSpec,
} from './helpers/track-pack';

// Round 0 runs from tick 1000 to 6998 (3000 samples, 2 ticks apart), round 1 from 7998 on.
const T = 1000;
const END0 = T + 2 * 2999;
const T1 = END0 + 1000;
const FIRE = { x: 10, y: 20, z: 0 };

/** p1, a CT, runs along x for a second from tick 4000 (sample 1500) and stands otherwise. */
const runner = (k: number): SampleSpec => ({
  x: 100 + (Math.min(Math.max(k - 1500, 0), 32) * 250) / 32,
  y: 0,
});

/**
 * p0 (a T at the origin) fires the AK at 1010, 3000, 5010 and five ticks before round 0's
 * `post_end_tick`, and the Deagle (a bank round 0 never names) on round 1's `start_tick`; a fire
 * burns at `FIRE` from 2000 to 2400.
 */
function matchPack() {
  const shot = (tick: number, weapon = 'weapon_ak47') =>
    event('weapon_fire', tick, { user_idx: 0, weapon });
  const pack = withSecondRound(
    trackPack({
      samples: 3000,
      start_tick: T,
      teams: [2, 3],
      players: [() => ({ x: 0, y: 0 }), runner],
      events: [
        shot(1010),
        shot(3000),
        shot(5010),
        shot(END0 - 5),
        shot(T1, 'weapon_deagle'),
        event('inferno_startburn', 2000, {
          entityid: 99,
          user_idx: 0,
          ...FIRE,
        }),
        event('inferno_expire', 2400, { entityid: 99, user_idx: 0, ...FIRE }),
      ],
    })
  );
  // Both play the second round too.
  for (const p of pack.header.players)
    p.team_by_round = [p.team_by_round[0], p.team_by_round[0]];
  return pack;
}

const sha = (c: string) => c.repeat(64);
const bank = (c: string) => ({ sha256: sha(c), bytes: 1000, seconds: 1 });
const once = { clips: [[0, 0.5]] };
// No `fire:start:molotov`: a key the manifest lacks, as some guns' reload parts are.
const MANIFEST = {
  banks: {
    weapon_ak47: bank('a'),
    weapon_deagle: bank('e'),
    steps_default: bank('b'),
    steps_metal: bank('c'),
    inferno: bank('d'),
  },
  sounds: {
    'shot:ak47': { bank: 'weapon_ak47', layers: [once] },
    'shot:deagle': { bank: 'weapon_deagle', layers: [once] },
    'step:default:ct': { bank: 'steps_default', layers: [once] },
    'step:metal:ct': { bank: 'steps_metal', layers: [once] },
    'fire:loop': {
      bank: 'inferno',
      layers: [{ clips: [[0, 2]], loop: true }],
    },
    'fire:out': { bank: 'inferno', layers: [once] },
  },
  surfaces: { metal_grate: 'metal' },
};

/** The listener the scene gives: at the origin, looking down the scene's −Z. */
const EAR: ListenerPose = {
  x: 0,
  y: 0,
  z: 0,
  fx: 0,
  fy: 0,
  fz: -1,
  ux: 0,
  uy: 1,
  uz: 0,
};

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const settle = () => new Promise((r) => setTimeout(r, 0));
const path = (url: string) => url.replace(/\?.*$/, '');

/**
 * A director over `matchPack`, paused at round 0's start. `hold` lists banks whose fetch waits
 * for `release(bank)`; `resumeAs` is what the context does when a gesture resumes it. The
 * scene's listener answers `view.pose` (null: no 3D view).
 */
function setup(
  o: { muted?: boolean; hold?: string[]; resumeAs?: ResumeAs } = {}
) {
  const pack = matchPack();
  const store = createPlaybackStore({ storage: null });
  store.getState().setPack(pack);
  const settings = createSettingsStore(null);
  if (o.muted) settings.getState().set({ muted: true });
  const ctx = new FakeAudioContext({ resumeAs: o.resumeAs });
  const engine = new SoundEngine(() => ctx);
  const urls: string[] = [];
  const held = new Map<string, () => void>();
  const load = async (url: string) => {
    urls.push(url);
    const p = path(url);
    const name = /^\/sounds\/(.+)\.webm$/.exec(p)?.[1];
    if (name && o.hold?.includes(name))
      await new Promise<void>((r) => held.set(name, r));
    return bytes(p === '/sounds/manifest.json' ? JSON.stringify(MANIFEST) : p);
  };
  const banks = new SoundBanks(load, (d) => engine.decode(d));
  const surface = { at: null as string | null, version: 0, calls: 0 };
  /** Work the director asked to run off the frame, run by `runIdle`. */
  const idles: (() => void)[] = [];
  const view: { pose: ListenerPose | null } = { pose: EAR };
  const director = new SoundDirector({
    store,
    settings,
    engine,
    banks,
    listener: (out) => {
      if (!view.pose) return false;
      Object.assign(out, view.pose);
      return true;
    },
    surfaceAt: () => {
      surface.calls++;
      return surface.at;
    },
    idle: (task) => idles.push(task),
    surfaceVersion: () => surface.version,
  });
  const stopAll = vi.spyOn(engine, 'stopAll');
  const play = vi.spyOn(engine, 'play');

  /** Each sound played, as `key@tick` (the cue found by its seed). */
  const played = () => {
    const bySeed = new Map<number, string>();
    for (const r of [0, 1])
      for (const set of ['default', 'metal'])
        for (const c of roundCues(pack, r, () => set))
          bySeed.set(c.seed, `${c.key}@${c.tick}`);
    return play.mock.calls.map(([, , , seed]) => bySeed.get(seed) ?? '?');
  };

  /** The clock's frame: writes `to` and reports the advance at the store's speed, then draws. */
  const advanceTo = (to: number | ClockPosition) => {
    const s = store.getState();
    const from = { round: s.round, tick: s.tick };
    const pos = typeof to === 'number' ? { round: s.round, tick: to } : to;
    store.setState(pos);
    // As the clock holds it: unbound.
    const onAdvance = director.onAdvance;
    onAdvance(from, pos, s.speed);
    director.frame();
  };

  /** The first gesture, and everything it fetches decoded. */
  const ready = async () => {
    director.unlock();
    await settle();
    director.frame();
    await settle();
  };

  const release = (name: string) => held.get(name)?.();
  const runIdle = () => {
    for (const task of idles.splice(0)) task();
  };
  const loops = () => ctx.sources().filter((s) => s.loop);

  return {
    pack,
    store,
    settings,
    ctx,
    engine,
    banks,
    director,
    urls,
    surface,
    view,
    stopAll,
    play,
    played,
    advanceTo,
    ready,
    release,
    idles,
    runIdle,
    loops,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SoundDirector: the gesture and the mute', () => {
  it('fetches and plays nothing before the first gesture', async () => {
    const t = setup();
    t.director.frame();
    t.store.getState().play();
    t.advanceTo(1020);
    await settle();
    expect(t.urls).toEqual([]);
    expect(t.play).not.toHaveBeenCalled();
    expect(t.director.debug).toEqual({
      unlocked: false,
      played: 0,
      skipped: 0,
      voices: 0,
      banks: [],
    });
  });

  it('after the gesture, fetches the manifest and the shown round’s banks by their hash', async () => {
    const t = setup();
    await t.ready();
    expect(t.director.debug.unlocked).toBe(true);
    expect(t.urls[0]).toBe('/sounds/manifest.json');
    expect([...t.urls.slice(1)].sort()).toEqual([
      '/sounds/inferno.webm?v=dddddddd',
      '/sounds/steps_default.webm?v=bbbbbbbb',
      '/sounds/weapon_ak47.webm?v=aaaaaaaa',
    ]);
    expect([...t.director.debug.banks].sort()).toEqual([
      'inferno',
      'steps_default',
      'weapon_ak47',
    ]);
    // A later gesture fetches nothing again.
    t.director.unlock();
    await settle();
    expect(t.urls).toHaveLength(4);
  });

  it('a first press the browser does not count: the banks load, cues crossed are skipped, and the next gesture starts the sound with none played late', async () => {
    const t = setup({ resumeAs: 'suspended' });
    // A finger's pointerdown makes the context, suspended.
    await t.ready();
    expect(t.director.debug.unlocked).toBe(false);
    // Decoding needs only the context: the shown round's banks are in.
    expect([...t.director.debug.banks].sort()).toEqual([
      'inferno',
      'steps_default',
      'weapon_ak47',
    ]);
    const chain = t.ctx.nodes.length;
    t.store.getState().play();
    t.advanceTo(1020);
    expect(t.director.debug.skipped).toBe(1);
    // Into the burning fire (its start, which the manifest lacks, skipped too): its loop waits.
    t.advanceTo(2100);
    expect(t.director.debug.skipped).toBe(2);
    expect(t.ctx.nodes).toHaveLength(chain);
    expect(t.play).not.toHaveBeenCalled();
    // Esc does not count either; each such gesture resumes it again.
    t.director.unlock();
    expect(t.ctx.resumes).toBe(2);
    // The finger's pointerup does.
    t.ctx.resumeAs = 'running';
    t.director.unlock();
    expect(t.director.debug.unlocked).toBe(true);
    expect(t.play).not.toHaveBeenCalled();
    t.director.frame();
    expect(t.loops()).toHaveLength(1);
    t.advanceTo(3010);
    expect(t.played()).toEqual(['fire:out@2400', 'shot:ak47@3000']);
    expect(t.director.debug).toMatchObject({ played: 2, skipped: 2 });
    // Running, a gesture has nothing to do.
    t.director.unlock();
    expect(t.ctx.resumes).toBe(3);
    expect(t.urls).toHaveLength(4);
  });

  it('unlocked while muted, fetches and plays nothing until unmuted', async () => {
    const t = setup({ muted: true });
    await t.ready();
    expect(t.director.debug.unlocked).toBe(true);
    t.store.getState().play();
    t.advanceTo(1020);
    await settle();
    expect(t.urls).toEqual([]);
    expect(t.play).not.toHaveBeenCalled();
    // Unmuting while paused loads what the shown round needs, with no frame drawn.
    t.store.getState().pause();
    t.director.frame();
    t.settings.getState().set({ muted: false });
    await settle();
    await settle();
    expect(t.urls.map(path).sort()).toEqual([
      '/sounds/inferno.webm',
      '/sounds/manifest.json',
      '/sounds/steps_default.webm',
      '/sounds/weapon_ak47.webm',
    ]);
    expect(t.director.debug.banks).toHaveLength(3);
  });

  it('takes the volume and the mute from the settings', async () => {
    const t = setup();
    await t.ready();
    expect(t.ctx.master().gain.value).toBe(0.6);
    t.settings.getState().set({ volume: 0.25 });
    t.director.frame();
    expect(t.ctx.master().gain.value).toBe(0.25);
    t.store.getState().play();
    t.advanceTo(1020);
    expect(t.director.debug.voices).toBe(1);
    // Muting stops what plays and plays nothing more.
    t.settings.getState().set({ muted: true });
    expect(t.ctx.master().gain.value).toBe(0);
    expect(t.director.debug.voices).toBe(0);
    t.store.getState().seekTick(5000);
    t.director.frame();
    t.advanceTo(5020);
    expect(t.played()).toEqual(['shot:ak47@1010']);
  });
});

describe('SoundDirector: what an advance crossed', () => {
  it('plays a cue an advance crossed at 1×, once, where its source is', async () => {
    const t = setup();
    await t.ready();
    t.store.getState().play();
    t.advanceTo(1020);
    expect(t.played()).toEqual(['shot:ak47@1010']);
    expect(t.play.mock.calls[0][2]).toEqual({ x: 0, y: 0, z: 0 });
    expect(t.director.debug.played).toBe(1);
    t.advanceTo(1040);
    expect(t.played()).toEqual(['shot:ak47@1010']);
    expect(t.director.debug.played).toBe(1);
  });

  it(`plays at up to ${SOUND_MAX_SPEED}×, nothing faster`, async () => {
    expect(SOUND_MAX_SPEED).toBe(2);
    const t = setup();
    await t.ready();
    t.store.getState().setSpeed(4);
    t.store.getState().play();
    t.advanceTo(1020);
    expect(t.play).not.toHaveBeenCalled();
    t.store.getState().setSpeed(2);
    t.store.getState().seekTick(5000);
    t.advanceTo(5020);
    expect(t.played()).toEqual(['shot:ak47@5010']);
  });

  it('a faster speed stops what was playing', async () => {
    const t = setup();
    await t.ready();
    t.store.getState().play();
    t.advanceTo(1020);
    expect(t.director.debug.voices).toBe(1);
    t.store.getState().setSpeed(8);
    t.advanceTo(1300);
    expect(t.stopAll).toHaveBeenCalled();
    expect(t.director.debug.voices).toBe(0);
  });

  it('a seek while playing plays nothing it jumped over and stops what was playing, once', async () => {
    const t = setup();
    await t.ready();
    t.store.getState().play();
    t.advanceTo(1020);
    const ringing = t.ctx.sources()[0];
    t.store.getState().seekTick(5000);
    t.advanceTo(5020);
    expect(t.played()).toEqual(['shot:ak47@1010', 'shot:ak47@5010']);
    expect(t.stopAll).toHaveBeenCalledTimes(1);
    expect(ringing.stops).toEqual([FADE_S]);
    expect(t.director.debug.voices).toBe(1);
  });

  it('a jump the clock did not make (a seek drawn first, a reel’s next segment) stops everything', async () => {
    const t = setup();
    await t.ready();
    t.store.getState().play();
    t.advanceTo(1020);
    // The store moved without an advance, and a frame was drawn there.
    t.store.setState({ tick: 5000 });
    t.director.frame();
    expect(t.stopAll).toHaveBeenCalledTimes(1);
    expect(t.director.debug.voices).toBe(0);
    // The next advance runs on from there: nothing to stop again.
    t.advanceTo(5020);
    expect(t.stopAll).toHaveBeenCalledTimes(1);
    expect(t.played()).toEqual(['shot:ak47@1010', 'shot:ak47@5010']);
  });

  it('a pause stops everything', async () => {
    const t = setup();
    await t.ready();
    t.store.getState().play();
    t.advanceTo(1020);
    expect(t.director.debug.voices).toBe(1);
    t.store.getState().pause();
    t.director.frame();
    expect(t.stopAll).toHaveBeenCalledTimes(1);
    expect(t.director.debug.voices).toBe(0);
    // Drawn again while paused: nothing more to stop.
    t.director.frame();
    expect(t.stopAll).toHaveBeenCalledTimes(1);
  });

  it("an advance across rounds plays the old round's last cue and the new round's first, once each", async () => {
    const t = setup();
    await t.ready();
    t.store.getState().seekTick(END0 - 10);
    t.director.frame();
    t.store.getState().play();
    const stops = t.stopAll.mock.calls.length;
    t.advanceTo(END0 - 8);
    // The next round's cues, made off the frame in the round's last seconds; its banks come in.
    t.runIdle();
    await settle();
    t.advanceTo({ round: 1, tick: T1 + 4 });
    expect(t.played()).toEqual([`shot:ak47@${END0 - 5}`, `shot:deagle@${T1}`]);
    t.advanceTo({ round: 1, tick: T1 + 20 });
    expect(t.played()).toHaveLength(2);
    expect(t.director.debug.skipped).toBe(0);
    // An advance into the next round is no seek.
    expect(t.stopAll).toHaveBeenCalledTimes(stops);
  });

  it(`in a round's last ${PREFETCH_S} s, makes the next round's cues once, off the frame, and loads its banks`, async () => {
    expect(PREFETCH_S).toBe(10);
    const t = setup();
    await t.ready();
    // Round 0's cues: the surface under each of its footfalls, once.
    const perRound = t.surface.calls;
    expect(perRound).toBeGreaterThan(0);
    const window = END0 - PREFETCH_S * 64;
    t.store.getState().seekTick(window - 30);
    t.director.frame();
    t.store.getState().play();
    t.advanceTo(window - 10);
    expect(t.idles).toHaveLength(0);
    t.advanceTo(window + 10);
    t.advanceTo(window + 20);
    // Asked for once, and nothing made on the frame itself.
    expect(t.idles).toHaveLength(1);
    expect(t.surface.calls).toBe(perRound);
    t.runIdle();
    // Round 1 has round 0's tracks: as many footfalls.
    expect(t.surface.calls).toBe(2 * perRound);
    // Its banks are asked for: the Deagle's resolves before the crossing.
    await settle();
    expect(t.urls.map(path)).toContain('/sounds/weapon_deagle.webm');
    t.advanceTo(END0 - 10);
    expect(t.idles).toHaveLength(0);
    // The crossing plays its first shot.
    t.advanceTo({ round: 1, tick: T1 + 4 });
    expect(t.played()).toEqual([`shot:ak47@${END0 - 5}`, `shot:deagle@${T1}`]);
    expect(t.director.debug.skipped).toBe(0);
    expect(t.surface.calls).toBe(2 * perRound);
  });

  it('without the prefetch, a bank first named at the crossing is still loading: its cue is skipped', async () => {
    const t = setup();
    await t.ready();
    t.store.getState().seekTick(END0 - 10);
    t.director.frame();
    t.store.getState().play();
    t.advanceTo({ round: 1, tick: T1 + 4 });
    expect(t.played()).toEqual([`shot:ak47@${END0 - 5}`]);
    expect(t.director.debug.skipped).toBe(1);
  });

  it('asks for nothing ahead while muted', async () => {
    const t = setup({ muted: true });
    await t.ready();
    t.store.getState().seekTick(END0 - 100);
    t.director.frame();
    t.store.getState().play();
    t.advanceTo(END0 - 80);
    expect(t.idles).toHaveLength(0);
    expect(t.urls).toEqual([]);
  });

  it('makes a round’s cues once per pack and surfaces: again only when either changes', async () => {
    const t = setup();
    await t.ready();
    const perRound = t.surface.calls;
    t.store.getState().play();
    t.advanceTo(1020);
    t.advanceTo(1040);
    t.director.frame();
    t.store.getState().seekTick(3000);
    t.advanceTo(3020);
    expect(t.surface.calls).toBe(perRound);
    // A hull came in: made once more, then kept.
    t.surface.version = 1;
    t.director.frame();
    t.advanceTo(3040);
    t.director.frame();
    expect(t.surface.calls).toBe(2 * perRound);
    // Another pack: made for it.
    t.store.getState().setPack(matchPack());
    t.director.frame();
    t.director.frame();
    expect(t.surface.calls).toBe(3 * perRound);
  });

  it('a cue whose bank is still loading is skipped and counted, never played late', async () => {
    const t = setup({ hold: ['weapon_ak47'] });
    await t.ready();
    t.store.getState().play();
    t.advanceTo(1020);
    expect(t.play).not.toHaveBeenCalled();
    expect(t.director.debug.skipped).toBe(1);
    t.release('weapon_ak47');
    await settle();
    t.advanceTo(1040);
    expect(t.play).not.toHaveBeenCalled();
    t.store.getState().seekTick(5000);
    t.advanceTo(5020);
    expect(t.played()).toEqual(['shot:ak47@5010']);
    expect(t.director.debug.skipped).toBe(1);
  });

  it('a cue whose key the manifest lacks is skipped and counted, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    await t.ready();
    t.store.getState().seekTick(1990);
    t.director.frame();
    t.store.getState().play();
    // The fire's start (`fire:start:molotov`) is not in the manifest; its loop is.
    t.advanceTo(2010);
    expect(t.play).not.toHaveBeenCalled();
    expect(t.director.debug.skipped).toBe(1);
    expect(t.loops()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('SoundDirector: loops', () => {
  it('a fire burning at the tick loops while playing, until it ends, and stops on a pause', async () => {
    const t = setup();
    await t.ready();
    t.store.getState().seekTick(2100);
    t.director.frame();
    expect(t.loops()).toHaveLength(0);
    t.store.getState().play();
    t.director.frame();
    expect(t.loops()).toHaveLength(1);
    expect(t.director.debug.voices).toBe(1);
    t.advanceTo(2390);
    // The same loop, not started again.
    expect(t.loops()).toHaveLength(1);
    expect(t.loops()[0].stops).toEqual([]);
    t.advanceTo(2400);
    expect(t.loops()[0].stops).toEqual([FADE_S]);
    expect(t.played()).toEqual(['fire:out@2400']);
    // Sought back into the fire while playing: it burns again.
    t.store.getState().seekTick(2100);
    t.advanceTo(2110);
    expect(t.loops()).toHaveLength(2);
    expect(t.loops()[1].stops).toEqual([]);
    t.store.getState().pause();
    t.director.frame();
    expect(t.loops()[1].stops).toEqual([FADE_S]);
    expect(t.director.debug.voices).toBe(0);
  });

  it(`loops nothing above ${SOUND_MAX_SPEED}×`, async () => {
    const t = setup();
    await t.ready();
    t.store.getState().seekTick(2100);
    t.store.getState().setSpeed(4);
    t.store.getState().play();
    t.director.frame();
    expect(t.loops()).toHaveLength(0);
  });
});

describe('SoundDirector: surfaces', () => {
  it('when the surfaces change, the cues are made again with them', async () => {
    const t = setup();
    await t.ready();
    const run = () => {
      t.store.getState().seekTick(3990);
      t.director.frame();
      t.store.getState().play();
      for (let tick = 4000; tick <= 4100; tick += 10) t.advanceTo(tick);
      t.store.getState().pause();
      t.director.frame();
    };
    run();
    const before = t.played();
    expect(before.length).toBeGreaterThan(2);
    expect(before.every((k) => k.startsWith('step:default:ct@'))).toBe(true);
    // A hull came in: p1 runs on a metal grate.
    t.surface.at = 'metal_grate';
    t.surface.version = 1;
    t.director.frame();
    await settle();
    expect(t.urls.map(path)).toContain('/sounds/steps_metal.webm');
    run();
    const after = t.played().slice(before.length);
    expect(after).toHaveLength(before.length);
    expect(after.every((k) => k.startsWith('step:metal:ct@'))).toBe(true);
  });
});

describe('SoundDirector: the listener', () => {
  it("listens from the scene's camera, else the followed player's eye, else where it last did", async () => {
    const t = setup();
    await t.ready();
    const at = () => [
      t.ctx.listener.positionX!.value,
      t.ctx.listener.positionY!.value,
      t.ctx.listener.positionZ!.value,
    ];
    t.view.pose = { ...EAR, x: 5, fx: 1, fz: 0 };
    t.director.frame();
    expect(at()).toEqual([5, 0, 0]);
    expect(t.ctx.listener.forwardX!.value).toBe(1);
    // No 3D view (the full radar): the eye of the player the camera shows, p1 at (100, 0, 0).
    t.view.pose = null;
    t.store.getState().setFollow(1);
    t.director.frame();
    const eye = [0, EYE_STANDING * UNIT, 100 * UNIT];
    at().forEach((v, i) => expect(v).toBeCloseTo(eye[i]));
    // No one to listen from (no pack): where it last listened.
    t.store.getState().setPack(null);
    t.director.frame();
    at().forEach((v, i) => expect(v).toBeCloseTo(eye[i]));
  });
});

describe('eyeListener', () => {
  it("is the player's eye from the track, looking along their view", () => {
    const pack = trackPack({
      players: [() => ({ x: 100, y: 200, z: 10, yaw: 90, pitch: 0 })],
    });
    const out = { ...EAR };
    expect(eyeListener(pack, 0, 1010, 0, out)).toBe(true);
    expect(out.x).toBeCloseTo(200 * UNIT);
    expect(out.y).toBeCloseTo((10 + EYE_STANDING) * UNIT);
    expect(out.z).toBeCloseTo(100 * UNIT);
    // Yaw 90 faces Source +y: the scene's +x.
    expect(out.fx).toBeCloseTo(1);
    expect(out.fy).toBeCloseTo(0);
    expect(out.fz).toBeCloseTo(0);
    expect([out.ux, out.uy, out.uz].map((v) => +v.toFixed(6))).toEqual([
      0, 1, 0,
    ]);
  });

  it('keeps its up at right angles to the view when looking down', () => {
    const pack = trackPack({ players: [() => ({ yaw: 0, pitch: 45 })] });
    const out = { ...EAR };
    expect(eyeListener(pack, 0, 1010, 0, out)).toBe(true);
    const dot = out.fx * out.ux + out.fy * out.uy + out.fz * out.uz;
    expect(dot).toBeCloseTo(0);
    expect(out.fy).toBeCloseTo(-Math.SQRT1_2);
    expect(out.uy).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(out.ux, out.uy, out.uz)).toBeCloseTo(1);
  });

  it('is false for a player with no live sample, and leaves the pose alone', () => {
    const pack = trackPack({ players: [() => ({ x: 100, flags: 0 })] });
    const out = { ...EAR };
    expect(eyeListener(pack, 0, 1010, 0, out)).toBe(false);
    expect(out).toEqual(EAR);
    expect(eyeListener(pack, 0, 1010, 5, out)).toBe(false);
    expect(eyeListener(pack, 3, 1010, 0, out)).toBe(false);
  });
});
