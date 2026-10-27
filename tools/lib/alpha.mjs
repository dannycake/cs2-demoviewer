// Textures resized without sharp's premultiplied alpha. To resize an image with alpha, sharp
// multiplies the colour by alpha and divides it back out after, so where alpha is near zero
// the colour comes back as black-and-white noise, and where it is zero, black. CS2 keeps other
// data in the alpha of many opaque materials' colour textures (Nuke's crates, pool rims and
// sign boards are mostly alpha 0), so they shipped speckled or black; cutouts came out with
// dark fringes, filtering their edges against that black. fitTextures resizes every texture
// first, colour and alpha apart, so the textureCompress that follows only encodes.
import sharp from 'sharp';

/** The size textureCompress's `resize: limit` gives a texture of `size` (gltf-transform's fitWithin). */
export function fitWithin([w, h], [maxW, maxH]) {
  if (w <= maxW && h <= maxH) return [w, h];
  if (w > maxW) {
    h = Math.floor(h * (maxW / w));
    w = maxW;
  }
  if (h > maxH) {
    w = Math.floor(w * (maxH / h));
    h = maxH;
  }
  return [w, h];
}

/** Textures some MASK or BLEND material reads as its base colour: the only alpha drawn. */
export function alphaTextures(doc) {
  const drawn = new Set();
  for (const m of doc.getRoot().listMaterials()) {
    const t = m.getBaseColorTexture();
    if (t && m.getAlphaMode() !== 'OPAQUE') drawn.add(t);
  }
  return drawn;
}

/**
 * Gives every fully transparent pixel of `data` (RGBA, row-major, changed in place) the colour
 * of the nearest visible pixel, so that filtering at a cutout's edge never blends in colour
 * nobody painted. An image with nothing visible is left as it is.
 */
export function bleed(data, width, height) {
  const n = width * height;
  const from = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] > 0) {
      from[i] = i;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
      if (j < 0 || j >= n || from[j] !== -1) continue;
      from[j] = from[i];
      for (let c = 0; c < 3; c++) data[j * 4 + c] = data[from[i] * 4 + c];
      queue[tail++] = j;
    }
  }
}

// One raw channel comes back as three sRGB ones unless told to stay grey.
const resizeRaw = (buf, width, height, channels, w, h) =>
  sharp(buf, { raw: { width, height, channels } })
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace(channels === 1 ? 'b-w' : 'srgb')
    .raw()
    .toBuffer();

/** The colour (RGB) and the alpha of `n` RGBA pixels, apart. */
function splitAlpha(data, n) {
  const colour = Buffer.alloc(n * 3);
  const alpha = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    colour[i * 3] = data[i * 4];
    colour[i * 3 + 1] = data[i * 4 + 1];
    colour[i * 3 + 2] = data[i * 4 + 2];
    alpha[i] = data[i * 4 + 3];
  }
  return { colour, alpha };
}

/**
 * `data` (RGBA, `width`×`height`) resized to `w`×`h`, colour and alpha apart, as RGBA. Bleed
 * the colour under transparent pixels first when their edges will be drawn.
 */
export async function resizeApart(data, width, height, w, h) {
  const { colour, alpha } = splitAlpha(data, width * height);
  const rgb = await resizeRaw(colour, width, height, 3, w, h);
  const a = await resizeRaw(alpha, width, height, 1, w, h);
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = a[i];
  }
  return out;
}

/**
 * `image` (any format sharp reads) fitted within `limit` as a PNG, its colour resized on its
 * own: with `keepAlpha` the alpha is resized apart and joined back, the colour under its
 * transparent pixels bled first; without, the alpha is dropped.
 */
export async function fitImage(image, limit, keepAlpha) {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [w, h] = fitWithin([info.width, info.height], limit);
  if (!keepAlpha) {
    const rgb = await resizeRaw(splitAlpha(data, info.width * info.height).colour, info.width, info.height, 3, w, h);
    return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  }
  bleed(data, info.width, info.height);
  const out = await resizeApart(data, info.width, info.height, w, h);
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/**
 * Fits every texture of `doc` within `limit` with fitImage, keeping alpha only on
 * `alphaTextures`. Returns how many were fitted and how many of those lost an alpha channel.
 */
export async function fitTextures(doc, limit) {
  const drawn = alphaTextures(doc);
  let fitted = 0;
  let alphaDropped = 0;
  for (const t of doc.getRoot().listTextures()) {
    const image = t.getImage();
    if (!image) continue;
    const keepAlpha = drawn.has(t);
    if (!keepAlpha && (await sharp(image).metadata()).hasAlpha) alphaDropped++;
    t.setImage(await fitImage(image, limit, keepAlpha)).setMimeType('image/png');
    fitted++;
  }
  return { fitted, alphaDropped };
}
