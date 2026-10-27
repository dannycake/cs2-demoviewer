import { describe, expect, it } from 'vitest';
import {
  SMOKE_FILL,
  TEAM_COLOR,
  drawRadar,
  type RadarCtx,
  type RadarView,
} from '../src/radar/draw';
import type { RadarFrame, RadarPlayer } from '../src/radar/frame';

interface Op {
  op: string;
  fill: string;
  stroke: string;
  alpha: number;
  args: unknown[];
}

/** A context that records every call with the styles in force, keeping save/restore honest. */
function recorder() {
  const ops: Op[] = [];
  const stack: Pick<
    RadarCtx,
    'fillStyle' | 'strokeStyle' | 'globalAlpha' | 'lineWidth'
  >[] = [];
  const log =
    (op: string) =>
    (...args: unknown[]) => {
      ops.push({
        op,
        fill: String(g.fillStyle),
        stroke: String(g.strokeStyle),
        alpha: g.globalAlpha,
        args,
      });
    };
  const g: RadarCtx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    save() {
      stack.push({
        fillStyle: g.fillStyle,
        strokeStyle: g.strokeStyle,
        globalAlpha: g.globalAlpha,
        lineWidth: g.lineWidth,
      });
    },
    restore() {
      Object.assign(g, stack.pop());
    },
    beginPath: () => {},
    closePath: () => {},
    moveTo: log('moveTo'),
    lineTo: log('lineTo'),
    arc: log('arc'),
    fill: log('fill'),
    stroke: log('stroke'),
    fillRect: log('fillRect'),
    clearRect: log('clearRect'),
    fillText: log('fillText'),
    drawImage: log('drawImage'),
    setLineDash: () => {},
  };
  return { g, ops };
}

const VIEW: RadarView = {
  x: 0,
  y: 0,
  size: 512,
  crop: { x: 0, y: 0, w: 1024, h: 1024 },
  level: 0,
  dpr: 1,
};

function player(o: Partial<RadarPlayer>): RadarPlayer {
  return {
    index: 0,
    label: '1',
    team: 2,
    x: 500,
    y: 500,
    dir: 0,
    level: 0,
    blind: 0,
    hit: 0,
    shot: false,
    bomb: false,
    shown: false,
    ...o,
  };
}

function frame(o: Partial<RadarFrame>): RadarFrame {
  return {
    sites: [],
    players: [],
    deaths: [],
    kills: [],
    effects: [],
    projectiles: [],
    bomb: null,
    ...o,
  };
}

const MAP = { width: 1024, height: 1024 } as unknown as CanvasImageSource;
/** The index of the last op matching `pred`, or -1. */
function lastIndex(ops: Op[], pred: (o: Op) => boolean): number {
  for (let i = ops.length - 1; i >= 0; i--) if (pred(ops[i])) return i;
  return -1;
}
const firstFill = (ops: Op[], style: string) =>
  ops.findIndex((o) => o.op === 'fill' && o.fill === style);
const lastFill = (ops: Op[], style: string) =>
  lastIndex(ops, (o) => o.op === 'fill' && o.fill === style);

describe('drawRadar', () => {
  it('draws the map first, the crop into the target square', () => {
    const r = recorder();
    drawRadar(r.g, frame({}), MAP, {
      ...VIEW,
      x: 10,
      y: 20,
      crop: { x: 100, y: 50, w: 800, h: 800 },
    });
    expect(r.ops[0].op).toBe('drawImage');
    expect(r.ops[0].args).toEqual([MAP, 100, 50, 800, 800, 10, 20, 512, 512]);
  });

  it('draws bottom to top: utility, then deaths, then players', () => {
    const r = recorder();
    drawRadar(
      r.g,
      frame({
        players: [player({})],
        deaths: [{ x: 300, y: 300, team: 3, level: 0 }],
        effects: [
          {
            kind: 'smoke',
            x: 600,
            y: 600,
            level: 0,
            radius: 28.8,
            progress: 0.5,
            age: 3,
            team: 2,
          },
        ],
      }),
      MAP,
      VIEW
    );
    const smoke = firstFill(r.ops, SMOKE_FILL);
    const death = r.ops.findIndex(
      (o) => o.op === 'stroke' && o.stroke === TEAM_COLOR[3]
    );
    const disc = firstFill(r.ops, TEAM_COLOR[2]);
    expect(smoke).toBeGreaterThan(0);
    expect(death).toBeGreaterThan(smoke);
    expect(disc).toBeGreaterThan(death);
  });

  it('draws the shown player last, ringed in white', () => {
    const r = recorder();
    drawRadar(
      r.g,
      frame({
        players: [
          player({ index: 1, team: 2 }),
          player({ index: 0, team: 3, shown: true }),
        ],
      }),
      MAP,
      VIEW
    );
    expect(lastFill(r.ops, TEAM_COLOR[3])).toBeGreaterThan(
      lastFill(r.ops, TEAM_COLOR[2])
    );
    const ring = lastIndex(
      r.ops,
      (o) => o.op === 'stroke' && o.stroke === '#ffffff'
    );
    expect(ring).toBeGreaterThan(lastFill(r.ops, TEAM_COLOR[3]));
  });

  it('draws a player on the other level hollow at half opacity', () => {
    const r = recorder();
    drawRadar(r.g, frame({ players: [player({ level: 1 })] }), MAP, VIEW);
    expect(firstFill(r.ops, TEAM_COLOR[2])).toBe(-1);
    const outline = r.ops.find(
      (o) => o.op === 'stroke' && o.stroke === TEAM_COLOR[2]
    );
    expect(outline?.alpha).toBe(0.5);
  });

  it('whitens a blind player by how blind they are', () => {
    const r = recorder();
    drawRadar(r.g, frame({ players: [player({ blind: 0.6 })] }), MAP, VIEW);
    const white = r.ops.findIndex(
      (o) => o.op === 'fill' && o.fill === '#ffffff'
    );
    expect(white).toBeGreaterThan(firstFill(r.ops, TEAM_COLOR[2]));
    expect(r.ops[white].alpha).toBeCloseTo(0.6, 6);
  });

  it('rings a smoke with the time it has left', () => {
    const r = recorder();
    drawRadar(
      r.g,
      frame({
        effects: [
          {
            kind: 'smoke',
            x: 512,
            y: 512,
            level: 0,
            radius: 28.8,
            progress: 0.25,
            age: 4.5,
            team: 2,
          },
        ],
      }),
      MAP,
      VIEW
    );
    const arcs = r.ops
      .filter((o) => o.op === 'arc')
      .map((o) => o.args as number[]);
    const partial = arcs.find(
      ([, , , s, e]) => Math.abs(e - s - 1.5 * Math.PI) < 1e-9
    );
    expect(partial).toBeDefined();
    // Radar pixel 512 is canvas pixel 256 in a 512 px square over the whole image.
    expect(partial![0]).toBe(256);
  });

  it('draws nothing but the background without a map image', () => {
    const r = recorder();
    drawRadar(r.g, frame({ players: [player({})] }), null, VIEW);
    expect(r.ops.some((o) => o.op === 'drawImage')).toBe(false);
    expect(firstFill(r.ops, TEAM_COLOR[2])).toBeGreaterThan(-1);
  });
});
