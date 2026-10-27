// Match share codes (`CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`) in pasted text. The rule is the
// server's (`extract` in server/crates/server/src/sharecode.rs) and gcbot's
// (gcbot/src/sharecode.mjs): the first code anywhere, so CS2's "copy share link"
// (`steam://rungame/730/…/+csgo_download_match%20CSGO-…`) works as is.

const FIND = /CSGO(?:-[A-Za-z0-9]{5}){5}/;

/** What the server says to text with no share code in it. */
export const NOT_A_SHARE_CODE =
  'That is not a match share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx)';

/** The first share code in `text`, or null. */
export function extractShareCode(text: string): string | null {
  return FIND.exec(text)?.[0] ?? null;
}
