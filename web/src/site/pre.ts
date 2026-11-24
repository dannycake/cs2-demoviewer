// The server's pre-rendered body: a page's content as plain HTML in `<div id="pre">`, just after
// the app's root (server/crates/server/src/pages.rs `into_pre`), for what reads the page without
// running it. Google's renderer runs the app but may not reach the API (robots.txt keeps it out),
// so a view takes the body away only once it has its own content (or a definite answer, such as
// "not found"), never while it loads or after a failure. Until then the view draws only the
// site's frame over it (`PreFrame`). App takes it away when the route changes: it is the first
// address's.

/** Whether the pre-rendered body is still in the page. */
export function hasPre(): boolean {
  return document.getElementById('pre') !== null;
}

/**
 * Keeps the pre-rendered body in the page behind the viewer, out of sight and out of the keyboard's
 * way. A match's viewer is a canvas, so without this a search engine that runs the app would find
 * no heading, no words and no links on the page: the body is what the viewer's scoreboard shows, in
 * text. App still takes it away when the route changes.
 */
export function tuckPre(): void {
  const pre = document.getElementById('pre');
  if (!pre) return;
  pre.dataset.tucked = '';
  pre.setAttribute('inert', '');
}

/** Removes the pre-rendered body, if it is still there. */
export function removePre(): void {
  document.getElementById('pre')?.remove();
}
