import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetUrl, fetchManifest } from '../src/api/assets';
import {
  HAND_PARTS,
  WeaponCache,
  muzzleOf,
  weaponModelName,
  type WeaponManifest,
} from '../src/scene/weapons';

const SHA = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

/** A loader whose loads the test settles by hand. */
function manualLoader() {
  const calls: string[] = [];
  const settle: ((ok: boolean) => void)[] = [];
  const load = (url: string) => {
    calls.push(url);
    return new Promise<THREE.Object3D>((resolve, reject) => {
      settle.push((ok) => {
        if (!ok) return reject(new Error('404'));
        const g = new THREE.Group();
        g.add(
          new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
        );
        resolve(g);
      });
    });
  };
  return { calls, settle, load };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe('assetUrl', () => {
  it('adds the first 8 hex of the hash as v', () => {
    expect(assetUrl('/weapons/ak47.glb', SHA)).toBe(
      '/weapons/ak47.glb?v=abcdef12'
    );
    expect(assetUrl('/x.glb?a=1', SHA.toUpperCase())).toBe(
      '/x.glb?a=1&v=abcdef12'
    );
  });
  it('leaves the path alone without a usable hash', () => {
    expect(assetUrl('/players/t.glb', undefined)).toBe('/players/t.glb');
    expect(assetUrl('/players/t.glb', 'not-a-hash')).toBe('/players/t.glb');
  });
});

describe('fetchManifest', () => {
  it('is the JSON of a good answer, null for an error, a failure or bad JSON', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    f.mockResolvedValueOnce(new Response('{"t":{"sha256":"ab"}}'));
    expect(await fetchManifest('/m')).toEqual({ t: { sha256: 'ab' } });
    f.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    expect(await fetchManifest('/m')).toBeNull();
    f.mockRejectedValueOnce(new TypeError('offline'));
    expect(await fetchManifest('/m')).toBeNull();
    f.mockResolvedValueOnce(new Response('{'));
    expect(await fetchManifest('/m')).toBeNull();
  });
});

describe('weaponModelName', () => {
  it('gives a T the T knife and nothing for no weapon', () => {
    expect(weaponModelName('knife', 2)).toBe('knife_t');
    expect(weaponModelName('knife', 3)).toBe('knife');
    expect(weaponModelName('ak47', 2)).toBe('ak47');
    expect(weaponModelName('none', 3)).toBeNull();
    expect(weaponModelName('', 3)).toBeNull();
  });
});

describe('WeaponCache', () => {
  it('answers null until the model arrives, then the model, from one load', async () => {
    const l = manualLoader();
    const cache = new WeaponCache(l.load);
    const loaded = vi.fn();
    cache.onLoad = loaded;
    expect(cache.get('ak47')).toBeNull();
    expect(cache.get('ak47')).toBeNull();
    l.settle[0](true);
    await flush();
    const model = cache.get('ak47');
    expect(model).toBeInstanceOf(THREE.Group);
    expect(cache.get('ak47')).toBe(model);
    expect(l.calls).toEqual(['/weapons/ak47.glb']);
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it('remembers a failed load: null for good, one load, one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const l = manualLoader();
    const cache = new WeaponCache(l.load);
    expect(cache.get('taser')).toBeNull();
    l.settle[0](false);
    await flush();
    for (let i = 0; i < 5; i++) expect(cache.get('taser')).toBeNull();
    expect(l.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('asks for the versioned URL, and never for a model the manifest lacks', () => {
    const l = manualLoader();
    const cache = new WeaponCache(l.load, {
      weapons: { ak47: { sha256: SHA, bytes: 1 } },
    });
    cache.get('ak47');
    expect(cache.get('newgun')).toBeNull();
    expect(l.calls).toEqual(['/weapons/ak47.glb?v=abcdef12']);
  });

  it('reads a manifest without a weapons table as one that lists nothing', () => {
    const l = manualLoader();
    const cache = new WeaponCache(l.load);
    // A map's manifest where the weapons' was meant, and JSON that is not an object.
    cache.setManifest({ files: {} } as unknown as WeaponManifest);
    expect(cache.get('ak47')).toBeNull();
    const other = new WeaponCache(l.load, 7 as unknown as WeaponManifest);
    expect(other.get('ak47')).toBeNull();
    expect(l.calls).toEqual([]);
    // No manifest at all still loads unversioned.
    cache.setManifest(null);
    cache.get('m4a1');
    expect(l.calls).toEqual(['/weapons/m4a1.glb']);
  });

  it('frees what it holds on dispose and keeps nothing that arrives after', async () => {
    const l = manualLoader();
    const cache = new WeaponCache(l.load);
    cache.get('ak47');
    l.settle[0](true);
    await flush();
    const mesh = cache.get('ak47')!.children[0] as THREE.Mesh;
    const freed = vi.fn();
    mesh.geometry.addEventListener('dispose', freed);
    cache.get('awp');
    cache.dispose();
    expect(freed).toHaveBeenCalledTimes(1);
    l.settle[1](true);
    await flush();
    expect(cache.get('awp')).toBeNull();
    expect(l.calls).toHaveLength(2);
  });
});

/**
 * A model of two pistols as the Dual Berettas' is laid out: each 0.3 m long facing +Z, the right
 * hand's on the `weapon` bone (CS2's weapon-bone turn, game axes: X ahead, Y left, Z up) and the
 * left hand's 0.508 m to its left, along the bone's Y (the model's +X).
 */
function pair(): THREE.Group {
  const g = new THREE.Group();
  g.userData = {
    attach: { translation: [0, 0.05, 0], rotation: [-0.5, -0.5, -0.5, 0.5] },
  };
  for (const x of [0, 0.508]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.3));
    m.position.set(x, 0.05, 0.05);
    g.add(m);
  }
  return g;
}

describe('muzzleOf', () => {
  it("is the middle of the model's front end, in its own frame, whatever holds it", () => {
    const g = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.4));
    barrel.position.set(0.01, 0.06, 0.3);
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.4)), barrel);
    const holder = new THREE.Object3D();
    holder.position.set(5, 1, -3);
    holder.rotation.set(0.3, 1.2, -0.4);
    holder.add(g);
    const m = muzzleOf(g, 'ak47');
    expect(m.x).toBeCloseTo(0.01, 6);
    expect(m.y).toBeCloseTo(0.06, 6);
    expect(m.z).toBeCloseTo(0.5, 6);
    // Found once: the same vector after the model moves.
    holder.position.x = 9;
    expect(muzzleOf(g, 'ak47')).toBe(m);
  });

  it("gives the Dual Berettas' right-hand pistol's muzzle, not the middle of the pair", () => {
    expect(HAND_PARTS.elite).toEqual({ axis: 1, at: 0.25 });
    const right = muzzleOf(pair(), 'elite');
    expect(right.x).toBeCloseTo(0, 6);
    expect(right.z).toBeCloseTo(0.2, 6);
    // As any other model, the pair's front end is the middle of both.
    expect(muzzleOf(pair(), 'glock').x).toBeCloseTo(0.254, 6);
  });
});
