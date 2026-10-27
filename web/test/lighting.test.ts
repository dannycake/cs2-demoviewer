// The scene's light: a hemisphere sky light and a sun above the map's centre whose
// orthographic shadow box is fitted to the map's bounds, tall maps included.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  HEMI_INTENSITY,
  Lighting,
  SHADOW_BIAS,
  SHADOW_FAR,
  SHADOW_NEAR,
  SHADOW_NORMAL_BIAS,
  SUN_INTENSITY,
  SUN_OFFSET,
  WORLD_CASTER_LAYER,
  castAndReceive,
} from '../src/scene/lighting';
import { shadowCasters } from './helpers/shadow-casters';

const CENTRE = new THREE.Vector3(-23, 4.6, -29.8);
const box = (sx: number, sy: number, sz: number) =>
  new THREE.Box3().setFromCenterAndSize(CENTRE, new THREE.Vector3(sx, sy, sz));

/**
 * Only the part of a renderer `setShadows` and `drawWorldShadow` touch: a render runs the
 * scene's `onAfterRender`, as three's does inside the state it sets up for the frame.
 */
function stubRenderer() {
  const r = {
    shadowMap: {
      enabled: false,
      type: THREE.BasicShadowMap,
      render: vi.fn(),
    },
    render: vi.fn((scene: THREE.Scene, camera: THREE.Camera) =>
      (scene.onAfterRender as (...args: unknown[]) => void)(r, scene, camera)
    ),
  };
  return r as unknown as THREE.WebGLRenderer & {
    shadowMap: { render: ReturnType<typeof vi.fn> };
    render: ReturnType<typeof vi.fn>;
  };
}

/** The eight corners of `b`. */
function corners(b: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [b.min.x, b.max.x])
    for (const y of [b.min.y, b.max.y])
      for (const z of [b.min.z, b.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}

/** Every corner of `b` lies inside the sun's shadow box, as three.js places it. */
function expectInsideShadowBox(l: Lighting, b: THREE.Box3) {
  const cam = l.sun.shadow.camera;
  l.sun.updateMatrixWorld();
  l.sun.target.updateMatrixWorld();
  l.sun.shadow.updateMatrices(l.sun);
  for (const c of corners(b)) {
    const v = c.clone().applyMatrix4(cam.matrixWorldInverse);
    // The camera looks down -z: depth is -v.z.
    expect(-v.z).toBeGreaterThanOrEqual(cam.near);
    expect(-v.z).toBeLessThanOrEqual(cam.far);
    expect(Math.abs(v.x)).toBeLessThanOrEqual(cam.right);
    expect(Math.abs(v.y)).toBeLessThanOrEqual(cam.top);
  }
}

describe('Lighting', () => {
  it('adds a sky light and a sun with its target, in the default colours', () => {
    const scene = new THREE.Scene();
    const l = new Lighting(scene);
    expect(scene.children).toContain(l.hemi);
    expect(scene.children).toContain(l.sun);
    expect(scene.children).toContain(l.sun.target);
    expect(l.hemi.color.getHexString()).toBe('e6ecf5');
    expect(l.hemi.groundColor.getHexString()).toBe('9a8f80');
    expect(l.hemi.intensity).toBe(HEMI_INTENSITY);
    expect(HEMI_INTENSITY).toBe(2.6);
    expect(l.sun.color.getHexString()).toBe('fff2e0');
    expect(l.sun.intensity).toBe(SUN_INTENSITY);
    expect(SUN_INTENSITY).toBe(3.6);
    expect(l.sun.shadow.bias).toBe(SHADOW_BIAS);
    expect(SHADOW_BIAS).toBe(-0.0005);
    expect(l.sun.shadow.normalBias).toBe(SHADOW_NORMAL_BIAS);
    expect(SHADOW_NORMAL_BIAS).toBe(0.05);
    expect(l.sun.castShadow).toBe(false);
  });

  it('fits the shadow box to a Mirage-sized map', () => {
    const l = new Lighting(new THREE.Scene());
    l.fit(box(150, 32, 152));
    const cam = l.sun.shadow.camera;
    expect(cam.left).toBe(-91.2);
    expect(cam.right).toBe(91.2);
    expect(cam.bottom).toBe(-91.2);
    expect(cam.top).toBe(91.2);
    expect(cam.near).toBe(SHADOW_NEAR);
    expect(SHADOW_NEAR).toBe(1);
    expect(cam.far).toBe(400);
    expect(SHADOW_FAR).toBe(400);
    // The projection follows the new box.
    expect(cam.projectionMatrix.elements[0]).toBeCloseTo(1 / 91.2, 12);
    expect(l.sun.target.position.distanceTo(CENTRE)).toBeLessThan(1e-9);
    // A low map keeps the sun at its usual place above the centre.
    expect(
      l.sun.position.clone().sub(CENTRE).distanceTo(SUN_OFFSET)
    ).toBeLessThan(1e-9);
  });

  it('fits a tall map by its height and keeps the whole map in depth (Vertigo)', () => {
    const l = new Lighting(new THREE.Scene());
    const b = box(99, 411, 101);
    l.fit(b);
    const cam = l.sun.shadow.camera;
    expect(cam.left).toBe(-246.6);
    expect(cam.top).toBe(246.6);
    expect(l.sun.target.position.distanceTo(CENTRE)).toBeLessThan(1e-9);
    // The sun shines from the same direction, moved back so the tower's top is in front.
    const dir = l.sun.position.clone().sub(CENTRE);
    expect(
      dir.clone().normalize().dot(SUN_OFFSET.clone().normalize())
    ).toBeCloseTo(1, 12);
    expect(dir.length()).toBeGreaterThan(SUN_OFFSET.length());
    expectInsideShadowBox(l, b);
  });

  it('keeps a long map in depth (Nuke)', () => {
    const l = new Lighting(new THREE.Scene());
    const b = box(198.5, 73.8, 321.1);
    l.fit(b);
    expect(l.sun.shadow.camera.left).toBeCloseTo(-321.1 * 0.6, 9);
    expectInsideShadowBox(l, b);
  });

  it('grows the shadow box to hold a map seen down the sun’s slant (Mirage corners)', () => {
    // A box seen down (40, 80, 20) is wider than 0.6 of its largest side: the corners of a
    // 150×32×152 m map reach 101.5 m across, past the 91.2 m the sides alone give. The
    // geometry sits under a moved and scaled parent, in normalized int16 positions like the
    // quantized world GLBs, so the walk must use each mesh's world matrix and dequantize.
    const b = box(150, 32, 152);
    const half = new THREE.Vector3(75, 16, 76);
    const world = new THREE.Group();
    world.position.copy(CENTRE);
    const parent = new THREE.Group();
    parent.scale.setScalar(100);
    world.add(parent);
    const q = new Int16Array(8 * 3);
    corners(new THREE.Box3(half.clone().negate(), half)).forEach((c, i) =>
      q.set(
        c.toArray().map((v) => Math.round((v / 100) * 32767)),
        i * 3
      )
    );
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(q, 3, true));
    parent.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial()));

    const bounds = new THREE.Box3().setFromObject(world);
    expect(bounds.distanceToPoint(b.min)).toBeLessThan(0.01);
    expect(bounds.distanceToPoint(b.max)).toBeLessThan(0.01);
    const reach = Lighting.reachOf(world, bounds);
    expect(reach).toBeGreaterThan(101.4);
    expect(reach).toBeLessThan(101.6);

    const l = new Lighting(new THREE.Scene());
    l.fit(bounds, reach);
    expect(l.sun.shadow.camera.right).toBeCloseTo(reach + 1, 9);
    expectInsideShadowBox(l, bounds);
    // Without the reach the sides alone leave the corners out.
    l.fit(bounds);
    expect(l.sun.shadow.camera.right).toBeCloseTo(91.2, 1);
    // A small reach never shrinks the box below the sides' floor.
    l.fit(bounds, 10);
    expect(l.sun.shadow.camera.right).toBeCloseTo(91.2, 1);
  });

  it('measures no reach for an empty world', () => {
    expect(Lighting.reachOf(new THREE.Group(), new THREE.Box3())).toBe(0);
  });

  it('turns the shadow off with size 0', () => {
    const l = new Lighting(new THREE.Scene());
    const r = stubRenderer();
    l.setShadows(2048, r);
    l.setShadows(0, r);
    expect(l.sun.castShadow).toBe(false);
    expect(r.shadowMap.enabled).toBe(false);
  });

  it('casts PCF shadows of the given size, freeing the old map when it changes', () => {
    const l = new Lighting(new THREE.Scene());
    const r = stubRenderer();
    l.setShadows(2048, r);
    expect(l.sun.castShadow).toBe(true);
    expect(r.shadowMap.enabled).toBe(true);
    expect(r.shadowMap.type).toBe(THREE.PCFShadowMap);
    expect(l.sun.shadow.mapSize.toArray()).toEqual([2048, 2048]);

    // The renderer allocates the map on the next draw and never resizes it itself.
    const map = new THREE.WebGLRenderTarget(2048, 2048);
    map.depthTexture = new THREE.DepthTexture(2048, 2048);
    const freed = vi.fn();
    const depthFreed = vi.fn();
    map.addEventListener('dispose', freed);
    map.depthTexture.addEventListener('dispose', depthFreed);
    l.sun.shadow.map = map;

    l.setShadows(2048, r);
    expect(l.sun.shadow.map).toBe(map);
    expect(freed).not.toHaveBeenCalled();

    l.setShadows(4096, r);
    expect(l.sun.shadow.mapSize.toArray()).toEqual([4096, 4096]);
    expect(l.sun.shadow.map).toBeNull();
    expect(freed).toHaveBeenCalledTimes(1);
    expect(depthFreed).toHaveBeenCalledTimes(1);

    const map2 = new THREE.WebGLRenderTarget(4096, 4096);
    const freed2 = vi.fn();
    map2.addEventListener('dispose', freed2);
    l.sun.shadow.map = map2;
    l.setShadows(0, r);
    expect(l.sun.shadow.map).toBeNull();
    expect(freed2).toHaveBeenCalledTimes(1);
  });

  it('takes the colours and the sun intensity of a map', () => {
    const l = new Lighting(new THREE.Scene());
    l.setColors({
      sunColor: '#fff0d8',
      sunIntensity: 2.5,
      hemiSky: '#e4e9ef',
      hemiGround: '#74604a',
    });
    expect(l.sun.color.getHexString()).toBe('fff0d8');
    expect(l.sun.intensity).toBe(2.5);
    expect(l.hemi.color.getHexString()).toBe('e4e9ef');
    expect(l.hemi.groundColor.getHexString()).toBe('74604a');
    expect(l.hemi.intensity).toBe(HEMI_INTENSITY);
    // Without a sun (Train's bake, brightness 0), the players and the viewmodel get none.
    l.setColors(
      {
        sunColor: '#fff0d8',
        sunIntensity: 2.5,
        hemiSky: '#e4e9ef',
        hemiGround: '#74604a',
      },
      false
    );
    expect(l.sun.intensity).toBe(0);
    expect(l.hemi.intensity).toBe(HEMI_INTENSITY);
    expect(l.sun.color.getHexString()).toBe('fff0d8');
  });

  it("takes the bake's own sun, π times its brightness in its linear colour, as the bake lights the world", () => {
    const l = new Lighting(new THREE.Scene());
    l.setBakedSun({
      dir: [0.3346, 0.866, -0.3716],
      color: [1, 0.73791, 0.450786],
      intensity: 3,
      baked: true,
    });
    expect(l.sun.intensity).toBeCloseTo(3 * Math.PI, 12);
    expect(l.sun.color.r).toBe(1);
    expect(l.sun.color.g).toBeCloseTo(0.73791, 6);
    expect(l.sun.color.b).toBeCloseTo(0.450786, 6);
  });

  it("keeps the sun lit while the shadow is split: the baked world tells the players' shadow by its black light", () => {
    const l = new Lighting(new THREE.Scene());
    const r = stubRenderer();
    const dark = {
      sunColor: '#000000',
      sunIntensity: 0,
      hemiSky: '#e4e9ef',
      hemiGround: '#74604a',
    };
    l.setShadows(2048, r, true);
    l.setColors(dark);
    const lit = () =>
      l.sun.intensity > 0 &&
      Math.max(l.sun.color.r, l.sun.color.g, l.sun.color.b) > 0;
    expect(lit()).toBe(true);
    l.setColors(dark, false);
    expect(lit()).toBe(true);
    // And when the split comes after the dark sun.
    l.setShadows(0, r);
    l.setColors(dark, false);
    expect(l.sun.intensity).toBe(0);
    l.setShadows(2048, r, true);
    expect(lit()).toBe(true);
  });

  it("aims the sun along the map's own direction (light.json), and back to the default without", () => {
    const l = new Lighting(new THREE.Scene());
    const along = () =>
      l.sun.position.clone().sub(l.sun.target.position).normalize();
    // Mirage: 60° up, from the side its light_environment says.
    const dir: [number, number, number] = [0.3346, 0.866, -0.3716];
    const want = new THREE.Vector3(...dir).normalize();
    l.setSun({ dir, color: [1, 0.74, 0.45], intensity: 3, baked: true });
    expect(along().distanceTo(want)).toBeLessThan(1e-6);
    expect(l.direction.distanceTo(want)).toBeLessThan(1e-6);
    // fit keeps it, and still holds the whole map in the shadow box.
    const b = box(150, 32, 152);
    const world = new THREE.Mesh(
      new THREE.BoxGeometry(150, 32, 152).translate(
        CENTRE.x,
        CENTRE.y,
        CENTRE.z
      )
    );
    l.fit(b, Lighting.reachOf(world, b, l.direction));
    expect(along().distanceTo(want)).toBeLessThan(1e-6);
    expect(l.sun.target.position.distanceTo(CENTRE)).toBeLessThan(1e-9);
    expectInsideShadowBox(l, b);

    l.setSun(null);
    expect(along().distanceTo(SUN_OFFSET.clone().normalize())).toBeLessThan(
      1e-6
    );
    l.fit(b, Lighting.reachOf(world, b, l.direction));
    expect(along().distanceTo(SUN_OFFSET.clone().normalize())).toBeLessThan(
      1e-6
    );
    expectInsideShadowBox(l, b);
  });

  it('measures the reach across the direction it is given', () => {
    const b = box(100, 10, 10);
    const world = new THREE.Mesh(
      new THREE.BoxGeometry(100, 10, 10).translate(CENTRE.x, CENTRE.y, CENTRE.z)
    );
    // Straight down, the long side lies across the view; along it, end-on.
    expect(Lighting.reachOf(world, b, new THREE.Vector3(0, 1, 0))).toBeCloseTo(
      50,
      4
    );
    expect(Lighting.reachOf(world, b, new THREE.Vector3(1, 0, 0))).toBeCloseTo(
      5,
      4
    );
    // Without a direction, SUN_OFFSET's, as before.
    expect(Lighting.reachOf(world, b)).toBeCloseTo(
      Lighting.reachOf(world, b, SUN_OFFSET.clone().normalize()),
      9
    );
  });

  it('leaves the scene and frees the shadow maps on dispose', () => {
    const scene = new THREE.Scene();
    const l = new Lighting(scene);
    l.setShadows(2048, stubRenderer(), true);
    const map = new THREE.WebGLRenderTarget(2048, 2048);
    const freed = vi.fn();
    map.addEventListener('dispose', freed);
    l.sun.shadow.map = map;
    const players = new THREE.WebGLRenderTarget(2048, 2048);
    const playersFreed = vi.fn();
    players.addEventListener('dispose', playersFreed);
    l.playerShadow.shadow.map = players;
    l.dispose();
    expect(scene.children).not.toContain(l.hemi);
    expect(scene.children).not.toContain(l.sun);
    expect(scene.children).not.toContain(l.sun.target);
    expect(scene.children).not.toContain(l.playerShadow);
    expect(scene.children).not.toContain(l.playerShadow.target);
    expect(freed).toHaveBeenCalledTimes(1);
    expect(playersFreed).toHaveBeenCalledTimes(1);
  });
});

// Where the sun is in the bake, the world's shadows are baked and the players' are not: the
// players need the world's shadow (are they in the sun?) and the baked world needs only the
// players' (where do they darken it?). The sun's shadow map holds the world alone, drawn when
// it is stale; a light that lights nothing holds the players', drawn every frame.
describe('Lighting with the sun in the bake', () => {
  /** A world of one opaque box and one glass pane, which casts no shadow. */
  function world() {
    const g = new THREE.Group();
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshLambertMaterial()
    );
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshLambertMaterial({ transparent: true })
    );
    g.add(wall, glass);
    castAndReceive(g, false);
    return { g, wall, glass };
  }

  it("draws the sun's shadow of the world alone, once until it is stale, and a black light casts the players' every frame", () => {
    const scene = new THREE.Scene();
    const l = new Lighting(scene);
    const r = stubRenderer();
    expect(scene.children).toContain(l.playerShadow);
    expect(scene.children).toContain(l.playerShadow.target);
    // Off until the sun is in the bake: no second light in the shaders of a map without one.
    expect(l.playerShadow.visible).toBe(false);
    expect(l.playerShadow.castShadow).toBe(false);
    l.setShadows(2048, r, true);
    expect(l.sun.castShadow).toBe(true);
    expect(l.sun.shadow.autoUpdate).toBe(false);
    expect(l.playerShadow.visible).toBe(true);
    expect(l.playerShadow.castShadow).toBe(true);
    expect(l.playerShadow.shadow.autoUpdate).toBe(true);
    expect(l.playerShadow.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    // It lights nothing: the baked world's shader knows the players' shadow by that.
    expect(l.playerShadow.color.getHex()).toBe(0);
    expect(l.playerShadow.intensity).toBe(0);

    const { g, wall, glass } = world();
    // A player: it casts every frame (into the players' map), never into the world's.
    const player = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshLambertMaterial()
    );
    player.castShadow = true;
    scene.add(g, player);
    const cast: boolean[][] = [];
    const drawn: THREE.Object3D[][] = [];
    r.shadowMap.render.mockImplementation(
      (_lights: THREE.Light[], root: THREE.Object3D, camera: THREE.Camera) => {
        cast.push([wall.castShadow, glass.castShadow]);
        drawn.push(shadowCasters(root, camera));
      }
    );
    expect(l.drawWorldShadow(r, g)).toBe(true);
    expect(r.shadowMap.render).toHaveBeenCalledTimes(1);
    // Inside a render of its own (three's shadow pass needs one), of nothing else.
    expect(r.render).toHaveBeenCalledTimes(1);
    expect((r.render.mock.lastCall?.[0] as THREE.Scene).children).toEqual([]);
    expect(r.shadowMap.render.mock.lastCall?.[0]).toEqual([l.sun]);
    // Of the scene itself, through the sun's camera on the world's layer alone: the world's
    // opaque meshes, not the player beside them, and the world left where it is.
    expect(r.shadowMap.render.mock.lastCall?.[1]).toBe(scene);
    expect(r.shadowMap.render.mock.lastCall?.[2]).toBe(l.sun.shadow.camera);
    expect(drawn).toEqual([[wall]]);
    expect(wall.layers.isEnabled(WORLD_CASTER_LAYER)).toBe(true);
    expect(wall.layers.isEnabled(0)).toBe(true);
    expect(player.layers.isEnabled(WORLD_CASTER_LAYER)).toBe(false);
    expect(g.parent).toBe(scene);
    // The world's opaque meshes cast while it is drawn, and only then: the players' map,
    // drawn by the renderer every frame, must not hold them.
    expect(cast).toEqual([[true, false]]);
    expect(wall.castShadow).toBe(false);
    expect(l.sun.shadow.needsUpdate).toBe(true);
    expect(l.drawWorldShadow(r, g)).toBe(false);
    expect(r.shadowMap.render).toHaveBeenCalledTimes(1);

    // Anything that moves the sun's shadow, or remakes it, draws it again.
    const b = box(150, 32, 152);
    l.fit(b);
    l.drawWorldShadow(r, g);
    expect(r.shadowMap.render).toHaveBeenCalledTimes(2);
    l.setSun({ dir: [0, 1, 0], color: [1, 1, 1], intensity: 1, baked: true });
    l.drawWorldShadow(r, g);
    expect(r.shadowMap.render).toHaveBeenCalledTimes(3);
    l.invalidateWorldShadow();
    l.drawWorldShadow(r, g);
    expect(r.shadowMap.render).toHaveBeenCalledTimes(4);
    l.setShadows(4096, r, true);
    l.drawWorldShadow(r, null);
    expect(r.shadowMap.render).toHaveBeenCalledTimes(5);
    // No world: an empty shadow, never a stale one, even with the last world still in the scene.
    expect(drawn.at(-1)).toEqual([]);
    expect(l.playerShadow.shadow.mapSize.toArray()).toEqual([4096, 4096]);
    // A render that draws nothing (a lost context) leaves it stale.
    l.invalidateWorldShadow();
    r.render.mockImplementationOnce(() => {});
    expect(l.drawWorldShadow(r, g)).toBe(false);
    expect(r.shadowMap.render).toHaveBeenCalledTimes(5);
    l.drawWorldShadow(r, g);
    expect(r.shadowMap.render).toHaveBeenCalledTimes(6);
  });

  it('draws the doors and breakables into the same map, as they stand, casting only while it is drawn', () => {
    const scene = new THREE.Scene();
    const l = new Lighting(scene);
    const r = stubRenderer();
    l.setShadows(2048, r, true);
    const { g } = world();
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshLambertMaterial()
    );
    const doors = new THREE.Group().add(door);
    castAndReceive(doors, false);
    scene.add(g, doors);
    const drawn: { casters: THREE.Object3D[]; at: number }[] = [];
    r.shadowMap.render.mockImplementation(
      (_lights: THREE.Light[], root: THREE.Object3D, camera: THREE.Camera) =>
        drawn.push({
          casters: shadowCasters(root, camera),
          at: door.matrixWorld.elements[12],
        })
    );
    expect(l.drawWorldShadow(r, g, doors)).toBe(true);
    // A door that swings (or a window that breaks) makes the map stale: drawn again, posed.
    door.position.x = 2;
    expect(l.drawWorldShadow(r, g, doors)).toBe(false);
    l.invalidateWorldShadow();
    expect(l.drawWorldShadow(r, g, doors)).toBe(true);
    // A window that broke is hidden: not in the shadow.
    door.visible = false;
    l.invalidateWorldShadow();
    l.drawWorldShadow(r, g, doors);
    const wall = g.children[0];
    expect(drawn).toEqual([
      { casters: [wall, door], at: 0 },
      { casters: [wall, door], at: 2 },
      { casters: [wall], at: 2 },
    ]);
    // Never in the renderer's own pass, every frame (the players' map, which the baked world takes).
    expect(door.castShadow).toBe(false);
    expect(door.receiveShadow).toBe(true);
    expect(doors.parent).toBe(scene);
    expect(g.parent).toBe(scene);
  });

  it('walks the world and its doors once for the casters it lets cast, not on every redraw', () => {
    const scene = new THREE.Scene();
    const l = new Lighting(scene);
    const r = stubRenderer();
    l.setShadows(2048, r, true);
    const { g } = world();
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshLambertMaterial()
    );
    const doors = new THREE.Group().add(door);
    castAndReceive(doors, false);
    scene.add(g, doors);
    const walks = { world: 0, doors: 0 };
    const traverse = THREE.Object3D.prototype.traverse;
    vi.spyOn(g, 'traverse').mockImplementation(function (
      this: THREE.Object3D,
      f
    ) {
      walks.world++;
      traverse.call(this, f);
    });
    vi.spyOn(doors, 'traverse').mockImplementation(function (
      this: THREE.Object3D,
      f
    ) {
      walks.doors++;
      traverse.call(this, f);
    });
    // A swing: the map drawn again on each of its frames.
    for (let i = 0; i < 5; i++) {
      door.rotation.y = i / 10;
      l.invalidateWorldShadow();
      expect(l.drawWorldShadow(r, g, doors)).toBe(true);
    }
    expect(r.shadowMap.render).toHaveBeenCalledTimes(5);
    expect(walks).toEqual({ world: 1, doors: 1 });
    // Other doors (a new map's): walked once more.
    const others = new THREE.Group().add(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial())
    );
    scene.add(others);
    l.invalidateWorldShadow();
    const drawn: THREE.Object3D[][] = [];
    r.shadowMap.render.mockImplementation(
      (_lights: THREE.Light[], root: THREE.Object3D, camera: THREE.Camera) =>
        drawn.push(shadowCasters(root, camera))
    );
    l.drawWorldShadow(r, g, others);
    expect(walks).toEqual({ world: 2, doors: 1 });
    // The doors it no longer draws are off the casters' layer.
    expect(drawn).toEqual([[g.children[0], others.children[0]]]);
    expect(door.layers.isEnabled(WORLD_CASTER_LAYER)).toBe(false);
  });

  it("forgets the world and its doors once the shadow is not split: none of their meshes stays referenced or on the casters' layer", () => {
    const scene = new THREE.Scene();
    const l = new Lighting(scene);
    const r = stubRenderer();
    l.setShadows(2048, r, true);
    const { g, wall } = world();
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshLambertMaterial()
    );
    const doors = new THREE.Group().add(door);
    scene.add(g, doors);
    l.drawWorldShadow(r, g, doors);
    expect(wall.layers.isEnabled(WORLD_CASTER_LAYER)).toBe(true);
    // A map without a bake, a baked one at `low` or Cache: one map of everything, or none.
    for (const [size, split] of [
      [2048, false],
      [0, true],
    ] as const) {
      l.setShadows(2048, r, true);
      l.drawWorldShadow(r, g, doors);
      l.setShadows(size, r, split);
      expect(l.drawWorldShadow(r, null)).toBe(false);
      const held = l as unknown as {
        casters: THREE.Mesh[];
        casterRoots: (THREE.Object3D | null)[];
      };
      expect(held.casters).toEqual([]);
      expect(held.casterRoots).toEqual([null, null]);
      for (const m of [wall, door])
        expect(m.layers.isEnabled(WORLD_CASTER_LAYER)).toBe(false);
    }
  });

  it("keeps the players' light in step with the sun: its place, its target and its shadow box", () => {
    const l = new Lighting(new THREE.Scene());
    l.setSun({
      dir: [0.3346, 0.866, -0.3716],
      color: [1, 1, 1],
      intensity: 3,
      baked: true,
    });
    l.fit(box(150, 32, 152), 120);
    const a = l.sun;
    const p = l.playerShadow;
    expect(p.position.distanceTo(a.position)).toBeLessThan(1e-9);
    expect(p.target.position.distanceTo(a.target.position)).toBeLessThan(1e-9);
    const [sc, pc] = [a.shadow.camera, p.shadow.camera];
    for (const k of ['left', 'right', 'top', 'bottom', 'near', 'far'] as const)
      expect(pc[k]).toBe(sc[k]);
    expect(pc.projectionMatrix.equals(sc.projectionMatrix)).toBe(true);
    expect(p.shadow.bias).toBe(SHADOW_BIAS);
    expect(p.shadow.normalBias).toBe(SHADOW_NORMAL_BIAS);
  });

  it('draws as today anywhere else: one shadow map of everything, every frame, and the black light off', () => {
    const l = new Lighting(new THREE.Scene());
    const r = stubRenderer();
    l.setShadows(2048, r, true);
    const players = new THREE.WebGLRenderTarget(2048, 2048);
    const freed = vi.fn();
    players.addEventListener('dispose', freed);
    l.playerShadow.shadow.map = players;
    l.setShadows(2048, r);
    expect(l.sun.castShadow).toBe(true);
    expect(l.sun.shadow.autoUpdate).toBe(true);
    expect(l.playerShadow.visible).toBe(false);
    expect(l.playerShadow.castShadow).toBe(false);
    expect(freed).toHaveBeenCalledTimes(1);
    const { g } = world();
    l.drawWorldShadow(r, g);
    expect(r.shadowMap.render).not.toHaveBeenCalled();
    // And without shadows, neither light casts.
    l.setShadows(0, r, true);
    expect(l.sun.castShadow).toBe(false);
    expect(l.playerShadow.castShadow).toBe(false);
    expect(l.playerShadow.visible).toBe(false);
    l.drawWorldShadow(r, g);
    expect(r.shadowMap.render).not.toHaveBeenCalled();
  });
});

describe('castAndReceive', () => {
  it('lets every mesh receive and every non-transparent one cast', () => {
    const root = new THREE.Group();
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshLambertMaterial()
    );
    const fence = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshLambertMaterial({ alphaTest: 0.5 })
    );
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.4 })
    );
    const mixed = new THREE.Mesh(new THREE.BoxGeometry(), [
      new THREE.MeshLambertMaterial({ transparent: true }),
      new THREE.MeshLambertMaterial(),
    ]);
    const nested = new THREE.Group();
    nested.add(mixed);
    root.add(wall, fence, glass, nested);
    castAndReceive(root);
    for (const m of [wall, fence, glass, mixed])
      expect(m.receiveShadow).toBe(true);
    expect(wall.castShadow).toBe(true);
    expect(fence.castShadow).toBe(true);
    expect(glass.castShadow).toBe(false);
    expect(mixed.castShadow).toBe(true);
  });

  it('lets a baked world receive the players’ shadows without casting its own', () => {
    const root = new THREE.Group();
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshLambertMaterial()
    );
    wall.castShadow = true;
    root.add(wall);
    castAndReceive(root, false);
    expect(wall.receiveShadow).toBe(true);
    expect(wall.castShadow).toBe(false);
  });
});
