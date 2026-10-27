import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { FrameScheduler } from '../src/state/clock';
import {
  countRender,
  DerivedValue,
  FrameWriter,
  renderCounts,
  sameModel,
} from '../src/state/derive';

describe('sameModel', () => {
  it('compares plain data structurally', () => {
    expect(
      sameModel([{ a: 1, b: ['x', null] }], [{ a: 1, b: ['x', null] }])
    ).toBe(true);
    expect(
      sameModel([{ a: 1, b: ['x', null] }], [{ a: 1, b: ['y', null] }])
    ).toBe(false);
    expect(sameModel([1, 2], [1, 2, 3])).toBe(false);
    expect(sameModel({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(sameModel({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(
      false
    );
    expect(sameModel(NaN, NaN)).toBe(true);
    expect(sameModel({ n: NaN }, { n: NaN })).toBe(true);
  });

  it('compares anything but arrays and plain objects by identity', () => {
    expect(sameModel([1], { 0: 1 })).toBe(false);
    expect(sameModel(new Date(0), new Date(0))).toBe(false);
    expect(sameModel(null, {})).toBe(false);
  });
});

describe('DerivedValue', () => {
  it('a derived value changes only when its model does', () => {
    const store = createStore(() => ({ tick: 0 }));
    const d = new DerivedValue(store, (s) => ({
      second: Math.floor(s.tick / 64),
    }));
    let calls = 0;
    d.subscribe(() => calls++);
    const first = d.getSnapshot();
    for (let t = 1; t <= 150; t++) store.setState({ tick: t });
    expect(calls).toBe(2); // seconds 1 and 2
    const second = d.getSnapshot();
    store.setState({ tick: 140 });
    expect(d.getSnapshot()).toBe(second); // equal model: same object
    expect(first).toEqual({ second: 0 });
  });

  it('follows the store only while it has listeners, catching up when one subscribes', () => {
    const store = createStore(() => ({ tick: 0 }));
    let derived = 0;
    const d = new DerivedValue(store, (s) => {
      derived++;
      return { tick: s.tick };
    });
    store.setState({ tick: 5 });
    expect(derived).toBe(1);
    const unsubscribe = d.subscribe(() => {});
    expect(d.getSnapshot()).toEqual({ tick: 5 });
    unsubscribe();
    const counted = derived;
    store.setState({ tick: 6 });
    expect(derived).toBe(counted);
  });

  it('is never stale without listeners: getSnapshot then derives from the store as it is', () => {
    const store = createStore(() => ({ tick: 0 }));
    let derived = 0;
    const d = new DerivedValue(store, (s) => {
      derived++;
      return { second: Math.floor(s.tick / 64) };
    });
    store.setState({ tick: 70 });
    expect(d.getSnapshot()).toEqual({ second: 1 });
    const one = d.getSnapshot();
    expect(derived).toBe(2); // the constructor's, then one for the new state
    store.setState({ tick: 80 });
    expect(d.getSnapshot()).toBe(one); // equal model: same object
    const unsubscribe = d.subscribe(() => {});
    unsubscribe();
    store.setState({ tick: 130 });
    expect(d.getSnapshot()).toEqual({ second: 2 });
  });

  it('rethrows what derive threw from getSnapshot, not from the store write', () => {
    const store = createStore(() => ({ tick: 0 }));
    const d = new DerivedValue(store, (s) => {
      if (s.tick === 1) throw new Error('bad tick');
      return { tick: s.tick };
    });
    let calls = 0;
    d.subscribe(() => calls++);
    expect(() => store.setState({ tick: 1 })).not.toThrow();
    expect(calls).toBe(1);
    expect(() => d.getSnapshot()).toThrow('bad tick');
    store.setState({ tick: 2 });
    expect(calls).toBe(2);
    expect(d.getSnapshot()).toEqual({ tick: 2 });
  });
});

// A hand-driven requestAnimationFrame, as in clock.test.ts: `step()` runs the pending callbacks.
function fakeFrames() {
  let next = 1;
  const pending = new Map<number, (t: number) => void>();
  const sched: FrameScheduler = {
    request(cb) {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
  };
  return {
    sched,
    get pending() {
      return pending.size;
    },
    step() {
      for (const id of [...pending.keys()]) {
        const cb = pending.get(id);
        if (!cb) continue;
        pending.delete(id);
        cb(0);
      }
    },
  };
}

describe('FrameWriter', () => {
  it('applies once at start, then once per frame after any batch of changes', () => {
    const store = createStore(() => ({ tick: 0 }));
    const frames = fakeFrames();
    const applied: number[] = [];
    const w = new FrameWriter(store, (s) => applied.push(s.tick), frames.sched);
    frames.step();
    expect(applied).toEqual([0]);
    for (let t = 1; t <= 5; t++) store.setState({ tick: t });
    frames.step();
    expect(applied).toEqual([0, 5]);
    expect(frames.pending).toBe(0);
    w.stop();
  });

  it('stop() cancels the pending frame, and later changes apply nothing', () => {
    const store = createStore(() => ({ tick: 0 }));
    const frames = fakeFrames();
    let applied = 0;
    const w = new FrameWriter(store, () => applied++, frames.sched);
    store.setState({ tick: 1 });
    expect(frames.pending).toBe(1);
    w.stop();
    expect(frames.pending).toBe(0);
    store.setState({ tick: 2 });
    frames.step();
    expect(frames.pending).toBe(0);
    expect(applied).toBe(1);
  });
});

describe('countRender', () => {
  it('counts renders by name', () => {
    countRender('a');
    countRender('a');
    expect(renderCounts().a).toBe(2);
  });
});
