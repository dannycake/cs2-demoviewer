// A molotov's fire: flames that flicker and lick, drawn as one instanced mesh per fire (each
// flame a quad that turns about the vertical to face the camera), catching from the middle
// outwards over the first `spreadS`, and a column of dark smoke rising off it. The flames are
// CS2's own (`fire_burning_character`, from the effect atlases), each looping one of the sheet's
// sequences, with a `fire_small_sim_b` burst played once as each flame catches; until the atlas
// arrives, or without one, a noise shader draws them. The smoke column's puffs are frames of
// CS2's smoke (`smokeloop_i_0_sc_hardedge`) once that atlas is in, the generated puff before.
// Everything is a function of the fire's age, so seeking shows the same frame as playing.

import * as THREE from 'three';
import type { Atlas } from './effects';
import { seeded } from '../sim/random';
import { hash01 } from './noise';

export const FLAMES = {
  /** The tallest flames, metres (in the middle of the fire). */
  height: 1.8,
  /** How long the fire takes to catch from its middle to its edge. */
  spreadS: 0.6,
  smokePuffs: 12,
  /** One smoke puff's rise, from the flames to where it is gone. */
  smokeLifeS: 2.8,
  /** When the smoke starts, after the fire does. */
  smokeStartS: 0.4,
  /** Height the smoke starts at and how far it rises, metres. */
  smokeBase: 0.6,
  smokeRise: 4.5,
  /** How far the wind carries a puff over its life, metres. */
  smokeDrift: 0.9,
  smokeOpacity: 0.42,
  /**
   * Frames a second of the flames' flipbook: a sequence of 11 to 25 frames is one tongue of
   * flame over 0.55–1.25 s, about the 0.65–1.2 s CS2 gives each (molotov_groundfire_main).
   */
  fps: 20,
  /** How long a flame's burst plays as it catches. */
  burstS: 1.0,
  /** A burst's height over its flame's. */
  burstScale: 1.4,
  /**
   * A flame's quad from the atlas over the layout's height: a frame fills its cell only at its
   * sequence's largest, so the quad is drawn larger for the flame to stand as tall.
   */
  atlasScale: 1.25,
  /** Its width over the cell's aspect, so neighbouring flames merge into one sheet of fire. */
  atlasWidth: 1.5,
  /** How much brighter than its sheet a flame burns (CS2's overbright factor). */
  gain: 2.0,
  /** How much of what is behind a flame it covers; the rest of its light is added. */
  cover: 0.7,
} as const;

export interface FlameLayout {
  /** Per flame: x, 0, z in the fire's frame, metres. */
  offsets: Float32Array;
  /** Per flame: width, height (metres) and a 0..1 seed for its own flicker. */
  shapes: Float32Array;
  /** Per flame: seconds after the fire starts that it catches. */
  delays: Float32Array;
}

/** Where `count` flames stand in a fire of `radius`, and when each catches; fixed by `seed`. */
export function flameLayout(
  seed: number,
  count: number,
  radius: number,
  out?: FlameLayout
): FlameLayout {
  const l = out ?? {
    offsets: new Float32Array(count * 3),
    shapes: new Float32Array(count * 3),
    delays: new Float32Array(count),
  };
  const rand = seeded(seed);
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radius * 0.95;
    const centre = 1 - r / radius;
    l.offsets[i * 3] = Math.cos(a) * r;
    l.offsets[i * 3 + 1] = 0;
    l.offsets[i * 3 + 2] = Math.sin(a) * r;
    // Wide enough to overlap their neighbours into one sheet of fire, and of very different
    // heights, so no row of even spikes shows.
    l.shapes[i * 3] = 0.6 + 0.6 * rand();
    l.shapes[i * 3 + 1] =
      FLAMES.height * (0.45 + 0.55 * centre) * (0.35 + 0.65 * rand() ** 0.7);
    l.shapes[i * 3 + 2] = rand();
    l.delays[i] = FLAMES.spreadS * (r / radius) * (0.75 + 0.25 * rand());
  }
  return l;
}

export interface SmokePuff {
  x: number;
  y: number;
  z: number;
  scale: number;
  opacity: number;
  /** The frame of the smoke atlas it draws; 0 without one (the generated puff, drawn whole). */
  frame: number;
}

/**
 * Smoke puff `i` of `count` over a fire of `radius` that has burned `age` seconds: it starts
 * among the flames, rises `smokeRise` over `smokeLifeS` while the wind (fixed by `seed`)
 * carries it, grows, and fades in and out; then it starts again somewhere else. Given the
 * `smoke` atlas, each rise draws one of its frames, chosen as the place is.
 */
export function fireSmokePuff(
  age: number,
  i: number,
  count: number,
  seed: number,
  radius: number,
  out: SmokePuff,
  smoke?: Pick<Atlas, 'frames'> | null
): SmokePuff {
  const local = age - FLAMES.smokeStartS;
  out.frame = 0;
  if (!(local > 0)) {
    out.x = out.z = 0;
    out.y = FLAMES.smokeBase;
    out.scale = 1;
    out.opacity = 0;
    return out;
  }
  const t = local / FLAMES.smokeLifeS + i / count;
  const cycle = Math.floor(t);
  const phase = t - cycle;
  const key = seed * 0.618 + i * 12.9898 + cycle * 78.233;
  const a = hash01(key) * Math.PI * 2;
  const r = Math.sqrt(hash01(key + 1.7)) * radius * 0.6;
  const wind = hash01(seed * 3.1 + 0.5) * Math.PI * 2;
  out.x = Math.cos(a) * r + Math.cos(wind) * FLAMES.smokeDrift * phase;
  out.z = Math.sin(a) * r + Math.sin(wind) * FLAMES.smokeDrift * phase;
  out.y = FLAMES.smokeBase + FLAMES.smokeRise * phase;
  out.scale = 1.2 + 3 * phase;
  out.opacity =
    FLAMES.smokeOpacity * Math.sin(Math.PI * phase) * Math.min(1, local / 1);
  if (smoke)
    out.frame = Math.min(
      smoke.frames - 1,
      Math.floor(hash01(key + 3.3) * smoke.frames)
    );
  return out;
}

const VERTEX = /* glsl */ `
attribute vec3 aOffset;
attribute vec3 aShape;
attribute float aDelay;
uniform float uTime;
uniform float uStrength;
varying vec2 vUv;
varying float vSeed;
void main() {
  float grow = clamp((uTime - aDelay) / 0.35, 0.0, 1.0);
  float flicker = 0.8 + 0.2 * sin(uTime * (5.0 + aShape.z * 4.0) + aShape.z * 40.0);
  float h = aShape.y * grow * uStrength * flicker;
  float w = aShape.x * (0.5 + 0.5 * grow);
  vec3 centre = (modelMatrix * vec4(aOffset, 1.0)).xyz;
  // Turn about the vertical to face the camera: the camera's right, flattened.
  vec3 right = vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]);
  right = length(right) > 1e-3 ? normalize(right) : vec3(1.0, 0.0, 0.0);
  vec3 world = centre + right * (position.x * w) + vec3(0.0, position.y * h, 0.0);
  vUv = uv;
  vSeed = aShape.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uExposure;
varying vec2 vUv;
varying float vSeed;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  // Turbulence scrolling up the flame, so its tongues rise, lick and split.
  float t = uTime * 1.7 + vSeed * 17.0;
  float n = fbm(vec2(vUv.x * 3.5 + vSeed * 9.0, vUv.y * 2.4 - t));
  float m = fbm(vec2(vUv.x * 7.0 - vSeed * 5.0, vUv.y * 4.0 - t * 1.6));
  float x = (vUv.x - 0.5) * 2.0 + (n - 0.5) * 1.4 * vUv.y;
  // Full width low down, so neighbouring flames merge into one burning carpet.
  float width = mix(1.0, 0.04, pow(vUv.y, 0.6));
  float body = 1.0 - smoothstep(width * 0.35, width, abs(x));
  // Hot at the base and the middle; the noise eats holes and ragged tips into it.
  float heat = body * (1.1 - vUv.y) + (n - 0.45) * 0.8 + (m - 0.5) * 0.35;
  float alpha = smoothstep(0.06, 0.45, heat) * smoothstep(0.0, 0.05, vUv.y);
  // Colours as they should end up on screen (linear, under the tone curve's knee, where it
  // keeps hue and saturation), divided by the exposure the tone mapping will multiply in.
  vec3 deep = vec3(0.45, 0.06, 0.01);
  vec3 orange = vec3(0.76, 0.25, 0.02);
  vec3 yellow = vec3(0.78, 0.55, 0.14);
  vec3 col = mix(deep, orange, smoothstep(0.12, 0.45, heat));
  col = mix(col, yellow, smoothstep(0.6, 1.0, heat));
  // The tips cool to a sooty red.
  col = mix(col, vec3(0.25, 0.04, 0.01), smoothstep(0.55, 1.0, vUv.y) * 0.55);
  // Premultiplied: a flame covers what is behind it.
  gl_FragColor = vec4(col / uExposure * alpha, alpha * 0.95);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * The flames' material: premultiplied blending (it covers and adds light), no depth writes;
 * `uTime` is the fire's age in seconds, `uStrength` its fade in and out, `uExposure` the tone
 * mapping's exposure, which the colours are divided by so they show as chosen on every map.
 */
export function flameMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uExposure: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

/** A quad per flame, 1 m wide and 1 m tall from its foot, with the layout's attributes. */
export function flameGeometry(count: number): THREE.InstancedBufferGeometry {
  const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.getAttribute('position'));
  g.setAttribute('uv', quad.getAttribute('uv'));
  g.setAttribute(
    'aOffset',
    new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
  );
  g.setAttribute(
    'aShape',
    new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
  );
  g.setAttribute(
    'aDelay',
    new THREE.InstancedBufferAttribute(new Float32Array(count), 1)
  );
  // The atlas sequence each flame plays: first frame, frame count.
  g.setAttribute(
    'aSeq',
    new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2)
  );
  g.instanceCount = count;
  return g;
}

/** Gives flame `i` of a geometry made by `flameGeometry` sequence `i` mod their count. */
export function setFlameSequences(
  g: THREE.InstancedBufferGeometry,
  sequences: readonly (readonly [number, number])[]
): void {
  const a = g.getAttribute('aSeq') as THREE.InstancedBufferAttribute;
  if (sequences.length === 0) return;
  for (let i = 0; i < a.count; i++) {
    const s = sequences[i % sequences.length];
    a.setXY(i, s[0], s[1]);
  }
  a.needsUpdate = true;
}

const ATLAS_VERTEX = /* glsl */ `
attribute vec3 aOffset;
attribute vec3 aShape;
attribute float aDelay;
attribute vec2 aSeq;
uniform float uTime;
uniform float uStrength;
uniform float uFps;
uniform float uLife;
uniform float uAspect;
uniform float uScale;
uniform float uWidth;
uniform vec2 uGrid;
varying vec2 vUv0;
varying vec2 vUv1;
varying float vBlend;
varying float vFade;
varying vec3 vTint;
float hash1(float n) { return fract(sin(n) * 43758.5453); }
// Frame 0 is the atlas's top-left cell (the atlas is uploaded with flipY).
vec2 cellUv(float frame, vec2 uv) {
  float col = mod(frame, uGrid.x);
  float row = floor(frame / uGrid.x);
  return vec2((col + uv.x) / uGrid.x, 1.0 - (row + 1.0 - uv.y) / uGrid.y);
}
void main() {
  float local = uTime - aDelay;
  float n = max(aSeq.y, 1.0);
  float size = 1.0;
  vec2 jitter = vec2(0.0);
  float rise = 0.0;
#ifdef ONCE
  float p = local / uLife;
  if (p < 0.0 || p >= 1.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float f = p * n;
  float i0 = min(floor(f), n - 1.0);
  float i1 = min(i0 + 1.0, n - 1.0);
#else
  // One lap of its sequence is one tongue of flame licking up and dying away; the next lap
  // starts from a spot near the flame's root and at its own size, as a new particle would.
  float f = max(local, 0.0) * uFps + aShape.z * n;
  float lap = floor(f / n);
  float i0 = mod(floor(f), n);
  float i1 = mod(i0 + 1.0, n);
  float k = aShape.z * 91.7 + lap * 13.37;
  jitter = (vec2(hash1(k), hash1(k + 4.1)) - 0.5) * 0.5;
  size = (0.8 + 0.4 * hash1(k + 7.3)) * clamp(local / 0.35, 0.0, 1.0);
  rise = 0.1 * fract(f / n);
#endif
  vBlend = fract(f);
  vUv0 = cellUv(aSeq.x + i0, uv);
  vUv1 = cellUv(aSeq.x + i1, uv);
  vFade = uStrength;
  // CS2's flame tints, the yellower of molotov_groundfire_main's (239 216 135) to the oranger
  // of molotov_child_flame01a's (235 172 95), linear: its paler ones read as cream in daylight.
  vTint = mix(vec3(0.86, 0.69, 0.24), vec3(0.83, 0.41, 0.11), hash1(aShape.z * 57.1));
  float h = aShape.y * uScale * size * (0.6 + 0.4 * uStrength);
  float w = h * uAspect * uWidth * (0.8 + 0.4 * aShape.z);
  vec3 centre = (modelMatrix * vec4(aOffset + vec3(jitter.x, 0.0, jitter.y), 1.0)).xyz;
  // Turn about the vertical to face the camera: the camera's right, flattened.
  vec3 right = vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]);
  right = length(right) > 1e-3 ? normalize(right) : vec3(1.0, 0.0, 0.0);
  vec3 world = centre + right * (position.x * w) + vec3(0.0, (position.y + rise) * h, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const ATLAS_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uExposure;
uniform float uGain;
uniform float uCover;
varying vec2 vUv0;
varying vec2 vUv1;
varying float vBlend;
varying float vFade;
varying vec3 vTint;
#ifdef ONCE
// The burst's sheet is orange already; overbright, the tone curve would bleach it pink. Its
// brightness picks a colour from deep red through orange to cream instead, each under the
// curve's knee (where it keeps hue), as it should end up on screen.
vec3 heat(float v) {
  vec3 c = mix(vec3(0.35, 0.05, 0.01), vec3(0.76, 0.25, 0.02), smoothstep(0.2, 0.45, v));
  c = mix(c, vec3(0.8, 0.5, 0.1), smoothstep(0.45, 0.7, v));
  c = mix(c, vec3(0.85, 0.7, 0.3), smoothstep(0.7, 0.9, v));
  return mix(c, vec3(1.0, 0.9, 0.7), smoothstep(0.9, 1.0, v));
}
#endif
void main() {
  // Between two frames of the flipbook, so the flame moves rather than steps.
  vec4 t = mix(texture2D(uMap, vUv0), texture2D(uMap, vUv1), vBlend);
  // A little denser than the sheet: CS2 stacks many more flames than the 64 drawn here.
  float alpha = min(1.0, t.a * 1.3) * vFade;
  if (alpha < 0.004) discard;
#ifdef ONCE
  vec3 col = heat(pow(dot(t.rgb, vec3(0.2126, 0.7152, 0.0722)), 1.0 / 2.2)) / uExposure;
#else
  // CS2 tints its flames and overbrights them; the tone curve then turns the hottest parts
  // yellow-white and leaves the rest orange. Divided by the exposure the tone mapping will
  // multiply in, so they look the same on every map.
  vec3 col = t.rgb * vTint * uGain / uExposure;
#endif
  // Premultiplied, covering only part of what is behind: the rest is light added to it.
  gl_FragColor = vec4(col * alpha, alpha * uCover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Flames drawn from `atlas`: `loop` plays each flame's sequence (`aSeq`) round and round at
 * `fps` from its catch, `once` plays it once over `burstS` from its catch (a burst), `burstScale`
 * times as tall. Uniforms as `flameMaterial`'s (`uTime` the fire's age, `uStrength` its fade,
 * `uExposure` divided out), with the atlas's grid and cell aspect. Premultiplied blending, no
 * depth writes.
 */
export function flameAtlasMaterial(
  atlas: Atlas,
  mode: 'loop' | 'once'
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uExposure: { value: 1 },
      uMap: { value: atlas.texture },
      uGrid: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
      uFps: { value: FLAMES.fps },
      uLife: { value: FLAMES.burstS },
      uAspect: { value: atlas.aspect },
      uScale: {
        value: mode === 'once' ? FLAMES.burstScale : FLAMES.atlasScale,
      },
      uWidth: { value: FLAMES.atlasWidth },
      uGain: { value: FLAMES.gain },
      uCover: { value: FLAMES.cover },
    },
    defines: mode === 'once' ? { ONCE: '' } : {},
    vertexShader: ATLAS_VERTEX,
    fragmentShader: ATLAS_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Writes `layout` into a geometry made by `flameGeometry`. */
export function setFlameLayout(
  g: THREE.InstancedBufferGeometry,
  layout: FlameLayout
): void {
  const set = (name: string, data: Float32Array) => {
    const a = g.getAttribute(name) as THREE.InstancedBufferAttribute;
    (a.array as Float32Array).set(data);
    a.needsUpdate = true;
  };
  set('aOffset', layout.offsets);
  set('aShape', layout.shapes);
  set('aDelay', layout.delays);
}
