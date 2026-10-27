#!/usr/bin/env node
// node tools/shrink-map.mjs <map>
//
// assets/raw/<map>/world.glb           → assets/maps/<map>/world.glb     (256 px WebP, lit: below)
//                                      → assets/maps/<map>/entities.glb  (doors and breakables, maps
//                                        that have any; one root node per entity at its spawn)
// assets/raw/<map>/world_collision.glb → assets/maps/<map>/hull.glb
// assets/raw/<map>/lightmaps/          → assets/maps/<map>/lightmap.webp, probes.bin, light.json
// each .glb, probes.bin and light.json with a .gz sibling, plus assets/maps/<map>/shrink.json
// (counts, sizes, timings, parameters).
//
// Drop editor-only meshes (lib/filters.mjs, with the map's PER_MAP entry) → pose skinned props →
// tint → doors and windows out → dedup, prune, flatten, join, weld, simplify once → light →
// textures.
//
// The light is CS2's own bake for a map in LIGHTMAP_MAPS whose rip-lighting.sh export is whole
// (lib/lightmap.mjs lightmapInputs, with the probe atlas): the H2 tier the user approved (Task 1b
// in the m2a plan; lib/light.mjs).
// - On a map whose sun is baked (light_environment directlight "1") the sun goes into the
//   irradiance offline (bakeSun); a dynamic sun (de_cache) stays out, for the viewer to draw.
//   The result is lightmap.webp: 1024 px, sqrt(light / range) at the map's one range
//   (chooseRange) in 8 bits a channel, lossless (lightmap.mjs encodeLightmap).
// - A primitive with at least 2 lightmap texels (at 2048) per vertex ships its lightmap UV as
//   TEXCOORD_1 (14-bit). Every other primitive gets its light per vertex in COLOR_0 (6-bit):
//   the 2048 px baked light at its lightmap UV, or without one the full-resolution probe volumes
//   10 cm off the surface (plus the baked sun). It is taken per source vertex before the strip
//   and given to each final vertex after weld and simplify, so it adds no vertices.
// - probes.bin is the light grid for players (lib/probes.mjs: 2.5 m cells over the hull's
//   bounds, sampled above its walkable floors), and light.json names the files, the range and
//   the sun.
// - A map whose first load (lib/maps.mjs MAP_FIRST_LOAD) would pass its cap (lib/budgets.mjs
//   firstLoadBytes) tries world.glb's textures at 192 px, then tier V (no lightmap, every
//   primitive vertex-lit) at 256 and 192 px: lib/light.mjs TIER_LADDER, walked in its order.
// A map outside LIGHTMAP_MAPS bakes AO into COLOR_0 (lib/ao.mjs) as before, with no bake files.
// One on it whose export is not whole (or that has no entity lump, probe volumes or, with a
// baked sun, bakedshadowindex) fails before anything is read: it never falls back to AO.
//
// Skinned props are first put into the pose the game draws them in (lib/poses.mjs, by
// raw/<map>/model-poses.json from tools/model-poses.sh; it stops when the table is not from the
// rip's CS2 build and VRF, or lacks or could not pose a skinned model the world draws), so
// everything below, the light and the AO included, sees the posed geometry.
// After the world's drop, pose, tint and lights (and, without a bake, its strip), the doors and
// breakable windows (lib/entities.mjs MOVABLE_CLASSES, with the props parented to them) leave
// it for entities.glb, before the world's geometry and light stages: they move, so they get no
// lightmap UV, and the world bakes without them. The viewer swings and breaks them as the match
// did. entities.glb: unread attributes stripped, dedup, prune, weld (no join, no simplify, the
// nodes stay apart), then its light in COLOR_0 at its spawn pose:
// - on a baked map, vertex light from the full-resolution probe volumes (plus the baked sun),
//   as the world's primitives without a lightmap UV get it, at the map's range: the viewer
//   draws it with the world's vertex-light look;
// - otherwise AO with the world in reach as occluder, as the world's AO.
// Then the world's 256 px textures, prune and meshopt. A map without any has no entities.glb,
// and one left from an earlier build is removed. On a baked map it counts in the first load.
// The hull is the world's own collision (maps/<map>/world_physics.vmdl_c, which
// rip-map.sh saves as world_collision.glb), through the same drop rule, so player,
// grenade and ladder clips go; not VRF's world_physics.glb from the world export,
// which is entity physics (trigger, place and nav volumes, func_brush, props).
// The server sends a `.gz` sibling (lib/gz.mjs, gzip -9) to clients that accept gzip.
// Everything is written into <out>.tmp-<pid>/ through one MapBuild (lib/map-build.mjs, which also
// keeps the stage log the bake and the tier ladder (walkTiers) write to) and renamed over those
// files and shrink.json at the end (lib/install.mjs), and the optional outputs this run did not write
// (entities.glb, the bake files) are removed from <out>, as is world_hd.glb, the 1024 px world
// nothing loads any more (lib/maps.mjs MAP_RETIRED); other files in <out> (radar, overview, sky,
// manifest) are left alone.
// There are deliberately no SIGINT/SIGTERM handlers: bakeAo is one synchronous loop
// (126 s on Mirage, 699 s on Train), and an installed JS handler both waits for the
// event loop and cancels node's default exit, so Ctrl-C would do nothing until the
// bake ends. A signal kills node at once and leaves <out>.tmp-<pid>/ behind, which
// build-assets.sh removes when it next starts.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PropertyType, getBounds } from '@gltf-transform/core';
import {
  cloneDocument, dedup, flatten, join, meshopt, prune, simplify, textureCompress, weld,
} from '@gltf-transform/functions';
import { paths } from './lib/paths.mjs';
import { createIO, countTris, stripAttributes, MeshoptEncoder, MeshoptSimplifier } from './lib/gltf.mjs';
import { shouldDrop, vmatOf, perMapParams, DROP_NODE, DROP_VMAT_PREFIXES, DROP_SHADERS } from './lib/filters.mjs';
import { bakeAo, AO_DEFAULTS } from './lib/ao.mjs';
import { MOVABLE_CLASSES, hiddenAtStart, hiddenNodes, movableEntities, parseEntities, splitMovables, sunOf } from './lib/entities.mjs';
import { bakeTint, hasMask, tintMaskPng } from './lib/tint.mjs';
import { fitTextures } from './lib/alpha.mjs';
import { isMain } from './lib/cli.mjs';
import { LIGHTMAP_MAPS, MAP_BAKE_FILES, MAP_FIRST_LOAD, MAP_GLBS as GLBS, MAP_OPTIONAL_GLBS, firstLoadBytes } from './lib/maps.mjs';
import { MapBuild } from './lib/map-build.mjs';
import { FIRST_LOAD_BEFORE_M2A, budgetFor, kb, mb } from './lib/budgets.mjs';
import { MODEL_POSES_FILE, poseSkinnedProps, readModelPoses, staleModelPoses } from './lib/poses.mjs';
import {
  LIGHTMAP_PARAMS, bakeSun, chooseRange, coverage, dilate, downscale, dropLightmapUv, encodeLightmap,
  fitsCharts, lightmapInputs, lightmapUv, lightmapWebp, readChart, readHdr, readShadow,
} from './lib/lightmap.mjs';
import {
  GRID_STEP, buildLightGrid, encodeLightGrid, probeSampler, probeVolumes, readProbeAtlas, walkableTriangles,
} from './lib/probes.mjs';
import {
  LIGHT_PARAMS, ladderRuns, walkLadder, applyVertexLight, keepsLightmapUv, lightJson, materialIds, sourceLight,
} from './lib/light.mjs';

export const PARAMS = Object.freeze({
  drop: { node: DROP_NODE.source, nodeFlags: DROP_NODE.flags, vmatPrefixes: [...DROP_VMAT_PREFIXES], shaders: [...DROP_SHADERS] },
  // Vertex attributes removed before welding. The viewer renders unlit, so normals and tangents
  // are never read; keeping them stops weld from merging vertices that differ only in them
  // (Inferno: 14.1 M vertices with them, 5.3 M without), which doubles the AO colour data and
  // the file. Only POSITION, TEXCOORD_0 and the baked COLOR_0 ship. With a bake every attribute
  // but POSITION and TEXCOORD_0 goes, and the lightmap UV comes back as TEXCOORD_1 where H2
  // keeps it.
  strip: ['NORMAL', 'TANGENT', 'TEXCOORD_1', 'TEXCOORD_2', 'COLOR_0', 'COLOR_1'],
  geometry: ['strip', 'dedup', 'prune', 'flatten', 'join', 'weld', 'simplify'],
  simplify: { ratio: 0.35, error: 0.002, lockBorder: true },
  ao: { ...AO_DEFAULTS },
  world: { format: 'webp', size: 256, quality: 60 },
  // One quantization grid for the whole map. The default ('mesh') gives every mesh its own
  // grid, so two meshes that share an edge (a wall and the floor) round its vertices to
  // different points and open hairline cracks that show the sky (measured on Mirage
  // 2026-10-22: of the open-edge vertices within 3 cm of another mesh, 67 coincided and about
  // 48,000 were 2-15 mm apart). 16 bits over a ~200 m map is ~3 mm per step.
  meshopt: { level: 'high', quantizationVolume: 'scene', quantizePosition: 16 },
  // The bake (lib/lightmap.mjs, lib/light.mjs, lib/probes.mjs). `prune` keeps attributes, or it
  // drops TEXCOORD_1, which no material reads; texcoords quantize at 14 bits where TEXCOORD_1
  // ships (12 is ±0.25 texel at 2048).
  bake: {
    lightmap: { ...LIGHTMAP_PARAMS },
    light: { ...LIGHT_PARAMS },
    gridStep: GRID_STEP,
    prune: { keepAttributes: true },
    quantizeTexcoord: 14,
  },
  hull: { source: 'world_collision.glb', steps: ['drop', 'strip materials', 'prune', 'weld', 'meshopt'] },
  // Taken out of the world after its strip (with a bake, before it: they are stripped as the
  // world is once their probe light is taken); textures as `world`, meshopt as the world.
  // `strip` removes what the world keeps but nothing reads (VRF's _TEXCOORD_4, and joints and
  // weights without a skin); not added to the world's list, because there it changes which
  // primitives join and weld (Mirage: 184 fewer triangles out, world.glb 107 KB smaller).
  // `steps`, per path: without a bake (`ao`), AO with the world occluding; with one (`bake`),
  // each source vertex's light from the full-resolution probes at the spawn pose (normals still
  // on), then the world's strip, and that light per welded vertex at the map's range.
  entities: {
    classes: [...MOVABLE_CLASSES], strip: ['_TEXCOORD_4', 'JOINTS_0', 'WEIGHTS_0'],
    steps: {
      ao: ['strip', 'dedup', 'prune', 'weld', 'ao (world occludes)', 'webp', 'prune', 'meshopt'],
      bake: [
        'strip', 'dedup', 'prune (keep attributes)', 'source light (probes + baked sun, at spawn)',
        'strip (as the world)', 'dedup', 'prune', 'weld', 'vertex light (the map\'s range)', 'webp', 'prune', 'meshopt',
      ],
    },
  },
});

/** Removes KHR_lights_punctual lights (VRF exports the map's sun at intensities around 2,600,
 *  which blows out any lit material in the viewer); returns how many lights were removed. */
export function dropLights(doc) {
  const ext = doc.getRoot().listExtensionsUsed().find((e) => e.extensionName === 'KHR_lights_punctual');
  if (!ext) return 0;
  const n = ext.listProperties().filter((p) => p.propertyType === 'Light').length;
  ext.dispose();
  return n;
}

const usage = 'usage: node tools/shrink-map.mjs <map>';

function fail(msg) {
  console.error(`shrink-map: ${msg}`);
  process.exit(1);
}

/** Removes every node mesh or primitive the filter (with `map`'s PER_MAP entry) rejects; returns node counts. */
function dropEditorMeshes(doc, map) {
  let droppedNodes = 0, keptNodes = 0, droppedPrimitives = 0;
  const failing = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const prims = mesh.listPrimitives();
    const bad = prims.filter((p) => {
      const { name, shader } = vmatOf(p.getMaterial());
      return shouldDrop(node.getName(), name, shader, map);
    });
    if (bad.length === prims.length) {
      // Detach rather than dispose: dispose() would orphan any children.
      node.setMesh(null);
      droppedNodes++;
    } else {
      // Only the material half of the rule can reject part of a mesh, and that
      // verdict holds for every node sharing it, so the mesh itself is edited.
      for (const p of bad) failing.add(p);
      keptNodes++;
    }
  }
  for (const p of failing) { p.dispose(); droppedPrimitives++; }
  return { droppedNodes, keptNodes, droppedPrimitives };
}

/** The hull is collision only: any materials (and their textures and UVs) go. */
function stripMaterials(doc) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      p.setMaterial(null);
      for (const s of p.listSemantics()) if (s.startsWith('TEXCOORD_')) p.setAttribute(s, null);
    }
  }
}

/**
 * What to bake for `map`, or why not ({ skipped }): its lightmaps export (lightmapInputs, with the
 * probe atlas), its probe volumes and its sun (entities.mjs sunOf). main builds the AO for a map
 * outside LIGHTMAP_MAPS and stops for one on it that cannot bake.
 */
function bakePlan(map, P, entities) {
  if (!LIGHTMAP_MAPS.includes(map)) return { skipped: `${map} is not in LIGHTMAP_MAPS` };
  if (!entities) return { skipped: 'no entity lump (tools/rip-entities.sh), so no sun or probe volumes' };
  const inputs = lightmapInputs(P.rawLightmaps);
  if (!inputs) return { skipped: `no whole lightmaps export in ${path.relative(process.cwd(), P.rawLightmaps)} (tools/rip-lighting.sh)` };
  if (!inputs.probes) return { skipped: 'the lightmaps export has no probe atlas' };
  const volumes = probeVolumes(entities);
  if (!volumes.length) return { skipped: 'the map has no light probe volumes' };
  const sun = sunOf(entities);
  if (inputs.shadow && sun?.baked && sun.shadowChannel == null) return { skipped: 'its baked sun has no bakedshadowindex' };
  return { inputs, volumes, sun };
}

async function main() {
  const map = process.argv[2];
  if (!map || process.argv.length > 3) fail(usage);
  let P;
  try { P = paths(map); } catch (e) { fail(e.message); }
  const rawWorld = path.join(P.raw, 'world.glb');
  const rawCollision = path.join(P.raw, 'world_collision.glb');
  for (const f of [rawWorld, rawCollision]) {
    // --force: rips made before rip-map.sh exported world_collision.glb are otherwise skipped.
    if (!fs.existsSync(f)) fail(`${f} is missing; run tools/rip-map.sh ${map} --force`);
  }
  // The skinned props' poses (tools/model-poses.sh), which must come from the rip's CS2 build and VRF.
  const poseTable = readModelPoses(P.raw);
  if (poseTable) {
    const ripFile = path.join(P.raw, 'rip.json');
    const stale = staleModelPoses(poseTable, fs.existsSync(ripFile) ? JSON.parse(fs.readFileSync(ripFile, 'utf8')) : null, map);
    if (stale) fail(stale);
  }
  // Entities a match starts with switched off (game-mode props and blockers): rip-entities.sh
  // writes the decompiled entity lump beside the raw world. The bake reads its sun and probe
  // volumes too.
  const ventsFile = path.join(P.raw, 'entities', 'default_ents.vents');
  // A map in LIGHTMAP_MAPS ships CS2's baked light and never falls back to AO: one that cannot
  // bake stops here, before anything is read or written (rip-lighting.sh fails such a map's
  // export, and check-map.mjs fails it without light.json). Taking it off LIGHTMAP_MAPS is the
  // one way to build it with AO. An entity lump or lightmaps.json that does not parse stops it
  // as the build's own errors do, with its message rather than a stack.
  let entities, plan;
  try {
    entities = fs.existsSync(ventsFile) ? parseEntities(fs.readFileSync(ventsFile, 'utf8')) : null;
    plan = bakePlan(map, P, entities);
  } catch (e) {
    fail(e.message);
  }
  if (plan.skipped && LIGHTMAP_MAPS.includes(map)) {
    fail(`${map} cannot bake: ${plan.skipped}. It is in LIGHTMAP_MAPS (tools/lib/maps.mjs), so it ships CS2's baked light, not AO; fix its raw export, or take it off LIGHTMAP_MAPS to build it with AO`);
  }

  // The clock, the stage log and everything written go through `build` (lib/map-build.mjs).
  const build = new MapBuild(map, P);

  try {
    const io = await createIO();

    const doc = await io.read(rawWorld);
    const trisIn = countTris(doc);
    build.stage('read', `${path.relative(process.cwd(), rawWorld)} ${mb(fs.statSync(rawWorld).size)}, ${doc.getRoot().listNodes().length} nodes, ${trisIn} tris`);

    let hiddenDropped = 0;
    if (entities) {
      const off = hiddenNodes(doc, hiddenAtStart(entities));
      for (const n of off) n.dispose();
      hiddenDropped = off.length;
      build.stage('hidden', `dropped ${hiddenDropped} node(s) of entities that start disabled`);
    } else {
      console.log(`           no ${path.relative(process.cwd(), ventsFile)}: entities that start disabled stay, and doors and breakables stay in the world (run tools/rip-entities.sh ${map})`);
    }

    const drop = dropEditorMeshes(doc, map);
    // The world's triangles going into its geometry stage: after the drop, less the doors and
    // breakables that leave it below.
    let trisKept = countTris(doc);
    build.stage('drop', `dropped ${drop.droppedNodes} nodes (+${drop.droppedPrimitives} primitives), kept ${drop.keptNodes}, ${trisKept} tris left`);

    // Skinned props into the pose the game draws them in (lib/poses.mjs): VRF exports them in
    // their bind pose, which lays Overpass's door flat and turns Nuke's out of their doorways.
    // Only the models still drawn after the drop count: a model the table could not pose stops
    // this map only if its world draws it.
    const poses = poseSkinnedProps(doc, poseTable?.models ?? {});
    if (poses.unknown.length) {
      throw new Error(`skinned model(s) ${poses.unknown.join(', ')} are not in ${path.join(P.raw, MODEL_POSES_FILE)}${poseTable ? '' : ', which does not exist'}; run tools/model-poses.sh ${map}`);
    }
    const unposable = Object.entries(poses.errors);
    if (unposable.length) {
      throw new Error(`model-poses.sh could not pose ${unposable.map(([m, e]) => `${m}: ${e}`).join('; ')}`);
    }
    const posedNodes = Object.values(poses.posed).reduce((a, b) => a + b, 0);
    if (posedNodes) build.stage('pose', `posed ${posedNodes} node(s) of ${Object.entries(poses.posed).map(([m, n]) => `${m} ×${n}`).join(', ')}`);

    // Tints through tint masks, baked into the colour; one texture per colour, mask and tint.
    const baked = new Map();
    let tinted = 0;
    for (const m of doc.getRoot().listMaterials()) {
      const mask = tintMaskPng(m, P.raw);
      const tex = m.getBaseColorTexture();
      if (!tex || !hasMask(mask)) continue;
      const f = m.getBaseColorFactor();
      const key = `${tex.getName()}|${mask}|${f.slice(0, 3).map((x) => x.toFixed(3)).join(',')}`;
      let out = baked.get(key);
      if (!out) {
        const image = await bakeTint(Buffer.from(tex.getImage()), fs.readFileSync(mask), f);
        out = doc.createTexture(`${tex.getName()}_tint${baked.size}`).setImage(image).setMimeType('image/png');
        baked.set(key, out);
      }
      m.setBaseColorTexture(out).setBaseColorFactor([1, 1, 1, f[3]]);
      tinted++;
    }
    if (tinted) build.stage('tint', `baked ${tinted} material tint(s) through their masks into ${baked.size} texture(s)`);

    const lights = dropLights(doc);
    if (lights) build.stage('lights', `removed ${lights} embedded light(s) (KHR_lights_punctual); the viewer lights the scene itself`);

    // A bake needs every attribute (lightmap UVs, normals) until its own strip; without one the
    // world is stripped now, as before M2a.
    if (plan.skipped) {
      console.log(`           no bake: ${plan.skipped}; AO in COLOR_0 as before`);
      const stripped = stripAttributes(doc, PARAMS.strip);
      build.stage('strip', `removed ${stripped} vertex attributes (${PARAMS.strip.join(', ')})`);
    }

    // Doors and breakable windows (and the props parented to them) leave the world, with its
    // drop, pose, tint and lights done, before anything takes the world's light or AO.
    const movables = movableEntities(entities ?? []);
    let ents = null;
    if (movables.length) {
      const split = splitMovables(doc, movables, entities);
      ents = { doc: split.doc, count: movables.length, nodes: split.nodes, trisIn: countTris(split.doc), light: plan.skipped ? 'ao' : 'probes' };
      trisKept = countTris(doc);
      const entStripped = stripAttributes(ents.doc, PARAMS.entities.strip);
      build.stage('movable', `moved ${ents.nodes} node(s) of ${ents.count} door(s) and breakable(s) to entities.glb, ${ents.trisIn} tris (${entStripped} more vertex attributes removed there); ${trisKept} tris left in the world`);
    }

    // The hull first: its walkable floors and its bounds place the light grid.
    const phys = await io.read(rawCollision);
    const hullTrisIn = countTris(phys);
    const hullDrop = dropEditorMeshes(phys, map);
    stripMaterials(phys);
    await phys.transform(prune(), weld());
    const hullFloors = walkableTriangles(phys);
    const hullBounds = getBounds(phys.getRoot().getDefaultScene() ?? phys.getRoot().listScenes()[0]);
    await phys.transform(meshopt({ encoder: MeshoptEncoder }));
    const hullBytes = await io.writeBinary(phys);
    build.write('hull.glb', hullBytes);
    const hullTris = countTris(phys);
    build.stage('hull', `${hullTrisIn} → ${hullTris} tris (dropped ${hullDrop.droppedNodes} nodes +${hullDrop.droppedPrimitives} primitives, kept ${hullDrop.keptNodes}), ${mb(hullBytes.byteLength)}`);

    const tex = (t) => textureCompress({ encoder: sharp, targetFormat: t.format, resize: [t.size, t.size], quality: t.quality });
    // Textures are fitted first, colour and alpha apart (lib/alpha.mjs), so textureCompress
    // only encodes: its resize premultiplies and turned colour under zero alpha to noise.
    const fit = async (d, t) => fitTextures(d, [t.size, t.size]);
    /** world.glb with `size` px textures from the lit document `d`, staged. */
    const shipTextures = async (d, finish, suffix = '', size = PARAMS.world.size) => {
      const world = { ...PARAMS.world, size };
      const worldFit = await fit(d, world);
      await d.transform(tex(world), ...finish());
      const worldBytes = await io.writeBinary(d);
      build.write('world.glb', worldBytes);
      build.stage(`world${suffix}`, `${size} px q${world.quality}: ${mb(worldBytes.byteLength)}, ${d.getRoot().listTextures().length} textures (${worldFit.alphaDropped} unused alpha channels dropped)`);
      return { worldBytes };
    };
    /** entities.glb from the lit `ents.doc` (the world's 256 px textures), staged with its .gz. */
    const shipEntities = async () => {
      // keepLeaves: an entity whose nodes the drop removed keeps its (empty) root.
      const entFit = await fit(ents.doc, PARAMS.world);
      await ents.doc.transform(tex(PARAMS.world), prune({ keepLeaves: true }), meshopt({ encoder: MeshoptEncoder, ...PARAMS.meshopt }));
      const entBytes = await io.writeBinary(ents.doc);
      build.write('entities.glb', entBytes);
      build.gzip(['entities.glb']);
      ents.bytes = entBytes.byteLength;
      build.stage('entities', `${ents.count} root(s), ${PARAMS.world.size} px q${PARAMS.world.quality}: ${kb(ents.bytes)}, ${ents.doc.getRoot().listTextures().length} textures (${entFit.alphaDropped} unused alpha channels dropped)`);
    };

    let world, trisOut, ao = { vertices: 0, seconds: 0 }, bakeReport = null;
    if (plan.skipped) {
      await doc.transform(
        dedup(), prune(), flatten(), join(), weld(),
        simplify({ simplifier: MeshoptSimplifier, ...PARAMS.simplify }),
      );
      trisOut = countTris(doc);
      build.stage('geometry', `${PARAMS.geometry.join(' → ')}: ${trisOut} tris, ${doc.getRoot().listMeshes().length} meshes`);
      ao = bakeAo(doc, { rays: PARAMS.ao.rays, maxDist: PARAMS.ao.maxDist });
      build.stage('ao', `${ao.vertices} vertices × ${PARAMS.ao.rays} rays in ${ao.seconds.toFixed(1)}s`);
      // The entities' geometry and AO, while the world is still unquantized to occlude them.
      if (ents) {
        await ents.doc.transform(dedup(), prune({ keepLeaves: true }), weld());
        ents.tris = countTris(ents.doc);
        const entAo = bakeAo(ents.doc, { rays: PARAMS.ao.rays, maxDist: PARAMS.ao.maxDist, occluders: doc });
        build.stage('ents-ao', `dedup → prune → weld: ${ents.tris} tris; AO ${entAo.vertices} vertices with ${entAo.occluderTris} world tris in reach occluding, in ${entAo.seconds.toFixed(1)}s`);
      }
      world = await shipTextures(doc, () => [prune(), meshopt({ encoder: MeshoptEncoder, ...PARAMS.meshopt })]);
      if (ents) await shipEntities();
    } else {
      ({ world, trisOut, report: bakeReport } = await bakeWorld(build, {
        doc, ents, plan, hull: { floors: hullFloors, bounds: hullBounds }, ship: { textures: shipTextures, entities: shipEntities },
      }));
    }

    const served = [...GLBS, ...MAP_OPTIONAL_GLBS, 'light.json', 'probes.bin'];
    build.gzip(served.filter((f) => build.has(f) && !build.has(`${f}.gz`)));
    build.stage('gzip', [...GLBS, ...(ents ? ['entities.glb'] : [])].map((f) => `${f} ${(f === 'entities.glb' ? kb : mb)(build.gzBytes[f])}`).join(', '));

    const seconds = build.seconds();
    const report = {
      map, trisIn, trisKept, trisOut, hiddenDropped, tinted, posed: poses.posed,
      entities: ents && { count: ents.count, nodes: ents.nodes, trisIn: ents.trisIn, tris: ents.tris, light: ents.light, bytes: ents.bytes, gzBytes: build.gzBytes['entities.glb'] },
      droppedNodes: drop.droppedNodes, keptNodes: drop.keptNodes, droppedPrimitives: drop.droppedPrimitives,
      aoSeconds: +ao.seconds.toFixed(1), aoVertices: ao.vertices,
      hullTrisIn, hullTris,
      hullDroppedNodes: hullDrop.droppedNodes, hullKeptNodes: hullDrop.keptNodes, hullDroppedPrimitives: hullDrop.droppedPrimitives,
      bytes: { world: world.worldBytes.byteLength, hull: hullBytes.byteLength, ...(ents && { entities: ents.bytes }) },
      gzBytes: { world: build.gzBytes['world.glb'], hull: build.gzBytes['hull.glb'], ...(ents && { entities: build.gzBytes['entities.glb'] }) },
      bake: bakeReport,
      ...(plan.skipped ? { bakeSkipped: plan.skipped } : {}),
      seconds, stages: build.stages, params: { ...PARAMS, drop: { ...PARAMS.drop, perMap: perMapParams(map) } },
    };
    build.write('shrink.json', JSON.stringify(report, null, 2) + '\n');

    // Optional outputs this run did not write (entities.glb on a map that lost its doors, a
    // bake now or tier V's lightmap) and retired ones (world_hd.glb) must not be served beside
    // it: installMapOutputs removes them.
    build.install();
    build.stage('done', `${path.relative(process.cwd(), P.out)}: world ${mb(world.worldBytes.byteLength)}, hull ${mb(hullBytes.byteLength)}${ents ? `, entities ${kb(ents.bytes)}` : ''}${bakeReport ? `, tier ${bakeReport.tier}, first load ${mb(bakeReport.firstLoadBytes)} of ${mb(bakeReport.firstLoadCap)}` : ''} in ${seconds}s`);
  } catch (e) {
    build.abort();
    if (process.env.DEBUG) console.error(e?.stack);
    fail(`${String(e?.message ?? e).split('\n')[0]} (DEBUG=1 for the stack)`);
  }
}

/**
 * The baked world (see the header): the lightmap, the light grid and the source light from the
 * raw document `doc` (after hidden, drop, pose, tint, lights and the doors' split), then
 * world.glb at tier H2, or tier V when H2 passes the map's first-load cap.
 * With `ents` (the doors and breakables split off, unstripped but for PARAMS.entities.strip)
 * their probe vertex light too, and entities.glb through `ship.entities` before the first load is
 * counted. `plan` is bakePlan's; `hull` the hull's walkable `floors` and its `bounds`, which place
 * the light grid; `ship.textures` ships world.glb's textures (main's shipTextures). Stages
 * lightmap.webp (H2 only), probes.bin and light.json in `build` beside the GLBs.
 * Returns the GLB bytes, the triangle count and shrink.json's `bake`.
 * @param {MapBuild} build
 */
async function bakeWorld(build, { doc, ents, plan, hull, ship }) {
  const { inputs, volumes, sun } = plan;
  const root = doc.getRoot();
  // The sun goes into the bake where CS2 baked it and it shines (Train's brightness is 0).
  const sunBaked = !!(sun?.baked && inputs.shadow);
  const bakedSun = sunBaked && sun.intensity > 0 ? sun : null;

  // A lightmap UV that lands at chance in debug_chart_color is a second material UV (D1).
  const chart = await readChart(inputs.chart);
  let chartRejects = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) if (!fitsCharts(chart, p) && dropLightmapUv(p)) chartRejects++;
  // Materials are final after this dedup: the source light is pooled by them.
  await doc.transform(dedup(), prune(PARAMS.bake.prune));
  build.stage('charts', `${chartRejects} lightmap UV(s) that miss the charts removed; dedup, prune`);

  // irradiance (+ the sun) → the 1024 px lightmap, and the 2048 px light vertex-lit primitives read.
  let hdr = await readHdr(inputs.irradiance);
  const fullSize = hdr.width;
  const sunTexels = bakedSun ? bakeSun(hdr, doc, await readShadow(inputs.shadow, sun.shadowChannel), bakedSun) : 0;
  let cov = coverage(doc, hdr.width, hdr.height);
  const lm = downscale(hdr, cov, hdr.width / LIGHTMAP_PARAMS.size);
  const range = chooseRange(lm.img, lm.covered);
  dilate(lm.img, lm.covered, LIGHTMAP_PARAMS.dilatePasses);
  const lightmapFile = await lightmapWebp(encodeLightmap(lm.img, range), lm.img.width, lm.img.height);
  const lightmapSize = [lm.img.width, lm.img.height];
  let sample = downscale(hdr, cov, hdr.width / LIGHT_PARAMS.sampleSize);
  dilate(sample.img, sample.covered, LIGHT_PARAMS.samplePadding);
  hdr = null; // 8192²: 0.8 GB of floats, and the coverage beside it
  cov = null;
  build.stage('lightmap', `${fullSize}² irradiance${bakedSun ? ` + the sun on ${sunTexels} texels` : sunBaked ? ' (the sun has no brightness)' : ' (the sun is dynamic: left out)'} → ${lightmapSize.join('×')} at range ${range}: ${lightmapFile.length} B; ${LIGHT_PARAMS.sampleSize}² for vertex light`);

  let atlas = await readProbeAtlas(build.paths.rawLightmaps, volumes);
  const grid = buildLightGrid(volumes, atlas, hull.bounds, GRID_STEP, hull.floors);
  const probesBin = encodeLightGrid(grid, range);
  build.write('probes.bin', probesBin);
  build.stage('grid', `${volumes.length} probe volumes (atlas ${atlas.width}×${atlas.height}×${atlas.depth}) → ${grid.size.join('×')} cells of ${GRID_STEP} m over the hull, ${grid.probed} above its floors: ${probesBin.length} B`);

  /**
   * Strips `d` to what a tier ships: every attribute but POSITION and TEXCOORD_0, then the lightmap
   * UV back as TEXCOORD_1 on the primitives in `kept`. With `dispose`, accessors left without a
   * primitive are disposed at once. Returns how many attributes went.
   */
  const strip = (d, kept, dispose) => {
    let stripped = 0;
    for (const mesh of d.getRoot().listMeshes()) {
      for (const p of mesh.listPrimitives()) {
        const uv = kept?.has(p) ? lightmapUv(p) : null;
        for (const s of p.listSemantics()) {
          if (s === 'POSITION' || s === 'TEXCOORD_0') continue;
          const acc = p.getAttribute(s);
          p.setAttribute(s, null);
          stripped++;
          if (dispose && acc !== uv && !acc.listParents().some((x) => x.propertyType !== PropertyType.ROOT)) acc.dispose();
        }
        if (uv) p.setAttribute('TEXCOORD_1', uv);
      }
    }
    return stripped;
  };

  // Light per source vertex, before anything is stripped; then H2's split.
  const ids = materialIds(doc);
  let atProbe = probeSampler(volumes, atlas, LIGHT_PARAMS.probeOffset);
  const probe = (p, n, out) => atProbe(p, n, bakedSun, out);
  const pool = sourceLight(doc, ids, { lightmap: sample.img, probe });
  // The doors and breakables move, so they ship no lightmap UV: every vertex takes the probes'
  // light (and the baked sun) at its spawn pose, as a world primitive without a lightmap UV does.
  // Materials are final after this dedup, as the world's are above.
  let entLight = null;
  if (ents) {
    await ents.doc.transform(dedup(), prune({ keepLeaves: true, keepAttributes: true }));
    const entIds = materialIds(ents.doc);
    entLight = { ids: entIds, pool: sourceLight(ents.doc, entIds, { lightmap: null, probe }) };
  }
  atProbe = atlas = sample = null; // the atlas in half precision: Mirage 57 MB, Nuke 146 MB, Cache ~0.85 GB
  const keep = new Set();
  const source = { chartRejects, lightmapped: 0, vertexLitFromLightmap: 0, vertexLitFromProbes: 0, vertices: pool.sources, cells: pool.cells.size };
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      if (!lightmapUv(p)) source.vertexLitFromProbes++;
      else if (keepsLightmapUv(p)) { keep.add(p); source.lightmapped++; } else source.vertexLitFromLightmap++;
    }
  }
  // Tier V, should H2 pass the cap, starts again from this copy (cloneDocument keeps material
  // order), stripped at once to what tier V ships and freed once H2's first load is known.
  let spare = cloneDocument(doc);
  const spareStripped = strip(spare, null, true);
  build.stage('source', `${pool.sources} source vertices in ${pool.cells.size} cells; H2 (≥ ${LIGHT_PARAMS.minTexelsPerVertex} texels/vertex): ${source.lightmapped} primitives keep the lightmap UV, ${source.vertexLitFromLightmap} vertex-lit from the lightmap, ${source.vertexLitFromProbes} from the probes`);

  // entities.glb: stripped as the world's other vertex-lit primitives are, welded, and lit from
  // its pool at the map's range; the same for H2 and tier V, so it is built once, here.
  if (ents) {
    const stripped = stripAttributes(ents.doc, PARAMS.strip);
    await ents.doc.transform(dedup(), prune({ keepLeaves: true }), weld());
    ents.tris = countTris(ents.doc);
    const vl = applyVertexLight(ents.doc, entLight.ids, entLight.pool, range);
    build.stage('ents-light', `${stripped} vertex attributes removed, dedup → prune → weld: ${ents.tris} tris; probe light from ${entLight.pool.sources} source vertices on ${vl.primitives} primitives, ${vl.vertices} vertices (${vl.hit} in their own cell, ${vl.neighbour} a neighbouring one, ${vl.otherMaterial} another material's, ${vl.fallback} their material's mean; ${vl.copiedMeshes} shared meshes copied)`);
    entLight = null;
    await ship.entities();
  }

  const sunJson = sun ? { ...sun, baked: sunBaked } : null;

  /**
   * One tier's lit geometry from document `d`; `kept` ships TEXCOORD_1 (null: tier V, from
   * `spare`, already stripped: `stripped` attributes): stripped, simplified and vertex-lit once,
   * its light.json (and H2's lightmap.webp) staged; walkTiers then ships its textures.
   */
  const lightTier = async (d, dIds, kept, suffix, stripped = strip(d, kept, false)) => {
    build.stage(`strip${suffix}`, `removed ${stripped} vertex attributes (all but POSITION and TEXCOORD_0)${kept ? `; ${kept.size} lightmap UVs back as TEXCOORD_1` : ''}`);
    // H2's prune keeps attributes: no material reads TEXCOORD_1, so a plain prune would drop it.
    const pruned = () => (kept ? prune(PARAMS.bake.prune) : prune());
    await d.transform(
      dedup(), pruned(), flatten(), join(), weld(),
      simplify({ simplifier: MeshoptSimplifier, ...PARAMS.simplify }),
    );
    const tris = countTris(d);
    // A lightmap UV simplify tore off its charts is not shipped: that primitive is vertex-lit.
    let lightmapped = 0, vertexLit = 0, chartDemotions = 0;
    for (const mesh of d.getRoot().listMeshes()) {
      for (const p of mesh.listPrimitives()) {
        if (p.getAttribute('TEXCOORD_1') && !fitsCharts(chart, p)) { p.setAttribute('TEXCOORD_1', null); chartDemotions++; }
        if (p.getAttribute('TEXCOORD_1')) lightmapped++;
        else vertexLit++;
      }
    }
    build.stage(`geometry${suffix}`, `${PARAMS.geometry.join(' → ')}: ${tris} tris, ${d.getRoot().listMeshes().length} meshes; ${lightmapped} primitives with TEXCOORD_1, ${vertexLit} without (${chartDemotions} whose lightmap UV left the charts)`);
    const vertexLight = applyVertexLight(d, dIds, pool, range);
    build.stage(`vlight${suffix}`, `COLOR_0 on ${vertexLight.primitives} primitives, ${vertexLight.vertices} vertices: ${vertexLight.hit} in their own cell, ${vertexLight.neighbour} a neighbouring one, ${vertexLight.otherMaterial} another material's, ${vertexLight.fallback} their material's mean; ${vertexLight.copiedMeshes} shared meshes copied`);
    const meshoptOptions = { encoder: MeshoptEncoder, ...PARAMS.meshopt, ...(kept ? { quantizeTexcoord: PARAMS.bake.quantizeTexcoord } : {}) };
    const light = lightJson({ range, lightmapSize: kept ? lightmapSize : null, sun: sunJson });
    build.write('light.json', `${JSON.stringify(light, null, 2)}\n`);
    if (kept) build.write('lightmap.webp', lightmapFile);
    else build.unwrite('lightmap.webp');
    return { d, suffix, pruned, meshoptOptions, tris, lightmapped, vertexLit, chartDemotions, vertexLight, light };
  };

  // TIER_LADDER in its written order: each tier's lit geometry once, its textures at each size,
  // until the first load fits the map's cap (check-map.mjs holds the finished map to the same).
  const cap = budgetFor(build.map, true).firstLoadBytes;
  const { tier: name, shipped, fallback } = await walkTiers(build, {
    cap,
    light: async (tier) => {
      if (tier !== 'V') return lightTier(doc, ids, keep, '', undefined);
      const v = spare;
      spare = null;
      return lightTier(v, materialIds(v), null, '_v', spareStripped);
    },
    textures: ship.textures,
  });
  spare = null;
  const report = {
    tier: name,
    fallback,
    range,
    sun: sunJson ? shipped.light.sun : null,
    lightmapSize: shipped.light.lightmap ? lightmapSize : null,
    lightmapBytes: shipped.light.lightmap ? lightmapFile.length : 0,
    worldTextureSize: shipped.worldSize,
    gridSize: grid.size,
    gridStep: GRID_STEP,
    gridProbed: grid.probed,
    gridBytes: probesBin.length,
    lightmappedPrimitives: shipped.lightmapped,
    vertexLitPrimitives: shipped.vertexLit,
    chartDemotions: shipped.chartDemotions,
    source,
    vertexLight: shipped.vertexLight,
    firstLoadBytes: shipped.firstLoad,
    firstLoadCap: cap,
  };
  return { world: shipped.glbs, trisOut: shipped.tris, report };
}

/**
 * Walks `runs` (lib/light.mjs ladderRuns of TIER_LADDER, in its written order; walkLadder) for a
 * baked map until its first load fits `cap`: `light(tier)` builds a tier's lit geometry once and
 * stages its light.json (and H2's lightmap.webp), answering `{ d, suffix, pruned, meshoptOptions,
 * light, … }`; then each of the tier's sizes ships world.glb through
 * `textures(d, finish, suffix, size)` (main's shipTextures; a copy of the lit document while the
 * tier has a smaller size left to try, so that one starts again from the untextured world), the
 * world and the bake are gzipped, and the first load is counted: this run's world, entities.glb
 * and bake as staged, plus the radars, overview and sky already in <out> (build-assets.sh runs
 * radar.mjs and sky.mjs, which read raw inputs only, before shrink-map.mjs, so they are this
 * build's). Returns the tier that ships, what it shipped (`light`'s answer with `firstLoad`,
 * `worldSize` and `glbs`), every try, and shrink.json's `fallback`: null when the first try
 * fitted, else which tiers and sizes were over the cap and which fits, or, past the last, that
 * check-map.mjs will fail the map.
 * @param {MapBuild} build
 */
export async function walkTiers(build, { cap, light, textures, runs = ladderRuns() }) {
  const own = ['world.glb', ...MAP_OPTIONAL_GLBS, ...MAP_BAKE_FILES];
  const others = firstLoadBytes(build.out, MAP_FIRST_LOAD.filter((f) => !own.includes(f)));
  const tried = (tries) => tries.map((a) => `${a.firstLoad} B at ${a.size ?? PARAMS.world.size} px`).join(', ');
  const overOf = (tier, tries) => `${tier}'s first load (${tried(tries.filter((a) => a.tier === tier))}) is over the cap ${cap} B`;
  const shipSize = async (t, size, rest) => {
    const worldSize = size ?? PARAMS.world.size;
    const sfx = size === null ? t.suffix : `${t.suffix}_${size}`;
    const glbs = await textures(rest.length ? cloneDocument(t.d) : t.d, () => [t.pruned(), meshopt(t.meshoptOptions)], sfx, worldSize);
    build.gzip(['world.glb', 'light.json', 'probes.bin']);
    const firstLoad = build.firstLoad(own) + others;
    build.stage(`firstload${sfx}`, `${mb(firstLoad)} of ${mb(cap)} (${build.map} before M2a + ${mb(cap - FIRST_LOAD_BEFORE_M2A[build.map])}), world.glb textures ${worldSize} px`);
    if (firstLoad > cap && rest.length) {
      build.log(`           the first load at ${worldSize} px, ${firstLoad} B, is over the cap ${cap} B: world.glb's textures at ${rest[0] ?? PARAMS.world.size} px`);
    }
    return { firstLoad, worldSize, glbs };
  };
  const walked = await walkLadder(runs, cap, {
    light: async (tier, tries) => {
      if (tries.length) build.log(`           ${overOf(tries[tries.length - 1].tier, tries)}: tier ${tier}${tier === 'V' ? ' (vertex light only, no lightmap)' : ''}`);
      return light(tier);
    },
    ship: shipSize,
  });
  const name = walked.tier;
  const shipped = { ...walked.lit, ...walked.shipped };
  const fits = shipped.firstLoad <= cap;
  const tiers = [...new Set(walked.tries.map((a) => a.tier))];
  const over = (fits ? tiers.slice(0, -1) : tiers).map((tier) => overOf(tier, walked.tries));
  // Null when the first try fitted, as before the ladder grew.
  let fallback = null;
  if (!fits) {
    fallback = `${over.join('; ')}: check-map.mjs will fail the map`;
    build.log(`           ${fallback}`);
  } else if (over.length || walked.tries.filter((a) => a.tier === name).length > 1) {
    fallback = [...over, `${name}'s fits (${tried(walked.tries.filter((a) => a.tier === name))})`].join('; ');
  }
  return { tier: name, shipped, tries: walked.tries, fallback };
}

if (isMain(import.meta.url)) await main();
