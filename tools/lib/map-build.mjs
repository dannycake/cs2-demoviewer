// One map's shrink while it runs (shrink-map.mjs): what it has staged in <out>.tmp-<pid>/
// (lib/stage.mjs) and the timed log of its stages. main makes one and hands it to the bake and
// the tier ladder, which write, unwrite, gzip and count the first load through it, so they take
// this object instead of a bag of closures over main's locals, and a test can drive them with a
// stub document and a scratch directory.
import fs from 'node:fs';
import { writeGzSiblings } from './gz.mjs';
import { installMapOutputs } from './install.mjs';
import { firstLoadBytes } from './maps.mjs';
import { staging } from './stage.mjs';

export class MapBuild {
  /**
   * Stages into a fresh `<out>.tmp-<pid>/` (one a killed run of this pid left is removed) and
   * starts the clock.
   * @param {string} map
   * @param {{ out: string, raw?: string, rawLightmaps?: string }} paths  lib/paths.mjs paths(map), or as much of it as a test needs
   * @param {{ log?: (line: string) => void, now?: () => number }} [opts]  where the stage lines go, and the clock in ms
   */
  constructor(map, paths, { log = console.log, now = () => performance.now() } = {}) {
    this.map = map;
    this.paths = paths;
    this.out = paths.out;
    this.log = log;
    this.now = now;
    this.staged = staging(paths.out);
    /** The staging directory: every output is written here and renamed into `out` by `install`. */
    this.dir = this.staged.dir;
    /** The names this run wrote into `dir`, the `.gz` siblings among them: what `install` puts in place. */
    this.written = new Set();
    /** Each gzipped output's `.gz` size by name (shrink.json's `gzBytes`). */
    this.gzBytes = {};
    /** Seconds each stage took, by key, in the order they ran (shrink.json's `stages`). */
    this.stages = {};
    this.t0 = now();
    this.last = this.t0;
  }

  /** Logs one stage's line, `[  12.3s] key       msg (+4.5s)`, and records its seconds under `key`. */
  stage(key, msg) {
    const now = this.now();
    this.stages[key] = +((now - this.last) / 1000).toFixed(1);
    this.log(`[${((now - this.t0) / 1000).toFixed(1).padStart(6)}s] ${key.padEnd(9)} ${msg} (+${this.stages[key]}s)`);
    this.last = now;
  }

  /** Seconds since the build started, to a tenth (shrink.json's `seconds`). */
  seconds() {
    return +((this.now() - this.t0) / 1000).toFixed(1);
  }

  /** `name`'s path in the staging directory. */
  file(name) {
    return this.staged.file(name);
  }

  /** Whether this run has written `name`. */
  has(name) {
    return this.written.has(name);
  }

  write(name, bytes) {
    this.staged.write(name, bytes);
    this.written.add(name);
  }

  /** Takes back an output this run wrote (lightmap.webp, when tier V follows H2). */
  unwrite(name) {
    fs.rmSync(this.staged.file(name), { force: true });
    this.written.delete(name);
  }

  /** Writes the `.gz` sibling (lib/gz.mjs, gzip -9) of each of `names`, which must be written. */
  gzip(names) {
    for (const g of writeGzSiblings(this.dir, names)) {
      this.gzBytes[g.name] = g.gzBytes;
      this.written.add(`${g.name}.gz`);
    }
  }

  /** The first load (lib/maps.mjs firstLoadBytes) of `names` as staged so far. */
  firstLoad(names) {
    return firstLoadBytes(this.dir, names);
  }

  /**
   * Renames what this run wrote into `out` and removes the optional and retired outputs it did
   * not write (lib/install.mjs installMapOutputs), then the staging directory.
   */
  install() {
    installMapOutputs(this.dir, this.out, [...this.written]);
    this.abort();
  }

  /** Removes the staging directory and whatever is still in it. */
  abort() {
    this.staged.abort();
  }
}
