// lib/sound-bank.mjs and build-sounds.mjs against audio made here (ramps and sines, written as
// WAVs by hand) and hand-written soundevents, never ripped clips. What needs ffmpeg is skipped
// without it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BANK_PARAMS, decodeClip, encodeBank, packBank, trimTail } from '../lib/sound-bank.mjs';
import { buildSounds, missingFiles } from '../build-sounds.mjs';
import { SOUNDEVENT_FILES } from '../lib/sounds.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const RATE = BANK_PARAMS.rate;

const ramp = (s) => Float32Array.from({ length: Math.round(s * RATE) }, (_, i, n = Math.round(s * RATE)) => (i + 1) / n);
const sine = (s, hz = 1000, amp = 0.5, rate = RATE) =>
  Float32Array.from({ length: Math.round(s * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

/** A PCM16 WAV of `channels` copies of `samples` at `rate`. */
function writeWav(file, samples, { rate = 44100, channels = 1 } = {}) {
  const data = Buffer.alloc(samples.length * channels * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

const peak = (a, from = 0, to = a.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
};

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-bank-test-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('packBank', () => {
  it('puts the clips end to end with the gap between and nothing after the last', () => {
    const a = ramp(0.5);
    const b = ramp(0.25);
    const { pcm, spans } = packBank([a, b], 0.05);
    const second = Math.round(0.55 * RATE);
    expect(spans).toEqual([[0, 0.5], [0.55, 0.25]]);
    expect(pcm.length).toBe(Math.round(0.8 * RATE));
    expect(Array.from(pcm.subarray(0, a.length))).toEqual(Array.from(a));
    expect(peak(pcm, a.length, second)).toBe(0);
    expect(Array.from(pcm.subarray(second))).toEqual(Array.from(b));
  });

  it("gives offsets as exact sample counts over the bank's rate and defaults to BANK_PARAMS.gapS", () => {
    const gap = Math.round(BANK_PARAMS.gapS * RATE);
    expect(Number.isInteger(BANK_PARAMS.gapS * RATE)).toBe(true);
    const { spans } = packBank([new Float32Array(7), new Float32Array(3), new Float32Array(1)]);
    expect(spans).toEqual([[0, 7 / RATE], [(7 + gap) / RATE, 3 / RATE], [(7 + 3 + 2 * gap) / RATE, 1 / RATE]]);
    expect(Object.isFrozen(BANK_PARAMS)).toBe(true);
  });
});

describe('trimTail', () => {
  const dbfs = (db) => 10 ** (db / 20);
  const lastAbove = (a, floor) => {
    let i = a.length - 1;
    while (i >= 0 && Math.abs(a[i]) < floor) i--;
    return i;
  };

  it('drops a tail quieter than -80 dBFS and keeps the tone before it', () => {
    const tone = sine(0.3, 1000);
    const clip = new Float32Array(tone.length + Math.round(0.2 * RATE));
    clip.set(tone);
    clip.fill(dbfs(-90), tone.length);
    const out = trimTail(clip);
    expect(out.length).toBe(lastAbove(tone, dbfs(-80)) + 1);
    expect(out.length).toBeGreaterThan(tone.length - RATE / 2000);
    expect(Array.from(out)).toEqual(Array.from(tone.subarray(0, out.length)));
    expect(Array.from(clip.subarray(0, 4))).toEqual(Array.from(tone.subarray(0, 4)));
    expect(clip.length).toBe(Math.round(0.5 * RATE));
  });

  it('keeps every sample up to the last one at or above the threshold, leading silence included', () => {
    const decay = Float32Array.from({ length: RATE }, (_, i) => (i < 4800 ? 0 : 0.5 * Math.exp(-(i - 4800) / 2400)));
    const out = trimTail(decay);
    const last = lastAbove(decay, dbfs(-80));
    expect(last).toBeGreaterThan(4800);
    expect(out.length).toBe(last + 1);
    expect(Math.abs(out[out.length - 1])).toBeGreaterThanOrEqual(dbfs(-80));
    expect(trimTail(decay, -60).length).toBe(lastAbove(decay, dbfs(-60)) + 1);
    expect(trimTail(decay, -60).length).toBeLessThan(out.length);
  });

  it('keeps one sample of an all-silent clip, so no span has no length', () => {
    expect(Array.from(trimTail(new Float32Array(4800)))).toEqual([0]);
    expect(trimTail(new Float32Array(0)).length).toBe(0);
  });
});

describe.skipIf(!hasFfmpeg)('encodeBank and decodeClip', () => {
  it('writes the same bytes for the same samples', async () => {
    const pcm = sine(1);
    const one = path.join(tmp, 'one.webm');
    const two = path.join(tmp, 'two.webm');
    const bytes = await encodeBank(pcm, one);
    expect(await encodeBank(pcm, two)).toBe(bytes);
    expect(bytes).toBe(fs.statSync(one).size);
    expect(fs.readFileSync(one).subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(fs.readFileSync(two).equals(fs.readFileSync(one))).toBe(true);
  });

  it('decodes a bank back to its length, the Opus pre-skip honoured', async () => {
    const file = path.join(tmp, 'long.webm');
    await encodeBank(sine(2), file);
    const pcm = await decodeClip(file);
    expect(Math.abs(pcm.length - 2 * RATE)).toBeLessThanOrEqual(2 * 960);
    expect(peak(pcm)).toBeGreaterThan(0.4);
    expect(peak(pcm)).toBeLessThan(0.6);
  });

  it('decodes a 44.1 kHz stereo WAV to mono 48 kHz at the level of its channels', async () => {
    const file = path.join(tmp, 'stereo.wav');
    writeWav(file, sine(1, 440, 0.5, 44100), { rate: 44100, channels: 2 });
    const pcm = await decodeClip(file);
    expect(Math.abs(pcm.length - RATE)).toBeLessThanOrEqual(2);
    expect(peak(pcm)).toBeCloseTo(0.5, 2);
  });

  it('rejects naming the file when ffmpeg cannot read it', async () => {
    const bad = path.join(tmp, 'bad.wav');
    fs.writeFileSync(bad, 'not audio');
    await expect(decodeClip(bad)).rejects.toThrow(/bad\.wav/);
  });
});

// A raw dir laid out like rip-sounds.sh's: the soundevents, the two surface files, rip.json and
// a few sounds as WAVs.
const HEADER = '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->';
const WEAPON_EVENTS = `${HEADER}
{
	Weapon_AK47.Single =
	{
		volume = 1.123456
		pitch_random_min = 0.98
		pitch_random_max = 1.02
		position_offset = [ 0.0, 0.0, 60.0 ]
		distance_volume_mapping_curve = [ [ 2500.0, 0.0147058823, 0.0, 0.0, ], [ 30.0, 1.0, 0.0, 0.0, ], ]
		vsnd_files_track_01 = [ "sounds/weapons/ak47/shot_01.vsnd", "sounds/weapons/ak47/shot_02.vsnd", ]
		soundevent_01 = [ "Weapon_AK47.SingleDistant", ]
	}
	Weapon_AK47.SingleDistant = { vsnd_files_track_01 = "sounds/weapons/ak47/distant.vsnd" }
	Weapon_AK47.Clipout = { vsnd_files_track_01 = [ "sounds/weapons/ak47/shot_01.vsnd", ] }
	Weapon_AWP.Single = { vsnd_files_track_01 = [ "sounds/weapons/awp/gone.vsnd", ] }
	Inferno.Loop = { vsnd_files_track_01 = "sounds/weapons/molotov/fire_loop.vsnd" }
	Inferno.FadeOut = { vsnd_files_track_01 = "sounds/weapons/molotov/fire_out.vsnd" }
}
`;
const FOOTSTEP_EVENTS = `${HEADER}
{
	CT_Concrete.StepLeft = { vsnd_files_track_01 = [ "sounds/player/footsteps/concrete1.vsnd", ] }
}
`;
const FOOTSTEPS = `${HEADER}
{
	ct_player = { SurfacePropertiesList = [ { surfacePropertyName = "concrete" walkleft = "CT_Concrete.StepLeft" walkright = "CT_Concrete.StepLeft" }, ] }
	t_player = { SurfacePropertiesList = [ ] }
}
`;
const VSURF = `${HEADER}
{
	SurfacePropertiesList =
	[
		{ surfacePropertyName = "default" m_nameHash = 11 },
		{ surfacePropertyName = "concrete" m_nameHash = 22 },
		{ surfacePropertyName = "plaster" base = "concrete" m_nameHash = 33 },
	]
}
`;

function fakeRaw(dir) {
  const tone = (s, hz) => sine(s, hz, 0.5, 44100);
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  for (const f of SOUNDEVENT_FILES) put(`${f}.vsndevts`, `${HEADER}\n{\n}\n`);
  put('soundevents/game_sounds_weapons.vsndevts', WEAPON_EVENTS);
  put('soundevents/game_sounds_footsteps.vsndevts', FOOTSTEP_EVENTS);
  put('scripts/surfaceproperties_footsteps.txt', FOOTSTEPS);
  put('surfaceproperties/surfaceproperties.vsurf', VSURF);
  put('rip.json', JSON.stringify({ cs2Build: '2000999', vrfVersion: '9.9.1+fake', exportedAt: '2026-10-25T00:00:00Z' }));
  writeWav(path.join(dir, 'sounds/weapons/ak47/shot_01.wav'), tone(0.3, 500));
  writeWav(path.join(dir, 'sounds/weapons/ak47/shot_02.wav'), tone(0.2, 600), { channels: 2 });
  // Followed by 0.1 s of silence, which the build trims.
  writeWav(path.join(dir, 'sounds/weapons/ak47/distant.wav'), Float32Array.from([...tone(0.4, 300), ...new Float32Array(4410)]));
  writeWav(path.join(dir, 'sounds/weapons/molotov/fire_loop.wav'), tone(0.5, 200));
  writeWav(path.join(dir, 'sounds/weapons/molotov/fire_out.wav'), new Float32Array(4410));
  writeWav(path.join(dir, 'sounds/player/footsteps/concrete1.wav'), tone(0.1, 800));
}

describe('missingFiles', () => {
  it('names the sources first, then each sound file a key needs, as the VPK paths to export', () => {
    const raw = path.join(tmp, 'missing-raw');
    fakeRaw(raw);
    fs.rmSync(path.join(raw, 'scripts/surfaceproperties_footsteps.txt'));
    fs.rmSync(path.join(raw, 'soundevents/game_sounds_ui.vsndevts'));
    expect(missingFiles(raw)).toEqual(['scripts/surfaceproperties_footsteps.txt', 'soundevents/game_sounds_ui.vsndevts_c']);
    fakeRaw(raw);
    expect(missingFiles(raw)).toEqual(['sounds/weapons/awp/gone.vsnd_c']);
  });
});

describe.skipIf(!hasFfmpeg)('buildSounds', () => {
  let raw;
  let out;
  let build;
  let warnings;
  beforeAll(async () => {
    raw = path.join(tmp, 'raw');
    out = path.join(tmp, 'sounds');
    fakeRaw(raw);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'weapon_gone.webm'), 'a bank from an older build');
    fs.writeFileSync(path.join(out, 'manifest.json'), '{}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      build = await buildSounds(raw, out);
      warnings = warn.mock.calls.map((c) => c.join(' '));
    } finally {
      warn.mockRestore();
    }
  });

  it('packs each bank once per file, in the order the keys name them, and records it', () => {
    expect(build.raw).toEqual({ cs2Build: '2000999', vrf: '9.9.1+fake' });
    expect(build.params).toEqual(BANK_PARAMS);
    expect(Object.keys(build.banks)).toEqual(['grenade_fire', 'steps_concrete', 'weapon_ak47']);
    const ak = build.banks.weapon_ak47;
    expect(ak.clips).toBe(3);
    expect(ak.seconds).toBeCloseTo(0.3 + 0.05 + 0.2 + 0.05 + 0.4, 3);
    expect(ak.bytes).toBe(fs.statSync(path.join(out, 'weapon_ak47.webm')).size);
    expect(fs.readdirSync(out).sort()).toEqual(['build.json', 'grenade_fire.webm', 'manifest.json', 'steps_concrete.webm', 'weapon_ak47.webm']);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'build.json'), 'utf8'))).toEqual(build);
  });

  it('gives each key its layers with the clips as [offset, duration], rounded to 4 decimals', () => {
    expect(build.sounds['shot:ak47']).toEqual({
      bank: 'weapon_ak47',
      layers: [
        {
          clips: [[0, 0.3], [0.35, 0.2]], volume: 1.1235, volumeRandom: [0, 0], pitch: 1, pitchRandom: [0.98, 1.02],
          curve: [[30, 1], [2500, 0.0147]], offset: [0, 0, 60], loop: false,
        },
        {
          // 0.4 s of tone and 0.1 s of silence: the silence is trimmed, the resampler's ringing
          // past the tone's hard end is not.
          clips: [[0.6, expect.closeTo(0.4, 3)]], volume: 1, volumeRandom: [0, 0], pitch: 1, pitchRandom: [0, 0],
          curve: null, offset: [0, 0, 0], loop: false,
        },
      ],
    });
    expect(build.sounds['reload:ak47:out'].layers[0].clips).toEqual([[0, 0.3]]);
    expect(build.sounds['fire:loop']).toMatchObject({ bank: 'grenade_fire', layers: [{ clips: [[0, 0.5]], loop: true }] });
    expect(build.sounds['step:concrete:ct'].bank).toBe('steps_concrete');
    expect(build.sounds['step:concrete:t'].layers).toEqual(build.sounds['step:concrete:ct'].layers);
  });

  it('keeps a silent clip as one sample and names it in a warning', () => {
    expect(build.sounds['fire:out'].layers[0].clips).toEqual([[0.55, 0]]);
    expect(build.banks.grenade_fire.clips).toBe(2);
    expect(warnings).toEqual(['build-sounds: 1 clip(s) silent in the rip, each kept as one sample: sounds/weapons/molotov/fire_out.wav (grenade_fire)']);
  });

  it('lists a key whose files or events are missing and leaves it out', () => {
    expect(build.missing).toContain('shot:awp');
    expect(build.missing).toContain('bomb:plant');
    expect(build.missing).toContain('land:concrete');
    expect(build.missing).toEqual([...build.missing].sort());
    for (const key of build.missing) expect(build.sounds).not.toHaveProperty([key]);
  });

  it('maps every surface to its step set', () => {
    expect(build.surfaces).toMatchObject({ concrete: 'concrete', plaster: 'concrete', default: 'default', vrf_unknown_key_33: 'concrete' });
  });

  it('refuses a raw dir without rip.json, changing nothing', async () => {
    const bare = path.join(tmp, 'bare');
    fakeRaw(bare);
    fs.rmSync(path.join(bare, 'rip.json'));
    const before = fs.readFileSync(path.join(out, 'build.json'));
    await expect(buildSounds(bare, out)).rejects.toThrow(/rip\.json/);
    expect(fs.readFileSync(path.join(out, 'build.json')).equals(before)).toBe(true);
  });
});
