import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectsManifest } from '../src/api/assets';
import { EffectAtlases } from '../src/scene/effects';

const SHA = 'eb3459309669b3df6e053c2b74f4b5ffba362eab7fff1b514be83ae08882f7ef';

const MANIFEST: EffectsManifest = {
  cs2Build: '2000935',
  vrf: '20.1.7467',
  atlases: {
    fire: {
      file: 'fire.webp',
      bytes: 350938,
      sha256: SHA,
      width: 1024,
      height: 1008,
      cell: [64, 112],
      cols: 16,
      frames: 131,
      sequences: [
        [0, 12],
        [12, 11],
        [23, 12],
      ],
    },
    smoke: {
      file: 'smoke.webp',
      bytes: 168000,
      sha256: 'ff'.repeat(32),
      width: 1024,
      height: 512,
      cell: [128, 128],
      cols: 8,
      frames: 32,
      sequences: [[0, 32]],
    },
  },
};

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Atlases over stub fetches that count their calls. */
function stubbed(
  manifest: EffectsManifest | null = MANIFEST,
  fail = new Set<string>()
) {
  const json: string[] = [];
  const textures: string[] = [];
  const atlases = new EffectAtlases({
    fetchJson: async (url) => {
      json.push(url);
      return manifest;
    },
    loadTexture: async (url) => {
      textures.push(url);
      if ([...fail].some((f) => url.includes(f))) throw new Error('404');
      return new THREE.Texture();
    },
  });
  return { atlases, json, textures };
}

afterEach(() => vi.restoreAllMocks());

describe('EffectAtlases', () => {
  it('loads the manifest and an atlas the first time one is asked for, once each', async () => {
    const { atlases, json, textures } = stubbed();
    const ready: string[] = [];
    atlases.onReady((k) => ready.push(k));
    expect(atlases.get('fire')).toBeNull();
    expect(atlases.get('fire')).toBeNull();
    await flush();
    expect(json).toEqual(['/effects/manifest.json']);
    expect(textures).toEqual(['/effects/fire.webp?v=eb345930']);
    const fire = atlases.get('fire')!;
    expect(fire).not.toBeNull();
    expect([fire.cols, fire.rows, fire.frames]).toEqual([16, 9, 131]);
    expect(fire.sequences).toEqual(MANIFEST.atlases!.fire!.sequences);
    expect(fire.aspect).toBeCloseTo(64 / 112);
    expect(fire.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(fire.texture.flipY).toBe(true);
    expect(fire.texture.generateMipmaps).toBe(true);
    expect(ready).toEqual(['fire']);
    for (let i = 0; i < 10; i++) atlases.get('fire');
    await flush();
    expect(textures).toHaveLength(1);
    expect(atlases.get('smoke')).toBeNull();
    await flush();
    expect(json).toHaveLength(1);
    expect(textures).toEqual([
      '/effects/fire.webp?v=eb345930',
      '/effects/smoke.webp?v=ffffffff',
    ]);
    expect(atlases.get('smoke')?.cols).toBe(8);
    expect(ready).toEqual(['fire', 'smoke']);
  });

  it('asks for nothing before an effect needs an atlas', async () => {
    const { json, textures } = stubbed();
    await flush();
    expect(json).toHaveLength(0);
    expect(textures).toHaveLength(0);
  });

  it('without a manifest (404) every atlas is null, one warning, no refetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { atlases, json, textures } = stubbed(null);
    for (let i = 0; i < 10; i++)
      for (const k of ['fire', 'smoke', 'decals'] as const) {
        expect(atlases.get(k)).toBeNull();
        await flush();
      }
    expect(json).toHaveLength(1);
    expect(textures).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /^effects: .*; drawing generated sprites$/
    );
  });

  it('an atlas that fails, or the manifest lacks, stays null; the others still load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { atlases, textures } = stubbed(MANIFEST, new Set(['fire.webp']));
    for (let i = 0; i < 5; i++) {
      atlases.get('fire');
      atlases.get('decals');
      atlases.get('smoke');
      await flush();
    }
    expect(atlases.get('fire')).toBeNull();
    expect(atlases.get('decals')).toBeNull();
    expect(atlases.get('smoke')).not.toBeNull();
    expect(textures.filter((t) => t.includes('fire'))).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('takes an atlas listing a sequence of no frames as missing: null, one warning, nothing fetched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const smoke = MANIFEST.atlases!.smoke!;
    for (const sequences of [
      [
        [0, 16],
        [16, 0],
      ],
      [[0, -1]],
    ] as [number, number][][]) {
      warn.mockClear();
      const { atlases, textures } = stubbed({
        ...MANIFEST,
        atlases: { ...MANIFEST.atlases, smoke: { ...smoke, sequences } },
      });
      atlases.get('smoke');
      await flush();
      await flush();
      expect(atlases.get('smoke')).toBeNull();
      expect(textures.filter((t) => t.includes('smoke'))).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      // The others still load.
      atlases.get('fire');
      await flush();
      await flush();
      expect(atlases.get('fire')).not.toBeNull();
    }
  });

  it('after dispose nothing fires and late textures are freed', async () => {
    const { atlases } = stubbed();
    const ready = vi.fn();
    atlases.onReady(ready);
    atlases.get('fire');
    atlases.dispose();
    await flush();
    expect(ready).not.toHaveBeenCalled();
    expect(atlases.get('fire')).toBeNull();
  });

  it('onReady returns its unsubscribe', async () => {
    const { atlases } = stubbed();
    const ready = vi.fn();
    const off = atlases.onReady(ready);
    off();
    atlases.get('fire');
    await flush();
    expect(ready).not.toHaveBeenCalled();
  });
});
