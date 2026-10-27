import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { chooseToken, expiresAt, loadToken, saveToken, usableToken } from '../src/token.mjs';
import { jwt, steamJwt } from './fixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcbot-token-'));

describe('expiresAt', () => {
  it("reads the JWT's exp", () => {
    assert.deepEqual(expiresAt(steamJwt(1_800_000_000)), new Date(1_800_000_000_000));
  });

  it('is null for anything malformed', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'abc',
      'a.b',
      'a.b.c',
      `x.${Buffer.from('not json').toString('base64url')}.y`,
      jwt({ iss: 'steam' }),
      jwt({ exp: 'soon' }),
      `x.${Buffer.from('7').toString('base64url')}.y`,
    ]) {
      assert.equal(expiresAt(bad), null, String(bad));
    }
  });
});

describe('chooseToken', () => {
  const early = steamJwt(1_800_000_000);
  const late = steamJwt(1_900_000_000);

  it('picks the later expiry, wherever it comes from', () => {
    assert.equal(chooseToken(early, late), late);
    assert.equal(chooseToken(late, early), late);
  });

  it('survives a malformed JWT on either side', () => {
    assert.equal(chooseToken('garbage', early), early);
    assert.equal(chooseToken(early, 'garbage'), early);
    assert.equal(chooseToken(undefined, early), early);
    assert.equal(chooseToken(early, null), early);
    assert.equal(chooseToken('', ''), null);
    assert.equal(chooseToken(null, undefined), null);
  });
});

describe('usableToken', () => {
  const now = 1_850_000_000_000;
  it('takes an unexpired Steam client refresh token only', () => {
    assert.equal(usableToken(steamJwt(1_900_000_000), now), true);
    assert.equal(usableToken(steamJwt(1_800_000_000), now), false);
    assert.equal(
      usableToken(jwt({ iss: 'other', aud: ['client'], exp: 1_900_000_000 }), now),
      false
    );
    assert.equal(usableToken(jwt({ iss: 'steam', aud: ['web'], exp: 1_900_000_000 }), now), false);
    assert.equal(usableToken('garbage', now), false);
  });
});

describe('saveToken', () => {
  it('leaves refresh-token at mode 600 and no .tmp', () => {
    const dir = tmp();
    saveToken(dir, 'first');
    // A leftover .tmp from a crash, wider than it should be, must not widen the result.
    fs.writeFileSync(path.join(dir, 'refresh-token.tmp'), 'stale', { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'refresh-token.tmp'), 0o644);
    saveToken(dir, 'second');
    assert.deepEqual(fs.readdirSync(dir), ['refresh-token']);
    assert.equal(fs.statSync(path.join(dir, 'refresh-token')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(dir, 'refresh-token'), 'utf8'), 'second');
    assert.equal(loadToken(dir), 'second');
  });

  it('loadToken is null when nothing was saved', () => {
    assert.equal(loadToken(tmp()), null);
  });
});
