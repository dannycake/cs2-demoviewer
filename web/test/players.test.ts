// PlayerModels' lifecycle on its own (players.ts): the pool is made of the models the scene's
// tier names once they are in; a load superseded by a change of tier leaves the pool drawn as
// it was until the new models land, then frees the old ones; a failed load keeps the pool,
// dresses it in the look of now, frees the model of it that did load and lets the next call ask
// for the manifest again; dispose frees the pool and every model, those still on their way when
// they land, and nothing it does not own. The scene's swaps through setQuality are
// phone-tier.test's. The GLB loader is stubbed: each model is a box whose freeing is seen.

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchHeader } from '../src/pack/types';
import type { RigTemplate } from '../src/scene/loaders';
import { UNLIT_LOOK } from '../src/scene/look';

/** Each model asked for: its URL, whether it was freed, and its answer, settled by the test. */
const models = vi.hoisted(() => ({
  asked: [] as {
    url: string;
    freed: boolean;
    resolve: () => void;
    reject: (e: Error) => void;
  }[],
}));
vi.mock('../src/scene/loaders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/loaders')>()),
  loadRigTemplate: (url: string) =>
    new Promise<RigTemplate>((resolve, reject) => {
      const root = new THREE.Group();
      root.name = url;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(),
        new THREE.MeshBasicMaterial()
      );
      root.add(body);
      const entry = {
        url,
        freed: false,
        resolve: () =>
          resolve({ scene: root, clips: new Map(), variants: new Map() }),
        reject,
      };
      body.geometry.addEventListener('dispose', () => (entry.freed = true));
      models.asked.push(entry);
    }),
}));

const { PlayerModels } = await import('../src/scene/players');
const { RigPool } = await import('../src/scene/PlayerRig');
const { WeaponCache } = await import('../src/scene/weapons');

const HEADER = { players: [{}, {}] } as unknown as MatchHeader;
const MANIFEST = {
  t: {
    sha256: 'a'.repeat(64),
    lo: { file: 't_lo.glb', sha256: 'b'.repeat(64) },
  },
  ct: {
    sha256: 'c'.repeat(64),
    lo: { file: 'ct_lo.glb', sha256: 'd'.repeat(64) },
  },
};
const FULL = ['/players/t.glb?v=aaaaaaaa', '/players/ct.glb?v=cccccccc'];
const LO = ['/players/t_lo.glb?v=bbbbbbbb', '/players/ct_lo.glb?v=dddddddd'];

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The models asked for at `urls`, answered. */
async function land(urls: string[]): Promise<void> {
  for (const m of models.asked) if (urls.includes(m.url)) m.resolve();
  await flush();
}
const freed = (urls: string[]) =>
  models.asked.filter((m) => urls.includes(m.url)).map((m) => m.freed);

function make() {
  const scene = new THREE.Scene();
  const weapons = new WeaponCache(async () => new THREE.Group());
  const host = {
    phoneTier: false,
    phone: () => host.phoneTier,
    look: vi.fn(() => UNLIT_LOOK),
    repose: vi.fn(() => false),
    invalidate: vi.fn(),
  };
  const players = new PlayerModels(scene, weapons, host);
  const pool = () =>
    (players as unknown as { pool: { root: THREE.Group } | null }).pool;
  return { scene, weapons, host, players, pool };
}

let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  models.asked.length = 0;
  fetch = vi.fn(async () => ({ ok: true, json: async () => MANIFEST }));
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PlayerModels', () => {
  it("makes the pool of the tier's models once they are in, and draws it", async () => {
    const { scene, host, players, pool } = make();
    const done = players.load(HEADER);
    await flush();
    expect(models.asked.map((m) => m.url)).toEqual(FULL);
    expect(pool()).toBeNull();
    await land(FULL);
    await done;
    expect(scene.children).toContain(pool()!.root);
    expect(host.invalidate).toHaveBeenCalledTimes(1);
  });

  it('draws the pool it had until the models of a change of tier land, then frees the old ones', async () => {
    const { scene, players, pool, host } = make();
    const first = players.load(HEADER);
    await flush();
    await land(FULL);
    await first;
    const was = pool();
    host.phoneTier = true;
    players.reload();
    await flush();
    expect(models.asked.map((m) => m.url)).toEqual([...FULL, ...LO]);
    // Superseded state stays drawn while the phone tier loads.
    expect(pool()).toBe(was);
    expect(scene.children).toContain(was!.root);
    expect(freed(FULL)).toEqual([false, false]);
    await land(LO);
    expect(pool()).not.toBe(was);
    expect(scene.children).not.toContain(was!.root);
    expect(freed(FULL)).toEqual([true, true]);
    expect(freed(LO)).toEqual([false, false]);
    // The manifest was asked for once.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the pool after a failed load, dresses it in the look of now, and asks for the manifest again next time', async () => {
    const { players, pool, host } = make();
    const first = players.load(HEADER);
    await flush();
    await land(FULL);
    await first;
    const was = pool();
    host.phoneTier = true;
    const failing = players.load(HEADER);
    await flush();
    // The look of now, which the change of tier left to the swap.
    const now = { ...UNLIT_LOOK, maxAnisotropy: 8 };
    host.look.mockReturnValue(now);
    const setLook = vi.spyOn(RigPool.prototype, 'setLook');
    for (const m of models.asked)
      if (LO.includes(m.url)) m.reject(new Error('404'));
    await expect(failing).rejects.toThrow('404');
    expect(pool()).toBe(was);
    expect(setLook).toHaveBeenCalledTimes(1);
    expect(setLook).toHaveBeenCalledWith(now);
    expect(setLook.mock.contexts[0]).toBe(was);
    expect(freed(FULL)).toEqual([false, false]);
    const again = players.load(HEADER);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    await land(LO);
    await again;
    expect(pool()).not.toBe(was);
  });

  it('frees the model that loaded when the other of a load fails, and keeps the pool', async () => {
    const { players, pool, host } = make();
    const first = players.load(HEADER);
    await flush();
    await land(FULL);
    await first;
    const was = pool();
    host.phoneTier = true;
    const failing = players.load(HEADER);
    await flush();
    // ct_lo.glb fails first, then t_lo.glb lands: it is freed, not left to the GC.
    const failed = expect(failing).rejects.toThrow('404');
    for (const m of models.asked)
      if (m.url === LO[1]) m.reject(new Error('404'));
    await land([LO[0]]);
    await failed;
    expect(freed([LO[0]])).toEqual([true]);
    expect(pool()).toBe(was);
    expect(freed(FULL)).toEqual([false, false]);
  });

  it('frees the pool and its models on dispose, those on their way when they land, and nothing it does not own', async () => {
    const { scene, weapons, players, pool, host } = make();
    const other = new THREE.Group();
    scene.add(other);
    const disposeWeapons = vi.spyOn(weapons, 'dispose');
    const first = players.load(HEADER);
    await flush();
    await land(FULL);
    await first;
    const was = pool()!;
    host.phoneTier = true;
    const late = players.load(HEADER);
    await flush();
    players.dispose();
    expect(scene.children).not.toContain(was.root);
    expect(scene.children).toContain(other);
    expect(freed(FULL)).toEqual([true, true]);
    expect(disposeWeapons).not.toHaveBeenCalled();
    // The phone tier lands after: freed, and no pool is made of it.
    await land(LO);
    await late;
    expect(freed(LO)).toEqual([true, true]);
    expect(pool()).toBeNull();
    expect(scene.children).toEqual([other]);
  });
});
