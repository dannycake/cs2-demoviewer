// loadSky: the map's sky.webp as an equirect, sRGB background texture without mipmaps (the
// background samples it near 1:1, and three.js makes its cube from it with the same
// filters, so mipmaps would only cost GPU memory). The image loader is stubbed: node has none.

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSky } from '../src/scene/loaders';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadSky', () => {
  it('loads sky.webp as an equirect sRGB texture, linear-filtered, without mipmaps', async () => {
    const load = vi
      .spyOn(THREE.TextureLoader.prototype, 'loadAsync')
      .mockResolvedValue(
        new THREE.Texture({
          width: 2048,
          height: 1024,
        }) as unknown as THREE.Texture<HTMLImageElement>
      );
    const t = await loadSky('/maps/de_mirage/sky.webp?v=12800f01');
    expect(load).toHaveBeenCalledWith('/maps/de_mirage/sky.webp?v=12800f01');
    expect(t.name).toBe('/maps/de_mirage/sky.webp?v=12800f01');
    expect(t.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(t.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(t.generateMipmaps).toBe(false);
    expect(t.minFilter).toBe(THREE.LinearFilter);
    expect(t.magFilter).toBe(THREE.LinearFilter);
  });
});
