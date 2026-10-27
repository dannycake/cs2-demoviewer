// Where a weapon's silhouette sits in `public/weapons.png` (made by tools/weapon-icons.mjs) and
// the CSS that shows it at a given height.

import type { CSSProperties } from 'react';
import sheet from '../weapon-icons.json';

const ICONS = sheet.icons as Record<
  string,
  { x: number; y: number; w: number; h: number } | undefined
>;

/**
 * The style of a silhouette of `name` `height` units tall (`em` by default, so it scales with
 * the text around it), or null for a weapon without one.
 */
export function spriteStyle(
  name: string,
  height: number,
  unit: 'em' | 'px' = 'em'
): CSSProperties | null {
  const icon = ICONS[name];
  if (!icon) return null;
  const k = height / icon.h;
  const u = (v: number) => `${+v.toFixed(4)}${unit}`;
  return {
    width: u(icon.w * k),
    height: u(height),
    backgroundImage: 'url(/weapons.png)',
    backgroundSize: `${u(sheet.width * k)} ${u(sheet.height * k)}`,
    backgroundPosition: `${u(-icon.x * k)} ${u(-icon.y * k)}`,
  };
}
