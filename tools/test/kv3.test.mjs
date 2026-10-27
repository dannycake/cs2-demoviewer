import { describe, expect, it } from 'vitest';
import { parseKv3 } from '../lib/kv3.mjs';

// Hand-written, shaped like VRF's decompiled output: the header, a dotted event name,
// a curve with an empty point and trailing commas, and the scalar kinds.
const DOC = [
  '<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->',
  '{',
  '\tThing.Alpha =',
  '\t{',
  '\t\tvsnd_files_track_01 =',
  '\t\t[',
  '\t\t\t"sounds/a/one.vsnd",',
  '\t\t\t"sounds/a/two.vsnd",',
  '\t\t]',
  '\t\tdistance_volume_mapping_curve =',
  '\t\t[',
  '\t\t\t[ ],',
  '\t\t\t[ 30.0, 1.0, 0.001, 0.001, 1.0, 1.0, ],',
  '\t\t]',
  '\t\tuse_distance = true',
  '\t\tpitch = -0.02',
  '\t\tvolume_random_min = 1e-05',
  '\t\tnothing = null',
  '\t}',
  '\tThing.Beta =',
  '\t{',
  '\t\tbase = "Thing.Alpha"',
  '\t\tvolume = 0.5',
  '\t}',
  '}',
].join('\n');

describe('parseKv3', () => {
  it('reads a file of dotted-name events with arrays, curves and scalars', () => {
    expect(parseKv3(DOC)).toEqual({
      'Thing.Alpha': {
        vsnd_files_track_01: ['sounds/a/one.vsnd', 'sounds/a/two.vsnd'],
        distance_volume_mapping_curve: [[], [30, 1, 0.001, 0.001, 1, 1]],
        use_distance: true,
        pitch: -0.02,
        volume_random_min: 1e-5,
        nothing: null,
      },
      'Thing.Beta': { base: 'Thing.Alpha', volume: 0.5 },
    });
  });

  it('reads empty arrays and objects, tagged and escaped strings, and quoted keys', () => {
    expect(parseKv3('{ a = [ ] b = { } c = resource:"x/y.vsnd" "d e" = "q\\"\\n" f = +2.5E3 }')).toEqual({
      a: [], b: {}, c: 'x/y.vsnd', 'd e': 'q"\n', f: 2500,
    });
  });

  it('lets a later duplicate key win and keeps __proto__ as an ordinary key', () => {
    const o = parseKv3('{ a = 1 a = 2 __proto__ = 3 }');
    expect(o.a).toBe(2);
    expect(Object.keys(o)).toEqual(['a', '__proto__']);
    expect(({}).polluted).toBeUndefined();
  });

  it('skips line and block comments, counting the lines a block spans', () => {
    expect(parseKv3('{ a = 1 // x\n /* b = 2\n */ c = 3 }')).toEqual({ a: 1, c: 3 });
    expect(() => parseKv3('{ /* one\n two */ a = }')).toThrow(/line 2/);
    expect(() => parseKv3('{ /* open')).toThrow(/unterminated comment/);
  });

  it('throws naming line 1 for a key with no value', () => {
    expect(() => parseKv3('{ a = }')).toThrow(/line 1/);
  });

  it('names the line of the fault', () => {
    expect(() => parseKv3('{\n a = 1\n b = [ 1 2 ]\n}')).toThrow(/line 3/);
    expect(() => parseKv3('{\n a = bogus\n}')).toThrow(/line 2.*bogus|bogus.*line 2/);
    expect(() => parseKv3('{\n a = "open\n}')).toThrow(/line 2/);
    expect(() => parseKv3('{ a = 1')).toThrow(/unterminated object/);
    expect(() => parseKv3('{ a = 1 } }')).toThrow(/after the value/);
  });
});
