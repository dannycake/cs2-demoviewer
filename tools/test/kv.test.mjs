import { parseKv } from '../lib/kv.mjs';

// Shaped like resource/overviews/<map>.txt: tabs, CRLF, trailing // comments,
// a comment between a key and its block, and no newline after the last brace.
const MIRAGE = [
  '// HLTV overview description file',
  '"de_mirage"',
  '{',
  '\t"material"\t"overviews/de_mirage"\t// c',
  '\t"pos_x"\t\t"-3230"\t// X coordinate,',
  '\t"pos_y"\t\t"1713"',
  '\t"scale"\t\t"5.00" \t// and used scale',
  '\tbare_key\tbare_value',
  '\t"verticalsections"',
  '\t{',
  '\t\t"default" // use the primary radar image',
  '\t\t{',
  '\t\t\t"AltitudeMax"\t"10000"',
  '\t\t\t"AltitudeMin"\t"-495"',
  '\t\t}',
  '\t\t"lower"',
  '\t\t{',
  '\t\t\t"AltitudeMax"\t"-495"',
  '\t\t\t"AltitudeMin"\t"-10000"',
  '\t\t}',
  '\t}',
  '\t"CTSpawn_x"\t"0.28"',
  '}',
].join('\r\n');

test('quoted keys and values, numbers stay strings', () => {
  const kv = parseKv(MIRAGE);
  expect(kv.de_mirage.pos_x).toBe('-3230');
  expect(kv.de_mirage.scale).toBe('5.00');
  expect(kv.de_mirage.material).toBe('overviews/de_mirage');
});

test('nested blocks, case preserved', () => {
  const kv = parseKv(MIRAGE);
  expect(kv.de_mirage.verticalsections.lower.AltitudeMin).toBe('-10000');
  expect(kv.de_mirage.verticalsections.default.AltitudeMin).toBe('-495');
  expect(kv.de_mirage.CTSpawn_x).toBe('0.28');
  expect(kv.de_mirage.ctspawn_x).toBeUndefined();
});

test('a // comment after a value is ignored', () => {
  const kv = parseKv(MIRAGE);
  expect(Object.keys(kv)).toEqual(['de_mirage']);
  expect(Object.keys(kv.de_mirage)).toEqual([
    'material', 'pos_x', 'pos_y', 'scale', 'bare_key', 'verticalsections', 'CTSpawn_x',
  ]);
  expect(Object.keys(kv.de_mirage.verticalsections)).toEqual(['default', 'lower']);
});

test('bare (unquoted) keys and values parse', () => {
  expect(parseKv(MIRAGE).de_mirage.bare_key).toBe('bare_value');
  expect(parseKv('a { b c d "e" }')).toEqual({ a: { b: 'c', d: 'e' } });
});

test('as in Valve\'s reader, a bare token ends at space, brace or quote, not at //', () => {
  expect(parseKv('k"v"')).toEqual({ k: 'v' });
  expect(parseKv('url http://x/y')).toEqual({ url: 'http://x/y' });
});

test('a comment at end of file without a newline, and a BOM, are fine', () => {
  expect(parseKv('\uFEFF"k" "v" // trailing')).toEqual({ k: 'v' });
  expect(parseKv('')).toEqual({});
  expect(parseKv('  // only a comment\n')).toEqual({});
});

test('duplicate keys: last wins', () => {
  expect(parseKv('"a" "1" "a" "2"')).toEqual({ a: '2' });
  expect(parseKv('"a" { "x" "1" } "a" { "y" "2" }')).toEqual({ a: { y: '2' } });
});

test('quoted strings may be empty or hold braces and spaces', () => {
  expect(parseKv('"k" ""  "b" "{ x }"')).toEqual({ k: '', b: '{ x }' });
});

test('__proto__ is stored as data, not as a prototype', () => {
  const kv = parseKv('"__proto__" { "polluted" "yes" }');
  expect(Object.getPrototypeOf(kv)).toBe(Object.prototype);
  expect(kv.polluted).toBeUndefined();
  expect(Object.keys(kv)).toEqual(['__proto__']);
  expect({}.polluted).toBeUndefined();
});

test('malformed input throws with a line number', () => {
  expect(() => parseKv('"a" {\n "b" "c"\n')).toThrow(/unclosed.*line 1/);
  expect(() => parseKv('"a" "b"\n}')).toThrow(/unexpected '}'.*line 2/);
  expect(() => parseKv('"a" "b\n')).toThrow(/unterminated.*line 1/);
  expect(() => parseKv('"a"')).toThrow(/no value.*line 1/);
  expect(() => parseKv('{ "a" "b" }')).toThrow(/unexpected '\{'.*line 1/);
});
