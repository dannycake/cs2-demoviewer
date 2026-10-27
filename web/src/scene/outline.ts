// Team outlines through walls, as CS2's spectator view draws them: every mesh of a player rig
// gets two siblings on the same geometry and skeleton.
// - The x-ray, a flat colour drawn only where the world hides the player: depth-tested
//   GreaterDepth, writing no depth, at render order 1, after the world (0) and before the
//   players (2), so it compares against the world's depth alone. The player then draws over it
//   wherever it is seen.
// - The hull, its back faces pushed out `widthPx` in screen space after skinning, drawn with
//   the players and depth-tested: a rim around the parts that are seen.
// Neither writes depth (the AO reads the scene's depth, so they leave no halo) nor casts or
// takes a shadow. Each takes its team colour; the followed player's is white.

import * as THREE from 'three';
import { attachHook, replaceOnce } from './hooks';
import { TEAM_HEX } from './colors';
import type { Team } from './PlayerRig';

export const OUTLINE = Object.freeze({
  /** The hull's rim, in CSS pixels. */
  widthPx: 2,
  /** The x-ray's render order: after the world, before the players. */
  xrayOrder: 1,
  /** The players', their held weapons' and the hulls' render order. */
  rigOrder: 2,
  /** The colour of the followed player. */
  shownColor: 0xffffff,
});

/** A team's colour, or the followed player's white. */
export type OutlineColor = Team | 'shown';

const COLORS: readonly OutlineColor[] = [2, 3, 'shown'];

function colorOf(c: OutlineColor): number {
  return c === 'shown' ? OUTLINE.shownColor : TEAM_HEX[c];
}

/**
 * The hull's push, after `project_vertex` (so after skinning). MeshBasicMaterial computes
 * `transformedNormal` only with skinning or an environment map: for a plain mesh the chunk
 * makes it. A BackSide material defines FLIP_SIDED, which turns `transformedNormal` inwards;
 * the push turns it back, or the hull would shrink by `widthPx` instead of growing.
 */
const HULL_PUSH = /* glsl */ `#include <project_vertex>
#ifndef USE_SKINNING
#include <beginnormal_vertex>
#include <defaultnormal_vertex>
#endif
{
#ifdef FLIP_SIDED
  vec3 outward = -transformedNormal;
#else
  vec3 outward = transformedNormal;
#endif
  vec2 n = normalize((projectionMatrix * vec4(outward, 0.0)).xy);
  gl_Position.xy += n * uOutlinePx * 2.0 / uViewport * gl_Position.w;
}`;

const HULL_UNIFORMS = /* glsl */ `#include <common>
uniform float uOutlinePx;
uniform vec2 uViewport;`;

/** The six outline materials of a rig pool (x-ray and hull, per colour), shared by every rig. */
export class OutlineMaterials {
  private readonly hulls = new Map<OutlineColor, THREE.MeshBasicMaterial>();
  private readonly xrays = new Map<OutlineColor, THREE.MeshBasicMaterial>();
  /** Shared by every hull's program, so `setViewport` reaches them all. */
  private readonly uniforms = {
    uOutlinePx: { value: OUTLINE.widthPx },
    uViewport: { value: new THREE.Vector2(1, 1) },
  };

  constructor() {
    const uniforms = this.uniforms;
    for (const c of COLORS) {
      const hull = new THREE.MeshBasicMaterial({
        color: colorOf(c),
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      hull.name = `outline-hull-${c}`;
      attachHook(hull, 'outline', {
        key: 'outline',
        edit(shader) {
          shader.uniforms.uOutlinePx = uniforms.uOutlinePx;
          shader.uniforms.uViewport = uniforms.uViewport;
          const v = replaceOnce(
            shader.vertexShader,
            '#include <common>',
            HULL_UNIFORMS
          );
          shader.vertexShader = replaceOnce(
            v,
            '#include <project_vertex>',
            HULL_PUSH
          );
        },
      });
      this.hulls.set(c, hull);
      const xray = new THREE.MeshBasicMaterial({
        color: colorOf(c),
        depthFunc: THREE.GreaterDepth,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      xray.name = `outline-xray-${c}`;
      this.xrays.set(c, xray);
    }
  }

  /** The rim drawn around the seen parts of a player. */
  hull(c: OutlineColor): THREE.MeshBasicMaterial {
    return this.hulls.get(c)!;
  }

  /** The flat colour drawn over the hidden parts of a player. */
  xray(c: OutlineColor): THREE.MeshBasicMaterial {
    return this.xrays.get(c)!;
  }

  /** The canvas's size in CSS pixels, which `widthPx` is measured in. */
  setViewport(width: number, height: number): void {
    this.uniforms.uViewport.value.set(Math.max(1, width), Math.max(1, height));
  }

  dispose(): void {
    for (const m of this.hulls.values()) m.dispose();
    for (const m of this.xrays.values()) m.dispose();
  }
}

/**
 * The hull and x-ray of `mesh` in `team`'s colour: siblings under its parent (inside the rig's
 * object, so hiding the rig hides them), at its place, on its geometry, and on its skeleton,
 * bind matrix and morph weights when it has them. They cast and take no shadow.
 */
export function outlineMeshes(
  mesh: THREE.Mesh,
  m: OutlineMaterials,
  team: Team
): { hull: THREE.Mesh; xray: THREE.Mesh } {
  const make = (material: THREE.Material, order: number, kind: string) => {
    const src = mesh as THREE.SkinnedMesh;
    let o: THREE.Mesh;
    if (src.isSkinnedMesh) {
      const s = new THREE.SkinnedMesh(mesh.geometry, material);
      s.bindMode = src.bindMode;
      s.bind(src.skeleton, src.bindMatrix);
      o = s;
    } else o = new THREE.Mesh(mesh.geometry, material);
    if (mesh.morphTargetInfluences)
      o.morphTargetInfluences = mesh.morphTargetInfluences;
    o.name = `${mesh.name}:outline-${kind}`;
    o.position.copy(mesh.position);
    o.quaternion.copy(mesh.quaternion);
    o.scale.copy(mesh.scale);
    o.renderOrder = order;
    o.castShadow = false;
    o.receiveShadow = false;
    // A skinned mesh's bounds are its bind pose; a rig's meshes are never culled, nor these.
    o.frustumCulled = false;
    mesh.parent?.add(o);
    return o;
  };
  return {
    hull: make(m.hull(team), OUTLINE.rigOrder, 'hull'),
    xray: make(m.xray(team), OUTLINE.xrayOrder, 'xray'),
  };
}
