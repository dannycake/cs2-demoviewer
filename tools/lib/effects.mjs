// Effects: CS2's own particle and decal textures, each packed into one WebP flipbook atlas the
// viewer fetches the first time an effect needs it (spec §7.6). rip-effects.sh exports every
// source texture of EFFECTS from pak01_dir.vpk; VRF writes each flipbook frame as its own PNG
// (cropped to its content, so frames of one sequence differ in size) plus an `.mks` listing the
// sequences. build-effects.mjs picks the frames (selectFrames), scales each sequence by one
// factor into equal cells (placeFrame) and lays the cells out in rows of 1024 px (layoutAtlas).
// The texture references come from the decompiled `.vpcf` systems (inferno_fx, explosions_fx,
// unified_weapon_fx, impact_fx, blood_impact).
import path from 'node:path';
import { assetsDir } from './paths.mjs';

/** Bytes over every atlas together (spec §7.6). */
export const EFFECTS_BUDGET = 1_500_000;

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const decals = (dir, set, names) => names.map((n) => ({ vtex: `materials/decals/${dir}/${n}`, set }));

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

/**
 * The atlases, by the key the viewer asks for. Per atlas:
 * - `sources`: textures in pak01 (without `.vtex_c`), in atlas order; `sequences` picks authored
 *   sequences of a sheet (all when absent); sources sharing a `set` make one atlas sequence.
 * - `every`: keeps frames 0, n, 2n… of each authored sequence.
 * - `group`: `sequence` keeps the authored sequences; `source` makes one per source (or set).
 * - `cell`: [width, height] each frame is scaled into; `anchor`: where it sits in the cell.
 * - `quality`: WebP quality; `budget`: bytes of the atlas.
 */
export const EFFECTS = deepFreeze({
  fire: {
    sources: [{ vtex: 'materials/particle/fire_burning_character/fire_burning_character' }],
    every: 1, group: 'sequence', cell: [64, 112], anchor: 'bottom', quality: 80, budget: 450_000,
  },
  fireburst: {
    sources: [{ vtex: 'materials/particle/fire_small_sim/fire_small_sim_b' }],
    // Quality 60: 238 KB at 80 is over its budget.
    every: 1, group: 'sequence', cell: [64, 64], anchor: 'bottom', quality: 60, budget: 220_000,
  },
  explosion: {
    sources: [{ vtex: 'materials/particle/explosion_fireballs/flame/explosion_fireball_01_flame' }],
    every: 2, group: 'source', cell: [128, 128], anchor: 'center', quality: 80, budget: 300_000,
  },
  smoke: {
    sources: [{ vtex: 'materials/particle/smoke/smokeburst/smokeloop_i_0_sc_hardedge' }],
    every: 4, group: 'source', cell: [128, 128], anchor: 'center', quality: 80, budget: 200_000,
  },
  dust: {
    sources: [{ vtex: 'materials/particle/smoke/smokeburst/smokeburst_e' }],
    every: 2, group: 'source', cell: [64, 88], anchor: 'center', quality: 80, budget: 80_000,
  },
  muzzle: {
    sources: [{ vtex: 'materials/particle/flames/flame_omni' }],
    every: 4, group: 'source', cell: [64, 64], anchor: 'center', quality: 80, budget: 40_000,
  },
  flare: {
    sources: [{ vtex: 'materials/particle/particle_flares/particle_flare_001' }],
    every: 1, group: 'source', cell: [128, 128], anchor: 'center', quality: 90, budget: 15_000,
  },
  sparks: {
    sources: [{ vtex: 'materials/particle/sparks/sparks', sequences: range(0, 8) }, { vtex: 'materials/effects/spark' }],
    every: 1, group: 'source', cell: [32, 64], anchor: 'center', quality: 90, budget: 15_000,
  },
  debris: {
    sources: [{ vtex: 'materials/particle/impact/fleks', sequences: range(7, 22) }],
    every: 1, group: 'source', cell: [32, 32], anchor: 'center', quality: 80, budget: 15_000,
  },
  blood: {
    sources: [
      { vtex: 'materials/particle/headshot/headshot', sequences: [0, ...range(2, 6)] },
      { vtex: 'materials/particle/blood_splatter/bloodsplatter', sequences: [0, 7, 8, 9] },
    ],
    every: 1, group: 'source', cell: [64, 64], anchor: 'center', quality: 80, budget: 40_000,
  },
  // One sequence per surface: stone, metal, wood, glass, blood.
  decals: {
    sources: [
      ...decals('concrete', 'stone', ['bullethole_concrete_1_color_psd_5d8baebd', 'bullethole_concrete_2_color_psd_88f01191', 'bullethole_concrete_3_color_psd_7a183c58', 'bullethole_concrete_4_color_psd_3f340bf4']),
      ...decals('metal', 'metal', ['bullethole_metal_1_color_psd_dd6383dc', 'bullethole_metal_2_color_psd_3f7a3abb', 'bullethole_metal_3_color_psd_9bb60ad0']),
      ...decals('wood', 'wood', ['shot1_color_tga_cca04ada', 'shot2_color_tga_7c06de1f', 'shot3_color_tga_44309014']),
      ...decals('glass', 'glass', ['shot1_color_psd_797d0fe2', 'shot2_color_psd_8be16948', 'shot3_color_psd_3763d81e']),
      ...decals('blood', 'blood', ['blood_decals_10_color.0_tga_f846d93', 'blood_decals_10_color.1_tga_473340ca', 'blood_decals_10_color.2_tga_4b63fe06', 'blood_decals_10_color.3_tga_b61083', 'blood_decals_10_color.4_tga_5f5c5c7b', 'blood_decals_10_color.5_tga_c986a094']),
    ],
    every: 1, group: 'source', cell: [64, 64], anchor: 'center', quality: 80, budget: 120_000,
  },
});

/** The atlas keys, in manifest order. */
export const EFFECT_KEYS = Object.freeze(Object.keys(EFFECTS));

/** Every source texture, each once, in table order (what rip-effects.sh exports). */
export const EFFECT_SOURCES = Object.freeze([...new Set(EFFECT_KEYS.flatMap((k) => EFFECTS[k].sources.map((s) => s.vtex)))]);

/** The width every atlas fills its rows to. */
export const ATLAS_WIDTH = 1024;

/**
 * The sequences of a VRF `.mks` (`sequence N` blocks of `frame <png> <duration>` lines, `//`
 * comments), frames in the order listed.
 * @param {string} text
 * @returns {{ sequences: { frames: string[] }[] }}
 */
export function parseMks(text) {
  const sequences = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const [word, arg] = line.split(/\s+/);
    if (word === 'sequence') sequences.push({ frames: [] });
    else if (word === 'frame') {
      if (!sequences.length) throw new Error(`.mks lists frame ${arg} before any sequence`);
      sequences.at(-1).frames.push(arg);
    }
  }
  return { sequences };
}

/** Cells of `cell` in rows of ATLAS_WIDTH px, enough rows for `count` frames. */
export function layoutAtlas(count, cell) {
  const cols = Math.floor(ATLAS_WIDTH / cell[0]);
  const rows = Math.ceil(count / cols);
  return { cols, rows, width: cols * cell[0], height: rows * cell[1] };
}

/**
 * Where a `w`×`h` frame goes in its cell: scaled by its sequence's one factor (the largest
 * frame, `seqMaxW`×`seqMaxH`, just fits), centred horizontally, on the cell's bottom edge for
 * `bottom` (flames stand on their base) or centred for `center`.
 */
export function placeFrame(w, h, seqMaxW, seqMaxH, cell, anchor) {
  const s = Math.min(cell[0] / seqMaxW, cell[1] / seqMaxH);
  const width = Math.max(1, Math.min(cell[0], Math.round(w * s)));
  const height = Math.max(1, Math.min(cell[1], Math.round(h * s)));
  const left = Math.round((cell[0] - width) / 2);
  const top = anchor === 'bottom' ? cell[1] - height : Math.round((cell[1] - height) / 2);
  return { left, top, width, height };
}

/**
 * The frames of an atlas in atlas order and its sequences as `[firstFrame, count]`.
 * @param {typeof EFFECTS[string]} effect
 * @param {Record<string, { sequences: { frames: string[] }[] } | null>} sheets  parsed `.mks`
 *   per source vtex; null for a texture without one (one sequence of one frame, `<name>.png`)
 * @returns {{ frames: { vtex: string, file: string, sequence: number }[], sequences: [number, number][] }}
 */
export function selectFrames(effect, sheets) {
  const frames = [];
  const sequences = [];
  let lastSet = null;
  const open = () => sequences.push([frames.length, 0]);
  for (const src of effect.sources) {
    const sheet = sheets[src.vtex] ?? { sequences: [{ frames: [`${path.basename(src.vtex)}.png`] }] };
    const picked = src.sequences ?? sheet.sequences.map((_, i) => i);
    if (effect.group === 'source' && !(src.set && src.set === lastSet)) open();
    lastSet = src.set ?? null;
    for (const i of picked) {
      const seq = sheet.sequences[i];
      if (!seq) throw new Error(`${src.vtex} has no sequence ${i} (its sheet has ${sheet.sequences.length})`);
      if (effect.group === 'sequence') open();
      for (let f = 0; f < seq.frames.length; f += effect.every) {
        frames.push({ vtex: src.vtex, file: seq.frames[f], sequence: sequences.length - 1 });
        sequences.at(-1)[1]++;
      }
    }
  }
  return { frames, sequences };
}

/**
 * The alpha of an opaque decal (the wood shots: alpha averaging ≥ 0.9, a mod2x mark on neutral
 * grey) from its darkness: how far each pixel's luma falls below the image's median (the grey
 * it sits on), stretched so the darkest is 255; the grey and anything lighter go transparent.
 * `data` is RGBA, changed in place; returns whether it was.
 */
export function decalAlpha(data) {
  const n = data.length / 4;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i * 4 + 3];
  if (sum / n < 0.9 * 255) return false;
  const luma = new Float64Array(n);
  for (let i = 0; i < n; i++) luma[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  const sorted = Float64Array.from(luma).sort();
  const grey = sorted[Math.floor(n / 2)];
  const span = grey - sorted[0];
  for (let i = 0; i < n; i++) data[i * 4 + 3] = span > 0 ? Math.round(Math.max(0, (grey - luma[i]) / span) * 255) : 0;
  return true;
}

/** The effects files under ASSETS_DIR. */
export function effectsPaths() {
  const root = assetsDir();
  const out = path.join(root, 'effects');
  const raw = path.join(root, 'raw', 'effects');
  return {
    raw,
    ripJson: path.join(raw, 'rip.json'),
    out,
    buildJson: path.join(out, 'build.json'),
    manifest: path.join(out, 'manifest.json'),
  };
}
