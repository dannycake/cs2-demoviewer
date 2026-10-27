// What every rig shows at (round, tick): its state, the locomotion clips it blends and their
// times, the actions playing, its death, the weapon it holds. Pure in (round, tick): nothing
// here remembers the previous frame, so scrubbing backwards or jumping rounds can never leave a
// stale pose (Review Focus 3); an output's objects are refilled in place, every value the
// tick's own. No three.js.

import { FLAG, type Pack, type RoundInfo } from '../pack/types';
import { ActionIndex, type Action } from '../sim/actions';
import { CROSS_FADE_S, DEATH_TOTAL_S, STRIDE_SPEED } from '../sim/anim';
import {
  locomotionBlend,
  locomotionInputAt,
  type ClipWeight,
  type LocomotionInput,
} from '../sim/locomotion';
import {
  newPlayerState,
  playerStateAt,
  sampleIndex,
  TELEPORT_UNITS,
  type PlayerState,
} from '../sim/sample';
import { familyOf, normaliseWeapon, type Family } from '../sim/weapons';

export interface RigInput {
  /**
   * The player's state. For a body inside its death window this is the last live sample with
   * `alive` cleared (so `present` is true).
   */
  state: PlayerState;
  /** `team_by_round` of the round: 2 = T, 3 = CT, anything else = not playing. */
  team: number;
  /** The tick being shown. */
  tick: number;
  /** Seconds since the round's start tick: the time of clips that are not strides. */
  clipTime: number;
  /** Ticks since the player's last death this round, or null while alive. */
  deathTicks: number | null;
  /** The death being played (hit group, bearing, headshot), or null. */
  death: Action | null;
  /** Looping clips and weights (summing to 1); `time` set for strides, null for the clock. */
  locomotion: ClipWeight[];
  /** One-shot actions playing at this tick, newest first (the death is in `death`). */
  actions: Action[];
  /** The weapon held, normalised (`weapons.ts`), and its clip family. */
  weapon: string;
  family: Family;
}

/** The state of a player not in the round or on no team, copied into theirs: nothing is made. */
const ABSENT: Readonly<PlayerState> = Object.freeze(newPlayerState());

export class FrameSolver {
  readonly pack: Pack;
  readonly actionIndex: ActionIndex;
  /** Per round, per player: `player_death` ticks within the round, ascending. */
  private deaths = new Map<number, number[][]>();
  /** Per round, per player: horizontal distance walked up to each sample, units. */
  private distances = new Map<number, Float64Array[]>();
  private scratch: LocomotionInput = {
    speed: 0,
    velocityAngle: 0,
    vertical: 0,
    duck: 0,
    flags: 0,
    yawRate: 0,
    family: 'rifle',
  };
  private acc = new Map<string, number>();
  private tapAcc = new Map<string, number>();
  private knot = newPlayerState();
  /** Clip family per index into `header.weapons`. */
  private families: Family[] = [];
  /**
   * For round `blendRound`, per player and sample: the clips the player blends at that
   * sample (`locomotionBlend`), null when not alive, made on first use. One round is kept.
   */
  private blendRound = -1;
  private sampleBlends: (ClipWeight[] | null | undefined)[][] = [];

  constructor(pack: Pack) {
    this.pack = pack;
    this.actionIndex = new ActionIndex(pack);
  }

  /** Fills `out` (one entry per `header.players`) with the inputs at `tick` of `round`. */
  solve(round: number, tick: number, out: RigInput[] = []): RigInput[] {
    const { header } = this.pack;
    const info = header.rounds[round];
    const tracks = this.pack.rounds[round]?.players;
    const n = header.players.length;
    out.length = n;
    const deathWindow = DEATH_TOTAL_S * header.tick_rate;
    const deaths = info ? this.deathsIn(round) : null;
    for (let i = 0; i < n; i++) {
      const inp = (out[i] ??= {
        state: newPlayerState(),
        team: 0,
        tick: 0,
        clipTime: 0,
        deathTicks: null,
        death: null,
        locomotion: [],
        actions: [],
        weapon: 'none',
        family: 'rifle',
      });
      const team = header.players[i].team_by_round[round] ?? 0;
      const track = tracks?.[i];
      inp.team = team;
      inp.tick = tick;
      inp.deathTicks = null;
      inp.death = null;
      inp.locomotion.length = 0;
      inp.actions.length = 0;
      inp.clipTime = info ? (tick - info.start_tick) / header.tick_rate : 0;
      if (!info || !track || (team !== 2 && team !== 3)) {
        Object.assign(inp.state, ABSENT);
        inp.weapon = 'none';
        inp.family = 'rifle';
        continue;
      }
      const s = playerStateAt(track, info, tick, header, inp.state);
      const death = lastAtOrBefore(deaths![i], tick);
      if (death !== null) {
        const since = tick - death;
        const aliveNow = s.present && (s.flags & FLAG.alive) !== 0;
        // Alive long after a death is a respawn; alive just after it is the last live sample
        // still showing while the body starts to fall.
        if (!aliveNow || since < deathWindow) inp.deathTicks = since;
        if (!s.present && since < deathWindow)
          this.body(round, i, info, death, s);
      }
      inp.weapon = normaliseWeapon(header.weapons[s.weapon] ?? 'none');
      inp.family = familyOf(inp.weapon);
      if (!s.present) continue;

      this.actionIndex.at(round, i, tick, inp.actions);
      if (inp.deathTicks !== null) {
        const k = inp.actions.findIndex((a) => a.kind === 'death');
        inp.death = k >= 0 ? inp.actions[k] : null;
        // A dying body plays nothing else; it holds its weapon's idle under the fall.
        inp.actions.length = 0;
        pushClip(inp, IDLE_CLIP[locoFamily(inp.family)], 1, null);
        continue;
      }
      this.blend(round, i, tick, info, inp);
    }
    return out;
  }

  /**
   * The locomotion blend at `tick`. At a sample it is the blends of the last CROSS_FADE_S of
   * samples, with weights falling linearly into the past, each sample with the clip family of
   * the weapon it held: every change of gait, crouch, jump, landing or weapon blends in
   * instead of popping. Between samples it moves linearly from one sample's blend to the
   * next, so it changes a little every frame rather than a fifth of the way at each sample.
   * Strides get their time from the distance walked.
   */
  private blend(
    round: number,
    p: number,
    tick: number,
    info: RoundInfo,
    inp: RigInput
  ): void {
    const step = this.pack.header.tick_step;
    const { k, f } = sampleIndex(info, tick, step);
    const acc = this.acc;
    acc.clear();
    let total = this.blendAtSample(round, p, k, info, 1 - f);
    if (f > 0) total += this.blendAtSample(round, p, k + 1, info, f);
    if (total === 0) {
      pushClip(inp, IDLE_CLIP[locoFamily(inp.family)], 1, null);
      return;
    }
    const dist = this.distanceAt(round, p, tick, info);
    for (const [clip, w] of acc)
      pushClip(inp, clip, w / total, strideTime(clip, dist));
  }

  /**
   * Adds the blend at sample `k` (see `blend`), scaled to sum to `scale`, into `acc`; returns
   * `scale`, or 0 when no sample in its window is live.
   */
  private blendAtSample(
    round: number,
    p: number,
    k: number,
    info: RoundInfo,
    scale: number
  ): number {
    const { header } = this.pack;
    const step = header.tick_step;
    const track = this.pack.rounds[round].players[p];
    const taps = Math.max(1, Math.round(CROSS_FADE_S * header.sample_hz));
    const tapAcc = this.tapAcc;
    tapAcc.clear();
    let total = 0;
    if (this.blendRound !== round) {
      this.blendRound = round;
      this.sampleBlends = [];
    }
    const blends = (this.sampleBlends[p] ??= []);
    for (let j = 0; j < taps && k - j >= 0; j++) {
      let clips = blends[k - j];
      if (clips === undefined) {
        const li = locomotionInputAt(
          this.pack,
          round,
          p,
          info.start_tick + (k - j) * step,
          this.weaponFamily(track.weapon[k - j]),
          this.scratch
        );
        clips =
          li && (li.flags & FLAG.alive) !== 0 ? locomotionBlend(li) : null;
        blends[k - j] = clips;
      }
      if (!clips) continue;
      const w = taps - j;
      for (const c of clips)
        tapAcc.set(c.clip, (tapAcc.get(c.clip) ?? 0) + c.weight * w);
      total += w;
    }
    if (total === 0 || scale <= 0) return 0;
    for (const [clip, w] of tapAcc)
      this.acc.set(clip, (this.acc.get(clip) ?? 0) + (w / total) * scale);
    return scale;
  }

  /** The clip family of `header.weapons[w]`. */
  private weaponFamily(w: number): Family {
    let f = this.families[w];
    if (f === undefined) {
      f = familyOf(normaliseWeapon(this.pack.header.weapons[w] ?? 'none'));
      this.families[w] = f;
    }
    return f;
  }

  /**
   * Units walked horizontally since the round start, along the drawn path: summed between the
   * points it passes at each sample (`playerStateAt` there), interpolated between samples.
   */
  distanceAt(round: number, p: number, tick: number, info: RoundInfo): number {
    let per = this.distances.get(round);
    if (!per) {
      per = [];
      this.distances.set(round, per);
    }
    let cum = per[p];
    if (!cum) {
      const t = this.pack.rounds[round]?.players[p];
      cum = new Float64Array(Math.max(1, info.samples));
      if (t) {
        const { header } = this.pack;
        const s = this.knot;
        let px = 0;
        let py = 0;
        for (let k = 0; k < info.samples; k++) {
          playerStateAt(
            t,
            info,
            info.start_tick + k * header.tick_step,
            header,
            s
          );
          const live =
            k > 0 &&
            (t.flags[k] & FLAG.alive) !== 0 &&
            (t.flags[k - 1] & FLAG.alive) !== 0;
          const d = Math.hypot(s.x - px, s.y - py);
          if (k > 0) cum[k] = cum[k - 1] + (live && d < TELEPORT_UNITS ? d : 0);
          px = s.x;
          py = s.y;
        }
      }
      per[p] = cum;
    }
    const { k, f } = sampleIndex(info, tick, this.pack.header.tick_step);
    const k1 = Math.min(k + 1, cum.length - 1);
    return cum[k] + (cum[k1] - cum[k]) * f;
  }

  /** Overwrites `s` with the player's last live sample at or before `death`, not alive. */
  private body(
    round: number,
    p: number,
    info: RoundInfo,
    death: number,
    s: PlayerState
  ) {
    const { header } = this.pack;
    const track = this.pack.rounds[round].players[p];
    const kd = sampleIndex(info, death, header.tick_step).k;
    const stop = Math.max(0, kd - BODY_SEARCH);
    for (let k = Math.min(kd + 1, info.samples - 1); k >= stop; k--) {
      if ((track.flags[k] & FLAG.alive) === 0) continue;
      playerStateAt(
        track,
        info,
        info.start_tick + k * header.tick_step,
        header,
        s
      );
      s.flags &= ~FLAG.alive;
      s.speed = 0;
      return;
    }
  }

  private deathsIn(round: number): number[][] {
    let d = this.deaths.get(round);
    if (d) return d;
    const { header, events } = this.pack;
    const info = header.rounds[round];
    d = header.players.map(() => []);
    for (const e of events) {
      if (e.kind !== 'player_death') continue;
      if (e.tick < info.start_tick || e.tick > info.post_end_tick) continue;
      const who = e.data.user_idx;
      if (typeof who === 'number' && Number.isInteger(who) && d[who])
        d[who].push(e.tick);
    }
    for (const ticks of d) ticks.sort((a, b) => a - b);
    this.deaths.set(round, d);
    return d;
  }
}

/** How many samples back from a death to look for the last live one. */
const BODY_SEARCH = 64;

function lastAtOrBefore(ticks: number[], tick: number): number | null {
  for (let i = ticks.length - 1; i >= 0; i--)
    if (ticks[i] <= tick) return ticks[i];
  return null;
}

/** Each locomotion family's idle clip. */
const IDLE_CLIP = {
  rifle: 'idle_rifle',
  pistol: 'idle_pistol',
  knife: 'idle_knife',
} as const;

/**
 * The clip weights of each input `solve` filled, kept from one solve to the next: the input's
 * `locomotion` is refilled with them in place, so a frame makes none. They are the input's: a
 * caller that keeps one past the next solve of the same input copies it.
 */
const clipWeights = new WeakMap<RigInput, ClipWeight[]>();

/** Appends `clip` at `weight` and `time` to `inp.locomotion`, in a weight object kept for it. */
function pushClip(
  inp: RigInput,
  clip: string,
  weight: number,
  time: number | null
): void {
  let kept = clipWeights.get(inp);
  if (!kept) clipWeights.set(inp, (kept = []));
  const c = (kept[inp.locomotion.length] ??= { clip, weight, time });
  c.clip = clip;
  c.weight = weight;
  c.time = time;
  inp.locomotion.push(c);
}

function locoFamily(f: Family): 'rifle' | 'pistol' | 'knife' {
  return f === 'rifle' || f === 'pistol' || f === 'knife' ? f : 'pistol';
}

/** A stride clip's time from the distance walked; null (the round clock) for anything else. */
export function strideTime(clip: string, distance: number): number | null {
  if (clip.startsWith('run_')) return distance / STRIDE_SPEED.run;
  if (clip.startsWith('walk_')) return distance / STRIDE_SPEED.walk;
  if (clip.startsWith('crouch_')) return distance / STRIDE_SPEED.crouch;
  return null;
}
