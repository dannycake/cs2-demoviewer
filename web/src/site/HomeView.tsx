// The skunk.club homepage (`/`): the hero loop (the chicken in Dust 2 mid while pro kills happen
// behind it, `tools/home-video.sh`; its still for a visitor who asked for less motion), dimmed,
// under a skewed band with the headline, the one input and the demo upload. One demo per upload, picked or dropped anywhere on the page: it goes up in gzip'd
// 32 MiB chunks with a progress bar, and a failed upload shows the server's error and a Retry
// that continues from the failed chunk in the same upload. Once up, the page moves to
// `/d/<demoId>`, where the viewer waits for the parse; a demo the server already has opens there
// straight away. Leaving the page stops the upload. Reached from a FACEIT match's Upload the demo
// (`/?hint=faceit`, site/profile/FaceitHistory), it says the demo will attach to that match on
// the player's profile: anyone may follow the link, not only the player.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { homeVideo } from '../api/site-assets';
import {
  CHUNK_SIZE,
  UploadError,
  resumeUpload,
  uploadDemo,
  type OnUploadProgress,
  type UploadProgress,
  type UploadResult,
} from '../api/upload';
import { messageOf } from '../errors';
import { HOME_TITLE, navigate, pageTitle, routeToPath } from '../router';
import { isPhone, readDevice } from '../state/device';
import about from '../../../server/crates/server/guides/home.html?raw';
import { GUIDE_LINKS } from './guide-links';
import HomeLinks from './HomeLinks';
import OneInput from './OneInput';
import { pickOneDemo } from './pick-one-demo';
import SiteBar from './SiteBar';
import SiteFoot from './SiteFoot';
import SiteLink from './SiteLink';
import { useSiteAssets } from './use-site-assets';
import styles from './HomeView.module.css';

const ACCEPT = '.dem,.bz2,.gz';
type Upload =
  | { kind: 'idle' }
  | {
      kind: 'sending';
      file: File;
      progress: UploadProgress | null;
      /** File bytes per second since this run started, once a chunk is through. */
      rate: number | null;
    }
  | { kind: 'failed'; file: File; error: UploadError };

type Start = (
  onProgress: OnUploadProgress,
  signal: AbortSignal
) => Promise<UploadResult>;

const PHASE_TEXT: Record<UploadProgress['phase'], string> = {
  gzip: 'Compressing',
  put: 'Sending',
  complete: 'Finishing',
};

function formatMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** `file`'s chunks at `chunkSize`: the server's once it opened the upload, else today's. */
function chunksOf(file: File, chunkSize = CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(file.size / chunkSize));
}

/** Whether the visitor asked for less motion: the still stands in for the loop. */
function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

function Sending({
  upload,
  onCancel,
}: {
  upload: Extract<Upload, { kind: 'sending' }>;
  onCancel: () => void;
}) {
  const { file, progress, rate } = upload;
  const chunks = progress?.chunks ?? chunksOf(file);
  const total = Math.max(1, file.size);
  const done = progress?.bytes ?? 0;
  // The chunk on its way is drawn as a pulsing segment after the part already sent.
  const current =
    progress && progress.phase !== 'complete'
      ? Math.min(file.size, (progress.chunk + 1) * progress.chunkSize) - done
      : 0;
  const shown = progress ? Math.min(progress.chunk + 1, progress.chunks) : 1;
  return (
    <section
      className={styles.card}
      data-testid="upload-progress"
      aria-live="polite"
    >
      <p className={styles.file}>
        <span className={styles.fileName}>{file.name}</span>
        <span className="n">{formatMB(file.size)}</span>
      </p>
      <span
        className={styles.meter}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((done / total) * 100)}
      >
        <span
          className={styles.meterDone}
          style={{ width: `${(done / total) * 100}%` }}
        />
        <span
          className={styles.meterCurrent}
          style={{ width: `${(current / total) * 100}%` }}
        />
      </span>
      <p className={styles.detail}>
        <span>{progress ? PHASE_TEXT[progress.phase] : 'Starting'}</span>
        <span className="n">
          chunk {shown}/{chunks}
        </span>
        <span className="n">
          {formatMB(done)} / {formatMB(file.size)}
        </span>
        {rate !== null && <span className="n">{formatMB(rate)}/s</span>}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function Failed({
  upload,
  onRetry,
  onStartOver,
  onDismiss,
}: {
  upload: Extract<Upload, { kind: 'failed' }>;
  onRetry: () => void;
  onStartOver: () => void;
  onDismiss: () => void;
}) {
  const { file, error } = upload;
  const chunks = chunksOf(file, error.upload?.chunkSize);
  let title: string;
  if (error.upload === null) title = 'The upload could not start';
  else if (error.chunk >= chunks) title = 'The upload could not finish';
  else title = `Chunk ${error.chunk + 1} of ${chunks} failed`;
  const retryText =
    error.chunk >= chunks ? 'Retry' : `Retry from chunk ${error.chunk + 1}`;
  return (
    <section className={styles.card} role="alert" data-testid="upload-error">
      <p className={styles.file}>
        <span className={styles.fileName}>{file.name}</span>
        <span className="n">{formatMB(file.size)}</span>
      </p>
      <p className={styles.errorTitle}>{title}</p>
      <p className={styles.errorText}>{error.message}</p>
      <div className={styles.actions}>
        {error.resumable ? (
          <>
            <button type="button" className={styles.go} onClick={onRetry}>
              {retryText}
            </button>
            <button
              type="button"
              className={styles.ghost}
              onClick={onStartOver}
            >
              Start over
            </button>
          </>
        ) : (
          <button type="button" className={styles.go} onClick={onStartOver}>
            {error.upload === null ? 'Retry' : 'Start over'}
          </button>
        )}
        <button type="button" className={styles.ghost} onClick={onDismiss}>
          Choose another file
        </button>
      </div>
    </section>
  );
}

/** What the page says above the upload when reached from a FACEIT match's Upload the demo. */
const FACEIT_HINT =
  "Upload your FACEIT demo (download it from the match room) and it will attach to the match on the player's profile";

export default function HomeView() {
  const [upload, setUpload] = useState<Upload>({ kind: 'idle' });
  const [faceitHint] = useState(
    () => new URLSearchParams(window.location.search).get('hint') === 'faceit'
  );
  const [notice, setNotice] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const assets = useSiteAssets();
  const video = assets && homeVideo(assets);
  const reduced = useReducedMotion();
  const [phone] = useState(() => isPhone(readDevice(window)));

  // Leaving the page stops the upload; the server drops an unfinished one after an hour.
  useEffect(() => () => running.current?.abort(), []);

  useEffect(() => {
    document.title = pageTitle(HOME_TITLE);
  }, []);

  const run = useCallback((file: File, start: Start) => {
    running.current?.abort();
    const ac = new AbortController();
    running.current = ac;
    setNotice(null);
    setUpload({ kind: 'sending', file, progress: null, rate: null });
    let first: { at: number; bytes: number } | null = null;
    const onProgress: OnUploadProgress = (p) => {
      if (ac.signal.aborted) return;
      const now = performance.now();
      first ??= { at: now, bytes: p.bytes };
      const secs = (now - first.at) / 1000;
      const sent = p.bytes - first.bytes;
      const rate = sent > 0 && secs > 0 ? sent / secs : null;
      setUpload({ kind: 'sending', file, progress: { ...p }, rate });
    };
    start(onProgress, ac.signal).then(
      ({ demoId }) => {
        if (ac.signal.aborted) return;
        running.current = null;
        navigate(routeToPath({ view: 'demo', demoId }));
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        running.current = null;
        const error =
          e instanceof UploadError ? e : new UploadError(messageOf(e), 0);
        setUpload({ kind: 'failed', file, error });
      }
    );
  }, []);

  const onFiles = (files: readonly File[]) => {
    if (upload.kind === 'sending') return;
    const picked = pickOneDemo(files);
    if ('error' in picked) {
      setNotice(picked.error);
      return;
    }
    const { file } = picked;
    run(file, (onProgress, signal) => uploadDemo(file, onProgress, signal));
  };

  const retry = () => {
    if (upload.kind !== 'failed') return;
    const { file, error } = upload;
    const opened = error.upload;
    if (opened === null) run(file, (p, s) => uploadDemo(file, p, s));
    else run(file, (p, s) => resumeUpload(file, opened, error.chunk, p, s));
  };

  const startOver = () => {
    if (upload.kind !== 'failed') return;
    const { file } = upload;
    run(file, (p, s) => uploadDemo(file, p, s));
  };

  const cancel = () => {
    running.current?.abort();
    running.current = null;
    setUpload({ kind: 'idle' });
  };

  // The whole page takes a dropped file; anything else dropped is left to the browser.
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    onFiles([...e.dataTransfer.files]);
  };

  return (
    <div
      className="site"
      data-testid="drop-zone"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <SiteBar />
      <main className={styles.hero}>
        {video &&
          (reduced ? (
            <img
              className={styles.poster}
              src={video.poster}
              alt=""
              data-poster
            />
          ) : (
            <video
              className={styles.video}
              autoPlay
              muted
              loop
              playsInline
              poster={video.poster}
              preload={phone ? 'metadata' : 'auto'}
              aria-hidden="true"
            >
              <source src={video.webm} type="video/webm" />
              <source src={video.mp4} type="video/mp4" />
            </video>
          ))}
        <div className={styles.fade} aria-hidden="true" />
        <div className={styles.band}>
          <div className={styles.inner}>
            <h1 className={styles.headline}>
              Watch CS2 demos in 3D, right in your browser.
            </h1>
            <OneInput variant="hero" />
            {faceitHint && <p className={styles.faceitHint}>{FACEIT_HINT}</p>}
            {upload.kind === 'sending' && (
              <Sending upload={upload} onCancel={cancel} />
            )}
            {upload.kind === 'failed' && (
              <Failed
                upload={upload}
                onRetry={retry}
                onStartOver={startOver}
                onDismiss={() => setUpload({ kind: 'idle' })}
              />
            )}
            {upload.kind === 'idle' && (
              <div className={styles.up}>
                <button
                  type="button"
                  className={styles.pick}
                  onClick={() => picker.current?.click()}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 16V4" />
                    <path d="M7 9l5-5 5 5" />
                    <path d="M4 20h16" />
                  </svg>
                  Upload a demo
                </button>
                <div className={styles.hint}>
                  or drop a .dem anywhere on this page
                </div>
                <input
                  ref={picker}
                  type="file"
                  accept={ACCEPT}
                  className={styles.picker}
                  data-testid="file-input"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    onFiles([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                />
              </div>
            )}
            <HomeLinks />
            {notice && (
              <p className={styles.notice} role="alert">
                {notice}
              </p>
            )}
            <p className={styles.kept}>
              Uploaded matches appear on their players&apos; profiles.
            </p>
          </div>
        </div>
      </main>
      <section className={styles.about} data-testid="about">
        {/* Static, first-party HTML (the fragment the server also embeds), never user input. */}
        <div dangerouslySetInnerHTML={{ __html: about }} />
        <nav aria-label="Guides">
          <h2>Guides</h2>
          <ul>
            {GUIDE_LINKS.map((g) => (
              <li key={g.slug}>
                <SiteLink href={`/guides/${g.slug}`}>{g.title}</SiteLink>
              </li>
            ))}
          </ul>
        </nav>
      </section>
      <SiteFoot />
    </div>
  );
}
