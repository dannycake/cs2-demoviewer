// Lets the browser-side GLB loaders run under vitest's node environment. GLTFLoader fetches
// the file (node's fetch serves `blob:` URLs), reports progress with `ProgressEvent`, finds
// `URL` on `self` and decodes each texture with `createImageBitmap`, the last three of
// which node lacks. The
// bitmap stub returns an undecoded 1x1 bitmap, so a texture still reaches its material
// without any image codec.

import { readFile } from 'node:fs/promises';

export function installBrowserShims(): void {
  const g = globalThis as {
    self?: unknown;
    createImageBitmap?: unknown;
    ProgressEvent?: unknown;
  };
  g.self ??= globalThis;
  g.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
  g.ProgressEvent ??= class ProgressEvent extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(
      type: string,
      init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}
    ) {
      super(type);
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  };
}

/** A `blob:` URL that `fetch` (and so GLTFLoader) can read. */
export function blobUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'model/gltf-binary' })
  );
}

export async function fileUrl(path: string): Promise<string> {
  return blobUrl(new Uint8Array(await readFile(path)));
}
