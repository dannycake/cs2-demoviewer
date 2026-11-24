// @vitest-environment jsdom
// The server's pre-rendered body: most views take it away once they have content of their own,
// and a match's viewer, a canvas, keeps it in the page out of sight.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasPre, removePre, tuckPre } from '../src/site/pre';

describe('the pre-rendered body', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="pre"><h1>Mirage 13–9</h1><a href="/profiles/1">alpha</a></div>';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('stays in the page behind the viewer, its text and links intact', () => {
    tuckPre();
    const pre = document.getElementById('pre')!;
    expect(hasPre()).toBe(true);
    expect('tucked' in pre.dataset).toBe(true);
    expect(pre.querySelector('h1')?.textContent).toBe('Mirage 13–9');
    expect(pre.querySelector('a')?.getAttribute('href')).toBe('/profiles/1');
  });

  it('is out of the keyboard\'s way once tucked', () => {
    tuckPre();
    expect(document.getElementById('pre')!.hasAttribute('inert')).toBe(true);
  });

  it('can still be taken away when the route changes', () => {
    tuckPre();
    removePre();
    expect(hasPre()).toBe(false);
  });

  it('asks nothing of a page without one', () => {
    document.body.innerHTML = '';
    expect(() => tuckPre()).not.toThrow();
  });
});
