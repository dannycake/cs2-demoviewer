// The team colours every view draws a side in, the HUD's `--t` and `--ct` (styles/tokens.css):
// the players' tint and outlines, their name tags, the damage numbers and the radar's discs.

/** A side's colour as 0xrrggbb, by team number: 2 is T, 3 is CT. */
export const TEAM_HEX: Readonly<Record<number, number>> = Object.freeze({
  2: 0xf2a33a,
  3: 0x4da3ff,
});

/** `hex` (0xrrggbb) as a CSS colour, `#rrggbb`. */
export function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}
