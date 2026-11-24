// The site's own images, from `/site/manifest.json` (tools/README.md, Site): the Competitive rank
// icons, the Steam logo, each map's strip and the homepage video, each asked for with its version
// (`assetUrl`). They are CS2's and Valve's files, so they live with the assets, never in web/.

import { assetUrl, fetchManifest } from './assets';

export interface SiteFile {
  file: string;
  sha256: string;
  bytes: number;
}

export interface SiteAssets {
  /** `"0"` (unranked) to `"18"` (Global Elite), and `"none"`. */
  ranks: Record<string, SiteFile>;
  steamLogo: SiteFile;
  /**
   * Each map's strip of CS2's screenshot of it, by map (`de_mirage`), 640×160: absent from a
   * manifest made before them, and a map without a screenshot has none.
   */
  maps?: Record<string, SiteFile>;
  /** Absent until tools/home-video.sh made it. */
  home: { mp4: SiteFile; webm: SiteFile; poster: SiteFile } | null;
}

let cached: Promise<SiteAssets | null> | null = null;

/** The site manifest, fetched once a page; null when the server has none. */
export function siteAssets({ fresh = false } = {}): Promise<SiteAssets | null> {
  if (!cached || fresh)
    cached = fetchManifest<SiteAssets>('/site/manifest.json');
  return cached;
}

const url = (f: SiteFile) => assetUrl(`/site/${f.file}`, f.sha256);

/** The icon of Competitive rank `rank` (1 to 18); the unranked one for null, 0 or any other. */
export function rankIconUrl(a: SiteAssets, rank: number | null): string | null {
  const f = (rank && a.ranks[String(rank)]) || a.ranks.none;
  return f ? url(f) : null;
}

export function steamLogoUrl(a: SiteAssets): string {
  return url(a.steamLogo);
}

export function homeVideo(
  a: SiteAssets
): { mp4: string; webm: string; poster: string } | null {
  if (!a.home) return null;
  return {
    mp4: url(a.home.mp4),
    webm: url(a.home.webm),
    poster: url(a.home.poster),
  };
}

/** A file name that can go into a CSS `url("…")` as it is. */
const PLAIN_PATH = /^[\w./-]+$/;

/**
 * The strip of `map`'s screenshot, which a profile sets behind the map's rows; null when the
 * manifest has none for it (or none at all, made before the strips), or names a file that is not
 * a plain path, since the URL goes into a style.
 */
export function mapStripUrl(a: SiteAssets | null, map: string): string | null {
  const f = a?.maps && Object.hasOwn(a.maps, map) ? a.maps[map] : undefined;
  return typeof f?.file === 'string' && PLAIN_PATH.test(f.file) ? url(f) : null;
}
