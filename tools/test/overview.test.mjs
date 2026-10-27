import { parseKv } from '../lib/kv.mjs';
import { overviewFromKv, overviewProblem, worldToRadar } from '../lib/overview.mjs';

const MIRAGE = `"de_mirage"
{
\t"material"\t"overviews/de_mirage"\t// texture file
\t"pos_x"\t\t"-3230"\t// X coordinate,
\t"pos_y"\t\t"1713"\t// Y coordinate,
\t"scale"\t\t"5.00" \t// and used scale used when taking the screenshot
\t// loading screen icons and positions
\t"CTSpawn_x"\t"0.28"
\t"CTSpawn_y"\t"0.70"
\t"TSpawn_x"\t"0.87"
\t"TSpawn_y"\t"0.36"
\t"bombA_x"\t"0.54"
\t"bombA_y"\t"0.76"
\t"bombB_x"\t"0.23"
\t"bombB_y"\t"0.28"
\t"inset_left"\t\t"0.135"
\t"inset_top"\t\t\t"0.08"
\t"inset_right"\t\t"0.105"
\t"inset_bottom"\t\t"0.08"
}`;

const NUKE = `// HLTV overview description file for de_nuke.bsp
"de_nuke"
{
\t"pos_x"\t\t"-3453"\t// upper left world coordinate
\t"pos_y"\t\t"2887"
\t"scale"\t\t"7"
\t"verticalsections"
\t{
\t\t"default" // use the primary radar image
\t\t{
\t\t\t"AltitudeMax" "10000"
\t\t\t"AltitudeMin" "-495"
\t\t}
\t\t"lower" // i.e. de_nuke_lower_radar.dds
\t\t{
\t\t\t"AltitudeMax" "-495"
\t\t\t"AltitudeMin" "-10000"
\t\t}
\t}
\t"CTSpawn_x"\t"0.82"
\t"CTSpawn_y"\t"0.45"
\t"TSpawn_x"\t"0.19"
\t"TSpawn_y"\t"0.54"
\t"bombA_x"\t"0.58"
\t"bombA_y"\t"0.48"
\t"bombB_x"\t"0.58"
\t"bombB_y"\t"0.58"
}`;

// de_anubis ships no bomb markers and no insets.
const ANUBIS = `// TAVR - AUTO RADAR. v 2.5.0a
"de_anubis"
{
\t"CTSpawn_x"\t"0.610000"
\t"CTSpawn_y"\t"0.220000"
\t"TSpawn_x"\t"0.580000"
\t"TSpawn_y"\t"0.930000"
\t"pos_x"\t"-2796.000000"
\t"pos_y"\t"3328.000000"
\t"scale"\t"5.220000"
}`;

const RADAR = { default: 'radar.png' };
const BOTH = { default: 'radar.png', lower: 'radar_lower.png' };
const mirage = () => overviewFromKv('de_mirage', parseKv(MIRAGE), RADAR);

test('Mirage: origin, scale and fixed size', () => {
  const ov = mirage();
  expect(ov.map).toBe('de_mirage');
  expect(ov.posX).toBe(-3230);
  expect(ov.posY).toBe(1713);
  expect(ov.scale).toBe(5);
  expect(ov.size).toBe(1024);
});

test('worldToRadar maps the radar corners to [0,0] and [1024,1024]', () => {
  const ov = mirage();
  expect(worldToRadar(-3230, 1713, ov)).toEqual([0, 0]);
  expect(worldToRadar(-3230 + 5 * 1024, 1713 - 5 * 1024, ov)).toEqual([1024, 1024]);
  expect(worldToRadar(-3230 + 5 * 100, 1713 - 5 * 200, ov)).toEqual([100, 200]);
});

test('no verticalsections: one default section spanning everything', () => {
  expect(mirage().sections).toEqual([
    { name: 'default', image: 'radar.png', altitudeMin: -10000, altitudeMax: 10000 },
  ]);
});

test('a Nuke-shaped verticalsections block gives two sections in file order', () => {
  const ov = overviewFromKv('de_nuke', parseKv(NUKE), BOTH);
  expect(ov.sections).toEqual([
    { name: 'default', image: 'radar.png', altitudeMin: -495, altitudeMax: 10000 },
    { name: 'lower', image: 'radar_lower.png', altitudeMin: -10000, altitudeMax: -495 },
  ]);
});

test('spawn and bomb markers, insets', () => {
  const ov = mirage();
  expect(ov.ctSpawn).toEqual([0.28, 0.70]);
  expect(ov.tSpawn).toEqual([0.87, 0.36]);
  expect(ov.bombA).toEqual([0.54, 0.76]);
  expect(ov.bombB).toEqual([0.23, 0.28]);
  expect(ov.inset).toEqual({ left: 0.135, top: 0.08, right: 0.105, bottom: 0.08 });
});

test('the whole Overview is plain JSON (no Infinity or NaN to lose)', () => {
  for (const ov of [mirage(), overviewFromKv('de_nuke', parseKv(NUKE), BOTH)]) {
    expect(JSON.parse(JSON.stringify(ov))).toEqual(ov);
  }
});

test('missing markers are null and missing insets are 0 (de_anubis)', () => {
  const ov = overviewFromKv('de_anubis', parseKv(ANUBIS), RADAR);
  expect(ov.scale).toBe(5.22);
  expect(ov.ctSpawn).toEqual([0.61, 0.22]);
  expect(ov.bombA).toBeNull();
  expect(ov.bombB).toBeNull();
  expect(ov.inset).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
});

test('keys are matched case-insensitively, the map block too', () => {
  const kv = parseKv('"DE_X" { "POS_X" "1" "Pos_Y" "2" "SCALE" "4" "ctspawn_x" "0.5" "CTSPAWN_Y" "0.25" }');
  const ov = overviewFromKv('de_x', kv, RADAR);
  expect([ov.posX, ov.posY, ov.scale]).toEqual([1, 2, 4]);
  expect(ov.ctSpawn).toEqual([0.5, 0.25]);
});

test('accepts the inner map block as well as the whole file', () => {
  expect(overviewFromKv('de_mirage', parseKv(MIRAGE).de_mirage, RADAR)).toEqual(mirage());
});

test('other section names get radar_<name>.png', () => {
  const kv = parseKv(`"m" { "pos_x" "0" "pos_y" "0" "scale" "1" "verticalsections" {
    "default" { "AltitudeMin" "100" } "mid" { "AltitudeMax" "100" "AltitudeMin" "0" } } }`);
  const ov = overviewFromKv('m', kv, { default: 'radar.png', mid: 'radar_mid.png' });
  expect(ov.sections).toEqual([
    { name: 'default', image: 'radar.png', altitudeMin: 100, altitudeMax: 10000 },
    { name: 'mid', image: 'radar_mid.png', altitudeMin: 0, altitudeMax: 100 },
  ]);
});

test('a section without its image, or an image without its section, throws', () => {
  // A lower section with no radar_lower.png would dangle.
  expect(() => overviewFromKv('de_nuke', parseKv(NUKE), RADAR)).toThrow(/de_nuke.*lower/);
  // A radar_lower.png with no section to show it on is a mismatch too.
  expect(() => overviewFromKv('de_mirage', parseKv(MIRAGE), BOTH)).toThrow(/de_mirage.*lower/);
});

test('missing or non-numeric pos_x / pos_y / scale throws, naming the key', () => {
  expect(() => overviewFromKv('m', parseKv('"m" { "pos_y" "0" "scale" "1" }'), RADAR)).toThrow(/m.*pos_x/);
  expect(() => overviewFromKv('m', parseKv('"m" { "pos_x" "0" "pos_y" "y" "scale" "1" }'), RADAR)).toThrow(/m.*pos_y/);
  expect(() => overviewFromKv('m', parseKv('"m" { "pos_x" "0" "pos_y" "0" "scale" "0" }'), RADAR)).toThrow(/m.*scale/);
  expect(() => overviewFromKv('m', parseKv('"other" { "pos_x" "0" }'), RADAR)).toThrow(/"m"/);
});

test('a section name in capitals throws: the viewer takes section images in lower case only', () => {
  const kv = parseKv(`"m" { "pos_x" "0" "pos_y" "0" "scale" "1" "verticalsections" {
    "default" { "AltitudeMin" "100" } "Lower" { "AltitudeMax" "100" } } }`);
  expect(() => overviewFromKv('m', kv, { default: 'radar.png', Lower: 'radar_Lower.png' })).toThrow(/"Lower"/);
});

test('overviewProblem (check-map.mjs) passes what overviewFromKv writes and names what it would not', () => {
  const nuke = JSON.parse(JSON.stringify(overviewFromKv('de_nuke', parseKv(NUKE), BOTH)));
  expect(overviewProblem(nuke, 'de_nuke')).toBeNull();
  expect(overviewProblem(mirage(), 'de_mirage')).toBeNull();
  expect(overviewProblem(nuke, 'de_mirage')).toBe('map is "de_nuke"');
  expect(overviewProblem([], 'de_nuke')).toBe('not an object');
  expect(overviewProblem({ ...nuke, scale: 0 }, 'de_nuke')).toBe('scale 0');
  expect(overviewProblem({ ...nuke, size: 512 }, 'de_nuke')).toBe('size 512');
  expect(overviewProblem({ ...nuke, sections: [] }, 'de_nuke')).toBe('no sections');
  const lower = nuke.sections[1];
  expect(overviewProblem({ ...nuke, sections: [nuke.sections[0], { ...lower, name: 'Lower', image: 'radar_Lower.png' }] }, 'de_nuke')).toBe('bad section name "Lower"');
  expect(overviewProblem({ ...nuke, sections: [nuke.sections[0], nuke.sections[0]] }, 'de_nuke')).toBe('bad section name "default"');
  expect(overviewProblem({ ...nuke, sections: [nuke.sections[0], { ...lower, image: 'lower.png' }] }, 'de_nuke')).toBe('section lower image "lower.png"');
  expect(overviewProblem({ ...nuke, sections: [nuke.sections[0], { ...lower, altitudeMin: 0, altitudeMax: -1 }] }, 'de_nuke')).toBe('section lower altitudes');
});
