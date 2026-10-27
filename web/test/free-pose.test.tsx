// @vitest-environment jsdom
// The free camera's pose for the Share button (state/free-pose): the 3D view hands over its
// scene's camera, and Share writes the pose into a link made in Free without the debug global.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ShareButton from '../src/components/ShareButton';
import { parseRoute } from '../src/router';
import {
  currentFreePose,
  setFreePoseSource,
  type CameraReading,
} from '../src/state/free-pose';
import { playbackStore } from '../src/state/store';
import { trackPack } from './helpers/track-pack';

const reading = (mode: string): CameraReading => ({
  x: 1.5,
  y: 2,
  z: -3.25,
  yaw: 90,
  pitch: -10,
  fov: 60,
  mode,
});

let remove: (() => void) | null = null;
afterEach(() => {
  remove?.();
  remove = null;
  cleanup();
  playbackStore.getState().setPack(null);
});

describe('currentFreePose', () => {
  it('is null without a scene, and outside Free', () => {
    expect(currentFreePose()).toBeNull();
    remove = setFreePoseSource(() => reading('pov'));
    expect(currentFreePose()).toBeNull();
  });

  it("is the camera's pose and field of view in Free", () => {
    remove = setFreePoseSource(() => reading('free'));
    expect(currentFreePose()).toEqual({
      x: 1.5,
      y: 2,
      z: -3.25,
      yaw: 90,
      pitch: -10,
      fov: 60,
    });
  });

  it("a scene's removal leaves the next scene's source in place (StrictMode mounts twice)", () => {
    const first = setFreePoseSource(() => reading('pov'));
    remove = setFreePoseSource(() => reading('free'));
    first();
    expect(currentFreePose()).not.toBeNull();
    remove();
    remove = null;
    expect(currentFreePose()).toBeNull();
  });
});

describe('ShareButton in Free', () => {
  it('writes the free pose into the link without window.__demoviewer', async () => {
    window.history.replaceState(null, '', '/d/demo1');
    delete window.__demoviewer;
    playbackStore
      .getState()
      .setPack(trackPack({ players: [() => ({}), () => ({})], samples: 10 }));
    playbackStore.getState().setCamera('free');
    remove = setFreePoseSource(() => reading('free'));
    render(<ShareButton />);
    // No clipboard here: the link is shown in the field.
    fireEvent.click(screen.getByRole('button', { name: /share/i }));
    const field = (await screen.findByRole('textbox')) as HTMLInputElement;
    const route = parseRoute(new URL(field.value));
    expect(route).toMatchObject({
      view: 'demo',
      demoId: 'demo1',
      cam: 'free',
      at: { x: 1.5, y: 2, z: -3.25, yaw: 90, pitch: -10, fov: 60 },
    });
  });
});
