import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { startSteam } from '../src/steam.mjs';
import { steamJwt } from './fixtures.mjs';

const YEAR = 365 * 86_400;
const now = () => Math.floor(Date.now() / 1000);

/** steam-user's surface that steam.mjs touches. */
class FakeUser extends EventEmitter {
  static last = null;
  constructor(options) {
    super();
    this.options = options;
    this.logOns = [];
    this.played = [];
    FakeUser.last = this;
  }
  logOn(details) {
    this.logOns.push(details);
  }
  gamesPlayed(apps) {
    this.played.push(apps);
  }
  logOff() {
    this.loggedOff = true;
  }
}

/** globaloffensive's surface that steam.mjs touches. */
class FakeGc extends EventEmitter {
  static last = null;
  constructor(user) {
    super();
    this.user = user;
    this.haveGCSession = false;
    this.requests = [];
    FakeGc.last = this;
  }
  requestGame(details) {
    this.requests.push(details);
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcbot-steam-'));
const start = (envToken, stateDir = tmp(), log = () => {}) => {
  const steam = startSteam({
    envToken,
    stateDir,
    log,
    SteamUser: FakeUser,
    GlobalOffensive: FakeGc,
  });
  return { steam, user: FakeUser.last, gc: FakeGc.last, stateDir };
};
const saved = (dir) => fs.readFileSync(path.join(dir, 'refresh-token'), 'utf8');

describe('startSteam', () => {
  it('logs on with the later of the env and saved tokens, and saves it first', () => {
    const dir = tmp();
    // One clock reading: starting can take over a second, which moved a later reading's year.
    const expires = now() + YEAR;
    const older = steamJwt(expires - YEAR / 2);
    const newer = steamJwt(expires);
    fs.writeFileSync(path.join(dir, 'refresh-token'), newer);
    const { steam, user } = start(older, dir);
    assert.deepEqual(user.options.renewRefreshTokens, true);
    assert.deepEqual(user.options.autoRelogin, true);
    assert.equal(user.options.dataDirectory, path.join(dir, 'steam'));
    assert.deepEqual(user.logOns, [{ refreshToken: newer }]);
    assert.equal(saved(dir), newer);
    assert.equal(steam.health().tokenExpiresAt, new Date(expires * 1000).toISOString());
    steam.stop();
  });

  it('puts the env token on disk when the volume is empty', () => {
    const token = steamJwt(now() + YEAR);
    const { steam, stateDir } = start(token);
    assert.equal(saved(stateDir), token);
    steam.stop();
  });

  it('saves a renewed refresh token before any other listener sees it', () => {
    const { steam, user, stateDir } = start(steamJwt(now() + YEAR / 2));
    const expires = now() + YEAR;
    const renewed = steamJwt(expires);
    let onDisk = null;
    user.on('refreshToken', () => (onDisk = saved(stateDir)));
    user.emit('refreshToken', renewed);
    assert.equal(onDisk, renewed);
    assert.equal(steam.health().tokenExpiresAt, new Date(expires * 1000).toISOString());
    steam.stop();
  });

  it('stays offline without a usable token instead of logging on', () => {
    for (const token of [undefined, 'garbage', steamJwt(now() - 60)]) {
      const { steam, user } = start(token);
      assert.deepEqual(user.logOns, []);
      assert.deepEqual(steam.health(), {
        steam: 'offline',
        gc: false,
        tokenExpiresAt: steam.health().tokenExpiresAt,
      });
      assert.equal(steam.isOnline(), false);
      steam.stop();
    }
  });

  it('plays CS2 on every logon and is online only with a GC session', () => {
    const { steam, user, gc } = start(steamJwt(now() + YEAR));
    user.emit('loggedOn');
    assert.deepEqual(user.played, [[730]]);
    assert.equal(steam.health().steam, 'online');
    assert.equal(steam.isOnline(), false);
    gc.haveGCSession = true;
    gc.emit('connectedToGC');
    assert.equal(steam.isOnline(), true);
    assert.equal(steam.health().gc, true);
    user.emit('disconnected', 3, 'NoConnection');
    gc.haveGCSession = false;
    assert.equal(steam.isOnline(), false);
    user.emit('loggedOn');
    assert.deepEqual(user.played, [[730], [730]]);
    steam.stop();
  });

  it('logs a GC that refuses the alt instead of throwing, and stays offline', () => {
    const lines = [];
    const { steam, user, gc } = start(steamJwt(now() + YEAR), tmp(), (line) => lines.push(line));
    user.emit('loggedOn');
    // globaloffensive's ClientLogonFatalError: an `error` nobody listens to would end gcbot.
    const refused = Object.assign(new Error('Logon Fatal Error: 5'), { code: 5 });
    assert.doesNotThrow(() => gc.emit('error', refused));
    assert.equal(steam.isOnline(), false);
    assert.ok(lines.includes('gc: Logon Fatal Error: 5 (code 5)'), lines.join('\n'));
    steam.stop();
  });

  it('plays CS2 again once another session of the alt stops playing', () => {
    const { steam, user } = start(steamJwt(now() + YEAR));
    user.emit('loggedOn');
    // Steam says so after every logon: nothing was blocked, nothing to play again.
    user.emit('playingState', false, 0);
    assert.deepEqual(user.played, [[730]]);
    user.emit('playingState', true, 730);
    assert.deepEqual(user.played, [[730]]);
    user.emit('playingState', false, 0);
    assert.deepEqual(user.played, [[730], [730]]);
    steam.stop();
  });

  it('sends the decoded code to the GC and hands every matchList over until cancelled', () => {
    const { steam, gc } = start(steamJwt(now() + YEAR));
    const details = {
      matchId: '3230642215713767580',
      outcomeId: '3230647599455273103',
      token: 55788,
    };
    const lists = [];
    const cancel = steam.request('CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK', details, (m) =>
      lists.push(m)
    );
    assert.deepEqual(gc.requests, [details]);
    gc.emit('matchList', [{ matchid: '1' }], {});
    cancel();
    gc.emit('matchList', [{ matchid: '2' }], {});
    assert.deepEqual(lists, [[{ matchid: '1' }]]);
    steam.stop();
  });
});
