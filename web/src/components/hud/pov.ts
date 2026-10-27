// What first person draws over the scene for the followed player: their crosshair, or the
// scope when they are scoped in with a weapon that has one, or nothing.

import { FLAG, zoomOf, type Pack } from '../../pack/types';
import { newPlayerState, playerStateAt } from '../../sim/sample';
import { scopeFov } from '../../sim/scope';
import { normaliseWeapon } from '../../sim/weapons';

export type PovOverlay =
  | { kind: 'none' }
  | { kind: 'crosshair'; code: string | null }
  | { kind: 'scope'; weapon: string; zoom: number };

const NONE: PovOverlay = { kind: 'none' };
const scratch = newPlayerState();

export function povOverlay(s: {
  pack: Pack | null;
  round: number;
  tick: number;
  camera: string;
  follow: number | null;
}): PovOverlay {
  if (s.camera !== 'pov' || s.follow === null || !s.pack) return NONE;
  const { header } = s.pack;
  const info = header.rounds[s.round];
  const track = s.pack.rounds[s.round]?.players[s.follow];
  if (!info || !track) return NONE;
  const st = playerStateAt(track, info, s.tick, header, scratch);
  if (!st.present || (st.flags & FLAG.alive) === 0) return NONE;
  const weapon = normaliseWeapon(header.weapons[st.weapon] ?? '');
  const zoom = Math.max(zoomOf(st.gear), st.flags & FLAG.scoped ? 1 : 0);
  if (zoom > 0 && scopeFov(weapon, zoom) !== null)
    return { kind: 'scope', weapon, zoom };
  return {
    kind: 'crosshair',
    code: header.players[s.follow]?.crosshair ?? null,
  };
}

/** Whether two overlays draw the same, so a component re-renders only on a change. */
export function sameOverlay(a: PovOverlay, b: PovOverlay): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'crosshair' && b.kind === 'crosshair')
    return a.code === b.code;
  if (a.kind === 'scope' && b.kind === 'scope')
    return a.weapon === b.weapon && a.zoom === b.zoom;
  return true;
}
