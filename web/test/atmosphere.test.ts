// The sky, fog and light colours of each map with a world (Active Duty and Cache), with defaults
// for any other map.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERES,
  DEFAULT_ATMOSPHERE,
  atmosphereFor,
} from '../src/scene/atmosphere';

const ACTIVE_DUTY = [
  'de_ancient',
  'de_anubis',
  'de_dust2',
  'de_inferno',
  'de_mirage',
  'de_nuke',
  'de_overpass',
  'de_train',
  'de_vertigo',
];
/** Every map with a world: Active Duty and Cache. */
const WORLD_MAPS = [...ACTIVE_DUTY, 'de_cache'].sort();

describe('atmosphereFor', () => {
  // Each map's light was fitted to the average colour of CS2's own screenshots of it
  // (panorama/images/map_icons/screenshots/1080p), 2026-10-22.
  // Cache was fitted on 2026-10-23: the mean of its POV views (lower 60 %, the HUD hidden) against
  // the mean of its screenshots scaled by Mirage's ratio of the two, (107, 105, 99) against
  // (110, 106, 102). Its sky is CS2's overcast grey, so most light comes from the sky, not the sun
  // (a strong sun on a high exposure blew out the first-person hands, which face it).
  it('gives Cache an overcast grey sky lit more by the sky than the sun', () => {
    const a = atmosphereFor('de_cache');
    const saturation = (hex: string) =>
      new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 }).s;
    expect(saturation(a.sky)).toBeLessThan(0.3);
    expect(saturation(atmosphereFor('de_mirage').sky)).toBeGreaterThan(0.5);
    const luminance = (hex: string) => {
      const c = new THREE.Color(hex);
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    };
    expect(luminance(a.sunColor)).toBeLessThan(luminance(a.hemiSky) * 0.5);
    expect(a.exposure).toBeCloseTo(3.25, 6);
    expect(a.exposure).toBeGreaterThan(atmosphereFor('de_mirage').exposure);
  });

  it("gives Mirage CS2's blue sky, warm sun and sandy bounce", () => {
    const a = atmosphereFor('de_mirage');
    expect(a.sky).toBe('#8fc0ee');
    expect(a.sunColor).toBe('#fdcc99');
    expect(a.hemiGround).toBe('#d7ab7c');
    expect(a.exposure).toBeCloseTo(1.6, 6);
    expect(a.bakedExposure).toBe(1.35);
    // Its cream horizon is the fog's colour: pushed out so the overview is not washed in it.
    expect(a.fogNear).toBe(200);
    expect(a.fogFar).toBe(700);
  });

  it('gives each map its own light and exposure', () => {
    expect(atmosphereFor('de_train').exposure).toBeLessThan(
      atmosphereFor('de_mirage').exposure
    );
    expect(atmosphereFor('de_overpass').exposure).toBeGreaterThan(
      atmosphereFor('de_mirage').exposure
    );
    const keys = Object.values(ATMOSPHERES).map((a) => JSON.stringify(a));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('falls back to the defaults for an unknown map', () => {
    expect(atmosphereFor('de_cbble')).toEqual(DEFAULT_ATMOSPHERE);
    expect(atmosphereFor('')).toEqual(DEFAULT_ATMOSPHERE);
    expect(DEFAULT_ATMOSPHERE).toEqual({
      sky: '#a8c6e6',
      fogNear: 120,
      fogFar: 420,
      sunColor: '#fff2e0',
      sunIntensity: 3.6,
      hemiSky: '#e6ecf5',
      hemiGround: '#9a8f80',
      exposure: 1.6,
      bakedExposure: 1.1,
      skyIntensity: 1,
    });
  });

  it("gives every map its bake's exposure, fitted to CS2's screenshot of it (2026-10-25)", () => {
    const fitted = Object.fromEntries(
      WORLD_MAPS.map((m) => [m, atmosphereFor(m).bakedExposure])
    );
    expect(fitted).toEqual({
      de_ancient: 0.9,
      de_anubis: 1.1,
      de_cache: 0.8,
      de_dust2: 1.15,
      de_inferno: 0.9,
      de_mirage: 1.35,
      de_nuke: 1.4,
      de_overpass: 0.85,
      de_train: 1.8,
      de_vertigo: 0.6,
    });
    for (const a of [DEFAULT_ATMOSPHERE, ...Object.values(ATMOSPHERES)]) {
      expect(a.bakedExposure).toBeGreaterThan(0);
      // With a bake the sun is light.json's (Cache's runtime one too); this is the sun without.
      expect(a.sunIntensity).toBe(3.6);
    }
  });

  it('ignores case', () => {
    expect(atmosphereFor('DE_MIRAGE')).toEqual(atmosphereFor('de_mirage'));
  });

  it('has an entry for every map with a world, all valid', () => {
    expect(Object.keys(ATMOSPHERES).sort()).toEqual(WORLD_MAPS);
    for (const a of [DEFAULT_ATMOSPHERE, ...Object.values(ATMOSPHERES)]) {
      for (const c of [a.sky, a.sunColor, a.hemiSky, a.hemiGround])
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
      // three parses every colour as given.
      expect(new THREE.Color(a.sky).getHexString()).toBe(a.sky.slice(1));
      expect(a.fogNear).toBeGreaterThan(0);
      expect(a.fogFar).toBeGreaterThan(a.fogNear);
      expect(a.exposure).toBeGreaterThan(0.5);
      expect(a.exposure).toBeLessThan(4);
      // sky.webp is drawn as tools/sky.mjs exposed it, times this.
      expect(a.skyIntensity).toBeGreaterThan(0);
    }
  });
});
