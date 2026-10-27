// The fly camera's keys: `W A S D` move along the view, `Q`/`E` go down and up, and `Shift` goes
// faster (`scene/flycam`). In Free the keyboard map leaves them to it (`state/keys`).

/** The `KeyboardEvent.code`s the fly camera reads (Shift aside). */
export const FLY_KEYS: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
]);
/** The Shift `code`s, any of which flies faster. */
export const SHIFT_KEYS: readonly string[] = [
  'ShiftLeft',
  'ShiftRight',
  'Shift',
];

/** Whether the fly camera reads this key (a movement key or a Shift). */
export function isFlyKey(code: string): boolean {
  return FLY_KEYS.has(code) || SHIFT_KEYS.includes(code);
}
