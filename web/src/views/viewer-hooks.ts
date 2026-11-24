// DemoView's hooks: what runs while a demo is open, whether or not the 3D view is up (a phone on
// the radar has not shown it yet, and a 3D view that failed has given way to its panel's note):
// - `useDeviceQuality`: a phone or a mobile GPU starts at `low` with nothing measured, decided
//   when the demo opens, before the 3D view makes its scene or loads anything;
// - `useSound`: one engine, its banks and the director while the demo is open;
// - `useClockLoop`: the clock (`startLoop`). Play and the scrubber move it, and each frame draws
//   the 3D view, when there is one, and moves the sound;
// - `useDebugHandle`: `window.__demoviewer`, for the debug HUD and the e2e.
// The 3D view hands its scene over while it has one (`useViewScene`, Viewport's `onScene`): the
// loop draws it, the sound listens from its camera and walks on its hull, and the handle reaches
// it. Without one the sound listens from the eyes of the player the camera shows.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { fetchBytes, SoundBanks } from '../audio/banks';
import { SoundDirector, type SoundDebug } from '../audio/director';
import { contextFor, listenForGestures, SoundEngine } from '../audio/engine';
import type { Scene } from '../scene/Scene';
import type { PropPose } from '../scene/prop';
import type { FreePose } from '../router';
import { browserFrames, startLoop, type FrameScheduler } from '../state/clock';
import { renderCounts } from '../state/derive';
import { isMobileDevice } from '../state/device';
import { settingsStore } from '../state/settings';
import { directedFollow, playbackStore } from '../state/store';

/** What the page hands the debug HUD and the e2e (`useDebugHandle`). */
export interface DebugHandle {
  /** The scene's live stats (`Scene.stats`); all zero (`probe` NaN) while there is no scene. */
  readonly stats: Scene['stats'];
  store: typeof playbackStore;
  /** The renderer's GPU memory counts, for the e2e leak check. */
  memory: () => ReturnType<Scene['memory']>;
  /** Measures the frame rate the scene can draw at its preset (`Scene.probeFps`). */
  probe: (ms?: number) => Promise<number>;
  /**
   * The pose and mode of the camera drawn last (`Scene.cameraDebug`), also the pose the Share
   * button writes in Free.
   */
  camera: () => ReturnType<Scene['cameraDebug']>;
  /** Metres from a scene point to the map's hull, null without one (`Scene.hullDistance`). */
  hullDistance: (x: number, y: number, z: number) => number | null;
  /** Player `i`'s rig as drawn last (`Scene.rigDebug`). */
  rig: (i: number) => ReturnType<Scene['rigDebug']>;
  /** The items on the ground as drawn last (`Scene.groundDebug`). */
  ground: () => ReturnType<Scene['groundDebug']>;
  /** The bullet marks as drawn last (`Scene.marksDebug`). */
  marks: () => ReturnType<Scene['marksDebug']>;
  /** The HUD's renders so far by component (`countRender`), for the e2e performance check. */
  hudRenders: () => Record<string, number>;
  /**
   * Turns the effects' own bloom on or off until the map or its exposure next sets it
   * (`Scene.setEffectsBloom`), for the e2e's frames with and without it.
   */
  effectsBloom: (on: boolean) => void;
  /** The sound director's counts, live (`SoundDirector.debug`). */
  readonly sound?: SoundDebug;
  /** Loads a GLB prop into the scene (`Scene.loadProp`); for the homepage video's render. */
  loadProp: (url: string) => ReturnType<Scene['loadProp']>;
  /** Poses the prop (`Scene.poseProp`). */
  poseProp: (p: PropPose | null) => void;
  /** Puts the free camera at a pose (`Scene.setFreePose`). */
  setFreePose: (p: FreePose) => void;
  /** Draws the store's moment now, as the clock loop would next frame. */
  drawNow: () => void;
  /** The depth of field (`Scene.setDof`). */
  setDof: (o: { focus: number; scale: number; max: number } | null) => void;
}

declare global {
  interface Window {
    /**
     * The store, the HUD's renders and the sound from when a demo opens; the scene's stats and
     * accessors reach the 3D view's scene once it has one (they throw before).
     */
    __demoviewer?: DebugHandle;
  }
}

/** The 3D view's scene as Viewport hands it over (`onScene`), for the hooks below. */
export interface ViewScene {
  /**
   * The scene now, set and cleared by Viewport as it makes and lets go of it: a scene let go is
   * never drawn or listened from again, even before the next render.
   */
  readonly ref: RefObject<Scene | null>;
  /** The same as of the last render: the clock loop starts again with each new one. */
  readonly scene: Scene | null;
  /** Viewport's `onScene`; the same function for the life of the view. */
  readonly onScene: (scene: Scene | null) => void;
}

/** Where the 3D view's scene is kept for DemoView's hooks (`ViewScene`). */
export function useViewScene(): ViewScene {
  const ref = useRef<Scene | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const onScene = useCallback((s: Scene | null) => {
    ref.current = s;
    setScene(s);
  }, []);
  return { ref, scene, onScene };
}

/**
 * A phone or a mobile GPU (`isMobile`, by default `isMobileDevice`) starts at `low` with nothing
 * measured, unless the viewer chose a preset or one was set (`deviceQuality`). Asked when the
 * demo opens: before the 3D view makes its scene at the store's preset, and before any pack,
 * which every world and model load waits for, comes in.
 */
export function useDeviceQuality(
  isMobile: () => boolean = isMobileDevice
): void {
  useEffect(() => {
    const s = playbackStore.getState();
    if (s.qualityFrom === 'default' && isMobile()) s.deviceQuality('low');
  }, [isMobile]);
}

/**
 * The sound: one engine, its banks and the director while the demo is open, which `view`'s scene
 * gives its listener and the surfaces underfoot. A click, tap or key anywhere on the page
 * (`GESTURES`, in the capture phase: before anything stops it) is the gesture browsers want
 * before audio; until then nothing under /sounds/ is fetched. The listeners stay: a gesture
 * costs nothing while the sound runs, and resumes it when a browser did not count the first (a
 * finger's press, Esc) or stopped it since (a phone call). The context is made at the first
 * gesture, at the preset of that moment (24 kHz on `low`). Returns the director, for the clock
 * loop and the debug handle.
 */
export function useSound(view: ViewScene): RefObject<SoundDirector | null> {
  const director = useRef<SoundDirector | null>(null);
  const { ref } = view;
  useEffect(() => {
    const engine = new SoundEngine(() =>
      contextFor(playbackStore.getState().quality)
    );
    const banks = new SoundBanks(fetchBytes, (data) => engine.decode(data));
    const d = new SoundDirector({
      store: playbackStore,
      settings: settingsStore,
      engine,
      banks,
      listener: (out) => ref.current?.listener(out) ?? false,
      surfaceAt: (x, y, z) => ref.current?.surfaceBelow(x, y, z) ?? null,
      surfaceVersion: () => ref.current?.hullVersion ?? 0,
    });
    director.current = d;
    const stopListening = listenForGestures(window, () => d.unlock());
    return () => {
      stopListening();
      if (director.current === d) director.current = null;
      d.dispose();
      banks.close();
      engine.close();
    };
  }, [ref]);
  return director;
}

/**
 * The store's moment in `scene`: the camera (the director's pick while it drives POV) and the
 * frame, drawn. Under the full radar, nothing is drawn.
 */
function drawMoment(scene: Scene): void {
  const s = playbackStore.getState();
  const { follow, pinned } = directedFollow(s);
  scene.setHidden(s.radar);
  if (s.radar) return;
  scene.setCamera(s.camera, follow, pinned);
  if (s.pack) scene.setFrame(s.round, s.tick, s.pack);
  scene.render();
}

/**
 * The clock loop (`startLoop`) while the demo is open: every frame while playing, once per
 * change while paused. Each frame draws `view`'s scene when it has one, then moves the sound,
 * which hears each advance first. It starts again with each new scene, whose first frame then
 * draws it while paused.
 */
export function useClockLoop(
  view: ViewScene,
  director: RefObject<SoundDirector | null>,
  frames: FrameScheduler = browserFrames
): void {
  const { ref, scene } = view;
  useEffect(
    () =>
      startLoop(
        playbackStore,
        () => {
          try {
            if (ref.current) drawMoment(ref.current);
          } finally {
            director.current?.frame();
          }
        },
        frames,
        (from, to, speed) => director.current?.onAdvance(from, to, speed)
      ),
    [ref, scene, director, frames]
  );
}

/** `Scene.stats` while there is no scene. */
export const NO_STATS: Scene['stats'] = Object.freeze({
  fps: 0,
  tris: 0,
  probe: Number.NaN,
  frames: 0,
  worldShadows: 0,
});

/** `window.__demoviewer` while the demo is open (`DebugHandle`). */
export function useDebugHandle(
  view: ViewScene,
  director: RefObject<SoundDirector | null>
): void {
  const { ref } = view;
  useEffect(() => {
    const scene = () => {
      if (!ref.current) throw new Error('demoviewer: the 3D view has no scene');
      return ref.current;
    };
    const handle: DebugHandle = {
      get stats() {
        return ref.current?.stats ?? NO_STATS;
      },
      store: playbackStore,
      memory: () => scene().memory(),
      probe: (ms) => scene().probeFps(ms),
      camera: () => scene().cameraDebug(),
      hullDistance: (x, y, z) => scene().hullDistance(x, y, z),
      rig: (i) => scene().rigDebug(i),
      ground: () => scene().groundDebug(),
      marks: () => scene().marksDebug(),
      hudRenders: renderCounts,
      effectsBloom: (on) => scene().setEffectsBloom(on),
      get sound() {
        return director.current?.debug;
      },
      loadProp: (url) => scene().loadProp(url),
      poseProp: (p) => scene().poseProp(p),
      setFreePose: (p) => scene().setFreePose(p),
      drawNow: () => drawMoment(scene()),
      setDof: (o) => scene().setDof(o),
    };
    window.__demoviewer = handle;
    return () => {
      if (window.__demoviewer === handle) delete window.__demoviewer;
    };
  }, [ref, director]);
}
