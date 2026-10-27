// Reads a whole match's pack: the synthetic match (test/helpers/synthetic-match.ts) always, and
// the real Mirage pack when DEMOVIEWER_PACK names it. Create that fixture with
//   cd server && cargo run --release --bin demoviewer-pack-cli -- \
//     ~/.local/share/demoviewer/demos/mirage.dem ~/.local/share/demoviewer/mirage.dvpk.gz
// and run with DEMOVIEWER_PACK=~/.local/share/demoviewer/mirage.dvpk.gz npm test.

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import type { Pack } from '../src/pack/types';
import { has, needs } from './helpers/gates';
import { MATCHES } from './helpers/match-packs';

for (const m of MATCHES)
  describe.skipIf(m.skip)(`the pack of ${m.name}`, () => {
    let pack: Pack;

    beforeAll(async () => {
      pack = await m.load();
    });

    it('has tracks of every round sized to its sample count', () => {
      const players = pack.header.players.length;
      expect(players).toBe(10);
      expect(pack.rounds).toHaveLength(pack.header.rounds.length);
      pack.header.rounds.forEach((round, r) => {
        expect(pack.rounds[r].players).toHaveLength(players);
        for (const t of pack.rounds[r].players) {
          for (const col of Object.values(t))
            expect(col.length).toBe(round.samples);
        }
      });
    });

    it('has grenade tracks sized to their sample counts', () => {
      expect(pack.grenades.length).toBeGreaterThan(0);
      for (const g of pack.grenades) {
        expect(g.x.length).toBe(g.samples);
        expect(g.y.length).toBe(g.samples);
        expect(g.z.length).toBe(g.samples);
      }
    });
  });

describe.skipIf(!has('DEMOVIEWER_PACK'))(
  needs('the Mirage pack', 'DEMOVIEWER_PACK'),
  () => {
    let pack: Pack;

    beforeAll(async () => {
      const gz = new Uint8Array(await readFile(process.env.DEMOVIEWER_PACK!));
      const t0 = performance.now();
      const bytes = await inflateIfGzip(gz);
      const t1 = performance.now();
      pack = parsePack(bytes);
      const t2 = performance.now();
      console.log(
        `mirage pack: ${gz.length} B gzip -> ${bytes.length} B; ` +
          `inflate ${(t1 - t0).toFixed(0)} ms, parse ${(t2 - t1).toFixed(0)} ms`
      );
    });

    it('has the Mirage header', () => {
      expect(pack.header.map).toBe('de_mirage');
      expect(pack.header.version).toBe(1);
      expect(pack.header.rounds).toHaveLength(24);
      expect(pack.header.players).toHaveLength(10);
      expect(pack.header.weapons[0]).toBe('none');
    });

    it('has the deaths and grenades of the match', () => {
      expect(pack.events.filter((e) => e.kind === 'player_death')).toHaveLength(
        176
      );
      expect(pack.grenades).toHaveLength(241);
    });
  }
);
