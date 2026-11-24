// The server's pre-rendered body (`pages::into_pre`): a `<div id="pre">` after the app's own
// container, which a view removes once it has content of its own (site/pre.ts).

/** Puts a pre-rendered body in the page, in place of any already there. */
export function putPre(): void {
  document.getElementById('pre')?.remove();
  const pre = document.createElement('div');
  pre.id = 'pre';
  pre.innerHTML =
    '<main class="pre"><h1 class="pre-h">From the server</h1></main>';
  document.body.append(pre);
}

/** Whether the pre-rendered body is still in the page. */
export const preShown = (): boolean => document.getElementById('pre') !== null;

/** Takes the pre-rendered body away, after a test. */
export function dropPre(): void {
  document.getElementById('pre')?.remove();
}
