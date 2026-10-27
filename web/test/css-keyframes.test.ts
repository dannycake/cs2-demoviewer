// Every animation a CSS module names has keyframes to run. CSS modules make a bare name the
// module's own (`pulse` becomes `_pulse_6bsiw_1` in the build), so a bare name needs its
// `@keyframes` in the same module, and one kept in a global stylesheet (tokens.css's `pulse`) is
// named `global(pulse)`. A bare `pulse` without its own keyframes animated nothing: the 3D
// view's "loading the world…" dot and the upload's current chunk never pulsed.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** The stylesheets under src/, by path from it. */
function sheets(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SRC, { recursive: true, encoding: 'utf8' }))
    if (f.endsWith('.css')) out.set(f, readFileSync(SRC + f, 'utf8'));
  return out;
}

const keyframes = (css: string) =>
  new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));

/** The keyframes each `animation` or `animation-name` names (the first word; `none` aside). */
function animations(css: string): { name: string; global: boolean }[] {
  const out: { name: string; global: boolean }[] = [];
  for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    const first = m[1].trim().split(/\s+/)[0];
    if (first === 'none') continue;
    const g = /^global\(([\w-]+)\)$/.exec(first);
    out.push(g ? { name: g[1], global: true } : { name: first, global: false });
  }
  return out;
}

describe('CSS animations', () => {
  it('name keyframes that exist: their module’s own, or a global stylesheet’s through global()', () => {
    const all = sheets();
    const globals = new Set<string>();
    for (const [path, css] of all)
      if (!path.endsWith('.module.css'))
        for (const k of keyframes(css)) globals.add(k);
    expect(globals.has('pulse')).toBe(true);

    const missing: string[] = [];
    let named = 0;
    for (const [path, css] of all) {
      if (!path.endsWith('.module.css')) continue;
      const own = keyframes(css);
      for (const a of animations(css)) {
        named++;
        if (!(a.global ? globals : own).has(a.name))
          missing.push(`${path}: ${a.global ? `global(${a.name})` : a.name}`);
      }
    }
    expect(named).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
