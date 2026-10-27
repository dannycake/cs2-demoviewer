// The radar overview model: resource/overviews/<map>.txt (parsed by kv.mjs) becomes
// overview.json. Everything stays in Source units; worldToRadar is the design doc's
// formula, px = (x - pos_x)/scale, py = (pos_y - y)/scale, in pixels of a 1024 px radar.
//
// Keys are looked up case-insensitively, as the game does. `rotate` and `zoom` are
// legacy HLTV fields and are not part of the model (de_dust2 still says "rotate" "1";
// the design doc's formula applies no rotation).

export const RADAR_SIZE = 1024;
/** Stand-ins for -Infinity/+Infinity so overview.json stays plain JSON. */
export const ALTITUDE_MIN = -10000;
export const ALTITUDE_MAX = 10000;

// Lower case only: the viewer takes a section's image name only in lower case
// (web/src/radar/overview.ts parseOverview), and refuses the whole overview otherwise.
const SECTION_NAME = /^[a-z0-9_]+$/;

/**
 * @typedef {{ name: string, image: string, altitudeMin: number, altitudeMax: number }} Section
 * @typedef {{ map: string, posX: number, posY: number, scale: number, size: 1024,
 *   sections: Section[],
 *   ctSpawn: [number, number] | null, tSpawn: [number, number] | null,
 *   bombA: [number, number] | null, bombB: [number, number] | null,
 *   inset: { left: number, top: number, right: number, bottom: number } }} Overview
 */

/** The served file name for a vertical section: radar.png, radar_lower.png, radar_<name>.png. */
export function sectionImage(name) {
  return name === 'default' ? 'radar.png' : `radar_${name}.png`;
}

/**
 * @param {string} map  e.g. 'de_nuke'
 * @param {object} kv   parseKv() of the overview file, or its "<map>" block
 * @param {{ default: string, lower?: string }} images  the radar images produced for this
 *   map, keyed by section name. Every section needs one and every image needs a section,
 *   so a missing radar_lower.png can never leave a dangling section (or the reverse).
 * @returns {Overview}
 */
export function overviewFromKv(map, kv, images) {
  const block = mapBlock(map, kv);
  const fail = (msg) => {
    throw new Error(`overview ${map}: ${msg}`);
  };

  const posX = num(block, 'pos_x', fail, { required: true });
  const posY = num(block, 'pos_y', fail, { required: true });
  const scale = num(block, 'scale', fail, { required: true });
  if (!(scale > 0)) fail(`scale must be positive, got ${JSON.stringify(get(block, 'scale'))}`);

  const sections = readSections(block, fail);
  const have = new Set(Object.keys(images ?? {}).filter((k) => images[k]));
  for (const s of sections) {
    if (!have.has(s.name)) fail(`section "${s.name}" has no radar image (images.${s.name})`);
  }
  for (const name of have) {
    if (!sections.some((s) => s.name === name)) {
      fail(`images.${name} given but there is no "${name}" section in verticalsections`);
    }
  }

  return {
    map,
    posX,
    posY,
    scale,
    size: RADAR_SIZE,
    sections,
    ctSpawn: marker(block, 'CTSpawn', fail),
    tSpawn: marker(block, 'TSpawn', fail),
    bombA: marker(block, 'bombA', fail),
    bombB: marker(block, 'bombB', fail),
    inset: {
      left: num(block, 'inset_left', fail) ?? 0,
      top: num(block, 'inset_top', fail) ?? 0,
      right: num(block, 'inset_right', fail) ?? 0,
      bottom: num(block, 'inset_bottom', fail) ?? 0,
    },
  };
}

/**
 * The vertical sections the overview file declares (just `default` when it has no
 * verticalsections block), with the image each one needs; radar.mjs looks for
 * those images before it calls overviewFromKv.
 * @param {string} map @param {object} kv  as for overviewFromKv
 * @returns {Section[]}
 */
export function sectionsFromKv(map, kv) {
  return readSections(mapBlock(map, kv), (msg) => {
    throw new Error(`overview ${map}: ${msg}`);
  });
}

/**
 * Why `ov` (a parsed overview.json) is not an Overview of `map` as overviewFromKv writes it, or
 * null: check-map.mjs's overview.json row. Every overview it passes the viewer reads
 * (web/src/radar/overview.ts parseOverview; web/test/tools-parity.test.ts holds the two together).
 */
export function overviewProblem(ov, map) {
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  if (ov === null || typeof ov !== 'object' || Array.isArray(ov)) return 'not an object';
  if (ov.map !== map) return `map is ${JSON.stringify(ov.map)}`;
  if (!finite(ov.posX) || !finite(ov.posY)) return 'posX/posY not numbers';
  if (!finite(ov.scale) || ov.scale <= 0) return `scale ${JSON.stringify(ov.scale)}`;
  if (ov.size !== RADAR_SIZE) return `size ${JSON.stringify(ov.size)}`;
  if (!Array.isArray(ov.sections) || ov.sections.length === 0) return 'no sections';
  const seen = new Set();
  for (const s of ov.sections) {
    if (!s || typeof s.name !== 'string' || !SECTION_NAME.test(s.name) || seen.has(s.name)) return `bad section name ${JSON.stringify(s?.name)}`;
    seen.add(s.name);
    if (s.image !== sectionImage(s.name)) return `section ${s.name} image ${JSON.stringify(s.image)}`;
    if (!finite(s.altitudeMin) || !finite(s.altitudeMax) || s.altitudeMin > s.altitudeMax) return `section ${s.name} altitudes`;
  }
  return null;
}

/**
 * World (Source units) to radar pixels at RADAR_SIZE.
 * @param {number} x @param {number} y @param {Overview} ov
 * @returns {[number, number]}
 */
export function worldToRadar(x, y, ov) {
  return [(x - ov.posX) / ov.scale, (ov.posY - y) / ov.scale];
}

function readSections(block, fail) {
  const vs = get(block, 'verticalsections');
  if (vs === undefined || (isBlock(vs) && Object.keys(vs).length === 0)) {
    return [{ name: 'default', image: sectionImage('default'), altitudeMin: ALTITUDE_MIN, altitudeMax: ALTITUDE_MAX }];
  }
  if (!isBlock(vs)) fail('verticalsections is not a block');
  return Object.entries(vs).map(([name, s]) => {
    if (!isBlock(s)) fail(`verticalsections.${name} is not a block`);
    if (!SECTION_NAME.test(name)) fail(`unusable section name ${JSON.stringify(name)}`);
    const altitudeMin = num(s, 'AltitudeMin', fail) ?? ALTITUDE_MIN;
    const altitudeMax = num(s, 'AltitudeMax', fail) ?? ALTITUDE_MAX;
    if (altitudeMin > altitudeMax) fail(`section "${name}" has AltitudeMin > AltitudeMax`);
    return { name, image: sectionImage(name), altitudeMin, altitudeMax };
  });
}

/** [x, y] in 0..1 of the radar, null when the file has neither key, an error when it has one. */
function marker(block, prefix, fail) {
  const x = num(block, `${prefix}_x`, fail);
  const y = num(block, `${prefix}_y`, fail);
  if (x === undefined && y === undefined) return null;
  if (x === undefined || y === undefined) fail(`${prefix}_x and ${prefix}_y must come together`);
  return [x, y];
}

function mapBlock(map, kv) {
  if (!isBlock(kv)) throw new TypeError(`overview ${map}: kv must be a parsed KeyValues object`);
  const inner = get(kv, map);
  if (isBlock(inner)) return inner;
  if (get(kv, 'pos_x') !== undefined) return kv;
  throw new Error(`overview ${map}: no "${map}" block (top-level keys: ${Object.keys(kv).join(', ') || 'none'})`);
}

/** Case-insensitive lookup; among keys differing only in case the last one wins. */
function get(obj, key) {
  const want = key.toLowerCase();
  let found;
  for (const k of Object.keys(obj)) if (k.toLowerCase() === want) found = obj[k];
  return found;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The key's value as a number; undefined when absent (an error when required or not numeric). */
function num(obj, key, fail, { required = false } = {}) {
  const v = get(obj, key);
  if (v === undefined) {
    if (required) fail(`missing ${key}`);
    return undefined;
  }
  if (typeof v !== 'string' || !NUMBER.test(v.trim())) fail(`${key} is not a number: ${JSON.stringify(v)}`);
  return Number(v.trim());
}

function isBlock(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
