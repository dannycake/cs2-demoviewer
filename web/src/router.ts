// The app has two views, chosen from the URL: `/` (upload) and `/d/<demoId>` (viewer),
// the viewer optionally starting at a shared moment, `?r=<round>&t=<tick>&cam=<camera>`, with
// `&p=<player>` and, for Free, `&at=<x,y,z,yaw,pitch[,fov]>`. Any other path
// is the upload view. Each part of the moment is read on its own: a bad one is dropped and the
// rest stays. `cam=follow`, the third-person camera there was before POV became the default,
// reads as POV, so an old link opens in POV.

/** A camera in a link: the two modes, and `auto` for POV driven by the director. */
export type UrlCamera = 'pov' | 'free' | 'auto';
const URL_CAMERAS: readonly UrlCamera[] = ['pov', 'free', 'auto'];

/** Scene metres and degrees, as Scene.cameraDebug() reports them. */
export interface FreePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** The vertical field of view; without it, Free keeps its own. */
  fov?: number;
}

/** The field of view a pose may give, in degrees. */
export const FOV_MIN_DEG = 1;
export const FOV_MAX_DEG = 179;

export type Route =
  | { view: 'upload' }
  | {
      view: 'demo';
      demoId: string;
      /** 1-based. */
      round?: number;
      tick?: number;
      cam?: UrlCamera;
      /** The followed player, 1-based (`p=1` is index 0, the player key `1` follows). */
      p?: number;
      /** Free's pose. */
      at?: FreePose;
    };

// Demo ids are base58 from the server; allow the URL-safe alphabet and nothing else.
const DEMO_PATH = /^\/d\/([A-Za-z0-9_-]+)\/?$/;
const ROUND = /^\d+$/;
const TICK = /^\d+(?:\.\d+)?$/;
const PLAYER = /^\d+$/;
const COORD = /^-?\d+(?:\.\d+)?$/;

function readNumber(value: string | null, pattern: RegExp): number | undefined {
  if (value === null || !pattern.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readCamera(value: string | null): UrlCamera | undefined {
  if (value === 'follow') return 'pov';
  return URL_CAMERAS.find((c) => c === value);
}

/**
 * `x,y,z,yaw,pitch`, optionally `,fov`: five or six finite numbers, the sixth from
 * `FOV_MIN_DEG` to `FOV_MAX_DEG`, else undefined.
 */
function readPose(value: string | null): FreePose | undefined {
  if (value === null) return undefined;
  const parts = value.split(',');
  if (parts.length !== 5 && parts.length !== 6) return undefined;
  const n = parts.map((v) => readNumber(v, COORD));
  if (n.some((v) => v === undefined)) return undefined;
  const [x, y, z, yaw, pitch, fov] = n as number[];
  if (fov === undefined) return { x, y, z, yaw, pitch };
  if (!(fov >= FOV_MIN_DEG && fov <= FOV_MAX_DEG)) return undefined;
  return { x, y, z, yaw, pitch, fov };
}

/** `v` to `digits` decimals, with no `-0.00` for a value that rounds to zero. */
function fixed(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

/** A pose as `at` writes it: metres to 2 decimals, degrees (the fov's too) to 1. */
function writePose(p: FreePose): string {
  const parts = [
    fixed(p.x, 2),
    fixed(p.y, 2),
    fixed(p.z, 2),
    fixed(p.yaw, 1),
    fixed(p.pitch, 1),
  ];
  if (p.fov !== undefined) parts.push(fixed(p.fov, 1));
  return parts.join(',');
}

export function parseRoute(url: URL): Route {
  const m = DEMO_PATH.exec(url.pathname);
  if (!m) return { view: 'upload' };
  const route: Route = { view: 'demo', demoId: m[1] };
  const q = url.searchParams;
  const round = readNumber(q.get('r'), ROUND);
  const tick = readNumber(q.get('t'), TICK);
  const cam = readCamera(q.get('cam'));
  const p = readNumber(q.get('p'), PLAYER);
  const at = readPose(q.get('at'));
  if (round !== undefined) route.round = round;
  if (tick !== undefined) route.tick = tick;
  if (cam !== undefined) route.cam = cam;
  if (p !== undefined && p >= 1) route.p = p;
  if (at !== undefined) route.at = at;
  return route;
}

export function routeToPath(r: Route): string {
  if (r.view === 'upload') return '/';
  const query = new URLSearchParams();
  if (r.round !== undefined) query.set('r', String(r.round));
  if (r.tick !== undefined) query.set('t', String(r.tick));
  if (r.cam !== undefined) query.set('cam', r.cam);
  if (r.p !== undefined) query.set('p', String(r.p));
  if (r.at !== undefined) query.set('at', writePose(r.at));
  // The pose's commas stay readable: a comma needs no escaping in a query.
  const q = query.toString().replace(/%2C/g, ',');
  return `/d/${encodeURIComponent(r.demoId)}${q ? `?${q}` : ''}`;
}

/** The app's name as it appears in the page title. */
export const APP_NAME = 'cs.skunk.to';

/**
 * The document title: the app, then the match's title ("Mirage 13–9", or just the map) and
 * its date when known.
 */
export function pageTitle(title?: string | null, date?: string | null): string {
  if (!title) return APP_NAME;
  return date ? `${APP_NAME} — ${title} — ${date}` : `${APP_NAME} — ${title}`;
}
