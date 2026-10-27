// Weapon models: which world models are ripped (keyed by the viewer's normalised
// weapon name, see the phase 3c animation plan), how a raw VRF export is cut down
// to the one mesh group the viewer draws in a player's hand, and where the files
// live. Besides the weapons a player holds, GROUND_MODELS lists the items only ever
// seen lying in the world (the defuse kit). rip-weapons.sh reads MODEL_PATHS from here.
import path from 'node:path';
import { MathUtils } from '@gltf-transform/core';
import { assetsDir } from './paths.mjs';
import { disposeClip } from './players.mjs';

/** VRF model paths inside pak01_dir.vpk, by normalised weapon name. */
export const WEAPON_MODELS = Object.freeze({
  ak47: 'weapons/models/ak47/weapon_rif_ak47.vmdl_c',
  aug: 'weapons/models/aug/weapon_rif_aug.vmdl_c',
  awp: 'weapons/models/awp/weapon_snip_awp.vmdl_c',
  bizon: 'weapons/models/bizon/weapon_smg_bizon.vmdl_c',
  c4: 'weapons/models/c4/weapon_c4.vmdl_c',
  cz75a: 'weapons/models/cz75a/weapon_pist_cz75a.vmdl_c',
  deagle: 'weapons/models/deagle/weapon_pist_deagle.vmdl_c',
  decoy: 'weapons/models/grenade/decoy/weapon_decoy.vmdl_c',
  elite: 'weapons/models/elite/weapon_pist_elite.vmdl_c',
  famas: 'weapons/models/famas/weapon_rif_famas.vmdl_c',
  fiveseven: 'weapons/models/fiveseven/weapon_pist_fiveseven.vmdl_c',
  flashbang: 'weapons/models/grenade/flashbang/weapon_flashbang.vmdl_c',
  g3sg1: 'weapons/models/g3sg1/weapon_snip_g3sg1.vmdl_c',
  galilar: 'weapons/models/galilar/weapon_rif_galilar.vmdl_c',
  glock: 'weapons/models/glock18/weapon_pist_glock18.vmdl_c',
  healthshot: 'weapons/models/healthshot/weapon_healthshot.vmdl_c',
  hegrenade: 'weapons/models/grenade/hegrenade/weapon_hegrenade.vmdl_c',
  hkp2000: 'weapons/models/hkp2000/weapon_pist_hkp2000.vmdl_c',
  incendiary: 'weapons/models/grenade/incendiary/weapon_incendiarygrenade.vmdl_c',
  knife: 'weapons/models/knife/knife_default_ct/weapon_knife_default_ct.vmdl_c',
  knife_t: 'weapons/models/knife/knife_default_t/weapon_knife_default_t.vmdl_c',
  m249: 'weapons/models/m249/weapon_mach_m249.vmdl_c',
  m4a1s: 'weapons/models/m4a1_silencer/weapon_rif_m4a1_silencer.vmdl_c',
  m4a4: 'weapons/models/m4a4/weapon_rif_m4a4.vmdl_c',
  mac10: 'weapons/models/mac10/weapon_smg_mac10.vmdl_c',
  mag7: 'weapons/models/mag7/weapon_shot_mag7.vmdl_c',
  molotov: 'weapons/models/grenade/molotov/weapon_molotov.vmdl_c',
  mp5sd: 'weapons/models/mp5sd/weapon_smg_mp5sd.vmdl_c',
  mp7: 'weapons/models/mp7/weapon_smg_mp7.vmdl_c',
  mp9: 'weapons/models/mp9/weapon_smg_mp9.vmdl_c',
  negev: 'weapons/models/negev/weapon_mach_negev.vmdl_c',
  nova: 'weapons/models/nova/weapon_shot_nova.vmdl_c',
  p250: 'weapons/models/p250/weapon_pist_p250.vmdl_c',
  p90: 'weapons/models/p90/weapon_smg_p90.vmdl_c',
  revolver: 'weapons/models/revolver/weapon_pist_revolver.vmdl_c',
  sawedoff: 'weapons/models/sawedoff/weapon_shot_sawedoff.vmdl_c',
  scar20: 'weapons/models/scar20/weapon_snip_scar20.vmdl_c',
  sg556: 'weapons/models/sg556/weapon_rif_sg556.vmdl_c',
  smokegrenade: 'weapons/models/grenade/smokegrenade/weapon_smokegrenade.vmdl_c',
  ssg08: 'weapons/models/ssg08/weapon_snip_ssg08.vmdl_c',
  taser: 'weapons/models/taser/weapon_pist_taser.vmdl_c',
  tec9: 'weapons/models/tec9/weapon_pist_tec9.vmdl_c',
  ump45: 'weapons/models/ump45/weapon_smg_ump45.vmdl_c',
  usp: 'weapons/models/usp_silencer/weapon_pist_usp_silencer.vmdl_c',
  xm1014: 'weapons/models/xm1014/weapon_shot_xm1014.vmdl_c',
});

/**
 * Sorted weapon names: the weapons a player holds. Also the viewmodel pipeline's list (one
 * clip folder per weapon, lib/viewmodels.mjs), so a model nobody holds does not go here.
 */
export const WEAPON_NAMES = Object.freeze(Object.keys(WEAPON_MODELS).sort());

/**
 * Models only ever seen lying in the world, by the name the pack gives the item (docs/pack.md
 * `GND1`): never held, so no `weapon` bone, no `extras.attach` and no viewmodel.
 */
export const GROUND_MODELS = Object.freeze({
  defuser: 'weapons/models/defuser/defuser.vmdl_c',
});

/** Every model ripped, shrunk, checked and listed in assets/weapons/: the weapons and GROUND_MODELS. */
export const MODEL_PATHS = Object.freeze({ ...WEAPON_MODELS, ...GROUND_MODELS });

/** Sorted MODEL_PATHS names. */
export const MODEL_NAMES = Object.freeze(Object.keys(MODEL_PATHS).sort());

const WEAPON_NAME = /^[a-z0-9_]+$/;

/**
 * VRF exports a weapon as mesh-group nodes `<vmdl>.<group>`: `body_legacy` (the
 * lower-poly body the game uses at distance) and `body_hd` (the close-up one), or a
 * single `body`, plus small extras such as `c4_screen`. The viewer draws the model
 * at arm's length of a 15 k-triangle player, so `body_hd` goes whenever
 * `body_legacy` exists; everything else is kept. In place; returns the group
 * suffixes dropped and kept.
 * @returns {{ dropped: string[], kept: string[] }}
 */
export function selectWeaponBody(doc) {
  const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh());
  const group = (n) => n.getName().slice(n.getName().lastIndexOf('.') + 1);
  const hasLegacy = nodes.some((n) => group(n) === 'body_legacy');
  const dropped = [];
  const kept = [];
  for (const n of nodes) {
    const g = group(n);
    if (hasLegacy && g === 'body_hd') {
      n.setMesh(null);
      n.dispose();
      dropped.push(g);
    } else kept.push(g);
  }
  if (kept.length === 0) throw new Error('no mesh node left');
  return { dropped: dropped.sort(), kept: kept.sort() };
}

/** A number rounded to 6 places, without a negative zero. */
const round6 = (v) => Math.round(v * 1e6) / 1e6 + 0;

/**
 * The rest pose of the export's `weapon` bone, the model's root bone, which the game puts on
 * the player's `wpn` bone: the glTF axes turned back into the game's and an offset that differs
 * per model (11 cm on the AK, 56 cm on the M4A4). Kept as the scene's
 * `extras.attach = { translation, rotation }` (the model's frame, metres, quaternion xyzw with
 * w ≥ 0), which three.js loads as `userData.attach`; the skeleton, skins, clips and the
 * `JOINTS_n`/`WEIGHTS_n` attributes go, the mesh stays as exported. Throws on an export made
 * without the skeleton.
 * @param {import('@gltf-transform/core').Document} doc
 * @returns {{ translation: number[], rotation: number[] }}
 */
export function takeWeaponAttach(doc) {
  const root = doc.getRoot();
  const bone = root.listNodes().find((n) => n.getName() === 'weapon');
  if (!bone) throw new Error('the export has no `weapon` bone (made without the skeleton); run tools/rip-weapons.sh --force');
  const t = [0, 0, 0];
  const r = [0, 0, 0, 1];
  const s = [1, 1, 1];
  MathUtils.decompose(bone.getWorldMatrix(), t, r, s);
  if (s.some((v) => Math.abs(v - 1) > 1e-3)) throw new Error(`the \`weapon\` bone is scaled (${s.join(', ')})`);
  const sign = r[3] < 0 ? -1 : 1;
  const attach = { translation: t.map(round6), rotation: r.map((v) => round6(v * sign)) };
  const scene = root.listScenes()[0];
  scene.setExtras({ ...scene.getExtras(), attach });
  dropSkeleton(doc);
  return attach;
}

/**
 * `takeWeaponAttach` for a weapon a player holds; for a GROUND_MODELS item (which has no
 * `weapon` bone: the kit's one bone is `weapon_hand_r`), null, after dropping its skeleton,
 * skins, clips and joint attributes the same way.
 * @param {string} name  a MODEL_PATHS key
 * @param {import('@gltf-transform/core').Document} doc
 * @returns {{ translation: number[], rotation: number[] } | null}
 */
export function takeModelAttach(name, doc) {
  if (!(name in GROUND_MODELS)) return takeWeaponAttach(doc);
  dropSkeleton(doc);
  return null;
}

/**
 * Drops the skeleton, skins, clips and `JOINTS_n`/`WEIGHTS_n` attributes, and the nodes left
 * with no mesh below them; the mesh stays as exported, in the model's frame. In place.
 * @param {import('@gltf-transform/core').Document} doc
 */
function dropSkeleton(doc) {
  const root = doc.getRoot();
  // Every accessor this lets go of is disposed here, so nothing is left for `prune` to find.
  const dropped = new Set();
  for (const a of root.listAnimations()) {
    for (const smp of a.listSamplers()) dropped.add(smp.getInput()).add(smp.getOutput());
    disposeClip(a);
  }
  for (const n of root.listNodes()) n.setSkin(null);
  for (const k of root.listSkins()) {
    dropped.add(k.getInverseBindMatrices());
    k.dispose();
  }
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives())
      for (const semantic of prim.listSemantics())
        if (/^(JOINTS|WEIGHTS)_\d+$/.test(semantic)) {
          dropped.add(prim.getAttribute(semantic));
          prim.setAttribute(semantic, null);
        }
  for (const acc of dropped) if (acc && acc.listParents().every((p) => p === root)) acc.dispose();
  // The bones, and the model's top node once they are gone: nodes with no mesh below them.
  const holdsMesh = (n) => Boolean(n.getMesh()) || n.listChildren().some(holdsMesh);
  for (const n of root.listNodes()) if (!holdsMesh(n)) n.dispose();
}

/**
 * Where the weapon artefacts live under ASSETS_DIR (read on every call).
 * @param {string} [name]  a MODEL_PATHS key; omit for the shared paths only
 */
export function weaponPaths(name) {
  if (name !== undefined && !(name in MODEL_PATHS)) {
    if (typeof name !== 'string' || !WEAPON_NAME.test(name)) throw new Error(`invalid weapon name: ${JSON.stringify(name)}`);
    throw new Error(`unknown weapon '${name}' (not in WEAPON_MODELS or GROUND_MODELS)`);
  }
  const root = assetsDir();
  const out = path.join(root, 'weapons');
  const raw = path.join(root, 'raw', 'weapons');
  const p = { raw, ripJson: path.join(raw, 'rip.json'), out, manifest: path.join(out, 'manifest.json') };
  if (name !== undefined) {
    p.glb = path.join(out, `${name}.glb`);
    p.gz = path.join(out, `${name}.glb.gz`);
    p.shrinkJson = path.join(out, `${name}.shrink.json`);
  }
  return p;
}
