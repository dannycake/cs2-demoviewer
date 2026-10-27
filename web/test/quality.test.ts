// The quality presets (Task 4): what each preset turns on, the auto-detect rule, the `Q` key,
// the setting's persistence, and `Scene.setQuality` switching a loaded world's look, shadows,
// tone mapping and pixel ratio in place, freeing what the previous preset made. WebGL does
// not exist in node, so the renderer, the GLB loader and the detail texture are stubbed as in
// scene-map.test.ts; the stub renderer has no float targets unless a test gives it them, so
// `high` runs without its post stack, as it does on such a device.

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetMapManifests } from '../src/api/assets';
import { atmosphereFor } from '../src/scene/atmosphere';
import { hasDetail } from '../src/scene/detail';
import type { Lighting } from '../src/scene/lighting';
import type { PostStack } from '../src/scene/post';
import type { LookOptions } from '../src/scene/look';
import {
  AUTO_HIGH_FPS,
  AUTO_LOW_FPS,
  DEFAULT_QUALITY,
  PRESETS,
  QUALITIES,
  autoQuality,
  nextQuality,
  type Quality,
} from '../src/scene/quality';
import { handleKey } from '../src/state/keys';
import { QUALITY_KEY, createPlaybackStore } from '../src/state/store';
import type { PrefsStorage } from '../src/state/storage';
import { playbackPack } from './helpers/playback-pack';

/** Whether the stub renderer draws into float targets, which the post stack needs. */
const device = vi.hoisted(() => ({ floatTargets: false }));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    readonly info = { render: { triangles: 0 }, autoReset: true, reset() {} };
    readonly capabilities = { getMaxAnisotropy: () => 16 };
    readonly extensions = {
      has: (name: string) =>
        device.floatTargets &&
        (name === 'EXT_color_buffer_float' ||
          name === 'EXT_color_buffer_half_float'),
    };
    readonly shadowMap = { enabled: false, type: 0 };
    toneMapping = 0;
    toneMappingExposure = 1;
    pixelRatio = 1;
    private readonly size = new three.Vector2(1600, 900);
    setPixelRatio(r: number) {
      this.pixelRatio = r;
    }
    getPixelRatio() {
      return this.pixelRatio;
    }
    getSize(out: THREE.Vector2) {
      return out.copy(this.size);
    }
    setSize(w: number, h: number) {
      this.size.set(w, h);
    }
    render() {}
    dispose() {}
    forceContextLoss() {}
  }
  return { ...three, WebGLRenderer: FakeRenderer };
});

/** A one-mesh world without normals, textured, as `loadWorld` loads it (the scene dresses it). */
const loadWorld = vi.hoisted(() =>
  vi.fn<(url: string) => Promise<THREE.Group>>()
);
vi.mock('../src/scene/loaders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/loaders')>()),
  loadWorld,
  loadHull: async () => new THREE.BoxGeometry(1, 1, 1),
}));
const detailTexture = vi.hoisted(() => ({ name: 'detail', dispose() {} }));
vi.mock('../src/scene/detail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/detail')>()),
  loadDetailTexture: async () => detailTexture,
}));

const { Scene } = await import('../src/scene/Scene');

// Each test serves its own manifests: none is kept from the last one's.
beforeEach(forgetMapManifests);

function makeWorld(): THREE.Group {
  const geo = new THREE.BoxGeometry(60, 10, 60);
  geo.deleteAttribute('normal');
  const map = new THREE.Texture();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map })));
  return g;
}

// ---------------------------------------------------------------- presets and rules

describe('quality presets', () => {
  it('auto-detects from the frame rate at medium', () => {
    expect(autoQuality(120)).toBe('high');
    expect(autoQuality(30)).toBe('low');
    expect(autoQuality(60)).toBe('medium');
    expect(autoQuality(AUTO_HIGH_FPS)).toBe('high');
    expect(autoQuality(AUTO_HIGH_FPS - 0.1)).toBe('medium');
    expect(autoQuality(AUTO_LOW_FPS)).toBe('medium');
    expect(autoQuality(AUTO_LOW_FPS - 0.1)).toBe('low');
    // A failed measurement keeps the default.
    expect(autoQuality(Number.NaN)).toBe(DEFAULT_QUALITY);
  });

  it('defaults to medium and cycles low → medium → high → low', () => {
    expect(DEFAULT_QUALITY).toBe('medium');
    expect(QUALITIES).toEqual(['low', 'medium', 'high']);
    expect(nextQuality('low')).toBe('medium');
    expect(nextQuality('medium')).toBe('high');
    expect(nextQuality('high')).toBe('low');
  });

  it('turns on light, shadows, post and pixel ratio by preset', () => {
    expect(PRESETS.low).toMatchObject({
      lit: false,
      shadows: 0,
      post: false,
      dpr: 1,
      smoothNormals: false,
      detail: false,
    });
    expect(PRESETS.medium).toMatchObject({
      lit: true,
      shadows: 2048,
      post: false,
      dpr: 1.5,
      smoothNormals: true,
      detail: true,
    });
    expect(PRESETS.high).toMatchObject({
      ...PRESETS.medium,
      shadows: 4096,
      post: true,
    });
  });
});

// ---------------------------------------------------------------- store and key

function memoryStorage(): PrefsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe('the quality setting', () => {
  it('starts at the default, waiting for detection, without a saved choice', () => {
    const store = createPlaybackStore({ storage: memoryStorage() });
    expect(store.getState().quality).toBe('medium');
    expect(store.getState().qualityFrom).toBe('default');
  });

  it('round-trips through localStorage', () => {
    const storage = memoryStorage();
    const a = createPlaybackStore({ storage });
    a.getState().setQuality('high');
    expect(storage.data.get(QUALITY_KEY)).toBe('high');
    expect(a.getState().quality).toBe('high');
    expect(a.getState().qualityFrom).toBe('chosen');

    const b = createPlaybackStore({ storage });
    expect(b.getState().quality).toBe('high');
    expect(b.getState().qualityFrom).toBe('chosen');
    b.getState().setQuality('low');
    expect(createPlaybackStore({ storage }).getState().quality).toBe('low');
  });

  it('ignores a stored value that is not a preset, and a preset that is not one', () => {
    const storage = memoryStorage();
    storage.data.set(QUALITY_KEY, 'ultra');
    const store = createPlaybackStore({ storage });
    expect(store.getState().quality).toBe('medium');
    expect(store.getState().qualityFrom).toBe('default');
    store.getState().setQuality('ultra' as Quality);
    expect(store.getState().quality).toBe('medium');
    expect(storage.data.get(QUALITY_KEY)).toBe('ultra');
  });

  it('works for the visit when storage throws', () => {
    const storage: PrefsStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = createPlaybackStore({ storage });
    expect(store.getState().quality).toBe('medium');
    store.getState().setQuality('low');
    expect(store.getState().quality).toBe('low');
  });

  it('takes the detected preset once, never over a choice, and does not save it', () => {
    const storage = memoryStorage();
    const store = createPlaybackStore({ storage });
    store.getState().detectQuality(120);
    expect(store.getState().quality).toBe('high');
    expect(store.getState().qualityFrom).toBe('detected');
    expect(storage.data.has(QUALITY_KEY)).toBe(false);
    store.getState().detectQuality(20);
    expect(store.getState().quality).toBe('high');

    const chosen = createPlaybackStore({ storage: null });
    chosen.getState().setQuality('low');
    chosen.getState().detectQuality(500);
    expect(chosen.getState().quality).toBe('low');
    expect(chosen.getState().qualityFrom).toBe('chosen');
  });

  it('cycles low → medium → high → low with Q, with or without a pack', () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setQuality('low');
    const seen: Quality[] = [];
    for (let i = 0; i < 3; i++) {
      expect(handleKey({ code: 'KeyQ', key: 'q' }, store)).toBe(true);
      seen.push(store.getState().quality);
    }
    expect(seen).toEqual(['medium', 'high', 'low']);
    expect(store.getState().qualityFrom).toBe('chosen');

    store.getState().setPack(
      playbackPack({
        players: 2,
        rounds: [{ start: 0, freeze: 10, end: 100 }],
        tick_step: 8,
      })
    );
    // A layout without a KeyQ code falls back to the typed character.
    expect(handleKey({ code: '', key: 'Q' }, store)).toBe(true);
    expect(store.getState().quality).toBe('medium');
    // Ctrl+Q belongs to the browser.
    expect(handleKey({ code: 'KeyQ', key: 'q', ctrlKey: true }, store)).toBe(
      false
    );
    expect(store.getState().quality).toBe('medium');
  });
});

// ---------------------------------------------------------------- Scene.setQuality

type Inside = {
  scene: THREE.Scene;
  lighting: Lighting;
  post: PostStack;
  renderer: THREE.WebGLRenderer & { pixelRatio: number };
  look: LookOptions;
};
const inside = (s: InstanceType<typeof Scene>) => s as unknown as Inside;

function fakeCanvas(): HTMLCanvasElement {
  const target = { addEventListener() {}, removeEventListener() {} };
  return {
    ...target,
    clientWidth: 1600,
    clientHeight: 900,
    style: {},
    getRootNode: () => target,
    ownerDocument: target,
  } as unknown as HTMLCanvasElement;
}

function worldMesh(s: InstanceType<typeof Scene>): THREE.Mesh {
  const world = inside(s).scene.children.find((c) => c.name === 'world');
  const mesh = world?.children[0] as THREE.Mesh | undefined;
  if (!mesh) throw new Error('no world');
  return mesh;
}

describe('Scene.setQuality', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200 }))
    );
    loadWorld.mockReset();
    loadWorld.mockImplementation(async () => makeWorld());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts at the preset it is given', async () => {
    const scene = new Scene(fakeCanvas(), 'low');
    expect(scene.quality).toBe('low');
    const { renderer, lighting } = inside(scene);
    expect(renderer.pixelRatio).toBe(1);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(lighting.sun.castShadow).toBe(false);
    await scene.loadMap('de_mirage');
    expect(inside(scene).look).toEqual({
      lit: false,
      smoothNormals: false,
      maxAnisotropy: 1,
      detail: undefined,
      baked: undefined,
    });
    expect(worldMesh(scene).material).toBeInstanceOf(THREE.MeshBasicMaterial);
    scene.dispose();
  });

  it("switches a loaded world's look, shadows, tone mapping, sky and pixel ratio in place", async () => {
    const scene = new Scene(fakeCanvas());
    expect(scene.quality).toBe('medium');
    await scene.loadMap('de_mirage');
    const { renderer, lighting, scene: s3 } = inside(scene);
    const mesh = worldMesh(scene);
    const sky = new THREE.Color(atmosphereFor('de_mirage').sky).getHex();
    const background = () => (s3.background as THREE.Color).getHex();
    const fog = s3.fog as THREE.Fog;

    // medium: lit with the detail texture, 2048² shadows, Neutral tone mapping, the map's sky, DPR ≤ 1.5.
    const lit = mesh.material as THREE.MeshLambertMaterial;
    expect(lit).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(hasDetail(lit)).toBe(true);
    expect(lit.map?.anisotropy).toBe(8);
    expect(mesh.geometry.hasAttribute('normal')).toBe(true);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(lighting.sun.shadow.mapSize.x).toBe(2048);
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(renderer.pixelRatio).toBe(1.5);
    expect(background()).toBe(sky);

    // low: phase 3's unlit scene, no shadows, no tone mapping, no sky or fog, DPR 1.
    const disposed = vi.fn();
    lit.addEventListener('dispose', disposed);
    scene.setQuality('low');
    expect(scene.quality).toBe('low');
    const flat = mesh.material as THREE.MeshBasicMaterial;
    expect(flat).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(hasDetail(flat)).toBe(false);
    expect(flat.map).toBe(lit.map);
    expect(flat.map?.anisotropy).toBe(1);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(lighting.sun.castShadow).toBe(false);
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
    expect(renderer.pixelRatio).toBe(1);
    expect(background()).not.toBe(sky);
    scene.render();
    expect(fog.near).toBeGreaterThan(1e6);

    // high, on this device without float targets: medium's look and its 2048² shadows.
    scene.setQuality('high');
    expect(mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(hasDetail(mesh.material as THREE.Material)).toBe(true);
    expect(lighting.sun.castShadow).toBe(true);
    expect(lighting.sun.shadow.mapSize.x).toBe(2048);
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(renderer.pixelRatio).toBe(1.5);
    expect(background()).toBe(sky);
    scene.render();
    expect(fog.near).toBeLessThan(1e6);
    scene.dispose();
  });

  it('draws high as medium where the post stack cannot run, with 4096² shadows where it can', () => {
    // Without float targets the stack is unsupported: medium's shadows and pixel ratio, no post.
    const weak = new Scene(fakeCanvas());
    weak.setQuality('high');
    expect(weak.quality).toBe('high');
    const w = inside(weak);
    expect(w.post.supported).toBe(false);
    expect(w.post.enabled).toBe(false);
    expect(w.lighting.sun.castShadow).toBe(true);
    expect(w.lighting.sun.shadow.mapSize.x).toBe(2048);
    expect(w.renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(w.renderer.pixelRatio).toBe(1.5);
    weak.dispose();

    // With them (and an Image for SMAA's lookup tables, which node lacks) high is high.
    device.floatTargets = true;
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        onload: (() => void) | null = null;
      }
    );
    try {
      const strong = new Scene(fakeCanvas());
      strong.setQuality('high');
      const s = inside(strong);
      expect(s.post.supported).toBe(true);
      expect(s.post.enabled).toBe(true);
      expect(s.lighting.sun.shadow.mapSize.x).toBe(4096);
      strong.setQuality('medium');
      expect(s.post.enabled).toBe(false);
      expect(s.lighting.sun.shadow.mapSize.x).toBe(2048);
      strong.dispose();
    } finally {
      device.floatTargets = false;
    }
  });

  it('keeps one live material per source after ten cycles, the rest freed', async () => {
    const scene = new Scene(fakeCanvas());
    await scene.loadMap('de_mirage');
    const mesh = worldMesh(scene);
    const seen = new Set<THREE.Material>();
    const freed = new Set<THREE.Material>();
    const track = () => {
      const m = mesh.material as THREE.Material;
      if (seen.has(m)) return;
      seen.add(m);
      m.addEventListener('dispose', () => freed.add(m));
    };
    track();
    for (let i = 0; i < 10; i++)
      for (const q of ['low', 'medium', 'high'] as const) {
        scene.setQuality(q);
        track();
      }
    expect(seen.size).toBeGreaterThan(10);
    expect(freed.size).toBe(seen.size - 1);
    expect(freed.has(mesh.material as THREE.Material)).toBe(false);
    scene.dispose();
  });

  it('dresses a world that was loading during a switch in the new look', async () => {
    let release!: () => void;
    loadWorld.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(makeWorld());
        })
    );
    const scene = new Scene(fakeCanvas());
    const loading = scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(loadWorld).toHaveBeenCalled());
    scene.setQuality('low');
    release();
    await loading;
    expect(worldMesh(scene).material).toBeInstanceOf(THREE.MeshBasicMaterial);
    scene.dispose();
  });
});
