import { describe, expect, it } from 'vitest';
import { povOverlay } from '../src/components/hud/pov';
import { FLAG, GEAR } from '../src/pack/types';
import { trackPack } from './helpers/track-pack';

function state(o: {
  weapon?: number;
  flags?: number;
  zoom?: number;
  camera?: string;
  follow?: number | null;
}) {
  const pack = trackPack({
    samples: 50,
    teams: [2, 3],
    weapons: ['none', 'AWP', 'AK-47'],
    players: [
      () => ({ weapon: o.weapon ?? 2, flags: o.flags ?? FLAG.alive }),
      () => ({}),
    ],
  });
  pack.header.players[0].crosshair = 'CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB';
  pack.rounds[0].players[0].gear = new Uint8Array(50).fill(
    (o.zoom ?? 0) << GEAR.zoomShift
  );
  return {
    pack,
    round: 0,
    tick: 1010,
    camera: (o.camera ?? 'pov') as 'pov',
    follow: o.follow === undefined ? 0 : o.follow,
  };
}

describe('povOverlay', () => {
  it("shows the followed player's crosshair in first person", () => {
    expect(povOverlay(state({}))).toEqual({
      kind: 'crosshair',
      code: 'CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB',
    });
  });

  it('shows the scope at its zoom when scoped with a scoped weapon, the crosshair otherwise', () => {
    expect(
      povOverlay(state({ weapon: 1, zoom: 1, flags: FLAG.alive | FLAG.scoped }))
    ).toEqual({ kind: 'scope', weapon: 'awp', zoom: 1 });
    expect(povOverlay(state({ weapon: 1, zoom: 2 }))).toEqual({
      kind: 'scope',
      weapon: 'awp',
      zoom: 2,
    });
    expect(
      povOverlay(state({ weapon: 2, flags: FLAG.alive | FLAG.scoped })).kind
    ).toBe('crosshair');
  });

  it('shows nothing outside first person, with nobody followed, or when the player is dead', () => {
    expect(povOverlay(state({ camera: 'free' })).kind).toBe('none');
    expect(povOverlay(state({ follow: null })).kind).toBe('none');
    expect(povOverlay(state({ flags: 0 })).kind).toBe('none');
  });

  it('shows nothing over the full radar, which is not first person', () => {
    expect(povOverlay({ ...state({}), radar: true }).kind).toBe('none');
  });
});
