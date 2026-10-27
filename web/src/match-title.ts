// A match as page titles name it, from its summary: "Mirage 13–9" and the day it was played.
// The server's match pages say the same (`match_title` and `match_date` in
// server/crates/server/src/pages.rs).

import type { MatchSummary } from './api/demos';
import { mapName } from './components/hud/models';

/** The map as players say it, then the score, the higher first. */
export function matchTitle(s: MatchSummary): string {
  const hi = Math.max(s.scoreT, s.scoreCt);
  const lo = Math.min(s.scoreT, s.scoreCt);
  return `${mapName(s.map)} ${hi}–${lo}`;
}

/**
 * The UTC day (YYYY-MM-DD) the match was played, else the day it was stored; '' for a time
 * no date can show.
 */
export function matchDate(s: MatchSummary): string {
  const d = new Date((s.playedUnix ?? s.createdUnix) * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
