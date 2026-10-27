// A map's radar: the game's radar images (`radar.png`, and `radar_lower.png` on two-level maps)
// and `overview.json` (tools/lib/overview.mjs), which places Source (x, y) on them with
// `worldToRadar` and says which altitudes each image covers. All three are in the map's
// manifest, so they are fetched versioned like the world.

import { assetUrl, mapManifest } from '../api/assets';
import { messageOf } from '../errors';

export interface Section {
  name: string;
  image: string;
  /** Source units; the section holds `altitudeMin <= z < altitudeMax`. */
  altitudeMin: number;
  altitudeMax: number;
}

export interface Overview {
  map: string;
  posX: number;
  posY: number;
  scale: number;
  /** The images' side in pixels (1024). */
  size: number;
  /** `default` first. */
  sections: Section[];
  /** 0–1 of the image. */
  bombA: [number, number] | null;
  bombB: [number, number] | null;
  /** The image's empty margins, 0–1 per side. */
  inset: { left: number; top: number; right: number; bottom: number };
}

const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

function point(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1])
    ? [v[0], v[1]]
    : null;
}

/** `overview.json` checked field by field; null when anything it needs is missing or wrong. */
export function parseOverview(raw: unknown): Overview | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.map !== 'string') return null;
  if (!isNum(o.posX) || !isNum(o.posY) || !isNum(o.scale) || o.scale <= 0)
    return null;
  const size = isNum(o.size) && o.size > 0 ? o.size : 1024;
  if (!Array.isArray(o.sections) || o.sections.length === 0) return null;
  const sections: Section[] = [];
  for (const s of o.sections as unknown[]) {
    const v = (s ?? {}) as Record<string, unknown>;
    if (
      typeof v.name !== 'string' ||
      typeof v.image !== 'string' ||
      !/^[a-z0-9_]+\.png$/.test(v.image) ||
      !isNum(v.altitudeMin) ||
      !isNum(v.altitudeMax)
    )
      return null;
    sections.push({
      name: v.name,
      image: v.image,
      altitudeMin: v.altitudeMin,
      altitudeMax: v.altitudeMax,
    });
  }
  sections.sort((a, b) =>
    a.name === 'default' ? -1 : b.name === 'default' ? 1 : 0
  );
  const inset = (o.inset ?? {}) as Record<string, unknown>;
  const side = (v: unknown) => (isNum(v) ? Math.min(0.45, Math.max(0, v)) : 0);
  return {
    map: o.map,
    posX: o.posX,
    posY: o.posY,
    scale: o.scale,
    size,
    sections,
    bombA: point(o.bombA),
    bombB: point(o.bombB),
    inset: {
      left: side(inset.left),
      top: side(inset.top),
      right: side(inset.right),
      bottom: side(inset.bottom),
    },
  };
}

/** The section that holds altitude `z`; the default section (0) when none does. */
export function sectionAt(ov: Overview, z: number): number {
  for (let i = 0; i < ov.sections.length; i++) {
    const s = ov.sections[i];
    if (z >= s.altitudeMin && z < s.altitudeMax) return i;
  }
  return 0;
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of the image the map fills (radar pixels): the image less its inset, squared about
 * its centre and moved back inside the image where the square would leave it.
 */
export function cropOf(ov: Overview): Crop {
  const { left, top, right, bottom } = ov.inset;
  const n = ov.size;
  const w = n * (1 - left - right);
  const h = n * (1 - top - bottom);
  const side = Math.min(n, Math.max(w, h));
  const cx = n * (left + (1 - left - right) / 2);
  const cy = n * (top + (1 - top - bottom) / 2);
  const clamp = (c: number) => Math.min(n - side, Math.max(0, c - side / 2));
  return { x: clamp(cx), y: clamp(cy), w: side, h: side };
}

export interface RadarAssets {
  ov: Overview;
  /** One per section, in `ov.sections` order. */
  images: ImageBitmap[];
}

async function image(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

/**
 * The radar of `map`: its overview and one decoded image per section; null when the map has no
 * manifest, no overview or an image that does not load (the viewer then has no radar).
 */
export async function loadRadar(
  map: string,
  signal?: AbortSignal
): Promise<RadarAssets | null> {
  const base = `/maps/${encodeURIComponent(map)}`;
  // Without a manifest (none for the map, or a failed request) each file is asked for unversioned.
  const manifest = await mapManifest(map).catch(() => null);
  const sha = (file: string) => manifest?.files?.[file]?.sha256;
  try {
    const res = await fetch(
      assetUrl(`${base}/overview.json`, sha('overview.json')),
      { signal }
    );
    const ov = res.ok ? parseOverview(await res.json()) : null;
    if (!ov) return null;
    const images = await Promise.all(
      ov.sections.map((s) =>
        image(assetUrl(`${base}/${s.image}`, sha(s.image)), signal)
      )
    );
    return { ov, images };
  } catch (e) {
    if (signal?.aborted) return null;
    console.warn(`radar ${map}: ${messageOf(e)}`);
    return null;
  }
}
