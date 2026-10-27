// A map's collision hull (`/maps/<map>/hull.glb`, merged by `loadHull`) under a BVH, for the
// cameras: how far a sphere can travel along a segment before it touches the hull, and how
// far a point is from it; for the first-person arms, whether the eye sees the sun; and for the
// bullets, where a ray meets a surface a bullet stops at or marks, and which (`raycast`,
// `raycastAll`: the surface of the triangle's collision group, what bullets pass skipped); for
// the footsteps, the surface under a player's feet (`surfaceBelow`). All work in scene metres
// and treat every triangle as two-sided.
//
// The sweep is exact per triangle rather than sampled: the distance from a point moving along
// a line to a triangle is convex in the travelled distance, so a triangle the swept sphere
// reaches is first touched on the descending side of that curve, where one bisection finds
// it. The BVH visits boxes nearest-first and skips any box the sphere would reach later than
// the earliest touch found so far.

import * as THREE from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';
import { SURFACES, type Surface } from '../sim/surfaces';

/** Bisection stops once the touch is known to within this many metres. */
const TOLERANCE = 1e-4;

const _dir = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _onTri = new THREE.Vector3();
const _ray = new THREE.Ray();
const _seg = new THREE.Line3();
const _closest = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const _tri = new THREE.Vector3();
const _n = new THREE.Vector3();
/** Straight down, `surfaceBelow`'s ray. */
const DOWN: Readonly<THREE.Vector3> = new THREE.Vector3(0, -1, 0);

/**
 * Faces met along one ray nearer together than this are one place: the same way round, one
 * face (the edge two triangles share); one leaving and one entering, the faces two abutting
 * pieces of a wall share, or a sheet's two sides (`raycastAll`).
 */
const SAME_HIT = 0.01;
/** `raycastAll`'s faces met, before what two abutting pieces share is taken out. */
const ALL_HITS = 16;

/** Where a ray met the hull (`Hull.raycast`, `Hull.raycastAll`). */
export interface HullHit {
  /** Metres from the ray's origin. */
  distance: number;
  point: THREE.Vector3;
  /** The face's unit normal, turned to face the ray's origin. */
  normal: THREE.Vector3;
  /** The surface of the face's collision group; stone for a hull without surfaces. */
  surface: Surface;
  /**
   * Whether the ray met the face from behind by its winding: by a solid's outward faces, the face
   * it leaves the solid by (a bullet's exit from a wall). Its outside is then `-normal`.
   */
  leaving: boolean;
}

/** A hit to fill. */
export function newHullHit(): HullHit {
  return {
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    surface: 'stone',
    leaving: false,
  };
}

const PASS = SURFACES.indexOf('pass');

export class Hull {
  /** The hull's triangles in scene metres, owned by the hull: read them, never free them. */
  readonly geometry: THREE.BufferGeometry;
  private readonly bvh: MeshBVH;
  private readonly box = new THREE.Box3();
  /** The ray `sees` casts and whether it met the hull, read by `sightCast`. */
  private readonly sight = { ray: new THREE.Ray(), met: false };
  /** `sees`'s shapecast, made once so a cast every frame makes nothing. */
  private readonly sightCast = {
    intersectsBounds: (box: THREE.Box3) =>
      this.sight.ray.intersectBox(box, _hit) !== null,
    intersectsTriangle: (tri: ExtendedTriangle) => {
      if (
        this.sight.ray.intersectTriangle(tri.a, tri.b, tri.c, false, _hit) ===
        null
      )
        return false;
      this.sight.met = true;
      return true;
    },
  };

  /** Each vertex's surface (`mergeMeshes`), or null for a hull of stone. */
  private readonly surface: THREE.BufferAttribute | null;
  /**
   * Each vertex's surface name, an index into `surfaceNames` (`mergeMeshes`); null for a hull
   * without them, under whose feet `surfaceBelow` names nothing.
   */
  private readonly surfaceName: THREE.BufferAttribute | null;
  private readonly surfaceNames: readonly string[];
  /**
   * The ray of `raycast`/`raycastAll`/`surfaceBelow` and what it has met: the hits so far in
   * `out` (`count`), nearest first, at most `out.length` of them, or for a `first` cast the
   * nearest alone and its triangle (`face`). Faces bullets pass are met only when `pass`.
   */
  private readonly cast = {
    ray: new THREE.Ray(),
    max: 0,
    first: false,
    pass: false,
    out: [] as HullHit[],
    count: 0,
    face: 0,
  };
  /** `raycast`'s and `surfaceBelow`'s one hit, as the list the cast fills. */
  private readonly one: HullHit[] = [newHullHit()];
  /** `surfaceBelow`'s hit. */
  private readonly below = newHullHit();
  /** `raycastAll`'s faces met, nearest first, as the list the cast fills. */
  private readonly met: HullHit[] = Array.from(
    { length: ALL_HITS },
    newHullHit
  );
  /** The cast's callbacks, made once so a ray makes nothing. */
  private readonly rayCast = {
    // Where the ray enters the box, 0 from inside it (three's `intersectBox` gives the exit
    // then), Infinity when it misses it.
    boundsTraverseOrder: (box: THREE.Box3) =>
      enterExpandedBox(
        box,
        this.cast.ray.origin,
        this.cast.ray.direction,
        0,
        Infinity
      ) ?? Infinity,
    intersectsBounds: (
      _box3: THREE.Box3,
      _leaf: boolean,
      score: number | undefined
    ) => (score ?? 0) <= this.reach(),
    intersectsTriangle: (tri: ExtendedTriangle, index: number) => {
      this.meet(tri, index);
      return false;
    },
  };

  /** Takes ownership of `geometry` (scene metres); `dispose` frees it. */
  constructor(geometry: THREE.BufferGeometry) {
    this.geometry = geometry;
    this.surface =
      (geometry.getAttribute('surface') as THREE.BufferAttribute | undefined) ??
      null;
    const name = geometry.getAttribute('surfaceName') as
      THREE.BufferAttribute | undefined;
    const names: unknown = geometry.userData.surfaceNames;
    this.surfaceName = name && Array.isArray(names) ? name : null;
    this.surfaceNames = this.surfaceName ? (names as string[]) : [];
    this.bvh = new MeshBVH(geometry);
    // From the vertices: the BVH's own box is padded for float32.
    this.box.setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute
    );
  }

  /**
   * The hull's bounding box (a copy). The cameras and the sun's shadow are fitted to it rather
   * than to the world, whose skybox props (Ancient's distant buildings, Nuke's skyline) stand
   * outside where anyone plays.
   */
  get bounds(): THREE.Box3 {
    return this.box.clone();
  }

  /**
   * Metres the sphere travels from `from` toward `to` before touching, capped at the full
   * distance. A `radius` of 0 casts a ray: it stops where it pierces the hull.
   */
  freeDistance(from: THREE.Vector3, to: THREE.Vector3, radius: number): number {
    const length = from.distanceTo(to);
    if (length === 0) return 0;
    const dir = _dir.subVectors(to, from).divideScalar(length);
    let best = length;
    const at = (t: number, out: THREE.Vector3) =>
      out.copy(from).addScaledVector(dir, t);

    this.bvh.shapecast({
      boundsTraverseOrder: (box) => box.distanceToPoint(from),
      intersectsBounds: (box) => {
        const t = enterExpandedBox(box, from, dir, radius, best);
        return t !== null && t < best;
      },
      intersectsTriangle: (tri: ExtendedTriangle) => {
        const t = touch(tri, from, dir, best, radius, at);
        if (t < best) best = t;
        return best === 0;
      },
    });
    return best;
  }

  /**
   * Whether the ray from `from` along unit `dir` leaves without meeting the hull: true when the
   * sun, along `dir`, is in view of `from`. Makes nothing per call.
   */
  sees(from: Readonly<THREE.Vector3>, dir: Readonly<THREE.Vector3>): boolean {
    this.sight.ray.origin.copy(from);
    this.sight.ray.direction.copy(dir);
    this.sight.met = false;
    this.bvh.shapecast(this.sightCast);
    return !this.sight.met;
  }

  /**
   * The nearest hit within `maxDist` of `from` along unit `dir`, into `out`, past every face
   * bullets pass (`pass`): false when there is none. Makes nothing.
   */
  raycast(
    from: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    out: HullHit
  ): boolean {
    this.one[0] = out;
    this.cast.out = this.one;
    this.cast.first = true;
    this.cast.pass = false;
    return this.castRay(from, dir, maxDist) > 0;
  }

  /**
   * Every hit within `maxDist` of `from` along unit `dir`, nearest first, past every face
   * bullets pass, up to `out.length` of them (the nearest): how many, copied into the first of
   * `out`. Faces less than 1 cm apart are one place: the same way round, one hit; one leaving
   * and one entering, inside a solid the faces two abutting pieces share (no hit: a bullet
   * through a wall of several pieces is marked where it goes in and out), in the open a sheet's
   * two sides (both). Makes nothing.
   */
  raycastAll(
    from: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    out: HullHit[]
  ): number {
    if (out.length === 0) return 0;
    const met = this.met;
    this.cast.out = met;
    this.cast.first = false;
    this.cast.pass = false;
    const n = this.castRay(from, dir, maxDist);
    // How many solids the ray is in, by the faces met so far (the shooter stands in the open).
    let inside = 0;
    let kept = 0;
    for (let i = 0; i < n && kept < out.length; i++) {
      const h = met[i];
      const next = i + 1 < n ? met[i + 1] : null;
      if (
        next &&
        next.leaving !== h.leaving &&
        next.distance - h.distance < SAME_HIT
      ) {
        i++;
        if (inside > 0) continue;
        copyHit(h, out[kept++]);
        if (kept < out.length) copyHit(next, out[kept++]);
        continue;
      }
      inside = h.leaving ? Math.max(0, inside - 1) : inside + 1;
      copyHit(h, out[kept++]);
    }
    return kept;
  }

  /**
   * The surface the first face straight down (scene −Y) from `p` within `maxDrop` metres is
   * named for (`mergeMeshes`'s `surfaceName`): what a player whose feet are under `p` stands on.
   * A floor bullets pass (a grate, a catwalk) is a floor here. Null when nothing is in reach or
   * the hull has no surface names. Makes nothing.
   */
  surfaceBelow(p: THREE.Vector3, maxDrop: number): string | null {
    if (!this.surfaceName) return null;
    const c = this.cast;
    this.one[0] = this.below;
    c.out = this.one;
    c.first = true;
    c.pass = true;
    if (this.castRay(p, DOWN, maxDrop) === 0) return null;
    // A face's vertices are all of one mesh, so its first names its surface; the BVH reorders
    // the index, never the vertices.
    const v = this.geometry.index!.getX(c.face * 3);
    return this.surfaceNames[this.surfaceName.getX(v)] ?? null;
  }

  /** Distance from `p` to the hull; `out` receives the closest point. */
  closestPoint(p: THREE.Vector3, out: THREE.Vector3): number {
    const hit = this.bvh.closestPointToPoint(p, _closest);
    if (!hit) return Infinity;
    out.copy(hit.point);
    return hit.distance;
  }

  dispose(): void {
    this.geometry.dispose();
  }

  /** Casts `cast`'s ray into its hits; how many it kept. */
  private castRay(
    from: Readonly<THREE.Vector3>,
    dir: Readonly<THREE.Vector3>,
    maxDist: number
  ): number {
    const c = this.cast;
    c.ray.origin.copy(from);
    c.ray.direction.copy(dir);
    c.max = maxDist;
    c.count = 0;
    if (maxDist > 0) this.bvh.shapecast(this.rayCast);
    return c.count;
  }

  /** How far a hit may yet be kept: `max`, or once the hits are full, the farthest kept. */
  private reach(): number {
    const c = this.cast;
    return c.count === c.out.length ? c.out[c.count - 1].distance : c.max;
  }

  /** The cast's ray against `tri` (triangle `index`): kept, in order, when it counts. */
  private meet(tri: ExtendedTriangle, index: number): void {
    const c = this.cast;
    const s = this.surface
      ? this.surface.getX(this.geometry.index!.getX(index * 3))
      : 0;
    if (s === PASS && !c.pass) return;
    if (c.ray.intersectTriangle(tri.a, tri.b, tri.c, false, _tri) === null)
      return;
    const t = _tri.distanceTo(c.ray.origin);
    if (t > c.max) return;
    const out = c.out;
    const kept = c.count;
    if (c.first && kept === 1 && t >= out[0].distance) return;
    tri.getNormal(_n);
    const leaving = _n.dot(c.ray.direction) > 0;
    if (!c.first) {
      for (let i = 0; i < kept; i++)
        if (
          out[i].leaving === leaving &&
          Math.abs(out[i].distance - t) < SAME_HIT
        )
          return;
      if (kept === out.length && t >= out[kept - 1].distance) return;
    }
    // The object to fill: the next free one, else the farthest kept, moved in by distance.
    let k = kept < out.length ? kept : kept - 1;
    const hit = out[k];
    while (k > 0 && out[k - 1].distance > t) {
      out[k] = out[k - 1];
      k--;
    }
    out[k] = hit;
    if (kept < out.length) c.count++;
    if (c.first) c.face = index;
    hit.distance = t;
    hit.point.copy(_tri);
    hit.leaving = leaving;
    hit.normal.copy(_n);
    if (leaving) hit.normal.negate();
    hit.surface = SURFACES[s] ?? 'stone';
  }
}

function copyHit(from: HullHit, to: HullHit): void {
  to.distance = from.distance;
  to.point.copy(from.point);
  to.normal.copy(from.normal);
  to.surface = from.surface;
  to.leaving = from.leaving;
}

/**
 * Where the segment `from + dir·t`, `t ∈ [0, far]`, enters `box` grown by `r` (0 when it
 * starts inside), or null when it misses it.
 */
function enterExpandedBox(
  box: THREE.Box3,
  from: THREE.Vector3,
  dir: THREE.Vector3,
  r: number,
  far: number
): number | null {
  let near = 0;
  for (let axis = 0; axis < 3; axis++) {
    const o = from.getComponent(axis);
    const d = dir.getComponent(axis);
    const lo = box.min.getComponent(axis) - r;
    const hi = box.max.getComponent(axis) + r;
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return null;
  }
  return near;
}

/**
 * The first `t ∈ [0, limit]` at which a sphere of radius `r` centred on `from + dir·t`
 * touches `tri`, or `limit` when it does not touch it sooner.
 */
function touch(
  tri: ExtendedTriangle,
  from: THREE.Vector3,
  dir: THREE.Vector3,
  limit: number,
  r: number,
  at: (t: number, out: THREE.Vector3) => THREE.Vector3
): number {
  const gap = (t: number) => tri.distanceToPoint(at(t, _p));
  if (gap(0) <= r) return 0;

  // Where the segment comes nearest the triangle: where it pierces it, else the closest
  // pair between the segment and the triangle's edges and corners.
  let tMin: number;
  _ray.origin.copy(from);
  _ray.direction.copy(dir);
  const pierce = _ray.intersectTriangle(tri.a, tri.b, tri.c, false, _hit);
  const tPierce = pierce ? _hit.distanceTo(from) : Infinity;
  if (tPierce <= limit) {
    // A ray (r = 0) touches where it pierces: the gap there is a tiny float, not 0.
    if (r === 0) return tPierce;
    tMin = tPierce;
  } else {
    _seg.start.copy(from);
    at(limit, _seg.end);
    const d = tri.closestPointToSegment(_seg, _onTri, _q);
    if (d > r) return limit;
    tMin = _q.sub(from).dot(dir);
  }
  if (gap(tMin) > r + TOLERANCE) return limit;

  // The gap falls from above r at 0 to at most r at tMin: bisect for the crossing.
  let lo = 0;
  let hi = tMin;
  while (hi - lo > TOLERANCE) {
    const mid = (lo + hi) / 2;
    if (gap(mid) > r) lo = mid;
    else hi = mid;
  }
  return Math.min(lo, limit);
}
