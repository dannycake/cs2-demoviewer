// A map's strip behind its name in the profile's tables (`.strip` in profile.module.css): CS2's
// screenshot of the map, darkened and gone to black by the cell's right edge. Without one the
// cell is as it was, plain black: a manifest from before the strips, or a map with none.

import type { CSSProperties } from 'react';
import { mapStripUrl, type SiteAssets } from '../../api/site-assets';
import s from './profile.module.css';

/** The class and style of a map's cell of class `base`: with `map`'s strip behind it when the
 * site has one. */
export function stripCell(
  assets: SiteAssets | null,
  map: string | null | undefined,
  base: string
): { className: string; style?: CSSProperties } {
  const url = map ? mapStripUrl(assets, map) : null;
  if (!url) return { className: base };
  return {
    className: `${base} ${s.strip}`,
    style: { '--strip': `url("${url}")` } as CSSProperties,
  };
}
