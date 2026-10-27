// Reels (M4 plan, Task 6): a kill cam or a run of highlights, which the store plays as a list
// of segments, each a round, a window `[from, to]` and the player it is on, in POV. A kill a
// highlight's player made after their own death plays on its victim, ending on their death
// view, as a kill cam from a dead killer does (`killcamSegment`): there is no view from a dead
// player's eyes. Entering a segment pins its player in POV at 1×, with the director and the
// full radar off.
// The clock's writes step the reel: past a segment's `to`, or out of its round, playback
// enters the next segment, and after the last it leaves. Leaving restores the camera, the
// director and the speed from before the reel (`Resume`), either back where it started
// (`'resume'`: a kill cam, or the user asking to go back) or where it got to (`'here'`: a
// highlights reel that plays on, or the user seeking, picking a player or a camera).
// Everything here is a state patch for the store; a reel changes only its position and camera.

import type { Pack, RoundInfo } from '../pack/types';
import type { CameraMode } from '../sim/follow';
import {
  HIGHLIGHT,
  RANK,
  highlightLabel,
  type Highlight,
  type HighlightKind,
} from '../sim/highlights';
import { diedBy } from '../sim/killcam';
import { timelineFor, type Kill } from '../sim/timeline';
import type { PlaybackState, Speed } from './store';

export interface ReelSegment {
  round: number;
  from: number;
  to: number;
  /** The player POV is on, pinned. */
  follow: number;
  /**
   * A highlight's player, when the camera is on someone else: the victim of a kill they made
   * after their death. The banner names them.
   */
  player?: number;
  title: string;
}

/** What a reel gives back when it is left: where it started, and the camera then. */
export interface Resume {
  round: number;
  tick: number;
  camera: CameraMode;
  follow: number | null;
  followPinned: boolean;
  director: boolean;
  playing: boolean;
  speed: Speed;
}

export interface Reel {
  kind: 'killcam' | 'highlights';
  segments: readonly ReelSegment[];
  /** The segment playing. */
  index: number;
  resume: Resume;
  /** After the last segment: back to `resume`, or play on from there. */
  atEnd: 'resume' | 'continue';
}

/** Plays `seg`: its round from `from`, in POV on its player (pinned), at 1×. */
export function enterSegment(seg: ReelSegment): Partial<PlaybackState> {
  return {
    round: seg.round,
    tick: seg.from,
    camera: 'pov',
    follow: seg.follow,
    followPinned: true,
    director: false,
    playing: true,
    speed: 1,
    radar: false,
  };
}

/** The segment after the one playing, or, after the last, leaving as `atEnd` says. */
export function nextSegment(reel: Reel): Partial<PlaybackState> {
  const next = reel.index + 1;
  if (next < reel.segments.length)
    return {
      ...enterSegment(reel.segments[next]),
      reel: { ...reel, index: next },
    };
  return leaveReel(reel, reel.atEnd === 'resume' ? 'resume' : 'here');
}

/**
 * What the reel does at the store's position: null without a reel or inside the segment
 * playing; else the next segment, or leaving after the last. A tick at `to` counts as past it
 * (the clock stops on the last round's `post_end_tick`, and a segment can end there), and so
 * does a tick in another round.
 */
export function stepReel(
  s: Pick<PlaybackState, 'reel' | 'round' | 'tick'>
): Partial<PlaybackState> | null {
  const reel = s.reel;
  if (!reel) return null;
  const seg: ReelSegment | undefined = reel.segments[reel.index];
  if (seg && s.round === seg.round && s.tick < seg.to) return null;
  return nextSegment(reel);
}

/**
 * Ends `reel`, restoring the camera, follow, pin, director and speed from before it:
 * `'resume'` also goes back to its round, tick and playing; `'here'` keeps the position, and
 * playing.
 */
export function leaveReel(
  reel: Reel,
  to: 'resume' | 'here'
): Partial<PlaybackState> {
  const r = reel.resume;
  const camera = {
    reel: null,
    camera: r.camera,
    follow: r.follow,
    followPinned: r.followPinned,
    director: r.director,
    speed: r.speed,
  };
  return to === 'resume'
    ? { ...camera, round: r.round, tick: r.tick, playing: r.playing }
    : camera;
}

/**
 * Whether the store's change from `prev` to `s` left a reel that was started in Free, in Free
 * (at its end, Escape, a seek, a pick, or `C`): the free camera then goes back to its pose from
 * before the reel (`Scene.keepFreePose`), not to the reel's last view.
 */
export function backToFree(
  s: Pick<PlaybackState, 'reel' | 'camera'>,
  prev: Pick<PlaybackState, 'reel'>
): boolean {
  return (
    prev.reel !== null &&
    s.reel === null &&
    prev.reel.resume.camera === 'free' &&
    s.camera === 'free'
  );
}

/**
 * What a row of the highlights panel plays (an opening kill too, which the reel leaves out):
 * one highlight's whole window as a segment, in POV on its player, titled with its kinds. A
 * highlight with a kill made after its player's death plays as the reel plays it instead
 * (`highlightSegments`): a window per kill, that kill's on its victim.
 */
export function highlightSegment(pack: Pack, h: Highlight): ReelSegment[] {
  const kills = timelineFor(pack).kills(h.round);
  if (
    h.kills.some(
      (i) => kills[i] && diedBy(pack, h.round, h.player, kills[i].tick)
    )
  )
    return highlightSegments(pack, [{ ...h, reel: true }], h.round);
  return [
    {
      round: h.round,
      from: h.from,
      to: h.to,
      follow: h.player,
      title: highlightLabel(h),
    },
  ];
}

const MULTI: ReadonlySet<HighlightKind> = new Set(['ace', '4k', '3k']);

/**
 * The highlights reel from round `fromRound` on: the highlights with `reel` true, in POV on
 * each one's player, but a kill made after the player's death (by a trade's tick too) on its
 * victim. A multi-kill plays one window per kill (the kill − `leadS` to + `tailS`, clamped to
 * the round as `highlightsOf` clamps), not its whole span; a clutch or a ninja defuse plays
 * its whole window, and a single kill's kinds their own. One round's windows on one player
 * (POV on them: their own, or ones on them as a victim) that overlap or lie closer than
 * `mergeGapS` merge into one segment, so no stretch plays twice, titled with their highlights'
 * kinds, each once, headline first (`highlightLabel`), and with `player` set from the window it
 * opens with. Segments come in round order, then by `from`.
 */
export function highlightSegments(
  pack: Pack,
  hs: readonly Highlight[],
  fromRound: number
): ReelSegment[] {
  const { header } = pack;
  const ticks = (s: number) => Math.round(s * header.tick_rate);
  const lead = ticks(HIGHLIGHT.leadS);
  const tail = ticks(HIGHLIGHT.tailS);
  const gap = ticks(HIGHLIGHT.mergeGapS);
  const timeline = timelineFor(pack);

  interface Window {
    round: number;
    /** The highlight's player, or the victim of a kill they made after their death. */
    follow: number;
    from: number;
    to: number;
    h: Highlight;
  }
  const windows: Window[] = [];
  for (const h of hs) {
    if (!h.reel || h.round < fromRound) continue;
    /** A window on `kill` (or on none): on its victim when the player has died. */
    const add = (from: number, to: number, kill: Kill | undefined) => {
      const dead =
        kill !== undefined && diedBy(pack, h.round, h.player, kill.tick);
      windows.push({
        round: h.round,
        follow: dead ? kill.victim : h.player,
        from,
        to,
        h,
      });
    };
    const info: RoundInfo | undefined = header.rounds[h.round];
    const kills = timeline.kills(h.round);
    const each = MULTI.has(h.kinds[0])
      ? h.kills.flatMap((i) => (kills[i] ? [kills[i]] : []))
      : [];
    if (each.length === 0 || !info) {
      add(h.from, h.to, h.kills.length > 0 ? kills[h.kills[0]] : undefined);
      continue;
    }
    const lo = info.freeze_end_tick;
    const hi = info.post_end_tick ?? info.end_tick;
    const clamp = (t: number) => Math.min(hi, Math.max(lo, t));
    for (const k of each) add(clamp(k.tick - lead), clamp(k.tick + tail), k);
  }
  windows.sort(
    (a, b) => a.round - b.round || a.follow - b.follow || a.from - b.from
  );

  const merged: { seg: ReelSegment; hs: Highlight[] }[] = [];
  let cur: (typeof merged)[0] | null = null;
  for (const w of windows) {
    if (
      cur &&
      cur.seg.round === w.round &&
      cur.seg.follow === w.follow &&
      w.from - cur.seg.to < gap
    ) {
      cur.seg.to = Math.max(cur.seg.to, w.to);
      if (!cur.hs.includes(w.h)) cur.hs.push(w.h);
      continue;
    }
    cur = {
      seg: {
        round: w.round,
        from: w.from,
        to: w.to,
        follow: w.follow,
        title: '',
      },
      hs: [w.h],
    };
    if (w.follow !== w.h.player) cur.seg.player = w.h.player;
    merged.push(cur);
  }

  for (const { seg, hs: its } of merged) {
    const kinds = [...new Set(its.flatMap((h) => h.kinds))].sort(
      (a, b) => RANK.indexOf(a) - RANK.indexOf(b)
    );
    const vs = its.find((h) => h.kinds.includes('clutch'))?.vs ?? null;
    seg.title = highlightLabel({ ...its[0], kinds, vs });
  }
  return merged
    .map((m) => m.seg)
    .sort(
      (a, b) => a.round - b.round || a.from - b.from || a.follow - b.follow
    );
}
