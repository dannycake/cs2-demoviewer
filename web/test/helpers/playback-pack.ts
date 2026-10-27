// A pack with a header and no track data: enough for the playback store, clock and keys,
// which only read the round ticks, the tick rate and step, and the player count, and for
// what reads only the events (highlights), given `events`, `teams` and each round's winner.

import type { Pack, PackEvent, RoundInfo } from '../../src/pack/types';
import { createPlaybackStore } from '../../src/state/store';

export interface PlaybackRound {
  start: number;
  /** Defaults to `start`. */
  freeze?: number;
  end: number;
  /** The after-round's end (`post_end_tick`); defaults to `end`. */
  post?: number;
  /** 2 T, 3 CT, 0 unknown; defaults to 2. */
  winner?: number;
  /** Defaults to `'t_killed'`. */
  reason?: string;
}

export function playbackPack(opts: {
  rounds: PlaybackRound[];
  players?: number;
  tick_rate?: number;
  tick_step?: number;
  /** The pack's events; defaults to none. */
  events?: PackEvent[];
  /**
   * Per player, the side in every round (2 T, 3 CT, 0 not playing). Defaults to the first
   * five T and the rest CT. Without `players`, its length is the player count.
   */
  teams?: number[];
}): Pack {
  const tickStep = opts.tick_step ?? 8;
  const rounds: RoundInfo[] = opts.rounds.map((r, i) => ({
    number: i + 1,
    start_tick: r.start,
    freeze_end_tick: r.freeze ?? r.start,
    end_tick: r.end,
    post_end_tick: r.post ?? r.end,
    winner: r.winner ?? 2,
    reason: r.reason ?? 't_killed',
    score_t: i + 1,
    score_ct: 0,
    samples: Math.floor(((r.post ?? r.end) - r.start) / tickStep) + 1,
  }));
  const count = opts.players ?? opts.teams?.length ?? 10;
  const players = Array.from({ length: count }, (_, i) => ({
    steamid: String(76561198000000000n + BigInt(i)),
    name: `player${i + 1}`,
    team_by_round: rounds.map(() => opts.teams?.[i] ?? (i < 5 ? 2 : 3)),
    crosshair: null,
  }));
  return {
    header: {
      version: 1,
      map: 'de_mirage',
      server_name: 'test',
      game_build: '0',
      tick_rate: opts.tick_rate ?? 64,
      sample_hz: (opts.tick_rate ?? 64) / tickStep,
      tick_step: tickStep,
      players,
      rounds,
      weapons: ['none'],
    },
    rounds: rounds.map(() => ({ players: [] })),
    events: opts.events ?? [],
    grenades: [],
    inventory: [],
    entities: [],
    entityChanges: [],
    ground: [],
  };
}

/**
 * A store (no storage) holding a pack of `players` and three rounds, 100-300, 400-600 and
 * 700-900 with their freeze ends at 150, 450 and 750, sampled every 8 ticks.
 */
export function threeRoundStore(players = 10) {
  const store = createPlaybackStore({ storage: null });
  store.getState().setPack(
    playbackPack({
      players,
      rounds: [
        { start: 100, freeze: 150, end: 300 },
        { start: 400, freeze: 450, end: 600 },
        { start: 700, freeze: 750, end: 900 },
      ],
      tick_step: 8,
    })
  );
  return store;
}
