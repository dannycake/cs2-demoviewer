// The EXRs Source2Viewer-CLI exports (ZIP-compressed scanlines, channels A, B, G, R) read under
// Node with three.js's EXRLoader, from the lightmap spike (tools/spike/lightmap/exr.mjs).
import fs from 'node:fs';
import { FloatType } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

/**
 * `file` as `{ width, height, data }`, `data` RGBA float32 with rows top-down: row 0 is the
 * image's first line, as in a PNG. EXRLoader writes them bottom-up (GL's order), so they are
 * flipped back here.
 */
export function readExr(file) {
  const buf = fs.readFileSync(file);
  const loader = new EXRLoader().setDataType(FloatType);
  const { width, height, data, format } = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (data.length !== width * height * 4) {
    throw new Error(`${file}: expected RGBA, got ${data.length / (width * height)} channels (format ${format})`);
  }
  const row = width * 4;
  const tmp = new Float32Array(row);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row;
    const b = (height - 1 - y) * row;
    tmp.set(data.subarray(a, a + row));
    data.copyWithin(a, b, b + row);
    data.set(tmp, b);
  }
  return { width, height, data };
}
