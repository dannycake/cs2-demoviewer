// Every world material becomes a lit MeshLambertMaterial, or an unlit MeshBasicMaterial in
// the unlit look, that keeps its texture and multiplies in the baked AO from COLOR_0. Runs on
// a GLB built here; with ASSETS_DIR=<repo>/assets it also checks the real Mirage and Ancient
// worlds and both player models.

import { join } from 'node:path';
import { Document, NodeIO, type Material } from '@gltf-transform/core';
import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  disposeObject,
  loadRigTemplate,
  loadWorld,
} from '../src/scene/loaders';
import { UNLIT_LOOK, applyLook, type LookOptions } from '../src/scene/look';
import { blobUrl, fileUrl, installBrowserShims } from './helpers/node-gltf';
import { needs } from './helpers/gates';

const ASSETS = process.env.ASSETS_DIR;
const LIT: LookOptions = { lit: true, smoothNormals: true, maxAnisotropy: 8 };

// A valid 1x1 PNG; the bitmap stub never decodes it.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
);

/**
 * One-triangle meshes: textured with AO, alpha-masked double-sided, alpha-blended, and plain
 * without AO.
 */
async function tinyWorld(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC2' | 'VEC3', values: number[]) =>
    doc
      .createAccessor()
      .setType(type)
      .setArray(new Float32Array(values))
      .setBuffer(buffer);
  const tex = doc.createTexture('stone').setImage(PNG).setMimeType('image/png');
  const mesh = (name: string, material: Material, ao: boolean) => {
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', acc('VEC3', [0, 0, 0, 1, 0, 0, 0, 0, 1]))
      .setAttribute('TEXCOORD_0', acc('VEC2', [0, 0, 1, 0, 0, 1]))
      .setMaterial(material);
    if (ao)
      prim.setAttribute(
        'COLOR_0',
        acc('VEC3', [1, 1, 1, 0.5, 0.5, 0.5, 0.2, 0.2, 0.2])
      );
    return doc
      .createNode(name)
      .setMesh(doc.createMesh(name).addPrimitive(prim));
  };
  const scene = doc.createScene();
  scene.addChild(
    mesh(
      'wall',
      doc.createMaterial('wall').setBaseColorTexture(tex).setRoughnessFactor(1),
      true
    )
  );
  scene.addChild(
    mesh(
      'fence',
      doc
        .createMaterial('fence')
        .setBaseColorTexture(tex)
        .setAlphaMode('MASK')
        .setAlphaCutoff(0.4)
        .setDoubleSided(true),
      true
    )
  );
  scene.addChild(
    mesh(
      'glass',
      doc
        .createMaterial('glass')
        .setBaseColorTexture(tex)
        .setBaseColorFactor([1, 1, 1, 0.5])
        .setAlphaMode('BLEND'),
      true
    )
  );
  scene.addChild(
    mesh(
      'plain',
      doc.createMaterial('plain').setBaseColorFactor([0.2, 0.4, 0.6, 1]),
      false
    )
  );
  return new NodeIO().writeBinary(doc);
}

/** The world at `url`, dressed in `look` as the scene dresses it once its bake is in. */
async function dressedWorld(
  url: string,
  look: LookOptions
): Promise<THREE.Group> {
  const world = await loadWorld(url);
  applyLook(world, look);
  return world;
}

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

function single(m: THREE.Mesh): THREE.MeshBasicMaterial {
  expect(Array.isArray(m.material)).toBe(false);
  return m.material as THREE.MeshBasicMaterial;
}

beforeAll(installBrowserShims);

describe('loadWorld, unlit', () => {
  let world: THREE.Group;
  const byName = (n: string) => meshes(world).find((m) => m.name === n)!;

  beforeAll(async () => {
    world = await dressedWorld(blobUrl(await tinyWorld()), UNLIT_LOOK);
  });

  it('replaces every material with an unlit one', () => {
    const all = meshes(world);
    expect(all).toHaveLength(4);
    for (const m of all) {
      expect(single(m)).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(m.frustumCulled).toBe(true);
    }
  });

  it('multiplies in COLOR_0 only where the geometry has it', () => {
    expect(byName('wall').geometry.hasAttribute('color')).toBe(true);
    expect(single(byName('wall')).vertexColors).toBe(true);
    expect(single(byName('fence')).vertexColors).toBe(true);
    expect(byName('plain').geometry.hasAttribute('color')).toBe(false);
    expect(single(byName('plain')).vertexColors).toBe(false);
  });

  it('keeps the texture, base colour and alpha mask, front faces by default', () => {
    const wall = single(byName('wall'));
    expect(wall.map).toBeInstanceOf(THREE.Texture);
    expect(wall.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(wall.side).toBe(THREE.FrontSide);
    expect(wall.transparent).toBe(false);
    expect(wall.depthWrite).toBe(true);
    expect(wall.alphaTest).toBe(0);

    const fence = single(byName('fence'));
    expect(fence.map).toBe(wall.map);
    expect(fence.alphaTest).toBeCloseTo(0.4);
    // A double-sided glTF material (foliage, fences) stays visible from behind.
    expect(fence.side).toBe(THREE.DoubleSide);
    expect(fence.transparent).toBe(false);

    const glass = single(byName('glass'));
    expect(glass.transparent).toBe(true);
    expect(glass.depthWrite).toBe(false);
    expect(glass.opacity).toBeCloseTo(0.5);
    expect(glass.alphaTest).toBe(0);

    const plain = single(byName('plain'));
    expect(plain.map).toBeNull();
    expect(plain.color.toArray()).toEqual([
      expect.closeTo(0.2, 5),
      expect.closeTo(0.4, 5),
      expect.closeTo(0.6, 5),
    ]);
  });
});

describe('loadWorld, lit', () => {
  it('lights every mesh with smooth normals and keeps alpha and AO', async () => {
    const world = await dressedWorld(blobUrl(await tinyWorld()), LIT);
    const all = meshes(world);
    expect(all).toHaveLength(4);
    for (const m of all) {
      expect(m.material).toBeInstanceOf(THREE.MeshLambertMaterial);
      expect(m.geometry.hasAttribute('normal')).toBe(true);
    }
    const byName = (n: string) =>
      all.find((m) => m.name === n)!.material as THREE.MeshLambertMaterial;
    expect(byName('wall').vertexColors).toBe(true);
    expect(byName('wall').flatShading).toBe(false);
    expect(byName('wall').map!.anisotropy).toBe(8);
    expect(byName('fence').alphaTest).toBeCloseTo(0.4);
    expect(byName('fence').side).toBe(THREE.DoubleSide);
    expect(byName('glass').transparent).toBe(true);
    expect(byName('plain').vertexColors).toBe(false);
  });
});

describe('disposeObject', () => {
  it("frees the textures the GLB brought, and not the bake's lightmap its materials borrow", async () => {
    const world = await dressedWorld(blobUrl(await tinyWorld()), LIT);
    const lightmap = new THREE.Texture();
    const borrowed = vi.fn();
    lightmap.addEventListener('dispose', borrowed);
    const own = new Set<THREE.Texture>();
    for (const m of meshes(world)) {
      const material = m.material as THREE.MeshLambertMaterial;
      if (material.map) own.add(material.map);
      material.lightMap = lightmap;
    }
    expect(own.size).toBeGreaterThan(0);
    const freed = vi.fn();
    for (const t of own) t.addEventListener('dispose', freed);
    disposeObject(world);
    expect(freed).toHaveBeenCalledTimes(own.size);
    expect(borrowed).not.toHaveBeenCalled();
  });
});

describe.skipIf(!ASSETS)(
  needs('the worlds and players in the built assets', 'ASSETS_DIR'),
  () => {
    it('loads the Mirage world unlit with baked AO and no lights', async () => {
      const world = await dressedWorld(
        await fileUrl(join(ASSETS!, 'maps/de_mirage/world.glb')),
        UNLIT_LOOK
      );
      const all = meshes(world);
      let textured = 0;
      let lights = 0;
      world.traverse((o) => {
        if ((o as THREE.Light).isLight) lights++;
      });
      for (const m of all) {
        const mat = single(m);
        expect(mat).toBeInstanceOf(THREE.MeshBasicMaterial);
        expect(mat.vertexColors).toBe(m.geometry.hasAttribute('color'));
        expect(m.geometry.hasAttribute('normal')).toBe(false);
        if (mat.map) textured++;
      }
      console.log(`mirage world: ${all.length} meshes, ${textured} textured`);
      expect(all.length).toBeGreaterThan(100);
      expect(textured / all.length).toBeGreaterThan(0.9);
      expect(lights).toBe(0);
    }, 60_000);

    it('loads the Mirage world lit with smooth normals', async () => {
      const url = await fileUrl(join(ASSETS!, 'maps/de_mirage/world.glb'));
      const t0 = performance.now();
      const world = await dressedWorld(url, LIT);
      const ms = performance.now() - t0;
      let vertices = 0;
      for (const m of meshes(world)) {
        expect(m.material).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(m.geometry.hasAttribute('normal')).toBe(true);
        vertices += m.geometry.getAttribute('position').count;
      }
      console.log(
        `mirage lit: ${vertices} vertices with normals, loaded in ${ms.toFixed(0)} ms`
      );
    }, 60_000);

    it('drops the light embedded in the Ancient world', async () => {
      const world = await dressedWorld(
        await fileUrl(join(ASSETS!, 'maps/de_ancient/world.glb')),
        LIT
      );
      let lights = 0;
      world.traverse((o) => {
        if ((o as THREE.Light).isLight) lights++;
      });
      expect(lights).toBe(0);
      expect(meshes(world).length).toBeGreaterThan(100);
    }, 60_000);

    it.each(['ct', 't'])(
      'loads the %s rig template with the whole clip set',
      async (side) => {
        const tmpl = await loadRigTemplate(
          await fileUrl(join(ASSETS!, `players/${side}.glb`))
        );
        const names = [...tmpl.clips.keys()];
        expect(names.length).toBeGreaterThanOrEqual(200);
        for (const c of [
          'idle_rifle',
          'run_n_rifle',
          'run_sw_rifle',
          'walk_e_pistol',
          'crouch_s_rifle',
          'run_w_knife',
          'shoot_ak',
          'reload_awp',
          'throw_overhand_grenade',
          'planting',
          'defuse_loop_rifle',
          'flashed',
          'flinch_head_left',
        ])
          expect(names).toContain(c);
        let skinned = 0;
        tmpl.scene.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++;
        });
        expect(skinned).toBeGreaterThan(0);
      },
      30_000
    );
  }
);
