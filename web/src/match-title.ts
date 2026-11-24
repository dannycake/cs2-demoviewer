// A match as page titles name it, from its summary. The server's match pages say the same
// (`match_title`, `page_title` and `match_page_title` in server/crates/server/src/pages.rs).

import type { MatchSummary } from './api/demos';
import { mapName } from './components/hud/models';
import { eventName } from './site/format';

/** The map as players say it, then the score, the higher first. */
export function matchTitle(s: MatchSummary): string {
  const hi = Math.max(s.scoreT, s.scoreCt);
  const lo = Math.min(s.scoreT, s.scoreCt);
  return `${mapName(s.map)} ${hi}–${lo}`;
}

/** The tab's name for a match: "A vs B · Mirage 13–9" when the corpus named the teams. */
export function matchTabTitle(s: MatchSummary): string {
  return s.teams
    ? `${s.teams[0]} vs ${s.teams[1]} · ${matchTitle(s)}`
    : matchTitle(s);
}

/**
 * The page's title, as `match_page_title` in pages.rs writes it: the tournament when the match has
 * one, else that it is a CS2 replay.
 */
export function matchPageTitle(s: MatchSummary): string {
  const name = s.event ? eventName(s.event) : '';
  return `${matchTabTitle(s)} · ${name || 'CS2 replay'}`;
}
