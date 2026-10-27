// The GLB textures' decoded images (images.ts, loadGltf): only a material's base colour texture
// is decoded; its image is released after its upload (once for a texture two materials share),
// and fetched again from the GLB, by the same URL, when three.js uploads the texture without it
// (a restored WebGL context, a changed parameter), one GLB at a time; a GLB that comes back other
// than it was gives nothing back, and one that has not come back in 20 s is given up. three.js
// calls `onUpdate` after an upload, which the tests call as it does. The bitmap stub keeps the
// bytes it was given, so a test sees which of the GLB's images came back; it is 8×4 but for an
// image whose last byte is 99 (16×16), and waits for `gate` before it answers.

import { Document, NodeIO } from '@gltf-transform/core';
import * as THREE from 'three';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ReleasedImage,
  imageReleased,
  onImagesRestored,
  restoreImages,
  trackImage,
} from '../src/scene/images';
import { disposeObject, loadGltf } from '../src/scene/loaders';
import { setAnisotropy } from '../src/scene/look';
import { blobUrl, installBrowserShims } from './helpers/node-gltf';

interface FakeBitmap {
  width: number;
  height: number;
  /** The bytes it was decoded from. */
  bytes: number[];
  options: unknown;
  close: ReturnType<typeof vi.fn>;
}

/** Image bytes the stub never decodes, told apart by their last byte. */
const IMAGE = (n: number) => Uint8Array.of(0x89, 0x50, 0x4e, 0x47, n);
/** The stub's size for an image ending in this byte. */
const LARGE = 99;

/**
 * A wall and a floor whose materials share one base colour texture (image 1, of `stoneImage`'s
 * bytes); the wall's also has normal, occlusion, metal-roughness and emissive textures (images
 * 2 to 5), and a crate has a base colour texture of its own (image 6).
 */
async function glb(stoneImage = IMAGE(1)): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const tex = (n: number, image = IMAGE(n)) =>
    doc.createTexture(`t${n}`).setImage(image).setMimeType('image/png');
  const stone = tex(1, stoneImage);
  const mesh = (
    name: string,
    material: ReturnType<Document['createMaterial']>
  ) => {
    const prim = doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        doc
          .createAccessor()
          .setType('VEC3')
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]))
          .setBuffer(buffer)
      )
      .setAttribute(
        'TEXCOORD_0',
        doc
          .createAccessor()
          .setType('VEC2')
          .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
          .setBuffer(buffer)
      )
      .setMaterial(material);
    return doc
      .createNode(name)
      .setMesh(doc.createMesh(name).addPrimitive(prim));
  };
  const scene = doc.createScene();
  scene.addChild(
    mesh(
      'wall',
      doc
        .createMaterial('wall')
        .setBaseColorTexture(stone)
        .setNormalTexture(tex(2))
        .setOcclusionTexture(tex(3))
        .setMetallicRoughnessTexture(tex(4))
        .setEmissiveTexture(tex(5))
    )
  );
  scene.addChild(
    mesh('floor', doc.createMaterial('floor').setBaseColorTexture(stone))
  );
  scene.addChild(
    mesh('crate', doc.createMaterial('crate').setBaseColorTexture(tex(6)))
  );
  return new NodeIO().writeBinary(doc);
}

/** The glTF image index of each test image, as written. */
async function imageIndex(bytes: Uint8Array, n: number): Promise<number> {
  const doc = await new NodeIO().readBinary(bytes);
  return doc
    .getRoot()
    .listTextures()
    .findIndex((t) => t.getName() === `t${n}`);
}

let decoded: FakeBitmap[] = [];
let bytes: Uint8Array;
let url: string;
let gate: Promise<void> = Promise.resolve();

beforeAll(async () => {
  installBrowserShims();
  bytes = await glb();
});

beforeEach(() => {
  decoded = [];
  gate = Promise.resolve();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (blob: Blob, options: unknown) => {
      const data = [...new Uint8Array(await blob.arrayBuffer())];
      const large = data.at(-1) === LARGE;
      const b: FakeBitmap = {
        width: large ? 16 : 8,
        height: large ? 16 : 4,
        bytes: data,
        options,
        close: vi.fn(),
      };
      decoded.push(b);
      await gate;
      return b;
    })
  );
  url = blobUrl(bytes);
});

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Mapped = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

async function load() {
  const gltf = await loadGltf(url);
  const mesh = (name: string) => gltf.scene.getObjectByName(name) as Mapped;
  return {
    root: gltf.scene,
    wall: mesh('wall'),
    stone: mesh('wall').material.map!,
    crate: mesh('crate').material.map!,
    floor: mesh('floor'),
  };
}

/** What three.js does after uploading `t`. */
const upload = (t: THREE.Texture) => t.onUpdate!(t);

/** Resolves when images next come back (or fail to). */
const restored = () =>
  new Promise<void>((resolve) => {
    const off = onImagesRestored(() => {
      off();
      resolve();
    });
  });

describe('loadGltf', () => {
  it("decodes a material's base colour texture alone", async () => {
    const { wall, floor, stone } = await load();
    const m = wall.material;
    expect(m.map).toBe(stone);
    expect(m.normalMap).toBeNull();
    expect(m.aoMap).toBeNull();
    expect(m.metalnessMap).toBeNull();
    expect(m.roughnessMap).toBeNull();
    expect(m.emissiveMap).toBeNull();
    expect(floor.material.map).toBe(stone);
    // The shared stone and the crate's own: nothing else was decoded.
    expect(decoded.map((d) => d.bytes.at(-1)).sort()).toEqual([1, 6]);
  });
});

describe('released images', () => {
  it('releases an image after its upload: one texture, one close, for the two materials that share it', async () => {
    const { stone, floor } = await load();
    expect(floor.material.map).toBe(stone);
    const bitmap = stone.image as FakeBitmap;
    expect(imageReleased(stone)).toBe(false);
    upload(stone);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(stone.image).toBeInstanceOf(ReleasedImage);
    expect(stone.image).toMatchObject({ width: 8, height: 4 });
    // An upload from now on allocates the texture without reading the closed bitmap.
    expect(stone.source.dataReady).toBe(false);
  });

  it('keeps an image three.js has not uploaded', async () => {
    const { crate } = await load();
    expect(imageReleased(crate)).toBe(false);
    expect((crate.image as FakeBitmap).close).not.toHaveBeenCalled();
  });

  it('fetches a released image again, by the same URL, when it is uploaded without it', async () => {
    const { stone, crate } = await load();
    upload(stone);
    upload(crate);
    const fetched = vi.spyOn(globalThis, 'fetch');
    const v = stone.version;
    // A restored context: three.js allocates both again, without data.
    upload(stone);
    upload(crate);
    await restored();
    // One fetch for the GLB's two images.
    expect(fetched.mock.calls.map((c) => c[0])).toEqual([url]);
    const stoneBack = stone.image as FakeBitmap;
    expect(stoneBack.bytes).toEqual([...IMAGE(1)]);
    expect((crate.image as FakeBitmap).bytes).toEqual([...IMAGE(6)]);
    // Decoded as GLTFLoader decodes it.
    expect(stoneBack.options).toEqual({
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    expect(stone.source.dataReady).toBe(true);
    expect(stone.version).toBeGreaterThan(v);
    // And released again after that upload.
    upload(stone);
    expect(stoneBack.close).toHaveBeenCalledTimes(1);
    expect(imageReleased(stone)).toBe(true);
  });

  it('asks again after a reload, for a release since', async () => {
    const { stone } = await load();
    upload(stone);
    upload(stone);
    await restored();
    upload(stone);
    upload(stone);
    await restored();
    expect((stone.image as FakeBitmap).bytes).toEqual([...IMAGE(1)]);
  });

  it('uploads a released texture with a new anisotropy once its image is back, drawn as it was until then', async () => {
    const { stone, crate } = await load();
    upload(stone);
    const v = stone.version;
    setAnisotropy(stone, 8);
    expect(stone.anisotropy).toBe(8);
    expect(stone.version).toBe(v);
    await restored();
    expect(stone.version).toBeGreaterThan(v);
    expect(imageReleased(stone)).toBe(false);
    // A texture that holds its image is marked at once.
    const c = crate.version;
    setAnisotropy(crate, 8);
    expect(crate.version).toBeGreaterThan(c);
  });

  it('restoreImages asks for every released texture under the roots and resolves once they are back', async () => {
    const { root, stone, crate } = await load();
    upload(stone);
    await restoreImages([root]);
    expect(imageReleased(stone)).toBe(false);
    expect((stone.image as FakeBitmap).bytes).toEqual([...IMAGE(1)]);
    // The crate was never released: nothing to ask for.
    expect(decoded).toHaveLength(3);
    expect(imageReleased(crate)).toBe(false);
  });

  it('gives a texture disposed while its image decodes nothing, and frees the image and what it never uploaded', async () => {
    const { root, stone, crate } = await load();
    const crateBitmap = crate.image as FakeBitmap;
    upload(stone);
    const held = deferred();
    gate = held.promise;
    upload(stone);
    // The stone's image is decoding again.
    await vi.waitFor(() => expect(decoded).toHaveLength(3));
    disposeObject(root);
    expect(crateBitmap.close).toHaveBeenCalledTimes(1);
    held.resolve();
    await restored();
    expect(imageReleased(stone)).toBe(true);
    // The late image is freed, not given to the disposed texture.
    expect(decoded[2].bytes).toEqual([...IMAGE(1)]);
    expect(decoded[2].close).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing for a texture disposed before its GLB is fetched', async () => {
    const { root, stone } = await load();
    upload(stone);
    const fetched = vi.spyOn(globalThis, 'fetch');
    upload(stone);
    disposeObject(root);
    await restored();
    expect(fetched).not.toHaveBeenCalled();
    expect(decoded).toHaveLength(2);
  });

  it('fetches and decodes one GLB at a time', async () => {
    const other = blobUrl(bytes);
    const a = await load();
    url = other;
    const b = await load();
    upload(a.stone);
    upload(b.stone);
    const held = deferred();
    const fetch = globalThis.fetch;
    const fetched = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        if (input === other) await held.promise;
        return fetch(input);
      });
    upload(b.stone);
    upload(a.stone);
    await vi.waitFor(() => expect(fetched).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    // The other GLB waits for the first one's images.
    expect(fetched.mock.calls.map((c) => c[0])).toEqual([other]);
    expect(imageReleased(b.stone)).toBe(true);
    held.resolve();
    await vi.waitFor(() => expect(fetched).toHaveBeenCalledTimes(2));
    expect(imageReleased(b.stone)).toBe(false);
    await vi.waitFor(() => expect(imageReleased(a.stone)).toBe(false));
  });

  it('gives nothing back from a GLB whose image is another size now, and warns once', async () => {
    const { root, stone, crate } = await load();
    upload(stone);
    upload(crate);
    // The same layout and byte counts; the stone's image decodes 16×16.
    const changed = await glb(IMAGE(LARGE));
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(changed as Uint8Array<ArrayBuffer>)
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await restoreImages([root]);
    expect(imageReleased(stone)).toBe(true);
    // Nothing of that GLB is given back, though the crate's image is its own size.
    expect(imageReleased(crate)).toBe(true);
    for (const d of decoded.slice(2)) expect(d.close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('16×16, was 8×4');
    await restoreImages([root]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('decodes nothing from a GLB whose image is of another encoded size now', async () => {
    const { root, stone } = await load();
    upload(stone);
    const changed = await glb(Uint8Array.of(...IMAGE(1), 0, 0));
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(changed as Uint8Array<ArrayBuffer>)
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await restoreImages([root]);
    expect(imageReleased(stone)).toBe(true);
    expect(decoded).toHaveLength(2);
    expect(String(warn.mock.calls[0][0])).toContain('7 bytes, was 5');
  });

  it('logs a GLB that does not come back and leaves its textures without', async () => {
    const { root, stone } = await load();
    upload(stone);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await restoreImages([root]);
    expect(imageReleased(stone)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('HTTP 404');
  });

  it('gives up on a GLB that does not answer in 20 s, its fetch aborted, and goes on to the next', async () => {
    const hung = blobUrl(bytes);
    const first = url;
    const a = await load();
    url = hung;
    const b = await load();
    upload(a.stone);
    upload(b.stone);
    const fetch = globalThis.fetch;
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetched = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        if (input !== hung) return fetch(input);
        // Never settles, aborted or not.
        signals.push(init?.signal);
        return new Promise<Response>(() => {});
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    upload(b.stone);
    upload(a.stone);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetched.mock.calls.map((c) => c[0])).toEqual([hung]);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    vi.useRealTimers();
    // The next GLB is fetched and its image given back; the hung one's texture keeps its stand-in.
    await vi.waitFor(() => expect(imageReleased(a.stone)).toBe(false));
    expect(fetched.mock.calls.map((c) => c[0])).toEqual([hung, first]);
    expect(imageReleased(b.stone)).toBe(true);
    expect(b.stone.image).toMatchObject({ width: 8, height: 4 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(hung);
    expect(String(warn.mock.calls[0][0])).toContain('no answer in 20 s');
  });

  it('gives up on a GLB whose body does not end in 20 s', async () => {
    const { root, stone } = await load();
    upload(stone);
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal;
      // Headers, then a body that never ends.
      return new Response(new ReadableStream({ start() {} }));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    const restoring = restoreImages([root]).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await restoring;
    expect(signal?.aborted).toBe(true);
    expect(imageReleased(stone)).toBe(true);
    expect(decoded).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('no answer in 20 s');
  });

  it('cuts the right image out of the GLB', async () => {
    const t = new THREE.Texture({ width: 8, height: 4, close() {} });
    trackImage(t, { url, image: await imageIndex(bytes, 6) });
    upload(t);
    await restoreImages([
      new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ map: t })
      ),
    ]);
    expect((t.image as FakeBitmap).bytes).toEqual([...IMAGE(6)]);
  });
});
