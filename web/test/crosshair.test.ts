// The vectors in fixtures/crosshair-vectors.json are the test samples of akiver/csgo-sharecode
// (MIT, (c) 2017-present AkiVer), whose decoder `sim/crosshair.ts` ports.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CROSSHAIR,
  crosshairLook,
  decodeCrosshair,
} from '../src/sim/crosshair';
import { scopeFov, verticalFov } from '../src/sim/scope';
import fixture from './fixtures/crosshair-vectors.json';

describe('decodeCrosshair', () => {
  it.each(fixture.vectors.map((v) => [v.code, v] as const))(
    'decodes %s',
    (code, expected) => {
      const fields: Partial<typeof expected> = { ...expected };
      delete fields.code;
      expect(decodeCrosshair(code)).toEqual(fields);
    }
  );

  it('is null for a code that is not one or has a bad checksum', () => {
    expect(decodeCrosshair('')).toBeNull();
    expect(decodeCrosshair('hello')).toBeNull();
    // One character changed from a good code: the checksum no longer adds up.
    expect(decodeCrosshair('CSGO-Cn37R-YE7vo-pLCAL-aURmZ-z6zkH')).toBeNull();
    expect(
      decodeCrosshair('CSvbPubOq37zTGqtsPTP5QTrp5CB4xFXiKRLfzJsm49ZRf')
    ).toBeNull();
  });

  it("decodes the crosshair of the Mirage demo's first player, a CS2 pixel code", () => {
    expect(decodeCrosshair('CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB')).toMatchObject(
      {
        format: 'legacy-v4',
        style: 4,
        red: 0,
        green: 255,
        blue: 0,
        alpha: 255,
      }
    );
  });
});

describe('crosshairLook', () => {
  it('scales a pixel crosshair from the height it was made at to the screen', () => {
    // legacy-v3: style 4 (static cross), gap 4, length 8, thickness 2 at 1080, 50 250 50.
    const look = crosshairLook(
      decodeCrosshair('CSGO-hLbCn-69VT6-Bok83-9MOqW-SWzwQ'),
      1440
    );
    expect(look.shape).toBe('cross');
    expect(look.gap).toBeCloseTo((4 * 1440) / 1080, 6);
    expect(look.length).toBeCloseTo((8 * 1440) / 1080, 6);
    expect(look.thickness).toBeCloseTo((2 * 1440) / 1080, 6);
    expect(look.color).toEqual([50, 250, 50, 255]);
    expect(look.outline).toBeNull();
    expect(look.dot).toBe(false);
    expect(look.tStyle).toBe(false);
  });

  it('reads the CS:GO-era sizes as 480-line units, the static gap 4 units out', () => {
    // legacy-v1: gap 1, length 5, thickness 0.5, colour 1 (green), alpha off.
    const look = crosshairLook(
      decodeCrosshair('CSGO-LibdP-VCVEd-ESayK-rSivi-2UBtG'),
      1080
    );
    expect(look.gap).toBeCloseTo(5 * 2.25, 6);
    expect(look.length).toBeCloseTo(5 * 2.25, 6);
    expect(look.thickness).toBeCloseTo(0.5 * 2.25, 6);
    expect(look.color).toEqual([50, 250, 50, 255]);
  });

  it('keeps a legacy-v1 custom colour, its alpha when enabled, its outline, dot and T', () => {
    // legacy-v1: colour 5 (custom 175 81 213), alpha 137 enabled, outline 2 px, dot, T style.
    const look = crosshairLook(
      decodeCrosshair('CSGO-Cn37R-YE7vo-pLCAL-aURmZ-z6zkG'),
      1080
    );
    expect(look.color).toEqual([175, 81, 213, 137]);
    expect(look.outline).toEqual({ width: 2, color: [0, 0, 0, 137] });
    expect(look.dot).toBe(true);
    expect(look.tStyle).toBe(true);
  });

  it('draws the styles as cross, circle, dot, square or quad', () => {
    const shapes = fixture.vectors
      .filter((v) => v.format !== 'legacy-v1')
      .map((v) => [
        v.style,
        crosshairLook(decodeCrosshair(v.code), 1080).shape,
      ]);
    expect(new Map(shapes as [number, string][])).toEqual(
      new Map([
        [2, 'cross'],
        [3, 'circle'],
        [4, 'cross'],
        [6, 'dot'],
        [8, 'square'],
        [9, 'quad'],
      ])
    );
  });

  it('gives a cs2-v1 code its own outline colour, a half outline half as wide', () => {
    const look = crosshairLook(
      decodeCrosshair('CSAB6Oby2JUDOrBRy4jRcsR6JOQdhbszKF9GuKQGhKVwAc'),
      1440
    );
    expect(look.outline).toEqual({ width: 0.5, color: [40, 50, 60, 128] });
    expect(look.gap).toBeCloseTo(-7, 6);
  });

  it("gives a player without a code CS2's default crosshair", () => {
    expect(crosshairLook(null, 1080)).toEqual(
      crosshairLook(DEFAULT_CROSSHAIR, 1080)
    );
    expect(crosshairLook(null, 1080).color).toEqual([50, 250, 50, 255]);
  });
});

describe('scopeFov', () => {
  it('zooms the snipers twice and the AUG and SG 553 once, in 4:3 field of view', () => {
    expect(scopeFov('awp', 1)).toBe(40);
    expect(scopeFov('awp', 2)).toBe(10);
    for (const w of ['ssg08', 'scar20', 'g3sg1']) {
      expect(scopeFov(w, 1)).toBe(40);
      expect(scopeFov(w, 2)).toBe(15);
    }
    expect(scopeFov('aug', 1)).toBe(45);
    expect(scopeFov('sg556', 1)).toBe(45);
    expect(scopeFov('awp', 0)).toBeNull();
    expect(scopeFov('ak47', 1)).toBeNull();
  });

  it("turns the game's 4:3 field of view into a vertical one", () => {
    expect(verticalFov(90)).toBeCloseTo(73.7398, 3);
    expect(verticalFov(40)).toBeCloseTo(
      (2 * Math.atan(Math.tan((20 * Math.PI) / 180) * 0.75) * 180) / Math.PI,
      6
    );
  });
});
