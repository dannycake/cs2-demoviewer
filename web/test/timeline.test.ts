import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/pack/types';
import {
  blinkOn,
  BOMB_BLINK,
  BOMB_S,
  FLASH_S,
  HE_BLAST_S,
  HE_S,
  ROUND_S,
  SMOKE_S,
  Timeline,
} from '../src/sim/timeline';
import { cpuTimed } from './helpers/cpu-time';
import { MATCHES } from './helpers/match-packs';
import { event, grenadeTrack, trackPack } from './helpers/track-pack';

// 64 ticks/s, 2 ticks per sample, the round runs 1000..4998 with a 10 s freeze (to 1640).
const T = 1000;
const R = 64;
const FREEZE_END = T + 10 * R;

function pack(o: Partial<Parameters<typeof trackPack>[0]> = {}) {
  return trackPack({
    samples: 2000,
    freeze: 10 * R,
    players: [
      () => ({ x: 0, y: 0 }),
      () => ({ x: 100, y: 0 }),
      () => ({ x: 500, y: 500 }),
      () => ({ x: 600, y: 500 }),
    ],
    teams: [2, 2, 3, 3],
    ...o,
  });
}

describe('Timeline effects', () => {
  const p = pack({
    events: [
      event('smokegrenade_detonate', 1100, {
        entityid: 5,
        user_idx: 0,
        x: 10,
        y: 20,
        z: 30,
      }),
      event('smokegrenade_expired', 1500, {
        entityid: 5,
        user_idx: 0,
        x: 10,
        y: 20,
        z: 30,
      }),
      event('smokegrenade_detonate', 1700, {
        entityid: 6,
        user_idx: 1,
        x: 0,
        y: 0,
        z: 0,
      }),
      event('inferno_startburn', 2000, {
        entityid: 9,
        user_idx: 2,
        x: 1,
        y: 2,
        z: 3,
      }),
      event('inferno_expire', 2300, {
        entityid: 9,
        user_idx: 2,
        x: 1,
        y: 2,
        z: 3,
      }),
      event('flashbang_detonate', 3000, {
        entityid: 11,
        user_idx: 3,
        x: 0,
        y: 0,
        z: 0,
      }),
      event('hegrenade_detonate', 3100, {
        entityid: 12,
        user_idx: 0,
        x: 0,
        y: 0,
        z: 0,
      }),
      event('decoy_started', 3200, {
        entityid: 13,
        user_idx: 1,
        x: 0,
        y: 0,
        z: 0,
      }),
      event('decoy_detonate', 3300, {
        entityid: 13,
        user_idx: 1,
        x: 0,
        y: 0,
        z: 0,
      }),
      event('smokegrenade_detonate', 10, {
        entityid: 1,
        user_idx: 0,
        x: 0,
        y: 0,
        z: 0,
      }),
    ],
  });
  const tl = new Timeline(p);
  const kinds = (tick: number) => tl.effectsAt(0, tick).map((e) => e.kind);

  it('a smoke lives from its detonation to its expiry, matched by entity', () => {
    expect(kinds(1099)).toEqual([]);
    expect(tl.effectsAt(0, 1200)).toEqual([
      {
        kind: 'smoke',
        x: 10,
        y: 20,
        z: 30,
        startTick: 1100,
        endTick: 1500,
        thrower: 0,
        entityId: 5,
      },
    ]);
    expect(kinds(1500)).toEqual([]);
  });

  it('a smoke without an expiry lasts the default, fires and decoys run to their end events', () => {
    const s = tl.effectsAt(0, 1800)[0];
    expect(s.endTick).toBe(1700 + Math.round(SMOKE_S * R));
    expect(kinds(2150)).toEqual(['smoke', 'fire']);
    expect(tl.effectsAt(0, 2150).find((e) => e.kind === 'fire')!.endTick).toBe(
      2300
    );
    expect(tl.effectsAt(0, 3250).find((e) => e.kind === 'decoy')!.endTick).toBe(
      3300
    );
  });

  it('a flash is a short burst; an HE lasts as long as the smoke after its blast', () => {
    const f = tl.effectsAt(0, 3000).find((e) => e.kind === 'flash')!;
    expect(f.endTick - f.startTick).toBe(Math.round(FLASH_S * R));
    expect(kinds(3000 + Math.round(FLASH_S * R))).not.toContain('flash');
    expect(kinds(3120)).toContain('he');
    const he = tl.effectsAt(0, 3120).find((e) => e.kind === 'he')!;
    expect(he.endTick - he.startTick).toBe(Math.round(HE_S * R));
    expect(HE_S).toBeGreaterThan(HE_BLAST_S);
    expect(kinds(3100 + Math.round(HE_S * R))).not.toContain('he');
  });

  it('ignores events outside the round', () => {
    expect(tl.effectsAt(0, 20)).toEqual([]);
  });
});

describe('Timeline projectiles', () => {
  const smoke = grenadeTrack({
    kind: 'smoke',
    thrower: 0,
    start_tick: 1050,
    from: [0, 0, 64],
    to: [400, 0, 64],
    samples: 60,
    entity_id: 21,
  });
  smoke.detonate_tick = 1100;
  const molly = grenadeTrack({
    kind: 'molotov',
    thrower: 1,
    start_tick: 1200,
    from: [0, 0, 64],
    to: [100, 0, 0],
    samples: 30,
    entity_id: 22,
  });
  molly.detonate_tick = 1250;
  const inc = grenadeTrack({
    kind: 'incendiary',
    thrower: 2,
    start_tick: 1300,
    from: [0, 0, 64],
    to: [100, 0, 0],
    samples: 10,
    entity_id: 23,
  });
  const tl = new Timeline(pack({ grenades: [smoke, molly, inc] }));

  it('flies from its start tick to its detonation, labelled', () => {
    expect(tl.projectilesAt(0, 1049)).toEqual([]);
    expect(tl.projectilesAt(0, 1060).map((g) => g.label)).toEqual(['Smoke']);
    expect(tl.projectilesAt(0, 1100)).toEqual([]);
    expect(tl.projectilesAt(0, 1210).map((g) => g.label)).toEqual(['Molotov']);
  });

  it('without a detonation tick it flies to the end of its track', () => {
    expect(tl.projectilesAt(0, 1300 + 17).map((g) => g.label)).toEqual([
      'Incendiary',
    ]);
    expect(tl.projectilesAt(0, 1300 + 18)).toEqual([]);
  });
});

describe('Timeline shots, hits, blinds and kills', () => {
  const p = pack({
    events: [
      event('weapon_fire', 1100, {
        user_idx: 0,
        weapon: 'weapon_m4a1_silencer',
      }),
      event('weapon_fire', 1110, { user_idx: 0, weapon: 'weapon_ak47' }),
      // The shot itself (recoil in its angles) and its hit, logged at the same tick.
      event('bullet_damage', 1110, {
        attacker_idx: 0,
        victim_idx: 2,
        damage_dir_x: 0.6,
        damage_dir_y: 0.8,
        damage_dir_z: 0,
        distance: 250,
        num_penetrations: 1,
      }),
      event('fire_bullets', 1110, {
        user_idx: 0,
        angles_x: -3.5,
        angles_y: 52,
        origin_x: 10,
        origin_y: 20,
        origin_z: 64,
      }),
      event('weapon_fire', 1110, { user_idx: 99, weapon: 'weapon_ak47' }),
      // A hit logged without its penetrations (a demo from before the field).
      event('weapon_fire', 1120, { user_idx: 0, weapon: 'weapon_ak47' }),
      event('bullet_damage', 1120, {
        attacker_idx: 0,
        victim_idx: 2,
        damage_dir_x: 1,
        damage_dir_y: 0,
        damage_dir_z: 0,
        distance: 300,
      }),
      event('player_hurt', 1111, {
        user_idx: 2,
        attacker_idx: 0,
        dmg_health: 27,
        health: 73,
        hitgroup: 'chest',
        weapon: 'ak47',
      }),
      event('player_hurt', 1112, {
        user_idx: 2,
        attacker_idx: null,
        dmg_health: 5,
        health: 68,
        hitgroup: 'generic',
        weapon: 'world',
      }),
      event('player_hurt', 1300, {
        user_idx: 2,
        attacker_idx: 0,
        dmg_health: 68,
        health: 0,
        hitgroup: 'head',
        weapon: 'ak47',
      }),
      event('player_blind', 1200, {
        user_idx: 3,
        attacker_idx: 1,
        blind_duration: 1.5,
      }),
      event('player_blind', 1210, {
        user_idx: 3,
        attacker_idx: 1,
        blind_duration: 0,
      }),
      event('player_death', 1300, {
        user_idx: 2,
        attacker_idx: 0,
        assister_idx: 1,
        weapon: 'ak47',
        headshot: true,
        penetrated: 1,
        thrusmoke: true,
        noscope: false,
        attackerblind: false,
        assistedflash: true,
      }),
      event('player_death', 1400, {
        user_idx: 3,
        attacker_idx: null,
        weapon: 'world',
      }),
    ],
  });
  const tl = new Timeline(p);

  it('windows shots and hits by tick, normalising and flagging suppressed weapons', () => {
    expect(tl.shotsAt(0, 1110, 20)).toEqual([
      {
        tick: 1100,
        player: 0,
        weapon: 'm4a1s',
        suppressed: true,
        from: null,
        aim: null,
        hit: null,
      },
      {
        tick: 1110,
        player: 0,
        weapon: 'ak47',
        suppressed: false,
        from: { x: 10, y: 20, z: 64 },
        aim: { pitch: -3.5, yaw: 52 },
        hit: { dir: [0.6, 0.8, 0], distance: 250, penetrations: 1 },
      },
    ]);
    expect(tl.shotsAt(0, 1110, 10).map((s) => s.tick)).toEqual([1110]);
    expect(tl.shotsAt(0, 1099, 1000)).toEqual([]);
    expect(tl.hitsAt(0, 1112, 5)).toEqual([
      {
        tick: 1111,
        victim: 2,
        attacker: 0,
        damage: 27,
        hitgroup: 'chest',
        headshot: false,
        weapon: 'ak47',
        fatal: false,
      },
      {
        tick: 1112,
        victim: 2,
        attacker: null,
        damage: 5,
        hitgroup: 'generic',
        headshot: false,
        weapon: 'world',
        fatal: false,
      },
    ]);
    // The hit that leaves no health is the killing one.
    expect(tl.hitsAt(0, 1300, 1)).toMatchObject([
      { tick: 1300, headshot: true, fatal: true },
    ]);
  });

  it("reads a hit's penetrations (0 when not logged) and lists the round's shots by tick", () => {
    expect(tl.shotsAt(0, 1120, 1)[0].hit).toEqual({
      dir: [1, 0, 0],
      distance: 300,
      penetrations: 0,
    });
    const all = tl.shots(0);
    expect(all.map((s) => [s.tick, s.weapon])).toEqual([
      [1100, 'm4a1s'],
      [1110, 'ak47'],
      [1120, 'ak47'],
    ]);
    expect(all[1].hit?.penetrations).toBe(1);
    // The same list each time, and none for a round that is not there.
    expect(tl.shots(0)).toBe(all);
    expect(tl.shots(7)).toEqual([]);
  });

  it('blinds last their duration and a zero-length blind is dropped', () => {
    expect(tl.blindsAt(0, 1200)).toEqual([
      { player: 3, startTick: 1200, endTick: 1296, attacker: 1 },
    ]);
    expect(tl.blindsAt(0, 1296)).toEqual([]);
  });

  it('kills carry the killfeed badges', () => {
    expect(tl.kills(0)).toEqual([
      {
        tick: 1300,
        attacker: 0,
        victim: 2,
        assister: 1,
        weapon: 'ak47',
        headshot: true,
        wallbang: true,
        smoke: true,
        noscope: false,
        blind: false,
        flashAssist: true,
      },
      {
        tick: 1400,
        attacker: null,
        victim: 3,
        assister: null,
        weapon: 'world',
        headshot: false,
        wallbang: false,
        smoke: false,
        noscope: false,
        blind: false,
        flashAssist: false,
      },
    ]);
  });
});

describe('Timeline bomb and clock', () => {
  const PLANT = 2000;
  const p = pack({
    players: [
      (k) => ({
        x: 10,
        y: 20,
        z: 30,
        flags: FLAG.alive | (k < 50 ? FLAG.bomb : 0),
      }),
      (k) => ({
        x: 300,
        y: 400,
        z: 5,
        flags: FLAG.alive | (k >= 100 && k < 500 ? FLAG.bomb : 0),
      }),
      () => ({ x: 500, y: 500 }),
      (k) => ({
        x: 600,
        y: 500,
        flags: FLAG.alive | (k >= 1400 && k < 1450 ? FLAG.defusing : 0),
      }),
    ],
    events: [
      event('bomb_dropped', 1100, { user_idx: 0 }),
      event('bomb_pickup', 1200, { user_idx: 1 }),
      event('bomb_planted', PLANT, { user_idx: 1, site: 109 }),
      event('bomb_exploded', PLANT + BOMB_S * R, { user_idx: 0, site: 109 }),
      event('round_end', PLANT + BOMB_S * R, {
        reason: 'target_bombed',
        winner: 2,
      }),
    ],
  });
  const tl = new Timeline(p);

  it('walks carried, dropped, carried, planted and exploded', () => {
    expect(tl.bombAt(0, 1050)).toEqual({ kind: 'carried', by: 0 });
    expect(tl.bombAt(0, 1150)).toEqual({
      kind: 'dropped',
      x: 10,
      y: 20,
      z: 30,
      tick: 1100,
    });
    expect(tl.bombAt(0, 1250)).toEqual({ kind: 'carried', by: 1 });
    expect(tl.bombAt(0, PLANT + 10)).toEqual({
      kind: 'planted',
      x: 300,
      y: 400,
      z: 5,
      tick: PLANT,
      site: 109,
      by: 1,
    });
    expect(tl.bombAt(0, PLANT + BOMB_S * R)).toEqual({
      kind: 'exploded',
      tick: PLANT + BOMB_S * R,
      x: 300,
      y: 400,
      z: 5,
    });
  });

  it('says when the bomb went off as bombAt does, at every tick, and bombAt answers a new state each call', () => {
    const info = p.header.rounds[0];
    const BOOM = PLANT + BOMB_S * R;
    const differ: number[] = [];
    let exploded = 0;
    // Half ticks too: playback draws between them.
    for (let t = info.start_tick; t <= info.post_end_tick; t += 0.5) {
      const b = tl.bombAt(0, t);
      if (b.kind === 'exploded') exploded++;
      if (tl.explodedAt(0, t) !== (b.kind === 'exploded' ? b.tick : null))
        differ.push(t);
    }
    expect(differ).toEqual([]);
    expect(exploded).toBeGreaterThan(0);
    expect(tl.explodedAt(0, BOOM - 0.5)).toBeNull();
    expect(tl.explodedAt(0, BOOM)).toBe(BOOM);
    expect(tl.explodedAt(7, BOOM)).toBeNull();
    // The states the events give are kept for the round: bombAt hands out copies of them.
    const planted = tl.bombAt(0, PLANT + 10);
    expect(tl.bombAt(0, PLANT + 10)).toEqual(planted);
    expect(tl.bombAt(0, PLANT + 10)).not.toBe(planted);
  });

  it('a defuse ends it, from the event or from the round end reason', () => {
    const defused = new Timeline(
      pack({
        events: [
          event('bomb_planted', PLANT, { user_idx: 1, site: 1 }),
          event('bomb_defused', PLANT + 600, { user_idx: 3, site: 1 }),
        ],
      })
    );
    expect(defused.bombAt(0, PLANT + 600)).toEqual({
      kind: 'defused',
      tick: PLANT + 600,
      by: 3,
    });
    const byReason = new Timeline(
      pack({
        events: [
          event('bomb_planted', PLANT, { user_idx: 1, site: 1 }),
          event('round_end', PLANT + 700, {
            reason: 'bomb_defused',
            winner: 3,
          }),
        ],
      })
    );
    expect(byReason.bombAt(0, PLANT + 700)).toEqual({
      kind: 'defused',
      tick: PLANT + 700,
      by: null,
    });
    expect(byReason.roundTimer(0, PLANT + 700)).toEqual({
      phase: 'over',
      secondsLeft: 0,
    });
  });

  it('the clock counts the freeze, the round and the fuse', () => {
    expect(tl.roundTimer(0, T)).toEqual({ phase: 'freeze', secondsLeft: 10 });
    expect(tl.roundTimer(0, FREEZE_END + 5 * R)).toEqual({
      phase: 'live',
      secondsLeft: ROUND_S - 5,
    });
    expect(tl.roundTimer(0, PLANT + 5 * R)).toEqual({
      phase: 'planted',
      secondsLeft: BOMB_S - 5,
    });
    expect(tl.roundTimer(0, PLANT + BOMB_S * R)).toEqual({
      phase: 'over',
      secondsLeft: 0,
    });
    // Without a round_end event the round is over at its end tick.
    expect(
      new Timeline(pack()).roundTimer(0, p.header.rounds[0].end_tick)
    ).toEqual({ phase: 'over', secondsLeft: 0 });
  });

  it('the feed tells throws, plants, defuses, kills and the explosion, newest last', () => {
    const g = grenadeTrack({
      kind: 'flash',
      thrower: 1,
      start_tick: 1500,
      from: [0, 0, 0],
      to: [10, 0, 0],
    });
    const f = new Timeline(
      pack({
        players: p.rounds[0].players.map(
          (_, i) => (k: number) =>
            i === 3 && k >= 1400 && k < 1450
              ? { flags: FLAG.alive | FLAG.defusing }
              : {}
        ),
        grenades: [g],
        events: [
          ...p.events,
          event('player_death', 1600, {
            user_idx: 2,
            attacker_idx: 0,
            weapon: 'ak47',
          }),
          event('player_death', 1700, {
            user_idx: 3,
            attacker_idx: 3,
            weapon: 'hegrenade',
          }),
        ],
      })
    );
    const all = f.feed(0, 99999, 99);
    expect(all.map((i) => `${i.kind}:${i.team}:${i.text}`)).toEqual([
      'throw:2:player2 threw a flash',
      'kill:2:player1 killed player3',
      'kill:3:player4 died',
      'plant:2:player2 planted the bomb',
      'defuse:3:player4 started defusing',
      'exploded:2:The bomb exploded',
    ]);
    expect(f.feed(0, 1650, 2).map((i) => i.kind)).toEqual(['throw', 'kill']);
    expect(f.feed(0, 1499, 5)).toEqual([]);
  });
});

for (const m of MATCHES)
  describe.skipIf(m.skip)(`Timeline on ${m.name}`, () => {
    it('finds every in-round kill, grenade and bomb event, and answers fast', async () => {
      const pk = await m.load();
      const tl = new Timeline(pk);
      const rounds = pk.header.rounds;
      // A round's events run on past its end to its post_end_tick (a kill or a molotov after
      // the round is won), as the timeline keeps them.
      const inRound = (t: number) =>
        rounds.some((r) => t >= r.start_tick && t <= r.post_end_tick);
      const count = (kind: string) =>
        pk.events.filter((e) => e.kind === kind && inRound(e.tick)).length;
      let kills = 0;
      let smokes = 0;
      let fires = 0;
      let flashes = 0;
      let hes = 0;
      let projectiles = 0;
      for (let r = 0; r < rounds.length; r++) {
        kills += tl.kills(r).length;
        const seen = new Set<string>();
        for (
          let t = rounds[r].start_tick;
          t <= rounds[r].post_end_tick;
          t += 8
        ) {
          for (const e of tl.effectsAt(r, t))
            seen.add(`${e.kind}:${e.startTick}:${e.entityId}`);
        }
        for (const k of seen) {
          if (k.startsWith('smoke')) smokes++;
          if (k.startsWith('fire')) fires++;
          if (k.startsWith('flash')) flashes++;
          if (k.startsWith('he')) hes++;
        }
        projectiles += pk.grenades.filter(
          (g) =>
            g.start_tick >= rounds[r].start_tick &&
            g.start_tick <= rounds[r].end_tick
        ).length;
      }
      expect(kills).toBe(count('player_death'));
      expect(smokes).toBe(count('smokegrenade_detonate'));
      expect(fires).toBe(count('inferno_startburn'));
      expect(flashes).toBe(count('flashbang_detonate'));
      expect(hes).toBe(count('hegrenade_detonate'));
      // The real match's own count; the synthetic one throws four a round.
      if (m.real) expect(projectiles).toBeGreaterThan(200);
      else expect(projectiles).toBe(4 * rounds.length);
      const exploded = rounds.filter(
        (r, i) => tl.bombAt(i, r.post_end_tick).kind === 'exploded'
      ).length;
      const planted = rounds.filter((r, i) =>
        ['planted', 'exploded', 'defused'].includes(
          tl.bombAt(i, r.post_end_tick).kind
        )
      ).length;
      expect(planted).toBe(count('bomb_planted'));
      expect(exploded).toBe(count('bomb_exploded'));
      // The synthetic match has every kind, so none of its counts above is vacuous. (A real
      // pack written before post_end_tick, such as mirage.dvpk.gz, ends round 6 before its bomb
      // explodes: no explosion is in a round.)
      if (!m.real)
        expect(
          Math.min(kills, smokes, fires, flashes, hes, planted, exploded)
        ).toBeGreaterThan(0);

      const r = Math.min(5, rounds.length - 1);
      const { value: n, ms } = cpuTimed(() => {
        let hits = 0;
        for (let t = rounds[r].start_tick; t <= rounds[r].end_tick; t += 2)
          hits += tl.effectsAt(r, t).length + tl.projectilesAt(r, t).length;
        return hits;
      });
      const per = ms / ((rounds[r].end_tick - rounds[r].start_tick) / 2);
      console.log(
        `${m.real ? 'real' : 'synthetic'} timeline: ${kills} kills, ${smokes} smokes, ${fires} fires, ${flashes} flashes, ${hes} HE, ${projectiles} grenades, ${planted} plants, ${exploded} explosions; effects+projectiles ${(per * 1000).toFixed(1)} µs of CPU per tick (${n} hits)`
      );
      expect(per).toBeLessThan(0.1);
    });
  });

describe('Timeline: the after-round', () => {
  it('keeps kills and effects after end_tick up to post_end_tick in the round', () => {
    const p = trackPack({
      players: [() => ({ x: 0, y: 0 }), () => ({ x: 100, y: 0 })],
      teams: [2, 3],
      events: [
        event('player_death', 1350, {
          user_idx: 1,
          attacker_idx: 0,
          weapon: 'ak47',
        }),
        event('smokegrenade_detonate', 1360, {
          entityid: 4,
          user_idx: 0,
          x: 0,
          y: 0,
          z: 0,
        }),
      ],
    });
    p.header.rounds[0].end_tick = 1300;
    const tl = new Timeline(p);
    expect(tl.kills(0).map((k) => k.tick)).toEqual([1350]);
    expect(tl.effectsAt(0, 1370).map((e) => e.kind)).toEqual(['smoke']);
    // The round is over from end_tick all the same.
    expect(tl.roundTimer(0, 1320).phase).toBe('over');
  });
});

describe('blinkOn', () => {
  it('blinks about once a second at the plant and eight times a second at the end', () => {
    const onsets: number[] = [];
    let was = false;
    for (let t = 0; t < BOMB_S; t += 0.0005) {
      const on = blinkOn(t);
      if (on && !was) onsets.push(t);
      was = on;
    }
    const first = onsets[1] - onsets[0];
    const last = onsets.at(-1)! - onsets.at(-2)!;
    expect(first).toBeGreaterThan(0.85);
    expect(first).toBeLessThanOrEqual(1);
    expect(last).toBeGreaterThanOrEqual(1 / BOMB_BLINK.to - 0.002);
    expect(last).toBeLessThan(1 / (BOMB_BLINK.to - 1));
  });
});
