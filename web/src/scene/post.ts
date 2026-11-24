// The `high` preset's post stack: the scene drawn into a half-float target, then ground-truth
// ambient occlusion (GTAO) from that draw's depth, a faint bloom on what is brighter than
// white, tone mapping and sRGB (OutputPass), a vignette, and SMAA in place of the canvas's
// MSAA. Off, or on a device that cannot draw into float targets, a frame is a plain
// `renderer.render`, exactly as without it. On a world lit by CS2's bake the bloom's threshold
// is far above white, and the effects that add light (`EFFECTS_LAYER`) bloom by their own light
// beside it (`EffectsBloomPass`).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';

/** The AO's reach in metres. */
export const AO_RADIUS = 0.8;
/** How much of the AO is multiplied in: 0 none, 1 all of it. */
export const AO_BLEND = 0.6;
export const BLOOM_STRENGTH = 0.15;
export const BLOOM_RADIUS = 0.4;
/** Linear brightness a pixel must pass to bloom. */
export const BLOOM_THRESHOLD = 0.9;
/**
 * The threshold on a world lit by CS2's bake, as a multiple of the exposure's white (the scene's
 * threshold is this over the exposure): the bake's light is CS2's own, so sunlit pale stone sits
 * at 3–5 in the scene, past 0.9 wherever the sun falls, and bloomed into a haze over Anubis's
 * sandstone and Vertigo's white containers (2026-10-25). At 3 the haze is gone; a lamp or the sun
 * off glass still blooms.
 */
export const BAKED_BLOOM_WHITE = 3;
/**
 * The layer the effects that add light are on besides the default one (`bloomsAsEffect`):
 * - utility.ts: the fires' flames, burst and the glow under them; the flash's, the HE's and the
 *   decoy's cores (the generated glow, the flash's CS2 flare) and the HE's generated fireball;
 *   CS2's fireball; the decoys' CS2 muzzle flash and spark streaks; the grenades' glow in flight;
 * - impacts.ts: the tracers and their generated flashes, CS2's muzzle flashes, the planted
 *   bomb's blink and the C4's blast;
 * - bulletmarks.ts: the sparks off metal.
 * Not the smokes, the HE's and the fire's smoke, the blood, the dust, the chips or the marks,
 * which cover. A camera that draws the scene sees the default layer, so this changes nothing it
 * draws.
 */
export const EFFECTS_LAYER = 2;
/**
 * Linear brightness an effect's own light (drawn alone over black) must pass to bloom on a baked
 * world, where the scene's threshold (BAKED_BLOOM_WHITE / exposure) is above every effect (the
 * flames divide the exposure out, so they never reach it): none, the whole of it blooms, as a
 * lens blooms a light. Measured on Mirage at `high` (the bloom's own contribution, mean 8-bit
 * levels over the effect, 2026-10-25): the molotov 13.7 (15.8 at the old 0.9 over the whole
 * scene, haze included; 8.3 at 0.25, 0 at 0.9), the flash 6.9 (2.6), the HE 2.7 (1.6), the world
 * around them unchanged (0.1 or less, their halos' edges). The flames' light is the exposure's
 * white over the exposure, so with none their glow is the same on every map.
 */
export const EFFECTS_BLOOM_THRESHOLD = 0;
/** How much darker the corners are than the centre. */
export const VIGNETTE = 0.25;

// three.js's NeutralToneMapping (tonemapping_pars_fragment, the Khronos PBR Neutral curve):
// below the knee it only takes a small offset off, so a map keeps its colours as it brightens.
const START_COMPRESSION = 0.8 - 0.04;
const DESATURATION = 0.15;

/**
 * Neutral tone mapping of the linear colour `c` at `exposure`, as three.js does it, into `out`
 * (a new colour without one).
 */
export function neutral(
  c: THREE.Color,
  exposure: number,
  out = new THREE.Color()
): THREE.Color {
  let r = c.r * exposure;
  let g = c.g * exposure;
  let b = c.b * exposure;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, g, b);
  if (peak < START_COMPRESSION) return out.setRGB(r, g, b);
  const d = 1 - START_COMPRESSION;
  const newPeak = 1 - (d * d) / (peak + d - START_COMPRESSION);
  const k = newPeak / peak;
  const m = 1 - 1 / (DESATURATION * (peak - newPeak) + 1);
  const mix = (v: number) => v * k * (1 - m) + newPeak * m;
  return out.setRGB(mix(r), mix(g), mix(b));
}

/**
 * The fog's colour (into `out`) that reads as a smoke of linear colour `smoke` when the eye is
 * inside it: through the post stack the fog mixes in before the tone mapping, so the smoke's own
 * colour; drawn straight to the canvas, after it, so the smoke tone-mapped at `exposure`.
 */
export function inSmokeFog(
  smoke: THREE.Color,
  post: boolean,
  exposure: number,
  out: THREE.Color
): THREE.Color {
  return post ? out.copy(smoke) : neutral(smoke, exposure, out);
}

/** The brightest colour `behindNeutral` gives back: the curve only reaches 1 at infinity. */
export const NEUTRAL_WHITE = 0.98;

/**
 * The white the sky texture is held to through the post stack at `exposure`: the brightest
 * colour whose `behindNeutral` stays at or under `threshold`, the bloom's threshold in force
 * (BLOOM_THRESHOLD, or a baked world's BAKED_BLOOM_WHITE / exposure), at most NEUTRAL_WHITE. A
 * near-white sky inverted to 0.98 would sit at 2–4 in the scene, and the bloom would spread
 * it over the whole frame. Under BLOOM_THRESHOLD 0.94 at Mirage's exposure without its bake,
 * 0.82 at Train's; under a bake's threshold 0.976 at any exposure.
 */
export function skyWhite(
  exposure: number,
  threshold = BLOOM_THRESHOLD
): number {
  // The peak after the offset (at most 0.04) that lands on the threshold.
  const p = threshold * exposure - 0.04;
  const d = 1 - START_COMPRESSION;
  const white =
    p <= START_COMPRESSION ? p : 1 - (d * d) / (p + d - START_COMPRESSION);
  return Math.min(NEUTRAL_WHITE, white);
}

/**
 * The linear colour that `neutral` turns into `c`. A frame drawn straight to the canvas shows
 * the clear colour (the sky), the fog colour and an sRGB sky texture untouched, but through the
 * post stack they are tone-mapped with everything else: the scene holds this colour instead,
 * so every preset shows the same sky. A colour brighter than `white` is first scaled down to
 * it, hue kept; a hue too saturated for its brightness, which the curve never puts out (past
 * the knee it mixes every channel towards the peak), is scaled down too, hue kept, to the
 * brightest the curve gives it (`saturatedPeak`), where it comes back with its darkest channel
 * at 0; rather than at its own brightness with that channel lifted, a bright blue sky turned
 * violet. The same steps run on the GPU for the sky texture (BEHIND_NEUTRAL_GLSL).
 */
export function behindNeutral(
  c: THREE.Color,
  exposure: number,
  white = NEUTRAL_WHITE
): THREE.Color {
  const over = Math.min(1, white / Math.max(c.r, c.g, c.b, 1e-9));
  let r = Math.max(c.r, 0) * over;
  let g = Math.max(c.g, 0) * over;
  let b = Math.max(c.b, 0) * over;
  const top = Math.max(r, g, b);
  const most = saturatedPeak(Math.min(r, g, b) / Math.max(top, 1e-9));
  if (top > most) {
    r *= most / top;
    g *= most / top;
    b *= most / top;
  }
  // Past the knee the curve put the peak p at 1 − d²/(p + d − knee) and mixed every channel
  // towards it by m: solve for p, then unmix.
  const peak = Math.max(r, g, b);
  if (peak >= START_COMPRESSION) {
    const d = 1 - START_COMPRESSION;
    const p = START_COMPRESSION - d + (d * d) / (1 - peak);
    const k = peak / p;
    const m = 1 - 1 / (DESATURATION * (p - peak) + 1);
    // A channel below 0 is a hue too saturated for this brightness: it comes back at 0.
    const unmix = (v: number) => Math.max(0, (v - peak * m) / (k * (1 - m)));
    r = unmix(r);
    g = unmix(g);
    b = unmix(b);
  }
  // Before that it took an offset off: x − 6.25x² for the darkest channel x under 0.08,
  // which leaves 6.25x² (under 0.04), else 0.04.
  const low = Math.min(r, g, b);
  const offset = low < 0.04 ? Math.sqrt(low / 6.25) - low : 0.04;
  return new THREE.Color(
    (r + offset) / exposure,
    (g + offset) / exposure,
    (b + offset) / exposure
  );
}

/**
 * The brightest peak the Neutral curve puts out for a colour whose darkest channel is `q` of its
 * peak: past the knee the curve mixes every channel towards the peak by m, so a colour more
 * saturated than m allows has no preimage. m ≤ q is (p − peak)·DESATURATION ≤ q / (1 − q), and
 * with u = 1 − peak and d = 1 − START_COMPRESSION that is u² − (Q + 2d)·u + d² ≤ 0 for
 * Q = q / (DESATURATION·(1 − q)): the peak is 1 − the smaller root. A grey has none (1); a fully
 * saturated colour stops at the knee.
 */
function saturatedPeak(q: number): number {
  if (q >= 1) return 1;
  const d = 1 - START_COMPRESSION;
  const s = q / (DESATURATION * (1 - q)) + 2 * d;
  return 1 - (s - Math.sqrt(Math.max(0, s * s - 4 * d * d))) / 2;
}

/** `behindNeutral` of `map` times `intensity`, at `exposure` and `white`, per texel (GLSL ES). */
const BEHIND_NEUTRAL_GLSL = /* glsl */ `
uniform sampler2D map;
uniform float exposure;
uniform float intensity;
uniform float white;
varying vec2 vUv;
void main() {
  vec3 c = max(texture2D(map, vUv).rgb * intensity, 0.0);
  c *= min(1.0, white / max(max(c.r, max(c.g, c.b)), 1e-9));
  float top = max(c.r, max(c.g, c.b));
  float q = min(c.r, min(c.g, c.b)) / max(top, 1e-9);
  if (q < 1.0) {
    float s = q / (${DESATURATION.toFixed(2)} * (1.0 - q)) + ${(2 * (1 - START_COMPRESSION)).toFixed(2)};
    float most = 1.0 - (s - sqrt(max(0.0, s * s - ${(4 * (1 - START_COMPRESSION) ** 2).toFixed(4)}))) * 0.5;
    if (top > most) c *= most / top;
  }
  float peak = max(c.r, max(c.g, c.b));
  if (peak >= ${START_COMPRESSION.toFixed(2)}) {
    float d = ${(1 - START_COMPRESSION).toFixed(2)};
    float p = ${START_COMPRESSION.toFixed(2)} - d + d * d / (1.0 - peak);
    float k = peak / p;
    float m = 1.0 - 1.0 / (${DESATURATION.toFixed(2)} * (p - peak) + 1.0);
    c = max((c - peak * m) / (k * (1.0 - m)), 0.0);
  }
  float low = min(c.r, min(c.g, c.b));
  float offset = low < 0.04 ? sqrt(low / 6.25) - low : 0.04;
  gl_FragColor = vec4((c + offset) / exposure, 1.0);
}`;

/**
 * The sky texture `source` (sRGB, equirect) as the post stack must hold it: `behindNeutral`
 * of every texel times `intensity`, at `exposure`, held to `skyWhite` under the bloom's
 * `threshold` in force (so the bloom leaves the sky alone), drawn once on the GPU into a half-float target, whose texture then stands in for
 * `source` as the background. The target is half the source's size: three.js turns an
 * equirect background into a cube as tall as the image, and a 512² cube a face already holds
 * sky.webp's 5.7 texels a degree (2048 / 360) at 8 bytes a texel (12 MB, against 48 MB at
 * full size). `dispose` frees the target and that cube.
 */
export class SkyBehindNeutral {
  readonly source: THREE.Texture;
  readonly exposure: number;
  readonly intensity: number;
  /** The bloom's threshold the sky is held under. */
  readonly threshold: number;
  private readonly target: THREE.WebGLRenderTarget;

  constructor(
    renderer: THREE.WebGLRenderer,
    source: THREE.Texture,
    exposure: number,
    intensity: number,
    threshold = BLOOM_THRESHOLD
  ) {
    this.source = source;
    this.exposure = exposure;
    this.intensity = intensity;
    this.threshold = threshold;
    const { width, height } = source.image as { width: number; height: number };
    const half = (n: number) => Math.max(1, Math.round(n / 2));
    this.target = new THREE.WebGLRenderTarget(half(width), half(height), {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.target.texture.name = 'SkyBehindNeutral';
    this.target.texture.mapping = THREE.EquirectangularReflectionMapping;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: source },
        exposure: { value: exposure },
        intensity: { value: intensity },
        white: { value: skyWhite(exposure, threshold) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: BEHIND_NEUTRAL_GLSL,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    const pass = new THREE.Scene().add(quad);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(pass, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    renderer.setRenderTarget(previous);
    quad.geometry.dispose();
    material.dispose();
  }

  /** The background texture: equirect, linear, drawn through the post stack's tone mapping. */
  get texture(): THREE.Texture {
    return this.target.texture;
  }

  dispose(): void {
    // The texture's own event is what frees the background cube made from it; the target's
    // dispose does not send it.
    this.target.texture.dispose();
    this.target.dispose();
  }
}

/** Puts `objects` on `EFFECTS_LAYER` (besides the default one): effects that add light. */
export function bloomsAsEffect(...objects: THREE.Object3D[]): void {
  for (const o of objects) o.layers.enable(EFFECTS_LAYER);
}

/**
 * The bright pass of `EffectsBloomPass` with the effects on: three's (LuminosityHighPassShader,
 * the scene's colour where its luminance passes `luminosityThreshold`) beside the effects' own
 * light where it passes `effectsThreshold`, whichever is brighter. An effect over a pixel that
 * passes by itself is in that pixel already, so the larger is taken, not the sum.
 */
const EFFECTS_HIGH_PASS = /* glsl */ `
#include <common>
uniform sampler2D tDiffuse;
uniform sampler2D tEffects;
uniform vec3 defaultColor;
uniform float defaultOpacity;
uniform float luminosityThreshold;
uniform float effectsThreshold;
uniform float smoothWidth;
varying vec2 vUv;
void main() {
  vec4 texel = texture2D( tDiffuse, vUv );
  vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );
  float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, luminance( texel.xyz ) );
  vec4 bright = mix( outputColor, texel, alpha );
  vec3 effects = texture2D( tEffects, vUv ).rgb;
  float pass = smoothstep( effectsThreshold, effectsThreshold + smoothWidth, luminance( effects ) );
  gl_FragColor = vec4( max( bright.rgb, effects * pass ), bright.a );
}`;

/**
 * three's bloom, which on a baked world (`effects` on) also blooms the effects by their own
 * light. Before its bright pass it draws the scene's `EFFECTS_LAYER` alone, over black, into the
 * colour of `sceneTarget`, the composer's target the scene was drawn into: by the bloom the AO
 * has copied that colour on into the other target (the bloom's input), so it is free, and its
 * depth is still the scene's, so a wall or a player in front of an effect hides it. Nothing is
 * allocated for it. The bright pass then takes that light past `EFFECTS_BLOOM_THRESHOLD` beside
 * the scene past `threshold` (EFFECTS_HIGH_PASS). With `effects` off, or a scene target that is
 * the input itself, it is three's bloom exactly.
 *
 * The effects are drawn from a scene of their own that holds the scene's children (the same
 * array) and its fog, through the camera with its layers set to `EFFECTS_LAYER` alone: three keeps
 * its lights and render lists per scene, so the scene's are left as its own draw set them, and
 * this draw has no light, shadow or background.
 */
export class EffectsBloomPass extends UnrealBloomPass {
  /** Whether the effects bloom by their own light (a baked world). */
  effects = false;
  /** The composer's target the scene was drawn into this frame (PostStack sets it). */
  sceneTarget: THREE.WebGLRenderTarget | null = null;
  /** The camera the scene was drawn through (PostStack sets it). */
  camera: THREE.Camera;
  /** Whether the last `render` bloomed the effects by their own light. */
  drewEffects = false;
  private readonly effectsScene = new THREE.Scene();
  private readonly scene: THREE.Scene;
  private readonly plainHighPass: THREE.ShaderMaterial;
  private readonly effectsHighPass: THREE.ShaderMaterial;
  private readonly clearWas = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    resolution: THREE.Vector2,
    strength: number,
    radius: number,
    threshold: number
  ) {
    super(resolution, strength, radius, threshold);
    this.scene = scene;
    this.camera = camera;
    this.effectsScene.children = scene.children;
    // The scene's matrices are up to date: its own draw updated them this frame.
    this.effectsScene.matrixWorldAutoUpdate = false;
    this.plainHighPass = this.materialHighPassFilter;
    // The same uniform objects as three's bright pass: its `render` sets them.
    const u = this.highPassUniforms as Record<string, THREE.IUniform>;
    this.effectsHighPass = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: u.tDiffuse,
        defaultColor: u.defaultColor,
        defaultOpacity: u.defaultOpacity,
        luminosityThreshold: u.luminosityThreshold,
        smoothWidth: u.smoothWidth,
        tEffects: { value: null },
        effectsThreshold: { value: EFFECTS_BLOOM_THRESHOLD },
      },
      vertexShader: LuminosityHighPassShader.vertexShader,
      fragmentShader: EFFECTS_HIGH_PASS,
    });
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean
  ): void {
    const target = this.sceneTarget;
    this.drewEffects = this.effects && !!target && target !== readBuffer;
    if (this.drewEffects) {
      this.drawEffects(renderer, target!);
      this.effectsHighPass.uniforms.tEffects.value = target!.texture;
      this.materialHighPassFilter = this.effectsHighPass;
    } else this.materialHighPassFilter = this.plainHighPass;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }

  override dispose(): void {
    super.dispose();
    this.plainHighPass.dispose();
    this.effectsHighPass.dispose();
  }

  /** Draws the scene's `EFFECTS_LAYER` alone into `target`'s colour, cleared to black. */
  private drawEffects(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget
  ): void {
    const camera = this.camera;
    const mask = camera.layers.mask;
    const autoClear = renderer.autoClear;
    renderer.getClearColor(this.clearWas);
    const clearAlpha = renderer.getClearAlpha();
    this.effectsScene.fog = this.scene.fog;
    camera.layers.set(EFFECTS_LAYER);
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    try {
      renderer.render(this.effectsScene, camera);
    } finally {
      camera.layers.mask = mask;
      renderer.autoClear = autoClear;
      renderer.setClearColor(this.clearWas, clearAlpha);
    }
  }
}

/**
 * A depth of field for the homepage video (`tools/home-video.mjs`), Dennis Gustafsson's single-pass
 * bokeh ("Bokeh depth of field in a single pass", 2018): each pixel gathers a golden-angle spiral
 * of the scene's draw, a sample counting where its own blur (by its depth) reaches this far, a
 * sample behind this pixel no more than twice this pixel's blur, so a sharp subject does not
 * bleed over the soft background behind it. Off unless `setDof` turns it on.
 */
const DofShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    focus: { value: 2 },
    /** Blur in drawing-buffer pixels per dioptre off focus. */
    scale: { value: 10 },
    maxBlur: { value: 12 },
    texel: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float focus;
    uniform float scale;
    uniform float maxBlur;
    uniform vec2 texel;
    varying vec2 vUv;
    const float GOLDEN_ANGLE = 2.39996323;
    const float RAD_SCALE = 0.5;
    float depthAt(vec2 uv) {
      return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
    }
    float blurAt(float z) {
      return clamp(abs(1.0 / focus - 1.0 / z) * scale, 0.0, maxBlur);
    }
    void main() {
      float z0 = depthAt(vUv);
      float size0 = blurAt(z0);
      vec4 c0 = texture2D(tDiffuse, vUv);
      vec3 color = c0.rgb;
      float tot = 1.0;
      float radius = RAD_SCALE;
      float ang = 0.0;
      for (int i = 0; i < 400; i++) {
        if (radius >= maxBlur) break;
        vec2 tc = vUv + vec2(cos(ang), sin(ang)) * texel * radius;
        vec3 sc = texture2D(tDiffuse, tc).rgb;
        float sz = depthAt(tc);
        float ss = blurAt(sz);
        if (sz > z0) ss = clamp(ss, 0.0, size0 * 2.0);
        float m = smoothstep(radius - 0.5, radius + 0.5, ss);
        color += mix(color / tot, sc, m);
        tot += 1.0;
        radius += RAD_SCALE / radius;
        ang += GOLDEN_ANGLE;
      }
      gl_FragColor = vec4(color / tot, c0.a);
    }`,
};

/**
 * `DofShader` drawn into a target of its own and copied back, as the
 * composer's write buffer may be the one whose depth the shader reads (a feedback loop).
 */
class DofPass extends Pass {
  readonly material = new THREE.ShaderMaterial({
    ...DofShader,
    uniforms: THREE.UniformsUtils.clone(DofShader.uniforms),
    depthTest: false,
    depthWrite: false,
  });
  private readonly copy = new THREE.ShaderMaterial({
    ...CopyShader,
    uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
    depthTest: false,
    depthWrite: false,
  });
  private readonly quad = new FullScreenQuad();
  private readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
  });

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  setSize(w: number, h: number): void {
    this.target.setSize(w, h);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.material;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    this.copy.uniforms.tDiffuse.value = this.target.texture;
    this.quad.material = this.copy;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.copy.dispose();
    this.quad.dispose();
    this.target.dispose();
  }
}

export class PostStack {
  /** False when the device cannot run the stack; `render` then always draws plainly. */
  readonly supported: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private camera: THREE.Camera;
  private readonly composer: EffectComposer | null = null;
  private readonly renderPass: RenderPass | null = null;
  private readonly gtao: GTAOPass | null = null;
  private readonly bloom: EffectsBloomPass | null = null;
  /** The depth of field (`DofShader`), off until `setDof`. */
  private readonly dof: DofPass | null = null;
  private on = false;
  private width = 0;
  private height = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    let built = false;
    if (PostStack.deviceCanRun(renderer)) {
      try {
        const size = renderer.getSize(new THREE.Vector2());
        const dpr = renderer.getPixelRatio();
        const w = Math.max(1, Math.floor(size.x * dpr));
        const h = Math.max(1, Math.floor(size.y * dpr));
        // The scene's draw keeps its depth in a texture, for the AO to read: drawing the
        // scene a second time for normals, as GTAOPass would by itself, doubles the geometry
        // cost and loses the cutouts' holes.
        const target = new THREE.WebGLRenderTarget(w, h, {
          type: THREE.HalfFloatType,
          depthTexture: new THREE.DepthTexture(w, h),
        });
        target.texture.name = 'PostStack.rt1';
        const composer = new EffectComposer(renderer, target);
        composer.renderTarget2.texture.name = 'PostStack.rt2';
        // Sizes are given in drawing-buffer pixels: see `resize`.
        composer.setPixelRatio(1);

        const renderPass = new RenderPass(scene, camera);
        const gtao = new GTAOPass(scene, camera, w, h);
        gtao.updateGtaoMaterial({ radius: AO_RADIUS });
        gtao.blendIntensity = AO_BLEND;
        const bloom = new EffectsBloomPass(
          scene,
          camera,
          new THREE.Vector2(w, h),
          BLOOM_STRENGTH,
          BLOOM_RADIUS,
          BLOOM_THRESHOLD
        );
        const vignette = new ShaderPass(VignetteShader);
        // VignetteShader darkens by dot(uv, uv) with uv = (vUv - 0.5) * offset: at a corner
        // that is offset² / 2.
        vignette.uniforms.offset.value = Math.sqrt(2 * VIGNETTE);
        vignette.uniforms.darkness.value = 1;
        composer.addPass(renderPass);
        composer.addPass(gtao);
        composer.addPass(bloom);
        const dof = new DofPass();
        dof.enabled = false;
        composer.addPass(dof);
        composer.addPass(new OutputPass());
        composer.addPass(vignette);
        composer.addPass(new SMAAPass());

        this.composer = composer;
        this.renderPass = renderPass;
        this.gtao = gtao;
        this.bloom = bloom;
        this.dof = dof;
        this.width = w;
        this.height = h;
        this.bindDepth();
        // The first bind switches the AO from its own normal pass to normals from depth.
        gtao.gtaoMaterial.needsUpdate = true;
        gtao.pdMaterial.needsUpdate = true;
        built = true;
      } catch (e) {
        console.warn('post stack unavailable:', e);
      }
    }
    this.supported = built;
  }

  /**
   * Whether `renderer`'s device can run the stack: it draws into half-float targets, and it
   * has anisotropic filtering, whose absence marks a device (or a software renderer) too
   * weak for full-screen passes at full resolution.
   */
  static deviceCanRun(renderer: THREE.WebGLRenderer): boolean {
    const ext = renderer.extensions;
    return (
      (ext.has('EXT_color_buffer_half_float') ||
        ext.has('EXT_color_buffer_float')) &&
      renderer.capabilities.getMaxAnisotropy() > 1
    );
  }

  /** Whether frames go through the stack. */
  get enabled(): boolean {
    return this.on;
  }

  /** Drawing-buffer pixels the stack renders at. */
  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** The passes in order; none when unsupported. */
  get passes(): readonly Pass[] {
    return this.composer?.passes ?? [];
  }

  /**
   * The depth of field on (focused `focus` metres away, `scale` pixels of
   * blur per dioptre off focus at a 1080-pixel-high frame, at most `max`), or off with null.
   */
  setDof(o: { focus: number; scale: number; max: number } | null): void {
    if (!this.dof) return;
    this.dof.enabled = o !== null;
    if (!o) return;
    const k = this.height / 1080;
    const u = this.dof.uniforms;
    u.focus.value = o.focus;
    u.scale.value = o.scale * k;
    u.maxBlur.value = o.max * k;
  }

  /** The linear brightness a pixel must pass to bloom (BLOOM_THRESHOLD until told otherwise). */
  setBloomThreshold(t: number): void {
    if (this.bloom) this.bloom.threshold = t;
  }

  /**
   * Whether the effects on `EFFECTS_LAYER` also bloom by their own light, past
   * `EFFECTS_BLOOM_THRESHOLD` (a baked world, whose threshold is above them); off until told.
   */
  setEffectsBloom(on: boolean): void {
    if (this.bloom) this.bloom.effects = on;
  }

  /**
   * Turns the stack on or off; on is ignored when it is not `supported`. Turning it off frees
   * its render targets on the GPU (they come back on the next frame through it).
   */
  setEnabled(b: boolean): void {
    const on = b && this.supported;
    if (this.on && !on) this.release();
    this.on = on;
  }

  /**
   * Sizes the targets to the canvas's drawing buffer: `w`×`h` CSS pixels at `dpr`, floored
   * as three.js floors the canvas, so every pass samples whole pixels of the same grid.
   */
  resize(w: number, h: number, dpr: number): void {
    const width = Math.max(1, Math.floor(w * dpr));
    const height = Math.max(1, Math.floor(h * dpr));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.composer?.setSize(width, height);
  }

  /** Draws a frame through `camera` (the last one given, or the constructor's). */
  render(camera: THREE.Camera = this.camera): void {
    this.setCamera(camera);
    if (!this.on || !this.composer) {
      this.renderer.render(this.scene, camera);
      return;
    }
    this.bindDepth();
    if (this.bloom) this.bloom.sceneTarget = this.composer.readBuffer;
    if (this.dof?.enabled) {
      const u = this.dof.uniforms;
      u.tDepth.value = this.composer.readBuffer.depthTexture;
      const cam = camera as THREE.PerspectiveCamera;
      u.cameraNear.value = cam.near;
      u.cameraFar.value = cam.far;
      (u.texel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    }
    this.composer.render(0);
  }

  dispose(): void {
    this.on = false;
    if (!this.composer) return;
    this.release();
    for (const p of this.composer.passes) p.dispose();
    this.composer.dispose();
  }

  /** Every render target the composer and its passes own; the tests look at their sizes. */
  renderTargets(): THREE.WebGLRenderTarget[] {
    const c = this.composer;
    if (!c) return [];
    const out = new Set([c.renderTarget1, c.renderTarget2]);
    for (const p of c.passes as (Pass & Record<string, unknown>)[])
      for (const v of Object.values(p))
        for (const t of Array.isArray(v) ? v : [v])
          if (t instanceof THREE.WebGLRenderTarget) out.add(t);
    return [...out];
  }

  /** Frees the targets' GPU memory; three.js allocates them again on their next use. */
  private release(): void {
    for (const t of this.renderTargets()) t.dispose();
  }

  private setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    if (!this.renderPass || !this.gtao) return;
    this.renderPass.camera = camera;
    this.gtao.camera = camera;
    if (this.bloom) this.bloom.camera = camera;
    const m = this.gtao.gtaoMaterial;
    const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? 1
      : 0;
    if (m.defines.PERSPECTIVE_CAMERA !== perspective) {
      m.defines.PERSPECTIVE_CAMERA = perspective;
      m.needsUpdate = true;
    }
  }

  /**
   * Points the AO at the depth of the target the scene is about to be drawn into: the
   * composer swaps its two targets as passes run, so that is not always the same one.
   */
  private bindDepth(): void {
    const gtao = this.gtao;
    const depth = this.composer?.readBuffer.depthTexture;
    if (gtao && depth && gtao.depthTexture !== depth) gtao.setGBuffer(depth);
  }
}
