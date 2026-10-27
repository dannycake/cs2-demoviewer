// CS2's own particle and decal textures (`tools/build-effects.mjs`), one flipbook atlas per
// effect under `/effects/`. Nothing is fetched until an effect first asks for its atlas: then
// the manifest (once) and that atlas (once). Until it arrives, and for good when it cannot be
// had (an asset set from before the atlases, a 404, a broken file), `get` is null and the
// effect draws its generated sprite; that is warned about once.

import * as THREE from 'three';
import {
  assetUrl,
  fetchManifest,
  type EffectAtlasEntry,
  type EffectsManifest,
} from '../api/assets';

export type EffectKey =
  | 'fire'
  | 'fireburst'
  | 'explosion'
  | 'smoke'
  | 'dust'
  | 'muzzle'
  | 'flare'
  | 'sparks'
  | 'debris'
  | 'blood'
  | 'decals';

export interface Atlas {
  texture: THREE.Texture;
  cols: number;
  rows: number;
  frames: number;
  /** [first frame, count] per sequence. */
  sequences: readonly (readonly [number, number])[];
  /** A cell's width ÷ its height. */
  aspect: number;
}

export interface EffectAtlasesOptions {
  /** Where the atlases are served, default `/effects`. */
  base?: string;
  /** The manifest's JSON, null when it cannot be had. */
  fetchJson?: (url: string) => Promise<EffectsManifest | null>;
  loadTexture?: (url: string) => Promise<THREE.Texture>;
}

const loadTexture = (url: string) => new THREE.TextureLoader().loadAsync(url);

export class EffectAtlases {
  private readonly base: string;
  private readonly fetchJson: (url: string) => Promise<EffectsManifest | null>;
  private readonly loadTexture: (url: string) => Promise<THREE.Texture>;
  private manifest: Promise<EffectsManifest | null> | null = null;
  private readonly ready = new Map<EffectKey, Atlas>();
  /** Keys asked for (loading, loaded or failed): each is loaded at most once. */
  private readonly asked = new Set<EffectKey>();
  private readonly listeners = new Set<(key: EffectKey) => void>();
  private warned = false;
  private disposed = false;

  constructor(opts: EffectAtlasesOptions = {}) {
    this.base = opts.base ?? '/effects';
    this.fetchJson = opts.fetchJson ?? fetchManifest<EffectsManifest>;
    this.loadTexture = opts.loadTexture ?? loadTexture;
  }

  /** The atlas of `key`, or null while it loads or when it cannot be had; the first call loads it. */
  get(key: EffectKey): Atlas | null {
    const a = this.ready.get(key);
    if (a || this.asked.has(key) || this.disposed) return a ?? null;
    this.asked.add(key);
    this.manifest ??= this.fetchJson(`${this.base}/manifest.json`).catch(
      () => null
    );
    void this.manifest.then((m) => this.load(key, m));
    return null;
  }

  /** Calls `cb` with each key whose atlas arrives; returns the unsubscribe. */
  onReady(cb: (key: EffectKey) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    for (const a of this.ready.values()) a.texture.dispose();
    this.ready.clear();
  }

  private async load(key: EffectKey, m: EffectsManifest | null): Promise<void> {
    if (this.disposed) return;
    if (!m) return this.warn(`no ${this.base}/manifest.json`);
    const e = m.atlases?.[key];
    if (!isEntry(e)) return this.warn(`the manifest has no atlas ${key}`);
    let texture: THREE.Texture;
    try {
      texture = await this.loadTexture(
        assetUrl(`${this.base}/${e.file}`, e.sha256)
      );
    } catch (err) {
      return this.warn(`${e.file}: ${String((err as Error)?.message ?? err)}`);
    }
    if (this.disposed) {
      texture.dispose();
      return;
    }
    texture.name = `effects/${key}`;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    this.ready.set(key, {
      texture,
      cols: e.cols,
      rows: Math.round(e.height / e.cell[1]),
      frames: e.frames,
      sequences: e.sequences,
      aspect: e.cell[0] / e.cell[1],
    });
    for (const l of this.listeners) l(key);
  }

  private warn(reason: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`effects: ${reason}; drawing generated sprites`);
  }
}

/**
 * Whether `e` is an atlas entry the batches can draw from: a cell, a grid and frames, and
 * sequences each of at least one frame (a sequence of none would make a frame of NaN).
 */
function isEntry(e: EffectAtlasEntry | undefined): e is EffectAtlasEntry {
  return (
    !!e &&
    typeof e.file === 'string' &&
    Array.isArray(e.cell) &&
    e.cell[0] > 0 &&
    e.cell[1] > 0 &&
    e.cols > 0 &&
    e.frames > 0 &&
    e.height > 0 &&
    Array.isArray(e.sequences) &&
    e.sequences.length > 0 &&
    e.sequences.every((q) => Array.isArray(q) && q[0] >= 0 && q[1] > 0)
  );
}
