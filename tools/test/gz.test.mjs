import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzSiblingState, writeGzSiblings } from '../lib/gz.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gz-test-'));

describe('writeGzSiblings', () => {
  it('writes a gzip -9 copy beside each file that inflates to the same bytes', () => {
    const dir = tmp();
    const body = Buffer.from('glTF'.repeat(5000));
    fs.writeFileSync(path.join(dir, 'world.glb'), body);
    fs.writeFileSync(path.join(dir, 'hull.glb'), Buffer.from('hull'));
    const out = writeGzSiblings(dir, ['world.glb', 'hull.glb']);
    expect(out.map((o) => o.name)).toEqual(['world.glb', 'hull.glb']);
    const gz = fs.readFileSync(path.join(dir, 'world.glb.gz'));
    expect(zlib.gunzipSync(gz).equals(body)).toBe(true);
    expect(out[0]).toEqual({ name: 'world.glb', bytes: body.length, gzBytes: gz.length });
    expect(gz.length).toBeLessThan(body.length / 10);
  });
});

describe('gzSiblingState', () => {
  it('is ok for a matching sibling, missing without one, stale when it inflates to other bytes', () => {
    const dir = tmp();
    const f = path.join(dir, 'world.glb');
    fs.writeFileSync(f, 'one');
    expect(gzSiblingState(f)).toBe('missing');
    writeGzSiblings(dir, ['world.glb']);
    expect(gzSiblingState(f)).toBe('ok');
    fs.writeFileSync(f, 'two');
    expect(gzSiblingState(f)).toBe('stale');
    fs.writeFileSync(`${f}.gz`, 'not gzip');
    expect(gzSiblingState(f)).toBe('stale');
  });
});
