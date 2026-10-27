import { describe, expect, it } from 'vitest';
import { needs, neededBy, type LocalData } from './helpers/gates';
import { skippedSummary } from './helpers/skipped-reporter';

const setOnly =
  (...set: LocalData[]) =>
  (v: LocalData) =>
    set.includes(v);

// As a test's full name reads in a block: the block's name, ' > ', the test's.
const NESTED = `${needs('Mirage hull surfaces, by the sounds manifest', 'ASSETS_DIR')} > ${needs('every round of the match', 'DEMOVIEWER_PACK')}`;

describe('neededBy', () => {
  it('reads a mark, one of several variables, and none', () => {
    expect(neededBy(needs('the spawns', 'DEMOVIEWER_PACK'))).toEqual([
      'DEMOVIEWER_PACK',
    ]);
    expect(
      neededBy(needs('the feet', 'DEMOVIEWER_PACK', 'ASSETS_DIR'))
    ).toEqual(['DEMOVIEWER_PACK', 'ASSETS_DIR']);
    expect(neededBy('reads a pack')).toBeNull();
  });

  it('takes every mark in a name, a block’s and its test’s, in one order', () => {
    expect(neededBy(NESTED)).toEqual(['DEMOVIEWER_PACK', 'ASSETS_DIR']);
    expect(
      neededBy(
        `${needs('a', 'ASSETS_DIR', 'DEMOVIEWER_PACK')} > ${needs('b', 'DEMOVIEWER_PACK')}`
      )
    ).toEqual(['DEMOVIEWER_PACK', 'ASSETS_DIR']);
  });
});

describe('skippedSummary', () => {
  it('counts a test in a marked block under every variable it needs', () => {
    expect(skippedSummary([{ name: NESTED, file: 'hull' }], setOnly())).toEqual(
      [
        '',
        ' Skipped for want of local data: 1 tests',
        '  1 need DEMOVIEWER_PACK + ASSETS_DIR (hull)',
        ' Set to run them:',
        expect.stringMatching(/^ {2}ASSETS_DIR: /),
        expect.stringMatching(/^ {2}DEMOVIEWER_PACK: /),
        '',
      ]
    );
  });

  it('names only the variables that are unset', () => {
    const lines = skippedSummary(
      [
        { name: NESTED, file: 'hull' },
        { name: needs('surfaces', 'ASSETS_DIR'), file: 'materials' },
      ],
      setOnly('ASSETS_DIR')
    );
    expect(lines).toEqual([
      '',
      ' Skipped for want of local data: 1 tests',
      '  1 need DEMOVIEWER_PACK (hull)',
      ' Set to run them:',
      expect.stringMatching(/^ {2}DEMOVIEWER_PACK: /),
      '',
    ]);
  });

  it('says nothing when no skipped test wanted local data', () => {
    expect(
      skippedSummary(
        [
          { name: 'a plain skip', file: 'timeline' },
          { name: needs('the spawns', 'DEMOVIEWER_PACK'), file: 'coords' },
        ],
        setOnly('DEMOVIEWER_PACK')
      )
    ).toBeNull();
  });

  it('groups tests by what they want, with their files', () => {
    const lines = skippedSummary(
      [
        { name: needs('a', 'ASSETS_DIR'), file: 'rig-real' },
        { name: needs('b', 'ASSETS_DIR'), file: 'arms' },
        { name: needs('c', 'ASSETS_DIR'), file: 'arms' },
        { name: needs('d', 'DEMOVIEWER_PACK_FP'), file: 'pack-reader' },
      ],
      setOnly()
    );
    expect(lines?.slice(1, 4)).toEqual([
      ' Skipped for want of local data: 4 tests',
      '  3 need ASSETS_DIR (arms, rig-real)',
      '  1 need DEMOVIEWER_PACK_FP (pack-reader)',
    ]);
  });
});
