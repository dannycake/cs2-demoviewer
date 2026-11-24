// The free camera: a fly camera. Right-drag looks (0.2° a pixel), and so does a one-finger
// touch drag; `W A S D` move along the view, `Q`/`E` go down and up, `Shift` goes four times as
// fast, and the wheel scales the base speed by 1.25 a notch within 0.5–40 m/s, remembered in
// `localStorage`. A mouse left-drag does nothing, so a stray click never spins the view. It
// collides with nothing.
//
// Key state is the caller's: it adds and deletes `KeyboardEvent.code`s in `keys` (and calls
// `clear` on blur, so a held `W` does not fly on after alt-tab). The pointer and the wheel are
// read from `dom` while `enabled`.
//
// `place` puts it at a pose (a shared link's `at`), and its field of view when given, which
// the next entry into Free keeps instead of taking the view drawn last; `keep` does the same
// for the pose it already has (nothing else moves it outside Free).

import * as THREE from 'three';
import { FOV_MAX_DEG, FOV_MIN_DEG } from '../router';
import { FLY_KEYS, SHIFT_KEYS } from '../state/fly-keys';
import { browserStorage, type PrefsStorage } from '../state/storage';

/** `localStorage` key of the base speed. */
export const FLY_SPEED_KEY = 'demoviewer.flySpeed';
/** Base speed in m/s when nothing is remembered: about a running player. */
export const FLY_SPEED_DEFAULT = 8;
export const FLY_SPEED_MIN = 0.5;
export const FLY_SPEED_MAX = 40;
/** Base speed factor per wheel notch. */
export const FLY_WHEEL_STEP = 1.25;
/** `Shift` multiplies the speed by this. */
export const FLY_BOOST = 4;
/** Degrees turned per pixel dragged. */
export const FLY_LOOK_DEG_PER_PX = 0.2;
/** The pitch stops this far short of straight up or down. */
const PITCH_LIMIT = THREE.MathUtils.degToRad(89);
const DEG = Math.PI / 180;

function clampSpeed(v: number): number {
  return Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, v));
}

const _move = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Where `camera` looks, in degrees, as `Scene.cameraDebug` and a link's `at` give it: `yaw` is
 * `atan2(x, z)` of the view direction (0 looks along +z, 90 along +x), and `pitch` is positive
 * looking down.
 */
export function viewAngles(camera: THREE.Camera): {
  yaw: number;
  pitch: number;
} {
  const d = camera.getWorldDirection(_dir);
  return {
    yaw: Math.atan2(d.x, d.z) / DEG,
    pitch: -Math.asin(Math.max(-1, Math.min(1, d.y))) / DEG,
  };
}

export class FlyCam {
  readonly camera: THREE.PerspectiveCamera;
  /** Base speed in m/s. */
  speed: number;
  /** `KeyboardEvent.code`s held down. */
  readonly keys = new Set<string>();
  /** Whether the pointer and the wheel steer it. */
  enabled = false;
  /** Called after the pointer or the wheel changed the view or the speed. */
  onChange: (() => void) | null = null;

  private readonly dom: HTMLElement | null;
  private readonly storage: PrefsStorage;
  /** The pointer dragging (the right button, or the first finger down), and where it was. */
  private drag: { id: number; x: number; y: number } | null = null;
  /** A pose was placed and no Free frame has drawn it yet: entering Free keeps it. */
  private placed = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    dom: HTMLElement | null,
    storage: PrefsStorage = browserStorage()
  ) {
    this.camera = camera;
    this.dom = dom;
    this.storage = storage;
    this.speed = this.readSpeed();
    if (dom) {
      dom.addEventListener('pointerdown', this.onPointerDown);
      dom.addEventListener('pointermove', this.onPointerMove);
      dom.addEventListener('pointerup', this.onPointerUp);
      dom.addEventListener('pointercancel', this.onPointerUp);
      dom.addEventListener('contextmenu', this.onContextMenu);
      dom.addEventListener('wheel', this.onWheel, { passive: false });
    }
  }

  /** True while a movement key is held, moving or not. */
  get held(): boolean {
    for (const k of this.keys) if (FLY_KEYS.has(k)) return true;
    return false;
  }

  /**
   * Takes `from`'s pose (and field of view), so switching to it is seamless; after `place`,
   * keeps the placed pose instead, once. Returns whether it took `from`'s.
   */
  takeFrom(from: THREE.Camera): boolean {
    if (this.placed) {
      this.placed = false;
      return false;
    }
    if (from === this.camera) return false;
    this.camera.position.copy(from.position);
    this.camera.quaternion.copy(from.quaternion);
    const fov = (from as THREE.PerspectiveCamera).isPerspectiveCamera
      ? (from as THREE.PerspectiveCamera).fov
      : this.camera.fov;
    if (fov !== this.camera.fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    return true;
  }

  /**
   * Puts the camera at `position` (scene metres), looking at `yawDeg` and `pitchDeg` as
   * `viewAngles` gives them (the pitch held short of straight up or down), with a vertical
   * field of view of `fovDeg` when given (else its own). It shows at once in Free; otherwise
   * entering Free next keeps it, field of view and all, instead of taking the view drawn last.
   * A pose that is not finite, or a field of view outside 1–179°, is ignored.
   */
  place(
    position: THREE.Vector3,
    yawDeg: number,
    pitchDeg: number,
    fovDeg?: number
  ): void {
    const values = [position.x, position.y, position.z, yawDeg, pitchDeg];
    if (!values.every(Number.isFinite)) return;
    if (
      fovDeg !== undefined &&
      !(fovDeg >= FOV_MIN_DEG && fovDeg <= FOV_MAX_DEG)
    )
      return;
    if (fovDeg !== undefined && fovDeg !== this.camera.fov) {
      this.camera.fov = fovDeg;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.copy(position);
    // The camera looks down its -z: Euler (x, y) = (-pitch, yaw + 180°) faces that direction.
    const pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, pitchDeg * DEG));
    this.camera.quaternion.setFromEuler(
      _euler.set(-pitch, yawDeg * DEG + Math.PI, 0, 'YXZ')
    );
    this.camera.updateMatrixWorld();
    this.placed = true;
  }

  /**
   * Keeps the pose (and field of view) the camera has for the next entry into Free, as `place`
   * keeps a placed one, instead of taking the view drawn last: a reel that left Free goes back
   * to where it was flown.
   */
  keep(): void {
    this.placed = true;
  }

  /** Flies `dt` seconds with the keys held; returns whether the camera moved. */
  update(dt: number): boolean {
    // A Free frame is drawing: a placed pose is shown, and the next entry takes the last view.
    this.placed = false;
    if (!(dt > 0)) return false;
    const k = this.keys;
    const fwd = +k.has('KeyW') - +k.has('KeyS');
    const right = +k.has('KeyD') - +k.has('KeyA');
    const up = +k.has('KeyE') - +k.has('KeyQ');
    if (fwd === 0 && right === 0 && up === 0) return false;
    const q = this.camera.quaternion;
    _move.set(0, 0, 0);
    if (fwd) _move.addScaledVector(_axis.set(0, 0, -1).applyQuaternion(q), fwd);
    if (right)
      _move.addScaledVector(_axis.set(1, 0, 0).applyQuaternion(q), right);
    if (up) _move.y += up;
    const len = _move.length();
    if (len < 1e-9) return false;
    const boost = SHIFT_KEYS.some((s) => k.has(s)) ? FLY_BOOST : 1;
    this.camera.position.addScaledVector(
      _move,
      (this.speed * boost * dt) / len
    );
    return true;
  }

  /** Turns the view by a drag of (`dx`, `dy`) pixels: right turns right, down looks down. */
  look(dx: number, dy: number): void {
    const e = _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    e.y -= dx * FLY_LOOK_DEG_PER_PX * DEG;
    e.x = Math.min(
      PITCH_LIMIT,
      Math.max(-PITCH_LIMIT, e.x - dy * FLY_LOOK_DEG_PER_PX * DEG)
    );
    e.z = 0;
    this.camera.quaternion.setFromEuler(e);
  }

  /** Scales the base speed by 1.25 per notch (positive is faster), and remembers it. */
  wheel(notches: number): void {
    if (!Number.isFinite(notches) || notches === 0) return;
    this.speed = clampSpeed(this.speed * FLY_WHEEL_STEP ** notches);
    try {
      this.storage?.setItem(FLY_SPEED_KEY, String(this.speed));
    } catch {
      // Storage full or blocked: the speed still holds for this visit.
    }
  }

  /** Lets go of every key (on blur, or when the page is hidden). */
  clear(): void {
    this.keys.clear();
  }

  dispose(): void {
    const dom = this.dom;
    if (!dom) return;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    dom.removeEventListener('pointermove', this.onPointerMove);
    dom.removeEventListener('pointerup', this.onPointerUp);
    dom.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('contextmenu', this.onContextMenu);
    dom.removeEventListener('wheel', this.onWheel);
  }

  private readSpeed(): number {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(FLY_SPEED_KEY) ?? null;
    } catch {
      raw = null;
    }
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) && v > 0 ? clampSpeed(v) : FLY_SPEED_DEFAULT;
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    // One finger looks, and a second one down meanwhile is ignored; the mouse looks with the
    // right button only. A touch keeps its default (focus, the compatibility mouse events): the
    // canvas's `touch-action: none` already keeps the browser from panning.
    const touch = e.pointerType === 'touch';
    if (touch ? this.drag !== null : e.button !== 2) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      this.dom?.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone: the drag still works while it stays over the view.
    }
    if (!touch) e.preventDefault();
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!this.enabled) {
      this.drag = null;
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (dx === 0 && dy === 0) return;
    this.look(dx, dy);
    this.onChange?.();
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (this.drag?.id !== e.pointerId) return;
    this.drag = null;
    try {
      this.dom?.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
  };

  /** Right-drag is the look: no context menu over the view while flying. */
  private readonly onContextMenu = (e: Event) => {
    if (this.enabled) e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.enabled || e.deltaY === 0) return;
    e.preventDefault();
    // One notch per event, whatever the device's step: wheel up is faster.
    this.wheel(-Math.sign(e.deltaY));
    this.onChange?.();
  };
}
