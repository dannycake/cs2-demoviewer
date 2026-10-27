// The tiling detail texture: a grey noise multiplied into the diffuse colour of opaque world
// materials, projected from world space. Compiled here the way the renderer does it, by
// handing `onBeforeCompile` a fresh copy of the material's shader source.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DETAIL_MULTIPLY, attachDetail, hasDetail } from '../src/scene/detail';
import { applyLook, type LookOptions } from '../src/scene/look';

type ShaderObject = Parameters<THREE.Material['onBeforeCompile']>[0];

/** What the renderer passes to `onBeforeCompile` for a material of shader `lib`. */
function compile(m: THREE.Material, lib: 'lambert' | 'basic'): ShaderObject {
  const src = THREE.ShaderLib[lib];
  const shader = {
    uniforms: THREE.UniformsUtils.clone(src.uniforms),
    vertexShader: src.vertexShader,
    fragmentShader: src.fragmentShader,
  } as ShaderObject;
  m.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
  return shader;
}

const count = (s: string, part: string) => s.split(part).length - 1;

describe('attachDetail', () => {
  it('injects the detail multiply once however often it is attached', () => {
    const m = new THREE.MeshLambertMaterial();
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    attachDetail(m, a);
    attachDetail(m, b, 2);
    const s = compile(m, 'lambert');
    expect(count(s.fragmentShader, DETAIL_MULTIPLY)).toBe(1);
    expect(count(s.fragmentShader, 'uniform sampler2D detailMap;')).toBe(1);
    expect(count(s.vertexShader, 'vDetailPos =')).toBe(1);
    // The last call's texture and scale win.
    expect(s.uniforms.detailMap.value).toBe(b);
    expect(s.uniforms.detailScale.value).toBe(2);
    expect(hasDetail(m)).toBe(true);
  });

  it('fails loudly on a shader without the chunks it edits, rather than drawing without them', () => {
    const m = new THREE.MeshLambertMaterial();
    attachDetail(m, new THREE.Texture());
    const src = THREE.ShaderLib.lambert;
    const moved = {
      uniforms: THREE.UniformsUtils.clone(src.uniforms),
      vertexShader: src.vertexShader,
      fragmentShader: src.fragmentShader.replace(
        '#include <color_fragment>',
        ''
      ),
    } as ShaderObject;
    expect(() =>
      m.onBeforeCompile(moved, null as unknown as THREE.WebGLRenderer)
    ).toThrow('shader hook: expected one #include <color_fragment>');
  });

  it('multiplies after the texture and vertex colour, before lighting', () => {
    const m = new THREE.MeshLambertMaterial();
    attachDetail(m, new THREE.Texture());
    const f = compile(m, 'lambert').fragmentShader;
    const at = f.indexOf(DETAIL_MULTIPLY);
    expect(at).toBeGreaterThan(f.indexOf('#include <color_fragment>'));
    expect(at).toBeLessThan(f.indexOf('#include <lights_fragment_begin>'));
  });

  it('works on the unlit material too and keys its program apart', () => {
    const m = new THREE.MeshBasicMaterial();
    const plain = new THREE.MeshBasicMaterial();
    attachDetail(m, new THREE.Texture());
    expect(count(compile(m, 'basic').fragmentShader, DETAIL_MULTIPLY)).toBe(1);
    expect(m.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
  });

  it('a recompile of the same material starts from clean source each time', () => {
    const m = new THREE.MeshLambertMaterial();
    attachDetail(m, new THREE.Texture());
    compile(m, 'lambert');
    expect(count(compile(m, 'lambert').fragmentShader, DETAIL_MULTIPLY)).toBe(
      1
    );
  });
});

describe('applyLook with a detail texture', () => {
  const LIT: LookOptions = {
    lit: true,
    smoothNormals: true,
    maxAnisotropy: 8,
  };

  function tri(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3)
    );
    return g;
  }

  function world() {
    const root = new THREE.Group();
    const opaque = new THREE.Mesh(tri(), new THREE.MeshStandardMaterial());
    const cutout = new THREE.Mesh(
      tri(),
      new THREE.MeshStandardMaterial({ alphaTest: 0.5 })
    );
    const glass = new THREE.Mesh(
      tri(),
      new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 })
    );
    root.add(opaque, cutout, glass);
    return { root, opaque, cutout, glass };
  }

  it('details only the opaque materials', () => {
    const w = world();
    const tex = new THREE.Texture();
    applyLook(w.root, { ...LIT, detail: tex });
    expect(hasDetail(w.opaque.material as THREE.Material)).toBe(true);
    expect(hasDetail(w.cutout.material as THREE.Material)).toBe(false);
    expect(hasDetail(w.glass.material as THREE.Material)).toBe(false);
  });

  it('a look without the texture drops it again', () => {
    const w = world();
    applyLook(w.root, { ...LIT, detail: new THREE.Texture() });
    applyLook(w.root, LIT);
    expect(hasDetail(w.opaque.material as THREE.Material)).toBe(false);
  });
});
