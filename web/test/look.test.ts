// The look step that runs on every loaded scene: lit (Lambert) or unlit (Basic) materials,
// smooth normals computed for meshes that have none, cutouts drawn from both sides, texture
// anisotropy, and no lights from the file. Runs on a scene built in node, shaped like what
// GLTFLoader returns for a map (COLOR_0, no normals, an embedded light) and a player
// (a skinned mesh with its own normals).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  GLASS,
  MAX_ANISOTROPY,
  applyLook,
  fillZeroNormals,
  materialFor,
  modelDresser,
  type LookMaterial,
  type LookOptions,
} from '../src/scene/look';
import {
  LIGHTMAP_DECODE,
  type Baked,
  type LightInfo,
} from '../src/scene/baked';

const LIT: LookOptions = { lit: true, smoothNormals: true, maxAnisotropy: 8 };
const UNLIT: LookOptions = {
  lit: false,
  smoothNormals: false,
  maxAnisotropy: 1,
};

/** Two triangles sharing an edge, indexed, at an angle: smooth normals differ from flat. */
function quad(color: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1], 3)
  );
  g.setIndex([0, 2, 1, 1, 2, 3]);
  if (color)
    g.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(
        [1, 1, 1, 0.5, 0.5, 0.5, 0.2, 0.2, 0.2, 1, 1, 1],
        3
      )
    );
  return g;
}

interface Tiny {
  root: THREE.Group;
  wall: THREE.Mesh;
  plain: THREE.Mesh;
  leaves: THREE.Mesh;
  glass: THREE.Mesh;
  body: THREE.SkinnedMesh;
  stone: THREE.Texture;
  foliage: THREE.Texture;
  sources: THREE.Material[];
}

function tinyScene(): Tiny {
  const root = new THREE.Group();
  const stone = new THREE.Texture();
  const foliage = new THREE.Texture();
  const wallMat = new THREE.MeshStandardMaterial({ name: 'wall', map: stone });
  // Baked AO in COLOR_0, no normals: a map mesh.
  const wall = new THREE.Mesh(quad(true), wallMat);
  wall.name = 'wall';
  // A map without COLOR_0 shares the same material.
  const plain = new THREE.Mesh(quad(false), wallMat);
  plain.name = 'plain';
  // An alpha-tested card that the file left single-sided.
  const leavesMat = new THREE.MeshStandardMaterial({
    name: 'leaves',
    map: foliage,
    alphaTest: 0.5,
  });
  const leaves = new THREE.Mesh(quad(true), leavesMat);
  leaves.name = 'leaves';
  const glassMat = new THREE.MeshStandardMaterial({
    name: 'glass',
    map: stone,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const glass = new THREE.Mesh(quad(true), glassMat);
  glass.name = 'glass';
  // A light from KHR_lights_punctual, with its target as a child the way GLTFLoader adds it.
  const sun = new THREE.DirectionalLight();
  sun.add(sun.target);
  const holder = new THREE.Object3D();
  holder.add(sun);
  // A player: skinned, with its own normals.
  const bone = new THREE.Bone();
  const bodyGeo = quad(false);
  bodyGeo.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3)
  );
  bodyGeo.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(new Array(16).fill(0), 4)
  );
  bodyGeo.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(
      [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      4
    )
  );
  const bodyMat = new THREE.MeshStandardMaterial({ name: 'body' });
  const body = new THREE.SkinnedMesh(bodyGeo, bodyMat);
  body.add(bone);
  body.bind(new THREE.Skeleton([bone]));
  root.add(wall, plain, leaves, glass, holder, body);
  return {
    root,
    wall,
    plain,
    leaves,
    glass,
    body,
    stone,
    foliage,
    sources: [wallMat, leavesMat, glassMat, bodyMat],
  };
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

function lightsOf(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if ((o as THREE.Light).isLight) n++;
  });
  return n;
}

const mat = (m: THREE.Mesh) => {
  expect(Array.isArray(m.material)).toBe(false);
  return m.material as THREE.MeshLambertMaterial;
};

describe('applyLook, lit', () => {
  it('makes every material Lambert, removes the light and counts what it did', () => {
    const t = tinyScene();
    const bodyNormal = t.body.geometry.getAttribute('normal');
    const res = applyLook(t.root, LIT);
    expect(res).toEqual({ meshes: 5, lightsRemoved: 1, normalsComputed: 4 });
    for (const m of meshesOf(t.root))
      expect(mat(m)).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(lightsOf(t.root)).toBe(0);
    // The skinned mesh keeps its own normals, the very same attribute.
    expect(t.body.geometry.getAttribute('normal')).toBe(bodyNormal);
  });

  it('computes smooth normals where there were none', () => {
    const t = tinyScene();
    expect(t.wall.geometry.hasAttribute('normal')).toBe(false);
    applyLook(t.root, LIT);
    const n = t.wall.geometry.getAttribute('normal');
    expect(n).toBeDefined();
    expect(n.count).toBe(4);
    // Vertex 1 and 2 are shared by both faces: their normal is the average, not either face's.
    const shared = new THREE.Vector3().fromBufferAttribute(n, 1);
    const face0 = new THREE.Vector3().fromBufferAttribute(n, 0);
    expect(shared.length()).toBeCloseTo(1, 5);
    expect(shared.distanceTo(face0)).toBeGreaterThan(0.01);
    expect(mat(t.wall).flatShading).toBe(false);
  });

  it('leaves no zero-length normal on back-to-back or degenerate faces', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        // A triangle drawn from both sides on the same three vertices, then a degenerate one.
        [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 1, 0, 2, 2, 0, 2],
        3
      )
    );
    g.setIndex([0, 1, 2, 0, 2, 1, 3, 4, 5]);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
    applyLook(root, LIT);
    const n = g.getAttribute('normal');
    const v = new THREE.Vector3();
    for (let i = 0; i < n.count; i++)
      expect(v.fromBufferAttribute(n, i).length()).toBeCloseTo(1, 5);
    // The zero ones point straight up, and a second pass finds none.
    expect(v.fromBufferAttribute(n, 0).toArray()).toEqual([0, 1, 0]);
    expect(fillZeroNormals(g)).toBe(0);
  });

  it('shades lit cutouts with the front normal bent to the sky, and only them', () => {
    const t = tinyScene();
    applyLook(t.root, LIT);
    const leaves = mat(t.leaves);
    expect(leaves.customProgramCacheKey()).toBe('demoviewer-foliage');
    const shader = {
      fragmentShader: 'a\n#include <normal_fragment_begin>\nb',
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    leaves.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('normal *= faceDirection;');
    expect(shader.fragmentShader).toContain(
      'viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)'
    );
    expect(mat(t.wall).customProgramCacheKey()).not.toBe('demoviewer-foliage');
    // A three.js that moved the chunk fails loudly, not drawing dark leaves again.
    const moved = {
      fragmentShader: 'a\nb',
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    expect(() =>
      leaves.onBeforeCompile(moved, {} as THREE.WebGLRenderer)
    ).toThrow('shader hook: expected one #include <normal_fragment_begin>');
    applyLook(t.root, UNLIT);
    expect(mat(t.leaves).customProgramCacheKey()).not.toBe(
      'demoviewer-foliage'
    );
  });

  it('draws cutouts from both sides and keeps blending, colour and AO', () => {
    const t = tinyScene();
    applyLook(t.root, LIT);
    const leaves = mat(t.leaves);
    expect(leaves.alphaTest).toBeCloseTo(0.5);
    expect(leaves.side).toBe(THREE.DoubleSide);
    expect(leaves.transparent).toBe(false);

    const wall = mat(t.wall);
    expect(wall.side).toBe(THREE.FrontSide);
    expect(wall.alphaTest).toBe(0);
    expect(wall.map).toBe(t.stone);
    expect(wall.vertexColors).toBe(true);
    // The same source material on a mesh without COLOR_0 gets its own copy without AO.
    expect(mat(t.plain).vertexColors).toBe(false);
    expect(mat(t.plain)).not.toBe(wall);

    const glass = mat(t.glass);
    expect(glass.transparent).toBe(true);
    expect(glass.opacity).toBeCloseTo(0.5);
    expect(glass.depthWrite).toBe(false);
    expect(glass.side).toBe(THREE.FrontSide);
  });

  it('sets the anisotropy of every texture once', () => {
    const t = tinyScene();
    const before = [t.stone.version, t.foliage.version];
    applyLook(t.root, LIT);
    expect(t.stone.anisotropy).toBe(8);
    expect(t.foliage.anisotropy).toBe(8);
    // A changed sampler needs a re-upload, once per texture even when shared.
    expect(t.stone.version).toBe(before[0] + 1);
    expect(t.foliage.version).toBe(before[1] + 1);
  });

  it('caps the anisotropy at the look maximum and never goes below 1', () => {
    const t = tinyScene();
    applyLook(t.root, { ...LIT, maxAnisotropy: 16 });
    expect(t.stone.anisotropy).toBe(MAX_ANISOTROPY);
    applyLook(t.root, { ...LIT, maxAnisotropy: 0 });
    expect(t.stone.anisotropy).toBe(1);
  });

  it('disposes the materials it replaced, not their textures', () => {
    const t = tinyScene();
    const disposed = new Set<THREE.Material>();
    for (const m of t.sources)
      m.addEventListener('dispose', () => disposed.add(m));
    let textureDisposed = false;
    t.stone.addEventListener('dispose', () => (textureDisposed = true));
    applyLook(t.root, LIT);
    expect([...disposed]).toEqual(expect.arrayContaining(t.sources));
    expect(textureDisposed).toBe(false);
  });

  it('flat-shades instead when smooth normals are off', () => {
    const t = tinyScene();
    const res = applyLook(t.root, { ...LIT, smoothNormals: false });
    expect(res.normalsComputed).toBe(0);
    expect(t.wall.geometry.hasAttribute('normal')).toBe(false);
    expect(mat(t.wall)).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mat(t.wall).flatShading).toBe(true);
  });

  it('converts each material of a multi-material mesh', () => {
    const g = quad(true);
    g.addGroup(0, 3, 0);
    g.addGroup(3, 3, 1);
    const a = new THREE.MeshStandardMaterial({ name: 'a' });
    const b = new THREE.MeshStandardMaterial({ name: 'b', alphaTest: 0.3 });
    const m = new THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>(g, [a, b]);
    const root = new THREE.Group().add(m);
    applyLook(root, LIT);
    const out = m.material as THREE.MeshLambertMaterial[];
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.name)).toEqual(['a', 'b']);
    for (const x of out) expect(x).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(out[1].side).toBe(THREE.DoubleSide);
  });
});

describe('applyLook, unlit', () => {
  it('makes every material Basic and computes no normals', () => {
    const t = tinyScene();
    const res = applyLook(t.root, UNLIT);
    expect(res).toEqual({ meshes: 5, lightsRemoved: 1, normalsComputed: 0 });
    for (const m of meshesOf(t.root))
      expect(m.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(t.wall.geometry.hasAttribute('normal')).toBe(false);
    expect((t.wall.material as THREE.MeshBasicMaterial).vertexColors).toBe(
      true
    );
    expect(t.stone.anisotropy).toBe(1);
  });

  it('switches back and forth on the same scene', () => {
    const t = tinyScene();
    applyLook(t.root, LIT);
    const lit = mat(t.leaves);
    let litDisposed = false;
    lit.addEventListener('dispose', () => (litDisposed = true));
    applyLook(t.root, UNLIT);
    expect(litDisposed).toBe(true);
    const leaves = t.leaves.material as THREE.MeshBasicMaterial;
    expect(leaves).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(leaves.side).toBe(THREE.DoubleSide);
    expect(leaves.alphaTest).toBeCloseTo(0.5);
    expect(leaves.map).toBe(t.foliage);
    applyLook(t.root, LIT);
    expect(mat(t.glass).transparent).toBe(true);
    expect(mat(t.glass).depthWrite).toBe(false);
    expect(mat(t.wall).vertexColors).toBe(true);
  });
});

describe('materialFor', () => {
  it('keeps a double-sided opaque material double-sided', () => {
    const src = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    for (const lit of [true, false]) {
      const m = materialFor(src, { ...LIT, lit, hasColor: false });
      expect(m.side).toBe(THREE.DoubleSide);
      expect(m.alphaTest).toBe(0);
    }
  });

  it('copies the base colour, name and AO flag', () => {
    const src = new THREE.MeshStandardMaterial({
      name: 'plain',
      color: 0x336699,
    });
    const m = materialFor(src, { ...LIT, hasColor: true });
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(m.name).toBe('plain');
    expect(m.color.getHex()).toBe(0x336699);
    expect(m.color).not.toBe(src.color);
    expect(m.vertexColors).toBe(true);
    expect(m.map).toBeNull();
    const basic = materialFor(src, { ...UNLIT, hasColor: false });
    expect(basic).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(basic.vertexColors).toBe(false);
  });
});

describe('modelDresser', () => {
  /** A mesh on `geo` drawn with `material`, as a cloned model holds them. */
  const mesh = (geo: THREE.BufferGeometry, material: THREE.Material) =>
    new THREE.Mesh(geo, material);

  it('makes one material per source material, COLOR_0 and normals, shared by the meshes, and leaves the sources as they are', () => {
    const map = new THREE.Texture();
    const skin = new THREE.MeshStandardMaterial({ map });
    const cloth = new THREE.MeshStandardMaterial();
    const smooth = new THREE.BoxGeometry(1, 1, 1);
    const flat = new THREE.BoxGeometry(1, 1, 1);
    flat.deleteAttribute('normal');
    const tinted = new THREE.BoxGeometry(1, 1, 1);
    tinted.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(3 * 24).fill(1), 3)
    );
    const meshes = [
      mesh(smooth, skin),
      mesh(smooth, skin),
      mesh(flat, skin),
      mesh(tinted, skin),
      new THREE.Mesh(smooth, [skin, cloth]),
    ];
    const out: LookMaterial[] = [];
    const dress = modelDresser(LIT, out);
    for (const m of meshes) dress(m);

    // skin (smooth), skin (flat), skin (smooth, COLOR_0), cloth (smooth).
    expect(out).toHaveLength(4);
    const [a, b, c, d, e] = meshes.map((m) => m.material);
    expect(a).toBe(b);
    expect((e as THREE.Material[])[0]).toBe(a);
    expect(new Set([a, c, d, (e as THREE.Material[])[1]]).size).toBe(4);
    for (const m of out) expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect((a as THREE.MeshLambertMaterial).flatShading).toBe(false);
    expect((c as THREE.MeshLambertMaterial).flatShading).toBe(true);
    expect((d as THREE.MeshLambertMaterial).vertexColors).toBe(true);
    expect((a as THREE.MeshLambertMaterial).vertexColors).toBe(false);
    // The texture is shared, at the look's anisotropy; the sources are untouched.
    expect((a as THREE.MeshLambertMaterial).map).toBe(map);
    expect(map.anisotropy).toBe(LIT.maxAnisotropy);
    expect(skin).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(flat.hasAttribute('normal')).toBe(false);
  });

  it('dresses unlit in Basic materials', () => {
    const out: LookMaterial[] = [];
    const m = mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial()
    );
    modelDresser(UNLIT, out)(m);
    expect(out).toEqual([m.material]);
    expect(m.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });
});

describe("CS2's glass (csgo_glass.vfx)", () => {
  /**
   * A glass material as GLTFLoader makes it from VRF's export: BLEND (so transparent, without
   * depth writes), base alpha 1, no texture, the vmat in its extras.
   */
  function glass(color = 0xffffff, tint?: [number, number, number, number]) {
    const m = new THREE.MeshStandardMaterial({
      name: 'hr_glass_001',
      color,
      transparent: true,
      depthWrite: false,
    });
    m.userData = {
      vmat: {
        Name: 'materials/glass/hr_g/hr_glass_001.vmat',
        ShaderName: 'csgo_glass.vfx',
        VectorParams: tint ? { GlassTintColor: tint } : {},
      },
    };
    return m;
  }

  it('is see-through, writes no depth and keeps its base colour, lit or not', () => {
    for (const lit of [true, false]) {
      const m = materialFor(glass(0xd2c8bc), { ...LIT, lit, hasColor: false });
      expect(m.transparent).toBe(true);
      expect(m.opacity).toBe(GLASS.opacity);
      expect(GLASS.opacity).toBeCloseTo(0.3, 6);
      expect(m.depthWrite).toBe(false);
      expect(m.color.getHex()).toBe(0xd2c8bc);
    }
  });

  it('is tinted by its GlassTintColor (an sRGB colour), once, however often it is dressed', () => {
    const src = glass(0xffffff, [0.5, 1, 1, 0]);
    const m = materialFor(src, { ...LIT, hasColor: false });
    const want = new THREE.Color().setRGB(0.5, 1, 1, THREE.SRGBColorSpace);
    expect(m.color.r).toBeCloseTo(want.r, 6);
    expect(m.color.g).toBeCloseTo(1, 6);
    // A preset change dresses the dressed material again: tinted no further, still glass.
    const again = materialFor(m, { ...UNLIT, hasColor: false });
    expect(again.color.r).toBeCloseTo(want.r, 6);
    expect(again.opacity).toBe(GLASS.opacity);
    expect(again.userData.vmat.ShaderName).toBe('csgo_glass.vfx');
  });

  it('lets less through frosted glass (its vmat named so), and keeps a copy of the extras of its own', () => {
    const src = glass();
    src.name = 'hr_glass_frosted_004';
    src.userData.vmat.Name = 'materials/glass/hr_g/hr_glass_frosted_004.vmat';
    const m = materialFor(src, { ...LIT, hasColor: false });
    expect(m.opacity).toBe(GLASS.frosted);
    expect(GLASS.frosted).toBeCloseTo(0.7, 6);
    expect(m.depthWrite).toBe(false);
    expect(materialFor(m, { ...UNLIT, hasColor: false }).opacity).toBe(
      GLASS.frosted
    );
    // Clear glass stays clear.
    expect(materialFor(glass(), { ...LIT, hasColor: false }).opacity).toBe(
      GLASS.opacity
    );
    // The extras are the source's, in an object of the material's own.
    expect(m.userData).not.toBe(src.userData);
    expect(m.userData).toEqual(src.userData);
  });

  it('leaves other blended materials as they are', () => {
    const src = glass();
    src.userData.vmat.ShaderName = 'csgo_complex.vfx';
    src.opacity = 0.8;
    const m = materialFor(src, { ...LIT, hasColor: false });
    expect(m.opacity).toBe(0.8);
    const plain = materialFor(new THREE.MeshStandardMaterial(), {
      ...LIT,
      hasColor: false,
    });
    expect(plain.opacity).toBe(1);
    expect(plain.transparent).toBe(false);
  });

  it('is glass in the world under any look, with a bake too, without the detail texture', () => {
    const detail = new THREE.Texture();
    const baked: Baked = {
      info: {
        version: 2,
        range: 16,
        lightmap: { file: 'lightmap.webp', size: [1024, 1024] },
        sun: { dir: [0, 1, 0], color: [1, 1, 1], intensity: 2.4, baked: true },
        probes: { file: 'probes.bin' },
      },
      lightmap: new THREE.Texture(),
      lightGrid: {
        origin: [0, 0, 0],
        step: 2.5,
        size: [1, 1, 1],
        range: 16,
        version: 2,
        cells: new Uint8Array(10),
      },
    };
    const root = new THREE.Group();
    const pane: THREE.Mesh = new THREE.Mesh(quad(true), glass());
    root.add(pane);
    for (const look of [
      { ...LIT, detail },
      { ...UNLIT },
      { ...LIT, baked },
      { ...UNLIT, baked },
      { ...LIT, detail },
    ]) {
      applyLook(root, look);
      const m = pane.material as THREE.MeshLambertMaterial;
      expect(m.opacity).toBe(GLASS.opacity);
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
      expect(m.customProgramCacheKey()).not.toContain('detail');
    }
  });
});

describe('applyLook with a bake', () => {
  /** Nuke's light.json, shortened. */
  const info: LightInfo = {
    version: 2,
    range: 16,
    lightmap: { file: 'lightmap.webp', size: [1024, 1024] },
    sun: { dir: [0, 1, 0], color: [1, 1, 1], intensity: 2.4, baked: true },
    probes: { file: 'probes.bin' },
  };
  const baked: Baked = {
    info,
    lightmap: new THREE.Texture(),
    lightGrid: {
      origin: [0, 0, 0],
      step: 2.5,
      size: [1, 1, 1],
      range: 16,
      version: 2,
      cells: new Uint8Array(10),
    },
  };

  /** A quad with the lightmap UV (TEXCOORD_1), and no COLOR_0. */
  function lightmapped(): THREE.BufferGeometry {
    const g = quad(false);
    g.setAttribute(
      'uv1',
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2)
    );
    return g;
  }

  /** The same three kinds of world mesh on one source material, and a lit cutout. */
  function world() {
    const root = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ name: 'stone' });
    const floor = new THREE.Mesh(lightmapped(), stone);
    const crate = new THREE.Mesh(quad(true), stone);
    const bare = new THREE.Mesh(quad(false), stone);
    const leaves = new THREE.Mesh(
      lightmapped(),
      new THREE.MeshStandardMaterial({ name: 'leaves', alphaTest: 0.5 })
    );
    root.add(floor, crate, bare, leaves);
    return { root, floor, crate, bare, leaves };
  }

  it('gives lightmapped meshes the lightmap, vertex-lit ones their light, the rest today’s material', () => {
    const w = world();
    applyLook(w.root, { ...LIT, baked });
    const floor = mat(w.floor);
    expect(floor).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(floor.lightMap).toBe(baked.lightmap);
    expect(floor.customProgramCacheKey()).toContain('baked-lightmap');
    const crate = mat(w.crate);
    expect(crate.lightMap).toBeNull();
    expect(crate.vertexColors).toBe(false);
    expect(crate.customProgramCacheKey()).toContain('baked-vertex');
    // One source material, three materials: the convert key knows uv1 and COLOR_0.
    expect(new Set([floor, crate, mat(w.bare)]).size).toBe(3);
    const bare = mat(w.bare);
    expect(bare.lightMap).toBeNull();
    expect(bare.customProgramCacheKey()).not.toContain('baked');
    expect(bare.vertexColors).toBe(false);
  });

  it('keeps the vertex light where the lightmap did not load: vertex-lit meshes keep the bake, lightmapped ones without COLOR_0 take today’s material', () => {
    const w = world();
    const noLightmap: Baked = {
      ...baked,
      lightmap: null,
      lightmapError: '/maps/de_nuke/lightmap.webp: HTTP 404',
    };
    applyLook(w.root, { ...LIT, baked: noLightmap });
    expect(mat(w.crate).customProgramCacheKey()).toContain('baked-vertex');
    expect(mat(w.crate).lightMap).toBeNull();
    for (const m of [mat(w.floor), mat(w.bare)]) {
      expect(m.lightMap).toBeNull();
      expect(m.customProgramCacheKey()).not.toContain('baked');
    }
  });

  it('dresses the world in the bake at low too, unlit meshes without it staying Basic', () => {
    const w = world();
    applyLook(w.root, { ...UNLIT, baked });
    expect(mat(w.floor)).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mat(w.floor).lightMap).toBe(baked.lightmap);
    expect(mat(w.floor).flatShading).toBe(true);
    expect(mat(w.crate)).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mat(w.crate).customProgramCacheKey()).toContain('baked-vertex');
    expect(w.bare.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    // No normals are computed at low: the bake needs none.
    expect(w.floor.geometry.hasAttribute('normal')).toBe(false);
  });

  it('takes the detail texture off what the bake lights (its light has the real variation), and keeps it on the rest', () => {
    const w = world();
    applyLook(w.root, { ...LIT, baked, detail: new THREE.Texture() });
    const floorKey = mat(w.floor).customProgramCacheKey();
    expect(floorKey).toContain('baked-lightmap');
    expect(floorKey).not.toContain('detail');
    expect(mat(w.crate).customProgramCacheKey()).not.toContain('detail');
    // A mesh the bake does not light keeps today's material, the detail included.
    expect(mat(w.bare).customProgramCacheKey()).toContain('detail');
    // Without the bake, the same world takes it everywhere, as today.
    const today = world();
    applyLook(today.root, { ...LIT, detail: new THREE.Texture() });
    expect(mat(today.floor).customProgramCacheKey()).toContain('detail');
    expect(mat(today.crate).customProgramCacheKey()).toContain('detail');
  });

  it('composes the bake with the foliage normal', () => {
    const w = world();
    applyLook(w.root, { ...LIT, baked, detail: new THREE.Texture() });
    const leaves = mat(w.leaves);
    expect(leaves.lightMap).toBe(baked.lightmap);
    const key = leaves.customProgramCacheKey();
    expect(key).toContain('baked-lightmap');
    expect(key).toContain('foliage');
    const src = THREE.ShaderLib.lambert;
    const shader = {
      uniforms: THREE.UniformsUtils.clone(src.uniforms),
      vertexShader: src.vertexShader,
      fragmentShader: src.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    leaves.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('normal *= faceDirection;');
    expect(shader.fragmentShader).toContain(LIGHTMAP_DECODE);
    expect(shader.fragmentShader).not.toContain(
      '#include <lights_fragment_begin>'
    );
  });

  it('switches back to today’s look without the bake', () => {
    const w = world();
    applyLook(w.root, { ...LIT, baked });
    applyLook(w.root, LIT);
    expect(mat(w.floor).lightMap).toBeNull();
    expect(mat(w.floor).customProgramCacheKey()).not.toContain('baked');
    expect(mat(w.crate).vertexColors).toBe(true);
  });

  it('leaves materialFor (the players’) as it was', () => {
    const src = new THREE.MeshStandardMaterial({ name: 'body' });
    for (const lit of [true, false]) {
      const plain = materialFor(src, { ...LIT, lit, hasColor: false });
      const withBake = materialFor(src, {
        ...LIT,
        lit,
        baked,
        hasColor: false,
      });
      expect(withBake.constructor).toBe(plain.constructor);
      expect(
        (withBake as THREE.MeshLambertMaterial).lightMap ?? null
      ).toBeNull();
      expect(withBake.customProgramCacheKey()).toBe(
        plain.customProgramCacheKey()
      );
    }
  });
});
