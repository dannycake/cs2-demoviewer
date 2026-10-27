// A whole match made up in code, for the tests that check how the viewer reads a match (the
// timeline's counts, the scoreboard, the round summaries, the highlights, the director, the radar
// and the sound cues) without a real one: packs of real matches are never committed, so these
// tests otherwise ran only where DEMOVIEWER_PACK named one. Ten players on Mirage's ground plan
// (every position falls inside its radar square; nothing here is Valve's) play 8 rounds, sides
// swapped after 4. Each round: a buy in the freeze time (TRK2 money and gear follow it), a run
// from spawn to a site with a jump, a smoke, a flash, an HE and a molotov thrown and bouncing,
// shots, hurts and kills, and an end that cycles through a T win by elimination, a CT win by
// elimination, a bomb that explodes and a defuse. Deterministic: the same pack every call.

import {
  FLAG,
  GEAR,
  type Grenade,
  type Pack,
  type PackEvent,
  type PlayerTrack,
  type RoundInfo,
} from '../../src/pack/types';

export const SYNTHETIC = {
  rounds: 8,
  players: 10,
  tickRate: 64,
  tickStep: 2,
  /** The tick round 1 starts at; each later round starts a second after the last ends. */
  firstTick: 1000,
} as const;

const RATE = SYNTHETIC.tickRate;
const STEP = SYNTHETIC.tickStep;
const sec = (s: number) => Math.round((s * RATE) / STEP) * STEP;

const WEAPONS = [
  'none',
  'knife_t',
  'knife',
  'Glock-18',
  'USP-S',
  'AK-47',
  'M4A4',
  'Smoke Grenade',
  'Flashbang',
  'High Explosive Grenade',
  'Molotov',
  'C4 Explosive',
];
const W = Object.fromEntries(WEAPONS.map((w, i) => [w, i]));

type Vec = [number, number, number];
const SPAWN: Record<2 | 3, Vec> = {
  2: [1200, -150, -165],
  3: [-1700, -1900, -265],
};
const SITE: Record<'A' | 'B', Vec> = {
  A: [-400, -2050, -170],
  B: [-2050, 350, -160],
};
const RUN_SPEED = 220;
/** The weapon a throw's `weapon_fire` names. */
const CLASSNAME: Partial<Record<Grenade['kind'], string>> = {
  smoke: 'weapon_smokegrenade',
  flash: 'weapon_flashbang',
  he: 'weapon_hegrenade',
  molotov: 'weapon_molotov',
};

/** Who kills whom, by slot on each side ('t0' is the round's first T): a kill every 2.5 s. */
const SCENARIOS = [
  {
    winner: 2,
    reason: 'ct_killed',
    site: 'A',
    kills: ['t0>c0', 'c1>t1', 't2>c1', 't3>c2', 'c3>t4', 't0>c3', 't2>c4'],
  },
  {
    winner: 3,
    reason: 't_killed',
    site: 'B',
    kills: ['c0>t0', 't1>c0', 'c2>t1', 'c2>t2', 't3>c1', 'c4>t3', 'c2>t4'],
  },
  {
    winner: 2,
    reason: 'target_bombed',
    site: 'A',
    kills: ['t1>c0', 'c1>t2', 't3>c1'],
    plant: true,
  },
  {
    winner: 3,
    reason: 'bomb_defused',
    site: 'B',
    kills: ['c0>t1', 'c1>t2', 't3>c2', 'c3>t3', 'c4>t4', 'c0>t0'],
    plant: true,
    defuse: true,
  },
] as const;

const FREEZE_S = 5;
const FIRST_KILL_S = 15;
const KILL_EVERY_S = 2.5;
const PLANT_S = 20;
const BOMB_S = 40;
const DEFUSE_START_S = 31;
const DEFUSE_S = 5;
const POST_S = 3;

interface Hurt {
  tick: number;
  damage: number;
}

/** The round's plan for one player, from which each sample is drawn. */
interface Plan {
  team: 2 | 3;
  slot: number;
  from: Vec;
  to: Vec;
  /** Tick the run starts (the freeze end). */
  run: number;
  jump: number;
  death: number | null;
  hurts: Hurt[];
  bomb: { from: number; to: number } | null;
  defusing: { from: number; to: number } | null;
  money: { tick: number; money: number }[];
  gear: { tick: number; gear: number }[];
}

const lerp = (a: Vec, b: Vec, t: number): Vec => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Where `p` stands at `tick`: running from its spawn spot to its site spot, then holding. */
function placeAt(p: Plan, tick: number): Vec {
  const dist = Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]);
  const t = Math.max(0, tick - p.run) / RATE;
  return lerp(p.from, p.to, Math.min(1, (t * RUN_SPEED) / dist));
}

/** The value of the last `{tick, v}` at or before `tick`. */
function lastAt<T extends { tick: number }>(
  list: T[],
  tick: number,
  first: T
): T {
  let out = first;
  for (const e of list) if (e.tick <= tick) out = e;
  return out;
}

function track(p: Plan, round: RoundInfo): PlayerTrack {
  const n = round.samples;
  const t: PlayerTrack = {
    x: new Int16Array(n),
    y: new Int16Array(n),
    z: new Int16Array(n),
    yaw: new Int16Array(n),
    pitch: new Int16Array(n),
    health: new Uint8Array(n),
    armor: new Uint8Array(n),
    flags: new Uint8Array(n),
    duck: new Uint8Array(n),
    weapon: new Uint8Array(n),
    money: new Uint16Array(n),
    ammo: new Uint8Array(n),
    gear: new Uint8Array(n),
  };
  const heading =
    (Math.atan2(p.to[1] - p.from[1], p.to[0] - p.from[0]) * 180) / Math.PI;
  for (let k = 0; k < n; k++) {
    const tick = round.start_tick + k * STEP;
    const dead = p.death !== null && tick >= p.death;
    const at = placeAt(p, dead ? p.death! : tick);
    const air = !dead && tick > p.jump && tick < p.jump + sec(0.5);
    const lift = air
      ? 50 * Math.sin((Math.PI * (tick - p.jump)) / sec(0.5))
      : 0;
    t.x[k] = Math.round(at[0]);
    t.y[k] = Math.round(at[1]);
    t.z[k] = Math.round(at[2] + lift);
    t.yaw[k] = Math.round(heading * 100);
    const damage = p.hurts
      .filter((h) => h.tick <= tick)
      .reduce((s, h) => s + h.damage, 0);
    t.health[k] = dead ? 0 : Math.max(1, 100 - damage);
    t.armor[k] = dead || tick < round.start_tick + sec(1) ? 0 : 100;
    let flags = dead ? 0 : FLAG.alive;
    if (air) flags |= FLAG.airborne;
    if (!dead && p.bomb && tick >= p.bomb.from && tick < p.bomb.to)
      flags |= FLAG.bomb;
    if (!dead && p.defusing && tick >= p.defusing.from && tick < p.defusing.to)
      flags |= FLAG.defusing;
    t.flags[k] = flags;
    t.weapon[k] = dead ? 0 : p.team === 2 ? W['AK-47'] : W['M4A4'];
    t.money[k] = lastAt(p.money, tick, p.money[0]).money;
    t.ammo[k] = dead ? GEAR.ammoNone : 30;
    t.gear[k] = lastAt(p.gear, tick, p.gear[0]).gear;
  }
  return t;
}

/** A grenade's flight from `from` to `to` over `flightS`, bouncing once at 70 % of the way. */
function grenade(
  meta: Omit<Grenade, 'samples' | 'x' | 'y' | 'z'>,
  from: Vec,
  to: Vec,
  flightS: number
): Grenade {
  const flight = Math.round((flightS * RATE) / STEP);
  const samples = flight + 16;
  const g: Grenade = {
    ...meta,
    samples,
    x: new Int16Array(samples),
    y: new Int16Array(samples),
    z: new Int16Array(samples),
  };
  const bounce = lerp(from, to, 0.7);
  bounce[2] = to[2];
  const first = Math.round(flight * 0.7);
  for (let k = 0; k < samples; k++) {
    let p: Vec;
    if (k <= first) {
      const u = k / first;
      p = lerp(from, bounce, u);
      p[2] += 120 * Math.sin(Math.PI * u);
    } else if (k <= flight) {
      const u = (k - first) / (flight - first);
      p = lerp(bounce, to, u);
      p[2] += 30 * Math.sin(Math.PI * u);
    } else p = to;
    g.x[k] = Math.round(p[0]);
    g.y[k] = Math.round(p[1]);
    g.z[k] = Math.round(p[2]);
  }
  return g;
}

/** The synthetic match (see the head of this file). */
export function syntheticMatch(): Pack {
  const n = SYNTHETIC.players;
  const steamid = (p: number) => String(76561198000000000n + BigInt(p) * 7n);
  const teamOf = (p: number, r: number): 2 | 3 =>
    p < n / 2 === r < SYNTHETIC.rounds / 2 ? 2 : 3;
  const rounds: RoundInfo[] = [];
  const tracks: Pack['rounds'] = [];
  const events: PackEvent[] = [];
  const grenades: Grenade[] = [];
  const ev = (tick: number, kind: string, data: Record<string, unknown>) =>
    events.push({ tick, kind, data });
  let start = SYNTHETIC.firstTick;
  let score = { t: 0, ct: 0 };

  for (let r = 0; r < SYNTHETIC.rounds; r++) {
    const sc = SCENARIOS[r % SCENARIOS.length];
    const freeze = start + sec(FREEZE_S);
    const at = (s: number) => freeze + sec(s);
    const side = (team: 2 | 3) =>
      Array.from({ length: n }, (_, p) => p).filter(
        (p) => teamOf(p, r) === team
      );
    const ts = side(2);
    const cts = side(3);
    const bySlot = (s: string) => (s[0] === 't' ? ts : cts)[Number(s[1])];
    const site = SITE[sc.site];
    const startMoney = Math.min(16000, 800 + 1900 * r);

    const plans: Plan[] = Array.from({ length: n }, (_, p) => {
      const team = teamOf(p, r);
      const slot = (team === 2 ? ts : cts).indexOf(p);
      const spawn = SPAWN[team];
      return {
        team,
        slot,
        from: [spawn[0] + slot * 40, spawn[1] + slot * 60, spawn[2]],
        to: [
          site[0] + (slot - 2) * 80,
          site[1] + (team === 2 ? 150 : -150),
          site[2],
        ],
        run: freeze,
        jump: freeze + sec(3 + slot * 0.4),
        death: null,
        hurts: [],
        bomb: null,
        defusing: null,
        money: [{ tick: start, money: startMoney }],
        gear: [{ tick: start, gear: 0 }],
      };
    });

    // The countdown to the freeze end, as the game beeps it.
    for (const s of [3, 2, 1]) ev(freeze - sec(s), 'cs_round_start_beep', {});
    ev(freeze, 'cs_round_final_beep', {});

    // The buy: armour (a vest in the pistol round), then a rifle and a smoke or a kit.
    for (const p of plans) {
      const id = plans.indexOf(p);
      const list: [string, number][] =
        r === 0
          ? [['Kevlar Vest', 650]]
          : [
              ['Kevlar & Helmet', 1000],
              p.team === 2 ? ['AK-47', 2700] : ['M4A4', 2900],
              p.team === 2 ? ['Smoke Grenade', 300] : ['Defuse Kit', 400],
            ];
      let money = startMoney;
      let gear = 0;
      list.forEach(([item, cost], slot) => {
        const tick = start + sec(1 + p.slot * 0.25 + slot * 0.25);
        money -= cost;
        if (item === 'Kevlar & Helmet') gear |= GEAR.helmet;
        if (item === 'Defuse Kit') gear |= GEAR.kit;
        p.money.push({ tick, money });
        p.gear.push({ tick, gear });
        ev(tick, 'item_purchase', {
          steamid: steamid(id),
          item_name: item,
          inventory_slot: slot,
          was_sold: false,
        });
      });
    }

    const hurt = (
      tick: number,
      victim: number,
      attacker: number,
      damage: number,
      weapon: string,
      fatal = false
    ) => {
      const v = plans[victim];
      const before = 100 - v.hurts.reduce((s, h) => s + h.damage, 0);
      const dealt = fatal ? before : Math.min(damage, before - 1);
      v.hurts.push({ tick, damage: dealt });
      ev(tick, 'player_hurt', {
        user_idx: victim,
        attacker_idx: attacker,
        dmg_health: dealt,
        health: before - dealt,
        weapon,
        hitgroup: fatal ? 'head' : 'chest',
      });
    };

    // Utility before the first kill: a T smoke and flash, a CT HE, a T molotov.
    const throwAt = (
      kind: Grenade['kind'],
      who: number,
      s: number,
      flightS: number,
      off: [number, number]
    ) => {
      const tick = at(s);
      const from = placeAt(plans[who], tick);
      from[2] += 60;
      const to: Vec = [site[0] + off[0], site[1] + off[1], site[2]];
      const id = 1000 + grenades.length;
      const g = grenade(
        {
          entity_id: id,
          kind,
          thrower: who,
          start_tick: tick,
          detonate_tick: tick + sec(flightS),
          expire_tick: null,
        },
        from,
        to,
        flightS
      );
      grenades.push(g);
      ev(tick, 'weapon_fire', { user_idx: who, weapon: CLASSNAME[kind] });
      return {
        g,
        at: g.detonate_tick!,
        where: { x: to[0], y: to[1], z: to[2] },
      };
    };
    const smoke = throwAt('smoke', ts[1], 8, 1.5, [300, 200]);
    smoke.g.expire_tick = smoke.at + sec(18);
    ev(smoke.at, 'smokegrenade_detonate', {
      entityid: smoke.g.entity_id,
      user_idx: ts[1],
      ...smoke.where,
    });
    ev(smoke.g.expire_tick, 'smokegrenade_expired', {
      entityid: smoke.g.entity_id,
      ...smoke.where,
    });
    const flash = throwAt('flash', ts[2], 9, 1.6, [-200, 100]);
    ev(flash.at, 'flashbang_detonate', {
      entityid: flash.g.entity_id,
      user_idx: ts[2],
      ...flash.where,
    });
    ev(flash.at, 'player_blind', {
      user_idx: cts[0],
      attacker_idx: ts[2],
      blind_duration: 1.5,
      entityid: flash.g.entity_id,
    });
    const he = throwAt('he', cts[0], 10, 1.6, [100, 300]);
    ev(he.at, 'hegrenade_detonate', {
      entityid: he.g.entity_id,
      user_idx: cts[0],
      ...he.where,
    });
    hurt(he.at, ts[3], cts[0], 25, 'hegrenade');
    const molotov = throwAt('molotov', ts[3], 12, 1.2, [-100, -200]);
    const fire = { entityid: 5000 + r, ...molotov.where };
    molotov.g.expire_tick = molotov.at + sec(7);
    ev(molotov.at, 'inferno_startburn', { ...fire, user_idx: ts[3] });
    ev(molotov.g.expire_tick, 'inferno_expire', fire);
    hurt(molotov.at + sec(0.5), cts[1], ts[3], 10, 'inferno');

    // The kills, each after two shots and a hit: assisted every third, a headshot every other.
    let last = freeze;
    sc.kills.forEach((k, i) => {
      const [a, v] = k.split('>').map(bySlot);
      const tick = at(FIRST_KILL_S + i * KILL_EVERY_S);
      const gun = plans[a].team === 2 ? 'ak47' : 'm4a1';
      for (const dt of [16, 8, 0])
        ev(tick - dt, 'weapon_fire', { user_idx: a, weapon: `weapon_${gun}` });
      hurt(tick - 8, v, a, 40, gun);
      hurt(tick, v, a, 100, gun, true);
      const mates = (plans[a].team === 2 ? ts : cts).filter(
        (p) => p !== a && (plans[p].death === null || plans[p].death! > tick)
      );
      ev(tick, 'player_death', {
        user_idx: v,
        attacker_idx: a,
        assister_idx: i % 3 === 1 && mates.length ? mates[0] : null,
        weapon: gun,
        headshot: i % 2 === 0,
        penetrated: 0,
        noscope: false,
        thrusmoke: false,
        attackerblind: false,
        assistedflash: false,
      });
      plans[v].death = tick;
      last = tick;
    });

    // The bomb: carried by the first T from the start, planted at 20 s, then exploded or
    // defused; without a plant the carrier drops it where they die.
    const carrier = plans[ts[0]];
    let end = last;
    if ('plant' in sc) {
      const plant = at(PLANT_S);
      carrier.bomb = { from: start, to: plant };
      const siteId = sc.site === 'A' ? 0 : 1;
      ev(plant - sec(3), 'bomb_beginplant', { user_idx: ts[0], site: siteId });
      ev(plant, 'bomb_planted', { user_idx: ts[0], site: siteId });
      if ('defuse' in sc) {
        const from = at(DEFUSE_START_S);
        end = from + sec(DEFUSE_S);
        plans[cts[0]].defusing = { from, to: end };
        ev(from, 'bomb_begindefuse', { user_idx: cts[0], haskit: true });
        ev(end, 'bomb_defused', { user_idx: cts[0], site: siteId });
      } else {
        end = plant + sec(BOMB_S);
        ev(end, 'bomb_exploded', { user_idx: ts[0], site: siteId });
      }
    } else {
      carrier.bomb = { from: start, to: carrier.death ?? Infinity };
      if (carrier.death !== null)
        ev(carrier.death, 'bomb_dropped', { user_idx: ts[0] });
    }
    ev(end, 'round_end', { winner: sc.winner, reason: sc.reason });
    if (sc.winner === 2) score = { ...score, t: score.t + 1 };
    else score = { ...score, ct: score.ct + 1 };

    const postEnd = end + sec(POST_S);
    const info: RoundInfo = {
      number: r + 1,
      start_tick: start,
      freeze_end_tick: freeze,
      end_tick: end,
      winner: sc.winner,
      reason: sc.reason,
      score_t: score.t,
      score_ct: score.ct,
      samples: (postEnd - start) / STEP + 1,
      post_end_tick: postEnd,
    };
    rounds.push(info);
    tracks.push({ players: plans.map((p) => track(p, info)) });
    start = postEnd + sec(1);
  }

  return {
    header: {
      version: 1,
      map: 'de_mirage',
      server_name: 'synthetic',
      game_build: '0',
      tick_rate: RATE,
      sample_hz: RATE / STEP,
      tick_step: STEP,
      players: Array.from({ length: n }, (_, p) => ({
        steamid: steamid(p),
        name: `Player ${p + 1}`,
        team_by_round: rounds.map((_, r) => teamOf(p, r)),
        crosshair: null,
      })),
      rounds,
      weapons: WEAPONS,
    },
    rounds: tracks,
    // In tick order, as the server writes them; events of one tick keep the order made.
    events: events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.tick - b.e.tick || a.i - b.i)
      .map(({ e }) => e),
    grenades: grenades.sort((a, b) => a.start_tick - b.start_tick),
    inventory: [],
    entities: [],
    entityChanges: [],
    ground: [],
  };
}
