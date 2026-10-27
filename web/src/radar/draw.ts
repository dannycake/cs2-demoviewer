// Paints a radar frame (`frame.ts`) into a square of a 2D canvas, bottom to top: the map image,
// the site letters, smokes, fires, grenades and their bursts, kill lines, deaths, the bomb, then
// the players with the shown one last. Marks keep their size whatever the zoom (the caller
// zooms by narrowing the crop), so zooming in spreads the players out. Anything on another
// level than the one drawn is hollow at half opacity.

import { TEAM_HEX, css } from '../scene/colors';
import type { Crop } from './overview';
import type {
  RadarBomb,
  RadarEffect,
  RadarFrame,
  RadarKill,
  RadarPlayer,
  RadarProjectile,
} from './frame';

/** The parts of a 2D context the painter uses (a test records them). */
export interface RadarCtx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void;
  setLineDash(segments: number[]): void;
}

/** Where a frame is painted. */
export interface RadarView {
  /** The target square, canvas pixels. */
  x: number;
  y: number;
  size: number;
  /** The radar pixels shown in it. */
  crop: Crop;
  /** The level drawn: an index into `Overview.sections`. */
  level: number;
  /** Canvas pixels per CSS pixel. */
  dpr: number;
}

/** The HUD's team colours (`--t`, `--ct`), as the 3D view draws them (`TEAM_HEX`). */
export const TEAM_COLOR: Readonly<Record<number, string>> = {
  2: css(TEAM_HEX[2]),
  3: css(TEAM_HEX[3]),
};
const NEUTRAL = '#c8ccd2';
export const SMOKE_FILL = 'rgba(196, 202, 210, 0.55)';
const FIRE_FILL = '#ff7a2e';
const C4 = '#e5484d';
const DEFUSED = '#46c37b';
const LABEL = '#101114';
const SITE = 'rgba(255, 255, 255, 0.6)';
const FONT = '"JetBrains Mono", ui-monospace, monospace';

const TAU = Math.PI * 2;

/** A player's disc radius in canvas pixels: 1.4 % of the square, never under 5 CSS pixels. */
export function discRadius(size: number, dpr: number): number {
  return Math.max(5 * dpr, 0.014 * size);
}

/** Discs smaller than this (CSS pixels) carry no digit: it would not be legible. */
const LABEL_MIN_R = 7;

const colorOf = (team: number | null) =>
  (team !== null ? TEAM_COLOR[team] : undefined) ?? NEUTRAL;

/** The map image, then the layers, into `view`. `map` null paints the layers alone. */
export function drawRadar(
  g: RadarCtx,
  frame: RadarFrame,
  map: CanvasImageSource | null,
  view: RadarView
): void {
  const { crop, size } = view;
  const k = size / crop.w;
  const sx = (x: number) => view.x + (x - crop.x) * k;
  const sy = (y: number) => view.y + (y - crop.y) * k;
  /** A player's disc radius; every other mark is sized from it. */
  const r = discRadius(size, view.dpr);
  const P: Painter = { g, sx, sy, k, r, view };

  g.save();
  if (map) {
    g.globalAlpha = 0.9;
    g.drawImage(
      map,
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      view.x,
      view.y,
      size,
      size
    );
    g.globalAlpha = 1;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineCap = 'round';
  g.lineJoin = 'round';

  g.font = `700 ${Math.round(r * 2.2)}px ${FONT}`;
  g.fillStyle = SITE;
  for (const s of frame.sites) g.fillText(s.label, sx(s.x), sy(s.y));

  for (const e of frame.effects) if (e.kind === 'smoke') smoke(P, e);
  for (const e of frame.effects) if (e.kind === 'fire') fire(P, e);
  for (const p of frame.projectiles) projectile(P, p);
  for (const e of frame.effects)
    if (e.kind !== 'smoke' && e.kind !== 'fire') burst(P, e);
  for (const kl of frame.kills) killLine(P, kl);
  for (const d of frame.deaths) death(P, d.x, d.y, d.team, d.level);
  if (frame.bomb) bomb(P, frame.bomb);
  g.font = `700 ${Math.round(r * 1.25)}px ${FONT}`;
  for (const p of frame.players) playerMark(P, p);
  g.restore();
}

interface Painter {
  g: RadarCtx;
  sx(x: number): number;
  sy(y: number): number;
  /** Canvas pixels per radar pixel. */
  k: number;
  /** A player's disc radius, canvas pixels. */
  r: number;
  view: RadarView;
}

/** The alpha for something on `level`: half on a level other than the one drawn. */
const levelAlpha = (P: Painter, level: number) =>
  level === P.view.level ? 1 : 0.5;

function circle(g: RadarCtx, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, Math.max(0, r), 0, TAU);
}

function smoke(P: Painter, e: RadarEffect): void {
  const { g } = P;
  const x = P.sx(e.x);
  const y = P.sy(e.y);
  const radius = e.radius * P.k * Math.min(1, 0.4 + 0.6 * e.age);
  const a = levelAlpha(P, e.level);
  g.globalAlpha = a;
  circle(g, x, y, radius);
  if (a === 1) {
    g.fillStyle = SMOKE_FILL;
    g.fill();
  }
  // The time left: an arc clockwise from the top.
  g.lineWidth = 2 * P.view.dpr;
  g.strokeStyle = '#ffffff';
  g.beginPath();
  g.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + (1 - e.progress) * TAU);
  g.stroke();
  g.globalAlpha = 1;
}

function fire(P: Painter, e: RadarEffect): void {
  const { g } = P;
  const pulse = 0.5 + 0.5 * Math.sin(e.age * TAU * 1.5);
  g.globalAlpha = (0.35 + 0.15 * pulse) * levelAlpha(P, e.level);
  circle(g, P.sx(e.x), P.sy(e.y), e.radius * P.k);
  g.fillStyle = FIRE_FILL;
  if (e.level === P.view.level) g.fill();
  else {
    g.strokeStyle = FIRE_FILL;
    g.lineWidth = 1.5 * P.view.dpr;
    g.stroke();
  }
  g.globalAlpha = 1;
}

function burst(P: Painter, e: RadarEffect): void {
  const { g } = P;
  const x = P.sx(e.x);
  const y = P.sy(e.y);
  const a = levelAlpha(P, e.level);
  g.lineWidth = 2 * P.view.dpr;
  if (e.kind === 'decoy') {
    g.globalAlpha = (0.5 + 0.5 * Math.abs(Math.sin(e.age * Math.PI * 2))) * a;
    g.fillStyle = colorOf(e.team);
    circle(g, x, y, P.r * 0.35);
    g.fill();
  } else {
    // A flash's white ring and an HE's orange one grow and fade over the burst.
    g.globalAlpha = (1 - e.progress) * a;
    g.strokeStyle = e.kind === 'flash' ? '#ffffff' : FIRE_FILL;
    circle(g, x, y, e.radius * P.k * (0.25 + 0.75 * e.progress));
    g.stroke();
  }
  g.globalAlpha = 1;
}

function projectile(P: Painter, p: RadarProjectile): void {
  const { g, r } = P;
  const a = levelAlpha(P, p.level);
  const n = p.trail.length;
  if (n === 0) return;
  g.strokeStyle = colorOf(p.team);
  g.lineWidth = 1.5 * P.view.dpr;
  // Older segments fainter.
  for (let i = 1; i < n; i++) {
    g.globalAlpha = (0.15 + 0.6 * (i / (n - 1))) * a;
    g.beginPath();
    g.moveTo(P.sx(p.trail[i - 1][0]), P.sy(p.trail[i - 1][1]));
    g.lineTo(P.sx(p.trail[i][0]), P.sy(p.trail[i][1]));
    g.stroke();
  }
  const [hx, hy] = p.trail[n - 1];
  g.globalAlpha = a;
  circle(g, P.sx(hx), P.sy(hy), r * 0.4);
  g.fillStyle = '#ffffff';
  g.fill();
  g.lineWidth = P.view.dpr;
  g.stroke();
  g.globalAlpha = 1;
}

function killLine(P: Painter, kl: RadarKill): void {
  const { g } = P;
  g.globalAlpha = 0.9 * (1 - kl.age) * levelAlpha(P, kl.level);
  g.strokeStyle = kl.headshot ? '#ffffff' : colorOf(kl.team);
  g.lineWidth = 1.5 * P.view.dpr;
  g.beginPath();
  g.moveTo(P.sx(kl.from[0]), P.sy(kl.from[1]));
  g.lineTo(P.sx(kl.to[0]), P.sy(kl.to[1]));
  g.stroke();
  g.globalAlpha = 1;
}

function death(
  P: Painter,
  rx: number,
  ry: number,
  team: number,
  level: number
): void {
  const { g } = P;
  const x = P.sx(rx);
  const y = P.sy(ry);
  const s = P.r * 0.75;
  g.globalAlpha = 0.75 * levelAlpha(P, level);
  g.strokeStyle = colorOf(team);
  g.lineWidth = 2 * P.view.dpr;
  g.beginPath();
  g.moveTo(x - s, y - s);
  g.lineTo(x + s, y + s);
  g.moveTo(x + s, y - s);
  g.lineTo(x - s, y + s);
  g.stroke();
  g.globalAlpha = 1;
}

/** The C4 mark: a small rounded block, centred on (x, y). */
function c4Mark(g: RadarCtx, x: number, y: number, s: number, color: string) {
  g.fillStyle = color;
  g.fillRect(x - s / 2, y - s * 0.35, s, s * 0.7);
}

function bomb(P: Painter, b: RadarBomb): void {
  if (b.state === 'carried') return; // drawn with the carrier
  const { g, r } = P;
  const x = P.sx(b.x);
  const y = P.sy(b.y);
  const a = levelAlpha(P, b.level);
  if (b.state === 'exploded') {
    if (b.age >= 1) return;
    g.globalAlpha = (1 - b.age) * a;
    g.strokeStyle = C4;
    g.lineWidth = 3 * P.view.dpr;
    circle(g, x, y, r * (1 + 11 * b.age));
    g.stroke();
    g.globalAlpha = 1;
    return;
  }
  g.globalAlpha = a;
  if (b.state === 'planted' && b.blink) {
    g.globalAlpha = 0.35 * a;
    g.fillStyle = C4;
    circle(g, x, y, r * 1.5);
    g.fill();
    g.globalAlpha = a;
  }
  const dim = b.state === 'planted' && !b.blink;
  c4Mark(
    g,
    x,
    y,
    r * 1.6,
    b.state === 'defused' ? DEFUSED : dim ? '#8f2f33' : C4
  );
  g.globalAlpha = 1;
}

function playerMark(P: Painter, p: RadarPlayer): void {
  const { g, r } = P;
  const x = P.sx(p.x);
  const y = P.sy(p.y);
  const color = colorOf(p.team);
  const here = p.level === P.view.level;
  const a = here ? 1 : 0.5;

  // The view cone, a short translucent wedge 90° wide; none on another level.
  if (here) {
    g.globalAlpha = 0.22;
    g.fillStyle = p.shown ? '#ffffff' : color;
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, r * 3.4, p.dir - Math.PI / 4, p.dir + Math.PI / 4);
    g.closePath();
    g.fill();
  }

  g.globalAlpha = a;
  if (p.hit > 0) {
    g.globalAlpha = p.hit * a;
    g.strokeStyle = C4;
    g.lineWidth = 2 * P.view.dpr;
    circle(g, x, y, r * 1.6);
    g.stroke();
    g.globalAlpha = a;
  }
  if (p.shot) {
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2 * P.view.dpr;
    g.beginPath();
    g.moveTo(x + Math.cos(p.dir) * r * 1.15, y + Math.sin(p.dir) * r * 1.15);
    g.lineTo(x + Math.cos(p.dir) * r * 2.1, y + Math.sin(p.dir) * r * 2.1);
    g.stroke();
  }

  circle(g, x, y, r);
  if (here) {
    g.fillStyle = color;
    g.fill();
    if (p.blind > 0) {
      g.globalAlpha = p.blind;
      g.fillStyle = '#ffffff';
      g.fill();
      g.globalAlpha = 1;
    }
    g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    g.lineWidth = P.view.dpr;
    g.stroke();
    g.fillStyle = LABEL;
  } else {
    g.strokeStyle = color;
    g.lineWidth = 2 * P.view.dpr;
    g.stroke();
    g.fillStyle = color;
  }
  if (p.label && r >= LABEL_MIN_R * P.view.dpr)
    g.fillText(p.label, x, y + r * 0.06);

  if (p.bomb) c4Mark(g, x + r * 1.1, y + r * 1.1, r * 1.1, C4);
  if (p.shown) {
    g.globalAlpha = a;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2 * P.view.dpr;
    circle(g, x, y, r * 1.45);
    g.stroke();
  }
  g.globalAlpha = 1;
}
