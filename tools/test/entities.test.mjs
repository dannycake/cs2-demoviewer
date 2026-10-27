import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh/src/index.js';
import { describe, expect, it } from 'vitest';
import { triangleSoup } from '../lib/ao.mjs';
import {
  MOVABLE_CLASSES, UNIT, anglesToGltfQuat, entityChecks, entityNodes, entityRootProblems, hiddenAtStart, hiddenNodes,
  movableEntities, parseEntities, skyboxMapOf, skyMaterialOf, skyOf, splitMovables, sunOf,
} from '../lib/entities.mjs';
import { countTris, createIO } from '../lib/gltf.mjs';
import { paths } from '../lib/paths.mjs';

// The shape VRF decompiles maps/<map>/entities/default_ents.vents_c to.
const VENTS = `====0====
classname                      "worldspawn"
====1====
startdisabled                  true
targetname                     "[PR#]props.2v2"
model                          resource_name:"models/props/de_nuke/hr_nuke/nuke_industrial_props/nuke_industrial_silo_door_001.vmdl"
classname                      "prop_dynamic"
origin                         [ 296.0, 86.0, -416.0 ]
angles                         [ 0.0, 90.0, 0.0 ]
====2====
startdisabled                  false
model                          resource_name:"models/props/de_nuke/hr_nuke/nuke_industrial_props/nuke_industrial_silo_door_001.vmdl"
classname                      "prop_dynamic"
origin                         [ 984.0, 80.0, -416.0 ]
====3====
startdisabled                  true
targetname                     "[PR#]retake.bsite"
model                          resource_name:"maps/de_nuke/entities/retake_bsite_2_61814_43343.vmdl"
classname                      "func_brush"
origin                         [ 881.0, -544.0, -704.0 ]
====4====
startdisabled                  true
classname                      "func_nav_blocker"
origin                         [ 0.0, 0.0, 0.0 ]
`;

// Nuke's door at the bottom of the ramp to B, as the raw .vents has it (some keys left out).
const NUKE_DOOR = `====454====
steamaudio_geometry_mode       "2"
targetname                     "[PR#]door_02"
local.origin                   [ 0.0, 0.0, 0.0 ]
local.angles                   [ 0.0, 0.0, 0.0 ]
model                          resource_name:"models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001_br.vmdl"
rendercolor                    [ 223, 149, 32 ]
slavename                      "[PR#]door_01"
distance                       89.0
spawnflags                     8192
classname                      "prop_door_rotating"
compile_source_id              10023
origin                         [ 1047.0, -920.0, -768.0 ]
angles                         [ 0.0, 180.000046, 0.0 ]
scales                         [ 1.0, 1.0, 1.0 ]
hammeruniqueid                 "2:61814:19238"
`;

describe('parseEntities', () => {
  it('reads each block into its class, model, origin, name and start state', () => {
    const e = parseEntities(VENTS);
    expect(e).toHaveLength(5);
    expect(e[1]).toMatchObject({
      classname: 'prop_dynamic',
      model: 'models/props/de_nuke/hr_nuke/nuke_industrial_props/nuke_industrial_silo_door_001.vmdl',
      origin: [296, 86, -416],
      angles: [0, 90, 0],
      targetname: '[PR#]props.2v2',
      parentname: '',
      startDisabled: true,
      hammerId: null,
      animation: '',
    });
    expect(e[2].startDisabled).toBe(false);
    expect(e[2].angles).toEqual([0, 0, 0]); // no angles key: Source's default
    expect(e[0]).toMatchObject({ classname: 'worldspawn', model: null, origin: null });
  });

  it('keeps the angles and the hammer id of a Nuke door', () => {
    const [door] = parseEntities(NUKE_DOOR);
    expect(door).toMatchObject({
      classname: 'prop_door_rotating',
      model: 'models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001_br.vmdl',
      origin: [1047, -920, -768],
      angles: [0, 180.000046, 0],
      hammerId: '2:61814:19238',
      startDisabled: false,
    });
  });

  it('keeps the name of the entity a prop is parented to', () => {
    expect(parseEntities(POTTY)[1].parentname).toBe('[PR#]door8');
  });

  it('keeps the animation a prop plays at spawn: its starting one, else its idle one', () => {
    const anims = (keys) => parseEntities(`====0====\nclassname                      "prop_dynamic"\n${keys}`)[0].animation;
    expect(anims('idleanim                       "spin"\nstartinganim                   ""')).toBe('spin');
    expect(anims('idleanim                       ""\nstartinganim                   "open"')).toBe('open');
    expect(anims('idleanim                       "spin_anim"\nstartinganim                   "spin_up"')).toBe('spin_up');
    expect(anims('')).toBe(''); // a door: its model's default sequence
  });

  it('keeps every key of the block, parsed, in kv', () => {
    const e = parseEntities(VENTS);
    expect(e[1].kv).toEqual({
      startdisabled: true,
      targetname: '[PR#]props.2v2',
      model: 'models/props/de_nuke/hr_nuke/nuke_industrial_props/nuke_industrial_silo_door_001.vmdl',
      classname: 'prop_dynamic',
      origin: [296, 86, -416],
      angles: [0, 90, 0],
    });
  });
});

// Inferno's two skies (the second only lights the bake), and a 3D skybox prefab's entities
// in the older text form: quoted strings, vectors as "x y z".
const SKIES = `====0====
targetname                     "[PR#]13276_LIGHT_sky"
startdisabled                  true
skyname                        resource_name:"materials/skybox/skymodel_hosekwilkie_ref/skymodel_hosekwilkie_albedo_0_30_turbidity_02_0_elevation_65_0.vmat"
classname                      "env_sky"
angles                         [ 0.0, 39.999985, 0.0 ]
====1====
targetname                     "[PR#]13276_MAT_sky"
startdisabled                  false
skyname                        resource_name:"materials/skybox/test/s2_de_inferno_sky01.vmat"
classname                      "env_sky"
angles                         [ 0.0, 244.999985, 0.0 ]
====2====
targetmapname                  "maps/prefabs/de_inferno/inferno_skybox.vmap"
worldgroupid                   "skyboxWorldGroup0"
classname                      "skybox_reference"
`;
const PREFAB = `====0====
classname                      "sky_camera"
scale                          "16"
====1====
skyname                        "materials/skybox/sky_hr_aztec_02_v1.vmat"
startdisabled                  "0"
classname                      "env_sky"
angles                         "0.000000 70.000000 0.000000"
`;

describe('skyMaterialOf, skyOf', () => {
  it("names the material of the first env_sky that does not start disabled", () => {
    expect(skyMaterialOf(parseEntities(SKIES))).toBe('materials/skybox/test/s2_de_inferno_sky01.vmat');
    expect(skyOf(parseEntities(SKIES))).toEqual({ material: 'materials/skybox/test/s2_de_inferno_sky01.vmat', yaw: 244.999985 });
  });

  it('reads the prefab text form, and answers null without an enabled env_sky', () => {
    expect(skyOf(parseEntities(PREFAB))).toEqual({ material: 'materials/skybox/sky_hr_aztec_02_v1.vmat', yaw: 70 });
    expect(skyMaterialOf(parseEntities(VENTS))).toBeNull();
    expect(skyMaterialOf(parseEntities(SKIES).slice(0, 1))).toBeNull();
    // An env_sky without angles faces yaw 0.
    expect(skyOf(parseEntities('====0====\nclassname "env_sky"\nskyname "materials/skybox/a.vmat"\n'))).toEqual({ material: 'materials/skybox/a.vmat', yaw: 0 });
  });
});

describe('skyboxMapOf', () => {
  it("names the 3D skybox prefab map a skybox_reference loads, or null", () => {
    expect(skyboxMapOf(parseEntities(SKIES))).toBe('maps/prefabs/de_inferno/inferno_skybox.vmap');
    expect(skyboxMapOf(parseEntities(VENTS))).toBeNull();
  });
});

describe('hiddenAtStart', () => {
  it('lists the entities with a model that a match starts with switched off', () => {
    const h = hiddenAtStart(parseEntities(VENTS));
    expect(h.map((e) => e.targetname)).toEqual(['[PR#]props.2v2', '[PR#]retake.bsite']);
  });
});

describe('hiddenNodes', () => {
  it('finds the world nodes of those entities by model name and position, not every copy of the model', () => {
    const doc = new Document();
    const scene = doc.createScene();
    const mesh = doc.createMesh('m');
    const node = (name, x, y, z) => {
      const n = doc.createNode(name).setMesh(mesh).setTranslation([x, y, z]);
      scene.addChild(n);
      return n;
    };
    const u = 0.0254;
    // glTF = (y, z, x) · 0.0254, as VRF writes the world.
    const off = node('nuke_industrial_silo_door_001.nuke_industrial_silo_door_001_bg_body_lod0', 86 * u, -416 * u, 296 * u);
    const on = node('nuke_industrial_silo_door_001.nuke_industrial_silo_door_001_bg_body_lod0', 80 * u, -416 * u, 984 * u);
    const brush = node('retake_bsite_2_61814_43343.hammer_mesh_0', -544 * u, -704 * u, 881 * u);
    node('something_else.lod0', 0, 0, 0);
    const found = hiddenNodes(doc, hiddenAtStart(parseEntities(VENTS)));
    expect(found).toContain(off);
    expect(found).toContain(brush);
    expect(found).not.toContain(on);
    expect(found).toHaveLength(2);
  });
});

// Mirage's light_environment as VRF decompiles it (the AO proxy keys left out), and Cache's
// sun, which the bake leaves to the engine (directlight "3": dynamic).
const MIRAGE_SUN = `====330====
bakedshadowindex               "0"
light_map_uniqueid             "606956707"
brightness_legacy              "-nan(ind)"
brightness_lumens              "0"
clientsideentity               "1"
brightnessscale                1.0
enabled                        true
color                          [ 255, 223, 179 ]
brightness                     3.0
castshadows                    1
directlight                    "1"
angulardiameter                1.0
skycolor                       [ 130, 205, 255 ]
skyintensity                   1.0
classname                      "light_environment"
origin                         [ 392.0, -2584.0, -48.0 ]
angles                         [ 60.0, 318.0, 0.0 ]
`;
const CACHE_SUN = `====0====
bakedshadowindex               "0"
enabled                        true
color                          [ 255, 244, 224 ]
brightness                     1.9
directlight                    "3"
classname                      "light_environment"
angles                         [ 44.999966, 115.999886, 0.0 ]
`;

describe('sunOf', () => {
  const linear = (c) => ((c / 255 + 0.055) / 1.055) ** 2.4;

  it("keeps the light_environment's keys in kv", () => {
    const env = parseEntities(MIRAGE_SUN).find((e) => e.classname === 'light_environment');
    expect(env.kv.bakedshadowindex).toBe('0');
    expect(env.kv.directlight).toBe('1');
  });

  it('gives the direction towards the sun in glTF axes, the linear colour and the brightness', () => {
    const sun = sunOf(parseEntities(VENTS + MIRAGE_SUN.replace('====330====', '====5====')));
    expect(sun.dir).toHaveLength(3);
    [0.3346, 0.866, -0.3716].forEach((v, i) => expect(Math.abs(sun.dir[i] - v)).toBeLessThan(1e-3));
    expect(Math.hypot(...sun.dir)).toBeCloseTo(1, 9);
    // sRGB [255, 223, 179] to linear: [1, 0.737, 0.451].
    [1, 0.737, 0.451].forEach((v, i) => expect(Math.abs(sun.color[i] - v)).toBeLessThan(1e-3));
    expect(sun.color[1]).toBeCloseTo(linear(223), 9);
    expect(sun.intensity).toBe(3);
    expect(sun.baked).toBe(true);
    expect(sun.shadowChannel).toBe(0);
  });

  it("says when the bake left the sun out (directlight other than \"1\")", () => {
    const sun = sunOf(parseEntities(CACHE_SUN));
    expect(sun.baked).toBe(false);
    expect(sun.intensity).toBe(1.9);
    expect(sun.color[0]).toBe(1);
  });

  it('skips a disabled light_environment, and is null without one', () => {
    expect(sunOf(parseEntities(VENTS))).toBeNull();
    const off = CACHE_SUN.replace('enabled                        true', 'enabled                        false');
    expect(sunOf(parseEntities(off))).toBeNull();
    expect(sunOf(parseEntities(off + MIRAGE_SUN)).intensity).toBe(3);
    expect(sunOf(parseEntities(CACHE_SUN.replace('enabled ', 'startdisabled true\nenabled ')))).toBeNull();
  });

  it('multiplies brightness by brightnessscale', () => {
    expect(sunOf(parseEntities(CACHE_SUN.replace('brightness ', 'brightnessscale 2.0\nbrightness '))).intensity).toBeCloseTo(3.8, 9);
  });

  it('reads no shadow channel from a missing or negative bakedshadowindex', () => {
    expect(sunOf(parseEntities(CACHE_SUN.replace('bakedshadowindex               "0"', 'bakedshadowindex "-1"'))).shadowChannel).toBeNull();
    expect(sunOf(parseEntities(CACHE_SUN.replace('bakedshadowindex               "0"\n', ''))).shadowChannel).toBeNull();
  });
});

describe('UNIT', () => {
  it('is the inch in metres, the one Source-to-glTF scale', () => {
    expect(UNIT).toBe(0.0254);
  });
});

// A door, a window, a door a match starts with switched off, and a prop that is not movable.
const MOVABLES = `====0====
classname                      "prop_door_rotating"
model                          resource_name:"models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001_br.vmdl"
origin                         [ 1047.0, -920.0, -768.0 ]
angles                         [ 0.0, 180.000046, 0.0 ]
hammeruniqueid                 "2:61814:19238"
====1====
classname                      "func_breakable"
model                          resource_name:"maps/de_nuke/entities/unnamed_2_61814_21692.vmdl"
origin                         [ 1414.5, -391.0, -341.0 ]
angles                         [ 0.0, 0.0, 0.0 ]
hammeruniqueid                 "2:61814:21692"
====2====
startdisabled                  true
classname                      "prop_door_rotating"
model                          resource_name:"models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001_br.vmdl"
origin                         [ 0.0, 0.0, 0.0 ]
hammeruniqueid                 "2:61814:1"
====3====
classname                      "prop_dynamic"
model                          resource_name:"models/props/de_nuke/hr_nuke/nuke_industrial_props/nuke_industrial_silo_door_001.vmdl"
origin                         [ 984.0, 80.0, -416.0 ]
hammeruniqueid                 "2:61814:2"
`;

describe('movableEntities', () => {
  it('lists the doors and breakables with a model and an origin that start switched on', () => {
    expect(MOVABLE_CLASSES).toEqual(['prop_door_rotating', 'func_door_rotating', 'func_door', 'func_breakable']);
    expect(movableEntities(parseEntities(MOVABLES)).map((e) => e.hammerId)).toEqual(['2:61814:19238', '2:61814:21692']);
  });
});

/** The 3×3 rotation of a glTF quaternion as its three columns. */
const columns = (q) => {
  const m = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...q)).elements;
  return [0, 1, 2].map((j) => [m[4 * j], m[4 * j + 1], m[4 * j + 2]]);
};
const expectClose = (actual, expected, tol) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((a, i) => (Array.isArray(a) ? expectClose(a, expected[i], tol) : expect(Math.abs(a - expected[i])).toBeLessThan(tol)));
};

describe('anglesToGltfQuat', () => {
  it('is S·R·Sᵀ: the spike\'s traffic cone on Inferno', () => {
    const q = anglesToGltfQuat([8.039667, 237.830719, 10.532831]);
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    expectClose(columns(q), [
      [-0.54509, 0.181, 0.8186],
      [-0.01907, 0.97349, -0.22794],
      [-0.83816, -0.13986, -0.52719],
    ], 1e-4);
  });

  it('turns a yaw of 180° into diag(−1, 1, −1)', () => {
    expectClose(columns(anglesToGltfQuat([0, 180, 0])), [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], 1e-12);
  });
});

const U = 0.0254;
/** glTF position of a Source origin, as VRF writes the world. */
const gltf = ([x, y, z]) => [y * U, z * U, x * U];

/**
 * A world as VRF exports it: Nuke's door (yaw 180) and a second copy of its model, both
 * sharing one mesh; the window; the same door model at an unrelated place; and a crate.
 */
function nukeWorld() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const mesh = (name, n) => {
    const pos = new Float32Array(n * 9);
    for (let i = 0; i < pos.length; i++) pos[i] = ((i * 7919) % 101) / 100;
    return doc.createMesh(name).addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer)));
  };
  const node = (name, m, at, rotation = [0, 0, 0, 1], scale = [1, 1, 1]) => {
    const n = doc.createNode(name).setMesh(m).setTranslation(at).setRotation(rotation).setScale(scale);
    scene.addChild(n);
    return n;
  };
  const door = mesh('metal_door_001_br.metal_door_001_br_bg_body_lod0', 5);
  const nodes = {
    door: node('metal_door_001_br.metal_door_001_br_bg_body_lod0', door, gltf([1047, -920, -768]), [0, 1, 0, 0]),
    doorFar: node('metal_door_001_br.metal_door_001_br_bg_body_lod0', door, gltf([1047, -1040, -768]), [0, 0, 0, 1], [1.0125, 1.0125, 1.0125]),
    glass: node('unnamed_2_61814_21692.hammer_mesh_0', mesh('unnamed_2_61814_21692.hammer_mesh_0', 2), gltf([1414.5, -391, -341])),
    crate: node('crate.lod0', mesh('crate.lod0', 12), [1, 2, 3]),
  };
  return { doc, nodes };
}

const TWO_DOORS = `${MOVABLES}====4====
classname                      "prop_door_rotating"
model                          resource_name:"models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001_br.vmdl"
origin                         [ 1047.0, -1040.0, -768.0 ]
angles                         [ 0.0, 0.0, 0.0 ]
hammeruniqueid                 "2:61814:19237"
====5====
classname                      "func_door_rotating"
model                          resource_name:"maps/de_vertigo/entities/door8_2_31017_6416.vmdl"
origin                         [ -1861.0, -782.0, 11540.299805 ]
hammeruniqueid                 "2:31017:6416"
`;

describe('entityNodes', () => {
  it('finds one entity\'s nodes by model name and position, not the other copies of the model', () => {
    const { doc, nodes } = nukeWorld();
    const [door, glass, other] = movableEntities(parseEntities(TWO_DOORS));
    expect(entityNodes(doc, door)).toEqual([nodes.door]);
    expect(entityNodes(doc, other)).toEqual([nodes.doorFar]);
    expect(entityNodes(doc, glass)).toEqual([nodes.glass]);
  });
});

describe('splitMovables', () => {
  const split = () => {
    const world = nukeWorld();
    const movables = movableEntities(parseEntities(TWO_DOORS));
    const before = new Map(Object.entries(world.nodes).map(([k, n]) => [k, n.getWorldMatrix()]));
    const tris = countTris(world.doc);
    return { ...world, movables, before, tris, out: splitMovables(world.doc, movables) };
  };

  it('takes every movable\'s nodes out of the world and leaves the rest', () => {
    const { doc, nodes, movables, tris, out } = split();
    for (const e of movables) expect(entityNodes(doc, e)).toEqual([]);
    expect(doc.getRoot().listNodes()).toEqual([nodes.crate]);
    expect(out.nodes).toBe(3);
    expect(countTris(doc) + countTris(out.doc)).toBe(tris);
  });

  it('gives each entity one root at its spawn transform, named by hammer id, with its extras', () => {
    const { movables, out } = split();
    const roots = out.doc.getRoot().getDefaultScene().listChildren();
    expect(roots.map((r) => r.getName())).toEqual(['2:61814:19238', '2:61814:21692', '2:61814:19237', '2:31017:6416']);
    roots.forEach((root, i) => {
      const e = movables[i];
      expectClose(root.getTranslation(), gltf(e.origin), 1e-9);
      expect(root.getRotation()).toEqual(anglesToGltfQuat(e.angles));
      expect(root.getScale()).toEqual([1, 1, 1]);
      expect(root.getMesh()).toBeNull();
      expect(root.getExtras()).toEqual({ classname: e.classname, origin: e.origin, angles: e.angles, model: e.model });
    });
    expect(roots[3].listChildren()).toEqual([]); // Vertigo's door: no node here, the root stays
    expect(entityRootProblems(out.doc, movables)).toEqual([]);
  });

  it('re-parents each node under its root without moving it, the doors still sharing one mesh', () => {
    const { before, out } = split();
    const [door, glass, doorFar] = out.doc.getRoot().getDefaultScene().listChildren();
    for (const [root, key] of [[door, 'door'], [glass, 'glass'], [doorFar, 'doorFar']]) {
      expect(root.listChildren()).toHaveLength(1);
      expectClose(root.listChildren()[0].getWorldMatrix(), before.get(key), 1e-6);
    }
    expectClose(door.listChildren()[0].getRotation(), [0, 0, 0, 1], 1e-6); // the yaw is on the root
    expectClose(doorFar.listChildren()[0].getScale(), [1.0125, 1.0125, 1.0125], 1e-6);
    expect(door.listChildren()[0].getMesh()).toBe(doorFar.listChildren()[0].getMesh());
    expect(out.doc.getRoot().listMeshes()).toHaveLength(2);
  });
});

// Vertigo's porta-potty: the func_door_rotating owns only a 4-triangle latch; the door you see is
// a prop_dynamic parented to it (`[PR#]door8`), here with a sign parented to that door in turn
// (its parentname without the `[PR#]` prefix), and the other porta-potty's door parented elsewhere.
const POTTY = `====0====
classname                      "func_door_rotating"
targetname                     "[PR#]door8"
model                          resource_name:"maps/de_vertigo/entities/door8_2_31017_6416.vmdl"
origin                         [ -1861.0, -782.0, 11540.299805 ]
hammeruniqueid                 "2:31017:6416"
====1====
classname                      "prop_dynamic"
targetname                     "[PR#]door8_panel"
parentname                     "[PR#]door8"
model                          resource_name:"models/props/de_vertigo/portapotty01_door.vmdl"
origin                         [ -1841.0, -748.320007, 11488.299805 ]
angles                         [ 0.0, 270.0, 0.0 ]
hammeruniqueid                 "2:31017:6418"
====2====
classname                      "prop_dynamic"
parentname                     "door8_panel"
model                          resource_name:"models/props/de_vertigo/potty_sign.vmdl"
origin                         [ -1841.0, -750.0, 11500.0 ]
hammeruniqueid                 "2:31017:6419"
====3====
classname                      "prop_dynamic"
parentname                     "[PR#]elsewhere"
model                          resource_name:"models/props/de_vertigo/portapotty01_door.vmdl"
origin                         [ -1914.0, -753.320007, 11488.299805 ]
hammeruniqueid                 "2:31017:6428"
`;

function pottyWorld() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const node = (name, at, rotation = [0, 0, 0, 1]) => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const mesh = doc.createMesh(name).addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer)));
    const n = doc.createNode(name).setMesh(mesh).setTranslation(at).setRotation(rotation);
    scene.addChild(n);
    return n;
  };
  const yaw270 = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];
  return {
    doc,
    latch: node('door8_2_31017_6416.hammer_mesh_0', gltf([-1861, -782, 11540.299805])),
    panel: node('portapotty01_door.portapotty01_door_bg_body_lod0', gltf([-1841, -748.320007, 11488.299805]), yaw270),
    sign: node('potty_sign.lod0', gltf([-1841, -750, 11500])),
    other: node('portapotty01_door.portapotty01_door_bg_body_lod0', gltf([-1914, -753.320007, 11488.299805]), yaw270),
  };
}

describe('splitMovables with parented entities', () => {
  it('takes the props parented to a door, at any depth, with the door', () => {
    const w = pottyWorld();
    const entities = parseEntities(POTTY);
    const movables = movableEntities(entities);
    const before = new Map([w.latch, w.panel, w.sign].map((n) => [n, n.getWorldMatrix()]));
    const out = splitMovables(w.doc, movables, entities);
    expect(out.nodes).toBe(3);
    expect(w.doc.getRoot().listNodes()).toEqual([w.other]);
    const [root] = out.doc.getRoot().getDefaultScene().listChildren();
    expect(root.getName()).toBe('2:31017:6416');
    expect(root.listChildren().map((c) => c.getName())).toEqual([w.latch, w.panel, w.sign].map((n) => n.getName()));
    root.listChildren().forEach((c, i) => expectClose(c.getWorldMatrix(), [...before.values()][i], 1e-6));
    expect(entityRootProblems(out.doc, movables)).toEqual([]);
  });

  it('follows a chain of parents that names an ancestor again only once', () => {
    // A helper parented to the sign takes the panel's name: the chain loops back to the panel.
    const loop = `${POTTY}====4====
classname                      "info_target"
targetname                     "[PR#]door8_panel"
parentname                     "sign8"
====5====
classname                      "info_target"
targetname                     "door8"
parentname                     "door8_panel"
`.replace('parentname                     "door8_panel"\nmodel', 'targetname                     "sign8"\nparentname                     "door8_panel"\nmodel');
    const entities = parseEntities(loop);
    expect(entities.find((e) => e.model?.endsWith('potty_sign.vmdl')).targetname).toBe('sign8');
    const w = pottyWorld();
    const out = splitMovables(w.doc, movableEntities(entities), entities);
    expect(out.nodes).toBe(3);
    expect(w.doc.getRoot().listNodes()).toEqual([w.other]);
  });

  it('refuses a node two entities claim', () => {
    const twice = `${POTTY}====4====
classname                      "func_door_rotating"
targetname                     "[PR#]door8b"
model                          resource_name:"maps/de_vertigo/entities/door8_2_31017_6416.vmdl"
origin                         [ -1861.0, -782.0, 11540.299805 ]
hammeruniqueid                 "2:31017:9999"
`;
    const entities = parseEntities(twice);
    expect(() => splitMovables(pottyWorld().doc, movableEntities(entities), entities)).toThrow(/door8_2_31017_6416\.hammer_mesh_0.*2:31017:6416.*2:31017:9999/);
    const child = `${POTTY}====4====
classname                      "func_door_rotating"
targetname                     "[PR#]door9"
model                          resource_name:"maps/de_vertigo/entities/door9_2_31017_6426.vmdl"
origin                         [ -1934.0, -787.0, 11540.299805 ]
hammeruniqueid                 "2:31017:6426"
====5====
classname                      "prop_dynamic"
parentname                     "[PR#]door9"
model                          resource_name:"models/props/de_vertigo/portapotty01_door.vmdl"
origin                         [ -1841.0, -748.320007, 11488.299805 ]
hammeruniqueid                 "2:31017:7777"
`;
    const all = parseEntities(child);
    expect(() => splitMovables(pottyWorld().doc, movableEntities(all), all)).toThrow(/portapotty01_door.*2:31017:6416.*2:31017:6426/);
  });
});

describe('entityChecks', () => {
  const movables = movableEntities(parseEntities(TWO_DOORS));
  const built = () => splitMovables(nukeWorld().doc, movables).doc;
  const status = (rows) => rows.map(([check, , , ok]) => [check, ok]);

  it('without the raw entity lump it checks nothing', () => {
    expect(status(entityChecks({ movables: null, doc: null, bytes: null, budget: 500e3 }))).toEqual([['entities.glb', null]]);
  });

  it('on a map without doors or breakables entities.glb must be absent', () => {
    expect(status(entityChecks({ movables: [], doc: null, bytes: null, budget: 500e3 }))).toEqual([['entities.glb', true]]);
    expect(status(entityChecks({ movables: [], doc: built(), bytes: 1000, budget: 500e3 }))).toEqual([['entities.glb', false]]);
  });

  it('on a map with them: present, within the budget, one root each, COLOR_0 on every primitive (and at least one)', () => {
    expect(status(entityChecks({ movables, doc: null, bytes: null, budget: 500e3 }))).toEqual([['entities.glb', false]]);
    const doc = built();
    expect(status(entityChecks({ movables, doc, bytes: 1000, budget: 500e3 }))).toEqual([
      ['entities.glb size', true], ['entities.glb roots', true], ['entities.glb COLOR_0', false],
    ]);
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(new Uint8Array(4)));
    expect(status(entityChecks({ movables, doc, bytes: 600e3, budget: 500e3 }))).toEqual([
      ['entities.glb size', false], ['entities.glb roots', true], ['entities.glb COLOR_0', true],
    ]);
    const empty = new Document();
    empty.getRoot().setDefaultScene(empty.createScene());
    const rows = entityChecks({ movables, doc: empty, bytes: 1000, budget: 500e3 });
    expect(status(rows)).toEqual([['entities.glb size', true], ['entities.glb roots', false], ['entities.glb COLOR_0', false]]);
    expect(rows[2][1]).toBe('0/0 primitives');
  });
});

describe('entityRootProblems', () => {
  it('names each entity whose root is missing, misnamed, moved or carries other extras', () => {
    const { doc } = nukeWorld();
    const movables = movableEntities(parseEntities(TWO_DOORS));
    const out = splitMovables(doc, movables);
    const [door, glass, doorFar] = out.doc.getRoot().getDefaultScene().listChildren();
    door.setTranslation([0, 0, 0]);
    glass.setExtras({ ...glass.getExtras(), origin: [0, 0, 0] });
    doorFar.dispose();
    const problems = entityRootProblems(out.doc, movables);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/2:61814:19238.*translation/);
    expect(problems[1]).toMatch(/2:61814:21692.*extras/);
    expect(problems[2]).toMatch(/2:61814:19237.*no root/);
  });

  it('names each root no entity has', () => {
    const { doc } = nukeWorld();
    const movables = movableEntities(parseEntities(TWO_DOORS));
    const out = splitMovables(doc, movables);
    expect(entityRootProblems(out.doc, movables.slice(0, 2))).toEqual([
      'root 2:61814:19237 matches no door or breakable',
      'root 2:31017:6416 matches no door or breakable',
    ]);
  });
});

// The real maps, once tools/shrink-map.mjs has built their entities.glb (reads the build, never runs it).
const builtMap = (map) => {
  const P = paths(map);
  const vents = path.join(P.raw, 'entities', 'default_ents.vents');
  return fs.existsSync(vents) && fs.existsSync(P.entities) ? { ...P, entities: parseEntities(fs.readFileSync(vents, 'utf8')), file: P.entities } : null;
};
const NUKE = builtMap('de_nuke');
const VERTIGO = builtMap('de_vertigo');
const OVERPASS = builtMap('de_overpass');

/** The size, in metres along glTF x, y (up) and z, of the box around a root's triangles at spawn. */
const rootSize = (doc, root) => {
  const pos = triangleSoup(doc, { under: root });
  return new THREE.Box3().setFromArray(pos).getSize(new THREE.Vector3()).toArray();
};

describe.skipIf(!NUKE)('the built Nuke', () => {
  it('has one root per door and window, named by hammer id: the four doors share one mesh under AO, and each has its own under the bake\'s probe light', async () => {
    const doc = await (await createIO()).read(NUKE.file);
    expect(entityRootProblems(doc, movableEntities(NUKE.entities))).toEqual([]);
    const roots = doc.getRoot().getDefaultScene().listChildren();
    expect(roots.map((r) => r.getName()).sort()).toEqual(['2:61814:19235', '2:61814:19236', '2:61814:19237', '2:61814:19238', '2:61814:20555', '2:61814:21692']);
    const doors = roots.filter((r) => r.getExtras().classname === 'prop_door_rotating');
    expect(doors).toHaveLength(4);
    const shrink = JSON.parse(fs.readFileSync(path.join(NUKE.out, 'shrink.json'), 'utf8'));
    // The light is per place with the bake (lib/light.mjs applyVertexLight copies a shared mesh).
    const baked = shrink.bake !== null && shrink.bake !== undefined;
    expect(shrink.entities.light).toBe(baked ? 'probes' : 'ao');
    expect(new Set(doors.flatMap((r) => r.listChildren().map((c) => c.getMesh()))).size).toBe(baked ? 4 : 1);
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
      expect(p.getAttribute('COLOR_0')).toBeTruthy();
      expect(p.getAttribute('TEXCOORD_1')).toBeNull(); // they move: no lightmap UV
    }
    expect(shrink.entities).toMatchObject({ count: 6, nodes: 6, trisIn: 4 * 572 + 2 * 2 });
    expect(shrink.bytes.entities).toBe(fs.statSync(NUKE.file).size);
  });

  it('left no surface of theirs in world.glb', async () => expectGoneFromWorld(NUKE));

  it('stands each door in its doorway, 1.52 m wide along Source y as its hull is (lib/poses.mjs)', async () => {
    const doc = await (await createIO()).read(NUKE.file);
    const doors = doc.getRoot().getDefaultScene().listChildren().filter((r) => r.getExtras().classname === 'prop_door_rotating');
    for (const door of doors) {
      const [x, y, z] = rootSize(doc, door);
      expect(y, door.getName()).toBeGreaterThan(2.7);
      expect(x, door.getName()).toBeGreaterThan(1.45); // glTF x is Source y; every door here has yaw 0 or 180
      expect(z, door.getName()).toBeLessThan(0.35);
    }
  });
});

describe.skipIf(!OVERPASS)('the built Overpass', () => {
  it('stands its door up: 2.8 m tall, not lying on the floor (lib/poses.mjs)', async () => {
    const doc = await (await createIO()).read(OVERPASS.file);
    expect(entityRootProblems(doc, movableEntities(OVERPASS.entities))).toEqual([]);
    const [door] = doc.getRoot().getDefaultScene().listChildren();
    const [x, y, z] = rootSize(doc, door);
    expect(y).toBeGreaterThan(2.7);
    expect(Math.min(x, z)).toBeLessThan(0.25);
    expect(Math.max(x, z)).toBeGreaterThan(1.3);
    const shrink = JSON.parse(fs.readFileSync(path.join(OVERPASS.out, 'shrink.json'), 'utf8'));
    expect(shrink.posed).toEqual({ construction_safetyribbon_01: 1, hvac_fanblade_spinning_01: 2, metal_door_112: 1 });
  });
});

describe.skipIf(!VERTIGO)('the built Vertigo', () => {
  it('takes each porta-potty door (a prop parented to its func_door_rotating) with its latch', async () => {
    const doc = await (await createIO()).read(VERTIGO.file);
    expect(entityRootProblems(doc, movableEntities(VERTIGO.entities))).toEqual([]);
    const roots = doc.getRoot().getDefaultScene().listChildren();
    expect(roots.map((r) => [r.getName(), r.listChildren().map((c) => c.getName().split('.')[0])])).toEqual([
      ['2:31017:6416', ['door8_2_31017_6416', 'portapotty01_door']],
      ['2:31017:6426', ['door9_2_31017_6426', 'portapotty01_door']],
    ]);
    const shrink = JSON.parse(fs.readFileSync(path.join(VERTIGO.out, 'shrink.json'), 'utf8'));
    expect(shrink.entities).toMatchObject({ count: 2, nodes: 4, trisIn: 2 * (4 + 136) });
  });

  it('left no surface of theirs in world.glb', async () => expectGoneFromWorld(VERTIGO));
});

/**
 * For every entity root of a built map, the median distance from its triangles' centres (at
 * spawn) to world.glb's surface is over 1 cm: with the door or window still in the world, its own
 * surface would sit at its centres (≤ 3 mm after simplification and quantization).
 */
async function expectGoneFromWorld(P) {
  const io = await createIO();
  const [world, ents] = [await io.read(P.world), await io.read(P.file)];
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(triangleSoup(world), 3));
  const bvh = new MeshBVH(geom, { maxLeafTris: 8 });
  const c = new THREE.Vector3();
  for (const root of ents.getRoot().getDefaultScene().listChildren()) {
    const pos = triangleSoup(ents, { under: root });
    const far = [];
    for (let i = 0; i < pos.length; i += 9) {
      c.set((pos[i] + pos[i + 3] + pos[i + 6]) / 3, (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3, (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3);
      far.push(bvh.closestPointToPoint(c).distance);
    }
    far.sort((a, b) => a - b);
    expect(far[Math.floor(far.length / 2)], root.getName()).toBeGreaterThan(0.01);
  }
}
