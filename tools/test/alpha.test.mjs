import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { alphaTextures, bleed, fitImage, fitTextures, fitWithin } from '../lib/alpha.mjs';

const png = (w, h, rgba) =>
  sharp(Buffer.from(rgba), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
const pixels = async (image) => sharp(image).raw().toBuffer({ resolveWithObject: true });

describe('fitWithin', () => {
  it("gives textureCompress's sizes, so its own resize has nothing left to do", () => {
    expect(fitWithin([1024, 512], [256, 256])).toEqual([256, 128]);
    expect(fitWithin([300, 1000], [256, 256])).toEqual([76, 256]);
    expect(fitWithin([100, 50], [256, 256])).toEqual([100, 50]);
  });
});

describe('sharp', () => {
  // fitTextures relies on both: textureCompress resizes every texture again, to the same size.
  it('premultiplies to resize, so colour under near-zero alpha comes out black', async () => {
    const image = await png(4, 4, new Array(16).fill([200, 200, 200, 1]).flat());
    const { data } = await pixels(await sharp(image).resize(2, 2, { fit: 'fill' }).png().toBuffer());
    expect([...data.subarray(0, 3)]).toEqual([0, 0, 0]);
  });

  it('leaves the colour alone when the size does not change', async () => {
    const image = await png(4, 4, new Array(16).fill([200, 200, 200, 1]).flat());
    const { data } = await pixels(await sharp(image).resize(4, 4, { fit: 'fill' }).png().toBuffer());
    expect([...data.subarray(0, 4)]).toEqual([200, 200, 200, 1]);
  });
});

describe('fitImage', () => {
  it('drops an alpha nothing draws, keeping the colour under it', async () => {
    // Nuke's crates: grey metal, its alpha (another channel's data in CS2) mostly zero.
    const image = await png(8, 8, new Array(64).fill([200, 200, 200, 0]).flat());
    const { data, info } = await pixels(await fitImage(image, [4, 4], false));
    expect([info.width, info.height, info.channels]).toEqual([4, 4, 3]);
    for (const v of data) expect(v).toBeGreaterThanOrEqual(198);
  });

  it("keeps a cutout's alpha, with colour bled under its transparent pixels", async () => {
    // Left half visible red, right half transparent black: a cutout's edge.
    const rgba = [];
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) rgba.push(...(x < 4 ? [220, 30, 30, 255] : [0, 0, 0, 0]));
    const { data, info } = await pixels(await fitImage(await png(8, 8, rgba), [4, 4], true));
    expect([info.width, info.height, info.channels]).toEqual([4, 4, 4]);
    for (let p = 0; p < data.length; p += 4) {
      const x = (p / 4) % 4;
      expect(data[p]).toBeGreaterThan(200); // red everywhere, no black fringe
      expect(data[p + 1]).toBeLessThan(50);
      if (x === 0) expect(data[p + 3]).toBe(255);
      if (x === 3) expect(data[p + 3]).toBe(0);
    }
  });
});

describe('bleed', () => {
  it('fills transparent pixels from the nearest visible one', () => {
    // 4×1: visible blue, then three transparent.
    const data = Buffer.from([0, 0, 255, 255, 9, 9, 9, 0, 9, 9, 9, 0, 9, 9, 9, 0]);
    bleed(data, 4, 1);
    expect([...data]).toEqual([0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0]);
  });

  it('leaves an image with nothing visible as it is', () => {
    const data = Buffer.from([1, 2, 3, 0, 4, 5, 6, 0]);
    bleed(data, 2, 1);
    expect([...data]).toEqual([1, 2, 3, 0, 4, 5, 6, 0]);
  });
});

describe('alphaTextures and fitTextures', () => {
  it("keep alpha only on the base colour of cutout and blended materials", async () => {
    const doc = new Document();
    const tex = async (name) =>
      doc
        .createTexture(name)
        .setMimeType('image/png')
        .setImage(await png(8, 8, new Array(64).fill([200, 200, 200, 0]).flat()));
    const [opaque, cutout, glass, normal] = await Promise.all(
      ['opaque', 'cutout', 'glass', 'normal'].map(tex)
    );
    doc.createMaterial('crate').setBaseColorTexture(opaque).setNormalTexture(normal);
    doc.createMaterial('fence').setAlphaMode('MASK').setBaseColorTexture(cutout);
    doc.createMaterial('window').setAlphaMode('BLEND').setBaseColorTexture(glass);
    // A texture shared with a cutout keeps its alpha.
    doc.createMaterial('fence_too').setBaseColorTexture(cutout);

    expect(alphaTextures(doc)).toEqual(new Set([cutout, glass]));
    expect(await fitTextures(doc, [4, 4])).toEqual({ fitted: 4, alphaDropped: 2 });
    for (const [t, channels] of [[opaque, 3], [normal, 3], [cutout, 4], [glass, 4]]) {
      const { info } = await pixels(Buffer.from(t.getImage()));
      expect([info.width, info.channels]).toEqual([4, channels]);
    }
  });
});
