// The 3D view: owns the canvas and one `Scene`, which it hands to DemoView while it has it
// (`onScene`): DemoView's clock loop draws it from the store every frame while playing and once
// per change while paused, and the sound listens from its camera (`views/viewer-hooks`). Here it
// loads the world and the rigs for the loaded pack at the store's quality preset. `data-ready`
// turns true once the pack, the rigs and the world (or the knowledge that the map has no assets)
// are in. With no preset saved, chosen or set for the device, the first second after that
// measures the scene at `medium` and picks the preset from it. A browser without WebGL 2 gets a
// banner instead of the 3D view; the player list, the transport and the sound keep working. The
// fly camera's keys (`W A S D Q E`, Shift) are tracked here, outside text fields, and all let go
// when the window loses focus. A shared link in Free (`cam=free&at=…`, read by DemoView when the
// demo opens: `pose`) places the free camera at its pose once the view is ready: a new map frames
// Free afresh, so the pose waits for the map. While the full radar is up and the 3D view has
// never been shown, neither the world nor the player models are fetched: they load when the 3D
// view first shows. The scene loads the world and the players at its preset's tier (`low`'s
// phone tier, smaller textures, where the assets have it) and swaps them on a change to or from
// `low`, which the view waits for as for the first load; a preset measured here keeps the files
// it was measured with. A tap on a player follows them; a finger's tap on empty space plays or
// pauses.

import { useEffect, useRef, useState } from 'react';
import { messageOf } from '../errors';
import { isTap } from '../geo/pick';
import type { Pack } from '../pack/types';
import type { FreePose } from '../router';
import { MissingAssetsError, Scene } from '../scene/Scene';
import { isDismissal } from '../state/dismiss';
import { isTextEntry } from '../state/focus';
import { setFreePoseSource } from '../state/free-pose';
import { backToFree } from '../state/reel';
import { playbackStore, usePlayback } from '../state/store';
import { mapName } from './hud/models';
import styles from './Viewport.module.css';

type LoadState = 'loading' | 'done' | 'failed';

export interface ViewportProps {
  /**
   * Hears the scene once it is made, and null when it is let go (on unmount). The same function
   * for the life of the view: a new one makes a new scene.
   */
  onScene: (scene: Scene | null) => void;
  /** The free camera's pose in the link the demo opened with (`cam=free&at=…`), or null. */
  pose: FreePose | null;
}

export default function Viewport({ onScene, pose }: ViewportProps) {
  const viewRef = useRef<HTMLDivElement>(null);
  /** The canvas the current scene draws on, made with it (see the scene's effect). */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  /** Why the 3D view could not be made (no WebGL 2 context); null while it works. */
  const [glError, setGlError] = useState<string | null>(null);
  const pack = usePlayback((s) => s.pack);
  const map = usePlayback((s) => s.map);
  const assetsMissing = usePlayback((s) => s.assetsMissing);
  const quality = usePlayback((s) => s.quality);
  const qualityFrom = usePlayback((s) => s.qualityFrom);
  const radar = usePlayback((s) => s.radar);
  /** Whether the 3D view has shown with a pack since mount: until then nothing loads. */
  const [shown, setShown] = useState(false);
  if (!shown && pack && !radar) setShown(true);
  const [rigs, setRigs] = useState<{
    pack: Pack;
    state: LoadState;
    error?: string;
  } | null>(null);
  const [world, setWorld] = useState<{
    key: string;
    state: LoadState;
    error?: string;
  } | null>(null);
  const posed = useRef(false);

  // The scene, on a canvas made for it and taken out with it: a scene let go loses its WebGL
  // context at once (`Scene.dispose`), and a canvas whose context was lost gives no other, so a
  // scene made again needs a new one (React's StrictMode makes the scene twice in development,
  // on one mount).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const canvas = document.createElement('canvas');
    canvas.className = styles.canvas;
    view.prepend(canvas);
    let s: Scene;
    try {
      // A preset measured on an earlier demo of the page keeps the files it was measured with.
      const st = playbackStore.getState();
      s = new Scene(canvas, st.quality, st.qualityFrom === 'detected');
    } catch (e) {
      setGlError(messageOf(e));
      return () => canvas.remove();
    }
    canvasRef.current = canvas;
    setScene(s);
    onScene(s);
    const unsource = setFreePoseSource(() => s.cameraDebug());
    return () => {
      unsource();
      onScene(null);
      s.dispose();
      canvasRef.current = null;
      canvas.remove();
      setScene(null);
    };
  }, [onScene]);

  // A measured preset keeps the files it was measured with (`Scene.setQuality`).
  useEffect(() => {
    scene?.setQuality(quality, qualityFrom === 'detected');
  }, [scene, quality, qualityFrom]);

  // A reel started in Free (`K`, a killfeed row, a highlight) gives Free back its own pose on
  // the way back, not the reel's last view.
  useEffect(() => {
    if (!scene) return;
    return playbackStore.subscribe((s, prev) => {
      if (backToFree(s, prev)) scene.keepFreePose();
    });
  }, [scene]);

  // The fly camera's keys. A key let go while the window is elsewhere never sends its keyup,
  // so losing focus (alt-tab) or hiding the page lets go of them all.
  useEffect(() => {
    if (!scene) return;
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || isTextEntry(e.target)) return;
      scene.flyKey(e.code, true);
    };
    const up = (e: KeyboardEvent) => {
      scene.flyKey(e.code, false);
    };
    const letGo = () => scene.clearFlyKeys();
    const hidden = () => {
      if (document.hidden) letGo();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', letGo);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', letGo);
      document.removeEventListener('visibilitychange', hidden);
      letGo();
    };
  }, [scene]);

  // Taps on the 3D view: with any pointer, a tap follows the player under it; a finger's tap on
  // empty space plays or pauses (a mouse click there does nothing). A tap is pressed and let go
  // on the canvas itself (not on the HUD over it) with the primary button, and a press while
  // another pointer is down is a gesture, not a tap. Letting go anywhere ends a press. A press
  // that closed an open panel only closes it (`state/dismiss`).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!scene || !canvas) return;
    const downs = new Map<
      number,
      { x: number; y: number; t: number; down: PointerEvent }
    >();
    let gesture = false;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      downs.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
        down: e,
      });
      if (downs.size > 1) gesture = true;
    };
    const end = (e: PointerEvent) => {
      const d = downs.get(e.pointerId);
      if (!d) return;
      downs.delete(e.pointerId);
      const many = gesture;
      if (downs.size === 0) gesture = false;
      if (many || e.type !== 'pointerup' || e.target !== canvas) return;
      if (isDismissal(d.down)) return;
      if (!isTap(d, { x: e.clientX, y: e.clientY, t: e.timeStamp })) return;
      const s = playbackStore.getState();
      if (s.radar) return;
      const r = canvas.getBoundingClientRect();
      const i = scene.pickPlayer(e.clientX - r.left, e.clientY - r.top);
      if (i !== null) s.setFollow(i, true);
      else if (e.pointerType === 'touch') s.toggle();
    };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [scene]);

  // Asked again at each preset: a change of tier's swap is joined (`Scene.setQuality` starts
  // it), and any other change answers at once with the models drawn.
  useEffect(() => {
    if (!scene || !pack || !shown) return;
    let live = true;
    setRigs({ pack, state: 'loading' });
    scene.loadRigs(pack.header).then(
      () => live && setRigs({ pack, state: 'done' }),
      (e) => live && setRigs({ pack, state: 'failed', error: messageOf(e) })
    );
    return () => {
      live = false;
    };
  }, [scene, pack, shown, quality]);

  useEffect(() => {
    if (!scene || !map || !shown) return;
    let live = true;
    const key = `${map}:${quality}`;
    setWorld({ key, state: 'loading' });
    scene.loadMap(map).then(
      () => {
        if (!live) return;
        // A world that loads after an earlier failure clears the "no assets" banner and grid.
        if (playbackStore.getState().assetsMissing)
          playbackStore.setState({ assetsMissing: false });
        setWorld({ key, state: 'done' });
      },
      (e) => {
        if (!live) return;
        if (e instanceof MissingAssetsError) {
          playbackStore.setState({ assetsMissing: true });
          setWorld({ key, state: 'failed' });
        } else setWorld({ key, state: 'failed', error: messageOf(e) });
      }
    );
    return () => {
      live = false;
    };
  }, [scene, map, shown, quality]);

  const worldNow = world && world.key === `${map}:${quality}` ? world : null;
  const rigsNow = rigs && rigs.pack === pack ? rigs : null;
  const ready =
    !!pack &&
    !!rigsNow &&
    rigsNow.state !== 'loading' &&
    (assetsMissing || (!!worldNow && worldNow.state !== 'loading'));
  const swapping = !!pack && !assetsMissing && worldNow?.state === 'loading';
  const drawn = ready && !assetsMissing && worldNow?.state === 'done';

  // A link's pose, once the map is in (or known missing) and while the camera is still Free.
  useEffect(() => {
    if (!scene || !ready || !pose || posed.current) return;
    posed.current = true;
    if (playbackStore.getState().camera === 'free') scene.setFreePose(pose);
  }, [scene, ready, pose]);

  // Nothing saved, chosen or set for the device: measure the first second of the map and the
  // players at `medium` (the default) and let the store pick the preset from it.
  useEffect(() => {
    if (!scene || !drawn || qualityFrom !== 'default') return;
    let live = true;
    scene.probeFps().then((fps) => {
      if (live) playbackStore.getState().detectQuality(fps);
    });
    return () => {
      live = false;
    };
  }, [scene, drawn, qualityFrom]);

  return (
    <div
      ref={viewRef}
      className={styles.viewport}
      data-testid="viewport"
      data-ready={ready}
    >
      {assetsMissing && <div className={styles.grid} aria-hidden="true" />}
      <div className={styles.banners}>
        {glError && (
          <p className={styles.banner} role="alert" title={glError}>
            This browser cannot draw the 3D view (WebGL 2 is unavailable)
          </p>
        )}
        {assetsMissing && map && (
          <p className={styles.banner} role="status">
            No 3D map for {mapName(map)}
          </p>
        )}
        {worldNow?.error && (
          <p className={styles.banner} role="alert">
            the {map} world did not load: {worldNow.error}
          </p>
        )}
        {rigsNow?.error && (
          <p className={styles.banner} role="alert">
            the player models did not load: {rigsNow.error}
          </p>
        )}
        {swapping && rigsNow && (
          <p className={styles.note} role="status">
            loading the world…
          </p>
        )}
      </div>
    </div>
  );
}
