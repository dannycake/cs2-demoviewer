// Puts the real Mirage pack's spawns on Mirage's radar. Gated like pack-mirage.test.ts: run
// with DEMOVIEWER_PACK=~/.local/share/demoviewer/mirage.dvpk.gz npm test.

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { worldToRadar } from '../src/geo/coords';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import type { Pack } from '../src/pack/types';
import { newPlayerState, playerStateAt } from '../src/sim/sample';
import { needs } from './helpers/gates';

const PACK = process.env.DEMOVIEWER_PACK;
const GATE = needs('mirage spawns on the radar', 'DEMOVIEWER_PACK');

// de_mirage overview and spawn markers, as tools/test/overview.test.mjs reads them.
const MIRAGE = { posX: -3230, posY: 1713, scale: 5 };
const CT_SPAWN: [number, number] = [0.28, 0.7];
const T_SPAWN: [number, number] = [0.87, 0.36];
const RADAR_PX = 1024;
const TOLERANCE = 0.12;

describe.skipIf(!PACK)(GATE, () => {
  let pack: Pack;

  beforeAll(async () => {
    pack = parsePack(
      await inflateIfGzip(new Uint8Array(await readFile(PACK!)))
    );
  });

  it('has every player of round 1 at their side spawn at freeze end', () => {
    const round = pack.header.rounds[0];
    const s = newPlayerState();
    let ct = 0;
    let t = 0;
    pack.header.players.forEach((player, p) => {
      const team = player.team_by_round[0];
      if (team !== 2 && team !== 3) return;
      playerStateAt(
        pack.rounds[0].players[p],
        round,
        round.freeze_end_tick,
        pack.header,
        s
      );
      expect(s.present, `${player.name} present`).toBe(true);
      const [px, py] = worldToRadar(s.x, s.y, MIRAGE);
      const frac: [number, number] = [px / RADAR_PX, py / RADAR_PX];
      const spawn = team === 3 ? CT_SPAWN : T_SPAWN;
      const d = Math.hypot(frac[0] - spawn[0], frac[1] - spawn[1]);
      console.log(
        `${team === 3 ? 'CT' : 'T '} ${player.name.padEnd(16)} ` +
          `radar [${frac.map((v) => v.toFixed(3)).join(', ')}] ` +
          `${d.toFixed(3)} from spawn`
      );
      expect(d, `${player.name} distance to spawn`).toBeLessThanOrEqual(
        TOLERANCE
      );
      if (team === 3) ct++;
      else t++;
    });
    expect(ct).toBe(5);
    expect(t).toBe(5);
  });
});
