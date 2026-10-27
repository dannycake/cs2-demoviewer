// The device the page runs on (a phone, a mobile GPU) and the HUD's layout for a window size.

import { describe, expect, it } from 'vitest';
import {
  hudLayout,
  isMobileDevice,
  isMobileGpu,
  isPhone,
  readDevice,
  type DeviceInfo,
} from '../src/state/device';

function device(d: Partial<DeviceInfo>): DeviceInfo {
  return {
    coarse: false,
    touchPoints: 0,
    screenW: 2560,
    screenH: 1440,
    gpu: '',
    ...d,
  };
}

describe('isMobileGpu', () => {
  it('knows the mobile GPUs by name', () => {
    expect(
      isMobileGpu(
        device({ gpu: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)' })
      )
    ).toBe(true);
    for (const gpu of [
      'Mali-G710 MC10',
      'PowerVR Rogue GE8320',
      'Immortalis-G715',
      'Samsung Xclipse 920',
    ])
      expect(isMobileGpu(device({ gpu }))).toBe(true);
  });

  it("takes Apple's GPU for a mobile one only with a touch screen", () => {
    expect(isMobileGpu(device({ gpu: 'Apple GPU', touchPoints: 5 }))).toBe(
      true
    );
    expect(isMobileGpu(device({ gpu: 'Apple GPU', touchPoints: 0 }))).toBe(
      false
    );
  });

  it('is false for a desktop GPU on a fine pointer', () => {
    expect(
      isMobileGpu(
        device({
          gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)',
        })
      )
    ).toBe(false);
  });

  it('is true for any GPU on a phone', () => {
    expect(
      isMobileGpu(device({ coarse: true, screenW: 393, screenH: 851, gpu: '' }))
    ).toBe(true);
  });
});

describe('isPhone', () => {
  it('is a coarse pointer on a screen under 600 px on its short side', () => {
    expect(isPhone(device({ coarse: true, screenW: 393, screenH: 851 }))).toBe(
      true
    );
    expect(isPhone(device({ coarse: true, screenW: 851, screenH: 393 }))).toBe(
      true
    );
  });

  it('is not a tablet, nor a small window on a fine pointer', () => {
    expect(
      isPhone(device({ coarse: true, screenW: 1024, screenH: 1366 }))
    ).toBe(false);
    expect(isPhone(device({ coarse: false, screenW: 393, screenH: 851 }))).toBe(
      false
    );
  });
});

describe('readDevice', () => {
  const win = (coarse: boolean) =>
    ({
      matchMedia: (q: string) => ({
        matches: q === '(pointer: coarse)' && coarse,
      }),
      navigator: { maxTouchPoints: coarse ? 5 : 0 },
      screen: { width: 412, height: 915 },
    }) as unknown as Window;

  it('reads the pointer, the touch points and the screen', () => {
    expect(readDevice(win(true))).toEqual({
      coarse: true,
      touchPoints: 5,
      screenW: 412,
      screenH: 915,
      gpu: '',
    });
    expect(readDevice(win(false)).coarse).toBe(false);
  });

  it("reads the GPU from WEBGL_debug_renderer_info, '' without it", () => {
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    const gl = (ext: boolean) =>
      ({
        getExtension: (name: string) =>
          ext && name === 'WEBGL_debug_renderer_info'
            ? { UNMASKED_RENDERER_WEBGL }
            : null,
        getParameter: (p: number) =>
          p === UNMASKED_RENDERER_WEBGL ? 'Adreno (TM) 740' : 'WebKit WebGL',
      }) as unknown as WebGL2RenderingContext;
    expect(readDevice(win(true), gl(true)).gpu).toBe('Adreno (TM) 740');
    expect(readDevice(win(true), gl(false)).gpu).toBe('');
    expect(readDevice(win(true), null).gpu).toBe('');
  });

  it('reads nothing without a window', () => {
    expect(readDevice(undefined)).toEqual({
      coarse: false,
      touchPoints: 0,
      screenW: 0,
      screenH: 0,
      gpu: '',
    });
  });
});

describe('isMobileDevice', () => {
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  /**
   * A window on a phone's screen with a finger, or a desktop's with a mouse, whose canvases make
   * a WebGL 2 context naming `gpu` (none for null); `contexts` lists those made and whether each
   * was let go.
   */
  function win(phone: boolean, gpu: string | null) {
    const contexts: { lost: boolean }[] = [];
    const w = {
      matchMedia: (q: string) => ({
        matches: q === '(pointer: coarse)' && phone,
      }),
      navigator: { maxTouchPoints: phone ? 5 : 0 },
      screen: phone
        ? { width: 412, height: 915 }
        : { width: 2560, height: 1440 },
      document: {
        createElement: (tag: string) => {
          expect(tag).toBe('canvas');
          return {
            getContext: (kind: string) => {
              expect(kind).toBe('webgl2');
              if (gpu === null) return null;
              const made = { lost: false };
              contexts.push(made);
              return {
                getExtension: (name: string) =>
                  name === 'WEBGL_debug_renderer_info'
                    ? { UNMASKED_RENDERER_WEBGL }
                    : name === 'WEBGL_lose_context'
                      ? { loseContext: () => (made.lost = true) }
                      : null,
                getParameter: (p: number) =>
                  p === UNMASKED_RENDERER_WEBGL ? gpu : 'WebKit WebGL',
              };
            },
          };
        },
      },
    } as unknown as Window;
    return { w, contexts };
  }

  it('says a phone is one without making a WebGL context', () => {
    const { w, contexts } = win(true, 'Adreno (TM) 740');
    expect(isMobileDevice(w)).toBe(true);
    expect(contexts).toEqual([]);
  });

  it("asks anything else's GPU with a context of its own, and lets it go", () => {
    const adreno = win(false, 'Adreno (TM) X1-85');
    expect(isMobileDevice(adreno.w)).toBe(true);
    expect(adreno.contexts).toEqual([{ lost: true }]);
    const desktop = win(false, 'ANGLE (NVIDIA GeForce RTX 4070)');
    expect(isMobileDevice(desktop.w)).toBe(false);
    expect(desktop.contexts).toEqual([{ lost: true }]);
  });

  it('is not one without WebGL 2', () => {
    expect(isMobileDevice(win(false, null).w)).toBe(false);
  });
});

describe('hudLayout', () => {
  const narrow = {
    narrow: true,
    killfeedRows: 3,
    roundFeed: false,
    minimap: false,
    playerList: 'sheet',
    card: 'compact',
    scoreColumns: 'compact',
  };
  const wide = {
    narrow: false,
    killfeedRows: 5,
    roundFeed: true,
    minimap: true,
    playerList: 'column',
    card: 'full',
    scoreColumns: 'all',
  };

  it('is narrow on a phone, held either way', () => {
    expect(hudLayout(390, 844)).toEqual(narrow);
    expect(hudLayout(844, 390)).toEqual(narrow);
  });

  it('is wide on a desktop window', () => {
    expect(hudLayout(1280, 720)).toEqual(wide);
  });

  it('is narrow below 720 wide or 480 tall', () => {
    expect(hudLayout(719, 1000).narrow).toBe(true);
    expect(hudLayout(720, 480).narrow).toBe(false);
    expect(hudLayout(1000, 479).narrow).toBe(true);
  });

  it('is the same object for the same layout, so a resize within it re-renders nothing', () => {
    expect(hudLayout(390, 844)).toBe(hudLayout(412, 839));
    expect(hudLayout(1280, 720)).toBe(hudLayout(2560, 1440));
  });
});
