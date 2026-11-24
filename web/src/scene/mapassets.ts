// The map's assets, a part of the scene (Scene.ts): the world (at the scene's phone tier where
// the manifest lists one), the collision hull, CS2's baked light and the doors and breakables,
// each loaded once per map by the versioned URLs of the map's manifest, and kept consistent by
// one sequence: a load that is superseded frees what it loaded, one that wins swaps the world
// in one commit, which sets the bake (and with it the tone mapping, the shadow and the look),
// dresses and adds the world, takes the hull and the doors, and, for the first world, fits the
// cameras and the sun to it and sets the map's sky and atmosphere. A scene draws one map.

import * as THREE from 'three';
import {
  assetUrl,
  jsonOrNull,
  mapManifest,
  type MapManifest,
} from '../api/assets';
import { toScene, UNIT } from '../geo/coords';
import type { Pack } from '../pack/types';
import { atmosphereFor, type Atmosphere } from './atmosphere';
import {
  disposeBaked,
  loadBaked,
  parseLightInfo,
  sunModeOf,
  type Baked,
} from './baked';
import type { BulletMarks } from './bulletmarks';
import type { Cameras } from './cameras';
import type { EffectAtlases } from './effects';
import { Hull } from './hull';
import { disposeObject, loadHull, loadWorld } from './loaders';
import { Lighting, castAndReceive } from './lighting';
import { applyLook, sameLook, type LookOptions } from './look';
import { MapEntities } from './mapents';
import { horizonOf, type SkyAndFog } from './sky';

/** `surfaceBelow` looks for the floor from this far over the feet to this far under them (units). */
const FEET_ABOVE = 8;
const FEET_BELOW = 32;

/**
 * The world file a map's manifest gives the scene: with `phone` the phone tier
 * (`world_lo.glb`) where the manifest lists it; else `world.glb`.
 */
function worldFile(manifest: MapManifest | null, phone: boolean): string {
  return phone && manifest?.files?.['world_lo.glb']
    ? 'world_lo.glb'
    : 'world.glb';
}

/** The versioned URL of `name` among `map`'s assets, by its manifest. */
function mapFileUrl(
  map: string,
  manifest: MapManifest | null,
  name: string
): string {
  return assetUrl(
    `/maps/${encodeURIComponent(map)}/${name}`,
    manifest?.files?.[name]?.sha256
  );
}

/**
 * A `load` call: the world file it loads once its manifest is in (the file of the scene's
 * tier then), null before.
 */
interface MapLoad {
  manifest: MapManifest | null;
  file: string | null;
  done: Promise<void>;
}

/** The server has no assets for this map (its manifest answers 404). */
export class MissingAssetsError extends Error {
  readonly map: string;
  readonly status: number;
  constructor(map: string, status: number) {
    super(`no assets for ${map} yet`);
    this.name = 'MissingAssetsError';
    this.map = map;
    this.status = status;
  }
}

/** What the map's assets ask of the scene they are drawn in, and the parts of it they set. */
export interface MapHost {
  /** Where the world and the doors are drawn. */
  readonly scene: THREE.Scene;
  /** The sun and sky light: fitted to the first world, and the world's shadow drawn again. */
  readonly lighting: Lighting;
  /** Fitted to the first world's bounds. */
  readonly cameras: Cameras;
  /** The map's sky and atmosphere, set with the first world. */
  readonly sky: SkyAndFog;
  /** The bullet marks, found on the hull: a hull replaced takes them with it. */
  readonly marks: BulletMarks;
  /** The effect atlases the breakables' debris draws from. */
  readonly effects: EffectAtlases;
  /** Whether the scene loads the phone tier (`Scene.setQuality`). */
  phone(): boolean;
  /** The look the world is dressed in now: the preset's, in the map's bake once it is set. */
  look(): LookOptions;
  /**
   * Waits for what the look needs before a world is dressed (the detail texture, asked for with
   * the scene), and dresses the scene in the look that has it.
   */
  lookReady(): Promise<void>;
  /** The world's bake is set (`baked`): the tone mapping, the shadow and the look follow it. */
  relight(): void;
  /** A world was drawn: the players take its light, and the scene draws. */
  changed(): void;
  /** Schedules a draw. */
  invalidate(): void;
}

export class MapAssets {
  private readonly host: MapHost;
  /**
   * The map this scene draws, named by the first `load`: a scene draws one map (the viewer
   * makes one per demo), so nothing here is ever another map's. A change of tier loads it again.
   */
  private map: string | null = null;
  /** The `load` in flight: a call that would load the same world joins it. */
  private mapLoad: MapLoad | null = null;
  private mapLoads = 0;
  private _world: THREE.Group | null = null;
  /** The URL `world` was loaded from: a load of the same file on the same map keeps it. */
  private worldUrl: string | null = null;
  /** The manifest `world` was loaded by, which names the other tier's file without a request. */
  private worldManifest: MapManifest | null = null;
  /** The look `world` is dressed in. */
  private worldLook: LookOptions | null = null;
  private _hull: Hull | null = null;
  /** Whether the hull's load answered (`hull` is its answer, null for none): swaps keep it. */
  private hullIn = false;
  /** How many times `hull` has changed (`hullVersion`). */
  private hullChanges = 0;
  /** `surfaceBelow`'s point, made once. */
  private readonly feetProbe = new THREE.Vector3();
  /**
   * The map's bake: one load, asked for with the first manifest in and shared by every world
   * load of the map, answering null when the map has none or it failed.
   */
  private bakeLoad: Promise<Baked | null> | null = null;
  /** The bake the world is drawn with (`look.baked`), or null for the look without one. */
  private _baked: Baked | null = null;
  /** The map's doors and breakables (`mapents.ts`); null for a map without entities.glb. */
  private _entities: MapEntities | null = null;
  /** Whether the load of entities.glb answered (`entities`, null for none): swaps keep them. */
  private entitiesIn = false;
  /** The pack drawn (`bind`), and the one `entities` was bound to last. */
  private pack: Pack | null = null;
  private entitiesPack: Pack | null = null;
  private disposed = false;

  /**
   * Hears a world file's bytes as they arrive, and the file's size from the manifest (null
   * when it does not say): the viewer's progress while the world loads.
   */
  onWorldBytes: ((loaded: number, total: number | null) => void) | null = null;

  constructor(host: MapHost) {
    this.host = host;
  }

  /** The world drawn, or null before the first one is in. */
  get world(): THREE.Group | null {
    return this._world;
  }

  /**
   * The map's collision hull, or null without a map, while it loads, or when the map has
   * none (tracers then run their whole reach).
   */
  get hull(): Hull | null {
    return this._hull;
  }

  /** Counts the hulls taken and dropped: it changes whenever `hull` does. */
  get hullVersion(): number {
    return this.hullChanges;
  }

  /** The map's bake the world is drawn with, or null: none, failed, or not in yet. */
  get baked(): Baked | null {
    return this._baked;
  }

  /** The map's doors and breakables, or null: none, failed, or not in yet. */
  get entities(): MapEntities | null {
    return this._entities;
  }

  /**
   * Loads the map last asked for again, at the scene's tier now (a change of tier); a caller of
   * `load` joins it to hear how it went.
   */
  reload(): void {
    if (this.map) this.load(this.map).catch(() => {});
  }

  /**
   * Dresses the world, where it is the file of the scene's tier (a change of tier is swapping it
   * otherwise), and the doors and breakables in the scene's look of now.
   */
  relook(): void {
    if (this.worldStays()) this.dressWorld();
    // The doors and breakables are drawn as the world is: on a baked map, by the probes'
    // light in their COLOR_0 (tools/shrink-map.mjs), without the detail texture.
    if (this._entities) applyLook(this._entities.models, this.host.look());
    if (this._world || this._entities)
      this.host.lighting.invalidateWorldShadow();
  }

  /**
   * Whether the world drawn is the file the scene's tier loads: false while a change of tier
   * swaps it for the other one.
   */
  private worldStays(): boolean {
    return (
      !!this.map &&
      this.worldUrl ===
        mapFileUrl(
          this.map,
          this.worldManifest,
          worldFile(this.worldManifest, this.host.phone())
        )
    );
  }

  /** Dresses the world in the scene's look of now, unless it is in it. */
  private dressWorld(): void {
    const world = this._world;
    const look = this.host.look();
    if (!world || (this.worldLook && sameLook(this.worldLook, look))) return;
    applyLook(world, look);
    this.worldLook = look;
    this.host.lighting.invalidateWorldShadow();
    this.host.invalidate();
  }

  /**
   * Loads `/maps/<map>/world.glb` (at the scene's phone tier, `low`'s: `setQuality`, its
   * `world_lo.glb` where the manifest lists it), each file by the versioned URL its manifest
   * (`mapManifest`) gives it, and fits the cameras to the first world drawn; a change of tier
   * swaps the world under the same view, and a call that names the file already drawn keeps it.
   * A scene draws one map: the first call names it, and a call for another rejects (a new map
   * needs a new Scene; the viewer makes one per demo). Beside the first world it loads
   * `/maps/<map>/hull.glb` into `hull`; a hull that is missing or does not parse logs once and
   * leaves `hull` null without failing the load. The cameras and the sun's shadow are fitted to
   * the hull's bounds, or to the world's without a hull. When the manifest lists light.json,
   * the map's bake (baked.ts) loads beside the world (light.json, then its lightmap), once for
   * every world of the map, and the world is drawn in it at every preset, the sun shining from
   * its direction; a bake that is missing or broken logs once and the map is drawn as without
   * one. When the manifest lists it, the first world also brings `/maps/<map>/entities.glb`, its
   * doors and breakables (`MapEntities`), dressed as the world is (by the bake, with one); the
   * phone-tier swap keeps them, as it keeps the hull. The map's sky.webp, when its manifest
   * lists one, loads the first time a preset shows the sky (`SkyAndFog`). When the server has no
   * assets for the map (a 404 manifest) the call rejects with `MissingAssetsError`, the scene
   * left empty (a manifest once in is kept for the page, so no world of the map was drawn); a
   * later call asks again. A manifest request that fails otherwise, or a world that does not
   * load, rejects with that error and keeps the world drawn. Of overlapping calls only the last
   * one has an effect: the others resolve without one, failed requests and all; a call that
   * would load the world of the call in flight (before its manifest is in, or the file the
   * scene's tier names) joins it, so a change of tier's own load and the viewer's call at each
   * preset load each world once. The world and the doors are dressed once, in the look of the
   * map's bake, when all are in.
   */
  load(map: string): Promise<void> {
    if (this.map !== null && map !== this.map)
      return Promise.reject(
        new Error(
          `this scene draws ${this.map}; ${map} needs a scene of its own`
        )
      );
    this.map = map;
    const now = this.mapLoad;
    if (
      now &&
      (now.file === null ||
        now.file === worldFile(now.manifest, this.host.phone()))
    )
      return now.done;
    const load: MapLoad = {
      manifest: null,
      file: null,
      done: Promise.resolve(),
    };
    load.done = this.loadAt(map, load);
    this.mapLoad = load;
    const settled = () => {
      if (this.mapLoad === load) this.mapLoad = null;
    };
    load.done.then(settled, settled);
    return load.done;
  }

  /** `load`'s call `load`, which learns its world file once the manifest is in. */
  private async loadAt(map: string, load: MapLoad): Promise<void> {
    const seq = ++this.mapLoads;
    const superseded = () => this.disposed || seq !== this.mapLoads;
    let manifest: MapManifest | null;
    try {
      manifest = await mapManifest(map);
    } catch (e) {
      if (superseded()) return;
      // The world drawn stays: in this preset's look, which a change of tier left to the swap.
      this.dressWorld();
      throw e;
    }
    if (superseded()) return;
    if (!manifest) {
      // Nothing of the map was drawn (a manifest once in is kept): the scene stays empty.
      this.dressWorld();
      throw new MissingAssetsError(map, 404);
    }
    const files = manifest.files;
    const file = (name: string) => mapFileUrl(map, manifest, name);
    // The tier of now: a change of tier while the manifest was on its way joined this call.
    load.manifest = manifest;
    load.file = worldFile(manifest, this.host.phone());
    const worldUrl = file(load.file);
    const worldBytes = files?.[load.file]?.bytes ?? null;
    // The same file (a preset change on a map without the phone tier): nothing to swap.
    if (this._world && worldUrl === this.worldUrl) return;
    // The look multiplies the detail texture into the world: wait for it (it is small and
    // was asked for when the scene was made).
    await this.host.lookReady();
    // Superseded meanwhile (a change of tier): nothing is asked for yet, so nothing to free.
    if (superseded()) return;
    // The hull is the same for both worlds of a map: the phone-tier swap keeps it.
    const hullLoad = this.hullIn ? null : this.fetchHull(map, file('hull.glb'));
    // So is the bake: every load shares its one load.
    const bakeLoad = (this.bakeLoad ??= files?.['light.json']
      ? this.fetchBake(map, file)
      : Promise.resolve(null));
    // And the doors and breakables, when the map has any.
    const entitiesLoad = this.entitiesIn
      ? null
      : this.fetchEntities(
          map,
          files?.['entities.glb'] ? file('entities.glb') : null
        );
    let world: THREE.Group;
    try {
      // Undressed: the look waits for the bake (and the preset may change meanwhile).
      world = await loadWorld(worldUrl, (loaded) => {
        if (!superseded()) this.onWorldBytes?.(loaded, worldBytes);
      });
    } catch (e) {
      void hullLoad?.then((h) => h?.dispose());
      void entitiesLoad?.then((g) => g && disposeObject(g));
      if (superseded()) return;
      this.dressWorld();
      throw e;
    }
    const hull = hullLoad ? await hullLoad : undefined;
    const bake = await bakeLoad;
    const entities = entitiesLoad ? await entitiesLoad : undefined;
    if (superseded()) {
      disposeObject(world);
      hull?.dispose();
      if (entities) disposeObject(entities);
      return;
    }
    const first = !this._world;
    this.dropWorld();
    // The bake decides the tone mapping, the shadow and the look of the world and the players.
    this.setBaked(bake);
    this.host.relight();
    const look = this.host.look();
    applyLook(world, look);
    this.worldLook = look;
    world.name = 'world';
    // A baked world casts only into the sun's own map, drawn apart from the players'
    // (Lighting.drawWorldShadow): the renderer's pass every frame holds the players', which
    // darken the baked light, or the live sun on it (baked.ts).
    castAndReceive(world, this.castsEveryFrame());
    this._world = world;
    this.worldUrl = worldUrl;
    this.worldManifest = manifest;
    this.host.scene.add(world);
    this.host.lighting.invalidateWorldShadow();
    if (hull !== undefined) {
      this.setHull(hull);
      this.hullIn = true;
    }
    if (entities !== undefined) {
      if (entities) applyLook(entities, look);
      this.setEntities(entities);
      this.entitiesIn = true;
    } else if (this._entities) {
      // Kept for the phone-tier swap: dressed by `relook`; they cast as the world does.
      castAndReceive(this._entities.models, this.castsEveryFrame());
    }
    if (first) {
      // The hull spans where anyone plays; the world also holds the skybox props around it.
      const h = this._hull;
      const bounds = h ? h.bounds : new THREE.Box3().setFromObject(world);
      this.host.cameras.setBounds(bounds);
      this.host.lighting.setSun(bake?.info.sun ?? null);
      this.host.lighting.fit(
        bounds,
        Lighting.reachOf(
          h ? h.geometry : world,
          bounds,
          this.host.lighting.direction
        )
      );
      this.host.sky.setSky(
        map,
        files?.['sky.webp'] ? file('sky.webp') : null,
        horizonOf(manifest)
      );
      this.setAtmosphere(atmosphereFor(map));
    }
    this.host.changed();
  }

  /**
   * `map`'s light.json and the lightmap and light grid it names, by the URLs `file` gives them,
   * or null, logged once, when light.json or the grid is missing, light.json is not a bake this
   * viewer can draw or the grid is not one: the map is then drawn as without a bake, its players
   * included. A lightmap that is missing or does not decode beside a grid that loaded is logged
   * once too, and the bake kept without it: its vertex-lit primitives keep their light, and the
   * lightmapped ones are drawn as without a bake (`loadBaked`).
   */
  private async fetchBake(
    map: string,
    file: (name: string) => string
  ): Promise<Baked | null> {
    const url = file('light.json');
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const info = parseLightInfo(await jsonOrNull(res));
      if (!info) throw new Error(`${url} is not a bake this viewer can draw`);
      const b = await loadBaked(file, info);
      if (b.lightmapError)
        console.warn(
          `${map}: no lightmap (${b.lightmapError}); ` +
            'the surfaces it lights are drawn without the bake, the rest with it'
        );
      return b;
    } catch (e) {
      console.warn(
        `${map}: no baked light (${e instanceof Error ? e.message : String(e)}); ` +
          'the map is drawn without it'
      );
      return null;
    }
  }

  /** Draws the world with bake `b` from now on, freeing the one it replaces. */
  private setBaked(b: Baked | null): void {
    if (b === this._baked) return;
    if (this._baked) disposeBaked(this._baked);
    this._baked = b;
  }

  /** The hull at `url` under its BVH, or null (logged) when it is missing or does not parse. */
  private async fetchHull(map: string, url: string): Promise<Hull | null> {
    try {
      return new Hull(await loadHull(url));
    } catch (e) {
      console.warn(
        `${map}: no collision hull (${e instanceof Error ? e.message : String(e)}); ` +
          'tracers will not stop at walls'
      );
      return null;
    }
  }

  /** Takes `hull` (null for none), freeing the one it replaces. */
  private setHull(hull: Hull | null): void {
    if (this._hull && this._hull !== hull) {
      // Nothing keeps the old one: the bullet marks found on it go with it.
      this.host.marks.forget(this._hull);
      this._hull.dispose();
    }
    if (hull !== this._hull) this.hullChanges++;
    this._hull = hull;
  }

  /**
   * The doors and breakables at `url`, undressed (`load` dresses them with the world, once
   * the map's bake is in), or null without a url (the map has none) or when they do not load
   * (logged: the world was built without them, so they are missing from the map).
   */
  private async fetchEntities(
    map: string,
    url: string | null
  ): Promise<THREE.Group | null> {
    if (!url) return null;
    try {
      return await loadWorld(url);
    } catch (e) {
      console.warn(
        `${map}: no doors or breakables (${e instanceof Error ? e.message : String(e)}); ` +
          'they are missing from the map'
      );
      return null;
    }
  }

  /**
   * Takes the doors and breakables (null for none), freeing the ones they replace, bound to the
   * pack shown last when it is of the scene's map. They cast the sun's
   * shadow as the world does (`castsEveryFrame`): where the shadow is split, only into the
   * world's map, which is drawn again whenever one of them moves (`Scene.poseUtility`), so the
   * players are in a door's shadow where it stands and the baked world is not darkened twice.
   */
  private setEntities(models: THREE.Group | null): void {
    this._entities?.dispose();
    this._entities = null;
    this.entitiesPack = null;
    if (models) {
      castAndReceive(models, this.castsEveryFrame());
      this._entities = new MapEntities(models, this.host.effects);
      this.host.scene.add(this._entities.root);
    }
    this.host.lighting.invalidateWorldShadow();
    this.bindEntities();
  }

  /**
   * Whether the world and its doors cast the sun's shadow in the renderer's pass every frame:
   * yes without a bake; no with one, where they cast only while `Lighting.drawWorldShadow` draws
   * the world's own map (a sun in the bake, or Cache's drawn at runtime: the shadow is split), or
   * nothing at all (no sun, no shadow map).
   */
  private castsEveryFrame(): boolean {
    return !this._baked;
  }

  /**
   * The pack drawn (`Scene.setFrame`), whose doors and breakables are matched to the map's,
   * once per pack, when it is of their map; ones that load later are matched to it then.
   */
  bind(pack: Pack): void {
    this.pack = pack;
    this.bindEntities();
  }

  /** Matches the doors and breakables to the pack drawn, once per pack, when it is of their map. */
  private bindEntities(): void {
    const pack = this.pack;
    if (
      !this._entities ||
      !pack ||
      this.entitiesPack === pack ||
      pack.header.map !== this.map
    )
      return;
    this._entities.bind(pack);
    this.entitiesPack = pack;
  }

  /** Removes and frees the world drawn, if any (a swap's outgoing one). */
  private dropWorld(): void {
    if (this._world) {
      this._world.removeFromParent();
      disposeObject(this._world);
    }
    this._world = null;
    this.worldUrl = null;
    this.worldManifest = null;
    this.worldLook = null;
    this.host.lighting.invalidateWorldShadow();
  }

  /**
   * The sky, fog and light colours of a map, or the dark empty scene for none. Where the sun is
   * in the map's bake, the sun the players and the viewmodel take is the bake's own, as it lit
   * the world's sunlit surfaces; where it is drawn at runtime beside the bake (de_cache), the
   * world's and the players' sun is light.json's at the bake's scale; a bake without a sun
   * (Train's) leaves them without one; any map without a bake keeps the atmosphere's.
   */
  private setAtmosphere(a: Readonly<Atmosphere> | null): void {
    if (a) {
      const b = this._baked;
      const mode = b ? sunModeOf(b.info) : null;
      this.host.lighting.setColors(a, mode !== 'none');
      // light.json's sun, as the bake lights the world with it (π times its brightness), where it
      // is in the bake and where it is drawn at runtime beside an irradiance-only lightmap
      // (de_cache): there it is the world's only sun.
      if (b?.info.sun && (mode === 'baked' || mode === 'live'))
        this.host.lighting.setBakedSun(b.info.sun);
    }
    this.host.sky.setAtmosphere(a, !!this._baked);
  }

  /**
   * The surface under the feet at the Source point `(x, y, z)` (units), as the hull names it
   * (`Hull.surfaceBelow`): the first face from 8 units over the feet down to 32 under them.
   * Null without a hull, over nothing in reach, or on a hull without surface names.
   */
  surfaceBelow(x: number, y: number, z: number): string | null {
    const hull = this._hull;
    if (!hull) return null;
    toScene(x, y, z + FEET_ABOVE, this.feetProbe);
    return hull.surfaceBelow(this.feetProbe, (FEET_ABOVE + FEET_BELOW) * UNIT);
  }

  /** Frees the world, the bake (one still on its way once it is in), the hull and the doors. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropWorld();
    const held = this._baked;
    this.setBaked(null);
    // A bake still on its way is freed once in; the one held, which that load brought, just was.
    void this.bakeLoad?.then((b) => b && b !== held && disposeBaked(b));
    this.setHull(null);
    this.setEntities(null);
  }
}
