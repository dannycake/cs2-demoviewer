// The guides with their bodies: each body is the fragment the server embeds for crawlers.

import download from '../../../server/crates/server/guides/download-cs2-demos.html?raw';
import faceit from '../../../server/crates/server/guides/watch-faceit-demos.html?raw';
import track from '../../../server/crates/server/guides/track-your-cs2-matches.html?raw';
import watch from '../../../server/crates/server/guides/watch-cs2-demos-in-your-browser.html?raw';
import { GUIDE_LINKS } from './guide-links';

const BODIES: Record<string, string> = {
  'watch-cs2-demos-in-your-browser': watch,
  'download-cs2-demos': download,
  'track-your-cs2-matches': track,
  'watch-faceit-demos': faceit,
};

/** The guides, in the order the server lists them. */
export const GUIDES = GUIDE_LINKS.map((g) => ({ ...g, body: BODIES[g.slug] }));
