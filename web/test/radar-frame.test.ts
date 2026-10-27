import { describe, expect, it } from 'vitest';
import { worldToRadar } from '../src/geo/coords';
import { FLAG, type Pack } from '../src/pack/types';
import { parseOverview, type Overview } from '../src/radar/overview';
import { KILL_LINE_S, radarFrame } from '../src/radar/frame';
import { HE_BLAST_S, HE_S } from '../src/sim/timeline';
import { cpuTimed } from './helpers/cpu-time';
import { MATCHES } from './helpers/match-packs';
import { event, trackPack } from './helpers/track-pack';

/** `assets/maps/de_mirage/overview.json`. */
const MIRAGE_OVERVIEW = {
  map: 'de_mirage',
  posX: -3230,
  posY: 1713,
  scale: 5,
  size: 1024,
  sections: [
    {
      name: 'default',
      image: 'radar.png',
      altitudeMin: -10000,
      altitudeMax: 10000,
    },
  ],
  bombA: [0.54, 0.76],
  bombB: [0.23, 0.28],
  inset: { left: 0.135, top: 0.08, right: 0.105, bottom: 0.08 },
};

/** Mirage's placement with a second level below z −495, as on Nuke. */
const OV: Overview = parseOverview({
  map: 'de_mirage',
  posX: -3230,
  posY: 1713,
  scale: 5,
  size: 1024,
  sections: [
    {
      name: 'default',
      image: 'radar.png',
      altitudeMin: -495,
      altitudeMax: 10000,
    },
    {
      name: 'lower',
      image: 'radar_lower.png',
      altitudeMin: -10000,
      altitudeMax: -495,
    },
  ],
  bombA: [0.54, 0.76],
  bombB: [0.23, 0.28],
  inset: { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 },
})!;

// Samples every 2 ticks from 1000; sample k is tick 1000 + 2k; 200 samples run to 1398.
const tickOf = (k: number) => 1000 + 2 * k;

/** Four players: 0 (T) runs east and fires, 1 (T) dies at sample 50, 2 (CT) is downstairs, 3 is not playing. */
function pack() {
  return trackPack({
    players: [
      (k) => ({ x: k * 2, y: 0, z: 0, yaw: 90 }),
      (k) => ({ x: 1000, y: -500, z: 0, flags: k < 50 ? FLAG.alive : 0 }),
      () => ({ x: -1000, y: 200, z: -600, yaw: 0 }),
      () => ({ x: 0, y: 0, z: 0 }),
    ],
    teams: [2, 2, 3, 0],
    events: [
      event('player_death', tickOf(50), {
        user_idx: 1,
        attacker_idx: 2,
        headshot: true,
        weapon: 'm4a1',
      }),
      event('smokegrenade_detonate', 1050, {
        user_idx: 0,
        entityid: 7,
        x: 500,
        y: 500,
        z: 0,
      }),
      event('smokegrenade_expired', 1050 + 320, { entityid: 7 }),
      event('weapon_fire', 1200, { user_idx: 0, weapon: 'weapon_ak47' }),
    ],
  });
}

describe('radarFrame', () => {
  it('places living players with worldToRadar, facing their yaw, on their level', () => {
    const f = radarFrame(pack(), 0, 1000, OV, null);
    const p0 = f.players.find((p) => p.index === 0)!;
    expect([p0.x, p0.y]).toEqual(worldToRadar(0, 0, OV));
    // Yaw 90 faces Source +y, which is up on the radar: −90° on the canvas.
    expect(p0.dir).toBeCloseTo(-Math.PI / 2, 6);
    expect(p0.label).toBe('1');
    expect(p0.team).toBe(2);
    const p2 = f.players.find((p) => p.index === 2)!;
    expect(OV.sections[p2.level].name).toBe('lower');
    expect(p2.label).toBe('3');
  });

  it('leaves out a player who is not in the round and a dead one', () => {
    const f = radarFrame(pack(), 0, tickOf(80), OV, null);
    expect(f.players.map((p) => p.index).sort()).toEqual([0, 2]);
  });

  it('marks a death where the victim fell, for the rest of the round', () => {
    const p = pack();
    expect(radarFrame(p, 0, tickOf(49), OV, null).deaths).toEqual([]);
    for (const k of [50, 51, 120, 199]) {
      const f = radarFrame(p, 0, tickOf(k), OV, null);
      expect(f.deaths).toHaveLength(1);
      const [x, y] = worldToRadar(1000, -500, OV);
      expect(f.deaths[0]).toMatchObject({ team: 2 });
      expect(f.deaths[0].x).toBeCloseTo(x, 6);
      expect(f.deaths[0].y).toBeCloseTo(y, 6);
    }
  });

  it('draws a kill line from the killer to the victim for a second, ageing from 0 to 1', () => {
    const p = pack();
    const at = (dt: number) =>
      radarFrame(p, 0, tickOf(50) + dt, OV, null).kills;
    expect(at(0)).toHaveLength(1);
    expect(at(0)[0]).toMatchObject({ team: 3, headshot: true, age: 0 });
    expect(at(32)[0].age).toBeCloseTo(0.5, 6);
    expect(at(KILL_LINE_S * 64)).toEqual([]);
    expect(at(0)[0].from).toEqual(worldToRadar(-1000, 200, OV));
  });

  it('gives a smoke its radius in radar pixels and how far through its life it is', () => {
    const p = pack();
    const smoke = (t: number) =>
      radarFrame(p, 0, t, OV, null).effects.find((e) => e.kind === 'smoke');
    expect(smoke(1049)).toBeUndefined();
    expect(smoke(1050)).toMatchObject({
      progress: 0,
      age: 0,
      radius: 144 / 5,
      team: 2,
    });
    expect(smoke(1050 + 64)!.age).toBe(1);
    expect(smoke(1050 + 160)!.progress).toBeCloseTo(0.5, 6);
    expect(smoke(1050 + 320)).toBeUndefined();
    expect([smoke(1050)!.x, smoke(1050)!.y]).toEqual(
      worldToRadar(500, 500, OV)
    );
  });

  it("rings an HE's blast for HE_BLAST_S, not the whole HE_S its smoke is drawn in the scene", () => {
    const p = trackPack({
      players: [() => ({ x: 0, y: 0, z: 0 })],
      teams: [2],
      events: [
        event('hegrenade_detonate', 1100, {
          user_idx: 0,
          entityid: 9,
          x: 0,
          y: 0,
          z: 0,
        }),
      ],
    });
    const he = (t: number) =>
      radarFrame(p, 0, t, OV, null).effects.find((e) => e.kind === 'he');
    expect(he(1100)).toMatchObject({ progress: 0, age: 0 });
    expect(he(1100 + Math.round(HE_BLAST_S * 64) / 2)!.progress).toBeCloseTo(
      0.5,
      6
    );
    expect(he(1100 + Math.round(HE_BLAST_S * 64))).toBeUndefined();
    expect(he(1100 + Math.round(HE_S * 64) - 1)).toBeUndefined();
  });

  it('marks a shot for a tenth of a second', () => {
    const p = pack();
    const shot = (t: number) =>
      radarFrame(p, 0, t, OV, null).players.find((q) => q.index === 0)!.shot;
    expect(shot(1199)).toBe(false);
    expect(shot(1200)).toBe(true);
    expect(shot(1206)).toBe(true);
    expect(shot(1208)).toBe(false);
  });

  it('names the bomb sites where the overview puts them', () => {
    expect(radarFrame(pack(), 0, 1000, OV, null).sites).toEqual([
      { label: 'A', x: 0.54 * 1024, y: 0.76 * 1024 },
      { label: 'B', x: 0.23 * 1024, y: 0.28 * 1024 },
    ]);
  });

  it('puts the shown player last, and only them shown', () => {
    const f = radarFrame(pack(), 0, 1000, OV, 0);
    expect(f.players.at(-1)!.index).toBe(0);
    expect(f.players.filter((q) => q.shown).map((q) => q.index)).toEqual([0]);
  });

  it('is the same whether a tick is reached forwards or backwards', () => {
    const p = pack();
    radarFrame(p, 0, 1300, OV, 2);
    const back = radarFrame(p, 0, 1060, OV, 2);
    const fresh = radarFrame(pack(), 0, 1060, OV, 2);
    expect(back).toEqual(fresh);
  });

  it('follows the bomb from its carrier to the plant, blinking', () => {
    const p = trackPack({
      players: [
        (k) => ({
          x: 100,
          y: 100,
          flags: FLAG.alive | (k < 100 ? FLAG.bomb : 0),
        }),
      ],
      teams: [2],
      events: [event('bomb_planted', tickOf(100), { user_idx: 0, site: 1 })],
    });
    const carried = radarFrame(p, 0, tickOf(10), OV, null).bomb!;
    expect(carried.state).toBe('carried');
    expect([carried.x, carried.y]).toEqual(worldToRadar(100, 100, OV));
    expect(radarFrame(p, 0, tickOf(10), OV, null).players[0].bomb).toBe(true);
    const planted = radarFrame(p, 0, tickOf(101), OV, null).bomb!;
    expect(planted.state).toBe('planted');
    const blinks = new Set(
      Array.from(
        { length: 60 },
        (_, i) => radarFrame(p, 0, tickOf(100) + i, OV, null).bomb!.blink
      )
    );
    expect(blinks).toEqual(new Set([true, false]));
  });
});

for (const m of MATCHES)
  describe.skipIf(m.skip)(`radarFrame on ${m.name}`, () => {
    it('builds every 32nd tick of every round in under half a millisecond of CPU on average, everyone on the image', async () => {
      const pack: Pack = await m.load();
      const ov = parseOverview({ ...MIRAGE_OVERVIEW })!;
      let frames = 0;
      const off: string[] = [];
      const { ms } = cpuTimed(() => {
        for (let r = 0; r < pack.header.rounds.length; r++) {
          const info = pack.header.rounds[r];
          for (let t = info.start_tick; t <= info.post_end_tick; t += 32) {
            const f = radarFrame(pack, r, t, ov, 0);
            frames++;
            for (const p of f.players)
              if (!(p.x >= 0 && p.x < 1024 && p.y >= 0 && p.y < 1024))
                off.push(`round ${r + 1} tick ${t}: ${p.x}, ${p.y}`);
          }
        }
      });
      expect(off.slice(0, 5)).toEqual([]);
      if (process.env.DEMOVIEWER_RIG_LOG === '1')
        console.log(`${frames} frames, ${(ms / frames).toFixed(3)} ms each`);
      expect(ms / frames).toBeLessThan(0.5);
    }, 60_000);
  });
