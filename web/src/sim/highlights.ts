// The match's highlights, found once per pack from each round's kills and bomb (`timeline.ts`):
// multi-kills, clutches, ninja defuses, collaterals, no-scopes, wallbangs and opening kills,
// each with the window a reel replays (M4 plan, Task 5). The rules:
// - 3k, 4k, ace (≥ 5): a player's enemy kills in one round, from the first kill − `leadS` to
//   the last + `tailS`;
// - clutch: from the first tick a player is the last alive on their side with an enemy alive,
//   when their side wins the round and they are alive at its `end_tick`; from that tick −
//   `clutchLeadS` to `end_tick` + `tailS`;
// - ninja: the defuser, when a T is alive at the defuse; from the defuser's last
//   `bomb_begindefuse` (else the defuse − `defuseLeadS`) to the defuse + `tailS`;
// - collateral (≥ 2 headshot kills at one tick with one gun), no-scope, wallbang and the
//   round's opening kill: from the kill − `leadS` to the kill + `tailS`. The kinds of one
//   attacker's kills at one tick share one highlight.
// An enemy kill is `stats.ts`'s: an attacker who is not the victim, on the other side that
// round. A player is alive while on a side that round with no death yet. Every window is
// clamped to the round's live part and after-round, `[freeze_end_tick, post_end_tick]`.

import type { Pack } from '../pack/types';
import { timelineFor, type Kill } from './timeline';
import { familyOf } from './weapons';

export type HighlightKind =
  | 'ace'
  | '4k'
  | '3k'
  | 'clutch'
  | 'ninja'
  | 'collateral'
  | 'noscope'
  | 'wallbang'
  | 'opening';

export interface Highlight {
  round: number;
  player: number;
  /** Ranked in the order of HighlightKind; the first is the headline. */
  kinds: HighlightKind[];
  /** The moment: the last kill, the defuse, or the round's end_tick for a clutch. */
  tick: number;
  /** The replay window. */
  from: number;
  to: number;
  /** Clutch: enemies alive when it began; else null. */
  vs: number | null;
  /**
   * The kills it shows, as indices into `timelineFor(pack).kills(round)`: a clutch's are the
   * player's enemy kills after it began, a ninja's none.
   */
  kills: number[];
  /** False for a plain opening kill: listed, not in the reel. */
  reel: boolean;
}

export const HIGHLIGHT = Object.freeze({
  /** Seconds shown before a kill… */
  leadS: 3,
  /** …and after the moment. */
  tailS: 1.5,
  /** Seconds shown before a clutch begins. */
  clutchLeadS: 2,
  /** Seconds before a defuse when the pack has no `bomb_begindefuse`. */
  defuseLeadS: 10,
  /** Reels merge one player's windows closer than this (Task 6). */
  mergeGapS: 1,
});

/** HighlightKind's order: a highlight's kinds are ranked by it. */
export const RANK: readonly HighlightKind[] = [
  'ace',
  '4k',
  '3k',
  'clutch',
  'ninja',
  'collateral',
  'noscope',
  'wallbang',
  'opening',
];

const LABEL: Readonly<Record<Exclude<HighlightKind, 'clutch'>, string>> = {
  ace: 'Ace',
  '4k': '4k',
  '3k': '3k',
  ninja: 'Ninja defuse',
  collateral: 'Collateral',
  noscope: 'No-scope',
  wallbang: 'Wallbang',
  opening: 'Opening kill',
};

const T = 2;
const CT = 3;

/** A gun's kill: not a grenade, fire, knife, the bomb or the world. */
function byGun(k: Kill): boolean {
  const family = familyOf(k.weapon);
  return (
    (family === 'rifle' || family === 'pistol') &&
    k.weapon !== 'inferno' &&
    k.weapon !== 'planted_c4' &&
    k.weapon !== 'world' &&
    k.weapon !== ''
  );
}

const cache = new WeakMap<Pack, readonly Highlight[]>();

/** The match's highlights, made once per pack, sorted by round, then tick. */
export function highlightsOf(pack: Pack): readonly Highlight[] {
  let hs = cache.get(pack);
  if (!hs) {
    hs = Object.freeze(find(pack));
    cache.set(pack, hs);
  }
  return hs;
}

/** `'Ace'`, `'1v3 clutch'`, `'No-scope · Wallbang'`: the kinds' names, headline first. */
export function highlightLabel(h: Highlight): string {
  const name = (k: HighlightKind) =>
    k !== 'clutch' ? LABEL[k] : h.vs === null ? 'Clutch' : `1v${h.vs} clutch`;
  return h.kinds.map(name).join(' · ');
}

function find(pack: Pack): Highlight[] {
  const { header } = pack;
  const timeline = timelineFor(pack);
  const ticks = (s: number) => Math.round(s * header.tick_rate);
  const lead = ticks(HIGHLIGHT.leadS);
  const tail = ticks(HIGHLIGHT.tailS);
  const begins = pack.events
    .filter((e) => e.kind === 'bomb_begindefuse')
    .sort((a, b) => a.tick - b.tick);
  const out: Highlight[] = [];

  header.rounds.forEach((info, round) => {
    const lo = info.freeze_end_tick;
    const hi = info.post_end_tick ?? info.end_tick;
    const clamp = (t: number) => Math.min(hi, Math.max(lo, t));
    const add = (
      player: number,
      kinds: HighlightKind[],
      tick: number,
      from: number,
      to: number,
      kills: number[],
      vs: number | null = null
    ) =>
      out.push({
        round,
        player,
        kinds,
        tick,
        from: clamp(from),
        to: clamp(to),
        vs,
        kills,
        reel: !(kinds.length === 1 && kinds[0] === 'opening'),
      });
    const side = (p: number) => header.players[p]?.team_by_round[round] ?? 0;
    const onSide = (p: number) => side(p) === T || side(p) === CT;
    const kills = timeline.kills(round);
    const enemy = (k: Kill): k is Kill & { attacker: number } =>
      k.attacker !== null &&
      k.attacker !== k.victim &&
      onSide(k.attacker) &&
      onSide(k.victim) &&
      side(k.attacker) !== side(k.victim);

    // Multi-kills, and each attacker's kills by tick for the single-kill kinds.
    const byPlayer = new Map<number, number[]>();
    const moments = new Map<string, { player: number; list: number[] }>();
    let opening = -1;
    kills.forEach((k, i) => {
      if (!enemy(k)) return;
      if (opening < 0) opening = i;
      const mine = byPlayer.get(k.attacker);
      if (mine) mine.push(i);
      else byPlayer.set(k.attacker, [i]);
      const key = `${k.tick}:${k.attacker}`;
      const at = moments.get(key);
      if (at) at.list.push(i);
      else moments.set(key, { player: k.attacker, list: [i] });
    });
    for (const [player, list] of byPlayer) {
      const n = list.length;
      if (n < 3) continue;
      const first = kills[list[0]].tick;
      const last = kills[list[n - 1]].tick;
      add(
        player,
        [n >= 5 ? 'ace' : n === 4 ? '4k' : '3k'],
        last,
        first - lead,
        last + tail,
        list
      );
    }
    for (const { player, list } of moments.values()) {
      const kinds: HighlightKind[] = [];
      const shown = new Set<number>();
      const tag = (kind: HighlightKind, which: number[]) => {
        if (which.length === 0) return;
        kinds.push(kind);
        for (const i of which) shown.add(i);
      };
      const guns = list.filter((i) => byGun(kills[i]));
      const gun = guns.length > 0 ? kills[guns[0]].weapon : '';
      tag(
        'collateral',
        guns.length >= 2 &&
          guns.every((i) => kills[i].weapon === gun && kills[i].headshot)
          ? guns
          : []
      );
      tag(
        'noscope',
        list.filter((i) => kills[i].noscope)
      );
      tag(
        'wallbang',
        list.filter((i) => kills[i].wallbang)
      );
      tag(
        'opening',
        list.filter((i) => i === opening)
      );
      if (kinds.length === 0) continue;
      const tick = kills[list[0]].tick;
      add(
        player,
        kinds,
        tick,
        tick - lead,
        tick + tail,
        list.filter((i) => shown.has(i))
      );
    }

    // Clutch: the deaths in tick order, a tick's together, until the winners are down to one.
    // Only deaths up to `end_tick` count: after it the round is decided.
    const winner = info.winner;
    const loser = winner === T ? CT : T;
    if (winner === T || winner === CT) {
      const alive = new Set<number>();
      for (let p = 0; p < header.players.length; p++)
        if (onSide(p)) alive.add(p);
      const left = (s: number) => [...alive].filter((p) => side(p) === s);
      let at = info.start_tick;
      let i = 0;
      for (;;) {
        const mine = left(winner);
        const theirs = left(loser).length;
        if (mine.length === 1 && theirs >= 1) {
          const player = mine[0];
          // The clutcher must be alive at end_tick: the reel shows a highlight through its
          // player's eyes, and a dead clutcher (a bomb win after they fell) has nothing to show.
          if (kills.some((k) => k.victim === player && k.tick <= info.end_tick))
            break;
          const list: number[] = [];
          kills.forEach((k, j) => {
            if (k.tick > at && enemy(k) && k.attacker === player) list.push(j);
          });
          add(
            player,
            ['clutch'],
            info.end_tick,
            at - ticks(HIGHLIGHT.clutchLeadS),
            info.end_tick + tail,
            list,
            theirs
          );
          break;
        }
        if (i >= kills.length || kills[i].tick > info.end_tick) break;
        at = kills[i].tick;
        while (i < kills.length && kills[i].tick === at)
          alive.delete(kills[i++].victim);
      }
    }

    // Ninja: a defuse with a T still alive.
    const bomb = timeline.bombAt(round, hi);
    if (
      bomb.kind === 'defused' &&
      bomb.by !== null &&
      bomb.by < header.players.length
    ) {
      const defuse = bomb.tick;
      const defuser = bomb.by;
      const dead = new Set(
        kills.filter((k) => k.tick <= defuse).map((k) => k.victim)
      );
      let tsAlive = false;
      for (let p = 0; p < header.players.length; p++)
        if (side(p) === T && !dead.has(p)) tsAlive = true;
      if (tsAlive) {
        let from = defuse - ticks(HIGHLIGHT.defuseLeadS);
        for (const e of begins) {
          if (e.tick > defuse) break;
          if (e.tick >= info.start_tick && e.data.user_idx === defuser)
            from = e.tick;
        }
        add(defuser, ['ninja'], defuse, from, defuse + tail, []);
      }
    }
  });

  const rank = (h: Highlight) => RANK.indexOf(h.kinds[0]);
  return out.sort(
    (a, b) =>
      a.round - b.round ||
      a.tick - b.tick ||
      rank(a) - rank(b) ||
      a.player - b.player
  );
}
