// Crosshair share codes, decoded, and how one is drawn at a screen height. The decoder is a
// port of `decodeCrosshairShareCode` from akiver/csgo-sharecode (MIT, (c) 2017-present AkiVer,
// https://github.com/akiver/csgo-sharecode), decode only; field names are the package's.
//
// Four formats. `legacy-v1`: CS:GO and CS2 before 1.41.8.2, sizes in tenths of the classic
// 480-line unit. `legacy-v3` and `legacy-v4`: CS2 1.41.8.2 and 1.41.8.3 (23 and 24 September
// 2026), the same `CSGO-` container, sizes in whole pixels at `screenHeight`. `cs2-v1`: the
// `CS…` code CS2 writes since 30 September 2026, pixels, a signed gap and its own outline
// colour. A demo carries whichever its players had set.

const DICTIONARY = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
const LEGACY_CODE = new RegExp(`^CSGO(-?[${DICTIONARY}]{5}){5}$`);
const CS2_CODE = new RegExp(`^CS[${DICTIONARY}]{44}$`);

export interface CrosshairLegacyV1 {
  format: 'legacy-v1';
  gap: number;
  outline: number;
  red: number;
  green: number;
  blue: number;
  alpha: number;
  splitDistance: number;
  followRecoil: boolean;
  fixedCrosshairGap: number;
  /** 0 red, 1 green, 2 yellow, 3 blue, 4 cyan, 5 custom (`red`, `green`, `blue`). */
  color: number;
  outlineEnabled: boolean;
  innerSplitAlpha: number;
  outerSplitAlpha: number;
  splitSizeRatio: number;
  thickness: number;
  centerDotEnabled: boolean;
  deployedWeaponGapEnabled: boolean;
  alphaEnabled: boolean;
  tStyleEnabled: boolean;
  style: number;
  length: number;
}

/** The fields the pixel formats share; sizes are pixels at `screenHeight`. */
interface PixelCrosshair {
  /**
   * 0 dynamic cross, 1 dynamic circle, 2 dynamic cross (legacy), 3 static circle, 4 static
   * cross, 5 static cross (shot feedback), 6 dot only, 7 dynamic quad, 8 static square,
   * 9 static quad.
   */
  style: number;
  followRecoil: boolean;
  centerDotEnabled: boolean;
  tStyleEnabled: boolean;
  red: number;
  green: number;
  blue: number;
  alpha: number;
  gap: number;
  length: number;
  thickness: number;
  dynamicSpreadLimit: number;
  splitDistance: number;
  innerSplitAlpha: number;
  outerSplitAlpha: number;
  splitSizeRatio: number;
  screenHeight: number;
}

export interface CrosshairLegacyV3 extends PixelCrosshair {
  format: 'legacy-v3';
  outlineEnabled: boolean;
}

export interface CrosshairLegacyV4 extends PixelCrosshair {
  format: 'legacy-v4';
  /** 0 none, 1 full, 2 half. */
  outlineMode: number;
}

export interface CrosshairCs2V1 extends PixelCrosshair {
  format: 'cs2-v1';
  /** 0 none, 1 full, 2 half. */
  outlineMode: number;
  outlineRed: number;
  outlineGreen: number;
  outlineBlue: number;
  outlineAlpha: number;
  scopeDotScale: number;
  scopeDotUseCrosshairColor: boolean;
}

export type Crosshair =
  CrosshairLegacyV1 | CrosshairLegacyV3 | CrosshairLegacyV4 | CrosshairCs2V1;

/** A share code's characters as `byteLength` bytes, or null when they do not fit. */
function charsToBytes(chars: string, byteLength: number): number[] | null {
  let big = 0n;
  for (const c of [...chars].reverse())
    big = big * 57n + BigInt(DICTIONARY.indexOf(c));
  const hex = big.toString(16).padStart(byteLength * 2, '0');
  if (hex.length > byteLength * 2) return null;
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2)
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

function checksumOk(bytes: number[]): boolean {
  let sum = 0;
  for (let i = 1; i < bytes.length; i++) sum += bytes[i];
  return bytes[0] === sum % 256;
}

const int8 = (n: number) => (n << 24) >> 24;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi);

function legacyV1(b: number[]): CrosshairLegacyV1 {
  return {
    format: 'legacy-v1',
    gap: int8(b[2]) / 10,
    outline: b[3] / 2,
    red: b[4],
    green: b[5],
    blue: b[6],
    alpha: b[7],
    splitDistance: b[8] & 7,
    followRecoil: ((b[8] >> 4) & 8) === 8,
    fixedCrosshairGap: int8(b[9]) / 10,
    color: b[10] & 7,
    outlineEnabled: (b[10] & 8) === 8,
    innerSplitAlpha: (b[10] >> 4) / 10,
    outerSplitAlpha: (b[11] & 0xf) / 10,
    splitSizeRatio: (b[11] >> 4) / 10,
    thickness: b[12] / 10,
    centerDotEnabled: ((b[13] >> 4) & 1) === 1,
    deployedWeaponGapEnabled: ((b[13] >> 4) & 2) === 2,
    alphaEnabled: ((b[13] >> 4) & 4) === 4,
    tStyleEnabled: ((b[13] >> 4) & 8) === 8,
    style: (b[13] & 0xf) >> 1,
    length: b[14] / 10,
  };
}

/** legacy-v3 and -v4: split alphas in 0.05 steps, the outer one from 0.3; the ratio in 0.01. */
function pixel(b: number[]): PixelCrosshair {
  const bits = b[10] | (b[11] << 8) | (b[12] << 16) | (b[13] << 24);
  return {
    style: b[2] & 0xf,
    followRecoil: (b[2] & 0x10) === 0x10,
    centerDotEnabled: (b[2] & 0x40) === 0x40,
    tStyleEnabled: (b[2] & 0x80) === 0x80,
    red: b[3],
    green: b[4],
    blue: b[5],
    alpha: b[6],
    gap: b[7],
    length: b[8],
    dynamicSpreadLimit: b[9],
    splitDistance: bits & 0x7f,
    innerSplitAlpha: ((bits >> 7) & 0x1f) / 20,
    outerSplitAlpha: (((bits >> 12) & 0xf) + 6) / 20,
    splitSizeRatio: ((bits >> 16) & 0x7f) / 100,
    thickness: (bits >> 23) & 0x1f,
    screenHeight: b[14] | (b[15] << 8),
  };
}

/** cs2-v1, clamped to the ranges CS2 applies on import (as the package does). */
function cs2V1(b: number[]): CrosshairCs2V1 | null {
  const screenHeight = b[2] | (b[3] << 8);
  if (screenHeight === 0) return null;
  const bits = b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24);
  return {
    format: 'cs2-v1',
    style: Math.min(b[4] & 0x1f, 9),
    followRecoil: (b[4] & 0x20) === 0x20,
    centerDotEnabled: (b[4] & 0x40) === 0x40,
    tStyleEnabled: (b[4] & 0x80) === 0x80,
    outlineMode: Math.min(b[13] >>> 6, 2),
    red: b[5],
    green: b[6],
    blue: b[7],
    alpha: b[8],
    outlineRed: b[9],
    outlineGreen: b[10],
    outlineBlue: b[11],
    outlineAlpha: b[12],
    gap: clamp(((b[14] | (b[15] << 8)) << 16) >> 16, -3840, 3840),
    length: b[16],
    thickness: Math.min(b[13] & 0x3f, 32),
    dynamicSpreadLimit: b[17],
    splitDistance: bits & 0x7f,
    innerSplitAlpha: Math.min((bits >> 7) & 0x7f, 100) / 100,
    outerSplitAlpha: (Math.min((bits >> 14) & 0x7f, 70) + 30) / 100,
    splitSizeRatio: Math.min((bits >> 21) & 0x7f, 100) / 100,
    screenHeight: Math.max(screenHeight, 240),
    scopeDotScale: Math.min((b[22] + 10) / 100, 2),
    scopeDotUseCrosshairColor: ((bits >>> 28) & 1) === 1,
  };
}

/** The crosshair of a share code, or null for anything that is not a valid one. */
export function decodeCrosshair(code: string): Crosshair | null {
  if (CS2_CODE.test(code)) {
    const b = charsToBytes(code.slice(2), 32);
    if (!b || !checksumOk(b) || b[1] !== 1) return null;
    return cs2V1(b);
  }
  if (!LEGACY_CODE.test(code)) return null;
  const b = charsToBytes(code.replace(/CSGO|-/g, ''), 18);
  if (!b || !checksumOk(b)) return null;
  switch (b[1]) {
    case 1:
      return legacyV1(b);
    case 3:
      return {
        format: 'legacy-v3',
        ...pixel(b),
        outlineEnabled: (b[2] & 0x20) === 0x20,
      };
    case 4:
      return {
        format: 'legacy-v4',
        ...pixel(b),
        outlineMode: (b[13] >> 4) & 3,
      };
    default:
      return null;
  }
}

/**
 * The crosshair of a player without a code: taken to be CS2's default, a static green cross
 * (the package's legacy-v3 sample `CSGO-hLbCn-69VT6-Bok83-9MOqW-SWzwQ`, CS2's default colour).
 */
export const DEFAULT_CROSSHAIR: CrosshairLegacyV3 = {
  format: 'legacy-v3',
  style: 4,
  followRecoil: false,
  outlineEnabled: false,
  centerDotEnabled: false,
  tStyleEnabled: false,
  red: 50,
  green: 250,
  blue: 50,
  alpha: 255,
  gap: 4,
  length: 8,
  thickness: 2,
  dynamicSpreadLimit: 255,
  splitDistance: 7,
  innerSplitAlpha: 1,
  outerSplitAlpha: 0.4,
  splitSizeRatio: 0.3,
  screenHeight: 1080,
};

export type CrosshairShape = 'cross' | 'circle' | 'dot' | 'square' | 'quad';
export type Rgba = [number, number, number, number];

/** A crosshair in screen pixels: what a canvas draws, centred on the screen. */
export interface CrosshairLook {
  shape: CrosshairShape;
  /** From the centre to each arm's inner end (or the circle's radius); may be negative. */
  gap: number;
  /** Each arm's length. */
  length: number;
  thickness: number;
  color: Rgba;
  outline: { width: number; color: Rgba } | null;
  /** A centre dot, `thickness` wide. */
  dot: boolean;
  /** No top arm. */
  tStyle: boolean;
}

/** The classic unit: a 480th of the screen height. */
const LEGACY_LINES = 480;
/** The classic static cross sits this many units out before its gap. */
const LEGACY_GAP_UNITS = 4;
const LEGACY_COLORS: readonly [number, number, number][] = [
  [250, 50, 50],
  [50, 250, 50],
  [250, 250, 50],
  [50, 50, 250],
  [50, 250, 250],
];

function shapeOf(style: number): CrosshairShape {
  if (style === 1 || style === 3) return 'circle';
  if (style === 6) return 'dot';
  if (style === 8) return 'square';
  if (style === 7 || style === 9) return 'quad';
  return 'cross';
}

/**
 * `c` (null for CS2's default) drawn on a screen `screenHeight` pixels tall. Pixel formats scale
 * from the height they were made at. `legacy-v1` sizes are read as CS:GO's 480-line units with
 * the static cross 4 units out: an approximation, since no conversion from that format to
 * pixels is published. Dynamic styles are drawn static (the replay has no spread).
 */
export function crosshairLook(
  c: Crosshair | null,
  screenHeight: number
): CrosshairLook {
  const x = c ?? DEFAULT_CROSSHAIR;
  if (x.format === 'legacy-v1') {
    const unit = screenHeight / LEGACY_LINES;
    const rgb = LEGACY_COLORS[x.color] ?? [x.red, x.green, x.blue];
    const alpha = x.alphaEnabled ? x.alpha : 255;
    return {
      shape: 'cross',
      gap: (LEGACY_GAP_UNITS + x.gap) * unit,
      length: x.length * unit,
      thickness: Math.max(1, x.thickness * unit),
      color: [rgb[0], rgb[1], rgb[2], alpha],
      outline: x.outlineEnabled
        ? { width: x.outline, color: [0, 0, 0, alpha] }
        : null,
      dot: x.centerDotEnabled,
      tStyle: x.tStyleEnabled,
    };
  }
  const scale = screenHeight / (x.screenHeight > 0 ? x.screenHeight : 1080);
  const mode =
    x.format === 'legacy-v3' ? (x.outlineEnabled ? 1 : 0) : x.outlineMode;
  const outlineColor: Rgba =
    x.format === 'cs2-v1'
      ? [x.outlineRed, x.outlineGreen, x.outlineBlue, x.outlineAlpha]
      : [0, 0, 0, x.alpha];
  return {
    shape: shapeOf(x.style),
    gap: x.gap * scale,
    length: x.length * scale,
    thickness: x.thickness * scale,
    color: [x.red, x.green, x.blue, x.alpha],
    outline:
      mode === 0 ? null : { width: mode === 2 ? 0.5 : 1, color: outlineColor },
    dot: x.centerDotEnabled,
    tStyle: x.tStyleEnabled,
  };
}
