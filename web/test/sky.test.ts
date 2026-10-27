// SkyAndFog's lifecycle on its own (sky.ts): one load of the map's sky.webp, asked for the first
// time a preset shows it; a sky replaced or disposed while on its way is freed when it lands
// and never drawn; the post stack's copy is made again after a lost context; dispose frees the
// texture and the copy it made and nothing else. The scene's own tests (scene-map.test) cover
// how a map's load sets it. Neither the image loader nor the post stack's GPU copy run in node:
// both are stubbed.

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atmosphereFor } from '../src/scene/atmosphere';

/** The sky loads asked for, each settled by the test. */
const skies = vi.hoisted(() => ({
  urls: [] as string[],
  settle: [] as {
    resolve: (t: unknown) => void;
    reject: (e: unknown) => void;
  }[],
}));
/** The post stack's sky copies made, in order. */
const copies = vi.hoisted(
  () =>
    [] as {
      source: unknown;
      threshold: number;
      disposed: number;
      texture: unknown;
    }[]
);

vi.mock('../src/scene/loaders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/loaders')>()),
  loadSky: (url: string) =>
    new Promise((resolve, reject) => {
      skies.urls.push(url);
      skies.settle.push({ resolve, reject });
    }),
}));

vi.mock('../src/scene/post', async (importOriginal) => {
  const three = await import('three');
  class SkyBehindNeutral {
    readonly texture = new three.Texture();
    readonly source: unknown;
    readonly exposure: number;
    readonly intensity: number;
    readonly threshold: number;
    disposed = 0;
    constructor(
      _renderer: unknown,
      source: unknown,
      exposure: number,
      intensity: number,
      threshold: number
    ) {
      this.source = source;
      this.exposure = exposure;
      this.intensity = intensity;
      this.threshold = threshold;
      copies.push(this);
    }
    dispose() {
      this.disposed++;
    }
  }
  return {
    ...(await importOriginal<typeof import('../src/scene/post')>()),
    SkyBehindNeutral,
  };
});

const { SkyAndFog } = await import('../src/scene/sky');
const { BAKED_BLOOM_WHITE } = await import('../src/scene/post');

const URL = '/maps/de_mirage/sky.webp?v=dddddddd';
const MIRAGE = atmosphereFor('de_mirage');

/** A sky and fog in a fresh scene, its post stack `on` or off. */
function make(on: boolean, shows = true) {
  const scene = new THREE.Scene();
  const renderer = {
    toneMappingExposure: 0,
  } as unknown as THREE.WebGLRenderer;
  const post = {
    enabled: on,
    setBloomThreshold: vi.fn(),
    setEffectsBloom: vi.fn(),
  };
  const sky = new SkyAndFog(
    renderer,
    scene,
    post as unknown as ConstructorParameters<typeof SkyAndFog>[2],
    shows
  );
  return { scene, renderer, post, sky };
}

/** A loaded sky texture whose uploads (`dispose`) are counted. */
function texture() {
  const t = new THREE.Texture();
  const dispose = vi.spyOn(t, 'dispose');
  return { t, dispose };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  skies.urls.length = 0;
  skies.settle.length = 0;
  copies.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('SkyAndFog', () => {
  it('starts dark with the fog out of reach, and paints the map once it has an atmosphere', () => {
    const { scene, renderer, sky } = make(false);
    expect(scene.background).toBe(sky.skyColor);
    expect(scene.fog).toBe(sky.fog);
    expect(sky.fog.near).toBeGreaterThan(1e6);
    sky.setSky('de_mirage', URL, '#405060');
    sky.setAtmosphere(MIRAGE, false);
    expect(renderer.toneMappingExposure).toBe(MIRAGE.exposure);
    expect(sky.skyColor.getHex()).toBe(0x405060);
    sky.placeFog(false, null);
    expect(sky.fog.near).toBe(MIRAGE.fogNear);
    expect(sky.fog.color.getHex()).toBe(0x405060);
    // The first paint that shows the sky asked for it, once.
    expect(skies.urls).toEqual([URL]);
    sky.setPreset(true);
    expect(skies.urls).toEqual([URL]);
  });

  it('asks for nothing while the preset shows no sky', () => {
    const { sky } = make(false, false);
    sky.setSky('de_mirage', URL, null);
    sky.setAtmosphere(MIRAGE, false);
    expect(skies.urls).toEqual([]);
    sky.setPreset(true);
    expect(skies.urls).toEqual([URL]);
  });

  it('draws the sky when it lands and tells the scene to draw', async () => {
    const { scene, sky } = make(false);
    const drawn = vi.fn();
    sky.onLoad = drawn;
    sky.setSky('de_mirage', URL, null);
    sky.setAtmosphere(MIRAGE, false);
    const { t } = texture();
    skies.settle[0].resolve(t);
    await flush();
    expect(scene.background).toBe(t);
    expect(drawn).toHaveBeenCalledTimes(1);
  });

  it('frees a sky that lands after it was replaced or disposed, and never draws it', async () => {
    const { scene, sky } = make(false);
    const drawn = vi.fn();
    sky.onLoad = drawn;
    sky.setSky('de_mirage', URL, null);
    sky.setAtmosphere(MIRAGE, false);
    sky.setSky('de_mirage', `${URL}2`, null);
    const old = texture();
    skies.settle[0].resolve(old.t);
    await flush();
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(scene.background).not.toBe(old.t);
    // The new one is asked for at the next paint; disposed before it lands.
    sky.setPreset(true);
    expect(skies.urls).toEqual([URL, `${URL}2`]);
    sky.dispose();
    const late = texture();
    skies.settle[1].resolve(late.t);
    await flush();
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(scene.background).not.toBe(late.t);
    expect(drawn).not.toHaveBeenCalled();
  });

  it('keeps the colour sky after a failed load, and asks no more; a failure after dispose says nothing', async () => {
    const { scene, sky } = make(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sky.setSky('de_mirage', URL, null);
    sky.setAtmosphere(MIRAGE, false);
    skies.settle[0].reject(new Event('error'));
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.lastCall?.[0])).toContain(URL);
    sky.setPreset(true);
    expect(skies.urls).toEqual([URL]);
    expect(scene.background).toBe(sky.skyColor);
    const other = make(false);
    other.sky.setSky('de_nuke', URL, null);
    other.sky.setAtmosphere(MIRAGE, false);
    other.sky.dispose();
    skies.settle[1].reject(new Error('404'));
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("through the post stack draws a copy held to the bake's threshold, made again after a lost context", async () => {
    const { scene, post, sky } = make(true);
    sky.setSky('de_mirage', URL, null);
    sky.setAtmosphere(MIRAGE, true);
    expect(post.setEffectsBloom).toHaveBeenLastCalledWith(true);
    const { t, dispose } = texture();
    skies.settle[0].resolve(t);
    await flush();
    expect(copies).toHaveLength(1);
    expect(copies[0].source).toBe(t);
    const threshold = BAKED_BLOOM_WHITE / MIRAGE.bakedExposure;
    expect(copies[0].threshold).toBeCloseTo(threshold, 12);
    expect(post.setBloomThreshold).toHaveBeenLastCalledWith(
      copies[0].threshold
    );
    expect(scene.background).toBe(copies[0].texture);
    // The copy is all that draws: the source's upload is freed.
    expect(dispose).toHaveBeenCalledTimes(1);
    sky.restore();
    expect(copies[0].disposed).toBe(1);
    expect(copies).toHaveLength(2);
    expect(scene.background).toBe(copies[1].texture);
    expect(skies.urls).toEqual([URL]);
  });

  it('frees the copy and the upload at a preset without the sky, and keeps the image for the next', async () => {
    const { scene, post, sky } = make(true);
    sky.setSky('de_mirage', URL, null);
    sky.setAtmosphere(MIRAGE, false);
    const { t, dispose } = texture();
    skies.settle[0].resolve(t);
    await flush();
    post.enabled = false;
    sky.setPreset(false);
    expect(copies[0].disposed).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(scene.background).toBe(sky.skyColor);
    sky.setPreset(true);
    expect(scene.background).toBe(t);
    expect(skies.urls).toEqual([URL]);
  });

  it('frees on dispose the texture and the copy it made, and nothing of the scene', async () => {
    const { scene, post, sky } = make(true);
    sky.setSky('de_mirage', URL, null);
    sky.setAtmosphere(MIRAGE, false);
    const { t, dispose } = texture();
    skies.settle[0].resolve(t);
    await flush();
    const fog = scene.fog;
    const uploads = dispose.mock.calls.length;
    sky.dispose();
    expect(dispose).toHaveBeenCalledTimes(uploads + 1);
    expect(copies[0].disposed).toBe(1);
    expect(scene.fog).toBe(fog);
    expect(post.setBloomThreshold).toHaveBeenCalledTimes(1);
  });
});
