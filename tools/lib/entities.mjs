// A map's entities (maps/<map>/entities/default_ents.vents_c, which rip-entities.sh decompiles
// to text) and the world nodes of those a match starts with switched off. The world export
// places every entity's model in the world whatever its state, so game-mode props show in
// every replay: on Nuke, Wingman's two silo doors and roll-up door close doorways a 5v5
// match plays through (`[PR#]props.2v2`, startdisabled), and the retake blockers sit at the
// sites. shrink-map.mjs drops their nodes. rip-lighting.sh reads which sky CS2 draws and
// whether the bake holds the sun; lib/lightmap.mjs adds the sun where it does not.
//
// It also takes the doors and breakable windows (MOVABLE_CLASSES) out of the world into a
// document of their own, entities.glb: one root node per entity at its spawn transform, named
// by its hammer id, so the viewer can swing and break them as the match did.
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { copyToDocument, createDefaultPropertyResolver } from '@gltf-transform/functions';
import * as THREE from 'three';
import { kb } from './budgets.mjs';
import { toLinear } from './tint.mjs';

/** Source units (inches) to glTF metres; glTF (x, y, z) = Source (y, z, x) · UNIT. */
export const UNIT = 0.0254;
const DEG = Math.PI / 180;

/** The value of one `key value` line: a string, a resource path, a vector, a bool or text. */
function value(raw) {
  const v = raw.trim();
  const res = /^resource_name:"(.*)"$/.exec(v);
  if (res) return res[1];
  const str = /^"(.*)"$/.exec(v);
  if (str) return str[1];
  const vec = /^\[([^\]]*)\]$/.exec(v);
  if (vec) return vec[1].split(',').map((s) => Number(s.trim()));
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * The entities of a decompiled .vents: blocks separated by `====<n>====` lines, each line
 * a key and its value. Each has what the pipeline uses: class, model, origin, angles (pitch,
 * yaw, roll in degrees; `[0, 0, 0]` without the key, as Source spawns it), name, the name of
 * the entity it is parented to (`parentname`, '' for none), start state, `hammeruniqueid`
 * (null without one) and the animation a prop plays at spawn (`startinganim`, else `idleanim`;
 * '' for neither, which plays its model's default sequence); and `kv`, every key of the block
 * with its parsed value.
 */
export function parseEntities(text) {
  return text
    .split(/^====\d+====$/m)
    .map((block) => {
      const kv = {};
      for (const line of block.split('\n')) {
        const m = /^(\S+)\s+(.*)$/.exec(line.trim());
        if (m) kv[m[1]] = value(m[2]);
      }
      return kv;
    })
    .filter((kv) => typeof kv.classname === 'string')
    .map((kv) => ({
      classname: kv.classname,
      model: typeof kv.model === 'string' && kv.model ? kv.model : null,
      origin: vec3(kv.origin),
      angles: vec3(kv.angles) ?? [0, 0, 0],
      targetname: typeof kv.targetname === 'string' ? kv.targetname : '',
      parentname: typeof kv.parentname === 'string' ? kv.parentname : '',
      startDisabled: kv.startdisabled === true || kv.startdisabled === '1',
      hammerId: typeof kv.hammeruniqueid === 'string' && kv.hammeruniqueid ? kv.hammeruniqueid : null,
      animation: [kv.startinganim, kv.idleanim].find((a) => typeof a === 'string' && a) ?? '',
      kv,
    }));
}

/**
 * Three numbers from a vector value: `[ a, b, c ]` (parsed to an array) or the text form of
 * the 3D skybox prefabs' entity lumps, `"a b c"`. Null for anything else.
 */
export function vec3(v) {
  const xs = numbers(v);
  return xs.length === 3 && xs.every(Number.isFinite) ? xs : null;
}

/** The numbers of a vector value in either form (see vec3), whatever their count. */
function numbers(v) {
  return Array.isArray(v) ? v : typeof v === 'string' ? v.trim().split(/\s+/).map(Number) : [];
}

/**
 * The sky CS2 draws: the material (`skyname`) and the yaw in degrees (`angles[1]`, 0
 * without angles) of the first `env_sky` that does not start disabled, looked for in each
 * list in turn (a map's entities, then its 3D skybox prefab's); null when none has one.
 */
export function skyOf(...lists) {
  for (const entities of lists) {
    const sky = entities.find(
      (e) => e.classname === 'env_sky' && !e.startDisabled && typeof e.kv.skyname === 'string' && e.kv.skyname
    );
    if (sky) return { material: sky.kv.skyname, yaw: vec3(sky.kv.angles)?.[1] ?? 0 };
  }
  return null;
}

/** The `skyname` of the first `env_sky` in `entities` that does not start disabled, or null. */
export function skyMaterialOf(entities) {
  return skyOf(entities)?.material ?? null;
}

/**
 * The map a `skybox_reference` loads as the 3D skybox (`targetmapname`, e.g.
 * `maps/prefabs/de_ancient/de_ancient_skybox.vmap`), or null. On Ancient, Anubis and Vertigo
 * the map's own `env_sky` starts disabled and the prefab's is the sky drawn.
 */
export function skyboxMapOf(entities) {
  const ref = entities.find((e) => e.classname === 'skybox_reference' && typeof e.kv.targetmapname === 'string');
  return ref ? ref.kv.targetmapname : null;
}

/**
 * The sun: the first `light_environment` that is enabled and does not start disabled, or null.
 * - `dir`: unit vector towards the sun in glTF axes, from `angles` (pitch, yaw): the light
 *   shines along Source (cos p·cos y, cos p·sin y, −sin p).
 * - `color`: `color` (sRGB 0–255) in linear light; `intensity`: `brightness` · `brightnessscale`
 *   (1 when absent; 1.0 on all ten maps). Lambert with no π: a surface facing the sun gets
 *   `color · intensity` (the viewer's lightMapIntensity = π cancels three's 1/π).
 * - `baked`: whether the lightmap bake treated the sun as static (`directlight "1"`). Its light
 *   is then still missing from `irradiance` (D3): lib/lightmap.mjs `bakeSun` adds it from
 *   `direct_light_shadows`. Otherwise (de_cache: `"3"`, dynamic) the engine draws it at runtime.
 * - `shadowChannel`: the channel of `direct_light_shadows` holding its shadow
 *   (`bakedshadowindex`), null when it has none.
 */
export function sunOf(entities) {
  const env = entities.find(
    (e) => e.classname === 'light_environment' && !e.startDisabled && e.kv.enabled !== false && e.kv.enabled !== '0'
  );
  if (!env) return null;
  const [pitch, yaw] = (vec3(env.kv.angles) ?? [0, 0, 0]).map((a) => (a * Math.PI) / 180);
  const along = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
  const rgb = vec3(numbers(env.kv.color).slice(0, 3)) ?? [255, 255, 255];
  const brightness = Number(env.kv.brightness);
  const scale = Number(env.kv.brightnessscale ?? 1);
  const channel = String(env.kv.bakedshadowindex ?? '');
  return {
    dir: [-along[1], -along[2], -along[0]],
    color: rgb.map((c) => toLinear(c / 255)),
    intensity: (Number.isFinite(brightness) ? brightness : 1) * (Number.isFinite(scale) ? scale : 1),
    baked: String(env.kv.directlight) === '1',
    shadowChannel: /^\d+$/.test(channel) ? Number(channel) : null,
  };
}

/** The entities with a model and an origin that start switched off. */
export function hiddenAtStart(entities) {
  return entities.filter((e) => e.startDisabled && e.model && e.origin);
}

/** glTF position of a Source origin, as VRF writes the world: `(y, z, x) · 0.0254`. */
function toGltf([x, y, z]) {
  return [y * UNIT, z * UNIT, x * UNIT];
}

/**
 * The scene's mesh nodes that are `hidden` entities: the node's name starts with the
 * entity's model name (VRF names them `<model>.<mesh>`) and its world position is the
 * entity's origin, as glTF `(y, z, x) · 0.0254`, to within `tolerance` metres.
 */
export function hiddenNodes(doc, hidden, tolerance = 0.05) {
  const byModel = new Map();
  for (const e of hidden) {
    const base = path.basename(e.model, '.vmdl');
    const list = byModel.get(base) ?? [];
    list.push(toGltf(e.origin));
    byModel.set(base, list);
  }
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const places = byModel.get(node.getName().split('.')[0]);
    if (!places) continue;
    const w = node.getWorldMatrix();
    if (places.some((p) => Math.hypot(w[12] - p[0], w[13] - p[1], w[14] - p[2]) <= tolerance))
      out.push(node);
  }
  return out;
}

/** The entity classes whose models move during a match: doors swing, windows break. */
export const MOVABLE_CLASSES = Object.freeze(['prop_door_rotating', 'func_door_rotating', 'func_door', 'func_breakable']);

/** The doors and breakables with a model and an origin that a match starts with switched on. */
export function movableEntities(entities) {
  return entities.filter((e) => MOVABLE_CLASSES.includes(e.classname) && e.model && e.origin && !e.startDisabled);
}

/** The scene's mesh nodes of one entity, by the rule of `hiddenNodes`. */
export function entityNodes(doc, entity, tolerance = 0.05) {
  return hiddenNodes(doc, [entity], tolerance);
}

/**
 * Source angles (pitch, yaw, roll in degrees) as a glTF rotation `[x, y, z, w]`: `S·R·Sᵀ`, where
 * `R = Rz(yaw)·Ry(pitch)·Rx(roll)` is Source's AngleMatrix and `S` takes Source `(x, y, z)` to
 * glTF `(y, z, x)`. Conjugating by `S` only renames the axes, so it is yaw about glTF y, then
 * pitch about x, then roll about z.
 */
export function anglesToGltfQuat([pitch, yaw, roll]) {
  const axis = (i, deg) => {
    const q = [0, 0, 0, Math.cos((deg * DEG) / 2)];
    q[i] = Math.sin((deg * DEG) / 2);
    return q;
  };
  return mul(mul(axis(1, yaw), axis(0, pitch)), axis(2, roll));
}

/** Hamilton product of two `[x, y, z, w]` quaternions. */
function mul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** An entity root's extras: what the viewer matches a demo's entity by, in Source units and degrees. */
function rootExtras(e) {
  return { classname: e.classname, origin: e.origin, angles: e.angles, model: e.model };
}

/** An entity name as a parentname refers to it: without the `[PR#]` prefix the compiler adds. */
const entityName = (name) => name.replace(/^\[PR#\]/, '');

/**
 * The entities parented to `movable`, at any depth (a prop on a door, a sign on that prop), that
 * have a model and an origin; not other movables, which have their own root.
 */
function attachedTo(movable, entities) {
  const name = entityName(movable.targetname);
  if (!name) return [];
  const byParent = new Map();
  for (const e of entities) {
    const parent = entityName(e.parentname);
    if (!parent || e === movable || MOVABLE_CLASSES.includes(e.classname)) continue;
    byParent.set(parent, [...(byParent.get(parent) ?? []), e]);
  }
  const out = [];
  const seen = new Set([name]);
  for (let queue = [name]; queue.length;) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      if (child.model && child.origin) out.push(child);
      const own = entityName(child.targetname);
      if (own && !seen.has(own)) { seen.add(own); queue.push(own); }
    }
  }
  return out;
}

/**
 * Moves the mesh nodes of `movables` (`movableEntities`), and of the entities parented to each
 * at any depth (`entities`, the map's whole list; Vertigo's porta-potty door is a prop_dynamic
 * on a func_door_rotating that owns only a latch), out of `doc` into a new document: one root
 * node per movable in the default scene, in `movables` order, named by its hammer id, at its
 * spawn transform (translation = origin as glTF, rotation = `anglesToGltfQuat(angles)`, no
 * scale) with `extras` `{ classname, origin, angles, model }`; its children are those nodes,
 * the movable's own first, re-parented with local = inverse(spawn) × their world matrix, so they
 * stay where they were. An entity with no node in `doc` keeps an empty root. Meshes the nodes
 * shared stay shared. What the nodes leave unused in `doc` stays there for its prune. Throws
 * when two entities claim one node.
 * @returns {{ doc: Document, nodes: number }} the entity document and how many nodes moved
 */
export function splitMovables(doc, movables, entities = []) {
  const out = new Document().setLogger(doc.getLogger());
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    const copy = out.createExtension(ext.constructor);
    if (ext.isRequired()) copy.setRequired(true);
  }
  const scene = out.createScene('entities');
  out.getRoot().setDefaultScene(scene);

  const claimed = new Map();
  const who = ([m, e]) => (e === m ? `${m.hammerId}` : `${e.hammerId} (parented to ${m.hammerId})`);
  const found = movables.map((m) => [m, ...attachedTo(m, entities)].flatMap((e) => {
    const nodes = entityNodes(doc, e);
    for (const n of nodes) {
      if (claimed.has(n)) throw new Error(`node ${n.getName()} is claimed by ${who(claimed.get(n))} and ${who([m, e])}`);
      claimed.set(n, [m, e]);
    }
    return nodes;
  }));
  const moving = found.flat();
  const world = new Map(moving.map((n) => [n, new THREE.Matrix4().fromArray(n.getWorldMatrix())]));
  const copies = copyToDocument(out, doc, moving, createDefaultPropertyResolver(out, doc));
  for (const n of moving) n.dispose();

  const one = new THREE.Vector3(1, 1, 1);
  movables.forEach((e, i) => {
    const t = toGltf(e.origin);
    const r = anglesToGltfQuat(e.angles);
    const root = out.createNode(e.hammerId ?? '').setTranslation(t).setRotation(r).setExtras(rootExtras(e));
    scene.addChild(root);
    const inverse = new THREE.Matrix4()
      .compose(new THREE.Vector3(...t), new THREE.Quaternion(...r), one)
      .invert();
    for (const n of found[i]) {
      const child = copies.get(n);
      child.setMatrix(inverse.clone().multiply(world.get(n)).toArray());
      root.addChild(child);
    }
  });
  return { doc: out, nodes: moving.length };
}

/**
 * What is wrong with `doc`'s entity roots (the default scene's children, or the first scene's)
 * against `movables`: per entity, no root named by its hammer id, other extras, or a
 * translation or rotation that is not its spawn; then any root no entity has. Empty when
 * every entity has its root.
 * @returns {string[]}
 */
export function entityRootProblems(doc, movables, tolerance = 1e-4) {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const roots = scene?.listChildren() ?? [];
  const byName = new Map(roots.map((r) => [r.getName(), r]));
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
  const problems = [];
  for (const e of movables) {
    const id = e.hammerId ?? '';
    const root = byName.get(id);
    byName.delete(id);
    if (!root) {
      problems.push(`${e.classname} ${id}: no root named by its hammer id`);
    } else if (JSON.stringify(root.getExtras()) !== JSON.stringify(rootExtras(e))) {
      problems.push(`${e.classname} ${id}: extras ${JSON.stringify(root.getExtras())}, expected ${JSON.stringify(rootExtras(e))}`);
    } else if (!near(root.getTranslation(), toGltf(e.origin))) {
      problems.push(`${e.classname} ${id}: translation ${root.getTranslation()} is not its origin`);
    } else {
      const r = root.getRotation();
      const q = anglesToGltfQuat(e.angles);
      // q and −q are the same rotation
      if (!near(r, q) && !near(r, q.map((v) => -v))) problems.push(`${e.classname} ${id}: rotation ${r} is not its angles`);
    }
  }
  for (const name of byName.keys()) problems.push(`root ${name} matches no door or breakable`);
  return problems;
}

/**
 * check-map.mjs's rows for entities.glb: `[check, actual, budget, ok]`, ok null for a row that
 * checks nothing. `movables` is `movableEntities` of the map's entity lump (null without one),
 * `doc` the read entities.glb (null when absent), `bytes` its size, `budget` the size limit.
 * Absent on a map without doors or breakables; otherwise present, within the budget, one root
 * per entity (`entityRootProblems`) and COLOR_0 on every primitive, with at least one.
 */
export function entityChecks({ movables, doc, bytes, budget }) {
  if (!movables) return [['entities.glb', doc ? 'present' : 'absent', 'unchecked: no entities/default_ents.vents', null]];
  if (!movables.length) return [['entities.glb', doc ? 'present' : 'absent', 'absent (no doors or breakables)', !doc]];
  if (!doc) return [['entities.glb', 'missing', `present (${movables.length} doors and breakables)`, false]];
  const problems = entityRootProblems(doc, movables);
  let prims = 0, missing = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { prims++; if (!p.getAttribute('COLOR_0')) missing++; }
  return [
    ['entities.glb size', kb(bytes), `≤ ${kb(budget)}`, bytes <= budget],
    ['entities.glb roots', problems.length ? `${problems.length} wrong, e.g. ${problems[0]}` : `${movables.length}/${movables.length}`, 'one per door and breakable, at its spawn, with its extras', problems.length === 0],
    ['entities.glb COLOR_0', `${prims - missing}/${prims} primitives`, 'every primitive (at least one)', prims > 0 && missing === 0],
  ];
}
