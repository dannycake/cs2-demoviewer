// Says at the end of a run what it skipped for want of local data (gates.ts): the tests marked
// `[needs …]` that did not run, counted by the variables they need that are unset, with their
// files and how to set them. Without it a plain `npm test` reads as complete while the
// real-data checks sat out.

import type { Reporter, TestModule } from 'vitest/node';
import { basename } from 'node:path';
import { has, LOCAL_DATA, neededBy, type LocalData } from './gates';

/** A skipped test: its full name, its blocks' names in it, and its file's name. */
export interface Skipped {
  name: string;
  file: string;
}

/**
 * The summary's lines for `skipped`, or null when none of them wanted local data. A test counts
 * under the variables its marks name that `isSet` says are unset (one in a block that needs a
 * set variable was skipped for want of the other), and only those are named under "Set to run
 * them"; a marked test with all of its variables set was skipped for another reason, and is
 * left out.
 */
export function skippedSummary(
  skipped: Iterable<Skipped>,
  isSet: (v: LocalData) => boolean
): string[] | null {
  const by = new Map<string, { tests: number; files: Set<string> }>();
  const unset = new Set<LocalData>();
  for (const t of skipped) {
    const wanted = neededBy(t.name)?.filter((v) => !isSet(v));
    if (!wanted?.length) continue;
    const key = wanted.join(' + ');
    const entry = by.get(key) ?? { tests: 0, files: new Set<string>() };
    entry.tests++;
    entry.files.add(t.file);
    by.set(key, entry);
    for (const v of wanted) unset.add(v);
  }
  if (by.size === 0) return null;
  const total = [...by.values()].reduce((n, e) => n + e.tests, 0);
  return [
    '',
    ` Skipped for want of local data: ${total} tests`,
    ...[...by].map(
      ([key, e]) =>
        `  ${e.tests} need ${key} (${[...e.files].sort().join(', ')})`
    ),
    ' Set to run them:',
    ...[...unset].sort().map((v) => `  ${v}: ${LOCAL_DATA[v]}`),
    '',
  ];
}

export default class SkippedReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const skipped: Skipped[] = [];
    for (const m of modules)
      for (const t of m.children.allTests('skipped'))
        skipped.push({
          name: t.fullName,
          file: basename(m.moduleId).replace(/\.test\.tsx?$/, ''),
        });
    const lines = skippedSummary(skipped, (v) => has(v));
    if (lines) console.log(lines.join('\n'));
  }
}
