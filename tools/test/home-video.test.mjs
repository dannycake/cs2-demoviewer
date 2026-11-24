// The homepage video's plan (home-video/shots.json, home-video.mjs): one orbit of the camera round
// the chicken a loop, cut into three pro kills, the replay slow at each kill and near real time
// at the cuts, every term periodic so the loop has no seam; and how it is encoded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ffmpegArgs, frameAt, frameList, SHOTS_FILE } from '../home-video.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(fs.readFileSync(path.join(TOOLS, SHOTS_FILE), 'utf8'));
const frames = frameList(spec);
const N = spec.fps * spec.seconds;

describe('the homepage video', () => {
  it('lasts 8 to 12 seconds at 60 fps', () => {
    expect(spec.fps).toBe(60);
    expect(frames.length).toBe(N);
    expect(frames.length / 60).toBeGreaterThanOrEqual(8);
    expect(frames.length / 60).toBeLessThanOrEqual(12);
  });

  it('starts where the shot list says and wraps round once', () => {
    expect(frames[0]).toEqual({ ...frameAt(spec, spec.startFrame), i: 0 });
    expect(frames.at(-1)).toEqual({ ...frameAt(spec, (spec.startFrame + N - 1) % N), i: N - 1 });
  });

  it('loops with no seam: the last frame runs into the first as any two neighbours do', () => {
    const [last, first] = [frames.at(-1), frames[0]];
    expect(last.moment).toBe(first.moment);
    const step = first.tick - last.tick;
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan((spec.speed.cut * 64) / spec.fps + 0.01);
    // The camera turns by one frame's worth, as its neighbours do.
    const turn = (a, b) => ((((b.pose.yaw - a.pose.yaw) % 360) + 540) % 360) - 180;
    expect(Math.abs(turn(last, first) - turn(frames.at(-2), last))).toBeLessThan(0.1);
  });

  it('runs each moment forward, slowest at its middle and near real time at its cuts', () => {
    const perMoment = N / spec.moments.length;
    for (let k = 0; k < spec.moments.length; k++) {
      const ticks = Array.from({ length: perMoment }, (_, j) => frameAt(spec, k * perMoment + j).tick);
      const steps = ticks.slice(1).map((t, j) => t - ticks[j]);
      expect(Math.min(...steps)).toBeGreaterThan(0);
      const mid = steps[Math.floor(steps.length / 2)];
      expect(mid).toBeCloseTo((spec.speed.kill * 64) / spec.fps, 2);
      expect(steps[0]).toBeCloseTo((spec.speed.cut * 64) / spec.fps, 2);
      // Smooth: the step changes by little from frame to frame.
      const jumps = steps.slice(1).map((s, j) => Math.abs(s - steps[j]));
      expect(Math.max(...jumps)).toBeLessThan(0.02);
    }
  });

  it('the committed shot list is valid', () => {
    expect(spec.width).toBe(1920);
    expect(spec.height).toBe(1080);
    expect(spec.moments).toHaveLength(3);
    expect(spec.chicken.clip).toMatch(/^chick_/);
    for (const m of spec.moments) {
      expect(spec.demos[m.demo], m.name).toMatch(/\.dem$/);
      expect(m.round).toBeGreaterThanOrEqual(0);
      expect(m.tick).toBeGreaterThan(0);
      expect(m.R).toBeGreaterThan(0.5);
      expect(m.h).toBeGreaterThan(0);
    }
    for (const f of frames) {
      expect(f.demo).toMatch(/\.dem$/);
      expect(f.chicken.clip).toBe(spec.chicken.clip);
      expect(f.dof.focus).toBeGreaterThan(0);
    }
  });

  it('encodes mp4 as H.264 High yuv420p, faststart, no audio, 60 fps', () => {
    expect(ffmpegArgs('mp4', 'f', 'o.mp4', 23)).toEqual(
      expect.arrayContaining(['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-r', '60']),
    );
    expect(ffmpegArgs('mp4', 'f', 'o.mp4', 23).at(-1)).toBe('o.mp4');
    expect(ffmpegArgs('mp4', 'f', 'o.mp4', 23)).toEqual(expect.arrayContaining(['-i', 'f/%04d.png', '-crf', '23']));
  });

  it('encodes webm as VP9 in two passes', () => {
    const one = ffmpegArgs('webm', 'f', 'o.webm', 32, 1);
    const two = ffmpegArgs('webm', 'f', 'o.webm', 32, 2);
    expect(one).toEqual(expect.arrayContaining(['-c:v', 'libvpx-vp9', '-pass', '1', '-f', 'null']));
    expect(two).toEqual(expect.arrayContaining(['-c:v', 'libvpx-vp9', '-pass', '2', '-an', '-crf', '32', '-b:v', '0']));
    expect(two.at(-1)).toBe('o.webm');
  });
});
