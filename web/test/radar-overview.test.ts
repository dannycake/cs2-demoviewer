import { describe, expect, it } from 'vitest';
import { cropOf, parseOverview, sectionAt } from '../src/radar/overview';

// `assets/maps/de_mirage/overview.json` and de_nuke's sections, as tools/lib/overview.mjs writes them.
const MIRAGE = {
  map: 'de_mirage',
  posX: -3230,
  posY: 1713,
  scale: 5,
  size: 1024,
  sections: [
    {
      name: 'default',
      image: 'radar.png',
      altitudeMin: -10000,
      altitudeMax: 10000,
    },
  ],
  ctSpawn: [0.28, 0.7],
  tSpawn: [0.87, 0.36],
  bombA: [0.54, 0.76],
  bombB: [0.23, 0.28],
  inset: { left: 0.135, top: 0.08, right: 0.105, bottom: 0.08 },
};
const NUKE = {
  ...MIRAGE,
  map: 'de_nuke',
  sections: [
    {
      name: 'lower',
      image: 'radar_lower.png',
      altitudeMin: -10000,
      altitudeMax: -495,
    },
    {
      name: 'default',
      image: 'radar.png',
      altitudeMin: -495,
      altitudeMax: 10000,
    },
  ],
};

describe('parseOverview', () => {
  it("reads the tools' overview.json", () => {
    const ov = parseOverview(MIRAGE)!;
    expect(ov).toMatchObject({
      map: 'de_mirage',
      posX: -3230,
      posY: 1713,
      scale: 5,
      size: 1024,
    });
    expect(ov.sections.map((s) => s.image)).toEqual(['radar.png']);
    expect(ov.bombA).toEqual([0.54, 0.76]);
    expect(ov.inset.left).toBe(0.135);
  });

  it('puts the default section first', () => {
    expect(parseOverview(NUKE)!.sections.map((s) => s.name)).toEqual([
      'default',
      'lower',
    ]);
  });

  it('refuses an overview it cannot place things with', () => {
    expect(parseOverview({ ...MIRAGE, scale: undefined })).toBeNull();
    expect(parseOverview({ ...MIRAGE, scale: 0 })).toBeNull();
    expect(parseOverview({ ...MIRAGE, sections: [] })).toBeNull();
    expect(
      parseOverview({
        ...MIRAGE,
        sections: [
          { name: 'x', image: '../etc.png', altitudeMin: 0, altitudeMax: 1 },
        ],
      })
    ).toBeNull();
    expect(parseOverview(null)).toBeNull();
    expect(parseOverview('x')).toBeNull();
  });

  it('reads a missing site or inset as none', () => {
    const ov = parseOverview({
      ...MIRAGE,
      bombA: undefined,
      inset: undefined,
    })!;
    expect(ov.bombA).toBeNull();
    expect(ov.inset).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});

describe('sectionAt', () => {
  it('finds the level that holds an altitude, the default one otherwise', () => {
    const ov = parseOverview(NUKE)!;
    expect(ov.sections[sectionAt(ov, -600)].name).toBe('lower');
    expect(ov.sections[sectionAt(ov, 0)].name).toBe('default');
    expect(ov.sections[sectionAt(ov, -495)].name).toBe('default');
    expect(sectionAt(parseOverview(MIRAGE)!, 50000)).toBe(0);
  });
});

describe('cropOf', () => {
  it('is the image less its inset, squared, inside the image', () => {
    const c = cropOf(parseOverview(MIRAGE)!);
    expect(c.w).toBe(c.h);
    expect(c.w).toBeCloseTo(1024 * 0.84, 6);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(1024);
    expect(c.y + c.h).toBeLessThanOrEqual(1024);
  });

  it('is the whole image without an inset', () => {
    expect(cropOf(parseOverview({ ...MIRAGE, inset: undefined })!)).toEqual({
      x: 0,
      y: 0,
      w: 1024,
      h: 1024,
    });
  });
});
