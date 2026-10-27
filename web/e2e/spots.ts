// Where the e2e puts the free camera: the first door swing in a pack (ENT1) and a pose that
// looks square at it, and a pose that looks down at a spot on the floor (where an item lies).
// Shared by effects.spec.ts ("doors", "ground") and baked.spec.ts (both under the baked light);
// not a spec itself.
import type { Page } from '@playwright/test';

/** Metres per Source unit. */
const UNIT = 0.0254;

/** The part of the page's debug handle these read. */
interface SpotsHandle {
  hullDistance(x: number, y: number, z: number): number | null;
  store: {
    getState(): {
      pack: {
        header: { tick_rate: number; rounds: { start_tick: number }[] };
        entities: { kind: string; x: number; y: number; z: number }[];
        entityChanges: {
          round: number;
          entity: number;
          tick: number;
          yaw: number;
        }[];
      } | null;
    };
  };
}

/** A spot in Source units, the horizontal normal to look along, and the side to prefer. */
export interface FaceOn {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  side: number;
}

/** A door's first swing that does not start with a round: its keys and the spot to face. */
export interface DoorSwing {
  round: number;
  /** The swing's first key. */
  tick: number;
  /** Halfway to its next key. */
  mid: number;
  /** The tick after which it no longer moves in that swing: its next key. */
  end: number;
  rate: number;
  at: FaceOn;
}

/** The first swing of the loaded pack's doors that does not start with a round. */
export async function firstDoorSwing(page: Page): Promise<DoorSwing> {
  return page.evaluate(() => {
    const d = (window as unknown as { __demoviewer: SpotsHandle }).__demoviewer;
    const pack = d.store.getState().pack!;
    const changes = pack.entityChanges;
    const first = changes
      .filter(
        (c) =>
          pack.entities[c.entity].kind === 'door' &&
          c.tick > pack.header.rounds[c.round].start_tick
      )
      .sort((a, b) => a.round - b.round || a.tick - b.tick)[0];
    const next = changes.find(
      (c) =>
        c.round === first.round &&
        c.entity === first.entity &&
        c.tick > first.tick
    )!;
    const e = pack.entities[first.entity];
    // The swing starts at the door's spawn: closed, its slab along the model's +y from the
    // hinge, which is `yaw` + 90° (the pose the game draws Nuke's door in; tools/lib/poses.mjs).
    const yaw = (first.yaw / 100) * (Math.PI / 180);
    const turn = (((next.yaw - first.yaw + 54000) % 36000) - 18000) / 100;
    return {
      round: first.round,
      tick: first.tick,
      mid: Math.round((first.tick + next.tick) / 2),
      end: next.tick,
      rate: pack.header.tick_rate,
      // The middle of a 60 × 110 unit door, looked at from the side it swings away from: a
      // positive turn moves the slab towards −(cos yaw, sin yaw).
      at: {
        x: e.x - Math.sin(yaw) * 30,
        y: e.y + Math.cos(yaw) * 30,
        z: e.z + 54,
        nx: Math.cos(yaw),
        ny: Math.sin(yaw),
        side: turn > 0 ? 1 : -1,
      },
    };
  });
}

/**
 * The free camera's `at` for looking square at `t` (a door or a window, by its normal): of
 * 2–4.5 m off it on its preferred side, then the other, the first spot with room around it and
 * a clear line to it in the map's hull.
 */
export async function faceOn(page: Page, t: FaceOn): Promise<string> {
  return page.evaluate(
    ({ t, unit }) => {
      const d = (window as unknown as { __demoviewer: SpotsHandle })
        .__demoviewer;
      const room = (x: number, y: number, z: number) =>
        d.hullDistance(x, y, z) ?? 10;
      // Scene metres: Source (x, y, z) is (y, z, x).
      const c = { x: t.y * unit, y: t.z * unit, z: t.x * unit };
      let best = { x: c.x, y: c.y, z: c.z, clear: -1 };
      for (const side of [t.side, -t.side])
        for (const m of [3, 2.5, 2, 3.5, 4.5]) {
          const p = {
            x: c.x + t.ny * side * m,
            y: c.y + 0.1,
            z: c.z + t.nx * side * m,
          };
          let clear = room(p.x, p.y, p.z) >= 0.35 ? Infinity : 0;
          for (let i = 1; i < 8 && clear > 0; i++) {
            const k = i / 10;
            clear = Math.min(
              clear,
              room(
                p.x + (c.x - p.x) * k,
                p.y + (c.y - p.y) * k,
                p.z + (c.z - p.z) * k
              )
            );
          }
          if (clear >= 0.15) {
            best = { ...p, clear };
            break;
          }
          if (clear > best.clear) best = { ...p, clear };
        }
      const dx = c.x - best.x;
      const dy = c.y - best.y;
      const dz = c.z - best.z;
      const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
      const pitch = (-Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
      return [best.x, best.y, best.z, yaw, pitch]
        .map((v) => v.toFixed(2))
        .join(',');
    },
    { t, unit: UNIT }
  );
}

/**
 * The free camera's `at` for looking down at `at` (Source units, on the floor) from 1.6 m above
 * it: of 16 bearings 2.5, 3 and 2 m off, the spot with the most room along its line to it in the
 * map's hull.
 */
export async function lookDownAt(
  page: Page,
  at: { x: number; y: number; z: number }
): Promise<string> {
  return page.evaluate(
    ({ at, unit }) => {
      const d = (window as unknown as { __demoviewer: SpotsHandle })
        .__demoviewer;
      const room = (x: number, y: number, z: number) =>
        d.hullDistance(x, y, z) ?? 10;
      // Scene metres: Source (x, y, z) is (y, z, x).
      const c = { x: at.y * unit, y: at.z * unit + 0.1, z: at.x * unit };
      let best = { x: c.x, y: c.y + 1.6, z: c.z, clear: -1 };
      for (const m of [2.5, 3, 2])
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const p = {
            x: c.x + Math.sin(a) * m,
            y: c.y + 1.6,
            z: c.z + Math.cos(a) * m,
          };
          let clear = room(p.x, p.y, p.z) >= 0.5 ? Infinity : 0;
          for (let i = 1; i < 9 && clear > 0; i++) {
            const t = i / 10;
            clear = Math.min(
              clear,
              room(
                p.x + (c.x - p.x) * t,
                p.y + (c.y - p.y) * t,
                p.z + (c.z - p.z) * t
              )
            );
          }
          if (clear > best.clear) best = { ...p, clear };
        }
      const dx = c.x - best.x;
      const dy = c.y - best.y;
      const dz = c.z - best.z;
      const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
      const pitch = (-Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
      return [best.x, best.y, best.z, yaw, pitch]
        .map((v) => v.toFixed(2))
        .join(',');
    },
    { at, unit: UNIT }
  );
}
