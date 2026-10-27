// Seeded random numbers, the same on every machine: the scene's sprites and poses, the sounds'
// pick of a clip and its pitch, all fixed by a seed.

/**
 * mulberry32: a small seeded generator, the same numbers on every machine. As an object that
 * can be seeded again (`reset`), so a pose run every frame makes none.
 */
export class SeededRandom {
  private a = 0;

  /** Starts the sequence of `seed` again. */
  reset(seed: number): this {
    this.a = seed >>> 0;
    return this;
  }

  /** The next number of the sequence, in [0, 1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** `SeededRandom`'s sequence of `seed` as a function. */
export function seeded(seed: number): () => number {
  const r = new SeededRandom().reset(seed);
  return () => r.next();
}
