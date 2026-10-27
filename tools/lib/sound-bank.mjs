// A sound bank: the clips of one family (a gun, a footstep set, a grenade) decoded to mono
// 48 kHz floats, laid end to end with a short silence between them, and encoded as one Opus
// file in WebM. The page fetches and decodes a bank once and plays a clip as a slice of it
// (offset, duration). A clip's tail quieter than BANK_PARAMS.tailDb is dropped first (trimTail):
// inaudible, and it is most of what a quiet decay costs. ffmpeg with libopus does the decoding
// and the encoding; the same samples always give the same bytes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * How every bank is made: its sample rate, its Opus bitrate (VBR), the silence between clips,
 * and the level (dBFS) under which a clip's tail is dropped.
 */
export const BANK_PARAMS = Object.freeze({ rate: 48000, bitrate: '48k', gapS: 0.05, tailDb: -80 });

/** Runs ffmpeg with `args`, feeding `input` on stdin; resolves to its stdout. */
function ffmpeg(args, input, what) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => reject(new Error(`ffmpeg could not run for ${what}: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      const tail = Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' | ');
      reject(new Error(`ffmpeg exited ${code} for ${what}${tail ? `: ${tail}` : ''}`));
    });
    if (input) {
      // An ffmpeg that exits early closes its stdin; the exit code reports why.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/**
 * A sound file's first audio stream as mono 48 kHz float samples. Stereo is averaged (each
 * channel at 0.5, `rematrix_maxval 1`), so a sound in both channels keeps its level and never
 * clips; ffmpeg's default would add 3 dB. An Opus file's pre-skip is dropped by the decoder.
 * @param {string} file
 * @returns {Promise<Float32Array>}
 */
export async function decodeClip(file) {
  const bytes = await ffmpeg([
    '-i', file, '-map', '0:a:0', '-ac', '1', '-rematrix_maxval', '1', '-ar', String(BANK_PARAMS.rate),
    '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
  ], null, file);
  // A copy: the Buffer may sit at an offset that is not a multiple of 4 in a shared pool.
  const pcm = new Float32Array(bytes.length >> 2);
  new Uint8Array(pcm.buffer).set(bytes.subarray(0, pcm.length * 4));
  return pcm;
}

/**
 * The clip without its tail of samples quieter than `thresholdDb` (|x| < 10^(dB/20)): a prefix
 * ending at the last sample at or above it. Leading silence is kept, so an onset stays where
 * the file has it. An all-silent clip keeps its first sample, so its span is never empty.
 * Pure: a view of `pcm`, which is not changed.
 * @param {Float32Array} pcm
 * @param {number} [thresholdDb]
 * @returns {Float32Array}
 */
export function trimTail(pcm, thresholdDb = BANK_PARAMS.tailDb) {
  const floor = 10 ** (thresholdDb / 20);
  let n = pcm.length;
  while (n > 1 && Math.abs(pcm[n - 1]) < floor) n--;
  return pcm.subarray(0, n);
}

/**
 * The clips end to end, `gapS` of silence between each and the next (none before the first or
 * after the last), and where each landed: `[offsetS, durationS]`, sample counts over the rate.
 * @param {Float32Array[]} clips
 * @param {number} [gapS]
 * @returns {{pcm: Float32Array, spans: [number, number][]}}
 */
export function packBank(clips, gapS = BANK_PARAMS.gapS) {
  const { rate } = BANK_PARAMS;
  const gap = Math.round(gapS * rate);
  const total = clips.reduce((n, c) => n + c.length, 0) + gap * Math.max(0, clips.length - 1);
  const pcm = new Float32Array(total);
  const spans = [];
  let at = 0;
  for (const clip of clips) {
    pcm.set(clip, at);
    spans.push([at / rate, clip.length / rate]);
    at += clip.length + gap;
  }
  return { pcm, spans };
}

/**
 * Encodes mono 48 kHz samples as Opus in WebM at `out` (replaced if there), bit-exact: the
 * muxer and encoder tags are the version-less `Lavf` and `Lavc libopus`, with no timestamp, no
 * other metadata and fixed track ids, so the same samples give the same bytes.
 * @param {Float32Array} pcm
 * @param {string} out
 * @returns {Promise<number>} the file's size in bytes
 */
export async function encodeBank(pcm, out) {
  const { rate, bitrate } = BANK_PARAMS;
  await ffmpeg([
    '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0',
    '-ac', '1', '-ar', String(rate), '-c:a', 'libopus', '-b:a', bitrate, '-vbr', 'on',
    '-fflags', '+bitexact', '-map_metadata', '-1', '-f', 'webm', '-y', out,
  ], Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), out);
  return fs.statSync(out).size;
}
