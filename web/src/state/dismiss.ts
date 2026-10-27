// A press outside an open panel (Settings, the player sheet, the scoreboard, Highlights, the
// Share field) closes it and does nothing else. Each panel's outside-press handler marks the
// `pointerdown` that closed it, and a view that acts on a tap (the 3D view, the full radar)
// skips a tap whose press is marked. The panels listen on `window`, so they hear the press
// after a view's own listener on its canvas: a view asks when the press ends, not when it
// starts, keeping the `pointerdown` event until then. Every panel closes the same way
// (`useDismiss`), so one Escape and one press each close one thing.

import { useEffect, useRef, type RefObject } from 'react';

const spent = new WeakSet<Event>();

/** The `pointerdown` `e` closed a panel: the press is spent on that. */
export function markDismissal(e: Event): void {
  spent.add(e);
}

/** Whether the `pointerdown` `e` closed a panel. */
export function isDismissal(e: Event): boolean {
  return spent.has(e);
}

/**
 * Whether a keydown is an Escape that closes a panel which is `open`: one no other panel has
 * spent yet. The panel that closes calls `preventDefault`, so that the other panels and the
 * key map (`handleKey`) leave the same Escape alone.
 */
export function escapeCloses(
  e: { key: string; defaultPrevented?: boolean },
  open: boolean
): boolean {
  return open && e.key === 'Escape' && !e.defaultPrevented;
}

export interface DismissOptions {
  /**
   * Whether Escape closes the panel (default true). A panel whose Escape is someone else's
   * (the key map closes the highlights; the scoreboard reads its own keys) says false.
   */
  escape?: boolean;
  /**
   * A press outside the panel that leaves it open: a toggle elsewhere on the page that opens
   * and closes the panel itself.
   */
  ignore?: (target: Element) => boolean;
}

/**
 * While `open`, closes the panel in `root` (`close`) on a press outside it, marking that
 * `pointerdown` spent (`markDismissal`), and on an Escape no other panel has spent, which it
 * spends (`escapeCloses`, then `preventDefault`). Escape is heard in the capture phase, before
 * the key map (DemoView), which leaves a spent one alone. The listeners stay put while the
 * panel is open, whatever `close` and `ignore` are at each render: the latest ones are called.
 */
export function useDismiss(
  open: boolean,
  root: RefObject<Element | null>,
  close: () => void,
  { escape = true, ignore }: DismissOptions = {}
): void {
  const latest = useRef({ close, ignore });
  useEffect(() => {
    latest.current = { close, ignore };
  });
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (!escapeCloses(e, true)) return;
      e.preventDefault();
      latest.current.close();
    };
    const press = (e: PointerEvent) => {
      const t = e.target;
      if (t instanceof Node && root.current?.contains(t)) return;
      if (t instanceof Element && latest.current.ignore?.(t)) return;
      markDismissal(e);
      latest.current.close();
    };
    if (escape) window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', press);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', press);
    };
  }, [open, root, escape]);
}
