// What a bullet meets, read from the name of the map hull's collision group: `hull.glb` keeps one
// node per `physics_group_<surface>` (or `physics_passbullets_<surface>`), and the impacts are
// drawn by it (`bulletmarks.ts`): dust on stone, sparks on metal, chips off glass.

/**
 * `pass`: bullets fly through it (chainlink, grates marked to pass bullets). `nodecal`: CS2 never
 * marks it (`physics_group_no_decal`): a puff of dust and no hole or blood.
 */
export type Surface =
  'stone' | 'metal' | 'wood' | 'glass' | 'dirt' | 'soft' | 'pass' | 'nodecal';

/** Every surface by the value the hull's `surface` attribute holds (its index). */
export const SURFACES: readonly Surface[] = Object.freeze([
  'stone',
  'metal',
  'wood',
  'glass',
  'dirt',
  'soft',
  'pass',
  'nodecal',
]);

/**
 * In order: the first that matches the group's name wins; stone when none does. What a thing is
 * made of wins over what it is: a concrete window is concrete, a plastic barrel or milk crate
 * plastic.
 */
const RULES: readonly (readonly [RegExp, Surface])[] = [
  [/passbullets/, 'pass'],
  [/no_decal/, 'nodecal'],
  [/concrete/, 'stone'],
  [/glass|window/, 'glass'],
  [/plastic/, 'soft'],
  [
    /metal|chainlink|grate|vent|vehicle|barrel|computer|brass|canister|paintcan/,
    'metal',
  ],
  [/wood|crate|plank/, 'wood'],
  [/dirt|sand|gravel|grass|mud|soil/, 'dirt'],
  [/carpet|cloth|rubber|cardboard|paper|upholstery|foliage/, 'soft'],
];

/** The surface of the hull group named `name` (`physics_group_metal_box` → metal). */
export function surfaceOf(name: string): Surface {
  for (const [re, surface] of RULES) if (re.test(name)) return surface;
  return 'stone';
}
