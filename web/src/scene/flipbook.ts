// Flipbook sprites: quads cut from an effect atlas (`effects.ts`), one instance per sprite, so
// an effect's particles are one draw. A batch is filled every frame between `begin` and `end`
// from arrays made when it is built; nothing is allocated while playing or seeking. Which frame
// a sprite shows is the caller's, from `loopFrame` or `onceFrame`, so it stays a function of
// the effect's age.

import * as THREE from 'three';
import type { Atlas } from './effects';

/**
 * The atlas rectangle of `frame` as (u0, v0, du, dv): frame 0 is the top-left cell, frames
 * run along each row (the atlas is uploaded with `flipY`, so its top row is at v = 1).
 */
export function frameRect(
  a: { cols: number; rows: number },
  frame: number,
  out: THREE.Vector4
): THREE.Vector4 {
  const col = frame % a.cols;
  const row = Math.floor(frame / a.cols);
  return out.set(col / a.cols, 1 - (row + 1) / a.rows, 1 / a.cols, 1 / a.rows);
}

/** The frame of looping sequence `seq` ([first, count]) at `seconds`, `phase` (0..1) in. */
export function loopFrame(
  seq: readonly [number, number],
  seconds: number,
  fps: number,
  phase: number
): number {
  const n = seq[1];
  const i = Math.floor(seconds * fps + phase * n);
  return seq[0] + (((i % n) + n) % n);
}

/** The frame of sequence `seq` played once over `life` seconds at `age`; null outside it. */
export function onceFrame(
  seq: readonly [number, number],
  age: number,
  life: number
): number | null {
  if (!(age >= 0) || age >= life) return null;
  return seq[0] + Math.min(seq[1] - 1, Math.floor((age / life) * seq[1]));
}

export interface FlipbookOptions {
  /** `additive` adds light; `premultiplied` covers and adds; `alpha` covers. */
  blending: 'additive' | 'premultiplied' | 'alpha';
  /**
   * `camera` faces the camera; `upright` turns about the vertical only and stands on its
   * point (flames); `surface` lies in the plane of the pushed normal (decals).
   */
  facing: 'camera' | 'upright' | 'surface';
  /** Colours are what the screen should show: divided by the tone mapping's exposure. */
  emissive: boolean;
  /**
   * The atlas's alpha times this, up to 1, before the sprite's own: for frames authored thin
   * (CS2's blood splatter). 1 when left out.
   */
  alphaGain?: number;
  /**
   * A dark core in the middle of each sprite (a bullet hole: CS2 draws a hole's depth from maps
   * this viewer does not have, so its colour frames alone read as flat chips): within `radius` of
   * the cell's middle (a share of its half-width) the colour falls to `shade` of itself at the
   * middle, covering there whatever the frame's alpha. None when left out.
   */
  core?: { radius: number; shade: number };
}

const FACING = { camera: 0, upright: 1, surface: 2 } as const;
const BLEND = { additive: 0, premultiplied: 1, alpha: 2 } as const;

const VERTEX = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aSize;
attribute vec4 aColor;
attribute vec3 aNormal;
uniform vec2 uGrid;
varying vec2 vUv;
varying vec4 vColor;
#ifdef CORE
varying vec2 vCell;
#endif
#include <fog_pars_vertex>
void main() {
  vec3 centre = (modelMatrix * vec4(aCentre, 1.0)).xyz;
  vec2 q = position.xy;
#if FACING == 1
  q.y += 0.5;
#endif
  q *= aSize.xy;
  float c = cos(aSize.z);
  float s = sin(aSize.z);
  q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
#if FACING == 0
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
#elif FACING == 1
  vec3 right = vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]);
  right = length(right) > 1e-3 ? normalize(right) : vec3(1.0, 0.0, 0.0);
  vec3 up = vec3(0.0, 1.0, 0.0);
#else
  vec3 n = normalize(aNormal);
  vec3 right = normalize(cross(abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n));
  vec3 up = cross(n, right);
#endif
  vec4 mvPosition = viewMatrix * vec4(centre + right * q.x + up * q.y, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float frame = mod(floor(aSize.w + 0.5), uGrid.x * uGrid.y);
  float col = mod(frame, uGrid.x);
  float row = floor(frame / uGrid.x);
  vUv = vec2((col + uv.x) / uGrid.x, 1.0 - (row + 1.0 - uv.y) / uGrid.y);
  vColor = aColor;
#ifdef CORE
  vCell = uv;
#endif
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uExposure;
uniform float uAlphaGain;
varying vec2 vUv;
varying vec4 vColor;
#ifdef CORE
uniform vec2 uCore;
varying vec2 vCell;
#endif
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(uMap, vUv);
  vec3 col = t.rgb * vColor.rgb;
  float a = min(1.0, t.a * uAlphaGain) * vColor.a;
#ifdef CORE
  // The dark core: full within 0.4 of the radius, gone at it.
  float k = smoothstep(uCore.x * 0.4, uCore.x, length(vCell - 0.5) * 2.0);
  col *= mix(uCore.y, 1.0, k);
  a = max(a, (1.0 - k) * vColor.a);
#endif
#ifdef EMISSIVE
  // As it should end up on screen: the tone mapping multiplies the exposure back in.
  col /= uExposure;
#endif
  float fogFactor = 0.0;
#ifdef USE_FOG
  #ifdef FOG_EXP2
    fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
#endif
#if BLEND == 0
  // Light fades into the fog rather than turning its colour.
  gl_FragColor = vec4(col * a * (1.0 - fogFactor), a);
#elif BLEND == 1
  gl_FragColor = vec4(mix(col, fogColor, fogFactor) * a, a);
#else
  gl_FragColor = vec4(mix(col, fogColor, fogFactor), a);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Instanced quads cut from one atlas; `push` one per sprite between `begin` and `end`. */
export class FlipbookBatch {
  readonly mesh: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  private readonly capacity: number;
  private readonly centre: THREE.InstancedBufferAttribute;
  private readonly size: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly normal: THREE.InstancedBufferAttribute;
  /**
   * The four attributes, and the update range each uploads (one object each, refilled by
   * `end`): `addUpdateRange` would make a range object per attribute per frame.
   */
  private readonly attributes: readonly THREE.InstancedBufferAttribute[];
  private readonly ranges: { start: number; count: number }[];
  private count = 0;

  constructor(capacity: number, opts: FlipbookOptions) {
    this.capacity = capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    const attr = (name: string, size: number) => {
      const a = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * size),
        size
      ).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.centre = attr('aCentre', 3);
    // Width, height, rotation (radians), frame.
    this.size = attr('aSize', 4);
    this.color = attr('aColor', 4);
    this.normal = attr('aNormal', 3);
    this.attributes = [this.centre, this.size, this.color, this.normal];
    this.ranges = this.attributes.map(() => ({ start: 0, count: 0 }));
    g.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uMap: { value: null },
        uGrid: { value: new THREE.Vector2(1, 1) },
        uExposure: { value: 1 },
        uAlphaGain: { value: opts.alphaGain ?? 1 },
        ...(opts.core
          ? {
              uCore: {
                value: new THREE.Vector2(opts.core.radius, opts.core.shade),
              },
            }
          : {}),
      },
      defines: {
        FACING: FACING[opts.facing],
        BLEND: BLEND[opts.blending],
        ...(opts.emissive ? { EMISSIVE: '' } : {}),
        ...(opts.core ? { CORE: '' } : {}),
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    if (opts.blending === 'alpha') material.blending = THREE.NormalBlending;
    else {
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.AddEquation;
      material.blendSrc = THREE.OneFactor;
      material.blendDst =
        opts.blending === 'additive'
          ? THREE.OneFactor
          : THREE.OneMinusSrcAlphaFactor;
    }
    if (opts.facing === 'surface') {
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -1;
      material.side = THREE.DoubleSide;
    }
    this.mesh = new THREE.Mesh(g, material);
    // The quad's own bounds say nothing of where its instances stand.
    this.mesh.frustumCulled = false;
  }

  /** Draws frames of `atlas`, or the whole of `fallback` (the frame ignored) without one. */
  setAtlas(atlas: Atlas | null, fallback: THREE.Texture): void {
    const u = this.mesh.material.uniforms;
    u.uMap.value = atlas?.texture ?? fallback;
    (u.uGrid.value as THREE.Vector2).set(atlas?.cols ?? 1, atlas?.rows ?? 1);
  }

  setExposure(e: number): void {
    this.mesh.material.uniforms.uExposure.value = e;
  }

  begin(): void {
    this.count = 0;
  }

  /**
   * One sprite at (x, y, z), scene metres: `w` × `h` metres, turned `rotation` radians in its
   * plane, showing `frame` of the atlas in `color` × `alpha`; (nx, ny, nz) is a `surface`
   * sprite's normal. False when the batch is full.
   */
  push(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    rotation: number,
    frame: number,
    color: THREE.Color,
    alpha: number,
    nx = 0,
    ny = 1,
    nz = 0
  ): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.centre.setXYZ(i, x, y, z);
    this.size.setXYZW(i, w, h, rotation, frame);
    this.color.setXYZW(i, color.r, color.g, color.b, alpha);
    this.normal.setXYZ(i, nx, ny, nz);
    return true;
  }

  /**
   * Draws the sprites pushed since `begin`, uploading only those, and shows the batch only when
   * there are any: none is uploaded, nor drawn, when there are none. Allocates nothing: the
   * attributes and their ranges are the batch's own.
   */
  end(): void {
    const n = this.count;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (let i = 0; i < this.attributes.length; i++) {
      const a = this.attributes[i];
      const r = this.ranges[i];
      r.start = 0;
      r.count = n * a.itemSize;
      a.updateRanges.length = 0;
      a.updateRanges.push(r);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
