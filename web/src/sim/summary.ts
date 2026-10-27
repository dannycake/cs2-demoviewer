// The panel at the end of a round (`components/hud/RoundSummary`): who won and how, the
// round's MVP, each player's kills and damage in it, and each player's money and buys at the
// start of the next round. Pure; a round's summary is made once per pack and kept, frozen.
// Rules (ours, close to the game's):
// - MVP: the round's `round_mvp` event, when the pack has one; else, by how the round was
//   won (`reasonGlyph`), the planter of a bomb that won it for T or the defuser of a CT win by
//   defuse; else the winner with the most enemy kills, then the most damage, then the lowest
//   index. Nobody without a winner. A bomb that explodes after a win by elimination leaves the
//   MVP to the kills, as in the game.
// - The next round's money is at its first sample; its buys are its `item_purchase` events
//   from its start to its buy end (its `buytime_ended` after the freeze, else the freeze end
//   and `SUMMARY.buyS`), less what was sold back and what is only re-listed (`purchasesOf`),
//   matched to players by Steam id (the event carries no player index). A pack without money
//   (`TRK2`) or purchases gives null money and no buys, not zeros.

import { moneyKnown, reasonGlyph, weaponIcon } from '../components/hud/models';
import type { Pack, PackEvent, RoundInfo } from '../pack/types';
import { roundRecord } from './stats';
import { timelineFor } from './timeline';

export interface SummaryPlayer {
  index: number;
  name: string;
  team: 2 | 3;
  kills: number;
  /** Health damage dealt to enemies (`roundRecord`). */
  damage: number;
  /** No death from the round's start through its `end_tick`. */
  alive: boolean;
}

export interface NextBuy {
  index: number;
  /** At the next round's first sample; null without money data. */
  money: number | null;
  /** In the order bought. `icon` is a weapon silhouette's name, '' for armor and the kit. */
  buys: { icon: string; label: string }[];
}

export interface RoundSummary {
  /** Index into `header.rounds`. */
  round: number;
  winner: 0 | 2 | 3;
  /** The round's end reason, as in the header (`t_killed`, `bomb_defused`, ...). */
  reason: string;
  mvp: { index: number; why: 'event' | 'bomb' | 'defuse' | 'kills' } | null;
  /** The winning side first, each side by damage. */
  players: SummaryPlayer[];
  /** Null for the last round. */
  next: NextBuy[] | null;
}

export const SUMMARY = Object.freeze({
  /** The buy time after the freeze when a round has no `buytime_ended` (`mp_buytime`), s. */
  buyS: 20,
});

/** Gear, by its `item_name`: shown as a word, without a silhouette. */
const GEAR_LABEL: Readonly<Record<string, string>> = {
  'Kevlar Vest': 'Armor',
  'Kevlar + Helmet': 'Helmet',
  // The game's own spelling, as the packs carry it.
  'Kevlar & Helmet': 'Helmet',
  'Defuse Kit': 'Kit',
};

interface PackSummaries {
  /** The pack's `item_purchase` events by tick. */
  purchases: PackEvent[];
  /** Its `buytime_ended` events by tick. */
  buyEnds: PackEvent[];
  /** Its `round_mvp` events by tick. */
  mvps: PackEvent[];
  /** Each player's index by Steam id. */
  bySteamid: Map<string, number>;
  /** The rounds' summaries, by round index, once made. */
  rounds: (RoundSummary | undefined)[];
}

const cache = new WeakMap<Pack, PackSummaries>();

function packSummaries(pack: Pack): PackSummaries {
  let c = cache.get(pack);
  if (!c) {
    const of = (kind: string) =>
      pack.events
        .filter((e) => e.kind === kind && Number.isFinite(e.tick))
        .sort((a, b) => a.tick - b.tick);
    c = {
      purchases: of('item_purchase'),
      buyEnds: of('buytime_ended'),
      mvps: of('round_mvp'),
      bySteamid: new Map(pack.header.players.map((p, i) => [p.steamid, i])),
      rounds: [],
    };
    cache.set(pack, c);
  }
  return c;
}

function idx(v: unknown, n: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n
    ? v
    : null;
}

/** The index of the first of `events` (by tick) at or after `tick`. */
function firstAt(events: readonly PackEvent[], tick: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The events of `events` in `[from, to]`. */
function within(
  events: readonly PackEvent[],
  from: number,
  to: number
): PackEvent[] {
  const out: PackEvent[] = [];
  for (let i = firstAt(events, from); i < events.length; i++) {
    if (events[i].tick > to) break;
    out.push(events[i]);
  }
  return out;
}

function mvpOf(
  pack: Pack,
  c: PackSummaries,
  round: number,
  info: RoundInfo,
  players: readonly SummaryPlayer[]
): RoundSummary['mvp'] {
  const winner = info.winner;
  if (winner !== 2 && winner !== 3) return null;
  const n = pack.header.players.length;
  // The game's own pick, the last in the round.
  let picked: number | null = null;
  for (const e of within(c.mvps, info.start_tick, info.post_end_tick))
    picked = idx(e.data.user_idx, n) ?? picked;
  if (picked !== null) return { index: picked, why: 'event' };
  const onWinners = (p: number | null): p is number =>
    p !== null &&
    p < n &&
    pack.header.players[p].team_by_round[round] === winner;
  const tl = timelineFor(pack);
  const glyph = reasonGlyph(info.reason);
  const bomb = tl.bombAt(round, info.post_end_tick);
  if (winner === 2 && glyph === 'bomb' && bomb.kind === 'exploded') {
    const before = tl.bombAt(round, bomb.tick - 1);
    if (before.kind === 'planted' && onWinners(before.by))
      return { index: before.by, why: 'bomb' };
  }
  if (
    winner === 3 &&
    glyph === 'defuse' &&
    bomb.kind === 'defused' &&
    onWinners(bomb.by)
  )
    return { index: bomb.by, why: 'defuse' };
  let best: SummaryPlayer | null = null;
  for (const p of players)
    if (
      p.team === winner &&
      (!best ||
        p.kills > best.kills ||
        (p.kills === best.kills &&
          (p.damage > best.damage ||
            (p.damage === best.damage && p.index < best.index))))
    )
      best = p;
  return best ? { index: best.index, why: 'kills' } : null;
}

/** The highest `inventory_slot` followed; an event past it counts as a purchase as it is. */
const MAX_SLOT = 255;

/**
 * The purchases among one player's `item_purchase` events of a round (by tick). The packs'
 * events follow the player's purchase list of the round (what they could still sell back):
 * a purchase takes the next slot, and when an item leaves the list, the ones after it come
 * again at the same tick, each a slot lower, while one leaving its end comes with nothing. An
 * event re-lists an item when that item sits at a higher slot of the list as followed so
 * far; at such a tick the list ends after the highest slot it gives.
 */
function purchasesOf(events: readonly PackEvent[]): PackEvent[] {
  const list: unknown[] = [];
  const out: PackEvent[] = [];
  for (let i = 0; i < events.length;) {
    const tick = events[i].tick;
    let top = -1;
    let relisted = false;
    for (; i < events.length && events[i].tick === tick; i++) {
      const e = events[i];
      const slot = e.data.inventory_slot;
      if (
        typeof slot !== 'number' ||
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot > MAX_SLOT
      ) {
        out.push(e);
        continue;
      }
      if (list.indexOf(e.data.item_name, slot + 1) > slot) relisted = true;
      else out.push(e);
      list[slot] = e.data.item_name;
      top = Math.max(top, slot);
    }
    if (relisted) list.length = top + 1;
  }
  return out;
}

function nextOf(pack: Pack, c: PackSummaries, round: number): NextBuy[] | null {
  const { header } = pack;
  const next = round + 1;
  const info = header.rounds[next];
  if (!info) return null;
  const known = moneyKnown(pack, next);
  const tracks = pack.rounds[next]?.players ?? [];
  const team = (p: number) => header.players[p]?.team_by_round[next] ?? 0;
  const out: NextBuy[] = [];
  const byPlayer = new Map<number, NextBuy>();
  for (let p = 0; p < header.players.length; p++) {
    if (team(p) !== 2 && team(p) !== 3) continue;
    const buy: NextBuy = {
      index: p,
      money: known ? (tracks[p]?.money[0] ?? null) : null,
      buys: [],
    };
    out.push(buy);
    byPlayer.set(p, buy);
  }
  // A `buytime_ended` before the freeze ends is another's (the pack's first round can carry
  // the warmup's at its start).
  const buyEnd =
    within(c.buyEnds, info.freeze_end_tick, info.post_end_tick)[0]?.tick ??
    info.freeze_end_tick + SUMMARY.buyS * header.tick_rate;
  // Each player's events, then their purchases.
  const events = new Map<NextBuy, PackEvent[]>();
  for (const e of within(c.purchases, info.start_tick, buyEnd)) {
    const p =
      typeof e.data.steamid === 'string'
        ? c.bySteamid.get(e.data.steamid)
        : undefined;
    const buy = p === undefined ? undefined : byPlayer.get(p);
    if (!buy) continue;
    let mine = events.get(buy);
    if (!mine) events.set(buy, (mine = []));
    mine.push(e);
  }
  for (const [buy, mine] of events)
    for (const { data: d } of purchasesOf(mine)) {
      const name = d.item_name;
      if (d.was_sold === true || typeof name !== 'string' || !name) continue;
      const gear = GEAR_LABEL[name];
      buy.buys.push(
        gear
          ? { icon: '', label: gear }
          : { icon: weaponIcon(name, team(buy.index)), label: name }
      );
    }
  return out;
}

/** `s`, frozen through its parts: a kept summary is shared by every reader. */
function frozen(s: RoundSummary): RoundSummary {
  for (const p of s.players) Object.freeze(p);
  Object.freeze(s.players);
  if (s.mvp) Object.freeze(s.mvp);
  for (const n of s.next ?? []) {
    for (const b of n.buys) Object.freeze(b);
    Object.freeze(n.buys);
    Object.freeze(n);
  }
  if (s.next) Object.freeze(s.next);
  return Object.freeze(s);
}

function make(pack: Pack, c: PackSummaries, round: number): RoundSummary {
  const { header } = pack;
  const info = header.rounds[round];
  const rec = roundRecord(pack, round);
  const players: SummaryPlayer[] = [];
  for (const [i, p] of header.players.entries()) {
    const team = p.team_by_round[round];
    const r = rec.players[i];
    if ((team !== 2 && team !== 3) || !r) continue;
    players.push({
      index: i,
      name: p.name,
      team,
      kills: r.kills,
      damage: r.damage,
      alive: r.survived,
    });
  }
  // The winners first (CT without a winner), each side by damage, then kills.
  const first = info.winner === 2 ? 2 : 3;
  players.sort(
    (a, b) =>
      Number(b.team === first) - Number(a.team === first) ||
      b.damage - a.damage ||
      b.kills - a.kills ||
      a.index - b.index
  );
  return {
    round,
    winner: info.winner === 2 || info.winner === 3 ? info.winner : 0,
    reason: info.reason,
    mvp: mvpOf(pack, c, round, info, players),
    players,
    next: nextOf(pack, c, round),
  };
}

/** Round `round`'s summary, made once per pack and round (frozen, shared). */
export function roundSummary(pack: Pack, round: number): RoundSummary {
  if (!pack.header.rounds[round])
    return frozen({
      round,
      winner: 0,
      reason: '',
      mvp: null,
      players: [],
      next: null,
    });
  const c = packSummaries(pack);
  let s = c.rounds[round];
  if (!s) c.rounds[round] = s = frozen(make(pack, c, round));
  return s;
}

/**
 * Whether the summary of `round` shows at `tick`: from its `end_tick` through its
 * `post_end_tick`, with the setting `on` and no reel playing.
 */
export function summaryShown(
  pack: Pack,
  round: number,
  tick: number,
  reel: boolean,
  on: boolean
): boolean {
  const info = pack.header.rounds[round];
  return (
    on &&
    !reel &&
    info !== undefined &&
    tick >= info.end_tick &&
    tick <= info.post_end_tick
  );
}
