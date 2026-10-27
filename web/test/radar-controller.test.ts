import { describe, expect, it } from 'vitest';
import { worldToRadar } from '../src/geo/coords';
import { PICK } from '../src/geo/pick';
import { RadarController, type RadarCanvas } from '../src/radar/controller';
import type { RadarCtx } from '../src/radar/draw';
import { parseOverview, type RadarAssets } from '../src/radar/overview';
import type { FrameScheduler } from '../src/state/clock';
import { createPlaybackStore } from '../src/state/store';
import { trackPack } from './helpers/track-pack';

const SECTIONS = [
  {
    name: 'default',
    image: 'radar.png',
    altitudeMin: -495,
    altitudeMax: 10000,
  },
  {
    name: 'lower',
    image: 'radar_lower.png',
    altitudeMin: -10000,
    altitudeMax: -495,
  },
];
const overview = (two: boolean) =>
  parseOverview({
    map: 'de_mirage',
    posX: -3230,
    posY: 1713,
    scale: 5,
    size: 1024,
    sections: two
      ? SECTIONS
      : SECTIONS.slice(0, 1).map((s) => ({ ...s, altitudeMin: -10000 })),
    bombA: [0.54, 0.76],
    bombB: [0.23, 0.28],
  })!;
const bitmap = { width: 1024, height: 1024 } as ImageBitmap;
const assets = (two = false): RadarAssets => ({
  ov: overview(two),
  images: two ? [bitmap, bitmap] : [bitmap],
});

/** A canvas whose context counts map draws and player discs. */
function canvas() {
  const calls: { op: string; args: unknown[] }[] = [];
  const noop = () => {};
  const record =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({ op, args });
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    clearRect: record('clearRect'),
    fillText: record('fillText'),
    drawImage: record('drawImage'),
    setLineDash: noop,
  } as RadarCtx;
  const c: RadarCanvas = { width: 0, height: 0, getContext: () => ctx };
  return { c, calls };
}

function frames() {
  const queue: ((t: number) => void)[] = [];
  const f: FrameScheduler = {
    request: (cb) => queue.push(cb),
    cancel: () => {},
  };
  return {
    f,
    queue,
    run() {
      const now = queue.splice(0);
      for (const cb of now) cb(0);
    },
  };
}

function store() {
  const s = createPlaybackStore({ storage: null });
  s.getState().setPack(
    trackPack({
      players: [
        () => ({ x: 0, y: 0, z: 0 }),
        () => ({ x: 400, y: 400, z: -600 }),
      ],
      teams: [2, 3],
    })
  );
  return s;
}

describe('RadarController', () => {
  it('draws once in the next frame however many changes come before it', () => {
    const { c, calls } = canvas();
    const fr = frames();
    const s = store();
    const rc = new RadarController({
      canvas: c,
      mode: 'mini',
      store: s,
      frames: fr.f,
      dpr: () => 1,
    });
    rc.setAssets(assets());
    rc.resize(200, 200);
    fr.run();
    calls.length = 0;
    s.getState().seekTick(1010);
    s.getState().seekTick(1020);
    s.getState().seekTick(1030);
    expect(fr.queue).toHaveLength(1);
    fr.run();
    expect(calls.filter((x) => x.op === 'drawImage')).toHaveLength(1);
    rc.dispose();
    s.getState().seekTick(1040);
    expect(fr.queue).toHaveLength(0);
  });

  it('sizes the canvas to its box in device pixels', () => {
    const { c } = canvas();
    const rc = new RadarController({
      canvas: c,
      mode: 'mini',
      store: store(),
      frames: frames().f,
      dpr: () => 2,
    });
    rc.resize(150, 150);
    expect([c.width, c.height]).toEqual([300, 300]);
  });

  it('draws nothing without assets', () => {
    const { c, calls } = canvas();
    const fr = frames();
    const rc = new RadarController({
      canvas: c,
      mode: 'mini',
      store: store(),
      frames: fr.f,
      dpr: () => 1,
    });
    rc.resize(200, 200);
    rc.setAssets(null);
    fr.run();
    expect(
      calls.filter((x) => x.op === 'drawImage' || x.op === 'fillText')
    ).toEqual([]);
  });

  it('puts both levels side by side in the full view, one level in the minimap', () => {
    const full = canvas();
    const fr = frames();
    const a = new RadarController({
      canvas: full.c,
      mode: 'full',
      store: store(),
      frames: fr.f,
      dpr: () => 1,
    });
    a.setAssets(assets(true));
    a.resize(1600, 800);
    fr.run();
    const draws = full.calls
      .filter((x) => x.op === 'drawImage')
      .map((x) => x.args[5] as number);
    expect(draws).toHaveLength(2);
    expect(draws[1]).toBeGreaterThanOrEqual(800);
    const mini = canvas();
    const b = new RadarController({
      canvas: mini.c,
      mode: 'mini',
      store: store(),
      frames: fr.f,
      dpr: () => 1,
    });
    b.setAssets(assets(true));
    b.resize(200, 200);
    fr.run();
    expect(mini.calls.filter((x) => x.op === 'drawImage')).toHaveLength(1);
  });

  it('picks the player under a point, and nobody off their discs', () => {
    const { c } = canvas();
    const fr = frames();
    const rc = new RadarController({
      canvas: c,
      mode: 'full',
      store: store(),
      frames: fr.f,
      dpr: () => 1,
    });
    rc.setAssets(assets());
    rc.resize(1024, 1024);
    const [x, y] = rc.toScreen(...worldToRadar(0, 0, overview(false)), 0)!;
    expect(rc.pick(x + 1, y - 1)).toBe(0);
    expect(rc.pick(x + 300, y)).toBeNull();
  });

  it('reaches further for a finger', () => {
    const { c } = canvas();
    const rc = new RadarController({
      canvas: c,
      mode: 'full',
      store: store(),
      frames: frames().f,
      dpr: () => 2,
    });
    rc.setAssets(assets());
    rc.resize(512, 512);
    const [x, y] = rc.toScreen(...worldToRadar(0, 0, overview(false)), 0)!;
    // Below the disc, away from the other player.
    expect(rc.pick(x, y + 30)).toBeNull();
    expect(rc.pick(x, y + 30, PICK.radiusPx)).toBe(0);
    expect(rc.pick(x, y + 60, PICK.radiusPx)).toBeNull();
  });

  it('zooms about the cursor between 1 and 4 times, and a reset undoes it', () => {
    const { c } = canvas();
    const rc = new RadarController({
      canvas: c,
      mode: 'full',
      store: store(),
      frames: frames().f,
      dpr: () => 1,
    });
    rc.setAssets(assets());
    rc.resize(800, 800);
    const before = rc.toRadar(300, 500)!;
    rc.zoomAt(300, 500, 2);
    const after = rc.toRadar(300, 500)!;
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    rc.zoomAt(300, 500, 100);
    expect(rc.zoom).toBe(4);
    rc.panBy(50, 0);
    rc.reset();
    expect(rc.zoom).toBe(1);
    expect(rc.toRadar(300, 500)).toEqual(before);
  });

  it('pinches as it zooms: about the midpoint, between 1 and 4 times', () => {
    const { c } = canvas();
    const rc = new RadarController({
      canvas: c,
      mode: 'full',
      store: store(),
      frames: frames().f,
      dpr: () => 1,
    });
    rc.setAssets(assets());
    rc.resize(800, 800);
    const [cx, cy] = [300, 500];
    const before = rc.toRadar(cx, cy)!;
    rc.pinch(2, cx, cy);
    expect(rc.zoom).toBe(2);
    const after = rc.toRadar(cx, cy)!;
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    rc.pinch(4, cx, cy);
    expect(rc.zoom).toBe(4);
  });
});
