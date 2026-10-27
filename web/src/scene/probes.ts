// CS2's light grid on the players (tools/README.md, "Light grid"; tools/lib/probes.mjs): a
// dense grid of cells 2.5 m apart over the map, each holding CS2's probe cube as the light from
// above (its +Y face), from below (−Y) and from the side (the mean of its four sides), and how
// much of the sun reaches it, in the bake's units (a Lambert without π, as the lightmap). A
// player, their weapons and the first-person arms take their ambient light from the grid at the
// player's chest in place of the hemisphere light: up·max(n.y, 0)² + down·max(−n.y, 0)² +
// side·(1 − n.y²) for a unit normal n, as CS2 weighs its cube faces (Σ n_axis² · face). The sun
// reaches them past the shadow maps (Lighting: the world's and the players'), or by the
// sample's `sun` where there is no shadow map: the grid's at `low`, and for the first-person
// arms, drawn without one, whether the eye sees the sun past the hull (Scene).
//
// probes.bin (tools/lib/probes.mjs `encodeLightGrid`), little-endian:
//   0  'DVLG'           20  f32 step (m)              32  f32 range
//   4  u16 version = 2  24  3 × u16 nx, ny, nz        36  10 B per cell, (x, y, z) at
//   8  3 × f32 origin   30  u16 0                         x + nx·(y + ny·z)
// The origin is cell (0, 0, 0)'s centre in scene metres; y is up. A cell is up R G B, down
// R G B, side R G B, sun: light bytes are sqrt(light / range) (light = (b / 255)² · range), the
// sun's is linear (b / 255). Every cell holds real light: cells outside the probe volumes copy
// the nearest one inside. Version 1 (146d893–4ef350d, a stale asset set) is read too: 8 B per
// cell, up R G B, down R G B, sun, 0, with no side, which is taken as the mean of up and down,
// the light that version gave a surface facing sideways.

import * as THREE from 'three';
import {
  attachHook,
  detachHook,
  directionalPastEveryShadow,
  hookIn,
  lightsBegin,
  replaceOnce,
  type ShaderHook,
} from './hooks';

/** probes.bin as read (`parseLightGrid`): the header, and the cells as stored. */
export interface LightGrid {
  /** Cell (0, 0, 0)'s centre, scene metres. */
  origin: [number, number, number];
  /** Metres between cell centres. */
  step: number;
  /** Cells along x, y (up) and z. */
  size: [number, number, number];
  /** The light a byte of 255 holds. */
  range: number;
  /** probes.bin's version: 2, or 1 (no side; see above). */
  version: 1 | 2;
  /** The cells as stored: 10 bytes each (version 1: 8). */
  cells: Uint8Array;
}

/** The grid's light at a point, in linear light in the bake's units. */
export interface ProbeSample {
  /** The light from above. */
  up: THREE.Color;
  /** The light from below. */
  down: THREE.Color;
  /** The light from the side. */
  side: THREE.Color;
  /** How much of the sun reaches the point, 0..1. */
  sun: number;
}

const MAGIC = 'DVLG';
const HEADER = 36;
/** Bytes per cell of each version read. */
const CELL = { 1: 8, 2: 10 } as const;

/**
 * probes.bin's bytes as a LightGrid. Throws, as tools/lib/probes.mjs `decodeLightGrid` does, on
 * a buffer shorter than its header, a bad magic or a version other than 1 or 2, a header no
 * encode writes (a size below 1, a step or range not above 0, an origin not finite), or a length
 * the header does not say.
 */
export function parseLightGrid(buf: ArrayBuffer): LightGrid {
  if (buf.byteLength < HEADER)
    throw new Error(
      `light grid of ${buf.byteLength} bytes is shorter than its ${HEADER}-byte header`
    );
  const v = new DataView(buf);
  let magic = '';
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(v.getUint8(i));
  if (magic !== MAGIC) throw new Error('not a light grid: bad magic');
  const version = v.getUint16(4, true);
  if (version !== 1 && version !== 2)
    throw new Error(`light grid version ${version}, not 1 or 2`);
  const cell = CELL[version];
  const origin: [number, number, number] = [
    v.getFloat32(8, true),
    v.getFloat32(12, true),
    v.getFloat32(16, true),
  ];
  const step = v.getFloat32(20, true);
  const size: [number, number, number] = [
    v.getUint16(24, true),
    v.getUint16(26, true),
    v.getUint16(28, true),
  ];
  const range = v.getFloat32(32, true);
  if (!origin.every(Number.isFinite))
    throw new Error(`light grid origin ${origin.join(',')} is not finite`);
  if (!(step > 0)) throw new Error(`light grid step ${step} is not above 0`);
  if (!(range > 0)) throw new Error(`light grid range ${range} is not above 0`);
  if (size.some((s) => s < 1))
    throw new Error(`light grid size ${size.join('×')} has no cells`);
  const n = size[0] * size[1] * size[2];
  if (buf.byteLength !== HEADER + cell * n)
    throw new Error(
      `light grid length ${buf.byteLength}, not ${HEADER + cell * n} for ${size.join('×')} cells of version ${version}`
    );
  return {
    origin,
    step,
    size,
    range,
    version,
    cells: new Uint8Array(buf, HEADER),
  };
}

/** A sample to fill (`sampleLightGrid`): no light, no sun. */
export function makeProbeSample(): ProbeSample {
  return {
    up: new THREE.Color(0, 0, 0),
    down: new THREE.Color(0, 0, 0),
    side: new THREE.Color(0, 0, 0),
    sun: 0,
  };
}

// The cells around a point and its weights along each axis, reused by every sample.
const lo = new Int32Array(3);
const hi = new Int32Array(3);
const frac = new Float64Array(3);

/**
 * `g`'s light at `p` (scene metres) into `out`, which it returns: trilinear between the eight
 * cell centres around it, with `p` clamped into the grid (so a point beyond an end, or one that
 * is not a number, takes the nearest cells: never no light where they have it). Each cell's
 * light is decoded to linear light before it is weighed: the bytes are its square root, and the
 * grid sets bright cells beside dark ones at the probe volumes' borders, so a mean of bytes
 * would read up to a stop too dark between them. A version 1 grid's side is the mean of its up
 * and down. Allocates nothing.
 */
export function sampleLightGrid(
  g: LightGrid,
  p: THREE.Vector3,
  out: ProbeSample
): ProbeSample {
  const { origin, step, size, range, cells } = g;
  const v1 = g.version === 1;
  const stride = CELL[g.version];
  for (let a = 0; a < 3; a++) {
    const last = size[a] - 1;
    let f = (p.getComponent(a) - origin[a]) / step;
    // NaN fails both tests and lands on cell 0.
    if (!(f > 0)) f = 0;
    else if (f > last) f = last;
    const i = Math.floor(f);
    lo[a] = i;
    hi[a] = Math.min(last, i + 1);
    frac[a] = f - i;
  }
  let ur = 0;
  let ug = 0;
  let ub = 0;
  let dr = 0;
  let dg = 0;
  let db = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sun = 0;
  const scale = range / (255 * 255);
  for (let k = 0; k < 8; k++) {
    const x = k & 1;
    const y = (k >> 1) & 1;
    const z = (k >> 2) & 1;
    const w =
      (x ? frac[0] : 1 - frac[0]) *
      (y ? frac[1] : 1 - frac[1]) *
      (z ? frac[2] : 1 - frac[2]);
    if (w === 0) continue;
    const cell =
      (x ? hi[0] : lo[0]) +
      size[0] * ((y ? hi[1] : lo[1]) + size[1] * (z ? hi[2] : lo[2]));
    const o = stride * cell;
    const lw = w * scale;
    ur += lw * cells[o] * cells[o];
    ug += lw * cells[o + 1] * cells[o + 1];
    ub += lw * cells[o + 2] * cells[o + 2];
    dr += lw * cells[o + 3] * cells[o + 3];
    dg += lw * cells[o + 4] * cells[o + 4];
    db += lw * cells[o + 5] * cells[o + 5];
    if (v1) {
      sun += (w * cells[o + 6]) / 255;
      continue;
    }
    sr += lw * cells[o + 6] * cells[o + 6];
    sg += lw * cells[o + 7] * cells[o + 7];
    sb += lw * cells[o + 8] * cells[o + 8];
    sun += (w * cells[o + 9]) / 255;
  }
  out.up.r = ur;
  out.up.g = ug;
  out.up.b = ub;
  out.down.r = dr;
  out.down.g = dg;
  out.down.b = db;
  if (v1) {
    sr = (ur + dr) / 2;
    sg = (ug + dg) / 2;
    sb = (ub + db) / 2;
  }
  out.side.r = sr;
  out.side.g = sg;
  out.side.b = sb;
  out.sun = sun;
  return out;
}

/** The world's up, for a material drawn in the world's own frame. */
export const WORLD_UP: Readonly<THREE.Vector3> = Object.freeze(
  new THREE.Vector3(0, 1, 0)
);

/** What a material's probe uniforms read: its sample, and the world's up in its frame. */
interface ProbeBinding {
  sample: ProbeSample;
  zenith: Readonly<THREE.Vector3>;
}
const bindings = new WeakMap<THREE.Material, ProbeBinding>();

/**
 * Where the player stands in the sun: past every directional shadow map at once (the world's and
 * the players', where the shadow is split), or by the light grid's sun without one.
 */
const DIR_PROBED = directionalPastEveryShadow('probeSunSeen', 'probeSun');

/** The grid's light in place of the ambient, light-probe and hemisphere light. */
const INDIRECT_PROBED = /* glsl */ `#if defined( RE_IndirectDiffuse )

	vec3 iblIrradiance = vec3( 0.0 );

	// CS2's light grid at the player, weighed by the square of the normal along each term as CS2
	// weighs its cube faces (up, down, and the four sides as one); a Lambert without π, which
	// three's 1/π takes back out.
	float probeY = dot( geometryNormal, normalize( ( viewMatrix * vec4( probeZenith, 0.0 ) ).xyz ) );
	float probeAbove = max( probeY, 0.0 );
	float probeBelow = max( - probeY, 0.0 );
	vec3 probeLight = probeUp * ( probeAbove * probeAbove ) + probeDown * ( probeBelow * probeBelow ) + probeSide * ( 1.0 - probeY * probeY );
	vec3 irradiance = PI * probeLight;

#endif

`;

let probedBegin: string | null = null;

/** The one hook every probed material shares; each reads its own binding. */
const PROBE_HOOK: ShaderHook = {
  key: 'probe',
  edit(shader, material) {
    const b = bindings.get(material);
    if (!b) throw new Error('probe hook on a material with no sample');
    // Read through `b` on every draw: a new sample or up needs no recompile.
    shader.uniforms.probeUp = {
      get value() {
        return b.sample.up;
      },
    };
    shader.uniforms.probeDown = {
      get value() {
        return b.sample.down;
      },
    };
    shader.uniforms.probeSide = {
      get value() {
        return b.sample.side;
      },
    };
    shader.uniforms.probeSun = {
      get value() {
        return b.sample.sun;
      },
    };
    shader.uniforms.probeZenith = {
      get value() {
        return b.zenith;
      },
    };
    probedBegin ??= lightsBegin(DIR_PROBED, INDIRECT_PROBED);
    let f = shader.fragmentShader;
    f = replaceOnce(
      f,
      '#include <common>',
      `#include <common>
uniform vec3 probeUp;
uniform vec3 probeDown;
uniform vec3 probeSide;
uniform float probeSun;
uniform vec3 probeZenith;`
    );
    f = replaceOnce(f, '#include <lights_fragment_begin>', probedBegin);
    shader.fragmentShader = f;
  },
};

/**
 * Lights material `m` (a player's, their weapons' or the viewmodel's) by `s`, read on every
 * draw, so `s` is filled in place each frame (`sampleLightGrid`): the hemisphere term becomes
 * up·max(n.y, 0)² + down·max(−n.y, 0)² + side·(1 − n.y²) with n.y the normal along `zenith` (the
 * world's up in the frame `m` is drawn in), and the sun is scaled by the shadow maps or, without
 * one, by `s.sun`.
 * Attaching again, with this sample or another, recompiles nothing.
 */
export function attachProbe(
  m: THREE.MeshLambertMaterial,
  s: ProbeSample,
  zenith: Readonly<THREE.Vector3> = WORLD_UP
): void {
  const b = bindings.get(m);
  if (b) {
    b.sample = s;
    b.zenith = zenith;
  } else bindings.set(m, { sample: s, zenith });
  if (hookIn(m, 'probe') !== PROBE_HOOK) attachHook(m, 'probe', PROBE_HOOK);
}

/** Lights `m` by the scene's sky light again; one without the probe is left as it is. */
export function detachProbe(m: THREE.Material): void {
  if (hookIn(m, 'probe')) detachHook(m, 'probe');
}
