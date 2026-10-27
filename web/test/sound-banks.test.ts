// The sound banks (`audio/banks.ts`): the manifest fetched once, each bank fetched once by its
// hash and decoded; a bank that 404s or will not decode warns once, stays silent and is never
// asked for again, and the other banks load as if nothing happened; once closed with the view,
// nothing more loads and nothing still loading warns.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBytes, SoundBanks } from '../src/audio/banks';
import { SoundEngine } from '../src/audio/engine';
import { FakeAudioContext, fakeBuffer } from './helpers/fake-audio';

const SHA_AK = 'eb345930' + 'a'.repeat(56);
const SHA_STEP = 'ffffffff' + 'b'.repeat(56);
const SHA_BAD = '12345678' + 'c'.repeat(56);

const MANIFEST = {
  schema: 1,
  banks: {
    weapon_ak47: { sha256: SHA_AK, bytes: 66975, seconds: 11.37 },
    steps_concrete: { sha256: SHA_STEP, bytes: 20000, seconds: 3.1 },
    broken: { sha256: SHA_BAD, bytes: 10, seconds: 1 },
  },
  sounds: {
    'shot:ak47': { bank: 'weapon_ak47', layers: [{ clips: [[0, 1.9]] }] },
    'step:concrete:ct': {
      bank: 'steps_concrete',
      layers: [{ clips: [[0, 0.3]] }],
    },
  },
  surfaces: { plaster: 'concrete' },
};

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Banks over `files` (a path → its body; a path missing is a 404); `broken` bodies do not decode.
 * `urls` lists every URL asked for, `decoded` each buffer made, by the body it came from.
 */
function setup(files: Record<string, string>) {
  const urls: string[] = [];
  const decoded = new Map<string, AudioBuffer>();
  const load = vi.fn(async (url: string) => {
    urls.push(url);
    const body = files[url.replace(/\?.*$/, '')];
    if (body === undefined) throw new Error('HTTP 404');
    return bytes(body);
  });
  const decode = vi.fn(async (data: ArrayBuffer) => {
    const body = new TextDecoder().decode(data);
    if (body === 'broken') throw new Error('Unable to decode audio data');
    const buffer = fakeBuffer(1, body);
    decoded.set(body, buffer);
    return buffer;
  });
  return { banks: new SoundBanks(load, decode), load, decode, urls, decoded };
}

const ALL = {
  '/sounds/manifest.json': JSON.stringify(MANIFEST),
  '/sounds/weapon_ak47.webm': 'ak47 bank',
  '/sounds/steps_concrete.webm': 'concrete steps',
  '/sounds/broken.webm': 'broken',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SoundBanks.manifest', () => {
  it('fetches /sounds/manifest.json once and parses it', async () => {
    const { banks, urls } = setup(ALL);
    const [a, b] = await Promise.all([banks.manifest(), banks.manifest()]);
    expect(a).toBe(b);
    expect(await banks.manifest()).toBe(a);
    expect(urls).toEqual(['/sounds/manifest.json']);
    expect(Object.keys(a!.banks)).toEqual([
      'weapon_ak47',
      'steps_concrete',
      'broken',
    ]);
    expect(a!.sounds['shot:ak47'].bank).toBe('weapon_ak47');
    expect(a!.surfaces).toEqual({ plaster: 'concrete' });
  });

  it('a manifest that is not JSON gives null, with one warning, and is not asked for again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { banks, urls } = setup({ '/sounds/manifest.json': '<html>' });
    expect(await banks.manifest()).toBeNull();
    expect(await banks.manifest()).toBeNull();
    expect(urls).toEqual(['/sounds/manifest.json']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^sounds: /);
  });

  it('a manifest that 404s, or is JSON but not a sounds manifest, gives null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await setup({}).banks.manifest()).toBeNull();
    expect(
      await setup({ '/sounds/manifest.json': '{"maps": {}}' }).banks.manifest()
    ).toBeNull();
  });
});

describe('SoundBanks.ensure', () => {
  it('fetches a bank once, by its hash, and holds it once decoded', async () => {
    const { banks, urls, decoded, decode } = setup(ALL);
    banks.ensure('weapon_ak47');
    banks.ensure('weapon_ak47');
    expect(banks.get('weapon_ak47')).toBeNull();
    await flush();
    banks.ensure('weapon_ak47');
    await flush();
    expect(urls).toEqual([
      '/sounds/manifest.json',
      '/sounds/weapon_ak47.webm?v=eb345930',
    ]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(banks.get('weapon_ak47')).toBe(decoded.get('ak47 bank'));
    expect(banks.loaded).toEqual(['weapon_ak47']);
    expect(banks.get('steps_concrete')).toBeNull();
  });

  it('a bank that 404s warns once, stays null and is never asked for again; the others load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const files: Record<string, string> = { ...ALL };
    delete files['/sounds/steps_concrete.webm'];
    const { banks, urls } = setup(files);
    for (let i = 0; i < 3; i++) {
      banks.ensure('steps_concrete');
      banks.ensure('weapon_ak47');
      await flush();
    }
    expect(urls.filter((u) => u.includes('steps_concrete'))).toEqual([
      '/sounds/steps_concrete.webm?v=ffffffff',
    ]);
    expect(banks.get('steps_concrete')).toBeNull();
    expect(banks.get('weapon_ak47')).not.toBeNull();
    expect(banks.loaded).toEqual(['weapon_ak47']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /^sounds: steps_concrete: .*404.*; its sounds stay silent$/
    );
  });

  it('a bank that will not decode warns once, stays null and is never asked for again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { banks, urls, decode } = setup(ALL);
    for (let i = 0; i < 3; i++) {
      banks.ensure('broken');
      banks.ensure('steps_concrete');
      await flush();
    }
    expect(urls.filter((u) => u.includes('broken'))).toHaveLength(1);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(banks.get('broken')).toBeNull();
    expect(banks.get('steps_concrete')).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /^sounds: broken: Unable to decode audio data; its sounds stay silent$/
    );
  });

  it('a bank the manifest does not list: one warning, nothing fetched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { banks, urls } = setup(ALL);
    banks.ensure('weapon_m4a1');
    banks.ensure('weapon_m4a1');
    await flush();
    expect(urls).toEqual(['/sounds/manifest.json']);
    expect(banks.get('weapon_m4a1')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('without a manifest no bank is fetched, and only the manifest warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { banks, urls } = setup({});
    banks.ensure('weapon_ak47');
    banks.ensure('steps_concrete');
    await flush();
    expect(urls).toEqual(['/sounds/manifest.json']);
    expect(banks.get('weapon_ak47')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('SoundBanks.close', () => {
  it('a bank still loading or decoding when the view goes (the engine closed) ends without a warning; nothing more loads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The real engine: its context closes with the view, and a decode under way then fails.
    const ctx = new FakeAudioContext();
    const engine = new SoundEngine(() => ctx);
    let failDecode: (e: Error) => void = () => {};
    ctx.decodeResult = () =>
      new Promise((_, reject) => {
        failDecode = reject;
      });
    const urls: string[] = [];
    let releaseFetch: () => void = () => {};
    const load = async (url: string) => {
      urls.push(url);
      const path = url.replace(/\?.*$/, '');
      // The steps' bank is still on the wire when the view goes.
      if (path === '/sounds/steps_concrete.webm')
        await new Promise<void>((r) => (releaseFetch = r));
      return bytes(ALL[path as keyof typeof ALL]);
    };
    const banks = new SoundBanks(load, (d) => engine.decode(d));
    engine.unlock();
    banks.ensure('weapon_ak47');
    banks.ensure('steps_concrete');
    await flush();
    // The AK's bank is decoding, the steps' still loading.
    banks.close();
    engine.close();
    failDecode(new Error('the AudioContext was closed'));
    releaseFetch();
    await flush();
    banks.ensure('broken');
    await flush();
    expect(warn).not.toHaveBeenCalled();
    expect(urls.some((u) => u.includes('broken'))).toBe(false);
    expect(banks.loaded).toEqual([]);
    // Without the banks' close, the closed engine's refusal is said as it is.
    await expect(engine.decode(new ArrayBuffer(4))).rejects.toThrow(
      'sound is closed'
    );
  });

  it('a manifest that fails after the close says nothing either', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail: (e: Error) => void = () => {};
    const banks = new SoundBanks(
      () => new Promise((_, reject) => (fail = reject)),
      async () => fakeBuffer(1)
    );
    const manifest = banks.manifest();
    banks.close();
    fail(new Error('HTTP 404'));
    expect(await manifest).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('fetchBytes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives the body of a good answer and rejects an error status', async () => {
    const body = bytes('bank');
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('missing.webm')
        ? new Response('not found', { status: 404, statusText: 'Not Found' })
        : new Response(body)
    );
    vi.stubGlobal('fetch', fetch);
    const got = await fetchBytes('/sounds/bank.webm?v=12345678');
    expect(new TextDecoder().decode(got)).toBe('bank');
    await expect(fetchBytes('/sounds/missing.webm')).rejects.toThrow(/404/);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/sounds/bank.webm?v=12345678',
      '/sounds/missing.webm',
    ]);
  });
});
