import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectsManifest } from '../src/api/assets';
import type { LabelCanvas } from '../src/scene/labels';
import { FLAMES } from '../src/scene/fire';
import { onceFrame } from '../src/scene/flipbook';
import {
  DECOY,
  FIRE,
  FIRE_BAKED_LIGHT,
  FLASH,
  HE,
  LABEL,
  POOLS,
  SMOKE,
  SMOKE_ALBEDO,
  SMOKE_FRAME_GAIN,
  SMOKE_TINT,
  Utility,
  type UtilityOptions,
} from '../src/scene/utility';
import { HE_S } from '../src/sim/timeline';
import { UNLIT_LOOK, type LookOptions } from '../src/scene/look';
import { EFFECTS_LAYER } from '../src/scene/post';
import { WeaponCache } from '../src/scene/weapons';
import { toScene } from '../src/geo/coords';
import { Timeline } from '../src/sim/timeline';
import { countCalls } from './helpers/count-calls';
import {
  flush,
  stubAtlases as stubEffectAtlases,
} from './helpers/stub-atlases';
import { lightGrid } from './helpers/light-grid';

// The grid sampler, spied through: a smoke samples the grid again only when its inputs change.
vi.mock('../src/scene/probes', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/scene/probes')>();
  return { ...m, sampleLightGrid: vi.fn(m.sampleLightGrid) };
});
import { makeProbeSample, sampleLightGrid } from '../src/scene/probes';
import { event, grenadeTrack, trackPack } from './helpers/track-pack';

const R = 64;
const LIT: LookOptions = { lit: true, smoothNormals: true, maxAnisotropy: 8 };
const at = (e: string, tick: number, id: number, x = 0, y = 0, z = 0) =>
  event(e, tick, { entityid: id, user_idx: 0, x, y, z });

/** The fixture's match; its smoke goes off at Source x `smokeX`. */
function timeline(smokeX = 400) {
  const smoke = grenadeTrack({
    kind: 'smoke',
    thrower: 0,
    start_tick: 1000,
    from: [0, 0, 64],
    to: [400, 0, 64],
    samples: 51,
    entity_id: 5,
  });
  smoke.detonate_tick = 1100;
  return new Timeline(
    trackPack({
      samples: 2500,
      players: [() => ({ x: 0, y: 0 }), () => ({ x: 100, y: 0 })],
      events: [
        at('smokegrenade_detonate', 1100, 5, smokeX, 0, 0),
        at('smokegrenade_expired', 1500, 5, smokeX, 0, 0),
        at('inferno_startburn', 2000, 9, 1000, 0, 0),
        at('inferno_expire', 2300, 9, 1000, 0, 0),
        at('flashbang_detonate', 3000, 11),
        at('hegrenade_detonate', 3100, 12),
        at('decoy_started', 3200, 13),
        at('decoy_detonate', 3300, 13),
      ],
      grenades: [smoke],
    })
  );
}

const fakeCanvas = (width: number, height: number): LabelCanvas => ({
  width,
  height,
  getContext: () => ({
    clearRect() {},
    fillText() {},
    strokeText() {},
  }),
});

/** The effects manifest's fire atlases (CS2 build 2000935). */
const FIRE_ATLASES: EffectsManifest = {
  atlases: {
    fire: {
      file: 'fire.webp',
      width: 1024,
      height: 1008,
      cell: [64, 112],
      cols: 16,
      frames: 131,
      sequences: [
        [0, 12],
        [12, 11],
        [23, 12],
        [35, 12],
        [47, 11],
        [58, 11],
        [69, 12],
        [81, 25],
        [106, 25],
      ],
    },
    fireburst: {
      file: 'fireburst.webp',
      width: 1024,
      height: 576,
      cell: [64, 64],
      cols: 16,
      frames: 131,
      sequences: [
        [0, 32],
        [32, 33],
        [65, 33],
        [98, 33],
      ],
    },
  },
};

/** Every atlas the utility draws from, as the effects manifest lists them (CS2 build 2000935). */
const ATLASES: EffectsManifest = {
  atlases: {
    ...FIRE_ATLASES.atlases,
    smoke: {
      file: 'smoke.webp',
      width: 1024,
      height: 512,
      cell: [128, 128],
      cols: 8,
      frames: 32,
      sequences: [[0, 32]],
    },
    explosion: {
      file: 'explosion.webp',
      width: 1024,
      height: 640,
      cell: [128, 128],
      cols: 8,
      frames: 40,
      sequences: [[0, 40]],
    },
    flare: {
      file: 'flare.webp',
      width: 1024,
      height: 128,
      cell: [128, 128],
      cols: 8,
      frames: 1,
      sequences: [[0, 1]],
    },
    muzzle: {
      file: 'muzzle.webp',
      width: 1024,
      height: 64,
      cell: [64, 64],
      cols: 16,
      frames: 15,
      sequences: [[0, 15]],
    },
    sparks: {
      file: 'sparks.webp',
      width: 1024,
      height: 64,
      cell: [32, 64],
      cols: 32,
      frames: 10,
      sequences: [
        [0, 9],
        [9, 1],
      ],
    },
  },
};
const ATLAS_FILES = Object.values(ATLASES.atlases!).map((a) => a!.file);

/** Atlases whose textures arrive when the test says (`release`); `manifest` null is a 404. */
const stubAtlases = (manifest: EffectsManifest | null = ATLASES) =>
  stubEffectAtlases(manifest);

function utility(atlases = stubAtlases().atlases) {
  const cache = new WeaponCache(async () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)));
    return g;
  });
  return new Utility(cache, atlases, LIT, fakeCanvas);
}

function opts(o: Partial<UtilityOptions> = {}): UtilityOptions {
  return {
    labels: true,
    trails: true,
    lights: true,
    fogColor: new THREE.Color(0x8899aa),
    eye: new THREE.Vector3(0, 2, -10),
    worldPerPixel: 0.001,
    exposure: 1.6,
    grid: null,
    sunLight: null,
    ...o,
  };
}

const visible = (root: THREE.Object3D) =>
  root.children.filter((c) => c.visible && !(c instanceof THREE.Light));

type Batch = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
/** A flipbook batch of the utility (`flipbook.ts`) by its name. */
const batch = (root: THREE.Object3D, name: string) =>
  root.getObjectByName(name) as Batch;
/** How many sprites a batch draws: none while it is hidden. */
const drawn = (b: Batch) => (b.visible ? b.geometry.instanceCount : 0);
/** Sprite `i` of a batch as pushed. */
function sprite(b: Batch, i: number) {
  const g = b.geometry;
  const c = g.getAttribute('aCentre');
  const s = g.getAttribute('aSize');
  const k = g.getAttribute('aColor');
  return {
    at: new THREE.Vector3(c.getX(i), c.getY(i), c.getZ(i)),
    w: s.getX(i),
    h: s.getY(i),
    rotation: s.getZ(i),
    frame: s.getW(i),
    color: new THREE.Color(k.getX(i), k.getY(i), k.getZ(i)),
    alpha: k.getW(i),
  };
}
const sprites = (b: Batch) =>
  Array.from({ length: drawn(b) }, (_, i) => sprite(b, i));

const count = (root: THREE.Object3D) => {
  let n = 0;
  root.traverse(() => n++);
  return n;
};

/** A Utility whose grenade models have a texture, as the real ones do, and the cache it loads them from. */
async function texturedUtility() {
  const cache = new WeaponCache(async () => {
    const g = new THREE.Group();
    g.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.1, 0.1),
        new THREE.MeshStandardMaterial({ map: new THREE.Texture() })
      )
    );
    return g;
  });
  cache.get('smokegrenade');
  await flush();
  return {
    u: new Utility(cache, stubAtlases().atlases, LIT, fakeCanvas),
    cache,
  };
}

describe('Utility', () => {
  it('dresses a grenade in flight in the look, as the players’ weapons are, whatever was held before', async () => {
    const { u, cache } = await texturedUtility();
    u.set(0, 1040, timeline(), opts());
    const grenade = u.root.getObjectByName('grenade:smokegrenade')!;
    const mesh = grenade.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const m = mesh.material as THREE.MeshLambertMaterial;
    expect(m.isMeshLambertMaterial).toBe(true);
    // The cache's texture, filtered as every copy of it is under this look.
    const src = cache
      .get('smokegrenade')!
      .getObjectByProperty('isMesh', true) as THREE.Mesh;
    expect(m.map).toBe((src.material as THREE.MeshStandardMaterial).map);
    expect(m.map!.anisotropy).toBe(8);
    expect(mesh.geometry).toBe(src.geometry);
  });

  it('dresses the grenades again, freeing the old materials, when the look changes', async () => {
    const { u } = await texturedUtility();
    const tl = timeline();
    const mesh = () =>
      u.root
        .getObjectByName('grenade:smokegrenade')!
        .getObjectByProperty('isMesh', true) as THREE.Mesh;
    u.set(0, 1040, tl, opts());
    const before = count(u.root);
    let freed = 0;
    (mesh().material as THREE.Material).addEventListener(
      'dispose',
      () => freed++
    );
    u.setLook(UNLIT_LOOK);
    expect(freed).toBe(1);
    u.set(0, 1040, tl, opts());
    const m = mesh().material as THREE.MeshBasicMaterial;
    expect(m.isMeshBasicMaterial).toBe(true);
    expect(count(u.root)).toBe(before);
    m.addEventListener('dispose', () => (freed += 10));
    u.dispose();
    expect(freed).toBe(11);
  });

  it('lights a grenade in flight by the light grid where it is, on every frame it moves, by materials of its own; by the sky light without a grid', async () => {
    const { u } = await texturedUtility();
    const tl = timeline();
    const grid = lightGrid();
    const mesh = () =>
      u.root
        .getObjectByName('grenade:smokegrenade')!
        .getObjectByProperty('isMesh', true) as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshLambertMaterial
      >;
    const sample = () => {
      const src = THREE.ShaderLib.lambert;
      const shader = {
        uniforms: THREE.UniformsUtils.clone(src.uniforms),
        vertexShader: src.vertexShader,
        fragmentShader: src.fragmentShader,
      } as Parameters<THREE.Material['onBeforeCompile']>[0];
      mesh().material.onBeforeCompile(
        shader,
        null as unknown as THREE.WebGLRenderer
      );
      return {
        up: shader.uniforms.probeUp.value as THREE.Color,
        sun: shader.uniforms.probeSun.value as number,
      };
    };
    u.set(0, 1040, tl, opts({ grid }));
    expect(mesh().material.customProgramCacheKey()).toContain('probe');
    // At 64 units up, 1.63 m: 0.65 of the way to the bright cells.
    const at = toScene(160, 0, 64, new THREE.Vector3()) as THREE.Vector3;
    expect(sample().sun).toBeCloseTo(at.y / 2.5, 6);
    // The shadow maps reach it at medium and high; it casts none, as before.
    expect(mesh().receiveShadow).toBe(true);
    expect(mesh().castShadow).toBe(false);
    // It flies: sampled again on the next frame.
    sample().up.r = 99;
    u.set(0, 1060, tl, opts({ grid }));
    expect(sample().up.r).toBeCloseTo((at.y / 2.5) * 8, 5);
    // Without a grid: the sky light, and no shadow, as before.
    u.set(0, 1060, tl, opts());
    expect(mesh().material.customProgramCacheKey()).not.toContain('probe');
    expect(mesh().receiveShadow).toBe(false);
  });

  it('shows a smoke of 16 puffs at full size in the fog colour, gone after it expires', () => {
    const u = utility();
    const tl = timeline();
    u.set(0, 1200, tl, opts());
    const smokes = batch(u.root, 'smokes');
    expect(visible(u.root)).toEqual([smokes]);
    const puffs = sprites(smokes);
    expect(puffs).toHaveLength(SMOKE.puffs);
    const centre = toScene(400, 0, 0, new THREE.Vector3()) as THREE.Vector3;
    for (const puff of puffs) {
      // Around the grenade, up to the smoke's radius out.
      const off = puff.at.clone().sub(centre);
      expect(Math.hypot(off.x, off.z)).toBeLessThanOrEqual(SMOKE.radius / 2);
      expect(off.y).toBeGreaterThan(0);
      expect(puff.w).toBeGreaterThanOrEqual(SMOKE.radius * 0.95 - 1e-6);
      expect(puff.h).toBe(puff.w);
      // The generated puff (no atlas yet), drawn whole and upright as the sprites were.
      expect(puff.color.getHex()).toBe(0x8899aa);
      expect(puff.alpha).toBeCloseTo(SMOKE.opacity, 6);
      expect(puff.rotation).toBe(0);
    }
    expect(smokes.material.uniforms.uMap.value).toBeInstanceOf(
      THREE.DataTexture
    );
    u.set(0, 1500, tl, opts());
    expect(visible(u.root)).toHaveLength(0);
  });

  it('flies a grenade with its model, a trail of its last 1.2 s and a label at a fixed screen size', async () => {
    const u = utility();
    const tl = timeline();
    u.set(0, 1040, tl, opts());
    await new Promise((r) => setTimeout(r, 0)); // the model arrives
    u.set(0, 1040, tl, opts());
    const shown = visible(u.root);
    const group = shown.find((c) => c instanceof THREE.Group)!;
    const ribbon = shown.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    // 40 ticks of flight at a step of 2: 21 points, 20 quads.
    expect(ribbon.geometry.drawRange.count).toBe(20 * 6);
    expect(group.getObjectByName('grenade:smokegrenade')?.visible).toBe(true);
    const where = toScene(160, 0, 64, new THREE.Vector3()) as THREE.Vector3;
    expect(group.position.distanceTo(where)).toBeLessThan(1e-6);
    const label = group.children.find(
      (c) => c instanceof THREE.Sprite && c.center.y === 0
    ) as THREE.Sprite;
    expect(label.visible).toBe(true);
    const h = where.distanceTo(opts().eye) * 0.001 * LABEL.pixels;
    expect(label.scale.y).toBeCloseTo(h, 9);
    u.set(0, 1040, tl, opts({ labels: false, trails: false }));
    expect(label.visible).toBe(false);
    expect(ribbon.visible).toBe(false);
  });

  it("on a baked map draws a smoke grey-white (SMOKE_ALBEDO), lit by the light grid where it stands and the sun past it, not in the horizon's colour", () => {
    const u = utility();
    const tl = timeline();
    const grid = lightGrid();
    const sunLight = new THREE.Color(2, 1.5, 1);
    u.set(0, 1200, tl, opts({ grid, sunLight }));
    const centre = (
      toScene(400, 0, 0, new THREE.Vector3()) as THREE.Vector3
    ).setY(SMOKE.lift);
    const s = sampleLightGrid(grid, centre, makeProbeSample());
    // Over the sphere of directions CS2's cube weighting averages to up/6 + down/6 + 2·side/3,
    // and a Lambert sphere takes a quarter of the sun; the smoke keeps SMOKE_TINT of the
    // light's colour, the rest its brightness alone.
    const light = (c: 'r' | 'g' | 'b') =>
      s.up[c] / 6 +
      s.down[c] / 6 +
      (2 * s.side[c]) / 3 +
      0.25 * s.sun * sunLight[c];
    const lum = 0.2126 * light('r') + 0.7152 * light('g') + 0.0722 * light('b');
    const want = (c: 'r' | 'g' | 'b') =>
      SMOKE_ALBEDO * (lum + SMOKE_TINT * (light(c) - lum));
    const puff = () => sprite(batch(u.root, 'smokes'), 0).color;
    for (const c of ['r', 'g', 'b'] as const)
      expect(puff()[c]).toBeCloseTo(want(c), 6);
    expect(puff().getHex()).not.toBe(0x8899aa);
    const lit = u.smokeColorAt(centre)!;
    for (const c of ['r', 'g', 'b'] as const)
      expect(lit[c]).toBeCloseTo(puff()[c], 6);
    expect(u.smokeColorAt(centre.clone().setX(centre.x + 5))).toBeNull();
    // Without a grid (a map without a bake) it is the fog's colour as before, and the fog stays
    // the scene's own.
    u.set(0, 1200, tl, opts());
    expect(puff().getHex()).toBe(0x8899aa);
    expect(u.smokeColorAt(centre)).toBeNull();
  });

  it("samples a smoke's light again only when the grid, its centre or the sun changes", () => {
    const u = utility();
    const tl = timeline();
    const grid = lightGrid();
    const centre = (
      toScene(400, 0, 0, new THREE.Vector3()) as THREE.Vector3
    ).setY(SMOKE.lift);
    const sampled = vi.mocked(sampleLightGrid);
    const sunLight = new THREE.Color(2, 1.5, 1);
    const before = sampled.mock.calls.length;
    u.set(0, 1200, tl, opts({ grid, sunLight }));
    // The smoke's samples are at its slot's centre, a vector of its own that moves with it: the
    // spy keeps it by reference, so its calls are found by identity, not by where it is now.
    const mine = sampled.mock.calls
      .slice(before)
      .find(([, p]) => p.equals(centre))![1];
    const atSmoke = () =>
      sampled.mock.calls.filter(([, p]) => p === mine).length;
    const puff = () => sprite(batch(u.root, 'smokes'), 0).color;
    const first = puff().clone();
    expect(atSmoke()).toBe(1);
    // The same inputs, a later tick (a new but equal sun colour): no new sample.
    u.set(0, 1300, tl, opts({ grid, sunLight: sunLight.clone() }));
    expect(atSmoke()).toBe(1);
    expect(puff().getHex()).toBe(first.getHex());
    // Another sun: sampled again, and brighter.
    u.set(0, 1300, tl, opts({ grid, sunLight: new THREE.Color(4, 3, 2) }));
    expect(atSmoke()).toBe(2);
    expect(puff().r).toBeGreaterThan(first.r);
    // Another grid (the next map's): sampled again.
    const other = lightGrid();
    u.set(0, 1300, tl, opts({ grid: other, sunLight }));
    expect(atSmoke()).toBe(3);
    expect(puff().getHex()).toBe(first.getHex());
    // The smoke 5 m away (another match's, in the same slot): sampled again, where it is now;
    // still there on the next frame, not again.
    const moved = (
      toScene(600, 0, 0, new THREE.Vector3()) as THREE.Vector3
    ).setY(SMOKE.lift);
    u.set(0, 1300, timeline(600), opts({ grid: other, sunLight }));
    expect(atSmoke()).toBe(4);
    expect(mine.equals(moved)).toBe(true);
    u.set(0, 1310, timeline(600), opts({ grid: other, sunLight }));
    expect(atSmoke()).toBe(4);
    // Back where it was: sampled there again.
    u.set(0, 1300, tl, opts({ grid: other, sunLight }));
    expect(atSmoke()).toBe(5);
    expect(mine.equals(centre)).toBe(true);
  });

  it('knows when the eye is inside a smoke', () => {
    const u = utility();
    u.set(0, 1300, timeline(), opts());
    const inside = (
      toScene(400, 0, 0, new THREE.Vector3()) as THREE.Vector3
    ).setY(1.2);
    expect(u.eyeInSmoke(inside)).toBe(true);
    expect(u.eyeInSmoke(inside.clone().setX(inside.x + 5))).toBe(false);
  });

  it('burns a fire as one mesh of flames timed by its age, smoke rising off it', () => {
    const u = utility();
    const tl = timeline();
    const fireAt = () =>
      visible(u.root).find(
        (c) => c instanceof THREE.Group && c.getObjectByName('fire-smoke')
      ) as THREE.Group;
    u.set(0, 2000 + 2 * R, tl, opts());
    const fire = fireAt();
    expect(fire).toBeDefined();
    const flames = fire.getObjectByName('fire-flames') as Batch;
    expect(flames.geometry.instanceCount).toBe(FIRE.flames);
    expect(flames.material.uniforms.uTime.value).toBeCloseTo(2, 6);
    expect(flames.material.uniforms.uStrength.value).toBe(1);
    // The exposure the tone mapping multiplies in is divided out of the flame colours.
    expect(flames.material.uniforms.uExposure.value).toBe(1.6);
    // The smoke column: one batch of the fire's puffs, in its frame, those not faded out.
    const smoke = batch(fire, 'fire-smoke');
    expect(smoke.parent).toBe(fire);
    const puffs = sprites(smoke);
    expect(puffs.length).toBeGreaterThan(0);
    expect(puffs.length).toBeLessThanOrEqual(FLAMES.smokePuffs);
    expect(puffs.some((s) => s.alpha > 0.05)).toBe(true);
    expect(puffs.every((s) => s.at.y >= FLAMES.smokeBase - 1e-6)).toBe(true);
    expect(puffs.every((s) => s.color.getHex() === 0x3d3834)).toBe(true);
    // The same tick gives the same frame, however it was reached.
    const at = puffs.map((s) => s.at.toArray());
    u.set(0, 2250, tl, opts());
    u.set(0, 2000 + 2 * R, tl, opts());
    expect(sprites(smoke).map((s) => s.at.toArray())).toEqual(at);
  });

  it('lights the fire at high and keeps the light count fixed', () => {
    const u = utility();
    const tl = timeline();
    const lights = () =>
      u.root.children.filter(
        (c) => c instanceof THREE.PointLight
      ) as THREE.PointLight[];
    u.set(0, 2150, tl, opts());
    expect(lights()).toHaveLength(FIRE.lights);
    expect(lights().every((l) => l.visible)).toBe(true);
    expect(lights()[0].intensity).toBeGreaterThan(0);
    expect(lights()[1].intensity).toBe(0);
    u.set(0, 2400, tl, opts());
    expect(lights().every((l) => l.visible && l.intensity === 0)).toBe(true);
    u.set(0, 2150, tl, opts({ lights: false }));
    expect(lights().every((l) => !l.visible)).toBe(true);
  });

  it("on a baked map lights only the fire's surroundings: FIRE_BAKED_LIGHT's reach and strength, not the 9 m of a map without a bake", () => {
    const u = utility();
    const tl = timeline();
    const lights = () =>
      u.root.children.filter(
        (c) => c instanceof THREE.PointLight
      ) as THREE.PointLight[];
    u.set(0, 2150, tl, opts());
    expect(lights()[0].distance).toBe(FIRE.distance);
    const plain = lights()[0].intensity;
    u.set(0, 2150, tl, opts({ grid: lightGrid() }));
    expect(
      lights().every((l) => l.distance === FIRE_BAKED_LIGHT.distance)
    ).toBe(true);
    expect(FIRE_BAKED_LIGHT.distance).toBeLessThanOrEqual(4);
    expect(lights()[0].intensity / plain).toBeCloseTo(
      FIRE_BAKED_LIGHT.light / FIRE.light,
      9
    );
    u.set(0, 2150, tl, opts());
    expect(lights()[0].distance).toBe(FIRE.distance);
  });

  it('bursts a flash to 4 m in 80 ms and fades it', () => {
    const u = utility();
    const tl = timeline();
    u.set(0, 3000 + 0.04 * R, tl, opts());
    const flash = visible(u.root)[0] as THREE.Group;
    const core = flash.children[0] as THREE.Sprite;
    expect(core.scale.x).toBeCloseTo(FLASH.size / 2, 6);
    u.set(0, 3000 + 0.2 * R, tl, opts());
    expect(core.material.opacity).toBeCloseTo(1 - 0.12 / FLASH.fadeS, 6);
  });

  it("puts what adds light on the effects layer beside the default one, for a baked world's bloom (post.ts): the fires, the flash's, HE's and decoy's cores, the HE's fireball and the grenades' glow, and CS2's fireball, decoy flash and sparks; not the smokes, the HE's smoke, the fire's smoke, the HE's ring or the labels", () => {
    const u = utility();
    const tl = timeline();
    const effect = (o: THREE.Object3D) =>
      o.layers.isEnabled(EFFECTS_LAYER) && o.layers.isEnabled(0);
    const drawn: (THREE.Mesh | THREE.Sprite)[] = [];
    u.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) drawn.push(o);
    });
    // Everything additive is an effect; so are the flames and their burst (premultiplied).
    let additive = 0;
    for (const o of drawn) {
      const m = o.material as THREE.Material;
      if (m.blending === THREE.AdditiveBlending) {
        additive++;
        expect(effect(o)).toBe(true);
      }
      if (o.name === 'fire-flames' || o.name === 'fire-burst')
        expect(effect(o)).toBe(true);
      if (o.name === 'fire-smoke') expect(effect(o)).toBe(false);
    }
    expect(additive).toBeGreaterThan(POOLS.fires);
    // CS2's frames: the batches that add light are effects, those that cover are not.
    for (const name of ['he-fireball', 'decoy-flash', 'decoy-sparks']) {
      const b = batch(u.root, name);
      expect(b.material.blendDst, name).toBe(THREE.OneFactor);
      expect(effect(b), name).toBe(true);
    }
    for (const name of ['smokes', 'he-smoke']) {
      const b = batch(u.root, name);
      expect(b.material.blending, name).toBe(THREE.NormalBlending);
      expect(effect(b), name).toBe(false);
    }
    expect(drawn.filter((o) => o.name === 'fire-smoke').length).toBe(
      POOLS.fires
    );
    // The HE's fireball (its puff, normal-blended) is one, its ring on the ground is not.
    u.set(0, 3100 + 0.05 * R, tl, opts());
    const he = visible(u.root).find((c) =>
      c.children.some((k) => k instanceof THREE.Mesh)
    )!;
    const [core, ball, ring] = he.children;
    expect(effect(core)).toBe(true);
    expect(effect(ball)).toBe(true);
    expect(effect(ring)).toBe(false);
    // The smokes are not.
    u.set(0, 1200, tl, opts());
    const smoke = visible(u.root)[0];
    smoke.traverse((o) => expect(effect(o)).toBe(false));
  });

  it('allocates nothing over twenty seeks back and forth, with and without the atlases', async () => {
    const s = stubAtlases();
    const u = utility(s.atlases);
    const tl = timeline();
    const ticks = [1040, 1200, 2150, 3010, 3110, 3180, 3210, 3250];
    for (const t of ticks) u.set(0, t, tl, opts());
    await new Promise((r) => setTimeout(r, 0));
    u.set(0, 1040, tl, opts());
    const before = count(u.root);
    // Every batch's arrays, which are filled in place.
    const arrays = () => {
      const out: unknown[] = [];
      u.root.traverse((o) => {
        const g = (o as THREE.Mesh).geometry;
        if (g instanceof THREE.InstancedBufferGeometry)
          for (const a of Object.values(g.attributes)) out.push(a.array);
      });
      return out;
    };
    const was = arrays();
    for (let i = 0; i < 20; i++) u.set(0, ticks[i % ticks.length], tl, opts());
    for (const f of ATLAS_FILES) await s.release(f);
    // The batches upload through ranges of their own: no range object is made per frame.
    const calls = countCalls(() => {
      for (let i = 0; i < 20; i++)
        u.set(0, ticks[i % ticks.length], tl, opts());
    });
    expect(calls.range).toBe(0);
    expect(count(u.root)).toBe(before);
    const now = arrays();
    expect(now).toHaveLength(was.length);
    now.forEach((a, i) => expect(a).toBe(was[i]));
  });
});

describe("the fire from CS2's frames", () => {
  afterEach(() => vi.restoreAllMocks());

  const fireGroup = (u: Utility) =>
    visible(u.root).find(
      (c) => c instanceof THREE.Group && c.getObjectByName('fire-smoke')
    ) as THREE.Group;
  const flamesOf = (g: THREE.Group) =>
    g.getObjectByName('fire-flames') as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.ShaderMaterial
    >;
  const burstOf = (g: THREE.Group) =>
    g.getObjectByName('fire-burst') as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.ShaderMaterial
    >;
  const AT = 2000 + 0.3 * R;

  it("draws noise flames until the fire atlas arrives, then CS2's frames and a burst", async () => {
    const s = stubAtlases();
    const u = utility(s.atlases);
    const tl = timeline();
    u.set(0, AT, tl, opts());
    const fire = fireGroup(u);
    const flames = flamesOf(fire);
    const noise = flames.material;
    expect(noise.fragmentShader).toContain('fbm');
    expect(burstOf(fire).visible).toBe(false);
    const disposed = vi.spyOn(noise, 'dispose');
    await s.release('fire.webp');
    await s.release('fireburst.webp');
    expect(s.ready).toEqual(['fire', 'fireburst']);
    u.set(0, AT, tl, opts());
    expect(flamesOf(fireGroup(u))).toBe(flames);
    expect(flames.material).not.toBe(noise);
    expect(flames.material.uniforms.uMap.value).toBe(
      s.textures.get('fire.webp')
    );
    expect(flames.material.uniforms.uTime.value).toBeCloseTo(0.3, 6);
    expect(flames.material.uniforms.uExposure.value).toBe(1.6);
    expect(disposed).toHaveBeenCalledTimes(1);
    const seq = flames.geometry.getAttribute('aSeq');
    expect(seq.getY(0)).toBeGreaterThan(0);
    const burst = burstOf(fire);
    expect(burst.visible).toBe(true);
    expect(burst.material.uniforms.uMap.value).toBe(
      s.textures.get('fireburst.webp')
    );
    expect(burst.material.uniforms.uTime.value).toBeCloseTo(0.3, 6);
    // The burst is over once the last flame has caught and burst.
    u.set(0, 2000 + 2 * R, tl, opts());
    expect(burst.visible).toBe(false);
  });

  it('asks for each atlas only once an effect that draws it shows', async () => {
    const s = stubAtlases();
    const u = utility(s.atlases);
    const tl = timeline();
    const asked = async (tick: number) => {
      u.set(0, tick, tl, opts());
      await flush();
      return [...s.pending.keys()].sort();
    };
    // A grenade in flight draws from none.
    expect(await asked(1040)).toEqual([]);
    expect(await asked(1200)).toEqual(['smoke.webp']);
    expect(await asked(AT)).toEqual([
      'fire.webp',
      'fireburst.webp',
      'smoke.webp',
    ]);
    expect(await asked(3000 + 0.04 * R)).toContain('flare.webp');
    expect(await asked(3100 + 0.05 * R)).toContain('explosion.webp');
    expect(await asked(3200 + 0.02 * R)).toEqual(ATLAS_FILES.slice().sort());
  });

  it('keeps the burst hidden without the burst atlas', async () => {
    const s = stubAtlases({ atlases: { fire: FIRE_ATLASES.atlases!.fire } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = utility(s.atlases);
    const tl = timeline();
    u.set(0, AT, tl, opts());
    await s.release('fire.webp');
    u.set(0, AT, tl, opts());
    const fire = fireGroup(u);
    expect(flamesOf(fire).material.uniforms.uMap.value).toBe(
      s.textures.get('fire.webp')
    );
    expect(burstOf(fire).visible).toBe(false);
  });

  it('draws noise flames without the atlas (no effects on the server), one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = stubAtlases(null);
    const u = utility(s.atlases);
    const tl = timeline();
    for (let i = 0; i < 5; i++) {
      u.set(0, AT + i, tl, opts());
      await flush();
    }
    const fire = fireGroup(u);
    expect(flamesOf(fire).material.fragmentShader).toContain('fbm');
    expect(burstOf(fire).visible).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(s.pending.size).toBe(0);
  });

  it('keeps its objects and pools across the swap', async () => {
    const s = stubAtlases();
    const u = utility(s.atlases);
    const tl = timeline();
    const ticks = [AT, 1200, 2150, 3010];
    u.set(0, AT, tl, opts());
    const before = count(u.root);
    const children = u.root.children.length;
    for (let i = 0; i < 10; i++) u.set(0, ticks[i % 4], tl, opts());
    await s.release('fire.webp');
    await s.release('fireburst.webp');
    for (let i = 0; i < 10; i++) u.set(0, ticks[i % 4], tl, opts());
    expect(count(u.root)).toBe(before);
    expect(u.root.children.length).toBe(children);
  });
});

describe("smokes, HE grenades, flashes and decoys from CS2's frames", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A utility that has shown every effect of the fixture once and has every atlas. */
  async function loaded() {
    const s = stubAtlases();
    const u = utility(s.atlases);
    const tl = timeline();
    for (const t of [1200, 2000 + 0.3 * R, 3000 + 0.04 * R, 3200 + 0.02 * R])
      u.set(0, t, tl, opts());
    for (const f of ATLAS_FILES) await s.release(f);
    expect(s.ready.sort()).toEqual(
      [
        'explosion',
        'fire',
        'fireburst',
        'flare',
        'muzzle',
        'smoke',
        'sparks',
      ].sort()
    );
    return { s, u, tl };
  }
  const HE_AT = 3100;
  const he = (s: number) => HE_AT + s * R;

  it('draws every smoke as one batch of 16 puffs, each a fixed smoke frame turning at 0.05 rad/s, as bright as the generated puff', async () => {
    const { s, u, tl } = await loaded();
    u.set(0, 1200, tl, opts());
    const smokes = batch(u.root, 'smokes');
    expect(smokes.geometry.instanceCount).toBe(16);
    expect(smokes.material.uniforms.uMap.value).toBe(
      s.textures.get('smoke.webp')
    );
    const grid = smokes.material.uniforms.uGrid.value as THREE.Vector2;
    expect([grid.x, grid.y]).toEqual([8, 4]);
    const a = sprites(smokes);
    const frames = new Set(a.map((p) => p.frame));
    for (const p of a) {
      expect(Number.isInteger(p.frame)).toBe(true);
      expect(p.frame).toBeGreaterThanOrEqual(0);
      expect(p.frame).toBeLessThan(32);
      // CS2's frames are a mid grey where the generated puff is near white: brightened to match.
      for (const c of ['r', 'g', 'b'] as const)
        expect(p.color[c]).toBeCloseTo(
          new THREE.Color(0x8899aa)[c] * SMOKE_FRAME_GAIN,
          5
        );
    }
    expect(frames.size).toBeGreaterThan(4);
    // 100 ticks later: the same frames and places, each turned 0.05 rad/s further.
    u.set(0, 1300, tl, opts());
    const b = sprites(smokes);
    b.forEach((p, i) => {
      expect(p.frame).toBe(a[i].frame);
      expect(p.at.distanceTo(a[i].at)).toBeLessThan(1e-5);
      expect(p.rotation - a[i].rotation).toBeCloseTo(SMOKE.turn * (100 / R), 5);
    });
    u.set(0, 1600, tl, opts());
    expect(smokes.geometry.instanceCount).toBe(0);
    expect(smokes.visible).toBe(false);
  });

  it('draws the nearer of two smokes over the farther', async () => {
    const { u } = await loaded();
    const two = new Timeline(
      trackPack({
        samples: 2500,
        players: [() => ({ x: 0, y: 0 })],
        events: [
          at('smokegrenade_detonate', 1100, 5, 400, 0, 0),
          at('smokegrenade_detonate', 1100, 6, 1200, 0, 0),
        ],
      })
    );
    const centre = (x: number) =>
      toScene(x, 0, 0, new THREE.Vector3()) as THREE.Vector3;
    // Seen from beyond the smoke at Source x 1200, then from beyond the one at 400.
    for (const [eyeX, far, near] of [
      [2000, 400, 1200],
      [-400, 1200, 400],
    ]) {
      const eye = (
        toScene(eyeX, 0, 64, new THREE.Vector3()) as THREE.Vector3
      ).clone();
      u.set(0, 1200, two, opts({ eye }));
      const puffs = sprites(batch(u.root, 'smokes'));
      expect(puffs).toHaveLength(32);
      // The first 16 drawn are the farther smoke's, the last 16 the nearer's, over them.
      for (const p of puffs.slice(0, 16))
        expect(Math.abs(p.at.z - centre(far).z)).toBeLessThan(SMOKE.radius);
      for (const p of puffs.slice(16))
        expect(Math.abs(p.at.z - centre(near).z)).toBeLessThan(SMOKE.radius);
    }
  });

  it('draws five HE grenades thrown within a second, each with its fireball and its smoke', async () => {
    const { u } = await loaded();
    expect(POOLS.hes).toBeGreaterThanOrEqual(5);
    const five = new Timeline(
      trackPack({
        samples: 2500,
        players: [() => ({ x: 0, y: 0 })],
        events: [0, 1, 2, 3, 4].map((k) =>
          at('hegrenade_detonate', 3100 + 10 * k, 20 + k, 200 * k, 0, 0)
        ),
      })
    );
    // 50 ticks after the first: every fireball still burns (the first 0.78 s in).
    u.set(0, 3150, five, opts());
    expect(drawn(batch(u.root, 'he-fireball'))).toBe(5);
    // 0.9 s after the last: all five are smoke.
    u.set(0, 3140 + 0.9 * R, five, opts());
    expect(drawn(batch(u.root, 'he-fireball'))).toBe(0);
    expect(drawn(batch(u.root, 'he-smoke'))).toBe(5 * HE.smokePuffs);
  });

  it('draws the same sprites at a tick sought from later as played up to it', async () => {
    const { u, tl } = await loaded();
    const grid = lightGrid();
    const sunLight = new THREE.Color(2, 1.5, 1);
    const o = opts({ grid, sunLight });
    const names = ['smokes', 'he-fireball', 'he-smoke'];
    const snap = () =>
      names.map((name) => {
        const g = batch(u.root, name).geometry;
        const n = g.instanceCount;
        const take = (a: string) => {
          const at = g.getAttribute(a);
          return Array.from(at.array.slice(0, n * at.itemSize));
        };
        return {
          name,
          n,
          centre: take('aCentre'),
          size: take('aSize'),
          color: take('aColor'),
        };
      });
    // A smoke, an HE's fireball and its smoke.
    const moments = [1300, 3126, 3196];
    const played = new Map<number, ReturnType<typeof snap>>();
    for (let t = 1000; t <= 3300; t++) {
      u.set(0, t, tl, o);
      if (moments.includes(t)) played.set(t, snap());
    }
    for (const t of moments) {
      u.set(0, 3400, tl, o);
      u.set(0, t, tl, o);
      expect(snap(), `tick ${t}`).toEqual(played.get(t));
    }
    // Each moment draws what it is for.
    const count = (t: number, name: string) =>
      played.get(t)!.find((b) => b.name === name)!.n;
    expect(count(1300, 'smokes')).toBe(SMOKE.puffs);
    expect(count(3126, 'he-fireball')).toBe(1);
    expect(count(3196, 'he-smoke')).toBe(HE.smokePuffs);
  });

  it('fades the HE, the decoy and the flash behind a smoke by the smoke between them and the eye, not those in front of it, the same sought as played', async () => {
    const { u } = await loaded();
    // A smoke 10 m down scene +z from 1000 to 1600, an HE, a decoy and a flash 20 m down; and
    // the same without the smoke.
    const smoke = [
      at('smokegrenade_detonate', 1000, 5, 400, 0, 0),
      at('smokegrenade_expired', 1000 + 600, 5, 400, 0, 0),
    ];
    const others = [
      at('hegrenade_detonate', 1100, 12, 800, 0, 0),
      at('decoy_started', 1100, 13, 800, 0, 0),
      at('decoy_detonate', 1300, 13, 800, 0, 0),
      at('flashbang_detonate', 1150, 11, 800, 0, 0),
    ];
    const match = (events: ReturnType<typeof at>[]) =>
      new Timeline(
        trackPack({ samples: 2500, players: [() => ({ x: 0, y: 0 })], events })
      );
    const tl = match([...smoke, ...others]);
    const none = match(others);
    const names = ['he-fireball', 'he-smoke', 'decoy-flash', 'decoy-sparks'];
    const alphas = () =>
      names.map((n) => sprites(batch(u.root, n)).map((p) => p.alpha));
    const cores = () =>
      visible(u.root)
        .filter((c): c is THREE.Group => c instanceof THREE.Group)
        .flatMap((g) =>
          g.children
            .filter((c): c is THREE.Sprite => c instanceof THREE.Sprite)
            .map((c) => c.material.opacity)
        );
    // The fireball, the decoy's pop and the flash; then the HE's smoke.
    const moments = [1101, 1100 + 1.0 * R];
    const behind = new THREE.Vector3(0, 2, -10);
    const front = new THREE.Vector3(0, 2, 40);
    for (const t of moments) {
      u.set(0, t, none, opts({ eye: behind }));
      const clear = alphas();
      const clearCores = cores();
      expect(clear.flat().length).toBeGreaterThan(0);
      u.set(0, t, tl, opts({ eye: behind }));
      const hidden = alphas();
      hidden.forEach((b, i) =>
        b.forEach((a, j) =>
          expect(a, `${names[i]} ${j} at ${t}`).toBeLessThan(
            clear[i][j] * (1 - SMOKE.opacity) + 0.02
          )
        )
      );
      cores().forEach((o, i) =>
        expect(o).toBeLessThan(clearCores[i] * (1 - SMOKE.opacity) + 0.02)
      );
      // Seen from past them, they stand in front of the smoke.
      u.set(0, t, none, opts({ eye: front }));
      const near = alphas();
      u.set(0, t, tl, opts({ eye: front }));
      expect(alphas()).toEqual(near);
      // Sought from later and from earlier, as played up to it.
      const played = (() => {
        for (let k = 900; k <= t; k++) u.set(0, k, tl, opts({ eye: behind }));
        return alphas();
      })();
      expect(played).toEqual(hidden);
      u.set(0, 2400, tl, opts({ eye: behind }));
      u.set(0, t, tl, opts({ eye: behind }));
      expect(alphas()).toEqual(hidden);
    }
  });

  it("plays the HE's fireball once over explosionS, one of CS2's fireballs, then six smoke puffs rise and fade over smokeS; the ring stays", async () => {
    const { u, tl } = await loaded();
    // The HE lives as long as its smoke.
    expect(HE_S).toBeCloseTo(HE.explosionS + HE.smokeS, 9);
    const fireball = batch(u.root, 'he-fireball');
    const smoke = batch(u.root, 'he-smoke');
    u.set(0, he(0.05), tl, opts());
    expect(drawn(fireball)).toBe(1);
    const which = Math.floor(sprite(fireball, 0).frame / HE.fireballFrames);
    expect(which).toBeGreaterThanOrEqual(0);
    expect(which).toBeLessThan(40 / HE.fireballFrames);
    expect(sprite(fireball, 0).frame % HE.fireballFrames).toBe(0);
    expect(sprite(fireball, 0).w).toBeCloseTo(HE.explosionSize, 6);
    // Its ring on the ground stays, and the glow (the blast's flash); the generated fireball
    // gives way to CS2's.
    const group = visible(u.root).find((c) =>
      c.children.some((k) => k instanceof THREE.Mesh)
    )!;
    const [core, ball, ring] = group.children;
    expect(ring.visible).toBe(true);
    expect(core.visible).toBe(true);
    expect(ball.visible).toBe(false);
    const t = he(0.4);
    u.set(0, t, tl, opts());
    expect(drawn(fireball)).toBe(1);
    // The glow is only the blast's flash, over by the time the fireball has grown.
    expect((core as THREE.Sprite).material.opacity).toBe(0);
    expect(ring.visible).toBe(true);
    expect(sprite(fireball, 0).frame).toBe(
      which * HE.fireballFrames +
        onceFrame([0, HE.fireballFrames], (t - HE_AT) / R, HE.explosionS)!
    );
    expect(drawn(smoke)).toBe(0);
    u.set(0, he(0.9), tl, opts());
    expect(drawn(fireball)).toBe(0);
    expect(drawn(smoke)).toBe(HE.smokePuffs);
    const early = sprites(smoke);
    u.set(0, he(2.4), tl, opts());
    const late = sprites(smoke);
    late.forEach((p, i) => {
      // They rise, fade and keep their frame.
      expect(p.at.y).toBeGreaterThan(early[i].at.y);
      expect(p.alpha).toBeLessThan(HE.smokeOpacity);
      expect(p.frame).toBe(early[i].frame);
      expect(p.frame).toBeLessThan(32);
    });
    expect(Math.max(...early.map((p) => p.alpha))).toBeLessThanOrEqual(
      HE.smokeOpacity
    );
    u.set(0, he(3.5), tl, opts());
    expect(drawn(fireball)).toBe(0);
    expect(drawn(smoke)).toBe(0);
    expect(visible(u.root)).toHaveLength(0);
  });

  it("colours an HE's smoke 0x6b6b6b, or on a baked map lit where it hangs as a smoke is, sampled once per HE", () => {
    const u = utility();
    const tl = timeline();
    u.set(0, he(0.9), tl, opts());
    const puff = () => sprite(batch(u.root, 'he-smoke'), 0).color;
    expect(puff().getHex()).toBe(HE.smokeColor);
    const grid = lightGrid();
    const sunLight = new THREE.Color(2, 1.5, 1);
    const sampled = vi.mocked(sampleLightGrid);
    const before = sampled.mock.calls.length;
    u.set(0, he(0.9), tl, opts({ grid, sunLight }));
    // Half the smoke's rise over the blast (the fixture's HE goes off at the origin).
    const where = new THREE.Vector3(0, HE.smokeRise / 2, 0);
    const call = sampled.mock.calls
      .slice(before)
      .find(([, p]) => p.equals(where));
    expect(call).toBeDefined();
    const s = sampleLightGrid(grid, where, makeProbeSample());
    const light = (c: 'r' | 'g' | 'b') =>
      s.up[c] / 6 +
      s.down[c] / 6 +
      (2 * s.side[c]) / 3 +
      0.25 * s.sun * sunLight[c];
    const lum = 0.2126 * light('r') + 0.7152 * light('g') + 0.0722 * light('b');
    const albedo = new THREE.Color(HE.smokeColor).r;
    for (const c of ['r', 'g', 'b'] as const)
      expect(puff()[c]).toBeCloseTo(
        albedo * (lum + SMOKE_TINT * (light(c) - lum)),
        6
      );
    // Not again while the HE's smoke rises and fades.
    const mine = call![1];
    const atHe = () => sampled.mock.calls.filter(([, p]) => p === mine).length;
    const n = atHe();
    for (const t of [1.2, 2, 3]) u.set(0, he(t), tl, opts({ grid, sunLight }));
    expect(atHe()).toBe(n);
  });

  it("draws the flash as the generated glow, with CS2's flare over it once its atlas arrives, at the same size and timing", async () => {
    const s = stubAtlases();
    const u = utility(s.atlases);
    const tl = timeline();
    const t = 3000 + 0.04 * R;
    u.set(0, t, tl, opts());
    const group = visible(u.root)[0] as THREE.Group;
    const core = group.children[0] as THREE.Sprite;
    const over = group.children[1] as THREE.Sprite;
    const glow = core.material.map!;
    expect(glow).toBeInstanceOf(THREE.DataTexture);
    expect(over.visible).toBe(false);
    await s.release('flare.webp');
    expect(s.ready).toContain('flare');
    u.set(0, t, tl, opts());
    // The glow stays under it.
    expect(core.material.map).toBe(glow);
    expect(core.material.color.getHex()).toBe(0xffffff);
    expect(over.visible).toBe(true);
    const flare = over.material.map!;
    // The flare's cell of its atlas, the first of a row of eight (1024 x 128), inset half a
    // texel and without mipmaps, so nothing of the next cell is drawn.
    expect(flare.source).toBe(s.textures.get('flare.webp')!.source);
    expect(flare.repeat.x).toBeCloseTo(1 / 8 - 1 / 1024, 9);
    expect(flare.repeat.y).toBeCloseTo(1 - 1 / 128, 9);
    expect(flare.offset.x).toBeCloseTo(0.5 / 1024, 9);
    expect(flare.offset.y).toBeCloseTo(0.5 / 128, 9);
    expect(flare.generateMipmaps).toBe(false);
    expect(flare.minFilter).toBe(THREE.LinearFilter);
    expect(core.scale.x).toBeCloseTo(FLASH.size / 2, 6);
    expect(over.scale.x).toBeCloseTo(FLASH.size / 2, 6);
    expect(over.material.opacity).toBe(core.material.opacity);
    expect(over.material.blending).toBe(THREE.AdditiveBlending);
    expect(over.layers.isEnabled(EFFECTS_LAYER)).toBe(true);
    // Brighter than white, so its rays show past the glow's edge; still white.
    const { r, g, b } = over.material.color;
    expect(r).toBeGreaterThan(1);
    expect([g, b]).toEqual([r, r]);
    // Every flash shares it.
    u.set(0, t, tl, opts());
    expect(over.material.map).toBe(flare);
    // Freed with the utility, the atlas's own texture kept.
    let freed = 0;
    flare.addEventListener('dispose', () => freed++);
    u.dispose();
    expect(freed).toBe(1);
  });

  it('pops a decoy as a muzzle frame and three spark streaks', async () => {
    const { u, tl } = await loaded();
    const flash = batch(u.root, 'decoy-flash');
    const sparks = batch(u.root, 'decoy-sparks');
    u.set(0, 3200 + 0.02 * R, tl, opts());
    expect(drawn(flash)).toBe(1);
    expect(sprite(flash, 0).frame).toBeGreaterThanOrEqual(0);
    expect(sprite(flash, 0).frame).toBeLessThan(15);
    expect(drawn(sparks)).toBe(DECOY.sparks);
    for (const p of sprites(sparks)) {
      expect(p.frame).toBeGreaterThanOrEqual(0);
      expect(p.frame).toBeLessThan(9);
      // A streak: half as wide as it is long, as the cells are.
      expect(p.w / p.h).toBeCloseTo(0.5, 6);
    }
    const turns = new Set(sprites(sparks).map((p) => p.rotation.toFixed(3)));
    expect(turns.size).toBe(DECOY.sparks);
    // The generated glow gives way.
    const group = visible(u.root).find(
      (c) => c instanceof THREE.Group && c.children.length === 1
    ) as THREE.Group;
    expect(group.children[0].visible).toBe(false);
    // Between pops, nothing.
    u.set(0, 3200 + 0.3 * R, tl, opts());
    expect(drawn(flash)).toBe(0);
    expect(drawn(sparks)).toBe(0);
  });

  it("draws the fire's smoke column from CS2's smoke frames once that atlas arrives", async () => {
    const s = stubAtlases();
    const u = utility(s.atlases);
    const tl = timeline();
    u.set(0, 2000 + 2 * R, tl, opts());
    const smoke = u.root.getObjectByName('fire-smoke') as Batch;
    expect(smoke.material.uniforms.uMap.value).toBeInstanceOf(
      THREE.DataTexture
    );
    await s.release('smoke.webp');
    u.set(0, 2000 + 2 * R, tl, opts());
    expect(smoke.material.uniforms.uMap.value).toBe(
      s.textures.get('smoke.webp')
    );
    const puffs = sprites(smoke);
    expect(puffs.length).toBeGreaterThan(0);
    for (const p of puffs) {
      expect(p.frame).toBeGreaterThanOrEqual(0);
      expect(p.frame).toBeLessThan(32);
      expect(p.color.getHex()).not.toBe(0x3d3834);
      expect(p.color.r).toBeCloseTo(
        new THREE.Color(0x3d3834).r * SMOKE_FRAME_GAIN,
        5
      );
    }
    expect(new Set(puffs.map((p) => p.frame)).size).toBeGreaterThan(1);
  });

  it("draws today's generated sprites without the atlases (no effects on the server), one warning, nothing fetched again", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = stubAtlases(null);
    const u = utility(s.atlases);
    const tl = timeline();
    const ticks = [1200, 2000 + 2 * R, 3000 + 0.04 * R, he(0.05), he(0.9)];
    for (let i = 0; i < 3; i++)
      for (const t of [...ticks, 3200 + 0.02 * R]) {
        u.set(0, t, tl, opts());
        await flush();
      }
    u.set(0, 1200, tl, opts());
    const smokes = batch(u.root, 'smokes');
    expect(drawn(smokes)).toBe(16);
    expect(smokes.material.uniforms.uMap.value).toBeInstanceOf(
      THREE.DataTexture
    );
    const grid = smokes.material.uniforms.uGrid.value as THREE.Vector2;
    expect([grid.x, grid.y]).toEqual([1, 1]);
    u.set(0, 3000 + 0.04 * R, tl, opts());
    const flash = (visible(u.root)[0] as THREE.Group)
      .children[0] as THREE.Sprite;
    expect(flash.material.map).toBeInstanceOf(THREE.DataTexture);
    u.set(0, he(0.05), tl, opts());
    expect(drawn(batch(u.root, 'he-fireball'))).toBe(0);
    const heGroup = visible(u.root).find((c) =>
      c.children.some((k) => k instanceof THREE.Mesh)
    )!;
    expect(heGroup.children.every((c) => c.visible)).toBe(true);
    u.set(0, he(0.9), tl, opts());
    expect(drawn(batch(u.root, 'he-smoke'))).toBe(HE.smokePuffs);
    u.set(0, 3200 + 0.02 * R, tl, opts());
    expect(drawn(batch(u.root, 'decoy-flash'))).toBe(0);
    expect(drawn(batch(u.root, 'decoy-sparks'))).toBe(0);
    const decoy = visible(u.root).find(
      (c) => c instanceof THREE.Group && c.children.length === 1
    ) as THREE.Group;
    expect(decoy.children[0].visible).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(s.pending.size).toBe(0);
  });
});

describe('sprite textures', () => {
  it('put the top of the drawing at the top of the texture (v = 1)', async () => {
    const { flameTexture } = await import('../src/scene/noise');
    const t = flameTexture(32);
    const data = t.image.data as Uint8Array;
    const alphaRow = (row: number) => {
      let a = 0;
      for (let x = 0; x < 32; x++) a += data[(row * 32 + x) * 4 + 3];
      return a;
    };
    // A flame is full low down and thin at its tip: more alpha near v = 0 than near v = 1.
    expect(alphaRow(6)).toBeGreaterThan(alphaRow(28) * 2);
    t.dispose();
  });
});
