// A press that closed a panel is marked on its `pointerdown` event, so a view that heard the
// same press first can tell, once the press ends, that it was spent closing the panel.

import { describe, expect, it } from 'vitest';
import { isDismissal, markDismissal } from '../src/state/dismiss';

describe('dismiss', () => {
  it('marks a press that closed a panel, and only that press', () => {
    const a = new Event('pointerdown');
    const b = new Event('pointerdown');
    expect(isDismissal(a)).toBe(false);
    markDismissal(a);
    expect(isDismissal(a)).toBe(true);
    expect(isDismissal(b)).toBe(false);
  });

  it('is seen by a listener that heard the press before the panel closed', () => {
    // A view's canvas listener runs before the panels' listeners on `window`: it keeps the
    // event, and asks when the press ends.
    const target = new EventTarget();
    let kept: Event | null = null;
    target.addEventListener('pointerdown', (e) => (kept = e));
    target.addEventListener('pointerdown', (e) => markDismissal(e));
    const press = new Event('pointerdown');
    target.dispatchEvent(press);
    expect(kept).toBe(press);
    expect(isDismissal(kept!)).toBe(true);
    // The next press is a new event: with nothing open, nobody marks it.
    const view = new EventTarget();
    view.addEventListener('pointerdown', (e) => (kept = e));
    const next = new Event('pointerdown');
    view.dispatchEvent(next);
    expect(kept).toBe(next);
    expect(isDismissal(next)).toBe(false);
  });
});
