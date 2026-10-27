// CS2's baked light as the lightmap the viewer ships (the M2a spike, tools/spike/lightmap/:
// bake.mjs, rgbm.mjs, chart.mjs; findings D1–D5 in the m2a plan).
//
// rip-lighting.sh exports raw/<map>/lightmaps/: irradiance.exr (8192², float), and on maps whose
// sun is baked (entities.mjs sunOf().baked) direct_light_shadows.png. irradiance holds bounce and
// sky light but not the sun's direct light, which the engine adds at runtime from the shadow
// texture (1 = shadowed). lightmapInputs says what there is to bake (null: no bake, the map
// builds as before). The pipeline, at the full size and then at LIGHTMAP_PARAMS.size:
//   readHdr → bakeSun (baked-sun maps only) → coverage → downscale → chooseRange (of the
//   covered texels, before padding) → dilate → encodeLightmap → lightmapWebp
// The lightmap UV is TEXCOORD_2 where a primitive has one, else TEXCOORD_1, in atlas space with
// no transform (D1); `m_vLightmapUvScale` is not applied. Image row 0 is v = 0. fitsCharts tells
// a real lightmap UV from a material UV that sits in TEXCOORD_1 (one Mirage crate), and
// dropLightmapUv takes such a UV off.
//
// The encoding: rgb = sqrt(min(light / range, 1)), 8 bits a channel, rounded jointly so the hue
// holds (lightBytes; COLOR_0's vertex light is the same at 6 bits), in a lossless RGB WebP. The
// viewer squares it and multiplies by the range. It replaced RGBM in lossy WebP (rgb · a ·
// range), whose 4:2:0 chroma mixed texels of different multipliers: pink, violet and green
// patches on grey walls (Nuke's lobby, Mirage's palace pillar), hue off by up to a stop per
// texel (p99) at any quality; lossless RGBM was 2.1 MB a map.
import fs from 'node:fs';
import path from 'node:path';
import { Primitive } from '@gltf-transform/core';
import sharp from 'sharp';
import { readExr } from './exr.mjs';

/**
 * The tier the user approved (H2: lightmap on large surfaces, vertex light on the rest; Task 1b):
 * a `size`² lightmap, `dilatePasses` rings of padding around every chart at that size, so
 * bilinear filtering never reads black at a chart's edge, and `bits`-bit sqrt light (lossless).
 */
export const LIGHTMAP_PARAMS = Object.freeze({ size: 1024, dilatePasses: 4, bits: 8 });

/** The light ranges chooseRange picks from (D5: Mirage 8, Nuke 16). */
const RANGES = Object.freeze([2, 4, 8, 16, 32, 64]);

/** The share of covered texels allowed above the range: chooseRange takes the p99.9. */
const RANGE_PERCENTILE = 0.999;

/**
 * fitsCharts (D1): triangles covering at least `minTexels` texels of debug_chart_color count;
 * a UV with at least `minTriangles` of them, under `minInside` of which fall inside one chart,
 * is not a lightmap UV. Real lightmap UVs score >= 80 %, the Mirage crate's material UV 5 %.
 */
const CHART_TEST = Object.freeze({ minTexels: 4, minTriangles: 20, minInside: 0.25, tolerance: 24 });

/** Barycentric slack: texel centres on an edge count as inside. */
const EDGE = 1e-6;

/**
 * @typedef {{ width: number, height: number, data: Float32Array }} HdrImage
 *   RGB, `data[3 · (y · width + x) + c]`, row 0 at v = 0.
 * @typedef {{ width: number, height: number, data: Uint8Array }} Shadow
 *   one channel of direct_light_shadows, 255 = fully shadowed.
 * @typedef {{ width: number, height: number, data: Uint8Array }} Chart
 *   debug_chart_color as RGB, one flat colour per chart.
 */

/**
 * What rip-lighting.sh exported into `dir` (raw/<map>/lightmaps/) for the bake, from its
 * lightmaps.json, or null when there is nothing to bake. Null means no bake: the map builds as
 * it did before. A half-set is never baked, so it is null without the export, without
 * `irradiance` (the map's VPK has no baked light), without `debug_chart_color` (fitsCharts
 * could not catch a material UV), and when the sun is baked but `direct_light_shadows` is
 * missing (the sun could go neither into the lightmap nor, unshadowed, to the runtime).
 * - `irradiance`, `chart`: file paths;
 * - `shadow`: direct_light_shadows.png, or null when the sun is dynamic (sunOf().baked false,
 *   de_cache: the engine draws it, and the lightmap stays irradiance only);
 * - `probes`: whether the probe atlas and its _dlshd slices are there.
 * @returns {{ irradiance: string, shadow: string | null, chart: string, probes: boolean } | null}
 */
export function lightmapInputs(dir) {
  const file = path.join(dir, 'lightmaps.json');
  if (!fs.existsSync(file)) return null;
  const { sunBaked, textures } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const has = (t) => Array.isArray(textures) && textures.includes(t);
  if (!has('irradiance') || !has('debug_chart_color')) return null;
  if (sunBaked !== false && !has('direct_light_shadows')) return null;
  return {
    irradiance: path.join(dir, 'irradiance.exr'),
    shadow: sunBaked === false ? null : path.join(dir, 'direct_light_shadows.png'),
    chart: path.join(dir, 'debug_chart_color.png'),
    probes: has('env_light_probe_volume_atlas') && has('env_light_probe_volume_atlas_dlshd'),
  };
}

/**
 * An EXR VRF exported (irradiance.exr: channels A, B, G, R, float32) as an HdrImage. Alpha is
 * dropped in place, so `data` is a view on the decoder's RGBA buffer (8192²: 1.07 GB).
 * @returns {Promise<HdrImage>}
 */
export async function readHdr(file) {
  const { width, height, data } = readExr(file);
  const n = width * height;
  for (let k = 0; k < n; k++) {
    data[3 * k] = data[4 * k];
    data[3 * k + 1] = data[4 * k + 1];
    data[3 * k + 2] = data[4 * k + 2];
  }
  return { width, height, data: data.subarray(0, 3 * n) };
}

/**
 * Channel `channel` (the light's `bakedshadowindex`) of direct_light_shadows.png. VRF writes a
 * one-channel (BC4) texture as grey, so channel 0 of either form is the same.
 * @returns {Promise<Shadow>}
 */
export async function readShadow(file, channel) {
  const { data, info } = await sharp(file).extractChannel(channel).raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || data.length !== info.width * info.height) {
    throw new Error(`${file}: channel ${channel} did not decode to one byte per texel`);
  }
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** debug_chart_color.png as RGB. @returns {Promise<Chart>} */
export async function readChart(file) {
  const { data, info } = await sharp(file).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/**
 * The primitive's lightmap UV accessor: TEXCOORD_2 when it has one (TEXCOORD_1 is then a second
 * material UV, or zeros), else TEXCOORD_1. Null without either, or when it is all zero: CS2
 * leaves such a primitive unlit.
 */
export function lightmapUv(prim) {
  const uv = prim.getAttribute('TEXCOORD_2') ?? prim.getAttribute('TEXCOORD_1');
  if (!uv) return null;
  const a = uv.getArray();
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return uv;
  return null;
}

/**
 * Takes the primitive's lightmap UV off (one fitsCharts rejects, or one leaving the lightmap for
 * vertex light): TEXCOORD_2 and TEXCOORD_1 both, so lightmapUv cannot fall back to TEXCOORD_1,
 * which beside a TEXCOORD_2 is a second material UV (or zeros) that no shipped material reads.
 * Returns whether the primitive had a lightmap UV.
 */
export function dropLightmapUv(prim) {
  const had = lightmapUv(prim) !== null;
  prim.setAttribute('TEXCOORD_2', null).setAttribute('TEXCOORD_1', null);
  return had;
}

/** An accessor's values as floats (a normalized integer accessor is denormalized). */
export function floats(acc) {
  const a = acc.getArray();
  if (a instanceof Float32Array) return a;
  const size = acc.getElementSize();
  const out = new Float32Array(acc.getCount() * size);
  const el = [];
  for (let i = 0; i < acc.getCount(); i++) out.set(acc.getElement(i, el), i * size);
  return out;
}

/** The primitive's triangle corners as vertex indices (a non-indexed primitive: 0..n−1). */
function cornersOf(prim) {
  const idx = prim.getIndices();
  if (idx) return idx.getArray();
  const n = prim.getAttribute('POSITION')?.getCount() ?? 0;
  return Uint32Array.from({ length: n }, (_, i) => i);
}

/**
 * Calls fn(node, prim, uv, corners) for every triangle primitive of every mesh node that has a
 * lightmap UV (`uv` as floats).
 */
function eachLightmapped(doc, fn) {
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const uv = lightmapUv(prim);
      if (uv) fn(node, prim, floats(uv), cornersOf(prim));
    }
  }
}

/**
 * Rasterizes the UV triangle of vertices a, b, c on a width × height image as a GPU samples it:
 * area(k, wa, wb, wc) for each texel centre inside it, edges included (k = y · width + x; wa, wb,
 * wc the centre's barycentric weights). A triangle no texel centre falls in calls instead
 * line(k, wa, wb, wc) for the texels a bilinear lookup reads along its longest edge (rasterLine):
 * CS2 gives small and thin faces a lightmap chart that is a point or a line (36 % of Mirage's
 * lightmap-UV triangles, 57 % of Nuke's, have no area in the atlas at all), baked into the
 * texels around it. Either visitor may be null; without `area`, the raster stops at the first
 * centre inside.
 */
function rasterTriangle(uv, a, b, c, width, height, area, line) {
  const ax = uv[2 * a] * width - 0.5, ay = uv[2 * a + 1] * height - 0.5;
  const bx = uv[2 * b] * width - 0.5, by = uv[2 * b + 1] * height - 0.5;
  const cx = uv[2 * c] * width - 0.5, cy = uv[2 * c + 1] * height - 0.5;
  const twice = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  let inside = 0;
  if (Math.abs(twice) > 1e-12) {
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - EDGE));
    const x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) + EDGE));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - EDGE));
    const y1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy) + EDGE));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const wa = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / twice;
        const wb = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / twice;
        const wc = 1 - wa - wb;
        if (!(wa >= -EDGE && wb >= -EDGE && wc >= -EDGE)) continue;
        if (!area) return;
        area(y * width + x, wa, wb, wc);
        inside++;
      }
    }
  }
  if (inside || !line) return;
  const ab = Math.hypot(bx - ax, by - ay), bc = Math.hypot(cx - bx, cy - by), ca = Math.hypot(ax - cx, ay - cy);
  if (ab >= bc && ab >= ca) rasterLine(ax, ay, bx, by, width, height, (k, t) => line(k, 1 - t, t, 0));
  else if (bc >= ca) rasterLine(bx, by, cx, cy, width, height, (k, t) => line(k, 0, 1 - t, t));
  else rasterLine(cx, cy, ax, ay, width, height, (k, t) => line(k, t, 0, 1 - t));
}

/**
 * Calls visit(k, t) for each texel a bilinear lookup reads (with a weight above 0) at points
 * no more than half a texel apart from (x0, y0) to (x1, y1), in texel-centre coordinates; t is
 * the point's place on the segment, 0..1. A texel may be visited more than once.
 */
function rasterLine(x0, y0, x1, y1, width, height, visit) {
  const steps = Math.ceil(2 * Math.hypot(x1 - x0, y1 - y0));
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0;
    const x = Math.min(width - 1, Math.max(0, x0 + (x1 - x0) * t));
    const y = Math.min(height - 1, Math.max(0, y0 + (y1 - y0) * t));
    const ix = Math.floor(x), iy = Math.floor(y);
    for (let yy = iy; yy <= (y > iy ? iy + 1 : iy); yy++) {
      for (let xx = ix; xx <= (x > ix ? ix + 1 : ix); xx++) visit(yy * width + xx, t);
    }
  }
}

/** coverage's values: a texel inside a chart's triangle, and one only a point or line chart reads. */
export const COVERED = Object.freeze({ area: 1, footprint: 2 });

/**
 * Which texels of a width × height lightmap the scene's lightmap UVs cover: COVERED.area (1)
 * where a texel centre lies inside (or on an edge of) a triangle; COVERED.footprint (2), unless
 * a triangle covers it, for the texels a bilinear lookup reads along a triangle no centre falls
 * in (a point or line chart); 0 elsewhere. CS2's own padding around each chart is not covered
 * (D4).
 */
export function coverage(doc, width, height) {
  const covered = new Uint8Array(width * height);
  const area = (k) => { covered[k] = COVERED.area; };
  const footprint = (k) => { if (!covered[k]) covered[k] = COVERED.footprint; };
  eachLightmapped(doc, (node, prim, uv, corners) => {
    for (let i = 0; i + 2 < corners.length; i += 3) rasterTriangle(uv, corners[i], corners[i + 1], corners[i + 2], width, height, area, footprint);
  });
  return covered;
}

/**
 * The matrix that takes a node's normals to world space: the cofactors of its world matrix's
 * upper 3 × 3 (the inverse transpose up to scale), negated when the node mirrors. Row-major 3 × 3.
 */
export function normalMatrix(m) {
  const [a, d, g, , b, e, h, , c, f, i] = m;
  const co = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
  const det = a * co[0] + b * co[1] + c * co[2];
  return det < 0 ? co.map((v) => -v) : co;
}

/**
 * Adds the sun to `img` (irradiance, full size) in place, at the texels the scene's lightmap
 * UVs cover: `sun.color · sun.intensity · max(N·L, 0) · (1 − shadow)` (D3), with N·L
 * interpolated across each triangle from its vertices' world normals (the raw NORMAL), or
 * flat from the triangle's own face normal (POSITION and winding) for a primitive without
 * NORMAL. Where triangles overlap (overlays share the texels of the surface under them) the
 * last one drawn sets N·L; point and line charts (rasterTriangle) are drawn first, so a texel a
 * chart's triangle covers takes that triangle's N·L. Only for a map whose sun is baked (sunOf().baked, with a
 * shadowChannel; anything else throws); `shadow` is that channel of direct_light_shadows at
 * the same size.
 * @param {HdrImage} img
 * @param {import('@gltf-transform/core').Document} doc
 * @param {Shadow} shadow
 * @param {{ dir: number[], color: number[], intensity: number, baked: true, shadowChannel: number }} sun
 *   sunOf()'s result on a baked-sun map
 * @returns {number} the texels with an N·L
 */
export function bakeSun(img, doc, shadow, sun) {
  if (!sun.baked) throw new Error('bakeSun: this sun is not baked (light_environment directlight "1"): the engine draws it, so the lightmap stays irradiance only');
  if (sun.shadowChannel == null) throw new Error('bakeSun: this sun has no shadow channel (bakedshadowindex)');
  const { width, height, data } = img;
  if (shadow.width !== width || shadow.height !== height) {
    throw new Error(`direct_light_shadows is ${shadow.width}×${shadow.height} but the lightmap ${width}×${height}: sizes differ`);
  }
  const [lx, ly, lz] = sun.dir;
  const ndl = new Float32Array(width * height).fill(NaN);
  // Point and line charts first, so that a chart's own triangles have the last word on its texels.
  for (const pass of ['footprint', 'area']) {
    const visitors = (set) => (pass === 'area' ? [set, null] : [null, set]);
    eachLightmapped(doc, (node, prim, uv, corners) => {
      const nm = normalMatrix(node.getWorldMatrix());
      // N·L of a node-space normal (any length) once in world space.
      const towardsSun = (x, y, z) => {
        const wx = nm[0] * x + nm[1] * y + nm[2] * z;
        const wy = nm[3] * x + nm[4] * y + nm[5] * z;
        const wz = nm[6] * x + nm[7] * y + nm[8] * z;
        return (wx * lx + wy * ly + wz * lz) / (Math.hypot(wx, wy, wz) || 1);
      };
      const normal = prim.getAttribute('NORMAL');
      if (normal) {
        const n = floats(normal);
        const vl = new Float32Array(n.length / 3);
        for (let j = 0; j < vl.length; j++) vl[j] = towardsSun(n[3 * j], n[3 * j + 1], n[3 * j + 2]);
        for (let i = 0; i + 2 < corners.length; i += 3) {
          const a = corners[i], b = corners[i + 1], c = corners[i + 2];
          rasterTriangle(uv, a, b, c, width, height, ...visitors((k, wa, wb, wc) => { ndl[k] = wa * vl[a] + wb * vl[b] + wc * vl[c]; }));
        }
        return;
      }
      const position = prim.getAttribute('POSITION');
      if (!position) return;
      const p = floats(position);
      for (let i = 0; i + 2 < corners.length; i += 3) {
        const a = 3 * corners[i], b = 3 * corners[i + 1], c = 3 * corners[i + 2];
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const face = towardsSun(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        rasterTriangle(uv, corners[i], corners[i + 1], corners[i + 2], width, height, ...visitors((k) => { ndl[k] = face; }));
      }
    });
  }
  const r = sun.color[0] * sun.intensity, g = sun.color[1] * sun.intensity, b = sun.color[2] * sun.intensity;
  let texels = 0;
  for (let k = 0; k < ndl.length; k++) {
    const d = ndl[k];
    if (Number.isNaN(d)) continue;
    texels++;
    const l = Math.max(0, d) * (1 - shadow.data[k] / 255);
    if (l <= 0) continue;
    data[3 * k] += r * l;
    data[3 * k + 1] += g * l;
    data[3 * k + 2] += b * l;
  }
  return texels;
}

/**
 * `img` shrunk by an integer `factor`: each texel is the mean of the covered texels of its
 * factor × factor block, and covered when any of them is. Where the block has texels inside a
 * chart's triangles (COVERED.area), only those count: the texels point and line charts read
 * (COVERED.footprint) count only in a block without any, so they never shift a chart's own light.
 * A block with none is black and uncovered, so CS2's padding and whatever lies between charts
 * never bleeds in.
 * @param {HdrImage} img
 * @param {Uint8Array} covered  coverage(): 0, COVERED.area or COVERED.footprint
 * @returns {{ img: HdrImage, covered: Uint8Array }}
 */
export function downscale(img, covered, factor) {
  const { width, height, data } = img;
  if (!Number.isInteger(factor) || factor < 1 || width % factor || height % factor) {
    throw new Error(`downscale: ${factor} does not divide ${width}×${height}`);
  }
  const w = width / factor, h = height / factor;
  const out = new Float32Array(w * h * 3);
  const outCovered = new Uint8Array(w * h);
  const sum = [new Float64Array(4), new Float64Array(4)]; // [area, footprint]: r, g, b, n
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sum[0].fill(0);
      sum[1].fill(0);
      for (let j = 0; j < factor; j++) {
        let s = (y * factor + j) * width + x * factor;
        for (let i = 0; i < factor; i++, s++) {
          if (!covered[s]) continue;
          const t = sum[covered[s] === COVERED.area ? 0 : 1];
          t[0] += data[3 * s];
          t[1] += data[3 * s + 1];
          t[2] += data[3 * s + 2];
          t[3]++;
        }
      }
      const t = sum[0][3] ? sum[0] : sum[1];
      if (!t[3]) continue;
      const o = y * w + x;
      out[3 * o] = t[0] / t[3];
      out[3 * o + 1] = t[1] / t[3];
      out[3 * o + 2] = t[2] / t[3];
      outCovered[o] = 1;
    }
  }
  return { img: { width: w, height: h, data: out }, covered: outCovered };
}

/**
 * Pads charts in place: each pass gives every uncovered texel with a covered 8-neighbour the
 * mean of those neighbours, then marks it covered. Covered texels never change.
 * @param {HdrImage} img
 * @param {Uint8Array} covered
 */
export function dilate(img, covered, passes) {
  const { width, height, data } = img;
  const filled = [];
  for (let pass = 0; pass < passes; pass++) {
    filled.length = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = y * width + x;
        if (covered[k]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
            const j = yy * width + xx;
            if (!covered[j]) continue;
            r += data[3 * j];
            g += data[3 * j + 1];
            b += data[3 * j + 2];
            n++;
          }
        }
        if (!n) continue;
        // Only texels covered before this pass are read, so writing now is safe.
        data[3 * k] = r / n;
        data[3 * k + 1] = g / n;
        data[3 * k + 2] = b / n;
        filled.push(k);
      }
    }
    if (!filled.length) break;
    for (const k of filled) covered[k] = 1;
  }
}

/**
 * The map's light range (the lightmap's and COLOR_0's): the smallest of 2, 4, … 64 at or above
 * the p99.9 of the covered texels' brightest channel (D5), so about 0.1 % of them clip. 2 when
 * nothing is covered.
 * Take it after downscale and before dilate, so the padding does not count.
 * @param {HdrImage} img
 * @param {Uint8Array} covered
 */
export function chooseRange(img, covered) {
  const { data } = img;
  let n = 0;
  for (let k = 0; k < covered.length; k++) if (covered[k]) n++;
  if (!n) return RANGES[0];
  const peaks = new Float32Array(n);
  for (let k = 0, i = 0; k < covered.length; k++) {
    if (covered[k]) peaks[i++] = Math.max(data[3 * k], data[3 * k + 1], data[3 * k + 2]);
  }
  peaks.sort();
  const p = peaks[Math.floor(RANGE_PERCENTILE * (n - 1))];
  return RANGES.find((r) => r >= p) ?? RANGES[RANGES.length - 1];
}

/** lightBytes' weight on the brightness error against the hue error (1 would round each channel alone). */
const JOINT_LUMA = 0.25;

/** ln of each code's light + one 8-bit step's light, per range: lightBytes' table. */
const logLight = new Map();
function logTable(range) {
  let t = logLight.get(range);
  if (!t) {
    const eps = range / (255 * 255);
    t = Float64Array.from({ length: 256 }, (_, q) => Math.log((q / 255) ** 2 * range + eps));
    logLight.set(range, t);
  }
  return t;
}

/**
 * Linear RGB light as the bytes the viewer reads per channel as (byte / 255)² · range, into
 * `out` (3): a lightmap texel at 8 bits (encodeLightmap), a vertex's COLOR_0 at 6 (light.mjs).
 * Each channel is 255 · sqrt(min(v / range, 1)) on the `bits`-bit grid (multiples of
 * 2^(8 − bits), the top step clamped to 255: 0, 4, … 252, 255 at 6 bits), rounded jointly: of
 * each channel's grid points below and above, the triple that keeps the hue best, cost
 * Σ(e_c − ē)² + JOINT_LUMA · 3ē² with e_c = ln(decoded / true light) and ē their mean. Rounded
 * alone, each channel can move a whole step (6 bits at Nuke's range 16: 16 % of mid-grey light)
 * away from the others, which tinted Nuke's grey silo pink and violet in patches; jointly, the
 * steps go together. Light above the range is scaled down to it whole, so it keeps its hue; +∞
 * is the range, and negative, −∞ or NaN light 0.
 */
export function lightBytes(rgb, range, bits, out = [0, 0, 0]) {
  const step = 2 ** (8 - bits);
  const table = logTable(range);
  const eps = range / (255 * 255);
  // +∞ is the range and NaN or −∞ nothing, channel by channel; light above the range is scaled
  // down to it whole, so it keeps its hue.
  const c0 = clean(rgb[0], range), c1 = clean(rgb[1], range), c2 = clean(rgb[2], range);
  const peak = Math.max(c0, c1, c2);
  const fit = peak > range ? range / peak : 1;
  let lo0 = 0, lo1 = 0, lo2 = 0, hi0 = 0, hi1 = 0, hi2 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let c = 0; c < 3; c++) {
    const v = (c === 0 ? c0 : c === 1 ? c1 : c2) * fit;
    const s = Math.sqrt(Math.min(v / range, 1)) * 255;
    const lo = Math.min(255, Math.floor(s / step) * step), hi = Math.min(255, lo + step);
    const t = Math.log(v + eps);
    if (c === 0) { lo0 = lo; hi0 = hi; t0 = t; } else if (c === 1) { lo1 = lo; hi1 = hi; t1 = t; } else { lo2 = lo; hi2 = hi; t2 = t; }
  }
  let best = Infinity;
  for (let m = 0; m < 8; m++) {
    const q0 = m & 1 ? hi0 : lo0, q1 = m & 2 ? hi1 : lo1, q2 = m & 4 ? hi2 : lo2;
    const e0 = table[q0] - t0, e1 = table[q1] - t1, e2 = table[q2] - t2;
    const mean = (e0 + e1 + e2) / 3;
    const cost = (e0 - mean) ** 2 + (e1 - mean) ** 2 + (e2 - mean) ** 2 + JOINT_LUMA * 3 * mean * mean;
    if (cost < best) { best = cost; out[0] = q0; out[1] = q1; out[2] = q2; }
  }
  return out;
}

/** One channel of light as lightBytes takes it: +∞ is `range`, NaN, −∞ and negative light 0. */
const clean = (v, range) => (v > 0 ? (v === Infinity ? range : v) : 0);

/**
 * The lightmap's bytes: lightBytes(·, range, LIGHTMAP_PARAMS.bits) per texel, 3 bytes (RGB) a
 * texel in `img`'s order; black is 0, 0, 0.
 * @param {HdrImage} img
 */
export function encodeLightmap(img, range) {
  const { width, height, data } = img;
  const n = width * height;
  const out = new Uint8Array(n * 3);
  const rgb = [0, 0, 0], q = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    rgb[0] = data[3 * k]; rgb[1] = data[3 * k + 1]; rgb[2] = data[3 * k + 2];
    lightBytes(rgb, range, LIGHTMAP_PARAMS.bits, q);
    out[3 * k] = q[0]; out[3 * k + 1] = q[1]; out[3 * k + 2] = q[2];
  }
  return out;
}

/** Linear RGB from lightmap bytes: (byte / 255)² · range, what the viewer's shader computes. */
export function decodeLightmap(rgb, range) {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = (rgb[i] / 255) ** 2 * range;
  return out;
}

/**
 * lightmap.webp from encodeLightmap's bytes: a lossless RGB WebP (no alpha, no chroma
 * subsampling), so the viewer reads exactly these codes. The same bytes give the same file.
 * @returns {Promise<Buffer>}
 */
export function lightmapWebp(rgb, width, height) {
  return sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { raw: { width, height, channels: 3 } })
    .webp({ lossless: true, effort: 6 })
    .toBuffer();
}

/**
 * Whether the primitive's lightmap UV lands in the lightmap's charts (D1). For each triangle
 * covering at least CHART_TEST.minTexels texels of `chart`, its centroid and the three points
 * 3/4 of the way to its corners must read one chart colour. A UV with CHART_TEST.minTriangles
 * such triangles, under CHART_TEST.minInside of them inside one chart, is a material UV (false);
 * with fewer, or without a lightmap UV, there is nothing to judge (true).
 * @param {Chart} chart
 */
export function fitsCharts(chart, prim) {
  const acc = lightmapUv(prim);
  if (!acc) return true;
  const uv = floats(acc);
  const corners = cornersOf(prim);
  const { width, height, data } = chart;
  const { minTexels, minTriangles, minInside, tolerance } = CHART_TEST;
  const colourAt = (u, v) => {
    const x = Math.floor(u * width), y = Math.floor(v * height);
    if (!(x >= 0 && y >= 0 && x < width && y < height)) return -1;
    const o = (y * width + x) * 3;
    return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
  };
  const near = (p, q) =>
    p >= 0 && q >= 0 &&
    Math.abs((p >> 16) - (q >> 16)) <= tolerance &&
    Math.abs(((p >> 8) & 255) - ((q >> 8) & 255)) <= tolerance &&
    Math.abs((p & 255) - (q & 255)) <= tolerance;
  let big = 0, inside = 0;
  for (let i = 0; i + 2 < corners.length; i += 3) {
    const a = corners[i], b = corners[i + 1], c = corners[i + 2];
    const area = (Math.abs((uv[2 * b] - uv[2 * a]) * (uv[2 * c + 1] - uv[2 * a + 1]) - (uv[2 * c] - uv[2 * a]) * (uv[2 * b + 1] - uv[2 * a + 1])) / 2) * width * height;
    if (!(area >= minTexels)) continue;
    big++;
    const mu = (uv[2 * a] + uv[2 * b] + uv[2 * c]) / 3, mv = (uv[2 * a + 1] + uv[2 * b + 1] + uv[2 * c + 1]) / 3;
    const centre = colourAt(mu, mv);
    if (centre < 0) continue;
    if ([a, b, c].every((j) => near(centre, colourAt(mu + 0.75 * (uv[2 * j] - mu), mv + 0.75 * (uv[2 * j + 1] - mv))))) inside++;
  }
  return big < minTriangles || inside >= minInside * big;
}
