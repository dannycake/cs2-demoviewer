// What a spec counts as the page going wrong: an error nothing caught (`pageerror`), and a render
// error one of the viewer's panels caught. A panel's ErrorBoundary keeps its error to itself (a
// quiet note in the panel's place, the rest of the viewer up) and no `pageerror` fires, so a
// widget that throws on a real match would pass every spec that does not look at that widget;
// the boundary's console line ("demoviewer: render error in the round strip", from
// components/ErrorBoundary) is how the specs see it.

import type { Page } from '@playwright/test';

/** The start of the console line an ErrorBoundary writes when it catches a render error. */
export const RENDER_ERROR = 'demoviewer: render error';

/**
 * Collects `page`'s errors into `into` (a new list by default), from now on: uncaught errors and
 * the render errors its error boundaries caught. A spec requires the list empty.
 */
export function trackErrors(page: Page, into: string[] = []): string[] {
  page.on('pageerror', (e) => into.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().startsWith(RENDER_ERROR))
      into.push(m.text());
  });
  return into;
}
