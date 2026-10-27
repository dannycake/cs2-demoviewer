// Viewmodels: what the viewer draws in first person. One arms model per team (the agent's
// `firstperson_*` meshes re-skinned onto CS2's viewmodel skeleton) and one clip file per weapon
// (that weapon's viewmodel clips on the same skeleton). The clips are authored on
// `animation/skeletons/characters/viewmodel.vnmskel`, whose arms hang from `root_motion` (the
// eye) through `armUpperShoulder_*`, not on the agents' world skeleton, so they are exported
// clip by clip (rip-viewmodels.sh) and the arms are moved onto that skeleton by name.
import fs from 'node:fs';
import path from 'node:path';
import { assetsDir } from './paths.mjs';
import { WEAPON_NAMES } from './weapons.mjs';

/** Where the clips live inside pak01_dir.vpk. */
export const CLIP_ROOT = 'animation/anims/viewmodel/';
/** The node VRF names after the viewmodel skeleton, the parent of `root_motion`. */
export const VIEWMODEL_SKELETON = 'animation/skeletons/characters/viewmodel.vnmskel';
/** A weapon skeleton VRF adds beside it (`animation/skeletons/weapons/<w>.vnmskel`). */
export const WEAPON_SKELETON = /^animation\/skeletons\/weapons\/[^/]+\.vnmskel$/;
/** The root node of every output: the skeleton's bones hang below it, `root_motion` first. */
export const RIG_ROOT = 'viewmodel';

/**
 * The clip folder (under CLIP_ROOT) each weapon model animates with, keyed like WEAPON_MODELS.
 * The M4A1-S, the USP-S and the decoy have no folder of their own and use the family default,
 * as the game does; the two default knives have one each.
 */
export const VIEWMODEL_DIRS = Object.freeze({
  ak47: 'rifle/rifle_ak',
  aug: 'rifle/rifle_aug',
  awp: 'rifle/rifle_awp',
  bizon: 'rifle/rifle_bizon',
  c4: 'equipment/c4',
  cz75a: 'pistol/pistol_cz75a',
  deagle: 'pistol/pistol_deagle',
  decoy: 'grenade/_default_grenade',
  elite: 'pistol/pistol_elite',
  famas: 'rifle/rifle_famas',
  fiveseven: 'pistol/pistol_fiveseven',
  flashbang: 'grenade/grenade_flashbang',
  g3sg1: 'rifle/rifle_g3sg1',
  galilar: 'rifle/rifle_galilar',
  glock: 'pistol/pistol_glock18',
  healthshot: 'equipment/healthshot',
  hegrenade: 'grenade/grenade_hegrenade',
  hkp2000: 'pistol/pistol_hkp2000',
  incendiary: 'grenade/grenade_incendiary',
  knife: 'knife/_default_knife',
  knife_t: 'knife/knife_default_t',
  m249: 'rifle/rifle_m249',
  m4a1s: 'rifle/_default_rifle',
  m4a4: 'rifle/rifle_m4a4',
  mac10: 'rifle/rifle_mac10',
  mag7: 'rifle/rifle_mag7',
  molotov: 'grenade/grenade_molotov',
  mp5sd: 'rifle/rifle_mp5sd',
  mp7: 'rifle/rifle_mp7',
  mp9: 'rifle/rifle_mp9',
  negev: 'rifle/rifle_negev',
  nova: 'rifle/rifle_nova',
  p250: 'pistol/pistol_p250',
  p90: 'rifle/rifle_p90',
  revolver: 'pistol/pistol_revolver',
  sawedoff: 'rifle/rifle_sawedoff',
  scar20: 'rifle/rifle_scar20',
  sg556: 'rifle/rifle_sg556',
  smokegrenade: 'grenade/grenade_smokegrenade',
  ssg08: 'rifle/rifle_ssg08',
  taser: 'pistol/pistol_taser',
  tec9: 'pistol/pistol_tec9',
  ump45: 'rifle/rifle_ump45',
  usp: 'pistol/_default_pistol',
  xm1014: 'rifle/rifle_xm1014',
});

/** The folders to export, sorted, each once. */
export const VIEWMODEL_DIR_LIST = Object.freeze([...new Set(Object.values(VIEWMODEL_DIRS))].sort());

/**
 * The clips a weapon file holds, by the name the viewer asks for, and where each comes from:
 * candidates in order, `<s>` standing for the folder's clip suffix (`clipSuffix`). `shoot` is a
 * gun's first shot, the knife's light swing (`light_miss1`) and the right pistol of the Dual
 * Berettas; `shoot_left` their left one. A kind the folder has no clip for is left out.
 */
export const CLIP_KINDS = Object.freeze({
  idle: ['idle_<s>', 'idle1_<s>'],
  draw: ['draw_<s>'],
  shoot: ['shoot1_<s>', 'shoot_right1_<s>', 'light_miss1_<s>'],
  shoot_left: ['shoot_left1_<s>'],
  reload: ['reload_<s>'],
  pullpin: ['pullpin_<s>'],
  throw: ['throw_overhand_<s>'],
  throw_underhand: ['throw_underhand_<s>'],
  plant: ['plant_<s>'],
});

/** Every file must have these. */
export const REQUIRED_KINDS = Object.freeze(['idle', 'draw']);

/** Per-weapon picks that differ from CLIP_KINDS: the USP-S draws with its silencer on. */
export const CLIP_OVERRIDES = Object.freeze({
  usp: Object.freeze({ draw: 'draw_silenced_pistol' }),
});

/**
 * Bones of the viewmodel skeleton the viewer never needs: the IK targets on the weapon
 * (`wpnHand_*`, `wpnTip`, `wpnEnd`) and in the hands (`attachHand_*`). Dropped with their
 * channels; nothing is skinned to them.
 */
export const HELPER_BONE = /^(wpnHand_|attachHand_|wpnTip$|wpnEnd$)/;

/**
 * Weapon-skeleton bones whose channels a weapon's file keeps, hung under `wpn` (the weapon
 * skeleton's root, `weapon`, sits exactly on `wpn` in every clip): the two weapons whose clips
 * leave `wpn` at the eye and carry the model's parts to the hands on these bones, the Dual
 * Berettas' pistols and the molotov's bottle and lighter. Every other weapon bone (bolts,
 * magazines) moves parts of a skinned viewmodel the viewer does not have.
 */
export const WEAPON_BONES_KEPT = Object.freeze({
  elite: Object.freeze(['weapon_hand_l', 'weapon_hand_r']),
  molotov: Object.freeze(['weapon_hand_l', 'weapon_hand_r']),
});

/**
 * The weapons a typical match shows, whose clip files with both arms make up the download
 * budget check-viewmodels.mjs holds (`BUDGET.typicalGzBytes`).
 */
export const TYPICAL_MATCH = Object.freeze([
  'ak47', 'm4a1s', 'm4a4', 'awp', 'galilar', 'famas', 'mac10', 'mp9',
  'glock', 'usp', 'hkp2000', 'p250', 'deagle', 'tec9', 'fiveseven',
  'knife', 'knife_t', 'hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incendiary', 'c4',
]);

/**
 * A folder's clip suffix: what follows `draw_` in its shortest `draw_*` clip (`draw_ak` → `ak`,
 * `draw_pistol` rather than `draw_silenced_pistol`, `draw_default_t`). Null without one.
 * @param {string[]} names  the folder's clip names (file names without `.glb`)
 */
export function clipSuffix(names) {
  const draws = names.filter((n) => /^draw_./.test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b));
  return draws.length ? draws[0].slice('draw_'.length) : null;
}

/**
 * The clips weapon `name` takes from its folder: kind → source clip name, in CLIP_KINDS order.
 * Throws naming the weapon when a REQUIRED_KINDS clip is missing.
 * @param {string} name   a VIEWMODEL_DIRS key
 * @param {string[]} names  the folder's clip names
 * @returns {Record<string, string>}
 */
export function selectClips(name, names) {
  const have = new Set(names);
  const s = clipSuffix(names);
  const out = {};
  if (s !== null) {
    for (const [kind, candidates] of Object.entries(CLIP_KINDS)) {
      const override = CLIP_OVERRIDES[name]?.[kind];
      const pick = override !== undefined ? (have.has(override) ? override : null) : candidates.map((c) => c.replace('<s>', s)).find((c) => have.has(c));
      if (pick) out[kind] = pick;
    }
  }
  const missing = REQUIRED_KINDS.filter((k) => !out[k]);
  if (missing.length) throw new Error(`${name}: no ${missing.join(' or ')} clip in ${VIEWMODEL_DIRS[name] ?? '?'} (${names.length} clips)`);
  return out;
}

/** True when a track's values all equal the node's rest value within `eps` (k values per key). */
export function trackAtRest(values, rest, eps = 1e-5) {
  const k = rest.length;
  for (let i = 0; i < values.length; i++) if (Math.abs(values[i] - rest[i % k]) > eps) return false;
  return true;
}

/** The node VRF names after the viewmodel skeleton in a clip export, or null. */
export function findViewmodelSkeleton(doc) {
  return doc.getRoot().listNodes().find((n) => n.getName() === VIEWMODEL_SKELETON) ?? null;
}

/** The weapon skeleton's root in a clip export, or null. */
export function findWeaponSkeleton(doc) {
  return doc.getRoot().listNodes().find((n) => WEAPON_SKELETON.test(n.getName())) ?? null;
}

/** True when `node` is `ancestor` or below it. */
function isUnder(node, ancestor) {
  for (let n = node; n; n = n.listParents().find((p) => p.propertyType === 'Node') ?? null) if (n === ancestor) return true;
  return false;
}

/**
 * Copies the viewmodel skeleton of clip export `src` into `doc`: a new RIG_ROOT node in the
 * scene, the skeleton's bones below it with their rest poses, HELPER_BONE bones (and anything
 * under them) left out, then every `weaponBones` bone of the weapon skeleton under `wpn` with
 * its own rest pose (its parent in the export is the weapon root, which sits on `wpn`).
 * @returns {{ root: import('@gltf-transform/core').Node, bones: Map<string, import('@gltf-transform/core').Node> }}
 */
export function copySkeleton(doc, src, weaponBones = []) {
  const from = findViewmodelSkeleton(src);
  if (!from) throw new Error(`the export has no ${VIEWMODEL_SKELETON}`);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0] ?? doc.createScene();
  const root = doc.createNode(RIG_ROOT);
  scene.addChild(root);
  const bones = new Map();
  const copy = (s, parent) => {
    if (HELPER_BONE.test(s.getName())) return;
    if (bones.has(s.getName())) throw new Error(`the viewmodel skeleton names ${s.getName()} twice`);
    const n = doc.createNode(s.getName()).setTranslation(s.getTranslation()).setRotation(s.getRotation()).setScale(s.getScale());
    bones.set(s.getName(), n);
    parent.addChild(n);
    for (const c of s.listChildren()) copy(c, n);
  };
  for (const c of from.listChildren()) copy(c, root);
  if (!bones.has('root_motion') || !bones.has('wpn')) throw new Error('the viewmodel skeleton has no root_motion or wpn');
  if (weaponBones.length) {
    const wroot = findWeaponSkeleton(src);
    const wnodes = wroot ? src.getRoot().listNodes().filter((n) => isUnder(n, wroot)) : [];
    for (const name of weaponBones) {
      const s = wnodes.find((n) => n.getName() === name);
      if (!s) throw new Error(`the weapon skeleton has no ${name}`);
      if (bones.has(name)) throw new Error(`${name} is in both skeletons`);
      const n = doc.createNode(name).setTranslation(s.getTranslation()).setRotation(s.getRotation()).setScale(s.getScale());
      bones.get('wpn').addChild(n);
      bones.set(name, n);
    }
  }
  return { root, bones };
}

/**
 * Copies one clip export's channels into `doc` as animation `name`, onto `bones` (from
 * `copySkeleton`): a viewmodel-skeleton channel goes to its namesake, a weapon-skeleton channel
 * only when its bone is in `weaponBones`; a channel whose bone is not in `bones` (a helper),
 * and one that never leaves the bone's rest pose, is left out.
 * @returns {{ anim: import('@gltf-transform/core').Animation, kept: number, atRest: number, skipped: number, seconds: number }}
 */
export function copyClip(doc, bones, src, name, weaponBones = []) {
  const vm = findViewmodelSkeleton(src);
  const wroot = findWeaponSkeleton(src);
  const anim = doc.createAnimation(name);
  let kept = 0;
  let atRest = 0;
  let skipped = 0;
  let seconds = 0;
  for (const sa of src.getRoot().listAnimations()) {
    for (const ch of sa.listChannels()) {
      const node = ch.getTargetNode();
      if (!node) continue;
      const bone = node.getName();
      const inVm = vm && isUnder(node, vm);
      const inWeapon = !inVm && wroot && isUnder(node, wroot) && weaponBones.includes(bone);
      const target = inVm || inWeapon ? bones.get(bone) : undefined;
      const s = ch.getSampler();
      const times = s.getInput().getArray();
      seconds = Math.max(seconds, times[times.length - 1] ?? 0);
      if (!target) {
        skipped++;
        continue;
      }
      const p = ch.getTargetPath();
      const rest = p === 'translation' ? target.getTranslation() : p === 'rotation' ? target.getRotation() : p === 'scale' ? target.getScale() : null;
      const values = s.getOutput().getArray();
      if (!rest || trackAtRest(values, rest)) {
        atRest++;
        continue;
      }
      const input = doc.createAccessor().setType('SCALAR').setArray(times.slice());
      const output = doc.createAccessor().setType(s.getOutput().getType()).setArray(values.slice());
      const smp = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(s.getInterpolation());
      anim.addSampler(smp).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(p).setSampler(smp));
      kept++;
    }
  }
  return { anim, kept, atRest, skipped, seconds };
}

/** The clip names (file names without `.glb`) in a ripped folder, sorted. */
export function listClips(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)).sort();
}

const NAME = /^[a-z0-9_]+$/;
const SIDE = /^(ct|t)$/;

/**
 * Where the viewmodel artefacts live under ASSETS_DIR (read on every call).
 * @param {string} [name]  a VIEWMODEL_DIRS key; omit for the shared paths only
 */
export function viewmodelPaths(name) {
  if (name !== undefined && !(name in VIEWMODEL_DIRS)) {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`invalid weapon name: ${JSON.stringify(name)}`);
    throw new Error(`unknown weapon '${name}' (not in VIEWMODEL_DIRS)`);
  }
  const root = assetsDir();
  const out = path.join(root, 'viewmodels');
  const raw = path.join(root, 'raw', 'viewmodels');
  const p = { raw, ripJson: path.join(raw, 'rip.json'), out, manifest: path.join(out, 'manifest.json') };
  if (name !== undefined) {
    p.dir = path.join(raw, VIEWMODEL_DIRS[name]);
    p.glb = path.join(out, `${name}.glb`);
    p.gz = path.join(out, `${name}.glb.gz`);
    p.shrinkJson = path.join(out, `${name}.shrink.json`);
  }
  return p;
}

/** The arms files of one side (`ct`/`t`) under ASSETS_DIR. */
export function armsPaths(side) {
  if (typeof side !== 'string' || !SIDE.test(side)) throw new Error(`side must be ct or t (got ${JSON.stringify(side)})`);
  const out = viewmodelPaths().out;
  return {
    out,
    glb: path.join(out, `arms_${side}.glb`),
    gz: path.join(out, `arms_${side}.glb.gz`),
    shrinkJson: path.join(out, `arms_${side}.shrink.json`),
  };
}

/** Every weapon of WEAPON_MODELS has a folder, and nothing else does. */
export function dirsCoverWeapons() {
  const keys = Object.keys(VIEWMODEL_DIRS).sort();
  return keys.length === WEAPON_NAMES.length && keys.every((k, i) => k === WEAPON_NAMES[i]);
}
