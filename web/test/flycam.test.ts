// The free camera: W A S D along the view, Q/E down and up, Shift four times as fast, right-drag
// (or a one-finger touch drag) to look at 0.2°/px, and a wheel-set base speed that is remembered.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FLY_LOOK_DEG_PER_PX,
  FLY_SPEED_DEFAULT,
  FLY_SPEED_KEY,
  FlyCam,
  viewAngles,
} from '../src/scene/flycam';
import type { PrefsStorage } from '../src/state/storage';

function memoryStorage(): PrefsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

function cam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
  c.position.set(1, 2, 3);
  c.lookAt(4, 2, 7); // forward (0.6, 0, 0.8)
  return c;
}

const FWD = new THREE.Vector3(0.6, 0, 0.8);

/** An element for the fly camera's pointer listeners, with pointer capture as a no-op. */
function fakeDom(): HTMLElement {
  return Object.assign(new EventTarget(), {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  }) as unknown as HTMLElement;
}

/** A pointer pressed at (100, 100), moved `dx` pixels right, and let go. */
function drag(
  dom: HTMLElement,
  p: { pointerId: number; pointerType: string; button: number },
  dx: number
): void {
  const send = (type: string, x: number) =>
    dom.dispatchEvent(
      Object.assign(new Event(type, { cancelable: true }), p, {
        isPrimary: true,
        clientX: x,
        clientY: 100,
      })
    );
  send('pointerdown', 100);
  send('pointermove', 100 + dx);
  send('pointerup', 100 + dx);
}

describe('FlyCam', () => {
  it('moves `speed` metres a second along the forward with W', () => {
    const c = cam();
    const fly = new FlyCam(c, null, null);
    expect(fly.speed).toBe(FLY_SPEED_DEFAULT);
    expect(fly.update(1)).toBe(false);
    fly.keys.add('KeyW');
    expect(fly.update(1)).toBe(true);
    const want = new THREE.Vector3(1, 2, 3).addScaledVector(FWD, fly.speed);
    expect(c.position.distanceTo(want)).toBeLessThan(1e-9);
  });

  it('goes along the view when looking down, strafes with A/D and rises with E', () => {
    const c = cam();
    c.lookAt(1, 1, 3 + 1); // 45° down, facing +z
    const fly = new FlyCam(c, null, null);
    fly.speed = 2;
    fly.keys.add('KeyW');
    fly.update(1);
    expect(c.position.y).toBeCloseTo(2 - Math.SQRT2, 9);
    fly.keys.clear();
    const at = c.position.clone();
    fly.keys.add('KeyD');
    fly.update(1);
    // Facing +z, right is -x.
    expect(c.position.clone().sub(at).toArray()).toEqual([
      expect.closeTo(-2, 9),
      expect.closeTo(0, 9),
      expect.closeTo(0, 9),
    ]);
    fly.keys.clear();
    fly.keys.add('KeyE');
    fly.update(0.5);
    expect(c.position.y - at.y).toBeCloseTo(1, 9);
    fly.keys.add('KeyQ'); // E and Q cancel
    expect(fly.update(1)).toBe(false);
  });

  it('Shift goes four times as fast', () => {
    const c = cam();
    const fly = new FlyCam(c, null, null);
    fly.keys.add('KeyW');
    fly.keys.add('ShiftLeft');
    fly.update(1);
    expect(c.position.distanceTo(new THREE.Vector3(1, 2, 3))).toBeCloseTo(
      4 * fly.speed,
      9
    );
  });

  it('takeFrom copies the position, orientation and field of view', () => {
    const from = new THREE.PerspectiveCamera(73.74, 1, 0.05, 1000);
    from.position.set(-5, 6, 7);
    from.lookAt(0, 0, 0);
    const c = cam();
    const fly = new FlyCam(c, null, null);
    fly.takeFrom(from);
    expect(c.position.toArray()).toEqual(from.position.toArray());
    expect(c.quaternion.toArray()).toEqual(from.quaternion.toArray());
    expect(c.fov).toBe(73.74);
  });

  it('looks 0.2° per pixel dragged, with the pitch held short of straight up or down', () => {
    const c = cam();
    c.lookAt(1, 2, 4); // facing +z, level
    const fly = new FlyCam(c, null, null);
    fly.look(100, 0); // 20° to the right
    const dir = c.getWorldDirection(new THREE.Vector3());
    const right = (20 * Math.PI) / 180;
    expect(dir.x).toBeCloseTo(-Math.sin(right), 9);
    expect(dir.z).toBeCloseTo(Math.cos(right), 9);
    fly.look(0, 100); // 20° down
    expect(c.getWorldDirection(dir).y).toBeCloseTo(-Math.sin(right), 9);
    fly.look(0, 10000);
    expect(c.getWorldDirection(dir).y).toBeGreaterThan(-1);
    expect(c.getWorldDirection(dir).y).toBeLessThan(-0.99);
  });

  it('looks with a one-finger touch drag; a mouse left drag turns nothing', () => {
    const c = cam();
    c.lookAt(1, 2, 4); // facing +z, level: yaw 0
    const dom = fakeDom();
    const fly = new FlyCam(c, dom, null);
    fly.enabled = true;
    // A placed pose keeps its field of view under the drag.
    fly.place(new THREE.Vector3(1, 2, 3), 0, 0, 73.7);
    drag(dom, { pointerId: 1, pointerType: 'mouse', button: 0 }, 10);
    expect(viewAngles(c).yaw).toBeCloseTo(0, 9);
    // Right turns right, which is a falling yaw (`viewAngles`).
    drag(dom, { pointerId: 2, pointerType: 'touch', button: 0 }, 10);
    expect(viewAngles(c).yaw).toBeCloseTo(-10 * FLY_LOOK_DEG_PER_PX, 9);
    expect(viewAngles(c).pitch).toBeCloseTo(0, 9);
    expect(c.fov).toBe(73.7);
    // Not while it does not steer (outside Free).
    fly.enabled = false;
    drag(dom, { pointerId: 3, pointerType: 'touch', button: 0 }, 10);
    expect(viewAngles(c).yaw).toBeCloseTo(-10 * FLY_LOOK_DEG_PER_PX, 9);
    fly.dispose();
  });

  it('scales the base speed 1.25 a wheel notch within 0.5–40 m/s and remembers it', () => {
    const storage = memoryStorage();
    const fly = new FlyCam(cam(), null, storage);
    fly.wheel(2);
    expect(fly.speed).toBeCloseTo(FLY_SPEED_DEFAULT * 1.25 ** 2, 9);
    expect(Number(storage.data.get(FLY_SPEED_KEY))).toBeCloseTo(fly.speed, 9);
    fly.wheel(100);
    expect(fly.speed).toBe(40);
    fly.wheel(-100);
    expect(fly.speed).toBe(0.5);
    expect(new FlyCam(cam(), null, storage).speed).toBe(0.5);
    // Junk in storage is ignored.
    storage.data.set(FLY_SPEED_KEY, 'fast');
    expect(new FlyCam(cam(), null, storage).speed).toBe(FLY_SPEED_DEFAULT);
  });

  it('clear() lets go of every key, as on blur', () => {
    const fly = new FlyCam(cam(), null, null);
    fly.keys.add('KeyW');
    expect(fly.held).toBe(true);
    fly.clear();
    expect(fly.held).toBe(false);
    expect(fly.update(1)).toBe(false);
  });

  it('keeps a placed pose when Free is entered, once', () => {
    const c = cam();
    const fly = new FlyCam(c, null, null);
    const v = new THREE.Vector3(5, 6, -7);
    fly.place(v, 90, -10);
    // The view drawn last, which entering Free would otherwise take.
    const last = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
    last.position.set(-20, 30, 40);
    last.lookAt(0, 0, 0);
    fly.takeFrom(last);
    expect(c.position.toArray()).toEqual([5, 6, -7]);
    // Yaw and pitch as Scene.cameraDebug reports them: atan2(x, z), and positive looking down.
    const dir = c.getWorldDirection(new THREE.Vector3());
    expect(Math.atan2(dir.x, dir.z) * (180 / Math.PI)).toBeCloseTo(90, 9);
    expect(-Math.asin(dir.y) * (180 / Math.PI)).toBeCloseTo(-10, 9);
    // The next entry takes the last view again.
    fly.takeFrom(last);
    expect(c.position.distanceTo(last.position)).toBeLessThan(1e-9);
  });

  it('shows a pose placed in Free at once, and forgets it after a frame', () => {
    const c = cam();
    const fly = new FlyCam(c, null, null);
    fly.place(new THREE.Vector3(1, 1, 1), -45, 30);
    expect(c.position.toArray()).toEqual([1, 1, 1]);
    expect(viewAngles(c)).toEqual({
      yaw: expect.closeTo(-45, 9),
      pitch: expect.closeTo(30, 9),
    });
    // A Free frame drew it: a later entry takes the last view.
    fly.update(0.016);
    const last = cam();
    last.position.set(9, 9, 9);
    fly.takeFrom(last);
    expect(c.position.toArray()).toEqual([9, 9, 9]);
  });

  it('round-trips a pose through viewAngles, keeping the pitch short of straight up or down', () => {
    const c = cam();
    const fly = new FlyCam(c, null, null);
    for (const [yaw, pitch] of [
      [0, 0],
      [179.9, 45],
      [-179.9, -45],
      [-90, 88.9],
      [12.3, -0.1],
    ]) {
      fly.place(new THREE.Vector3(0, 0, 0), yaw, pitch);
      expect(viewAngles(c), `${yaw},${pitch}`).toEqual({
        yaw: expect.closeTo(yaw, 6),
        pitch: expect.closeTo(pitch, 6),
      });
    }
    fly.place(new THREE.Vector3(0, 0, 0), 270, 200);
    expect(viewAngles(c)).toEqual({
      yaw: expect.closeTo(-90, 6),
      pitch: expect.closeTo(89, 6),
    });
    // A pose that is not finite is not placed.
    fly.place(new THREE.Vector3(NaN, 0, 0), 0, 0);
    expect(c.position.toArray()).toEqual([0, 0, 0]);
  });

  it('takes a placed field of view, which entering Free keeps', () => {
    const c = cam();
    const fly = new FlyCam(c, null, null);
    const before = c.projectionMatrix.elements[5];
    fly.place(new THREE.Vector3(1, 2, 3), 10, 5, 73.7);
    expect(c.fov).toBe(73.7);
    // The projection follows: a wider view draws things smaller.
    expect(c.projectionMatrix.elements[5]).toBeLessThan(before);
    const last = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
    last.position.set(9, 9, 9);
    fly.takeFrom(last);
    expect(c.fov).toBe(73.7);
    expect(c.position.toArray()).toEqual([1, 2, 3]);
    // Without one, the camera's own field of view stays.
    fly.place(new THREE.Vector3(0, 0, 0), 0, 0);
    expect(c.fov).toBe(73.7);
    // The next entry takes the last view's, as before.
    fly.update(0.016);
    fly.takeFrom(last);
    expect(c.fov).toBe(60);
  });

  it('ignores a pose whose field of view is not 1 to 179 degrees', () => {
    const c = cam();
    const fly = new FlyCam(c, null, null);
    for (const fov of [0, 180, NaN, -60, Infinity]) {
      fly.place(new THREE.Vector3(7, 7, 7), 0, 0, fov);
      expect(c.position.toArray(), String(fov)).toEqual([1, 2, 3]);
      expect(c.fov).toBe(60);
    }
  });
});
