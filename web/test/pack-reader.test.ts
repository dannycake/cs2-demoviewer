import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inflateIfGzip, PackError, parsePack } from '../src/pack/reader';
import { readFileSync } from 'node:fs';
import {
  killfeedRows,
  markers,
  roundBarModel,
  roundFeedRows,
  roundStripModel,
} from '../src/components/hud/models';
import { timelineFor } from '../src/sim/timeline';
import {
  GEAR,
  zoomOf,
  type GroundItem,
  type MapEntity,
  type MapEntityChange,
  type Pack,
  type PackEvent,
} from '../src/pack/types';
import {
  buildHeader,
  buildPack,
  extraValue,
  groundRuns,
  grenadeMetas,
  grenadeValue,
  I16_COLUMNS,
  i16Value,
  U8_COLUMNS,
  u8Value,
  type BuildOptions,
} from './helpers/build-pack';
import { needs } from './helpers/gates';

const EVENTS: PackEvent[] = [
  { tick: 101, kind: 'round_freeze_end', data: {} },
  {
    tick: 103,
    kind: 'player_death',
    data: {
      attacker: 0,
      victim: 1,
      weapon: 'ak47',
      headshot: true,
      note: 'é ✓',
    },
  },
];

// The plan's minimal pack: 2 players, one round of 3 samples (odd, so every column after
// the first u8 block starts at an odd offset), events and one grenade.
const BASE: BuildOptions = {
  players: 2,
  rounds: [{ samples: 3, start_tick: 100 }],
  tick_step: 2,
  events: EVENTS,
  grenades: [
    {
      samples: 2,
      kind: 'flash',
      thrower: 1,
      detonate_tick: null,
      expire_tick: null,
    },
  ],
};

const parse = (o: Partial<BuildOptions> = {}) =>
  parsePack(buildPack({ ...BASE, ...o }));

function expectTracks(o: BuildOptions, pack: ReturnType<typeof parsePack>) {
  expect(pack.rounds).toHaveLength(o.rounds.length);
  o.rounds.forEach((round, r) => {
    expect(pack.rounds[r].players).toHaveLength(o.players);
    for (let p = 0; p < o.players; p++) {
      const t = pack.rounds[r].players[p];
      const k = Array.from({ length: round.samples }, (_, i) => i);
      I16_COLUMNS.forEach((name, c) => {
        expect(t[name]).toBeInstanceOf(Int16Array);
        expect(Array.from(t[name])).toEqual(k.map((i) => i16Value(r, p, c, i)));
      });
      U8_COLUMNS.forEach((name, c) => {
        expect(t[name]).toBeInstanceOf(Uint8Array);
        expect(Array.from(t[name])).toEqual(k.map((i) => u8Value(r, p, c, i)));
      });
    }
  });
}

describe('parsePack', () => {
  it('round-trips the header', () => {
    expect(parse().header).toEqual(buildHeader(BASE));
  });

  it('keeps 64-bit steam ids exact as strings', () => {
    expect(parse().header.players[1].steamid).toBe('76561199000000007');
  });

  it('reads track columns at unaligned offsets', () => {
    const pack = parse();
    expect(pack.rounds[0].players[1].x[2]).toBe(i16Value(0, 1, 0, 2));
    expectTracks(BASE, pack);
  });

  it('reads several rounds of different lengths, including an empty one', () => {
    const o: BuildOptions = {
      ...BASE,
      players: 3,
      rounds: [
        { samples: 5, start_tick: 100 },
        { samples: 0, start_tick: 400 },
        { samples: 2, start_tick: 900 },
      ],
    };
    expectTracks(o, parsePack(buildPack(o)));
  });

  it('round-trips events and grenades', () => {
    const o: BuildOptions = {
      ...BASE,
      grenades: [
        {
          samples: 2,
          kind: 'flash',
          thrower: 1,
          detonate_tick: null,
          expire_tick: null,
        },
        {
          samples: 3,
          kind: 'molotov',
          thrower: 255,
          detonate_tick: 250,
          expire_tick: 700,
        },
        { samples: 0, kind: 'decoy' },
      ],
    };
    const pack = parsePack(buildPack(o));
    expect(pack.events).toEqual(EVENTS);
    const metas = grenadeMetas(o);
    expect(pack.grenades).toHaveLength(3);
    pack.grenades.forEach((g, i) => {
      const { x, y, z, ...meta } = g;
      expect(meta).toEqual(metas[i]);
      [x, y, z].forEach((col, c) => {
        expect(col).toBeInstanceOf(Int16Array);
        expect(Array.from(col)).toEqual(
          Array.from({ length: metas[i].samples }, (_, k) =>
            grenadeValue(i, c, k)
          )
        );
      });
    });
  });

  it('copies columns into fresh, transferable buffers', () => {
    const bytes = buildPack(BASE);
    const pack = parsePack(bytes);
    const t = pack.rounds[0].players[1];
    const g = pack.grenades[0];
    const buffers = [
      ...[t.x, t.y, t.pitch, t.health, t.weapon, g.x, g.z].map((a) => a.buffer),
    ];
    for (const b of buffers) expect(b).not.toBe(bytes.buffer);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(t.x.byteOffset).toBe(0);
    expect(t.x.buffer.byteLength).toBe(t.x.byteLength);
  });

  it('reads a pack that is a view into a larger buffer', () => {
    const bytes = buildPack(BASE);
    const host = new Uint8Array(bytes.length + 7);
    host.set(bytes, 3);
    const pack = parsePack(host.subarray(3, 3 + bytes.length));
    expect(pack.header.map).toBe('de_test');
    expectTracks(BASE, pack);
  });

  it('ignores unknown sections', () => {
    const pack = parse({
      order: ['XTRA', 'HDR1', 'TRK1', 'EVT1', 'ZZZ9', 'GRN1', 'GRB1'],
    });
    expectTracks(BASE, pack);
  });

  it('accepts the sections in another valid order', () => {
    const pack = parse({ order: ['GRN1', 'HDR1', 'EVT1', 'GRB1', 'TRK1'] });
    expect(pack.events).toEqual(EVENTS);
    expectTracks(BASE, pack);
  });

  it('refuses a bad magic', () => {
    expect(() => parse({ magic: 'DVPX' })).toThrow(PackError);
    expect(() => parse({ magic: 'DVPX' })).toThrow(/magic/);
  });

  it('refuses bytes too short to hold the preamble', () => {
    expect(() => parsePack(new Uint8Array([0x44, 0x56, 0x50]))).toThrow(
      /magic/
    );
  });

  it('refuses a version other than 1', () => {
    expect(() => parse({ version: 2 })).toThrow(/version/);
    expect(() => parse({ header: { version: 2 } })).toThrow(/version/);
  });

  it('refuses a TRK1 one byte short', () => {
    expect(() => parse({ trim: { TRK1: 1 } })).toThrow(/TRK1/);
  });

  it('refuses a GRB1 one byte short', () => {
    expect(() => parse({ trim: { GRB1: 1 } })).toThrow(/GRB1/);
  });

  it('refuses a TRK1 before HDR1 and a GRB1 before GRN1', () => {
    expect(() =>
      parse({ order: ['TRK1', 'HDR1', 'EVT1', 'GRN1', 'GRB1'] })
    ).toThrow(/TRK1.*HDR1/);
    expect(() =>
      parse({ order: ['HDR1', 'TRK1', 'EVT1', 'GRB1', 'GRN1'] })
    ).toThrow(/GRB1.*GRN1/);
  });

  it('refuses a missing section', () => {
    const all = ['HDR1', 'TRK1', 'EVT1', 'GRN1', 'GRB1'];
    for (const tag of ['TRK1', 'EVT1', 'GRB1']) {
      expect(() => parse({ order: all.filter((t) => t !== tag) }), tag).toThrow(
        `missing ${tag} section`
      );
    }
    // Without HDR1 (GRN1) the TRK1 (GRB1) that depends on it is refused first, as in read.rs.
    expect(() => parse({ order: all.filter((t) => t !== 'HDR1') })).toThrow(
      /HDR1/
    );
    expect(() => parse({ order: ['EVT1', 'GRN1', 'GRB1'] })).toThrow(
      'missing HDR1 section'
    );
    expect(() => parse({ order: all.filter((t) => t !== 'GRN1') })).toThrow(
      /GRN1/
    );
    expect(() => parse({ order: ['HDR1', 'TRK1', 'EVT1'] })).toThrow(
      'missing GRN1 section'
    );
  });

  it('refuses a duplicate section', () => {
    expect(() =>
      parse({ order: ['HDR1', 'TRK1', 'EVT1', 'EVT1', 'GRN1', 'GRB1'] })
    ).toThrow(/duplicate EVT1/);
  });

  it('refuses a section whose length runs past the end', () => {
    const bytes = buildPack(BASE);
    expect(() => parsePack(bytes.subarray(0, bytes.length - 1))).toThrow(
      /GRB1.*truncated/
    );
    expect(() => parsePack(bytes.subarray(0, 6 + 2))).toThrow(/truncated/);
  });

  it('refuses a header that is not JSON', () => {
    const bytes = buildPack(BASE);
    bytes[6 + 12] = 0x7b + 1; // first byte of the HDR1 payload: '{' -> '|'
    expect(() => parsePack(bytes)).toThrow(/HDR1/);
  });

  it('refuses the header rules the writer enforces', () => {
    expect(() => parse({ header: { weapons: ['ak47', 'none'] } })).toThrow(
      /weapons\[0\]/
    );
    expect(() => parse({ header: { tick_step: 0 } })).toThrow(/tick_step/);
    const header = buildHeader(BASE);
    header.players[0].team_by_round = [2, 3];
    expect(() => parse({ header: { players: header.players } })).toThrow(
      /team_by_round/
    );
  });

  it('refuses a tick rate, sample rate or tick step that is not a positive integer (a u32)', () => {
    /** The header with `key` written as the raw JSON `raw` (`1e999` parses to Infinity). */
    const withRaw = (key: string, raw: string) => {
      const text = JSON.stringify({ ...buildHeader(BASE), [key]: '@' });
      return parse({
        payload: {
          HDR1: new TextEncoder().encode(text.replace('"@"', raw)),
        },
      });
    };
    for (const key of ['tick_rate', 'sample_hz', 'tick_step'])
      for (const raw of [
        '0',
        '-64',
        '1e999',
        '-1e999',
        '"64"',
        'null',
        '1.5',
        '4294967296',
      ]) {
        expect(() => withRaw(key, raw), `${key} = ${raw}`).toThrow(PackError);
        expect(() => withRaw(key, raw), `${key} = ${raw}`).toThrow(
          new RegExp(`header\\.${key} is not a positive integer`)
        );
      }
    expect(() => parse({ header: { tick_rate: 2000 } })).toThrow(
      /header\.tick_rate is over 1024/
    );
    expect(() => parse({ header: { sample_hz: 128 } })).toThrow(
      /header\.sample_hz is over header\.tick_rate/
    );
    // A real pack's: 64 ticks a second, sampled at 32 Hz every 2 ticks.
    expect(parse().header).toMatchObject({
      tick_rate: 64,
      sample_hz: 32,
      tick_step: 2,
    });
    expect(withRaw('sample_hz', '32').header.sample_hz).toBe(32);
  });

  it('refuses a weapon index out of range', () => {
    expect(() =>
      parse({ weapon: (_r, p, k) => (p === 1 && k === 2 ? 4 : 0) })
    ).toThrow(/weapon index 4/);
  });

  it('refuses a grenade thrower that is neither a player nor 255', () => {
    expect(() => parse({ grenades: [{ samples: 1, thrower: 2 }] })).toThrow(
      /thrower/
    );
    expect(
      parse({ grenades: [{ samples: 1, thrower: 255 }] }).grenades[0].thrower
    ).toBe(255);
  });
});

describe('inflateIfGzip', () => {
  it('inflates gzip bytes', async () => {
    const plain = buildPack(BASE);
    const gz = new Uint8Array(gzipSync(plain));
    expect(gz[0]).toBe(0x1f);
    const out = await inflateIfGzip(gz);
    expect(out).toEqual(plain);
    expect(parsePack(out).header.map).toBe('de_test');
  });

  it('returns plain bytes unchanged', async () => {
    const plain = buildPack(BASE);
    expect(await inflateIfGzip(plain)).toBe(plain);
  });

  it('rejects corrupt gzip with a PackError', async () => {
    const gz = new Uint8Array(gzipSync(buildPack(BASE)));
    await expect(inflateIfGzip(gz.subarray(0, gz.length - 9))).rejects.toThrow(
      PackError
    );
  });
});

describe('parsePack: money, ammo, gear, inventory, crosshair, after-round', () => {
  const ROUNDS = [
    { samples: 4, start_tick: 100 },
    { samples: 3, start_tick: 200 },
  ];
  const base: BuildOptions = { players: 2, rounds: ROUNDS, tick_step: 2 };
  const ALL = ['HDR1', 'TRK1', 'EVT1', 'GRN1', 'GRB1', 'TRK2', 'INV1'];
  const inventory = [
    { round: 0, player: 1, tick: 100, items: [3, 1] },
    { round: 1, player: 0, tick: 202, items: [] },
  ];
  // A header as written before the optional fields existed.
  const oldHeader = () => {
    const h = buildHeader(base);
    return {
      players: h.players.map(({ steamid, name, team_by_round }) => ({
        steamid,
        name,
        team_by_round,
      })),
      rounds: h.rounds.map((r) => {
        const old: Partial<typeof r> = { ...r };
        delete old.post_end_tick;
        return old;
      }),
    };
  };

  it('fills defaults for a pack written before the optional data', () => {
    const pack = parsePack(buildPack({ ...base, header: oldHeader() }));
    expect(pack.inventory).toEqual([]);
    for (const [r, round] of pack.rounds.entries()) {
      expect(pack.header.rounds[r].post_end_tick).toBe(
        pack.header.rounds[r].end_tick
      );
      for (const t of round.players) {
        expect([...t.money]).toEqual(new Array(ROUNDS[r].samples).fill(0));
        expect([...t.ammo]).toEqual(
          new Array(ROUNDS[r].samples).fill(GEAR.ammoNone)
        );
        expect([...t.gear]).toEqual(new Array(ROUNDS[r].samples).fill(0));
      }
    }
    expect(pack.header.players.map((p) => p.crosshair)).toEqual([null, null]);
  });

  it('reads TRK2 columns, INV1, the crosshair and the after-round end', () => {
    const header = {
      players: buildHeader(base).players.map((p, i) => ({
        ...p,
        crosshair: i === 0 ? 'CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB' : undefined,
      })),
      rounds: buildHeader(base).rounds.map((r) => ({
        ...r,
        post_end_tick: r.end_tick + 40,
      })),
    };
    const pack = parsePack(
      buildPack({ ...base, order: ALL, inventory, header })
    );
    pack.rounds.forEach((round, r) =>
      round.players.forEach((t, p) => {
        for (let k = 0; k < ROUNDS[r].samples; k++) {
          expect(t.money[k]).toBe(extraValue(r, p, 0, k));
          expect(t.ammo[k]).toBe(extraValue(r, p, 1, k));
          expect(t.gear[k]).toBe(extraValue(r, p, 2, k));
        }
      })
    );
    expect(pack.inventory).toEqual(inventory);
    expect(pack.header.players[0].crosshair).toBe(
      'CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB'
    );
    expect(pack.header.players[1].crosshair).toBeNull();
    expect(pack.header.rounds[0].post_end_tick).toBe(
      pack.header.rounds[0].end_tick + 40
    );
  });

  it('decodes the gear bits', () => {
    expect(zoomOf(GEAR.helmet | (2 << GEAR.zoomShift))).toBe(2);
    expect(zoomOf(GEAR.kit)).toBe(0);
  });

  it('refuses a TRK2 before TRK1, a short TRK2, a duplicate one, and broken INV1 or after-round data', () => {
    expect(() =>
      parsePack(
        buildPack({
          ...base,
          order: ['HDR1', 'TRK2', 'TRK1', 'EVT1', 'GRN1', 'GRB1'],
        })
      )
    ).toThrow(/TRK2 section before TRK1/);
    expect(() =>
      parsePack(buildPack({ ...base, order: ALL, trim: { TRK2: 1 } }))
    ).toThrow(/TRK2 is/);
    expect(() =>
      parsePack(buildPack({ ...base, order: [...ALL, 'TRK2'] }))
    ).toThrow(/duplicate TRK2/);
    expect(() =>
      parsePack(
        buildPack({
          ...base,
          order: ALL,
          inventory: [{ round: 0, player: 9, tick: 1, items: [] }],
        })
      )
    ).toThrow(/inventory 0/);
    expect(() =>
      parsePack(
        buildPack({
          ...base,
          order: ALL,
          inventory: [{ round: 0, player: 0, tick: 1, items: [99] }],
        })
      )
    ).toThrow(/weapon index 99/);
    expect(() =>
      parsePack(
        buildPack({ ...base, order: ALL, inventory: [{ round: 0 } as never] })
      )
    ).toThrow(/INV1\[0\]/);
    const rounds = buildHeader(base).rounds.map((r) => ({
      ...r,
      post_end_tick: r.end_tick - 1,
    }));
    expect(() => parsePack(buildPack({ ...base, header: { rounds } }))).toThrow(
      /post_end_tick/
    );
  });
});

describe('parsePack: doors and breakables (ENT1)', () => {
  const ROUNDS = [
    { samples: 4, start_tick: 100 },
    { samples: 3, start_tick: 200 },
  ];
  const base: BuildOptions = { players: 2, rounds: ROUNDS, tick_step: 2 };
  const ORDER = [
    'HDR1',
    'TRK1',
    'EVT1',
    'GRN1',
    'GRB1',
    'TRK2',
    'INV1',
    'ENT1',
  ];
  const entities: MapEntity[] = [
    { kind: 'door', x: 257, y: -1310, z: -416 },
    { kind: 'breakable', x: 1415, y: -391, z: -341 },
  ];
  const changes: MapEntityChange[] = [
    { round: 0, entity: 0, tick: 100, pitch: 0, yaw: 0, roll: 0, gone: false },
    {
      round: 0,
      entity: 0,
      tick: 129,
      pitch: 0,
      yaw: -9000,
      roll: 0,
      gone: false,
    },
    { round: 1, entity: 1, tick: 204, pitch: 0, yaw: 0, roll: 0, gone: true },
  ];

  it('decodes the entities and their changes', () => {
    const pack = parsePack(
      buildPack({ ...base, order: ORDER, mapEntities: { entities, changes } })
    );
    expect(pack.entities).toEqual(entities);
    expect(pack.entityChanges).toEqual(changes);
  });

  it('has none in a pack without the section', () => {
    const pack = parsePack(buildPack(base));
    expect(pack.entities).toEqual([]);
    expect(pack.entityChanges).toEqual([]);
  });

  it('refuses a change out of range or out of order, a broken section and a second one', () => {
    const build = (c: MapEntityChange[], order = ORDER) =>
      parsePack(
        buildPack({ ...base, order, mapEntities: { entities, changes: c } })
      );
    expect(() => build([{ ...changes[0], entity: 2 }])).toThrow(
      /map change 0: round 0 entity 2 out of range/
    );
    expect(() => build([{ ...changes[0], round: 2 }])).toThrow(
      /map change 0: round 2 entity 0 out of range/
    );
    expect(() => build([changes[1], changes[0]])).toThrow(
      /map changes 0 and 1 out of order/
    );
    expect(() => build(changes, [...ORDER, 'ENT1'])).toThrow(/duplicate ENT1/);
    expect(() =>
      build([{ ...changes[0], gone: 'yes' } as unknown as MapEntityChange])
    ).toThrow(/ENT1 changes\[0\]/);
    expect(() =>
      parsePack(
        buildPack({
          ...base,
          order: ORDER,
          mapEntities: {
            entities: [{ kind: 'window', x: 0, y: 0, z: 0 } as never],
            changes: [],
          },
        })
      )
    ).toThrow(/ENT1 entities\[0\]/);
  });
});

describe('parsePack: ground items (GND1 + GNB1)', () => {
  const ROUNDS = [
    { samples: 4, start_tick: 100 },
    { samples: 3, start_tick: 200 },
  ];
  // weapons: none, ak47, m4a1, knife
  const base: BuildOptions = { players: 2, rounds: ROUNDS, tick_step: 2 };
  const ORDER = [
    'HDR1',
    'TRK1',
    'EVT1',
    'GRN1',
    'GRB1',
    'TRK2',
    'INV1',
    'ENT1',
    'GND1',
    'GNB1',
  ];
  const item = (
    round: number,
    id: number,
    weapon: number,
    tick: number,
    x: number,
    yaw: number,
    gone = false
  ): GroundItem => ({
    round,
    id,
    weapon,
    tick,
    x,
    y: -1 - x,
    z: 7,
    pitch: 100,
    yaw,
    roll: 0 - yaw,
    gone,
  });
  // Two runs of one AK (picked up, dropped again under the same id), a second item, and
  // keys whose differences wrap: ticks and positions from one end of their range to the other.
  const ground: GroundItem[] = [
    item(0, 255, 1, 102, -1000, 17000),
    item(0, 255, 1, 104, -990, -17000),
    item(0, 255, 1, 130, -990, -17000, true),
    item(0, 255, 1, 140, 500, 0),
    item(0, 300, 2, -2147483648, -32768, -18000 + 1),
    item(0, 300, 2, 2147483647, 32767, 18000),
    item(1, 12, 1, 204, 0, 0),
  ];

  const build = (o: Partial<BuildOptions> = {}) =>
    parsePack(buildPack({ ...base, order: ORDER, ground, ...o }));

  it('decodes the keys, differences and all, in order', () => {
    expect(groundRuns(ground)).toHaveLength(3);
    expect(build().ground).toEqual(ground);
  });

  it('has none in a pack without the sections', () => {
    expect(parsePack(buildPack(base)).ground).toEqual([]);
    expect(
      parsePack(buildPack({ ...base, order: ORDER.slice(0, -2) })).ground
    ).toEqual([]);
  });

  it('refuses one section without the other, out of order, or twice', () => {
    const without = (tag: string) => ORDER.filter((t) => t !== tag);
    expect(() => build({ order: without('GND1') })).toThrow(
      /GNB1 section before GND1/
    );
    expect(() => build({ order: without('GNB1') })).toThrow(
      /missing GNB1 section/
    );
    expect(() =>
      build({ order: [...ORDER.slice(0, -2), 'GNB1', 'GND1'] })
    ).toThrow(/GNB1 section before GND1/);
    expect(() => build({ order: [...ORDER, 'GND1'] })).toThrow(
      /duplicate GND1/
    );
    expect(() => build({ order: [...ORDER, 'GNB1'] })).toThrow(
      /duplicate GNB1/
    );
  });

  it('refuses columns of the wrong length, before reading them', () => {
    // The Rust reader's wording (read.rs `expect_len`).
    expect(() => build({ trim: { GNB1: 1 } })).toThrow(
      /GNB1 is 118 bytes, header implies 119/
    );
    // Key counts whose total no length can match, each a u32 as serde reads it: refused by
    // the arithmetic (the total past 2^53 bytes), not by an allocation.
    const runs = Array.from({ length: 124_000 }, (_, i) => ({
      round: 0,
      id: i & 0xffff,
      weapon: 1,
      keys: 0xffffffff,
    }));
    const many = new TextEncoder().encode(JSON.stringify(runs));
    expect(() => build({ payload: { GND1: many } })).toThrow(
      /^GNB1 size overflows$/
    );
  });

  it('refuses a gone byte other than 0 or 1, and a run that is not {round, id, weapon, keys}', () => {
    const gnb = buildPack({ ...base, order: ['GNB1'], ground }).subarray(18);
    const bad = gnb.slice();
    bad[bad.length - 1] = 2;
    expect(() => build({ payload: { GNB1: bad } })).toThrow(
      /GNB1 gone byte 2, not 0 or 1/
    );
    const run = (r: Record<string, unknown>) =>
      new TextEncoder().encode(JSON.stringify([r]));
    expect(() =>
      build({
        ground: [],
        payload: { GND1: run({ round: 0, id: 1, weapon: 1, keys: -1 }) },
      })
    ).toThrow(/GND1\[0\]/);
    // Wider than serde's GroundRun (round u16, id u16, weapon u8, keys u32).
    for (const r of [
      { round: 0, id: 70000, weapon: 1, keys: 0 },
      { round: 0, id: 1, weapon: 300, keys: 0 },
      { round: 0x10000, id: 1, weapon: 1, keys: 0 },
      { round: 0, id: 1, weapon: 1, keys: 2 ** 32 },
      { round: 0, id: 1, weapon: 1, keys: 2 ** 53 },
    ]) {
      expect(() => build({ ground: [], payload: { GND1: run(r) } })).toThrow(
        /GND1\[0\] is not \{round, id, weapon, keys\}/
      );
    }
  });

  it('refuses weapon 0, a weapon or round out of range, and keys out of order', () => {
    const one = (g: Partial<GroundItem>) => [{ ...ground[0], ...g }];
    expect(() => build({ ground: one({ weapon: 0 }) })).toThrow(
      /ground item 0: weapon index 0 not in 1\.\.4/
    );
    expect(() => build({ ground: one({ weapon: 4 }) })).toThrow(
      /ground item 0: weapon index 4 not in 1\.\.4/
    );
    expect(() => build({ ground: one({ round: 2 }) })).toThrow(
      /ground item 0: round 2 out of range/
    );
    expect(() => build({ ground: [ground[1], ground[0]] })).toThrow(
      /ground items 0 and 1 out of order/
    );
  });
});

describe("parsePack: the JSON sections' field types (serde's, in read.rs)", () => {
  // One round with a kill, a plant and a thrown grenade in it, so the models below have
  // something to draw.
  const base: BuildOptions = {
    players: 2,
    rounds: [
      { samples: 50, start_tick: 100 },
      { samples: 20, start_tick: 300 },
    ],
    tick_step: 2,
    events: [
      { tick: 110, kind: 'round_freeze_end', data: {} },
      {
        tick: 150,
        kind: 'player_death',
        data: { user_idx: 1, attacker_idx: 0, weapon: 'ak47', headshot: true },
      },
      { tick: 160, kind: 'bomb_planted', data: { user_idx: 0, site: 1 } },
    ],
    grenades: [
      {
        samples: 3,
        kind: 'he',
        thrower: 0,
        start_tick: 120,
        detonate_tick: 125,
      },
    ],
  };

  interface Sections {
    header: Record<string, unknown>;
    events: Record<string, unknown>[];
    grenades: Record<string, unknown>[];
  }

  /** `base` with its HDR1, EVT1 and GRN1 JSON changed by `edit` before they are written. */
  function edited(edit: (j: Sections) => void): Uint8Array {
    const j = structuredClone({
      header: buildHeader(base),
      events: base.events!,
      grenades: grenadeMetas(base),
    }) as unknown as Sections;
    edit(j);
    const text = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    return buildPack({
      ...base,
      payload: {
        HDR1: text(j.header),
        EVT1: text(j.events),
        GRN1: text(j.grenades),
      },
    });
  }

  const round = (j: Sections, r = 0) =>
    (j.header.rounds as Record<string, unknown>[])[r];
  const player = (j: Sections, p = 0) =>
    (j.header.players as Record<string, unknown>[])[p];

  it('reads the unedited sections', () => {
    const pack = parsePack(edited(() => {}));
    expect(pack.events).toHaveLength(3);
    expect(pack.grenades[0]).toMatchObject({ kind: 'he', detonate_tick: 125 });
  });

  it('refuses an event with no data, or data that is not an object', () => {
    expect(() => parsePack(edited((j) => delete j.events[1].data))).toThrow(
      /EVT1\[1\]\.data is not an object/
    );
    for (const data of [null, [], 'x', 1])
      expect(() => parsePack(edited((j) => (j.events[1].data = data)))).toThrow(
        /EVT1\[1\]\.data is not an object/
      );
    expect(() =>
      parsePack(edited((j) => (j.events[2] = null as never)))
    ).toThrow(/EVT1\[2\] is not an object/);
  });

  it('refuses an event whose tick is not an i32 or whose kind is not a string', () => {
    for (const tick of ['150', 1.5, 2 ** 31, null])
      expect(() => parsePack(edited((j) => (j.events[1].tick = tick)))).toThrow(
        /EVT1\[1\]\.tick is not an i32/
      );
    expect(() => parsePack(edited((j) => (j.events[0].kind = 7)))).toThrow(
      /EVT1\[0\]\.kind is not a string/
    );
  });

  it('refuses a round without a start tick, or with ticks that are not i32s', () => {
    expect(() => parsePack(edited((j) => delete round(j).start_tick))).toThrow(
      /header\.rounds\[0\]\.start_tick is not an i32/
    );
    for (const key of ['start_tick', 'freeze_end_tick', 'end_tick'])
      for (const v of ['100', 100.5, null, 2 ** 31])
        expect(() => parsePack(edited((j) => (round(j, 1)[key] = v)))).toThrow(
          new RegExp(`header\\.rounds\\[1\\]\\.${key} is not an i32`)
        );
    // post_end_tick may be absent or null (an older pack's): it is end_tick then.
    expect(
      parsePack(edited((j) => (round(j).post_end_tick = null))).header.rounds[0]
        .post_end_tick
    ).toBe(198);
    expect(() =>
      parsePack(edited((j) => (round(j).post_end_tick = '198')))
    ).toThrow(/header\.rounds\[0\]\.post_end_tick is not an i32 or null/);
  });

  it("refuses a round's number, winner, reason, scores or samples of the wrong type", () => {
    const cases: [string, unknown, RegExp][] = [
      ['number', 70000, /\.number is not a u16/],
      ['winner', '2', /\.winner is not a u8/],
      ['winner', 256, /\.winner is not a u8/],
      ['reason', 3, /\.reason is not a string/],
      ['reason', undefined, /\.reason is not a string/],
      ['score_t', -1, /\.score_t is not a u8/],
      ['score_ct', 1.5, /\.score_ct is not a u8/],
      ['samples', '50', /\.samples is not a u32/],
    ];
    for (const [key, v, message] of cases)
      expect(() => parsePack(edited((j) => (round(j)[key] = v)))).toThrow(
        message
      );
  });

  it("refuses a player's steamid, name, teams or crosshair of the wrong type", () => {
    const cases: [string, unknown, RegExp][] = [
      ['steamid', 76561198000000000, /\.steamid is not a u64/],
      ['steamid', '7656x', /\.steamid is not a u64/],
      ['steamid', '18446744073709551616', /\.steamid is not a u64/],
      ['name', undefined, /\.name is not a string/],
      ['name', 5, /\.name is not a string/],
      ['team_by_round', [2, '3'], /\.team_by_round is not an array of u8/],
      ['team_by_round', [2, 300], /\.team_by_round is not an array of u8/],
      ['crosshair', 12, /\.crosshair is not a string or null/],
    ];
    for (const [key, v, message] of cases)
      expect(() => parsePack(edited((j) => (player(j, 1)[key] = v)))).toThrow(
        message
      );
    expect(
      parsePack(edited((j) => (player(j).steamid = '18446744073709551615')))
        .header.players[0].steamid
    ).toBe('18446744073709551615');
    expect(
      parsePack(edited((j) => delete player(j).crosshair)).header.players[0]
        .crosshair
    ).toBeNull();
  });

  it("refuses the header's names and weapons when they are not strings", () => {
    for (const key of ['map', 'server_name', 'game_build'])
      expect(() => parsePack(edited((j) => (j.header[key] = 1)))).toThrow(
        new RegExp(`header\\.${key} is not a string`)
      );
    expect(() =>
      parsePack(edited((j) => ((j.header.weapons as unknown[])[2] = 2)))
    ).toThrow(/header\.weapons\[2\] is not a string/);
  });

  it('refuses a grenade with fields of the wrong type', () => {
    const cases: [string, unknown, RegExp][] = [
      ['kind', 1, /GRN1\[0\]\.kind is not a string/],
      ['kind', null, /GRN1\[0\]\.kind is not a string/],
      ['entity_id', '100', /GRN1\[0\]\.entity_id is not an i32/],
      ['thrower', -1, /GRN1\[0\]\.thrower is not a u8/],
      ['start_tick', undefined, /GRN1\[0\]\.start_tick is not an i32/],
      ['detonate_tick', '125', /GRN1\[0\]\.detonate_tick is not an i32/],
      ['expire_tick', 1.5, /GRN1\[0\]\.expire_tick is not an i32/],
      ['samples', -3, /GRN1\[0\]\.samples is not a u32/],
    ];
    for (const [key, v, message] of cases)
      expect(() => parsePack(edited((j) => (j.grenades[0][key] = v)))).toThrow(
        message
      );
    // serde reads an absent Option as None.
    const g = parsePack(
      edited((j) => {
        delete j.grenades[0].detonate_tick;
        delete j.grenades[0].expire_tick;
      })
    ).grenades[0];
    expect(g.detonate_tick).toBeNull();
    expect(g.expire_tick).toBeNull();
  });

  it('leaves out a grenade of a kind it does not know, and reads the rest of the pack', () => {
    // A later server may write a kind the viewer has no colour, model or label for: read.rs
    // takes any string, so the pack is still good, and only that grenade is left out.
    const opts: BuildOptions = {
      ...base,
      grenades: [
        { samples: 4, kind: 'he', start_tick: 110 },
        { samples: 3, kind: 'smoke', start_tick: 120 },
        { samples: 2, kind: 'flash', start_tick: 130 },
      ],
    };
    const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const metas = grenadeMetas(opts);
    const known = parsePack(buildPack(opts));
    const pack = parsePack(
      buildPack({
        ...opts,
        payload: {
          GRN1: json(
            metas.map((g, i) => (i === 1 ? { ...g, kind: 'snowball' } : g))
          ),
        },
      })
    );
    expect(pack.grenades.map((g) => g.kind)).toEqual(['he', 'flash']);
    // The left-out grenade's samples are skipped, not read into the next one's.
    const flash = pack.grenades[1];
    expect(flash.entity_id).toBe(metas[2].entity_id);
    expect(Array.from(flash.x)).toEqual(
      [0, 1].map((k) => grenadeValue(2, 0, k))
    );
    expect(Array.from(flash.z)).toEqual(
      [0, 1].map((k) => grenadeValue(2, 2, k))
    );
    expect(pack.grenades[0]).toEqual(known.grenades[0]);
    // The rest of the pack is the one the server wrote.
    expect(pack.header).toEqual(known.header);
    expect(pack.events).toEqual(known.events);
    expect(timelineFor(pack).kills(0)).toHaveLength(1);
    // As in read.rs, its other fields are still checked: a thrower past the players refuses.
    expect(() =>
      parsePack(
        buildPack({
          ...opts,
          payload: {
            GRN1: json(
              metas.map((g, i) =>
                i === 1 ? { ...g, kind: 'snowball', thrower: 7 } : g
              )
            ),
          },
        })
      )
    ).toThrow(/grenade 1: thrower 7 out of 2 players/);
  });

  it('refuses inventory and map changes whose numbers are not the integers serde reads', () => {
    const order = ['HDR1', 'TRK1', 'EVT1', 'GRN1', 'GRB1', 'INV1', 'ENT1'];
    const inv = (c: Record<string, unknown>) =>
      parsePack(
        buildPack({
          ...base,
          order,
          inventory: [
            { round: 0, player: 0, tick: 120, items: [1], ...c },
          ] as never,
        })
      );
    expect(inv({}).inventory).toHaveLength(1);
    for (const c of [
      { tick: 1.5 },
      { tick: 2 ** 31 },
      { tick: null },
      { items: [1.5] },
      { player: 256 },
    ])
      expect(() => inv(c), JSON.stringify(c)).toThrow(/INV1\[0\]/);
    const ent = (e: Record<string, unknown>) =>
      parsePack(
        buildPack({
          ...base,
          order,
          mapEntities: {
            entities: [{ kind: 'door', x: 1, y: 2, z: 3, ...e }] as never,
            changes: [],
          },
        })
      );
    expect(ent({}).entities).toHaveLength(1);
    expect(() => ent({ x: 1.5 })).toThrow(/ENT1 entities\[0\]/);
    expect(() => ent({ z: 40000 })).toThrow(/ENT1 entities\[0\]/);
  });

  // The property behind the cases above: whatever one field of the JSON holds, the reader
  // either refuses the pack with a PackError or returns one the HUD's models can read without
  // throwing, a NaN, or an "undefined" in their text.
  it('either refuses a pack with one field changed, or gives one every model reads', () => {
    const values: unknown[] = [
      undefined,
      null,
      '7',
      '',
      1.5,
      -1,
      0,
      300,
      70000,
      2 ** 40,
      true,
      {},
      [],
      [0],
    ];
    type Target = [where: string, at: (j: Sections) => Record<string, unknown>];
    const fields = (
      at: Target[1],
      where: string,
      keys: readonly string[]
    ): [string, Target[1], string][] => keys.map((k) => [where, at, k]);
    const targets = [
      ...fields((j) => j.header, 'header', [
        'map',
        'server_name',
        'game_build',
        'tick_rate',
        'sample_hz',
        'tick_step',
        'players',
        'rounds',
        'weapons',
      ]),
      ...fields((j) => round(j), 'round', [
        'number',
        'start_tick',
        'freeze_end_tick',
        'end_tick',
        'post_end_tick',
        'winner',
        'reason',
        'score_t',
        'score_ct',
        'samples',
      ]),
      ...fields((j) => player(j), 'player', [
        'steamid',
        'name',
        'team_by_round',
        'crosshair',
      ]),
      ...fields((j) => j.events[1], 'kill', ['tick', 'kind', 'data']),
      ...fields(
        (j) => j.events[1].data as Record<string, unknown>,
        'kill data',
        ['user_idx', 'attacker_idx', 'weapon', 'headshot']
      ),
      ...fields((j) => j.events[2], 'plant', ['tick', 'kind', 'data']),
      ...fields((j) => j.grenades[0], 'grenade', [
        'entity_id',
        'kind',
        'thrower',
        'start_tick',
        'detonate_tick',
        'expire_tick',
      ]),
    ];
    let refused = 0;
    let read = 0;
    for (const [where, at, key] of targets)
      for (const v of values) {
        const what = `${where}.${key} = ${JSON.stringify(v)}`;
        let pack: Pack;
        try {
          pack = parsePack(edited((j) => (at(j)[key] = v)));
        } catch (e) {
          expect(e, what).toBeInstanceOf(PackError);
          refused++;
          continue;
        }
        read++;
        const tl = timelineFor(pack);
        pack.header.rounds.forEach((info, r) => {
          for (const tick of [
            info.start_tick,
            info.freeze_end_tick + 20,
            info.end_tick,
          ]) {
            expectClean(
              [
                roundBarModel(pack, tl, r, tick),
                killfeedRows(tl, r, tick, false),
                roundFeedRows(tl, r, tick, false),
                roundStripModel(pack, r),
                markers(tl, r, null),
              ],
              `${what}, round ${r} at ${tick}`
            );
          }
        });
      }
    // Both outcomes happen: the property is not vacuous.
    expect(refused).toBeGreaterThan(100);
    expect(read).toBeGreaterThan(50);
  });
});

/** Fails on a NaN anywhere in `v`, or a string that says "undefined" or "NaN". */
function expectClean(v: unknown, what: string): void {
  if (typeof v === 'number') expect(Number.isNaN(v), what).toBe(false);
  else if (typeof v === 'string') expect(v, what).not.toMatch(/undefined|NaN/);
  else if (Array.isArray(v)) for (const e of v) expectClean(e, what);
  else if (typeof v === 'object' && v !== null)
    for (const e of Object.values(v)) expectClean(e, what);
}

const FP = process.env.DEMOVIEWER_PACK_FP;
describe.skipIf(!FP)(
  needs('the Mirage pack with first-person data', 'DEMOVIEWER_PACK_FP'),
  () => {
    it('carries the values read from the demo', async () => {
      const pack = parsePack(
        await inflateIfGzip(new Uint8Array(readFileSync(FP!)))
      );
      const h = pack.header;
      const milo = h.players.findIndex((p) => p.name === 'Milo');
      const r3 = h.rounds[2];
      const k = (10778 - r3.start_tick) / h.tick_step;
      expect(pack.rounds[2].players[milo].money[k]).toBe(1650);
      expect(pack.rounds[2].players[milo].gear[k] & GEAR.helmet).toBe(
        GEAR.helmet
      );
      expect(h.players[milo].crosshair).toBe(
        'CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB'
      );
      const inv = pack.inventory
        .filter((c) => c.round === 2 && c.player === milo && c.tick <= 10778)
        .at(-1)!;
      expect(inv.items.map((i) => h.weapons[i])).toEqual([
        'knife_t',
        'Glock-18',
        'AK-47',
      ]);
      for (const r of h.rounds)
        expect(r.post_end_tick).toBeGreaterThanOrEqual(r.end_tick);
      const boom = pack.events.find((e) => e.kind === 'bomb_exploded')!.tick;
      expect(boom).toBeGreaterThan(h.rounds[5].end_tick);
      expect(boom).toBeLessThanOrEqual(h.rounds[5].post_end_tick);
    });
  }
);
