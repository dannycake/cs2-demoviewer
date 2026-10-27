// The packs the match-wide tests read: the synthetic match (synthetic-match.ts) always, and a
// real match's pack when DEMOVIEWER_PACK names one. A block of checks that hold for any match
// runs once against each (`MATCHES`); the checks of one demo's own numbers (the Mirage pack's 24
// rounds, its director's 77 %) run against the real one alone.

import { readFile } from 'node:fs/promises';
import { inflateIfGzip, parsePack } from '../../src/pack/reader';
import type { Pack } from '../../src/pack/types';
import { encodePack } from './build-pack';
import { has, needs } from './gates';
import { syntheticMatch } from './synthetic-match';

export interface MatchPack {
  /** "the synthetic match", or "the real match [needs DEMOVIEWER_PACK]". */
  name: string;
  real: boolean;
  /** The pack is not there to read: the real one without DEMOVIEWER_PACK. */
  skip: boolean;
  /**
   * The pack, parsed afresh on each call (a test timed "from a fresh pack" builds the caches
   * kept per pack inside its timing): the real one from DEMOVIEWER_PACK, the synthetic one
   * through the pack writer and the reader, as a real one is read.
   */
  load(): Promise<Pack>;
}

let syntheticBytes: Uint8Array | null = null;

/** The real match's pack at DEMOVIEWER_PACK, parsed afresh. */
export async function realMatch(): Promise<Pack> {
  const file = process.env.DEMOVIEWER_PACK;
  if (!file) throw new Error('DEMOVIEWER_PACK is not set');
  return parsePack(await inflateIfGzip(new Uint8Array(await readFile(file))));
}

export const MATCHES: readonly MatchPack[] = [
  {
    name: 'the synthetic match',
    real: false,
    skip: false,
    load: async () =>
      parsePack((syntheticBytes ??= encodePack(syntheticMatch()))),
  },
  {
    name: needs('the real match', 'DEMOVIEWER_PACK'),
    real: true,
    skip: !has('DEMOVIEWER_PACK'),
    load: realMatch,
  },
];
