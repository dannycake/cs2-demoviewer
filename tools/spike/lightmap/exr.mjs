// Spike: read an S2V-exported EXR under Node with three's EXRLoader.
// Returns { width, height, data } with data a Float32Array of RGBA, rows top-down (row 0 is
// the image's first line, as in the PNGs and in glTF UV space where v = 0 is the top).
import fs from 'node:fs';
import { FloatType } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

export function readExr(file) {
  const buf = fs.readFileSync(file);
  const loader = new EXRLoader().setDataType(FloatType);
  const { width, height, data, format } = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (data.length !== width * height * 4) throw new Error(`${file}: expected RGBA, got ${data.length / (width * height)} channels (format ${format})`);
  // EXRLoader writes bottom-up (GL convention); flip back to the file's top-down order.
  const row = width * 4, tmp = new Float32Array(row);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row, b = (height - 1 - y) * row;
    tmp.set(data.subarray(a, a + row)); data.copyWithin(a, b, b + row); data.set(tmp, b);
  }
  return { width, height, data };
}
