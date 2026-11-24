// The viewer at `/d/<demoId>`: waits for the server to finish the demo (queued /
// downloading / parsing), loads the pack in the worker, hands it to the store, applies the
// URL's moment (`?r=&t=&cam=&p=`; the viewport places Free's `at`) and checks the map has
// assets. The viewport fills the window (or the full radar does, on `R`); the minimap and
// the player list sit on the left, the round bar top
// centre with a reel's banner under it (or, at a round's end, its summary), the camera bar
// top right with the highlights panel under it, the round feed and the followed player's
// card bottom right, and the transport bar at the bottom. With the setting on, a kill cam
// plays after each death of the followed player. `?hud=0` draws the viewport alone (and the
// loading or error panel), to measure what the HUD costs.
//
// The HUD lays out from `useHudLayout()`. Narrow (a phone, either way up: `state/device`), the
// camera row has the top right to itself; the round bar, a reel's banner and the summary go
// under it (held upright) or to the top left (on its side); the killfeed takes the round
// feed's place over the compact card; the player list is a "Players" button at the bottom
// left that opens a sheet; and the transport wraps onto rows of its own, so what sits above it
// is placed from its measured height. A phone opens on the full radar unless the link names a
// camera: the 3D view, three.js and the scene with it, is a chunk of its own that loads when the
// 3D view first shows, and the world and the player models load then. Anywhere else the 3D view
// loads as the demo opens, beside the pack.
//
// Until the match can be watched, the screen holds one panel and no HUD: what the server is
// doing, the pack's bytes (of its size, with a bar, where the server says it), then the 3D view's
// chunk and the map's first world with its bytes; or why the match cannot be opened, in the
// site's words, with a way home. The HUD comes with the pack, and the server's scoreboard under
// the viewer (`site/pre.ts`) goes then, not before.
//
// The clock loop, the sound and the preset a phone or a mobile GPU starts at are DemoView's
// (`views/viewer-hooks`), not the 3D view's: they run whether or not the 3D view is up, and the
// 3D view hands them its scene while it has one (`onScene`).
//
// Each panel (the 3D view, the radar, every HUD widget) sits behind its own ErrorBoundary
// (`Guard`): a render error in one leaves a quiet note in its place and the rest of the viewer
// on screen, playing on, where App's boundary would replace the whole viewer with its error
// screen (it stays as the last line). After the 3D view fails, play, the scrubber and the sound
// go on without it (the sound listening from the eyes of the player the camera shows) until a
// new pack tries it again.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { preload } from 'react-dom';
import { mapManifest } from '../api/assets';
import { pollDemo, type DemoStatus } from '../api/demos';
import CameraBar from '../components/CameraBar';
import ErrorBoundary from '../components/ErrorBoundary';
import Hud from '../components/Hud';
import Brand from '../components/hud/Brand';
import Digits from '../components/hud/Digits';
import { mapName } from '../components/hud/models';
import { WEAPON_SPRITE } from '../components/hud/weapon-sprite';
import Highlights from '../components/hud/Highlights';
import Killfeed from '../components/hud/Killfeed';
import PlayerCard from '../components/hud/PlayerCard';
import PovOverlay from '../components/hud/PovOverlay';
import ReelBanner from '../components/hud/ReelBanner';
import RoundBar from '../components/hud/RoundBar';
import RoundFeed from '../components/hud/RoundFeed';
import RoundStrip from '../components/hud/RoundStrip';
import RoundSummary from '../components/hud/RoundSummary';
import Scoreboard from '../components/hud/Scoreboard';
import { useScoreboard } from '../components/hud/scoreboard-state';
import Settings from '../components/hud/Settings';
import Whiteout from '../components/hud/Whiteout';
import { messageOf } from '../errors';
import { errorCopy } from './error-copy';
import { isPhone, readDevice, useHudLayout } from '../state/device';
import { settingsStore, useSettings } from '../state/settings';
import PlayerList from '../components/PlayerList';
import Radar from '../components/Radar';
import Transport from '../components/Transport';
import type { ViewportProps, WorldLoad } from '../components/Viewport';
import { matchPageTitle } from '../match-title';
import { loadPack } from '../pack/client';
import { pageTitle } from '../router';
import { chunkOnce, useChunk } from '../use-chunk';
import { isTextEntry, trackFocus } from '../state/focus';
import { handleKey } from '../state/keys';
import {
  applyUrlState,
  readUrlState,
  writeUrlState,
  type UrlState,
} from '../state/url';
import { playbackStore, startAutoKillcam, usePlayback } from '../state/store';
import type { FreePose } from '../router';
import LoadingBar from '../site/LoadingBar';
import OneInput from '../site/OneInput';
import { tuckPre } from '../site/pre';
import SiteBar from '../site/SiteBar';
import styles from './DemoView.module.css';
import { mapNotice, noRoundsNotice, type Notice } from './notices';
import {
  NO_STATS,
  useClockLoop,
  useDebugHandle,
  useDeviceQuality,
  useSound,
  useViewScene,
} from './viewer-hooks';

// The 3D view, with three.js and the scene: a chunk of its own, asked for the first time the
// view shows (`use-chunk`). A deploy since the page loaded reloads it (`importOrReload`).
const loadViewport = chunkOnce(() => import('../components/Viewport'));

/**
 * A loading panel in the middle of the view: what is on its way, a line under it (figures in
 * mono), and a bar of the fraction in when it is known.
 */
function LoadPanel({
  title,
  detail,
  fraction = null,
}: {
  title: string;
  detail?: string;
  fraction?: number | null;
}) {
  return (
    <div className={styles.panel} role="status" aria-live="polite">
      <LoadingBar />
      <p className={styles.panelTitle}>
        <Digits text={title} />
      </p>
      {detail && (
        <p className={styles.panelText}>
          <Digits text={detail} />
        </p>
      )}
      {fraction !== null && (
        <span className={styles.progress}>
          <span style={{ width: `${Math.min(1, fraction) * 100}%` }} />
        </span>
      )}
    </div>
  );
}

/**
 * The 3D view once its chunk is in, and until then the loading panel saying so, once the match
 * is in and the 3D view is what shows (before that the match's panel is the one; with the radar
 * up, nothing). The view mounts as soon as the chunk is in, and always in a commit after the one
 * that mounted DemoView: the device's preset (`useDeviceQuality`) is set before the scene is
 * made, on the page's first demo and on every one after it. A chunk that will not load is thrown
 * to the 3D view's Guard.
 */
function LazyViewport(props: ViewportProps) {
  const Viewport = useChunk(loadViewport)?.default;
  const waiting = usePlayback((s) => s.pack !== null && !s.radar);
  if (!Viewport)
    return waiting ? (
      <div className={styles.overlay}>
        <LoadPanel title="Loading the 3D view" />
      </div>
    ) : null;
  return <Viewport {...props} />;
}

const STATUS_TEXT: Record<DemoStatus['status'], string> = {
  resolving: 'Asking Valve for the replay',
  queued: 'Queued for parsing',
  downloading: 'Downloading the demo',
  parsing: 'Parsing the demo',
  done: 'Loading the match',
  error: 'The demo could not be parsed',
};

function formatMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** "4.2 MB", or "4.2 of 10.3 MB" with the size. */
function bytesText(loaded: number, total: number | null): string {
  return total
    ? `${(loaded / 1048576).toFixed(1)} of ${formatMB(total)}`
    : formatMB(loaded);
}

/**
 * Whether the demo opens on the full radar (`at`, the link's moment): a phone's does, unless the
 * link names a camera, and not without the HUD (`?hud=0`).
 */
function opensOnRadar(at: UrlState, hud: boolean): boolean {
  return hud && at.camera === undefined && isPhone(readDevice());
}

/** The free camera's pose in the link the page opened with (`cam=free&at=…`), or null. */
function linkPose(): FreePose | null {
  const u = readUrlState(new URL(window.location.href));
  return u.camera === 'free' ? (u.at ?? null) : null;
}

/**
 * `children`, one panel of the viewer, behind an ErrorBoundary of its own (`name` is the
 * panel's in the note that takes its place; `place` positions the note). A failed panel tries
 * again with a new pack and, unless `retry` is `'pack'`, the next round: the 3D view only with a
 * new pack, since each try builds a scene. With `reload`, the note offers to reload the page.
 */
function Guard({
  name,
  place,
  retry = 'round',
  reload,
  children,
}: {
  name: string;
  place?: string;
  retry?: 'round' | 'pack';
  reload?: boolean;
  children: ReactNode;
}) {
  const pack = usePlayback((s) => s.pack);
  const round = usePlayback((s) => (retry === 'round' ? s.round : -1));
  // A new identity only when one of them changes: the boundary's `resetKey`.
  const attempt = useMemo(() => ({ pack, round }), [pack, round]);
  return (
    <ErrorBoundary
      region={name}
      className={place}
      resetKey={attempt}
      reload={reload}
    >
      {children}
    </ErrorBoundary>
  );
}

export default function DemoView({ demoId }: { demoId: string }) {
  const [demo, setDemo] = useState<DemoStatus | null>(null);
  const status = usePlayback((s) => s.status);
  const error = usePlayback((s) => s.error);
  const progress = usePlayback((s) => s.progress);
  const hasPack = usePlayback((s) => s.pack !== null);
  /** The match can be watched: the HUD shows (before, and on an error, only the panel). */
  const live = hasPack && status !== 'error';
  const map = usePlayback((s) => s.pack?.header.map ?? null);
  const noRounds = usePlayback((s) => s.pack?.header.rounds.length === 0);
  const assetsMissing = usePlayback((s) => s.assetsMissing);
  /** The map's first world on its way (the 3D view's `onWorldLoad`), or null. */
  const [worldLoad, setWorldLoad] = useState<WorldLoad | null>(null);
  /** The demo whose notice was put away with "Watch without the map". */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const hudScale = useSettings((s) => s.settings.hudScale);
  const minimap = useSettings((s) => s.settings.minimap);
  const radar = usePlayback((s) => s.radar);
  const layout = useHudLayout();
  const view = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const { debug, hud } = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return { debug: q.get('debug') === '1', hud: q.get('hud') !== '0' };
  }, []);
  // Read when the demo opens, before the URL's own updates (`writeUrlState`) drop `at`.
  const [pose] = useState(linkPose);
  /**
   * Whether the 3D view is mounted: as the demo opens, unless it opens on the radar, and then
   * from when it is first shown (a pack, and the radar closed). It stays once mounted.
   */
  const [show3d, setShow3d] = useState(
    () => !opensOnRadar(readUrlState(new URL(window.location.href)), hud)
  );
  if (!show3d && hasPack && !radar) setShow3d(true);
  // The weapons' silhouettes (the player list's, the card's, the killfeed's) come while the
  // match loads, so the HUD shows with them rather than filling them in after.
  preload(WEAPON_SPRITE, { as: 'image' });
  const view3d = useViewScene();
  const director = useSound(view3d);
  useClockLoop(view3d, director);
  useDebugHandle(view3d, director);

  // Status → pack → store → URL position → map manifest.
  useEffect(() => {
    const ac = new AbortController();
    const store = playbackStore;
    store.getState().setPack(null);
    store.setState({
      status: 'loading',
      error: null,
      progress: { loaded: 0, total: null },
    });
    setDemo(null);

    (async () => {
      const last = await pollDemo(demoId, setDemo, ac.signal);
      if (last.status === 'error')
        throw new Error(last.error || STATUS_TEXT.error);
      const pack = await loadPack(
        demoId,
        (loaded, total) => store.setState({ progress: { loaded, total } }),
        ac.signal
      );
      if (ac.signal.aborted) return;
      store.getState().setPack(pack);
      const at = readUrlState(new URL(window.location.href));
      applyUrlState(store, at);
      // A phone opens on the radar, in the same render as the pack, so the 3D view never
      // shows (nor loads) until asked for; a link that names a camera opens on it.
      if (opensOnRadar(at, hud)) store.getState().setRadar(true);
      // A failed manifest request (not a 404) is left to the viewport's world load. The request
      // is the one the 3D view and the radar read the manifest from (`mapManifest`).
      const manifest = await mapManifest(pack.header.map).catch(
        () => undefined
      );
      if (!ac.signal.aborted && manifest === null)
        store.setState({ assetsMissing: true });
    })().catch((e: unknown) => {
      if (ac.signal.aborted) return;
      store.setState({ status: 'error', error: messageOf(e) });
    });

    return () => {
      ac.abort();
      store.getState().setPack(null);
    };
  }, [demoId, hud]);
  // After the load's first request is on its way: a phone or a mobile GPU starts at `low`.
  useDeviceQuality();

  // The server's scoreboard (`site/pre.ts`) goes once the match can be watched; while the pack
  // loads, and after a failure, it stays.
  useEffect(() => {
    if (live) tuckPre();
  }, [live]);

  // The tab names the match, as the server's title does, once the server has its summary, else
  // the map once it is known. Until then it keeps the title the page came with: the server's
  // /d/ page already names a done match.
  const summary = demo?.summary ?? null;
  const shownMap = map ?? demo?.map;
  useEffect(() => {
    if (summary)
      document.title = pageTitle(matchPageTitle(summary));
    else if (shownMap) document.title = pageTitle(shownMap);
  }, [summary, shownMap]);

  // Keyboard map, unless a text field has focus. How each control got focus decides whether
  // Space is its or play and pause (`trackFocus`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      if (handleKey(e, playbackStore)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    const untrack = trackFocus(document);
    return () => {
      window.removeEventListener('keydown', onKey);
      untrack();
    };
  }, []);

  // `?r=&t=&cam=&p=` follows the clock and the camera (throttled to one write a second). With
  // "Kill cam after each death" on, the clock passing the followed player's death and its hold
  // starts its kill cam, in POV with the 3D view up (`autoKillcamDue`).
  useEffect(
    () =>
      playbackStore.subscribe((s, prev) => {
        if (
          s.pack &&
          s.pack === prev.pack &&
          (s.round !== prev.round ||
            s.tick !== prev.tick ||
            s.camera !== prev.camera ||
            s.director !== prev.director ||
            s.follow !== prev.follow ||
            s.followPinned !== prev.followPinned)
        )
          writeUrlState(playbackStore);
        if (settingsStore.getState().settings.autoKillcam)
          startAutoKillcam(playbackStore, s, prev);
      }),
    []
  );

  // Narrow, the transport wraps onto rows of its own: what sits above it (the HUD's corners,
  // the full radar, the panels' heights) reads its height from `--transport-height`. Wide, it
  // is one row of the stylesheet's height.
  const narrow = layout.narrow;
  useLayoutEffect(() => {
    const v = view.current;
    const b = bar.current;
    if (!v || !b) return;
    if (!narrow) {
      v.style.removeProperty('--transport-height');
      return;
    }
    const write = () =>
      v.style.setProperty('--transport-height', `${b.offsetHeight}px`);
    write();
    const observer = new ResizeObserver(write);
    observer.observe(b);
    return () => {
      observer.disconnect();
      v.style.removeProperty('--transport-height');
    };
  }, [narrow, hud, live]);

  // Wide, the round bar is centred at the top; where it would run into the camera row at the
  // right (a tablet's width, a big HUD size), it goes under the row (`data-stack`).
  const top = useRef<HTMLDivElement>(null);
  const cameraRow = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const v = view.current;
    const t = top.current;
    const c = cameraRow.current;
    if (!v || !t || !c || narrow) return;
    const check = () => {
      const round = t.querySelector('[role="group"][aria-label="Round"]');
      const stack =
        !!round &&
        round.getBoundingClientRect().right + 8 >
          c.getBoundingClientRect().left;
      if (v.dataset.stack !== String(stack)) v.dataset.stack = String(stack);
    };
    check();
    // Without the observer (a test's DOM), the one check.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    for (const el of [v, t, c]) observer?.observe(el);
    return () => {
      observer?.disconnect();
      delete v.dataset.stack;
    };
  }, [narrow, hud, live]);
  /** Narrow, the open scoreboard takes the room the player card had. */
  const scoreboardOpen = useScoreboard((s) => s.held || s.pinned);

  let overlay: ReactNode = null;
  let notice: Notice | null = null;
  if (hasPack && noRounds) notice = noRoundsNotice();
  else if (hasPack && assetsMissing && map && dismissed !== demoId)
    notice = mapNotice(map);
  if (notice) {
    overlay = (
      <div className={styles.panel} role="alert" data-testid="notice">
        <p className={styles.panelTitle}>{notice.title}</p>
        <p className={styles.panelText}>{notice.text}</p>
        <div className={styles.actions}>
          {!noRounds && (
            <button
              type="button"
              className={styles.button}
              onClick={() => setDismissed(demoId)}
            >
              Watch without the map
            </button>
          )}
          <a className={styles.link} href="/">
            Upload another demo
          </a>
        </div>
      </div>
    );
  } else if (status === 'error') {
    const copy = errorCopy(error ?? '');
    overlay = (
      <div className={styles.panel} role="alert">
        <p className={styles.panelTitle}>{copy.title}</p>
        <p className={styles.panelText}>{copy.text}</p>
        <div className={styles.actions}>
          <a className={styles.button} href="/">
            Upload a demo
          </a>
        </div>
      </div>
    );
  } else if (!hasPack) {
    const title =
      demo && demo.status !== 'done'
        ? STATUS_TEXT[demo.status]
        : demo
          ? `Loading the match${progress.loaded ? ` · ${bytesText(progress.loaded, progress.total)}` : ''}`
          : 'Looking up the match';
    const fraction =
      demo?.status === 'done' && progress.total
        ? progress.loaded / progress.total
        : null;
    const detail = demo?.map
      ? `${mapName(demo.map)}${demo.rounds ? ` · ${demo.rounds} rounds` : ''}`
      : undefined;
    overlay = <LoadPanel title={title} detail={detail} fraction={fraction} />;
  } else if (worldLoad && !radar && map) {
    overlay = (
      <LoadPanel
        title="Loading the map"
        detail={`${mapName(map)} · ${bytesText(worldLoad.loaded, worldLoad.total)}`}
        fraction={worldLoad.total ? worldLoad.loaded / worldLoad.total : null}
      />
    );
  }

  // The chunk's wait shows its note, and its failure, after the reload, the panel's note. That
  // note offers a reload: a new pack is the 3D view's only other try, and a chunk that failed
  // stays failed for the page. The debug corner (`?debug=1`) reads the scene's stats, zero
  // without one.
  const viewport = (
    <>
      {show3d && (
        <Guard name="the 3D view" place={styles.viewNote} retry="pack" reload>
          <LazyViewport
            onScene={view3d.onScene}
            pose={pose}
            onWorldLoad={setWorldLoad}
          />
        </Guard>
      )}
      {debug && <Hud stats={view3d.scene?.stats ?? NO_STATS} />}
    </>
  );

  if (!hud)
    return (
      <div className={styles.view}>
        {viewport}
        {overlay && <div className={styles.overlay}>{overlay}</div>}
      </div>
    );

  // With the HUD, the site's bar on top says where this is (the mark, the one input, sign-in);
  // the viewer fills the screen under it.
  return (
    <>
      <div className={`site site-chrome ${styles.siteBar}`}>
        <SiteBar search={<OneInput variant="bar" />} />
      </div>
      <div
        ref={view}
        className={`${styles.view} ${styles.underBar}`}
        data-narrow={narrow}
        data-scoreboard={scoreboardOpen}
        style={{ '--hud-scale': hudScale } as CSSProperties}
      >
        {viewport}
        {radar && (
          <Guard name="the radar" place={styles.viewNote}>
            <Radar mode="full" />
          </Guard>
        )}
        {live && (
          <>
            <div className={styles.pov}>
              <Guard name="the first-person overlay" place={styles.viewNote}>
                <PovOverlay />
                <Whiteout />
              </Guard>
            </div>
            <div className={styles.left}>
              {minimap && layout.minimap && !radar && hasPack && (
                <Guard name="the minimap">
                  <Radar mode="mini" />
                </Guard>
              )}
              <Guard name="the match title">
                <Brand />
              </Guard>
              <Guard name="the player list">
                <PlayerList mode={layout.playerList} />
              </Guard>
            </div>
            <div ref={top} className={styles.top}>
              <Guard name="the round bar">
                <RoundBar />
              </Guard>
              <Guard name="the reel banner">
                <ReelBanner />
              </Guard>
              <Guard name="the round summary">
                <RoundSummary />
              </Guard>
            </div>
            <div className={styles.camera}>
              <div ref={cameraRow} className={styles.cameraRow}>
                <Guard name="the settings">
                  <Settings playback={narrow} />
                </Guard>
                <Guard name="the camera bar">
                  <CameraBar compact={narrow} />
                </Guard>
                <Guard name="the highlights">
                  <Highlights />
                </Guard>
              </div>
              {!narrow && (
                <Guard name="the killfeed">
                  <Killfeed rows={layout.killfeedRows} />
                </Guard>
              )}
            </div>
            <div className={styles.feed}>
              {layout.roundFeed && (
                <Guard name="the round feed">
                  <RoundFeed />
                </Guard>
              )}
              {narrow && (
                <Guard name="the killfeed">
                  <Killfeed rows={layout.killfeedRows} />
                </Guard>
              )}
              <Guard name="the player card">
                <PlayerCard compact={layout.card === 'compact'} />
              </Guard>
            </div>
            <div className={styles.transport}>
              <div className={styles.strip}>
                <Guard name="the round strip">
                  <RoundStrip />
                </Guard>
              </div>
              <Guard name="the transport">
                <Transport ref={bar} />
              </Guard>
            </div>
            <div className={styles.scoreboard}>
              <Guard name="the scoreboard">
                <Scoreboard columns={layout.scoreColumns} />
              </Guard>
            </div>
          </>
        )}
        {overlay && <div className={styles.overlay}>{overlay}</div>}
      </div>
    </>
  );
}
