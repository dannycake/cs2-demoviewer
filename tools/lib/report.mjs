// The table every check-*.mjs gate prints: one row per check, [check, actual, budget, status],
// the status OK, FAIL, SKIP (does not apply: an optional file absent; only skipRow says it) or
// WARN (printed, never failing: a measurement of the machine's load, not of the artefact). Each gate's rows come from
// an exported function its tests call; its command line only prints them through here and exits
// 1 when any row is FAIL, which is what stops build-assets.sh before the manifest is written.

/**
 * A row: `ok` true is OK, anything else FAIL. A check whose `ok` comes out null or undefined (a
 * `x && cond` with `x` missing) fails rather than passing as a SKIP; a row that does not apply is
 * a skipRow.
 */
export const row = (check, actual, budget, ok) => [check, String(actual), budget, ok ? 'OK' : 'FAIL'];

/** A row that checks nothing because it does not apply (an optional file absent): SKIP. */
export const skipRow = (check, actual, budget) => [check, String(actual), budget, 'SKIP'];

/** A row that warns instead of failing: OK, or WARN when `ok` is false. */
export const warnRow = (check, actual, budget, ok) => [check, String(actual), budget, ok ? 'OK' : 'WARN'];

/**
 * A gate's rows as it adds them: `rows`, `row(check, actual, budget, ok)`, `skipRow(check,
 * actual, budget)` and `warnRow(…)`, which build a row as above and push it.
 */
export function collector() {
  const rows = [];
  return {
    rows,
    row: (...a) => rows.push(row(...a)),
    skipRow: (...a) => rows.push(skipRow(...a)),
    warnRow: (...a) => rows.push(warnRow(...a)),
  };
}

/** How many of `rows` are FAIL. */
export const failures = (rows) => rows.filter((r) => r[3] === 'FAIL').length;

/**
 * The table as lines: `title`, the header, one padded line per row, then `all checks OK` or
 * `<n> check(s) FAILED`.
 */
export function reportLines(title, rows) {
  const widths = [0, 1, 2, 3].map((i) => Math.max(...[['check', 'actual', 'budget', ''][i], ...rows.map((r) => r[i])].map((s) => s.length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const failed = failures(rows);
  return [title, line(['check', 'actual', 'budget', '']), ...rows.map(line), failed ? `${failed} check(s) FAILED` : 'all checks OK'];
}

/** Prints the table and exits: 0 when no row failed, else 1. */
export function exitWithReport(title, rows) {
  for (const l of reportLines(title, rows)) console.log(l);
  process.exit(failures(rows) ? 1 : 0);
}
