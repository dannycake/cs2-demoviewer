// The post stack (GTAO, bloom, vignette, SMAA) built on a renderer stub: construction, the
// fallback to a plain draw, and resizing. Nothing here touches WebGL: render targets only
// allocate on their first draw.

import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LuminosityHighPassShader } from 'three/addons/shaders/LuminosityHighPassShader.js';
import {
  BAKED_BLOOM_WHITE,
  BLOOM_THRESHOLD,
  EFFECTS_BLOOM_THRESHOLD,
  EFFECTS_LAYER,
  EffectsBloomPass,
  NEUTRAL_WHITE,
  PostStack,
  bloomsAsEffect,
  behindNeutral,
  inSmokeFog,
  neutral,
  skyWhite,
} from '../src/scene/post';
import { ATMOSPHERES, DEFAULT_ATMOSPHERE } from '../src/scene/atmosphere';

/** The parts of a renderer the stack reads while it is built, resized and bypassed. */
function stubRenderer(
  o: { floatTargets?: boolean; maxAnisotropy?: number } = {}
) {
  const { floatTargets = true, maxAnisotropy = 16 } = o;
  const size = new THREE.Vector2(800, 600);
  return {
    render: vi.fn(),
    getPixelRatio: () => 1,
    getSize: (v: THREE.Vector2) => v.copy(size),
    extensions: {
      has: (name: string) =>
        floatTargets &&
        (name === 'EXT_color_buffer_float' ||
          name === 'EXT_color_buffer_half_float'),
    },
    capabilities: { getMaxAnisotropy: () => maxAnisotropy },
  } as unknown as THREE.WebGLRenderer & { render: ReturnType<typeof vi.fn> };
}

// SMAA decodes its lookup tables from data URLs into images; node has no Image.
const hadImage = 'Image' in globalThis;
beforeAll(() => {
  if (!hadImage)
    (globalThis as Record<string, unknown>).Image = class {
      src = '';
      onload: (() => void) | null = null;
    };
});
afterAll(() => {
  if (!hadImage) delete (globalThis as Record<string, unknown>).Image;
});

const scene = () => new THREE.Scene();
const camera = () => new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);

describe('inSmokeFog', () => {
  it('is the fog colour that reads as a lit smoke: the smoke itself under the post stack (the fog mixes in before the tone mapping), its tone-mapped colour without', () => {
    const smoke = new THREE.Color(0.6, 0.55, 0.5);
    const out = new THREE.Color();
    expect(inSmokeFog(smoke, true, 1.3, out)).toBe(out);
    expect(out.equals(smoke)).toBe(true);
    inSmokeFog(smoke, false, 1.3, out);
    expect(out.equals(neutral(smoke, 1.3))).toBe(true);
  });
});

describe('PostStack', () => {
  it('is supported with float render targets: scene, GTAO, bloom, output, vignette, SMAA', () => {
    const p = new PostStack(stubRenderer(), scene(), camera());
    expect(p.supported).toBe(true);
    const kinds = [
      RenderPass,
      GTAOPass,
      UnrealBloomPass,
      // The depth of field, off unless asked (the homepage video's render).
      Pass,
      OutputPass,
      ShaderPass,
      SMAAPass,
    ];
    expect(p.passes).toHaveLength(kinds.length);
    expect(p.passes[3].enabled).toBe(false);
    p.passes.forEach((pass, i) => expect(pass).toBeInstanceOf(kinds[i]));
  });

  it('blooms past BLOOM_THRESHOLD until told another threshold, and a stack it cannot run ignores one', () => {
    const p = new PostStack(stubRenderer(), scene(), camera());
    const bloom = p.passes[2] as UnrealBloomPass;
    expect(bloom.threshold).toBe(BLOOM_THRESHOLD);
    p.setBloomThreshold(BAKED_BLOOM_WHITE / 1.3);
    expect(bloom.threshold).toBeCloseTo(3 / 1.3, 12);
    const weak = new PostStack(
      stubRenderer({ floatTargets: false }),
      scene(),
      camera()
    );
    expect(() => weak.setBloomThreshold(2)).not.toThrow();
  });

  it('disabled, render() draws the scene straight to the canvas once', () => {
    const r = stubRenderer();
    const s = scene();
    const c = camera();
    const p = new PostStack(r, s, c);
    p.setEnabled(true);
    p.setEnabled(false);
    p.render();
    expect(r.render).toHaveBeenCalledTimes(1);
    expect(r.render).toHaveBeenCalledWith(s, c);
  });

  it('render(camera) draws through the camera it is given', () => {
    const r = stubRenderer();
    const p = new PostStack(r, scene(), camera());
    const top = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    p.render(top);
    expect(r.render.mock.calls[0][1]).toBe(top);
  });

  it('without float render targets it is unsupported and stays off', () => {
    const r = stubRenderer({ floatTargets: false });
    const p = new PostStack(r, scene(), camera());
    expect(p.supported).toBe(false);
    p.setEnabled(true);
    expect(p.enabled).toBe(false);
    p.render();
    expect(r.render).toHaveBeenCalledTimes(1);
  });

  it('a device without anisotropic filtering is treated as too weak for it', () => {
    const p = new PostStack(
      stubRenderer({ maxAnisotropy: 1 }),
      scene(),
      camera()
    );
    expect(p.supported).toBe(false);
  });

  it('resize sizes the composer and every pass to the drawing buffer', () => {
    const p = new PostStack(stubRenderer(), scene(), camera());
    p.resize(1001, 701, 1.5);
    // three.js floors the canvas to 1501x1051; the targets must match it exactly, or SMAA
    // and GTAO sample half a pixel off.
    expect(p.size).toEqual({ width: 1501, height: 1051 });
    const dims = (name: string) => {
      const t = p.renderTargets().find((t) => t.texture.name === name);
      return t ? [t.width, t.height] : null;
    };
    for (const name of [
      'PostStack.rt1',
      'PostStack.rt2',
      'SMAAPass.edges',
      'SMAAPass.weights',
    ])
      expect(dims(name)).toEqual([1501, 1051]);
    p.resize(640, 480, 1);
    expect(p.size).toEqual({ width: 640, height: 480 });
    expect(dims('SMAAPass.edges')).toEqual([640, 480]);
  });

  it('disabling frees the render targets, dispose frees everything', () => {
    const p = new PostStack(stubRenderer(), scene(), camera());
    p.setEnabled(true);
    const freed = vi.fn();
    for (const t of p.renderTargets()) t.addEventListener('dispose', freed);
    const n = p.renderTargets().length;
    expect(n).toBeGreaterThan(6);
    p.setEnabled(false);
    expect(freed).toHaveBeenCalledTimes(n);
    p.dispose();
    expect(p.enabled).toBe(false);
  });
});

describe('the effects bloom of a baked world', () => {
  /**
   * The renderer calls the bloom makes, in order, with what each saw: the target, the clear
   * colour, what was drawn and through which layers.
   */
  function recorder() {
    const calls: string[] = [];
    let target: THREE.WebGLRenderTarget | null = null;
    const clear = new THREE.Color(0.2, 0.3, 0.4);
    let alpha = 0.5;
    const r = {
      autoClear: true,
      getClearColor: (c: THREE.Color) => c.copy(clear),
      getClearAlpha: () => alpha,
      setClearColor: (c: THREE.ColorRepresentation, a = 1) => {
        clear.set(c);
        alpha = a;
      },
      setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
        target = t;
      },
      clear: (color = true, depth = true, stencil = true) =>
        calls.push(
          `clear ${target?.texture.name ?? 'canvas'} ${[color, depth, stencil].join(' ')} to ${clear.getHexString()}/${alpha}`
        ),
      render: (o: THREE.Object3D, c: THREE.Camera) =>
        calls.push(
          `render ${o instanceof THREE.Scene ? 'scene' : 'quad'} into ${target?.texture.name ?? 'canvas'} layers ${c.layers.mask} autoClear ${r.autoClear}`
        ),
    };
    return { r: r as unknown as THREE.WebGLRenderer, calls, clear };
  }

  function setup() {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xffffff, 1, 2);
    scene.add(new THREE.Mesh(), new THREE.Sprite());
    const cam = camera();
    const pass = new EffectsBloomPass(
      scene,
      cam,
      new THREE.Vector2(64, 64),
      0.15,
      0.4,
      3
    );
    const target = (name: string) => {
      const t = new THREE.WebGLRenderTarget(64, 64);
      t.texture.name = name;
      return t;
    };
    return {
      scene,
      cam,
      pass,
      sceneTarget: target('sceneTarget'),
      input: target('input'),
    };
  }

  it('puts an object on EFFECTS_LAYER beside the default one, so the scene still draws it', () => {
    const o = new THREE.Sprite();
    bloomsAsEffect(o);
    expect(o.layers.isEnabled(0)).toBe(true);
    expect(o.layers.isEnabled(EFFECTS_LAYER)).toBe(true);
    expect(EFFECTS_LAYER).not.toBe(1); // WORLD_CASTER_LAYER's
  });

  it("is three's bloom, its own bright pass and nothing drawn, until told the effects bloom", () => {
    const { pass, sceneTarget, input } = setup();
    const { r, calls } = recorder();
    pass.sceneTarget = sceneTarget;
    pass.render(r, sceneTarget, input, 0, false);
    expect(pass.drewEffects).toBe(false);
    expect(pass.materialHighPassFilter.fragmentShader).toBe(
      LuminosityHighPassShader.fragmentShader
    );
    expect(calls.some((c) => c.startsWith('render scene'))).toBe(false);
    expect(calls.some((c) => c.includes('sceneTarget'))).toBe(false);
  });

  it("draws the scene's effects layer alone over black into the scene's target, through the camera, then takes their light past EFFECTS_BLOOM_THRESHOLD beside the scene's past its own threshold", () => {
    const { scene, cam, pass, sceneTarget, input } = setup();
    const { r, calls, clear } = recorder();
    pass.effects = true;
    pass.sceneTarget = sceneTarget;
    const mask = cam.layers.mask;
    pass.render(r, sceneTarget, input, 0, false);
    expect(pass.drewEffects).toBe(true);
    // First the effects, the colour cleared to black and the depth (the scene's) kept, then
    // three's bloom, its bright pass first.
    expect(calls.slice(0, 3)).toEqual([
      'clear sceneTarget true false false to 000000/0',
      `render scene into sceneTarget layers ${1 << EFFECTS_LAYER} autoClear false`,
      'clear UnrealBloomPass.bright true true true to 000000/0',
    ]);
    // Everything the draw changed is put back.
    expect(cam.layers.mask).toBe(mask);
    expect(r.autoClear).toBe(true);
    expect(clear.getHexString()).toBe(
      new THREE.Color(0.2, 0.3, 0.4).getHexString()
    );
    // The scene's own children and fog, drawn from a scene of its own (its lights and render
    // lists are the scene's own draw's).
    const fx = pass['effectsScene'] as THREE.Scene;
    expect(fx).not.toBe(scene);
    expect(fx.children).toBe(scene.children);
    expect(fx.fog).toBe(scene.fog);
    expect(fx.background).toBeNull();
    // The bright pass reads the scene (the input) past `threshold` and the effects past theirs.
    const m = pass.materialHighPassFilter;
    expect(m.fragmentShader).not.toBe(LuminosityHighPassShader.fragmentShader);
    expect(m.fragmentShader).toContain('max( bright.rgb, effects * pass )');
    expect(m.uniforms.tDiffuse.value).toBe(input.texture);
    expect(m.uniforms.tEffects.value).toBe(sceneTarget.texture);
    expect(m.uniforms.luminosityThreshold.value).toBe(3);
    expect(m.uniforms.effectsThreshold.value).toBe(EFFECTS_BLOOM_THRESHOLD);
    // Off again: three's.
    pass.effects = false;
    pass.render(r, sceneTarget, input, 0, false);
    expect(pass.materialHighPassFilter.fragmentShader).toBe(
      LuminosityHighPassShader.fragmentShader
    );
  });

  it('draws no effects when the scene target is its input (the AO has not copied the scene on): that colour is the frame', () => {
    const { pass, input } = setup();
    const { r, calls } = recorder();
    pass.effects = true;
    pass.sceneTarget = input;
    pass.render(r, new THREE.WebGLRenderTarget(64, 64), input, 0, false);
    expect(pass.drewEffects).toBe(false);
    expect(calls.some((c) => c.startsWith('render scene'))).toBe(false);
    pass.sceneTarget = null;
    pass.render(r, new THREE.WebGLRenderTarget(64, 64), input, 0, false);
    expect(pass.drewEffects).toBe(false);
  });

  it("is the stack's bloom, off until a baked world turns it on, and follows the stack's camera", () => {
    const p = new PostStack(stubRenderer(), scene(), camera());
    const bloom = p.passes[2] as EffectsBloomPass;
    expect(bloom).toBeInstanceOf(EffectsBloomPass);
    expect(bloom.effects).toBe(false);
    p.setEffectsBloom(true);
    expect(bloom.effects).toBe(true);
    p.setEffectsBloom(false);
    expect(bloom.effects).toBe(false);
    const weak = new PostStack(
      stubRenderer({ floatTargets: false }),
      scene(),
      camera()
    );
    expect(() => weak.setEffectsBloom(true)).not.toThrow();
  });

  it('frees both bright passes on dispose', () => {
    const { pass } = setup();
    const plainFreed = vi.fn();
    const effectsFreed = vi.fn();
    pass.materialHighPassFilter.addEventListener('dispose', plainFreed);
    pass.effects = true;
    pass.sceneTarget = new THREE.WebGLRenderTarget(4, 4);
    const { r } = recorder();
    pass.render(
      r,
      pass.sceneTarget,
      new THREE.WebGLRenderTarget(4, 4),
      0,
      false
    );
    pass.materialHighPassFilter.addEventListener('dispose', effectsFreed);
    // Back to three's before dispose: the effects' pass is not the one three frees.
    pass.effects = false;
    pass.render(
      r,
      pass.sceneTarget,
      new THREE.WebGLRenderTarget(4, 4),
      0,
      false
    );
    pass.dispose();
    expect(plainFreed).toHaveBeenCalled();
    expect(effectsFreed).toHaveBeenCalled();
  });
});

describe('the sky behind the tone mapping', () => {
  it('matches three.js Neutral tone mapping on reference colours', () => {
    expect(neutral(new THREE.Color(0, 0, 0), 1).getHex()).toBe(0);
    // Below the knee it only takes the 0.04 offset off, so hues stay as they are.
    const warm = neutral(new THREE.Color(0.6, 0.3, 0.1), 1);
    expect(warm.r).toBeCloseTo(0.56, 6);
    expect(warm.g).toBeCloseTo(0.26, 6);
    expect(warm.b).toBeCloseTo(0.06, 6);
    // Exposure scales first; bright white compresses towards 1.
    expect(neutral(new THREE.Color(0.25, 0.25, 0.25), 2).r).toBeCloseTo(
      0.46,
      6
    );
    const white = neutral(new THREE.Color(10, 10, 10), 1).r;
    expect(white).toBeGreaterThan(0.98);
    expect(white).toBeLessThanOrEqual(1);
  });

  it('undoes the curve exactly over the whole range, up to its white (0.98)', () => {
    // The closed form the sky texture's GPU pass (BEHIND_NEUTRAL_GLSL) also runs.
    const steps = [
      0, 0.01, 0.03, 0.05, 0.1, 0.3, 0.6, 0.75, 0.77, 0.85, 0.93, 0.98,
    ];
    for (const exposure of [1, 1.6, 3.25])
      for (const r of steps)
        for (const g of steps)
          for (const b of [0, 0.04, 0.5, 0.9, 0.98]) {
            const c = new THREE.Color(r, g, b);
            const back = behindNeutral(c, exposure);
            expect(Math.min(back.r, back.g, back.b)).toBeGreaterThanOrEqual(0);
            const shown = neutral(back, exposure);
            const peak = Math.max(r, g, b);
            // The curve's own reach: past its knee (0.76) it mixes every channel towards the
            // peak by m, so a colour whose darkest channel is under peak·m has no preimage.
            const p = peak < 0.76 ? peak : 0.52 + 0.0576 / (1 - peak);
            const m = peak < 0.76 ? 0 : 1 - 1 / (0.15 * (p - peak) + 1);
            if (Math.min(r, g, b) >= peak * m - 1e-9) {
              expect(shown.r).toBeCloseTo(r, 5);
              expect(shown.g).toBeCloseTo(g, 5);
              expect(shown.b).toBeCloseTo(b, 5);
            } else {
              // Out of its reach: the same hue, dimmer.
              const k = Math.max(shown.r, shown.g, shown.b) / peak;
              expect(k).toBeLessThan(1);
              expect(shown.r).toBeCloseTo(r * k, 4);
              expect(shown.g).toBeCloseTo(g * k, 4);
              expect(shown.b).toBeCloseTo(b * k, 4);
            }
          }
  });

  it('keeps the hue of a colour too saturated for its brightness, dimmed until the curve can give it back, not tinted (a bright blue sky turned violet)', () => {
    for (const exposure of [0.6, 1, 1.6])
      for (const c of [
        new THREE.Color(0, 0.25, 0.95),
        new THREE.Color(0.05, 0.3, 0.9),
        new THREE.Color(0.9, 0.5, 0.02),
      ]) {
        const shown = neutral(behindNeutral(c, exposure), exposure);
        const peak = Math.max(c.r, c.g, c.b);
        const k = Math.max(shown.r, shown.g, shown.b) / peak;
        expect(k).toBeLessThanOrEqual(1 + 1e-6);
        expect(k).toBeGreaterThan(0.75);
        // The same colour, darker: every channel in proportion.
        for (const ch of ['r', 'g', 'b'] as const)
          expect(shown[ch]).toBeCloseTo(c[ch] * k, 4);
      }
  });

  it('stops at white: brighter than 0.98 comes back as 0.98', () => {
    const shown = neutral(behindNeutral(new THREE.Color(1, 1, 1), 2), 2);
    expect(shown.r).toBeCloseTo(0.98, 5);
  });

  it('keeps the sky texture out of the bloom: under skyWhite, nothing behind the curve passes the threshold', () => {
    for (const a of [DEFAULT_ATMOSPHERE, ...Object.values(ATMOSPHERES)]) {
      const white = skyWhite(a.exposure);
      expect(white).toBeGreaterThan(0.8);
      expect(white).toBeLessThanOrEqual(0.98);
      for (const c of [
        [1, 1, 1],
        [0.4, 0.68, 1],
        [1, 0.9, 0.7],
        [0.02, 0.05, 1],
      ]) {
        const back = behindNeutral(new THREE.Color(...c), a.exposure, white);
        expect(Math.max(back.r, back.g, back.b)).toBeLessThanOrEqual(
          BLOOM_THRESHOLD + 1e-9
        );
        // White itself is shown as `white`.
        if (c[0] === 1 && c[1] === 1)
          expect(neutral(back, a.exposure).r).toBeCloseTo(white, 5);
      }
      // Below it, the sky comes back exactly.
      const mid = new THREE.Color(0.3, 0.5, Math.min(0.75, white));
      const shown = neutral(behindNeutral(mid, a.exposure, white), a.exposure);
      expect(shown.b).toBeCloseTo(mid.b, 5);
    }
  });

  it("holds the sky to the white under the bloom threshold in force: a baked world's (BAKED_BLOOM_WHITE / exposure) leaves it near NEUTRAL_WHITE at every exposure", () => {
    // Without the threshold, as before: Vertigo's baked exposure would cap the sky at 0.50.
    expect(skyWhite(0.6)).toBeLessThan(0.55);
    for (const exposure of [0.6, 0.75, 0.8, 0.85, 0.9, 1.35, 1.65]) {
      const threshold = BAKED_BLOOM_WHITE / exposure;
      const white = skyWhite(exposure, threshold);
      expect(white).toBeGreaterThan(0.97);
      expect(white).toBeLessThanOrEqual(NEUTRAL_WHITE);
      const back = behindNeutral(new THREE.Color(1, 1, 1), exposure, white);
      expect(Math.max(back.r, back.g, back.b)).toBeLessThanOrEqual(
        threshold + 1e-9
      );
    }
    // The default is BLOOM_THRESHOLD's, unchanged.
    expect(skyWhite(1.6, BLOOM_THRESHOLD)).toBe(skyWhite(1.6));
  });

  it('tone-maps into `out` without making a colour', () => {
    const out = new THREE.Color();
    const c = new THREE.Color(0.6, 0.55, 0.5);
    expect(neutral(c, 1.3, out)).toBe(out);
    expect(out.equals(neutral(c, 1.3))).toBe(true);
    const bright = new THREE.Color(3, 2, 1);
    expect(neutral(bright, 1.3, out)).toBe(out);
    expect(out.equals(neutral(bright, 1.3))).toBe(true);
  });

  it("turns every map sky back into itself through the tone mapping at the map's exposure", () => {
    for (const a of [DEFAULT_ATMOSPHERE, ...Object.values(ATMOSPHERES)]) {
      const sky = new THREE.Color(a.sky);
      const shown = neutral(behindNeutral(sky, a.exposure), a.exposure);
      expect(shown.r).toBeCloseTo(sky.r, 4);
      expect(shown.g).toBeCloseTo(sky.g, 4);
      expect(shown.b).toBeCloseTo(sky.b, 4);
    }
  });
});
