// Asset URLs: every file a manifest lists is asked for as `<path>?v=<the first 8 hex of its
// sha256>`. The server caches a versioned request for a year without revalidating
// (server/README.md), so a match's assets download once per build of them; a file asked for
// before its manifest is in, or missing from it, goes unversioned and is revalidated.

/** `path` with `?v=<8 hex>` when `sha256` is a hex digest; `path` as it is otherwise. */
export function assetUrl(path: string, sha256: string | undefined): string {
  if (!sha256 || !/^[0-9a-f]{8}/i.test(sha256)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}v=${sha256.slice(0, 8).toLowerCase()}`;
}

/** The JSON body of `res`, or null when it is not JSON (or cannot be read). */
export async function jsonOrNull<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** The JSON at `url`, or null when the request fails, answers an error or is not JSON. */
export async function fetchManifest<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await jsonOrNull<T>(res) : null;
  } catch {
    return null;
  }
}

/** One side's model in `/players/manifest.json`. */
export interface PlayerModelEntry {
  sha256?: string;
  /**
   * The phone tier of the model (`tools/phone-tier.mjs`): the same model with its textures
   * within `textureSize` px, in `file` beside it; absent where it was not built.
   */
  lo?: { file?: string; textureSize?: number; sha256?: string };
}

/** `/players/manifest.json`: one entry per side model. */
export interface PlayersManifest {
  t?: PlayerModelEntry;
  ct?: PlayerModelEntry;
}

/**
 * `/maps/<map>/manifest.json` (tools/manifest.mjs): the files built for the map by name, and
 * what the viewer reads beside them. Read as the server sends it, so any field may be missing;
 * the fields the viewer does not read (an older build's `hd` among them) are left out.
 */
export interface MapManifest {
  /** `world_lo.glb` among them where the phone tier was built (`lo`). */
  files?: Record<string, { bytes?: number; sha256?: string } | undefined>;
  /** With sky.webp: its horizon colour (`#rrggbb`), the fog's and the sky's below the horizon. */
  sky?: { horizon?: string };
  /** With world_lo.glb: the size its textures are within. */
  lo?: { textureSize?: number };
}

/** The map manifests asked for, by map: in flight, or in (kept for the page's life). */
const mapManifests = new Map<string, Promise<MapManifest | null>>();

/**
 * The manifest of `map`, the one request the viewer reads it from (the page's "no assets"
 * notice, the 3D view, the radar): null when the server has no assets for the map (404), an
 * empty manifest when the answer is not JSON (each file is then asked for unversioned), and a
 * rejection with `manifest: HTTP <status>` on any other error status, or the request's own
 * failure. Calls for one map share its request while it is in flight and the manifest once it
 * is in; a 404 or a failure is not kept, so the next call asks again (the map's assets may
 * have been built since, or the server be back).
 */
export function mapManifest(map: string): Promise<MapManifest | null> {
  const had = mapManifests.get(map);
  if (had) return had;
  const load = fetchMapManifest(map);
  mapManifests.set(map, load);
  const drop = () => {
    if (mapManifests.get(map) === load) mapManifests.delete(map);
  };
  load.then((m) => {
    if (m === null) drop();
  }, drop);
  return load;
}

/** Forgets every map manifest kept: the next call for each asks the server again. */
export function forgetMapManifests(): void {
  mapManifests.clear();
}

async function fetchMapManifest(map: string): Promise<MapManifest | null> {
  const res = await fetch(`/maps/${encodeURIComponent(map)}/manifest.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  return (await jsonOrNull<MapManifest>(res)) ?? {};
}

/** One atlas of `/effects/manifest.json`: frames in cells, frame 0 the top-left one. */
export interface EffectAtlasEntry {
  file: string;
  bytes?: number;
  sha256?: string;
  width: number;
  height: number;
  /** One frame's cell, [width, height] in pixels. */
  cell: [number, number];
  cols: number;
  frames: number;
  /** [first frame, count] per sequence. */
  sequences: [number, number][];
}

/** `/effects/manifest.json` (`tools/manifest.mjs effects`): the effect atlases by key. */
export interface EffectsManifest {
  cs2Build?: string;
  vrf?: string;
  atlases?: Partial<Record<string, EffectAtlasEntry>>;
}
