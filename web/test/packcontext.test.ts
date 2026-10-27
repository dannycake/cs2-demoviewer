// PackContext (packcontext.ts): what the scene derives from a pack is made once per pack, and
// only when a draw first asks for it (the solver with the context); `killerOf` is kept for the
// round asked last. The scene makes a new context when the pack changes (scene-map.test draws
// across packs).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trackPack } from './helpers/track-pack';

/** How many of each thing the context made. */
const made = vi.hoisted(() => ({
  ground: 0,
  entities: 0,
  timeline: 0,
  killers: 0,
}));

vi.mock('../src/sim/ground', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/sim/ground')>();
  class GroundIndex extends m.GroundIndex {
    constructor(...a: ConstructorParameters<typeof m.GroundIndex>) {
      super(...a);
      made.ground++;
    }
  }
  return { ...m, GroundIndex };
});
vi.mock('../src/sim/mapents', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/sim/mapents')>();
  class MapEntityIndex extends m.MapEntityIndex {
    constructor(...a: ConstructorParameters<typeof m.MapEntityIndex>) {
      super(...a);
      made.entities++;
    }
  }
  return { ...m, MapEntityIndex };
});
vi.mock('../src/sim/timeline', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/sim/timeline')>();
  return {
    ...m,
    timelineFor: (...a: Parameters<typeof m.timelineFor>) => {
      made.timeline++;
      return m.timelineFor(...a);
    },
  };
});
vi.mock('../src/sim/follow', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/sim/follow')>();
  return {
    ...m,
    killersOf: (...a: Parameters<typeof m.killersOf>) => {
      made.killers++;
      return m.killersOf(...a);
    },
  };
});

const { PackContext } = await import('../src/scene/packcontext');

const pack = () => trackPack({ samples: 20, players: [() => ({})] });

beforeEach(() => {
  made.ground = 0;
  made.entities = 0;
  made.timeline = 0;
  made.killers = 0;
});

describe('PackContext', () => {
  it('makes the solver with it and nothing else until it is asked for', () => {
    const p = pack();
    const ctx = new PackContext(p);
    expect(ctx.pack).toBe(p);
    expect(ctx.solver.pack).toBe(p);
    expect(made).toEqual({ ground: 0, entities: 0, timeline: 0, killers: 0 });
  });

  it('makes the ground, the timeline and the doors once each, of its own pack', () => {
    const p = pack();
    const ctx = new PackContext(p);
    const ground = ctx.ground;
    const timeline = ctx.timeline;
    const entities = ctx.entities;
    expect(ground.pack).toBe(p);
    expect(timeline.pack).toBe(p);
    expect(entities.pack).toBe(p);
    for (let i = 0; i < 3; i++) {
      expect(ctx.ground).toBe(ground);
      expect(ctx.timeline).toBe(timeline);
      expect(ctx.entities).toBe(entities);
    }
    expect(made).toEqual({ ground: 1, entities: 1, timeline: 1, killers: 0 });
    // Another pack's context makes its own.
    const other = new PackContext(pack());
    expect(other.ground).not.toBe(ground);
    expect(made.ground).toBe(2);
  });

  it("keeps the round's killerOf until another round is asked for", () => {
    const ctx = new PackContext(pack());
    const of = ctx.killerOf(0);
    expect(ctx.killerOf(0)).toBe(of);
    expect(made.killers).toBe(1);
    expect(ctx.killerOf(1)).not.toBe(of);
    expect(made.killers).toBe(2);
    ctx.killerOf(0);
    expect(made.killers).toBe(3);
  });
});
