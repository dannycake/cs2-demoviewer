// The players' models, a part of the scene (Scene.ts): the players' manifest, the T and CT
// models (at the scene's phone tier where the manifest lists one), the pool of rigs made of them
// for the match, and each shown player's light from the map's light grid. A change of tier or of
// match makes the pool again once the new models are in, drawing the old one until then; the
// models replaced are freed once nothing draws them. The scene tells it the tier and the look,
// drives the pool each frame and lights it.

import * as THREE from 'three';
import { assetUrl, fetchManifest, type PlayersManifest } from '../api/assets';
import type { MatchHeader } from '../pack/types';
import type { RigInput } from './frame';
import { disposeObject, loadRigTemplate, type RigTemplate } from './loaders';
import type { LookOptions } from './look';
import { RigPool, type PlayerRig, type Team } from './PlayerRig';
import {
  makeProbeSample,
  sampleLightGrid,
  type LightGrid,
  type ProbeSample,
} from './probes';
import type { WeaponCache } from './weapons';

/** Where a player is lit by the light grid: their chest, this far above their feet (metres). */
const CHEST_HEIGHT = 1;
const PLAYER_GLB: Record<Team, string> = {
  2: '/players/t.glb',
  3: '/players/ct.glb',
};

/**
 * The URL of `team`'s model: its phone tier (`<side>_lo.glb`) with `phone` where the manifest
 * lists one, else today's file, each versioned by the manifest.
 */
function playerUrl(
  m: PlayersManifest | null,
  team: Team,
  phone: boolean
): string {
  const entry = m?.[team === 2 ? 't' : 'ct'];
  const lo = entry?.lo;
  if (
    phone &&
    typeof lo?.file === 'string' &&
    /^[a-z0-9_]+\.glb$/.test(lo.file)
  )
    return assetUrl(`/players/${lo.file}`, lo.sha256);
  return assetUrl(PLAYER_GLB[team], entry?.sha256);
}

/** Both players' URLs (`playerUrl`), the T side's first: the key of a pool's models. */
function playerUrls(m: PlayersManifest | null, phone: boolean): string {
  return `${playerUrl(m, 2, phone)} ${playerUrl(m, 3, phone)}`;
}

/** Frees two templates once (a pool's and the ones replaced may be the same). */
const freedTemplates = new WeakSet<Record<Team, RigTemplate>>();
function disposeTemplates(t: Record<Team, RigTemplate>): void {
  if (freedTemplates.has(t)) return;
  freedTemplates.add(t);
  disposeObject(t[2].scene);
  disposeObject(t[3].scene);
}

/**
 * The T and CT models at `t` and `ct`. When one fails, the one that loaded is freed before the
 * first failure is thrown: its images were never uploaded, so nothing else would close them
 * (images.ts) before the GC does.
 */
async function loadTemplates(
  t: string,
  ct: string
): Promise<Record<Team, RigTemplate>> {
  const [tm, ctm] = await Promise.allSettled([
    loadRigTemplate(t),
    loadRigTemplate(ct),
  ]);
  if (tm.status === 'fulfilled' && ctm.status === 'fulfilled')
    return { 2: tm.value, 3: ctm.value };
  for (const r of [tm, ctm])
    if (r.status === 'fulfilled') disposeObject(r.value.scene);
  throw tm.status === 'rejected'
    ? tm.reason
    : (ctm as PromiseRejectedResult).reason;
}

/** What the players ask of the scene they are drawn in. */
export interface PlayersHost {
  /** Whether the scene loads the phone tier (`Scene.setQuality`). */
  phone(): boolean;
  /** The look the players are drawn in now (`Scene.playerLook`). */
  look(): LookOptions;
  /** Poses the frame drawn last again, the rigs remade under it; false when there is none. */
  repose(): boolean;
  /** Schedules a draw. */
  invalidate(): void;
}

export class PlayerModels {
  private readonly scene: THREE.Scene;
  private readonly weapons: WeaponCache;
  private readonly host: PlayersHost;
  /** The players' manifest, asked for with the first templates (again after a failure). */
  private playersManifest: Promise<PlayersManifest | null> | null = null;
  /** The players' manifest once in, which names the other tier's files without waiting. */
  private playersKnown: PlayersManifest | null = null;
  /** The match last asked for (`load`): a change of tier loads its players again. */
  private headerAsked: MatchHeader | null = null;
  /** The players' templates last asked for: the URLs they come from, and their load. */
  private templates: {
    urls: string;
    load: Promise<Record<Team, RigTemplate>>;
  } | null = null;
  /** The templates the pool's rigs are made of, their URLs, and the match it was made for. */
  private poolTemplates: Record<Team, RigTemplate> | null = null;
  private poolUrls: string | null = null;
  private poolHeader: MatchHeader | null = null;
  private rigLoads = 0;
  private pool: RigPool | null = null;
  /** Each player's light from the grid (`light`), filled in place every frame. */
  private readonly lightSamples: ProbeSample[] = [];
  private readonly chest = new THREE.Vector3();
  /** The canvas's size in CSS pixels (`setViewport`), which the outlines are drawn at. */
  private width = 1;
  private height = 1;
  private disposed = false;

  /** The players of the match to come, added to `scene`, holding `weapons`' models. */
  constructor(scene: THREE.Scene, weapons: WeaponCache, host: PlayersHost) {
    this.scene = scene;
    this.weapons = weapons;
    this.host = host;
  }

  /**
   * Makes the rig pool for this match (`header.players.length` players) of the players' models:
   * at the scene's phone tier (`low`'s: `setQuality`), their `<side>_lo.glb` where the manifest
   * lists it, else today's files. A call with other files (a change of tier) makes the pool
   * again of them once they are in, the rigs drawn as they were until then, and frees the models
   * it replaced; one with the same files for the same match keeps the pool, and one with the
   * pool's files loads nothing again. Of overlapping calls only the last one has an effect: one
   * superseded before the manifest is in loads nothing.
   */
  async load(header: MatchHeader): Promise<void> {
    const seq = ++this.rigLoads;
    this.headerAsked = header;
    this.playersManifest ??= fetchManifest<PlayersManifest>(
      '/players/manifest.json'
    );
    const m = await this.playersManifest;
    if (this.disposed || seq !== this.rigLoads) return;
    this.playersKnown = m;
    const phone = this.host.phone();
    const t = playerUrl(m, 2, phone);
    const ct = playerUrl(m, 3, phone);
    const urls = playerUrls(m, phone);
    if (this.templates?.urls !== urls) {
      const old = this.templates;
      this.templates = {
        urls,
        load:
          // Back to the pool's own files (a change of tier and back before the swap).
          urls === this.poolUrls && this.poolTemplates
            ? Promise.resolve(this.poolTemplates)
            : loadTemplates(t, ct),
      };
      // The models replaced go once nothing draws them: when they are in, or with the pool
      // made of them.
      void old?.load.then(
        (was) => {
          if (was !== this.poolTemplates) disposeTemplates(was);
        },
        () => {}
      );
    }
    const asked = this.templates;
    let templates: Record<Team, RigTemplate>;
    try {
      templates = await asked.load;
    } catch (e) {
      // Let a later call retry, the manifest too.
      if (this.templates === asked) {
        this.templates = null;
        this.playersManifest = null;
      }
      // The players drawn stay: in this preset's look, which a change of tier left to the swap.
      if (!this.disposed && seq === this.rigLoads) this.dress();
      throw e;
    }
    // Freed by `dispose`, or, replaced, once they are not the pool's.
    if (this.disposed || seq !== this.rigLoads) return;
    if (templates === this.poolTemplates && header === this.poolHeader) return;
    const was = this.poolTemplates;
    this.pool?.dispose();
    this.pool = new RigPool(
      templates,
      header.players.length,
      this.host.look(),
      this.weapons
    );
    this.poolTemplates = templates;
    this.poolUrls = urls;
    this.poolHeader = header;
    if (was && was !== templates) disposeTemplates(was);
    this.pool.setViewport(this.width, this.height);
    this.scene.add(this.pool.root);
    if (!this.host.repose()) this.host.invalidate();
  }

  /**
   * Loads the players of the match last asked for again, at the scene's tier now (a change of
   * tier); a caller of `load` joins it to hear how it went.
   */
  reload(): void {
    if (this.headerAsked) this.load(this.headerAsked).catch(() => {});
  }

  /**
   * Dresses the players in the scene's look now, where they are the files of the scene's tier:
   * a change of tier is swapping them otherwise, and their textures' images were released after
   * upload (images.ts), so a new anisotropy would fetch them again only to free them.
   */
  relook(): void {
    if (this.stays()) this.dress();
  }

  /** Whether the pool's players are the files the scene's tier loads. */
  private stays(): boolean {
    return (
      !!this.pool &&
      this.poolUrls === playerUrls(this.playersKnown, this.host.phone())
    );
  }

  /** Draws the players in the current look (`RigPool.setLook`), posed again. */
  private dress(): void {
    if (!this.pool) return;
    this.pool.setLook(this.host.look());
    // Remade rigs are posed by the next drive.
    this.host.repose();
  }

  /** The rig shown for player `i`, or null. */
  active(i: number): PlayerRig | null {
    return this.pool?.active(i) ?? null;
  }

  /** Poses every player as `inputs` say (`RigPool.drive`). */
  drive(inputs: readonly RigInput[], header: MatchHeader): void {
    this.pool?.drive(inputs, header);
  }

  /** Team outlines through walls, on or off; white for player `shown`. */
  setOutlines(on: boolean, shown: number | null): void {
    this.pool?.setOutlines(on, shown);
  }

  /**
   * Lights every player shown by the map's light grid `grid` at their chest, once per frame,
   * each in its own sample filled in place; by the sky light where the map has no grid (null).
   */
  light(grid: LightGrid | null): void {
    const pool = this.pool;
    if (!pool) return;
    for (let i = 0; i < pool.size; i++) {
      const rig = pool.active(i);
      if (!rig) continue;
      if (!grid) {
        rig.setProbe(null);
        continue;
      }
      const s = (this.lightSamples[i] ??= makeProbeSample());
      this.chest.copy(rig.object.position).y += CHEST_HEIGHT;
      rig.setProbe(sampleLightGrid(grid, this.chest, s));
    }
  }

  /** Player `i`'s light from the grid as `light` sampled it last, if it has. */
  lightOf(i: number): ProbeSample | undefined {
    return this.lightSamples[i];
  }

  /** The canvas's new size in CSS pixels. */
  setViewport(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.pool?.setViewport(width, height);
  }

  /** Frees the pool and every model loaded, those still on their way once they are in. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool?.dispose();
    this.pool = null;
    if (this.poolTemplates) disposeTemplates(this.poolTemplates);
    this.poolTemplates = null;
    this.templates?.load.then(disposeTemplates).catch(() => {});
  }
}
