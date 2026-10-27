// Team outlines through walls (Task 3): the six shared materials, the hull's screen-space push,
// the two outline siblings of every mesh of a rig, and how a rig and the pool colour and hide
// them. Runs on a two-bone stub skeleton; the look of the result is checked in the browser.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/pack/types';
import type { RigInput } from '../src/scene/frame';
import type { RigTemplate } from '../src/scene/loaders';
import {
  OUTLINE,
  OutlineMaterials,
  outlineMeshes,
  type OutlineColor,
} from '../src/scene/outline';
import { PlayerRig, RigPool } from '../src/scene/PlayerRig';
import { WeaponCache } from '../src/scene/weapons';
import { DEATH_COLLAPSE_S, DEATH_FADE_S, DEATH_HOLD_S } from '../src/sim/anim';
import { newPlayerState } from '../src/sim/sample';

const HEADER = { tick_rate: 64 };
const flush = () => new Promise((r) => setTimeout(r, 0));

function triangle(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 1, 0, 0], 3)
  );
  geo.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
  );
  geo.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0], 4)
  );
  geo.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute(
      [0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0],
      4
    )
  );
  return geo;
}

/**
 * A skinned mesh bound to a two-bone skeleton (pelvis → wpn), under `root`; `spine_3`, where a
 * carrier's C4 hangs, is in the hierarchy but not the skeleton.
 */
function skinned(root: THREE.Object3D): THREE.SkinnedMesh {
  const pelvis = Object.assign(new THREE.Bone(), { name: 'pelvis' });
  const wpn = Object.assign(new THREE.Bone(), { name: 'wpn' });
  const spine = Object.assign(new THREE.Bone(), { name: 'spine_3' });
  wpn.position.set(0, 0.5, 0);
  pelvis.add(wpn, spine);
  root.add(pelvis);
  const mesh = new THREE.SkinnedMesh(
    triangle(),
    new THREE.MeshStandardMaterial()
  );
  mesh.name = 'body';
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([pelvis, wpn]));
  return mesh;
}

/**
 * A model like the real ones: a group of skinned meshes (one per material, as GLTFLoader
 * splits a multi-material mesh) sharing one skeleton, beside the bones.
 */
function template(): RigTemplate {
  const root = new THREE.Group();
  const body = skinned(root);
  const parts = new THREE.Group();
  parts.name = 'parts';
  root.add(parts);
  body.removeFromParent();
  parts.add(body);
  const head = new THREE.SkinnedMesh(
    triangle(),
    new THREE.MeshStandardMaterial({ color: 0x00ff00 })
  );
  head.name = 'head';
  parts.add(head);
  root.updateMatrixWorld(true);
  head.bind(body.skeleton, body.bindMatrix);
  const idle = new THREE.AnimationClip('idle_rifle', 1, []);
  return {
    scene: root,
    clips: new Map([[idle.name, idle]]),
    variants: new Map(),
  };
}

function input(o: Partial<RigInput> = {}): RigInput {
  return {
    state: {
      ...newPlayerState(),
      present: true,
      flags: FLAG.alive,
      health: 100,
    },
    team: 2,
    tick: 1000,
    clipTime: 0,
    deathTicks: null,
    death: null,
    actions: [],
    weapon: 'ak47',
    family: 'rifle',
    locomotion: [{ clip: 'idle_rifle', weight: 1, time: null }],
    ...o,
  };
}

/** The model's own meshes in `rig`, and the two outline siblings of each. */
function outlined(rig: PlayerRig, m: OutlineMaterials) {
  const outline = new Set<THREE.Material>();
  for (const c of [2, 3, 'shown'] as OutlineColor[])
    outline.add(m.hull(c)).add(m.xray(c));
  const out: {
    mesh: THREE.Mesh;
    hull: THREE.Mesh | undefined;
    xray: THREE.Mesh | undefined;
    siblings: number;
  }[] = [];
  rig.object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || outline.has(mesh.material as THREE.Material)) return;
    if (o.name.startsWith('weapon:') || o.parent?.name.startsWith('weapon:'))
      return;
    const siblings = mesh.parent!.children.filter(
      (s) => s !== mesh && (s as THREE.Mesh).geometry === mesh.geometry
    ) as THREE.Mesh[];
    const isHull = (s: THREE.Mesh) =>
      (s.material as THREE.Material).side === THREE.BackSide;
    out.push({
      mesh,
      hull: siblings.find(isHull),
      xray: siblings.find((s) => !isHull(s)),
      siblings: siblings.length,
    });
  });
  return out;
}

describe('OutlineMaterials', () => {
  it('is the shared x-ray and hull material of each colour', () => {
    const m = new OutlineMaterials();
    const xray = m.xray(2);
    expect(xray).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(xray.depthFunc).toBe(THREE.GreaterDepth);
    expect(xray.depthWrite).toBe(false);
    expect(xray.fog).toBe(false);
    expect(xray.toneMapped).toBe(false);
    expect(xray.color.getHexString()).toBe('f2a33a');
    const hull = m.hull(3);
    expect(hull.side).toBe(THREE.BackSide);
    expect(hull.depthTest).toBe(true);
    expect(hull.depthWrite).toBe(false);
    expect(hull.color.getHexString()).toBe('4da3ff');
    expect(m.hull('shown').color.getHexString()).toBe('ffffff');
    expect(m.xray('shown').color.getHexString()).toBe('ffffff');
    expect(m.xray(3).color.getHexString()).toBe('4da3ff');
    expect(m.hull(2).color.getHexString()).toBe('f2a33a');
    // A second call is the same object: six materials, shared by every rig.
    expect(m.xray(2)).toBe(xray);
    expect(m.hull(3)).toBe(hull);
    expect(OUTLINE).toEqual({
      widthPx: 2,
      xrayOrder: 1,
      rigOrder: 2,
      shownColor: 0xffffff,
    });
    expect(Object.isFrozen(OUTLINE)).toBe(true);
  });

  it('pushes the hull out widthPx after skinning, along the outward normal', () => {
    const m = new OutlineMaterials();
    const shader = {
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
      uniforms: {} as Record<string, THREE.IUniform>,
    };
    m.hull(2).onBeforeCompile(shader as never, null as never);
    const vs = shader.vertexShader;
    const main = vs.indexOf('void main()');
    expect(vs.indexOf('uniform float uOutlinePx;')).toBeGreaterThan(-1);
    expect(vs.indexOf('uniform float uOutlinePx;')).toBeLessThan(main);
    expect(vs.indexOf('uniform vec2 uViewport;')).toBeLessThan(main);
    const project = vs.indexOf('#include <project_vertex>');
    const push = vs.indexOf(
      'gl_Position.xy += n * uOutlinePx * 2.0 / uViewport * gl_Position.w;'
    );
    expect(project).toBeGreaterThan(main);
    expect(push).toBeGreaterThan(project);
    // A plain mesh has no transformedNormal in MeshBasicMaterial: the chunk makes it.
    const after = vs.slice(project);
    expect(after).toMatch(
      /#ifndef USE_SKINNING\s+#include <beginnormal_vertex>\s+#include <defaultnormal_vertex>\s+#endif/
    );
    expect(after.indexOf('#ifndef USE_SKINNING')).toBeLessThan(push - project);
    // BackSide defines FLIP_SIDED, which turns transformedNormal inwards: the push undoes it,
    // or the hull would shrink by widthPx instead of growing.
    expect(after).toMatch(/#ifdef FLIP_SIDED[\s\S]*-\s*transformedNormal/);
    expect(shader.uniforms.uOutlinePx.value).toBe(OUTLINE.widthPx);
    m.setViewport(2560, 1440);
    const vp = shader.uniforms.uViewport.value as THREE.Vector2;
    expect([vp.x, vp.y]).toEqual([2560, 1440]);
    // Every hull reads the same viewport.
    const other = {
      ...shader,
      vertexShader: THREE.ShaderLib.basic.vertexShader,
    };
    m.hull('shown').onBeforeCompile(other as never, null as never);
    expect(other.uniforms.uViewport.value).toBe(vp);
    // The x-ray is a plain flat colour.
    const plain = {
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      uniforms: {},
    };
    m.xray(2).onBeforeCompile(plain as never, null as never);
    expect(plain.vertexShader).toBe(THREE.ShaderLib.basic.vertexShader);
    // The hull's edit is a composed hook (hooks.ts), with its own program key.
    expect(m.hull(2).customProgramCacheKey()).toBe('demoviewer-outline');
  });

  it('fails loudly on a shader without the chunk the hull edits, rather than drawing no rim', () => {
    const m = new OutlineMaterials();
    const moved = {
      vertexShader: THREE.ShaderLib.basic.vertexShader.replace(
        '#include <project_vertex>',
        ''
      ),
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
      uniforms: {} as Record<string, THREE.IUniform>,
    };
    expect(() =>
      m.hull(3).onBeforeCompile(moved as never, null as never)
    ).toThrow('shader hook: expected one #include <project_vertex>');
  });

  it('frees its six materials', () => {
    const m = new OutlineMaterials();
    let freed = 0;
    for (const c of [2, 3, 'shown'] as OutlineColor[])
      for (const mat of [m.hull(c), m.xray(c)])
        mat.addEventListener('dispose', () => freed++);
    m.dispose();
    expect(freed).toBe(6);
  });
});

describe('outlineMeshes', () => {
  it('adds a hull and an x-ray beside a skinned mesh, on its skeleton', () => {
    const root = new THREE.Group();
    const mesh = skinned(root);
    mesh.position.set(1, 2, 3);
    const m = new OutlineMaterials();
    const { hull, xray } = outlineMeshes(mesh, m, 2);
    for (const o of [hull, xray]) {
      expect(o.parent).toBe(root);
      expect(o.geometry).toBe(mesh.geometry);
      expect((o as THREE.SkinnedMesh).isSkinnedMesh).toBe(true);
      expect((o as THREE.SkinnedMesh).skeleton).toBe(mesh.skeleton);
      expect((o as THREE.SkinnedMesh).bindMatrix.equals(mesh.bindMatrix)).toBe(
        true
      );
      expect(o.position.toArray()).toEqual([1, 2, 3]);
      expect(o.castShadow).toBe(false);
      expect(o.receiveShadow).toBe(false);
      expect(o.frustumCulled).toBe(false);
    }
    expect(xray.renderOrder).toBe(OUTLINE.xrayOrder);
    expect(hull.renderOrder).toBe(OUTLINE.rigOrder);
    expect(xray.renderOrder).toBe(1);
    expect(hull.renderOrder).toBe(2);
    expect(hull.material).toBe(m.hull(2));
    expect(xray.material).toBe(m.xray(2));
  });

  it('works on a plain mesh too', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(triangle(), new THREE.MeshBasicMaterial());
    root.add(mesh);
    const m = new OutlineMaterials();
    const { hull, xray } = outlineMeshes(mesh, m, 3);
    expect((hull as THREE.SkinnedMesh).isSkinnedMesh).toBeFalsy();
    expect(hull.parent).toBe(root);
    expect(xray.geometry).toBe(mesh.geometry);
    expect(xray.material).toBe(m.xray(3));
  });
});

describe('PlayerRig outlines', () => {
  it('gives every mesh of the model its two outline siblings', () => {
    const m = new OutlineMaterials();
    const rig = new PlayerRig(template(), 2, undefined, null, m);
    const meshes = outlined(rig, m);
    expect(meshes.map((x) => x.mesh.name).sort()).toEqual(['body', 'head']);
    for (const { mesh, hull, xray, siblings } of meshes) {
      expect(siblings).toBe(2);
      expect(mesh.renderOrder).toBe(OUTLINE.rigOrder);
      expect(mesh.castShadow).toBe(true);
      expect(hull!.material).toBe(m.hull(2));
      expect(xray!.material).toBe(m.xray(2));
      expect(hull!.renderOrder).toBe(2);
      expect(xray!.renderOrder).toBe(1);
      expect(hull!.castShadow || xray!.castShadow).toBe(false);
      expect((hull as THREE.SkinnedMesh).skeleton).toBe(
        (mesh as THREE.SkinnedMesh).skeleton
      );
    }
    // Hiding the rig hides them too: they are inside its object.
    rig.object.visible = false;
    for (const { hull } of meshes) {
      let shown = true;
      hull!.traverseAncestors((a) => (shown &&= a.visible));
      expect(shown).toBe(false);
    }
  });

  it('hides, whitens and recolours them', () => {
    const m = new OutlineMaterials();
    const rig = new PlayerRig(template(), 2, undefined, null, m);
    const meshes = outlined(rig, m);
    rig.setOutline(false, 2);
    for (const { hull, xray } of meshes) {
      expect(hull!.visible).toBe(false);
      expect(xray!.visible).toBe(false);
    }
    rig.setOutline(true, 'shown');
    for (const { hull, xray } of meshes) {
      expect(hull!.visible).toBe(true);
      expect(xray!.visible).toBe(true);
      expect(hull!.material).toBe(m.hull('shown'));
      expect(xray!.material).toBe(m.xray('shown'));
    }
    // A new team recolours a team outline; the shown player stays white.
    rig.setTeam(3);
    expect(meshes[0].hull!.material).toBe(m.hull('shown'));
    rig.setOutline(true, 2);
    rig.setTeam(3);
    for (const { hull, xray } of meshes) {
      expect(hull!.material).toBe(m.hull(3));
      expect(xray!.material).toBe(m.xray(3));
    }
  });

  it('outlines living players only: a dying body has none', () => {
    const m = new OutlineMaterials();
    const rig = new PlayerRig(template(), 2, undefined, null, m);
    const meshes = outlined(rig, m);
    rig.setOutline(true, 2);
    rig.apply(input({ deathTicks: 10 }), HEADER);
    expect(rig.object.visible).toBe(true);
    for (const { hull, xray } of meshes) {
      expect(hull!.visible).toBe(false);
      expect(xray!.visible).toBe(false);
    }
    rig.apply(input(), HEADER);
    for (const { hull, xray } of meshes) {
      expect(hull!.visible).toBe(true);
      expect(xray!.visible).toBe(true);
    }
    // Off stays off for the living.
    rig.setOutline(false, 2);
    rig.apply(input(), HEADER);
    expect(meshes[0].hull!.visible).toBe(false);
  });

  it('draws the held weapon at the rig order, after the x-ray', async () => {
    const geometry = new THREE.BoxGeometry();
    const cache = new WeaponCache(async () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
      return g;
    });
    cache.get('ak47');
    cache.get('c4');
    await flush();
    const m = new OutlineMaterials();
    const rig = new PlayerRig(template(), 2, undefined, cache, m);
    rig.apply(
      input({ state: { ...input().state, flags: FLAG.alive | FLAG.bomb } }),
      HEADER
    );
    const weapons: THREE.Mesh[] = [];
    rig.object.traverse((o) => {
      if (o.name.startsWith('weapon:'))
        o.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) weapons.push(c as THREE.Mesh);
        });
    });
    // The rifle in hand and the C4 on the back.
    expect(weapons).toHaveLength(2);
    for (const w of weapons) expect(w.renderOrder).toBe(OUTLINE.rigOrder);
  });

  it('a fading body sorts with smoke (order 0), and draws after the x-ray once opaque', async () => {
    const cache = new WeaponCache(async () => {
      const g = new THREE.Group();
      g.add(
        new THREE.Mesh(
          new THREE.BoxGeometry(),
          new THREE.MeshStandardMaterial()
        )
      );
      return g;
    });
    cache.get('ak47');
    await flush();
    const m = new OutlineMaterials();
    const rig = new PlayerRig(template(), 2, undefined, cache, m);
    rig.apply(input(), HEADER); // takes the rifle in hand
    const outlines = new Set<THREE.Object3D>();
    for (const { hull, xray } of outlined(rig, m))
      outlines.add(hull!).add(xray!);
    const orders = () => {
      const out = new Set<number>();
      rig.object.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && !outlines.has(o))
          out.add(o.renderOrder);
      });
      return [...out];
    };
    const outlineOrders = () => [...outlines].map((o) => o.renderOrder).sort();
    let meshes = 0;
    rig.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !outlines.has(o)) meshes++;
    });
    expect(meshes).toBe(3); // body, head and the rifle
    expect(orders()).toEqual([OUTLINE.rigOrder]);

    const rate = HEADER.tick_rate;
    const lying = (DEATH_COLLAPSE_S + 1) * rate;
    const fading = (DEATH_COLLAPSE_S + DEATH_HOLD_S + DEATH_FADE_S / 2) * rate;
    rig.apply(input({ deathTicks: lying }), HEADER);
    expect(rig.opacity).toBe(1);
    expect(orders()).toEqual([OUTLINE.rigOrder]);
    rig.apply(input({ deathTicks: fading }), HEADER);
    expect(rig.opacity).toBeLessThan(1);
    expect(orders()).toEqual([0]);
    // The outlines keep their own orders, hidden on the dying.
    expect(outlineOrders()).toEqual([1, 1, 2, 2]);
    for (const o of outlines) expect(o.visible).toBe(false);
    // Scrubbed back to the body lying opaque, then alive in the next round.
    rig.apply(input({ deathTicks: lying }), HEADER);
    expect(orders()).toEqual([OUTLINE.rigOrder]);
    rig.apply(input({ deathTicks: fading }), HEADER);
    rig.apply(input(), HEADER);
    expect(rig.opacity).toBe(1);
    expect(orders()).toEqual([OUTLINE.rigOrder]);
  });

  it('a rig without outline materials has none', () => {
    const rig = new PlayerRig(template(), 2);
    let meshes = 0;
    rig.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBe(2);
    rig.setOutline(true, 'shown'); // nothing to do
  });
});

describe('RigPool outlines', () => {
  function setup() {
    const pool = new RigPool({ 2: template(), 3: template() }, 3);
    const inputs = [input({ team: 2 }), input({ team: 3 }), input({ team: 3 })];
    pool.drive(inputs, HEADER);
    return { pool, inputs };
  }

  function colours(pool: RigPool, i: number) {
    const out = new Set<string>();
    pool.active(i)!.object.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if ((o as THREE.Mesh).isMesh && mat.side === THREE.BackSide)
        out.add(`${o.visible ? 'on' : 'off'}:${mat.color.getHexString()}`);
    });
    return [...out];
  }

  it('colours every rig by team and the shown player white, or hides them all', () => {
    const { pool } = setup();
    pool.setOutlines(true, 1);
    expect(colours(pool, 0)).toEqual(['on:f2a33a']);
    expect(colours(pool, 1)).toEqual(['on:ffffff']);
    expect(colours(pool, 2)).toEqual(['on:4da3ff']);
    // The followed player changes.
    pool.setOutlines(true, 2);
    expect(colours(pool, 1)).toEqual(['on:4da3ff']);
    expect(colours(pool, 2)).toEqual(['on:ffffff']);
    // Nobody followed.
    pool.setOutlines(true, null);
    expect(colours(pool, 2)).toEqual(['on:4da3ff']);
    pool.setOutlines(false, 1);
    for (const i of [0, 1, 2])
      expect(colours(pool, i)).toEqual([
        `off:${['f2a33a', 'ffffff', '4da3ff'][i]}`,
      ]);
  });

  it('a player who changes sides is outlined in the new team colour', () => {
    const { pool, inputs } = setup();
    pool.setOutlines(true, null);
    expect(colours(pool, 0)).toEqual(['on:f2a33a']);
    inputs[0] = input({ team: 3 });
    pool.drive(inputs, HEADER);
    pool.setOutlines(true, null);
    expect(colours(pool, 0)).toEqual(['on:4da3ff']);
  });

  it('rigs made again for a new look keep their outlines', () => {
    const { pool } = setup();
    pool.setOutlines(true, 0);
    pool.setLook({ lit: true, smoothNormals: true, maxAnisotropy: 1 });
    pool.setOutlines(true, 0);
    expect(colours(pool, 0)).toEqual(['on:ffffff']);
    expect(colours(pool, 1)).toEqual(['on:4da3ff']);
  });
});
