// What every tools/ script with a command line checks before it runs it: whether it is the
// module node was started with, rather than one a test or another script imported for its
// exports.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `url` (its import.meta.url) is the entry module. Both sides are
 * realpathed: node realpaths the entry module's URL but leaves process.argv[1] as typed, so a
 * script run through a symlinked path (a checkout reached through a symlink, as build-assets.sh's
 * `cd && pwd` gives it) would otherwise not know itself, skip its main and exit 0 having done
 * nothing. False under `node -e`/`-p`, the REPL, or anything else without a script path: under
 * `node -e '…' <args>` process.argv[1] is the first argument, so a bash script that imports a lib
 * by passing its path there (`node --input-type=module -e 'await import(argv[1])' lib/kinds.mjs`)
 * would otherwise run that lib's command line.
 */
export function isMain(url) {
  if (!process.argv[1] || process.execArgv.some((a) => /^(?:-[ep]{1,2}|--(?:eval|print)(?:=.*)?)$/.test(a))) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
