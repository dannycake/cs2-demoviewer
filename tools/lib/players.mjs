// Player models: which agents are ripped, which animation clips are requested,
// and how a raw VRF agent export is cut down to the third-person model the viewer
// draws. rip-players.sh reads PLAYER_MODELS and CLIPS_REQUESTED from here.
import path from 'node:path';
import { assetsDir } from './paths.mjs';

/** VRF model paths inside pak01_dir.vpk, per side. */
export const PLAYER_MODELS = Object.freeze({
  ct: 'agents/models/ctm_sas/ctm_sas.vmdl_c',
  t: 'agents/models/tm_phoenix/tm_phoenix.vmdl_c',
});

export const SIDES = Object.freeze(Object.keys(PLAYER_MODELS));

const DIR8 = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const DIR4 = ['n', 'e', 's', 'w'];
const dirs = (prefix, list, suffix) => list.map((d) => `${prefix}_${d}_${suffix}`);

/**
 * Per-weapon clip name suffixes: the viewer's normalised weapon name → the suffix VRF
 * uses in `idle_<s> reload_<s> draw_<s> shoot_<s>` (phase 3c animation plan). Where a
 * weapon's shoot clip breaks the pattern it is listed under `shoot`.
 */
export const WEAPON_CLIP_SUFFIX = Object.freeze({
  ak47: 'ak', m4a4: 'm4a4', m4a1s: 'm4a1s', awp: 'awp', famas: 'famas', galilar: 'galilar', aug: 'aug',
  sg556: 'sg556', ssg08: 'ssg08', scar20: 'scar20', g3sg1: 'g3sg1', mp9: 'mp9', mac10: 'mac10', mp7: 'mp7',
  mp5sd: 'mp5sd', ump45: 'ump45', p90: 'p90', bizon: 'bizon', nova: 'nova', xm1014: 'xm1014', mag7: 'mag7',
  sawedoff: 'sawedoff', m249: 'm249', negev: 'negev', glock: 'glock', usp: 'usp', hkp2000: 'hkp', p250: 'p250',
  fiveseven: 'fiveseven', tec9: 'tec9', cz75a: 'cz75a', deagle: 'deagle', elite: 'elite', revolver: 'revolver',
  taser: 'taser',
});
/** Shoot clips that do not follow `shoot_<suffix>`. */
export const WEAPON_SHOOT_CLIP = Object.freeze({ cz75a: 'shoot_cz75', elite: 'shoot_right1_elite' });
/** Weapons VRF ships no reload clip for. */
const NO_RELOAD = new Set(['aug', 'taser']);

/**
 * The allow list of third-person clips a player GLB carries, by family (phase 3c
 * animation plan, Global Constraints). Exact VRF short names; rip-players.sh asks
 * for all of them and shrink-player.mjs keeps whatever VRF matched.
 */
export const CLIP_SET = Object.freeze({
  rifle: Object.freeze([
    'idle_rifle', 'idle_crouch_rifle',
    ...dirs('run', DIR8, 'rifle'), ...dirs('walk', DIR8, 'rifle'), ...dirs('crouch', DIR4, 'rifle'),
    'inair_stand_rifle', 'inair_crouch_stand_rifle', 'jump_stand_rifle',
    'turn_left_loop_45_rifle', 'turn_right_loop_45_rifle', 'turn_left_loop_90_rifle', 'turn_right_loop_90_rifle',
    'ladder_facing_fast_rifle', 'ladder_facing_crouch_rifle',
    'shoot_rifle',
  ]),
  pistol: Object.freeze([
    'idle_pistol', 'idle_crouch_pistol',
    ...dirs('run', DIR8, 'pistol'), ...dirs('walk', DIR4, 'pistol'), 'crouch_n_pistol', 'crouch_s_pistol',
    'inair_stand_pistol', 'jump_stand_pistol',
  ]),
  // inair_stand_knife is what sim/locomotion.ts plays for a knife in the air. CS2 build 2000935
  // ships it (animation/anims/world/knife/_default_knife/ in pak01_dir.vpk), but the players
  // were ripped before it was asked for, so no GLB carries it until the next players rip. Like
  // every clip outside CLIPS_REQUIRED, a rip where VRF does not match it still builds and passes
  // check-players, which lists it among the optional clips absent.
  knife: Object.freeze([
    'idle_knife', 'idle_crouch_knife',
    ...dirs('run', DIR4, 'knife'), 'walk_n_knife', 'walk_s_knife', 'crouch_n_knife',
    'inair_stand_knife',
    'frontswing_knife', 'backstab_knife',
  ]),
  weapon: Object.freeze(Object.entries(WEAPON_CLIP_SUFFIX).flatMap(([w, s]) => [
    `idle_${s}`, `draw_${s}`, WEAPON_SHOOT_CLIP[w] ?? `shoot_${s}`, ...(NO_RELOAD.has(w) ? [] : [`reload_${s}`]),
  ])),
  grenade: Object.freeze([
    'idle_grenade', 'pullpin_grenade', 'throw_overhand_grenade', 'throw_underhand_grenade', 'idle_molotov', 'pullpin_molotov',
  ]),
  c4: Object.freeze(['idle_c4', 'planting', 'planting_crouch']),
  shared: Object.freeze([
    'defuse_enter_rifle', 'defuse_loop_rifle', 'defuse_crouch_enter_rifle', 'defuse_crouch_loop_rifle',
    'flashed', 'flashed_crouch', 'jump_additive_start_rifle', 'jump_additive_land_rifle', 'breathing',
    'flinch_head', 'flinch_chest', 'flinch_stomach', 'flinch_arm_left', 'flinch_arm_right', 'flinch_leg_left', 'flinch_leg_right',
    'flinch_head_rear', 'flinch_chest_rear', 'flinch_stomach_rear',
    'flinch_head_left', 'flinch_head_right', 'flinch_chest_left', 'flinch_chest_right',
    'flinch_molotov',
  ]),
});

/** Clips a player GLB must carry (short names); the rest of CLIP_SET is kept when VRF finds it. */
export const CLIPS_REQUIRED = Object.freeze([
  'idle_rifle', 'run_n_rifle', 'walk_n_rifle', 'crouch_n_rifle', 'idle_crouch_rifle', 'inair_stand_rifle',
  'run_s_rifle', 'run_e_rifle', 'run_w_rifle', 'flashed', 'idle_pistol', 'run_n_pistol', 'idle_knife',
]);
/** The `--gltf_animation_list` rip-players.sh passes: every CLIP_SET name once, required ones first. */
export const CLIPS_REQUESTED = Object.freeze([...new Set([...CLIPS_REQUIRED, ...Object.values(CLIP_SET).flat()])]);
/** Requested clips the build tolerates missing (`shoot_rifle` is unmatched on CS2 build 2000934). */
export const CLIPS_OPTIONAL = Object.freeze(CLIPS_REQUESTED.filter((c) => !CLIPS_REQUIRED.includes(c)));

/**
 * VRF names clips by resource path; the third-person ones live under this prefix.
 * The same filter also matches `animation/anims/viewmodel/...` (first-person arms
 * and weapon), which is dropped.
 */
export const WORLD_CLIP_PREFIX = 'animation/anims/world/';

/**
 * Nodes removed with their whole subtree: the weapon skeleton VRF adds for the
 * rifle clips (`animation/skeletons/weapons/m4a1_silencer.vnmskel` and its
 * `.empty_mesh_reference` placeholder mesh, which carries a second, 9-joint skin)
 * and the first-person mesh groups (`<model>.vmdl_c.firstperson_default_gloves_arms`,
 * `.firstperson_sleeves`), which the game draws only in the viewmodel.
 */
export const PLAYER_DROP_NODE = /(^animation\/skeletons\/|\.firstperson_)/;

/** Last path segment of a clip name: `animation/anims/world/rifle/_default_rifle/idle_rifle` → `idle_rifle`. */
export function clipBase(name) {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** Short names of the document's third-person clips (sorted). */
export function worldClipBases(doc) {
  return doc.getRoot().listAnimations()
    .map((a) => a.getName())
    .filter((n) => n.startsWith(WORLD_CLIP_PREFIX))
    .map(clipBase)
    .sort();
}

/**
 * Cuts a raw agent export down to the third-person model, in place: drops the
 * PLAYER_DROP_NODE subtrees and every clip outside WORLD_CLIP_PREFIX, strips the
 * channels of kept clips that animate a dropped node (the weapon skeletons VRF adds
 * for weapon clips; the viewer parents its own weapon model to the `wpn` bone), and
 * renames the remaining clips to their short names. A clip left with no channel is
 * dropped. Throws when two kept clips share a short name. Unused meshes, skins,
 * materials and textures are left for prune().
 * @returns {{ droppedNodes: number, droppedClips: string[], clips: string[], strippedChannels: number }}
 */
/**
 * Disposes a clip with its channels and samplers. `Animation.dispose()` alone only
 * unlinks them: the samplers stay alive on the root, keep their accessors referenced,
 * and prune() then leaves megabytes of dropped keyframes in the file (seen 2026-10-22:
 * 13.6 MB of orphans in a 24 MB player GLB).
 */
export function disposeClip(anim) {
  for (const ch of anim.listChannels()) ch.dispose();
  for (const s of anim.listSamplers()) s.dispose();
  anim.dispose();
}

/** Removes a channel; its sampler goes with it unless another channel still uses it. */
function disposeChannel(ch) {
  const sampler = ch.getSampler();
  ch.dispose();
  if (sampler && sampler.listParents().every((p) => p.propertyType !== 'AnimationChannel')) sampler.dispose();
}

/** Samplers alive on the root but attached to no animation (should be none). */
export function orphanSamplers(doc) {
  const attached = new Set();
  for (const a of doc.getRoot().listAnimations()) for (const s of a.listSamplers()) attached.add(s);
  const orphans = new Set();
  for (const acc of doc.getRoot().listAccessors()) {
    for (const p of acc.listParents()) if (p.propertyType === 'AnimationSampler' && !attached.has(p)) orphans.add(p);
  }
  return [...orphans];
}

export function selectThirdPerson(doc) {
  const root = doc.getRoot();

  const doomed = new Set();
  const mark = (node) => { doomed.add(node); for (const c of node.listChildren()) mark(c); };
  for (const node of root.listNodes()) if (PLAYER_DROP_NODE.test(node.getName())) mark(node);

  const droppedClips = [];
  const seen = new Set();
  let strippedChannels = 0;
  for (const anim of root.listAnimations()) {
    const name = anim.getName();
    if (!name.startsWith(WORLD_CLIP_PREFIX)) {
      droppedClips.push(name);
      disposeClip(anim);
      continue;
    }
    const base = clipBase(name);
    if (seen.has(base)) throw new Error(`two third-person clips are both named '${base}'`);
    for (const ch of anim.listChannels()) {
      if (!doomed.has(ch.getTargetNode())) continue;
      disposeChannel(ch);
      strippedChannels++;
    }
    if (anim.listChannels().length === 0) {
      droppedClips.push(name);
      disposeClip(anim);
      continue;
    }
    seen.add(base);
    anim.setName(base);
  }

  for (const node of doomed) node.dispose();
  return { droppedNodes: doomed.size, droppedClips: droppedClips.sort(), clips: [...seen].sort(), strippedChannels };
}

/**
 * Bones whose translation channels carry motion the viewer needs: root motion, the hips, and
 * the weapon attachment (`wpnPivot` hangs off the root and is placed by translation each clip;
 * `wpn` below it; without them a held weapon sits at the player's feet).
 */
export const TRANSLATED_BONES = Object.freeze(['root_motion', 'pelvis', 'wpnPivot', 'wpn']);

/**
 * Drops every scale channel and the translation channels of bones outside
 * TRANSLATED_BONES, in place: VRF exports rotation, translation and scale for all 94
 * joints of every clip, but only rotations move the skeleton (bone lengths and
 * scale are constant). Measured 2026-10-22 on the CT model with 231 clips: 31.9 MB
 * → 6.4 MB raw, 7.1 MB → 1.9 MB gzipped (with resample 3e-3). Samplers left without
 * a channel are disposed.
 * @returns {number} channels removed
 */
export function stripBoneChannels(doc) {
  let stripped = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const p = ch.getTargetPath();
      const name = ch.getTargetNode()?.getName() ?? '';
      if (p !== 'scale' && !(p === 'translation' && !TRANSLATED_BONES.includes(name))) continue;
      disposeChannel(ch);
      stripped++;
    }
  }
  return stripped;
}

/**
 * Where the player artefacts live under ASSETS_DIR (read on every call).
 * @param {'ct'|'t'} side
 */
export function playerPaths(side) {
  if (!SIDES.includes(side)) throw new Error(`side must be one of ${SIDES.join(', ')} (got ${JSON.stringify(side)})`);
  const root = assetsDir();
  const out = path.join(root, 'players');
  const raw = path.join(root, 'raw', 'players');
  return {
    raw,
    ripJson: path.join(raw, 'rip.json'),
    out,
    glb: path.join(out, `${side}.glb`),
    /** Precompressed sibling the server sends as `Content-Encoding: gzip`. */
    gz: path.join(out, `${side}.glb.gz`),
    shrinkJson: path.join(out, `${side}.shrink.json`),
  };
}
