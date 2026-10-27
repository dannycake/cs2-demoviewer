// Counting what a per-frame path calls that would make an object: a test helper, not a spy (a
// spy on the array iterator records each call and iterates itself).

import * as THREE from 'three';

/**
 * Runs `fn` with the array iterator, `forEach`, `map` and `addUpdateRange` wrapped in bare
 * counters (a spy would itself iterate and record), and returns how often each was called.
 */
export function countCalls(fn: () => void) {
  const arrays = Array.prototype as unknown as Record<
    PropertyKey,
    (...a: unknown[]) => unknown
  >;
  const attrs = THREE.BufferAttribute.prototype as unknown as Record<
    PropertyKey,
    (...a: unknown[]) => unknown
  >;
  const counts = { iterator: 0, forEach: 0, map: 0, range: 0 };
  const wrap = (
    o: Record<PropertyKey, (...a: unknown[]) => unknown>,
    key: PropertyKey,
    name: keyof typeof counts
  ) => {
    const f = o[key];
    o[key] = function (this: unknown, ...a: unknown[]) {
      counts[name]++;
      return f.apply(this, a);
    };
    return () => (o[key] = f);
  };
  const undo = [
    wrap(arrays, Symbol.iterator, 'iterator'),
    wrap(arrays, 'forEach', 'forEach'),
    wrap(arrays, 'map', 'map'),
    wrap(attrs, 'addUpdateRange', 'range'),
  ];
  try {
    fn();
  } finally {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]();
  }
  return counts;
}
