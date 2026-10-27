// The decoded images of the GLB textures (the world's, its doors', the players', the weapons',
// the first-person arms'), released once they are on the GPU. three.js keeps a texture's image
// (an ImageBitmap, or an <img> where GLTFLoader decodes without createImageBitmap) for as long
// as the texture lives though it never reads it again, and on an iPhone the world's and the
// players' images held the tab past what iOS allows. A tracked texture (`trackImage`) drops its
// image after its upload (three.js calls `onUpdate`), keeping a stand-in of its size whose
// source is not `dataReady`: an upload three.js makes again (a lost WebGL context restored, a
// parameter changed) then allocates the texture without reading a closed bitmap, and asks for
// the image again (`requestImage`). The GLB it came from is fetched again by the same versioned
// URL (the HTTP cache answers it: `?v=` URLs are immutable), the image cut out of it and decoded
// as GLTFLoader decodes it, and the texture uploaded from it, then released again. One GLB is
// fetched and decoded at a time, its bytes let go of before its images decode, so a restored
// context does not hold every model's file at once. A GLB that comes back other than it was (the
// server does not check `?v=`: a redeploy and a cache miss) gives nothing back, and one that has
// not come back in 20 s is given up (its fetch aborted), so it does not hold the others.

import * as THREE from 'three';

/** Where a texture's image is: the GLB at `url` and the index of the image in its `images`. */
export interface ImageOrigin {
  url: string;
  image: number;
  /** The image's encoded size in the GLB, which the GLB fetched again must have too. */
  bytes?: number;
}

/** The stand-in for a released image: its size, which an upload without data allocates. */
export class ReleasedImage {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

interface Origin extends ImageOrigin {
  /** Decoded as an ImageBitmap (else as an <img>), as GLTFLoader did. */
  bitmap: boolean;
}

/** The textures waiting for their images from one GLB, by image index. */
interface Batch {
  url: string;
  images: Map<number, Set<THREE.Texture>>;
  done: Promise<void>;
  finish: () => void;
}

type Decoded = ImageBitmap | HTMLImageElement;

/** A GLB fetched again that is not the one its textures came from. */
class ChangedGlb extends Error {}

/** How many GLBs are fetched and decoded again at once. */
const RELOADS_AT_ONCE = 1;
/** How long the fetch of a GLB and the read of its body may take before they are given up. */
const RELOAD_TIMEOUT_MS = 20_000;

const origins = new WeakMap<THREE.Texture, Origin>();
/** The batch each texture waits in, until its image is back (or failed to come back). */
const waiting = new WeakMap<THREE.Texture, Batch>();
/** Batches not started yet, by GLB URL, in the order asked; a request joins its URL's. */
const queue = new Map<string, Batch>();
let reloading = 0;
/** The GLBs found changed, warned about once each. */
const changed = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Releases `texture`'s image after each of its uploads from now on; `origin` says where the
 * image is fetched from again. A texture without an image is left as it is. A texture shared by
 * several materials is one texture: released once, after its upload. (A clone made of it later
 * shares its image but is not tracked: none is made.)
 */
export function trackImage(texture: THREE.Texture, origin: ImageOrigin): void {
  if (origins.has(texture)) return;
  const image = texture.image as { width?: unknown; close?: unknown } | null;
  if (!image || typeof image.width !== 'number') return;
  origins.set(texture, {
    ...origin,
    bitmap: typeof image.close === 'function',
  });
  texture.onUpdate = uploaded;
  texture.addEventListener('dispose', disposed);
}

/** Whether `texture`'s image was released (and is not back yet). */
export function imageReleased(texture: THREE.Texture): boolean {
  return texture.image instanceof ReleasedImage;
}

/**
 * Marks `texture` for upload, as `needsUpdate` does: now while it holds its image; once its
 * image is back when it was released, the texture drawn as it was until then (an upload now
 * would allocate it empty, drawn black until the image came).
 */
export function needsUpload(texture: THREE.Texture): void {
  if (imageReleased(texture) && origins.has(texture))
    void requestImage(texture);
  else texture.needsUpdate = true;
}

/**
 * Asks again for the image of every released texture drawn under `roots` (by a mesh's, a
 * sprite's or a line's material); resolves once each is back or failed (logged).
 */
export function restoreImages(roots: readonly THREE.Object3D[]): Promise<void> {
  const loads: Promise<void>[] = [];
  for (const t of texturesUnder(roots))
    if (imageReleased(t) && origins.has(t)) loads.push(requestImage(t));
  return Promise.all(loads).then(() => {});
}

/** Calls `fn` each time images came back (or failed to), so a paused view draws them. */
export function onImagesRestored(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * three.js uploaded `texture`: from its image, which is released now; or, its image released
 * before, without data (the texture is allocated, empty), so the image is asked for again.
 */
function uploaded(texture: THREE.Texture): void {
  if (imageReleased(texture)) void requestImage(texture);
  else release(texture);
}

/** The size of an image as three.js reads it: an <img>'s own. */
function sizeOf(image: {
  width: number;
  height: number;
  naturalWidth?: number;
  naturalHeight?: number;
}): { width: number; height: number } {
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  };
}

/** Puts the stand-in in place of `texture`'s image and frees the image. */
function release(texture: THREE.Texture): void {
  const image = texture.image as
    (Parameters<typeof sizeOf>[0] & { close?: () => void }) | null;
  if (!image || image instanceof ReleasedImage) return;
  const { width, height } = sizeOf(image);
  texture.image = new ReleasedImage(width, height);
  texture.source.dataReady = false;
  image.close?.();
}

/** A disposed texture waits no more; an image it never uploaded is freed now. */
function disposed(e: { target: unknown }): void {
  const texture = e.target as THREE.Texture;
  const batch = waiting.get(texture);
  if (batch) {
    for (const textures of batch.images.values()) textures.delete(texture);
    waiting.delete(texture);
  }
  release(texture);
}

/**
 * Asks for `texture`'s image again, with every other image asked for from its GLB before the
 * GLB's fetch starts. Resolves once it is back or failed.
 */
function requestImage(texture: THREE.Texture): Promise<void> {
  const had = waiting.get(texture);
  if (had) return had.done;
  const origin = origins.get(texture)!;
  let batch = queue.get(origin.url);
  if (!batch) {
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    batch = { url: origin.url, images: new Map(), done, finish };
    // Started after the current task, so what it asks for in one go is fetched in one go.
    if (!queue.size) queueMicrotask(pump);
    queue.set(origin.url, batch);
  }
  let textures = batch.images.get(origin.image);
  if (!textures) batch.images.set(origin.image, (textures = new Set()));
  textures.add(texture);
  waiting.set(texture, batch);
  return batch.done;
}

/** Starts the batches asked for, `RELOADS_AT_ONCE` at a time, in the order asked. */
function pump(): void {
  while (reloading < RELOADS_AT_ONCE && queue.size) {
    const [url, batch] = queue.entries().next().value!;
    queue.delete(url);
    reloading++;
    void reload(batch).finally(() => {
      reloading--;
      pump();
    });
  }
}

/** One image's decode for the textures of one source. */
interface Decoding {
  index: number;
  source: THREE.Texture['source'];
  textures: THREE.Texture[];
  image: Decoded;
}

/**
 * Fetches `batch`'s GLB and gives every texture still waiting in it its image, decoded once per
 * texture source, marked for upload; when the GLB is not the one the textures came from (an
 * image of another encoded size or decoded size, or none at that index), none, and it is warned
 * about once. A GLB that does not load is logged; the textures without their image stay so
 * (drawn black).
 */
async function reload(batch: Batch): Promise<void> {
  const decodings: Decoding[] = [];
  let failure: unknown = null;
  try {
    if ([...batch.images.values()].some((t) => t.size)) {
      // Cut out, so the GLB's bytes are let go of before any image decodes.
      const blobs = cutImages(await fetchGlb(batch.url), batch);
      // Settled, every decode, so none lands after a failure has closed the others.
      const decoded = await Promise.allSettled(
        [...batch.images].map(async ([index, textures]) => {
          for (const [source, of] of releasedSources(textures)) {
            const image = await decode(
              blobs.get(index)!,
              origins.get(of[0])!.bitmap
            );
            decodings.push({ index, source, textures: of, image });
          }
        })
      );
      for (const r of decoded) if (r.status === 'rejected') throw r.reason;
      for (const d of decodings) checkSize(d);
      for (const d of decodings) give(batch, d);
      decodings.length = 0;
    }
    // Given their image by another batch meanwhile: uploaded from that one.
    for (const textures of batch.images.values())
      for (const t of textures)
        if (!imageReleased(t) && waiting.get(t) === batch) {
          waiting.delete(t);
          t.needsUpdate = true;
        }
  } catch (e) {
    failure = e;
    for (const d of decodings) close(d.image);
  }
  if (failure instanceof ChangedGlb) {
    if (!changed.has(batch.url)) {
      changed.add(batch.url);
      console.warn(
        `${batch.url} is not the file its textures came from (${failure.message}); ` +
          'they are drawn without their images until the page is reloaded'
      );
    }
  } else if (failure !== null)
    console.warn(
      `${batch.url}: its textures' images did not load again ` +
        `(${failure instanceof Error ? failure.message : String(failure)}); ` +
        'they are drawn without them'
    );
  for (const textures of batch.images.values())
    for (const t of textures) if (waiting.get(t) === batch) waiting.delete(t);
  batch.finish();
  for (const fn of listeners) fn();
}

/**
 * The bytes at `url`; a failure when the fetch and the read of its body have not ended in
 * `RELOAD_TIMEOUT_MS`, which aborts them.
 */
async function fetchGlb(url: string): Promise<ArrayBuffer> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Failed first, so the failure names the timeout rather than the abort.
      reject(new Error(`no answer in ${RELOAD_TIMEOUT_MS / 1000} s`));
      abort.abort();
    }, RELOAD_TIMEOUT_MS);
  });
  const read = (async () => {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** `textures` whose image is still released, by their source. */
function releasedSources(
  textures: Set<THREE.Texture>
): Map<THREE.Texture['source'], THREE.Texture[]> {
  const sources = new Map<THREE.Texture['source'], THREE.Texture[]>();
  for (const t of textures) {
    if (!imageReleased(t)) continue;
    const of = sources.get(t.source);
    if (of) of.push(t);
    else sources.set(t.source, [t]);
  }
  return sources;
}

/** Throws `ChangedGlb` when `d`'s image is not the size of the stand-in it replaces. */
function checkSize(d: Decoding): void {
  const was = d.source.data;
  if (!(was instanceof ReleasedImage)) return;
  const { width, height } = sizeOf(d.image);
  if (width !== was.width || height !== was.height)
    throw new ChangedGlb(
      `image ${d.index} is ${width}×${height}, was ${was.width}×${was.height}`
    );
}

/**
 * Puts `d`'s image in its source, unless the source has one again (another batch's), and marks
 * the textures of `batch` still waiting for it for upload; they wait no more.
 */
function give(batch: Batch, d: Decoding): void {
  const textures = batch.images.get(d.index)!;
  // Not those disposed meanwhile (they left the batch).
  const live = d.textures.filter((t) => textures.has(t));
  if (live.length && d.source.data instanceof ReleasedImage) {
    d.source.data = d.image;
    d.source.dataReady = true;
  } else close(d.image);
  for (const t of live) {
    if (waiting.get(t) === batch) waiting.delete(t);
    t.needsUpdate = true;
  }
}

function close(image: Decoded): void {
  (image as { close?: () => void }).close?.();
}

interface GlbJson {
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number }[];
}

/**
 * The images of `data` (a GLB) that `batch` asks for, each a Blob of its own type copied out of
 * the binary chunk. Throws `ChangedGlb` for an image missing or of another encoded size than
 * its textures recorded.
 */
function cutImages(data: ArrayBuffer, batch: Batch): Map<number, Blob> {
  const view = new DataView(data);
  if (data.byteLength < 12 || view.getUint32(0, true) !== 0x46546c67)
    throw new Error('not a GLB');
  let json: GlbJson | null = null;
  let bin: Uint8Array | null = null;
  for (let at = 12; at + 8 <= data.byteLength;) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const chunk = new Uint8Array(data, at + 8, length);
    if (type === 0x4e4f534a)
      json = JSON.parse(new TextDecoder().decode(chunk)) as GlbJson;
    else if (type === 0x004e4942) bin = chunk;
    at += 8 + length;
  }
  if (!json || !bin) throw new Error('a GLB without its JSON or its binary');
  const blobs = new Map<number, Blob>();
  for (const [index, textures] of batch.images) {
    if (!textures.size) continue;
    const image = json.images?.[index];
    const bv =
      image?.bufferView === undefined
        ? undefined
        : json.bufferViews?.[image.bufferView];
    if (!image || !bv || (bv.buffer ?? 0) !== 0)
      throw new ChangedGlb(`no image ${index} in it`);
    for (const t of textures) {
      const bytes = origins.get(t)!.bytes;
      if (bytes !== undefined && bytes !== bv.byteLength)
        throw new ChangedGlb(
          `image ${index} is ${bv.byteLength} bytes, was ${bytes}`
        );
    }
    const start = bv.byteOffset ?? 0;
    blobs.set(
      index,
      new Blob([bin.slice(start, start + bv.byteLength)], {
        type: image.mimeType ?? '',
      })
    );
  }
  return blobs;
}

/**
 * `blob` decoded as GLTFLoader decodes a GLB's image: an ImageBitmap with its alpha and colours
 * as they are, or an <img> where it used one.
 */
async function decode(blob: Blob, bitmap: boolean): Promise<Decoded> {
  if (bitmap)
    return createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Every texture of the materials drawn under `roots`. */
function texturesUnder(roots: readonly THREE.Object3D[]): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>();
  for (const root of roots)
    root.traverse((o) => {
      const m = (o as { material?: THREE.Material | THREE.Material[] })
        .material;
      if (!m) return;
      for (const material of Array.isArray(m) ? m : [m])
        for (const v of Object.values(material))
          if ((v as THREE.Texture | null)?.isTexture) textures.add(v);
    });
  return textures;
}
