// Whether the scoreboard is open: while Tab is held, or until closed after a click on the
// player card. Kept apart from the playback store; nothing else reads it.

import { create } from 'zustand';

export interface ScoreboardState {
  held: boolean;
  pinned: boolean;
  setHeld(held: boolean): void;
  togglePinned(): void;
  close(): void;
}

export const useScoreboard = create<ScoreboardState>((set) => ({
  held: false,
  pinned: false,
  setHeld: (held) => set({ held }),
  togglePinned: () => set((s) => ({ pinned: !s.pinned })),
  close: () => set({ held: false, pinned: false }),
}));

/**
 * What a key press means for the scoreboard, if anything. Tab is the keyboard's way between
 * controls too: it holds the scoreboard when no control has focus (`onPage`: the page or the 3D
 * view), or once held down on one (its repeat), and never with Shift.
 */
export function scoreboardKey(
  e: Pick<KeyboardEvent, 'key' | 'type' | 'repeat'> & { shiftKey?: boolean },
  onPage = true
): 'hold' | 'release' | 'close' | null {
  if (e.key === 'Tab') {
    if (e.type !== 'keydown') return 'release';
    if (e.shiftKey) return null;
    return onPage || e.repeat ? 'hold' : null;
  }
  if (e.key === 'Escape' && e.type === 'keydown') return 'close';
  return null;
}
