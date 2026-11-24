// What the homepage takes from a pick or a drop: one demo, as the owner asked ("don't let people
// upload folders... just one file").

import { isDemoFile } from '../api/upload';

const NOT_A_DEMO =
  "That isn't a demo: choose a .dem, .dem.bz2 or .dem.gz file.";
const ONE_AT_A_TIME = 'One demo at a time.';

/**
 * The one demo in what was picked or dropped. More than one file is refused, and so is anything
 * that is not a demo by its name; a dropped folder comes as one entry named as the folder, and
 * is not walked.
 */
export function pickOneDemo(
  files: readonly File[]
): { file: File } | { error: string } {
  if (files.length > 1) return { error: ONE_AT_A_TIME };
  const file = files[0];
  if (!file || !isDemoFile(file.name)) return { error: NOT_A_DEMO };
  return { file };
}
