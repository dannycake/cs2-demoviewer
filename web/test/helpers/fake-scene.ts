// A stand-in for the 3D view's `Scene` in component tests (jsdom has no WebGL): it records what
// it was made with and asked, in order, and its loads wait until the test settles them. Mock
// scene/Scene with it (`vi.mock('../src/scene/Scene', sceneModule)`); `FakeScene.made` lists
// the scenes made since `FakeScene.reset()`.

import { vi } from 'vitest';
import type { MatchHeader, Pack } from '../../src/pack/types';
import type { FreePose } from '../../src/router';
import type { Quality } from '../../src/scene/quality';
import type { Scene } from '../../src/scene/Scene';
import type { CameraMode } from '../../src/sim/follow';

/** A load the test settles. */
export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeScene {
  /** The scenes made since `reset`, in order. */
  static made: FakeScene[] = [];
  /** Thrown by the next scene made (a browser without WebGL 2), once. */
  static failNext: Error | null = null;

  static reset(): void {
    FakeScene.made = [];
    FakeScene.failNext = null;
  }

  readonly stats = {
    fps: 0,
    tris: 0,
    probe: Number.NaN,
    frames: 0,
    worldShadows: 0,
  };
  readonly hullVersion = 0;
  /** What was asked, in order: `quality low`, `map de_mirage at low`, `render`, `dispose`. */
  readonly log: string[] = [];
  readonly maps: Deferred[] = [];
  readonly rigs: Deferred[] = [];
  /** What `probeFps` answers. */
  probeAnswer = 120;
  quality: Quality;
  readonly measured: boolean;
  readonly canvas: HTMLCanvasElement;
  disposed = false;
  readonly setHidden = vi.fn((hidden: boolean) => {
    this.log.push(`hidden ${hidden}`);
  });
  readonly setCamera = vi.fn(
    (mode: CameraMode, follow: number | null, pinned = false) => {
      this.log.push(`camera ${mode} ${follow} ${pinned}`);
    }
  );
  readonly setFrame = vi.fn((round: number, tick: number, pack: Pack) => {
    void pack;
    this.log.push(`frame ${round}:${tick}`);
  });
  readonly render = vi.fn(() => {
    this.stats.frames++;
    this.log.push('render');
  });
  readonly setFreePose = vi.fn((p: FreePose) => {
    this.log.push(`pose ${p.x},${p.y},${p.z}`);
  });
  readonly keepFreePose = vi.fn();
  readonly flyKey = vi.fn((code: string, down: boolean) => {
    void code;
    return down;
  });
  readonly clearFlyKeys = vi.fn();
  readonly pickPlayer = vi.fn((x: number, y: number): number | null => {
    void x;
    void y;
    return null;
  });
  readonly listener = vi.fn(() => false);
  readonly surfaceBelow = vi.fn(() => null);
  readonly memory = vi.fn(() => ({ geometries: 0, textures: 0 }));
  readonly cameraDebug = vi.fn(() => ({
    x: 1,
    y: 2,
    z: 3,
    yaw: 0,
    pitch: 0,
    fov: 60,
    mode: 'pov' as CameraMode,
    shown: null,
  }));

  constructor(canvas: HTMLCanvasElement, quality: Quality, measured = false) {
    if (FakeScene.failNext) {
      const e = FakeScene.failNext;
      FakeScene.failNext = null;
      throw e;
    }
    this.canvas = canvas;
    this.quality = quality;
    this.measured = measured;
    this.log.push(`made at ${quality}${measured ? ' measured' : ''}`);
    FakeScene.made.push(this);
  }

  setQuality(q: Quality, measured = false): void {
    if (q === this.quality) return;
    this.quality = q;
    this.log.push(`quality ${q}${measured ? ' measured' : ''}`);
  }

  loadMap(map: string): Promise<void> {
    this.log.push(`map ${map} at ${this.quality}`);
    const d = deferred();
    this.maps.push(d);
    return d.promise;
  }

  loadRigs(header: MatchHeader): Promise<void> {
    void header;
    this.log.push(`rigs at ${this.quality}`);
    const d = deferred();
    this.rigs.push(d);
    return d.promise;
  }

  probeFps(): Promise<number> {
    this.log.push('probe');
    return Promise.resolve(this.probeAnswer);
  }

  dispose(): void {
    this.disposed = true;
    this.log.push('dispose');
  }
}

/** `f` where a `Scene` is wanted. */
export function asScene(f: FakeScene): Scene {
  return f as unknown as Scene;
}

/** scene/Scene's module with `FakeScene` for `Scene`, the rest as it is. */
export async function sceneModule(
  importOriginal: () => Promise<typeof import('../../src/scene/Scene')>
) {
  return { ...(await importOriginal()), Scene: FakeScene };
}
