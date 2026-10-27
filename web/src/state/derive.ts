// The HUD's render budget: a component reads the store through a derived view model
// (`useDerived`) and re-renders only when that model changes, not at every tick; values that
// do change every frame (a position, a fade) go straight to the DOM (`useFrameWriter`).
// `countRender` counts the renders, which the performance check reads.

import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { browserFrames, type FrameScheduler } from './clock';
import { playbackStore, type Playback } from './store';

function isPlainObject(x: object): boolean {
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality of plain data: primitives compare with `Object.is` (so `NaN` equals
 * `NaN`), arrays element by element, plain objects key by key (the same own keys, equal
 * values). Anything else (a `Map`, a `Date`, a class instance) is equal only to itself.
 */
export function sameModel(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameModel(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || !isPlainObject(a) || !isPlainObject(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  for (const k of keys)
    if (!Object.hasOwn(rb, k) || !sameModel(ra[k], rb[k])) return false;
  return true;
}

/**
 * A view model of a store, for `useSyncExternalStore`: `derive(state)`, recomputed at each
 * store change, kept as the same object while `equal` finds the new one equal, and its
 * listeners told only when it is not. It follows the store only while it has listeners and
 * catches up when the first one subscribes, so one dropped without unsubscribing costs
 * nothing; without listeners, `getSnapshot` derives from the store's state as it is. What
 * `derive` throws at a store change is rethrown by `getSnapshot` (in the component's render,
 * where a selector's error would be) instead of out of the store's write.
 */
export class DerivedValue<S, T> {
  private readonly store: StoreApi<S>;
  private readonly derive: (s: S) => T;
  private readonly equal: (a: T, b: T) => boolean;
  private model: T;
  /** The store state `model` (or `failure`) was derived from. */
  private from: S;
  /** What `derive` last threw, until it succeeds again. */
  private failure: { error: unknown } | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    store: StoreApi<S>,
    derive: (s: S) => T,
    equal: (a: T, b: T) => boolean = sameModel
  ) {
    this.store = store;
    this.derive = derive;
    this.equal = equal;
    this.from = store.getState();
    this.model = derive(this.from);
  }

  /** Recomputes the model from `s`; returns whether the snapshot changed. */
  private update(s: S): boolean {
    this.from = s;
    try {
      const next = this.derive(s);
      const recovered = this.failure !== null;
      this.failure = null;
      if (this.equal(this.model, next)) return recovered;
      this.model = next;
      return true;
    } catch (error) {
      this.failure = { error };
      return true;
    }
  }

  /** Derives again if the store has changed since the model was derived. */
  private catchUp(): void {
    const s = this.store.getState();
    if (s !== this.from) this.update(s);
  }

  subscribe = (onChange: () => void): (() => void) => {
    if (this.listeners.size === 0) {
      this.catchUp();
      this.unsubscribe = this.store.subscribe((s) => {
        if (!this.update(s)) return;
        for (const l of this.listeners) l();
      });
    }
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
      if (this.listeners.size === 0 && this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    };
  };

  getSnapshot = (): T => {
    // Subscribed, the model follows every store change; otherwise it may be behind.
    if (!this.unsubscribe) this.catchUp();
    if (this.failure) throw this.failure.error;
    return this.model;
  };
}

/**
 * `make()`, made again when an entry of `deps` changes (by `Object.is`, as React compares
 * dependencies): `useMemo` over a dependency list the caller passes in.
 */
function useRemade<T>(make: () => T, deps: readonly unknown[]): T {
  const [held, setHeld] = useState(() => ({ deps, value: make() }));
  if (
    held.deps.length === deps.length &&
    held.deps.every((d, i) => Object.is(d, deps[i]))
  )
    return held.value;
  const next = { deps, value: make() };
  setHeld(next);
  return next.value;
}

/**
 * `derive(playbackStore)`, re-rendering the component only when the model changes by
 * `equal`. `derive` and `equal` are taken again when `deps` change, as `useMemo` takes its
 * function: list in `deps` whatever `derive` reads besides the store.
 */
export function useDerived<T>(
  derive: (s: Playback) => T,
  deps: readonly unknown[],
  equal: (a: T, b: T) => boolean = sameModel
): T {
  const value = useRemade(
    () => new DerivedValue(playbackStore, derive, equal),
    deps
  );
  return useSyncExternalStore(value.subscribe, value.getSnapshot);
}

/**
 * Writes a store's state somewhere outside React (the DOM): `apply(state)` once at start,
 * then once in the next frame after any batch of store changes. `stop()` ends it.
 */
export class FrameWriter<S> {
  private readonly store: StoreApi<S>;
  private readonly apply: (s: S) => void;
  private readonly frames: FrameScheduler;
  private readonly unsubscribe: () => void;
  private handle: number | null = null;

  constructor(
    store: StoreApi<S>,
    apply: (s: S) => void,
    frames: FrameScheduler = browserFrames
  ) {
    this.store = store;
    this.apply = apply;
    this.frames = frames;
    apply(store.getState());
    this.unsubscribe = store.subscribe(() => {
      if (this.handle === null) this.handle = frames.request(this.frame);
    });
  }

  private readonly frame = (): void => {
    this.handle = null;
    this.apply(this.store.getState());
  };

  stop(): void {
    this.unsubscribe();
    if (this.handle !== null) this.frames.cancel(this.handle);
    this.handle = null;
  }
}

/**
 * Runs `apply(playbackStore)` through a `FrameWriter` while the component is mounted, the
 * first time before the browser paints. `apply` is taken again, and run at once, when `deps`
 * change: list in `deps` whatever it reads besides the store (the elements it writes to).
 */
export function useFrameWriter(
  apply: (s: Playback) => void,
  deps: readonly unknown[]
): void {
  const write = useRemade(() => apply, deps);
  useLayoutEffect(() => {
    const writer = new FrameWriter(playbackStore, write);
    return () => writer.stop();
  }, [write]);
}

const renders = new Map<string, number>();

/** Counts one render of the component `name`; a HUD component's first line. */
export function countRender(name: string): void {
  renders.set(name, (renders.get(name) ?? 0) + 1);
}

/** The renders counted so far by component, as a copy. */
export function renderCounts(): Readonly<Record<string, number>> {
  return Object.fromEntries(renders);
}
