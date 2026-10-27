// The sound banks: the manifest (`/sounds/manifest.json`) fetched once, and each bank (one family
// of clips, `/sounds/<bank>.webm`) fetched once by its hash and decoded when first needed. A
// manifest or bank that fails (a server without `/sounds/`, a 404, a browser that cannot decode
// Opus) warns once and is never asked for again: its sounds stay silent, nothing else changes.
// Once closed (the view that wanted them is gone), nothing more is decoded and nothing warns.

import { assetUrl } from '../api/assets';
import { messageOf } from '../errors';
import { parseSoundManifest, type SoundManifest } from './manifest';

const MANIFEST_URL = '/sounds/manifest.json';

/** The body at `url`; rejects on a failed request or an error status (a 404 is not a bank). */
export async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  return res.arrayBuffer();
}

export class SoundBanks {
  private readonly load: (url: string) => Promise<ArrayBuffer>;
  private readonly decode: (data: ArrayBuffer) => Promise<AudioBuffer>;
  private manifestP: Promise<SoundManifest | null> | null = null;
  /** Every bank asked for, loaded or not: none is asked for twice. */
  private readonly asked = new Set<string>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly done: string[] = [];
  private closed = false;

  /** `load` fetches a URL's bytes (`fetchBytes`); `decode` makes audio of them. */
  constructor(
    load: (url: string) => Promise<ArrayBuffer>,
    decode: (data: ArrayBuffer) => Promise<AudioBuffer>
  ) {
    this.load = load;
    this.decode = decode;
  }

  /** The banks decoded so far, in the order they came in. */
  get loaded(): readonly string[] {
    return this.done;
  }

  /** The manifest, fetched on the first call; null when it fails or is not a sounds manifest. */
  manifest(): Promise<SoundManifest | null> {
    this.manifestP ??= this.fetchManifest();
    return this.manifestP;
  }

  /** Starts fetching and decoding `bank` unless it was asked for before (or the banks closed). */
  ensure(bank: string): void {
    if (this.closed || this.asked.has(bank)) return;
    this.asked.add(bank);
    void this.fetchBank(bank);
  }

  /** `bank`'s audio, or null until it is decoded (and for good if it failed). */
  get(bank: string): AudioBuffer | null {
    return this.buffers.get(bank) ?? null;
  }

  /**
   * Lets go, with the audio context (the view is gone): nothing more is decoded, and a fetch or
   * decode still under way ends without a warning (it fails because the context closed).
   */
  close(): void {
    this.closed = true;
  }

  private async fetchManifest(): Promise<SoundManifest | null> {
    try {
      const raw: unknown = JSON.parse(
        new TextDecoder().decode(await this.load(MANIFEST_URL))
      );
      const manifest = parseSoundManifest(raw);
      if (!manifest) throw new Error('not a sounds manifest');
      return manifest;
    } catch (e) {
      if (!this.closed)
        console.warn(
          `sounds: ${MANIFEST_URL}: ${messageOf(e)}; playing silent`
        );
      return null;
    }
  }

  private async fetchBank(bank: string): Promise<void> {
    const manifest = await this.manifest();
    // Without a manifest it has already warned; every bank is silent.
    if (!manifest || this.closed) return;
    try {
      const entry = Object.hasOwn(manifest.banks, bank)
        ? manifest.banks[bank]
        : undefined;
      if (!entry) throw new Error('not in the manifest');
      const data = await this.load(
        assetUrl(`/sounds/${bank}.webm`, entry.sha256)
      );
      if (this.closed) return;
      const buffer = await this.decode(data);
      if (this.closed) return;
      this.buffers.set(bank, buffer);
      this.done.push(bank);
    } catch (e) {
      if (!this.closed)
        console.warn(
          `sounds: ${bank}: ${messageOf(e)}; its sounds stay silent`
        );
    }
  }
}
