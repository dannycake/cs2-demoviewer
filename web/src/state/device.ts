// What the page runs on and how the HUD lays out on it. A phone (a coarse pointer on a screen
// under 600 px on its short side) or a mobile GPU starts at the `low` preset instead of
// measuring (`isMobileDevice`, asked when a demo opens: `useDeviceQuality`), and a phone opens
// on the full radar (`DemoView`). The HUD is narrow
// below 720 px wide or 480 px tall, a phone held either way: three killfeed rows, no round
// feed, no minimap, the player list in a sheet, the compact player card and the scoreboard's
// compact columns. `useHudLayout` follows the window and re-renders only when that changes.

import { useSyncExternalStore } from 'react';

export interface DeviceInfo {
  /** The primary pointer is coarse (a finger). */
  coarse: boolean;
  touchPoints: number;
  /** The screen in CSS pixels, as the device is held. */
  screenW: number;
  screenH: number;
  /** The GPU's unmasked name (WEBGL_debug_renderer_info), '' without it. */
  gpu: string;
}

/** Mobile GPU families, by the names their drivers give. */
const MOBILE_GPU = /Adreno|Mali|PowerVR|Immortalis|Xclipse/i;

/** A phone's screen is under this on its short side; a tablet's is not. */
const PHONE_SHORT_SIDE = 600;

/**
 * The device `win` runs on, and the GPU behind `gl` when given. Without a window (tests, a
 * worker), nothing: a fine pointer, no touch, no screen, no GPU.
 */
export function readDevice(
  win: Window | undefined = typeof window !== 'undefined' ? window : undefined,
  gl?: WebGL2RenderingContext | null
): DeviceInfo {
  let gpu = '';
  if (gl) {
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
    } catch {
      // A lost context or a browser that refuses: no name.
    }
  }
  if (!win)
    return { coarse: false, touchPoints: 0, screenW: 0, screenH: 0, gpu };
  return {
    coarse:
      typeof win.matchMedia === 'function' &&
      win.matchMedia('(pointer: coarse)').matches,
    touchPoints: win.navigator?.maxTouchPoints ?? 0,
    screenW: win.screen?.width ?? 0,
    screenH: win.screen?.height ?? 0,
    gpu,
  };
}

/** A coarse pointer on a screen under 600 px on its short side. */
export function isPhone(d: DeviceInfo): boolean {
  return d.coarse && Math.min(d.screenW, d.screenH) < PHONE_SHORT_SIDE;
}

/**
 * A GPU named as a mobile one, Apple's on a touch screen (an iPhone or iPad; a Mac's has no
 * touch points), or any GPU on a phone.
 */
export function isMobileGpu(d: DeviceInfo): boolean {
  return (
    MOBILE_GPU.test(d.gpu) ||
    (/Apple GPU/.test(d.gpu) && d.touchPoints > 1) ||
    isPhone(d)
  );
}

/**
 * Whether `win` runs on a phone or a mobile GPU (`isMobileGpu`). A phone says so without the
 * GPU's name; anything else is asked with a WebGL 2 context made for the question on a canvas of
 * its own and let go at once (`WEBGL_lose_context`), as the 3D view, which makes its own, may
 * not be made yet. Without WebGL 2, the GPU has no name.
 */
export function isMobileDevice(win: Window = window): boolean {
  if (isPhone(readDevice(win))) return true;
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = win.document.createElement('canvas').getContext('webgl2');
  } catch {
    // A browser that refuses: no name.
  }
  try {
    return isMobileGpu(readDevice(win, gl));
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export interface HudLayout {
  narrow: boolean;
  killfeedRows: number;
  roundFeed: boolean;
  minimap: boolean;
  playerList: 'column' | 'sheet';
  card: 'full' | 'compact';
  scoreColumns: 'all' | 'compact';
}

/** Narrow below this width, or below `NARROW_H` tall. */
export const NARROW_W = 720;
export const NARROW_H = 480;

const WIDE: HudLayout = Object.freeze({
  narrow: false,
  killfeedRows: 5,
  roundFeed: true,
  minimap: true,
  playerList: 'column',
  card: 'full',
  scoreColumns: 'all',
});

const NARROW: HudLayout = Object.freeze({
  narrow: true,
  killfeedRows: 3,
  roundFeed: false,
  minimap: false,
  playerList: 'sheet',
  card: 'compact',
  scoreColumns: 'compact',
});

/** The HUD's layout for a window of `width` × `height`: one object per layout. */
export function hudLayout(width: number, height: number): HudLayout {
  return width < NARROW_W || height < NARROW_H ? NARROW : WIDE;
}

function subscribe(onChange: () => void): () => void {
  // Turning the device fires a resize too.
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

const windowLayout = () => hudLayout(window.innerWidth, window.innerHeight);
const serverLayout = () => WIDE;

/** The layout for the window's size, re-rendering only when it changes. */
export function useHudLayout(): HudLayout {
  return useSyncExternalStore(subscribe, windowLayout, serverLayout);
}
