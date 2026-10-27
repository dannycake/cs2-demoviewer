// The local data some tests need and the repo cannot carry (packs of real matches, the assets
// built from CS2's files), by the environment variable that names it. A test or a block that
// needs one is named with `needs(...)`: the mark in its name is how the run's summary
// (skipped-reporter.ts) tells what was skipped for want of it, and says how to give it.

export const LOCAL_DATA = {
  DEMOVIEWER_PACK:
    "a real match's pack, e.g. DEMOVIEWER_PACK=~/.local/share/demoviewer/mirage.dvpk.gz",
  DEMOVIEWER_PACK_FP:
    'the Mirage pack with first-person data, e.g. DEMOVIEWER_PACK_FP=~/.local/share/demoviewer/mirage-fp.dvpk.gz',
  ASSETS_DIR: 'the built assets, e.g. ASSETS_DIR=<repo>/assets',
} as const;

export type LocalData = keyof typeof LOCAL_DATA;

/** `name` marked as needing `data` (`[needs A + B]`), which the run's summary reads. */
export function needs(name: string, ...data: LocalData[]): string {
  return `${name} [needs ${data.join(' + ')}]`;
}

const MARK = /\[needs ([A-Z_]+(?: \+ [A-Z_]+)*)\]/g;

/**
 * The variables the marks `needs` put in a name name, in `LOCAL_DATA`'s order, or null without
 * a mark. A test's full name carries its blocks' marks too, and it needs every one of them (a
 * test marked `DEMOVIEWER_PACK` in a block marked `ASSETS_DIR` needs both).
 */
export function neededBy(name: string): LocalData[] | null {
  const named = new Set<string>();
  for (const [, vars] of name.matchAll(MARK))
    for (const v of vars.split(' + ')) named.add(v);
  if (named.size === 0) return null;
  return (Object.keys(LOCAL_DATA) as LocalData[]).filter((v) => named.has(v));
}

/** Whether every one of `data` is set. */
export const has = (...data: LocalData[]): boolean =>
  data.every((v) => !!process.env[v]);
