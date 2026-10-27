// The page at `/`: drop or pick a demo, which goes up in gzip'd 32 MiB chunks with a
// progress bar, chunk n/N and MB/s, or paste a Valve replay URL for the server to fetch, or,
// while the server takes them (`GET /api/site`), a match share code for it to look up.
// A failed upload shows the server's error and a Retry that continues from the failed chunk
// in the same upload. Either way the page moves to `/d/<demoId>`, where the viewer waits
// for the parse; a demo the server already has (`cached`) opens there straight away.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { getSite } from '../api/site';
import {
  CHUNK_SIZE,
  UploadError,
  ingestShareCode,
  ingestUrl,
  isDemoFile,
  resumeUpload,
  uploadDemo,
  type OnUploadProgress,
  type UploadProgress,
  type UploadResult,
} from '../api/upload';
import DropZone from '../components/DropZone';
import SourceLink from '../components/SourceLink';
import { messageOf } from '../errors';
import { pageTitle, routeToPath } from '../router';
import { NOT_A_SHARE_CODE, extractShareCode } from '../sharecode';
import styles from './UploadView.module.css';

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

const ACCEPT = '.dem,.bz2,.gz';

const PHASE_TEXT: Record<UploadProgress['phase'], string> = {
  gzip: 'Compressing',
  put: 'Sending',
  complete: 'Finishing',
};

function formatMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Moves the app to the viewer; App re-reads the route on popstate. */
function openDemo(demoId: string) {
  history.pushState(null, '', routeToPath({ view: 'demo', demoId }));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** `file`'s chunks at `chunkSize`: the server's once it opened the upload, else today's. */
function chunksOf(file: File, chunkSize = CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(file.size / chunkSize));
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
        <span className={styles.fileSize}>{formatMB(file.size)}</span>
      </p>
      <span
        className={styles.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((done / total) * 100)}
      >
        <span
          className={styles.barDone}
          style={{ width: `${(done / total) * 100}%` }}
        />
        <span
          className={styles.barCurrent}
          style={{ width: `${(current / total) * 100}%` }}
        />
      </span>
      <p className={styles.detail}>
        <span>{progress ? PHASE_TEXT[progress.phase] : 'Starting'}</span>
        <span>
          chunk {shown}/{chunks}
        </span>
        <span>
          {formatMB(done)} / {formatMB(file.size)}
        </span>
        {rate !== null && <span>{formatMB(rate)}/s</span>}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={onCancel}>
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
        <span className={styles.fileSize}>{formatMB(file.size)}</span>
      </p>
      <p className={styles.errorTitle}>{title}</p>
      <p className={styles.errorText}>{error.message}</p>
      <div className={styles.actions}>
        {error.resumable ? (
          <>
            <button type="button" className={styles.primary} onClick={onRetry}>
              {retryText}
            </button>
            <button
              type="button"
              className={styles.button}
              onClick={onStartOver}
            >
              Start over
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.primary}
            onClick={onStartOver}
          >
            {error.upload === null ? 'Retry' : 'Start over'}
          </button>
        )}
        <button type="button" className={styles.button} onClick={onDismiss}>
          Choose another file
        </button>
      </div>
    </section>
  );
}

export default function UploadView() {
  const [upload, setUpload] = useState<Upload>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [sharecodes, setSharecodes] = useState(false);
  const [code, setCode] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);

  // Leaving the page stops the upload; the server drops an unfinished one after an hour.
  useEffect(() => () => running.current?.abort(), []);

  useEffect(() => {
    document.title = pageTitle();
  }, []);

  // The share-code field shows only while the server can look codes up.
  useEffect(() => {
    const ac = new AbortController();
    getSite({ signal: ac.signal }).then((site) => {
      if (!ac.signal.aborted) setSharecodes(site.sharecodes);
    });
    return () => ac.abort();
  }, []);

  // A file dropped beside the zone would otherwise replace the page with the file itself.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
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
        openDemo(demoId);
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

  const onFile = (file: File) => {
    if (!isDemoFile(file.name)) {
      setNotice(
        `${file.name} is not a demo: choose a .dem, .dem.bz2 or .dem.gz file.`
      );
      return;
    }
    run(file, (onProgress, signal) => uploadDemo(file, onProgress, signal));
  };

  const retry = () => {
    if (upload.kind !== 'failed') return;
    const { file, error } = upload;
    const opened = error.upload;
    if (opened === null) {
      run(file, (p, s) => uploadDemo(file, p, s));
      return;
    }
    run(file, (p, s) => resumeUpload(file, opened, error.chunk, p, s));
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

  const onSubmitUrl = async (e: FormEvent) => {
    e.preventDefault();
    const target = url.trim();
    if (!target || fetching) return;
    setFetching(true);
    setUrlError(null);
    try {
      const { demoId } = await ingestUrl(target);
      openDemo(demoId);
    } catch (err) {
      setUrlError(messageOf(err));
      setFetching(false);
    }
  };

  const onSubmitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || lookingUp) return;
    const found = extractShareCode(code);
    if (!found) {
      setCodeError(NOT_A_SHARE_CODE);
      return;
    }
    setLookingUp(true);
    setCodeError(null);
    try {
      const { demoId } = await ingestShareCode(found);
      openDemo(demoId);
    } catch (err) {
      setCodeError(messageOf(err));
      setLookingUp(false);
    }
  };

  const busy = upload.kind === 'sending' || fetching || lookingUp;

  return (
    <main className={styles.view}>
      <div className={styles.column}>
        <header className={styles.header}>
          <h1 className={styles.title}>
            <img src="/skunk-mark.svg" alt="" width={44} height={37} />
            cs.skunk.to
          </h1>
          <p className={styles.lead}>
            Watch a Counter-Strike 2 match in 3D, in your browser. Drop its demo
            and the match is rebuilt from the recording: follow any player, look
            through their eyes, or fly over the map.
          </p>
        </header>

        {upload.kind === 'idle' && (
          <DropZone
            onFile={onFile}
            accept={ACCEPT}
            disabled={fetching || lookingUp}
          >
            <span className={styles.dropTitle}>Drop a demo here</span>
            <span className={styles.dropHint}>
              or click to choose a .dem, .dem.bz2 or .dem.gz file, up to
              500&nbsp;MB
            </span>
          </DropZone>
        )}
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
        {notice && (
          <p className={styles.notice} role="alert">
            {notice}
          </p>
        )}

        <p className={styles.or} aria-hidden="true">
          or
        </p>

        <form className={styles.urlForm} onSubmit={onSubmitUrl}>
          <label className={styles.urlLabel} htmlFor="replay-url">
            Valve replay URL
          </label>
          <div className={styles.urlRow}>
            <input
              id="replay-url"
              className={styles.urlInput}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://replay183.valve.net/730/…_….dem.bz2"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setUrlError(null);
              }}
              disabled={busy}
            />
            <button
              type="submit"
              className={styles.primary}
              disabled={busy || !url.trim()}
            >
              {fetching ? 'Fetching…' : 'Fetch'}
            </button>
          </div>
          {urlError && (
            <p className={styles.errorText} role="alert">
              {urlError}
            </p>
          )}
        </form>

        {sharecodes && (
          <form className={styles.urlForm} onSubmit={onSubmitCode}>
            <label className={styles.urlLabel} htmlFor="share-code">
              Match share code
            </label>
            <div className={styles.urlRow}>
              <input
                id="share-code"
                className={styles.urlInput}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeError(null);
                }}
                disabled={busy}
              />
              <button
                type="submit"
                className={styles.primary}
                disabled={busy || !code.trim()}
              >
                {lookingUp ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
            {codeError && (
              <p className={styles.errorText} role="alert">
                {codeError}
              </p>
            )}
          </form>
        )}

        <footer className={styles.footer}>
          <p className={styles.note}>
            Uploaded demos are deleted as soon as they are packed into a replay.
            Replays are kept: the link keeps working after Valve deletes the
            demo.
          </p>
          <SourceLink className={styles.source} />
        </footer>
      </div>
    </main>
  );
}
