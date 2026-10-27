// What a player's steps sound like, by the surface under their feet: the hull names each
// collision group after its surface property (`physics_group_<surface>`, `hull.glb`), and the
// sounds manifest maps a surface to the step set CS2 walks it with (`plaster` → `concrete`).

import type { SoundManifest } from './manifest';

/** Words before the surface in a group's name: what the group is, not what it is made of. */
const KIND =
  /^(?:ladder|group|passbullets|window|blocksound|conditionallysolid)(?:_|$)/;

/**
 * The surface of the hull node named `name`, as the sounds manifest keys it, or null for a node
 * that is not a collision group (`physics_…`). `physics_` and then any of `ladder`, `group`,
 * `passbullets`, `window`, `blocksound` and `conditionallysolid` go, each with its `_`:
 * `physics_group_wood_plank` → `wood_plank`, `physics_ladder_passbullets_wood_ladder` →
 * `wood_ladder`, Train's `physics_ConditionallySolid_foliage` → `foliage`; the bare
 * `physics_group` is `default`.
 */
export function surfaceOfNode(name: string): string | null {
  const lower = name.toLowerCase();
  if (!lower.startsWith('physics_')) return null;
  let rest = lower.slice('physics_'.length);
  for (let m = KIND.exec(rest); m; m = KIND.exec(rest))
    rest = rest.slice(m[0].length);
  return rest || 'default';
}

/**
 * The step set a player on `surface` (`Hull.surfaceBelow`) walks with: `default` without a
 * surface, or for one the manifest does not know.
 */
export function stepSetOf(m: SoundManifest, surface: string | null): string {
  return surface !== null && Object.hasOwn(m.surfaces, surface)
    ? m.surfaces[surface]
    : 'default';
}
