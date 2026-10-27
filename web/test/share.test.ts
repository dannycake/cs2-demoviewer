// Share a moment: the link carries the round, the tick, the camera and the player (or, in Free,
// the pose), and the Share button hands it to the phone's share sheet, the clipboard, or a field.

import { describe, expect, it, vi } from 'vitest';
import { FLAG } from '../src/pack/types';
import { parseRoute } from '../src/router';
import { shareLink, shareUrl } from '../src/state/share';
import type { PlaybackState } from '../src/state/store';
import { playbackPack } from './helpers/playback-pack';
import { event, trackPack } from './helpers/track-pack';

const HREF = 'https://cs.skunk.to/d/abc?r=1&t=2&cam=free&debug=1#x';

type Shared = Pick<
  PlaybackState,
  'pack' | 'round' | 'tick' | 'camera' | 'director' | 'follow' | 'followPinned'
>;

function state(over: Partial<Shared> = {}): Shared {
  return {
    pack: playbackPack({
      rounds: Array.from({ length: 6 }, (_, i) => ({
        start: i * 2000,
        end: i * 2000 + 1500,
      })),
    }),
    round: 4,
    tick: 8000.4,
    camera: 'pov',
    director: false,
    follow: 3,
    followPinned: true,
    ...over,
  };
}

const search = (url: string) => new URL(url).search;

describe('shareUrl', () => {
  it('writes the round (1-based), the tick, POV and the player (1-based)', () => {
    const url = shareUrl(state(), HREF, null);
    expect(search(url)).toBe('?r=5&t=8000&cam=pov&p=4');
    // The demo's page, and nothing else from the address: no debug, no hash.
    expect(url).toBe('https://cs.skunk.to/d/abc?r=5&t=8000&cam=pov&p=4');
  });

  it('writes Free with its selected player and its pose, metres to 2 decimals and degrees to 1', () => {
    const url = shareUrl(state({ camera: 'free' }), HREF, {
      x: 1.234,
      y: 4,
      z: -5.678,
      yaw: 90,
      pitch: -12.34,
    });
    expect(search(url)).toBe(
      '?r=5&t=8000&cam=free&p=4&at=1.23,4.00,-5.68,90.0,-12.3'
    );
    expect(url).toContain('cam=free&p=4&at=1.23,4.00,-5.68,90.0,-12.3');
    // It reads back as the pose it was written from.
    const route = parseRoute(new URL(url));
    expect(route.view === 'demo' && route.at).toEqual({
      x: 1.23,
      y: 4,
      z: -5.68,
      yaw: 90,
      pitch: -12.3,
    });
  });

  it('writes the field of view as a sixth number, to 1 decimal', () => {
    const url = shareUrl(state({ camera: 'free' }), HREF, {
      x: 1.234,
      y: 4,
      z: -5.678,
      yaw: 90,
      pitch: -12.34,
      fov: 73.7397,
    });
    expect(search(url)).toBe(
      '?r=5&t=8000&cam=free&p=4&at=1.23,4.00,-5.68,90.0,-12.3,73.7'
    );
    const route = parseRoute(new URL(url));
    expect(route.view === 'demo' && route.at).toEqual({
      x: 1.23,
      y: 4,
      z: -5.68,
      yaw: 90,
      pitch: -12.3,
      fov: 73.7,
    });
  });

  it('writes Free without at when there is no pose', () => {
    expect(search(shareUrl(state({ camera: 'free' }), HREF, null))).toBe(
      '?r=5&t=8000&cam=free&p=4'
    );
  });

  it('writes the player on screen: the killer an unpinned follow cut to, else its own', () => {
    // Player 1 (index 0) dies at 1100, killed by player 2 (index 1); 2 s on, the camera cuts.
    const pack = trackPack({
      players: [
        (k: number) => ({ x: 0, y: 0, flags: k < 50 ? FLAG.alive : 0 }),
        () => ({ x: 0, y: 200 }),
      ],
      teams: [2, 3],
      events: [event('player_death', 1100, { user_idx: 0, attacker_idx: 1 })],
    });
    const at = state({ pack, round: 0, tick: 1300, follow: 0 });
    for (const camera of ['pov', 'free'] as const) {
      expect(
        search(shareUrl({ ...at, camera, followPinned: false }, HREF, null))
      ).toBe(`?r=1&t=1300&cam=${camera}&p=2`);
      expect(
        search(shareUrl({ ...at, camera, followPinned: true }, HREF, null))
      ).toBe(`?r=1&t=1300&cam=${camera}&p=1`);
    }
  });

  it('writes auto, and no p, while the director drives POV', () => {
    expect(
      search(shareUrl(state({ camera: 'pov', director: true }), HREF, null))
    ).toBe('?r=5&t=8000&cam=auto');
  });

  it('writes POV with the player, and Free with its player while the director is on', () => {
    expect(search(shareUrl(state({ camera: 'pov' }), HREF, null))).toBe(
      '?r=5&t=8000&cam=pov&p=4'
    );
    // The director drives only POV: Free still names its selected player.
    expect(
      search(shareUrl(state({ camera: 'free', director: true }), HREF, null))
    ).toBe('?r=5&t=8000&cam=free&p=4');
  });

  it('leaves out p when nobody is followed, and the pose outside Free', () => {
    expect(search(shareUrl(state({ follow: null }), HREF, null))).toBe(
      '?r=5&t=8000&cam=pov'
    );
    expect(
      search(shareUrl(state(), HREF, { x: 1, y: 2, z: 3, yaw: 4, pitch: 5 }))
    ).toBe('?r=5&t=8000&cam=pov&p=4');
  });

  it('writes only the page without a pack', () => {
    expect(shareUrl(state({ pack: null }), HREF, null)).toBe(
      'https://cs.skunk.to/d/abc'
    );
  });
});

describe('shareLink', () => {
  const URL_ = 'https://cs.skunk.to/d/abc?r=5&t=8000&cam=pov&p=4';

  it("uses the share sheet on a coarse pointer: 'shared'", async () => {
    const share = vi.fn(() => Promise.resolve());
    const writeText = vi.fn(() => Promise.resolve());
    await expect(
      shareLink(URL_, { share, clipboard: { writeText } }, true)
    ).resolves.toBe('shared');
    expect(share).toHaveBeenCalledWith({ url: URL_ });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies on a fine pointer, even with a share sheet: 'copied'", async () => {
    const share = vi.fn(() => Promise.resolve());
    const writeText = vi.fn(() => Promise.resolve());
    await expect(
      shareLink(URL_, { share, clipboard: { writeText } }, false)
    ).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(share).not.toHaveBeenCalled();
  });

  it("copies on a coarse pointer without a share sheet: 'copied'", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await expect(
      shareLink(URL_, { clipboard: { writeText } }, true)
    ).resolves.toBe('copied');
  });

  it("falls back to the field with neither: 'manual'", async () => {
    await expect(shareLink(URL_, {}, false)).resolves.toBe('manual');
    await expect(shareLink(URL_, {}, true)).resolves.toBe('manual');
    await expect(shareLink(URL_, undefined, false)).resolves.toBe('manual');
  });

  it("falls back to the field when the clipboard rejects: 'manual'", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    await expect(
      shareLink(URL_, { clipboard: { writeText } }, false)
    ).resolves.toBe('manual');
    // Only the share sheet's AbortError is a dismissal: the clipboard's is a failure.
    const aborted = vi.fn(() =>
      Promise.reject(new DOMException('aborted', 'AbortError'))
    );
    await expect(
      shareLink(URL_, { clipboard: { writeText: aborted } }, true)
    ).resolves.toBe('manual');
  });

  it("takes a cancelled share sheet as a dismissal: 'shared', no field", async () => {
    const share = vi.fn(() =>
      Promise.reject(new DOMException('cancelled', 'AbortError'))
    );
    const writeText = vi.fn(() => Promise.resolve());
    await expect(
      shareLink(URL_, { share, clipboard: { writeText } }, true)
    ).resolves.toBe('shared');
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the field when the share sheet fails otherwise: 'manual'", async () => {
    const share = vi.fn(() =>
      Promise.reject(new DOMException('no gesture', 'NotAllowedError'))
    );
    const writeText = vi.fn(() => Promise.resolve());
    await expect(
      shareLink(URL_, { share, clipboard: { writeText } }, true)
    ).resolves.toBe('manual');
    expect(writeText).not.toHaveBeenCalled();
    await expect(
      shareLink(URL_, { share: () => Promise.reject(new Error('x')) }, true)
    ).resolves.toBe('manual');
  });

  it("falls back to the field when the clipboard throws at once: 'manual'", async () => {
    const writeText = vi.fn((): Promise<void> => {
      throw new Error('not allowed');
    });
    await expect(
      shareLink(URL_, { clipboard: { writeText } }, false)
    ).resolves.toBe('manual');
  });
});
