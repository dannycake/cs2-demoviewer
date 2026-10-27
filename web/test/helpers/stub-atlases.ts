// Effect atlases for tests: the manifest a test gives, and each atlas's texture arriving when
// the test says (`release`), so a test sees an effect before and after its frames are in.

import * as THREE from 'three';
import type { EffectsManifest } from '../../src/api/assets';
import { EffectAtlases, type EffectKey } from '../../src/scene/effects';

/** Lets pending promises (a manifest, a texture) settle. */
export const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Atlases whose textures arrive when the test says (`release`); `manifest` null is a 404.
 * Nothing is fetched until an effect asks: `fetches` counts the manifest's fetches and `pending`
 * holds each atlas file asked for.
 */
export function stubAtlases(manifest: EffectsManifest | null) {
  const pending = new Map<string, (t: THREE.Texture) => void>();
  const textures = new Map<string, THREE.Texture>();
  let fetches = 0;
  const atlases = new EffectAtlases({
    fetchJson: async () => {
      fetches++;
      return manifest;
    },
    loadTexture: (url) =>
      new Promise((resolve) => {
        const file = url.replace(/^\/effects\/|\?.*$/g, '');
        pending.set(file, resolve);
      }),
  });
  const ready: EffectKey[] = [];
  atlases.onReady((k) => ready.push(k));
  const release = async (file: string) => {
    await flush();
    // The image's size, as a loaded atlas has it.
    const entry = Object.values(manifest?.atlases ?? {}).find(
      (a) => a?.file === file
    );
    const t = new THREE.Texture(
      entry
        ? ({ width: entry.width, height: entry.height } as HTMLImageElement)
        : undefined
    );
    textures.set(file, t);
    pending.get(file)?.(t);
    await flush();
  };
  return {
    atlases,
    release,
    ready,
    textures,
    pending,
    get fetches() {
      return fetches;
    },
  };
}

/** Atlases that never arrive (the manifest never answers): every effect draws its generated sprite. */
export function noAtlases(): EffectAtlases {
  return new EffectAtlases({ fetchJson: () => new Promise(() => {}) });
}
