// A Web Audio context for tests (`AudioContextLike`, audio/engine.ts) that makes no sound: it
// records every node it creates and where each connects, each parameter's value and automation,
// and each source's starts and stops, so a test reads what the engine asked of the context. Its
// `resume()` runs it, or (`resumeAs`) leaves it suspended or rejects, as a browser does for a
// press it does not count as a gesture.

import type {
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
} from '../../src/audio/engine';

/** One automation call on a parameter. */
export interface ParamEvent {
  kind: 'set' | 'ramp' | 'target' | 'cancel';
  value: number;
  time: number;
}

/** A parameter: `value` is what the last call set or aims at, `events` every call. */
export class FakeParam implements AudioParamLike {
  value: number;
  readonly events: ParamEvent[] = [];

  constructor(value: number) {
    this.value = value;
  }

  setValueAtTime(value: number, time: number): void {
    this.events.push({ kind: 'set', value, time });
    this.value = value;
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ kind: 'ramp', value, time });
    this.value = value;
  }

  setTargetAtTime(value: number, time: number): void {
    this.events.push({ kind: 'target', value, time });
    this.value = value;
  }

  cancelScheduledValues(time: number): void {
    this.events.push({ kind: 'cancel', value: this.value, time });
  }
}

export class FakeNode implements AudioNodeLike {
  readonly kind: string;
  /** The nodes this one connects to, in order. */
  readonly outputs: FakeNode[] = [];
  disconnected = false;

  constructor(kind: string) {
    this.kind = kind;
  }

  connect(destination: FakeNode): FakeNode {
    this.outputs.push(destination);
    return destination;
  }

  disconnect(): void {
    this.outputs.length = 0;
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);

  constructor() {
    super('gain');
  }
}

export class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeParam(1);
  onended: ((ev: Event) => unknown) | null = null;
  /** `start(when, offset, duration)` as called (an argument left out stays undefined). */
  readonly starts: [number, number | undefined, number | undefined][] = [];
  readonly stops: number[] = [];

  constructor() {
    super('source');
  }

  start(when = 0, offset?: number, duration?: number): void {
    this.starts.push([when, offset, duration]);
  }

  stop(when = 0): void {
    this.stops.push(when);
  }

  /** What the context does when the clip has played out (or reached a `stop`). */
  end(): void {
    this.onended?.(new Event('ended'));
  }
}

export class FakePanner extends FakeNode {
  panningModel: PanningModelType = 'equalpower';
  distanceModel: DistanceModelType = 'inverse';
  rolloffFactor = 1;
  readonly positionX = new FakeParam(0);
  readonly positionY = new FakeParam(0);
  readonly positionZ = new FakeParam(0);

  constructor() {
    super('panner');
  }
}

export class FakeCompressor extends FakeNode {
  // Chromium's defaults.
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);

  constructor() {
    super('compressor');
  }
}

/** The listener: with `positionX…`/`forwardX…`/`upX…`, or (`legacy`) only the two setters. */
export class FakeListener {
  positionX?: FakeParam;
  positionY?: FakeParam;
  positionZ?: FakeParam;
  forwardX?: FakeParam;
  forwardY?: FakeParam;
  forwardZ?: FakeParam;
  upX?: FakeParam;
  upY?: FakeParam;
  upZ?: FakeParam;
  readonly positions: [number, number, number][] = [];
  readonly orientations: [number, number, number, number, number, number][] =
    [];

  constructor(legacy: boolean) {
    if (legacy) return;
    this.positionX = new FakeParam(0);
    this.positionY = new FakeParam(0);
    this.positionZ = new FakeParam(0);
    this.forwardX = new FakeParam(0);
    this.forwardY = new FakeParam(0);
    this.forwardZ = new FakeParam(-1);
    this.upX = new FakeParam(0);
    this.upY = new FakeParam(1);
    this.upZ = new FakeParam(0);
  }

  setPosition(x: number, y: number, z: number): void {
    this.positions.push([x, y, z]);
  }

  setOrientation(
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number
  ): void {
    this.orientations.push([fx, fy, fz, ux, uy, uz]);
  }
}

/**
 * What `resume()` does: `running` runs the context (a gesture the browser counts), `suspended`
 * leaves it suspended (a finger's `pointerdown`, Esc), `rejected` rejects and leaves it so.
 */
export type ResumeAs = 'running' | 'suspended' | 'rejected';

export interface FakeContextOptions extends AudioContextOptions {
  /** A listener with only `setPosition`/`setOrientation` (Firefox). */
  legacyListener?: boolean;
  resumeAs?: ResumeAs;
}

export class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  state = 'suspended';
  resumes = 0;
  closed = false;
  /** What `resume()` does from now on (it can change between gestures). */
  resumeAs: ResumeAs;
  /** What the context was made with. */
  readonly options: FakeContextOptions;
  /** The rate asked for, else a device's 48 kHz. */
  readonly sampleRate: number;
  readonly destination = new FakeNode('destination');
  readonly listener: FakeListener;
  /** Every node made, in order. */
  readonly nodes: FakeNode[] = [];
  /** What `decodeAudioData` answers. */
  decodeResult: (data: ArrayBuffer) => Promise<AudioBuffer> = () =>
    Promise.resolve(fakeBuffer(1));

  constructor(options: FakeContextOptions = {}) {
    this.options = options;
    this.sampleRate = options.sampleRate ?? 48000;
    this.resumeAs = options.resumeAs ?? 'running';
    this.listener = new FakeListener(options.legacyListener ?? false);
  }

  resume(): Promise<void> {
    this.resumes++;
    if (this.resumeAs === 'rejected')
      return Promise.reject(
        new Error('the AudioContext was not allowed to start')
      );
    if (this.resumeAs === 'running') this.state = 'running';
    return Promise.resolve();
  }

  createGain(): FakeGain {
    return this.made(new FakeGain());
  }

  createBufferSource(): FakeSource {
    return this.made(new FakeSource());
  }

  createPanner(): FakePanner {
    return this.made(new FakePanner());
  }

  createDynamicsCompressor(): FakeCompressor {
    return this.made(new FakeCompressor());
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.decodeResult(data);
  }

  close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }

  sources(): FakeSource[] {
    return this.nodes.filter((n) => n instanceof FakeSource);
  }

  panners(): FakePanner[] {
    return this.nodes.filter((n) => n instanceof FakePanner);
  }

  /** The gain every sound goes through: the one that feeds the compressor. */
  master(): FakeGain {
    const m = this.nodes.find(
      (n) =>
        n instanceof FakeGain &&
        n.outputs.some((o) => o instanceof FakeCompressor)
    );
    if (!(m instanceof FakeGain)) throw new Error('no master gain');
    return m;
  }

  /** The kinds of nodes from `node` to wherever its first outputs lead. */
  path(node: FakeNode): string[] {
    const kinds = [node.kind];
    for (let n = node.outputs[0]; n; n = n.outputs[0]) kinds.push(n.kind);
    return kinds;
  }

  /** The gain node right after `source`. */
  gainOf(source: FakeSource): FakeGain {
    const g = source.outputs[0];
    if (!(g instanceof FakeGain)) throw new Error('source not into a gain');
    return g;
  }

  /** The panner after `source`'s gain, or null. */
  pannerOf(source: FakeSource): FakePanner | null {
    const p = this.gainOf(source).outputs[0];
    return p instanceof FakePanner ? p : null;
  }

  private made<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
}

/** An `AudioBuffer` stand-in: the engine only hands it to its sources. */
export function fakeBuffer(seconds: number, tag = ''): AudioBuffer {
  return {
    duration: seconds,
    length: Math.round(seconds * 48000),
    sampleRate: 48000,
    numberOfChannels: 1,
    tag,
  } as unknown as AudioBuffer;
}
