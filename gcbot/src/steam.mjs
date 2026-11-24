// The alt's Steam session: steam-user logged on with the refresh token, "playing" CS2 so that
// globaloffensive gets a Game Coordinator session, and the GC requests a share code and a
// player's recent matches become.
import path from 'node:path';
import GlobalOffensiveClient from 'globaloffensive';
import SteamUserClient from 'steam-user';
import { chooseToken, expiresAt, loadToken, saveToken, usableToken } from './token.mjs';

const CS2 = 730;
// After a fatal logon error (a revoked token, Steam down): wait this long, doubling to the cap.
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;

/**
 * Logs the alt on and keeps it on. `envToken` is STEAM_REFRESH_TOKEN; `stateDir` holds
 * `refresh-token` and steam-user's own files. Without a usable token it stays offline and says
 * so (`node src/login.mjs` on the desktop makes one).
 *
 * Returns `{ isOnline(), health(), request(code, details, onList), requestRecent(steamid,
 * onList), stop() }`; `request` and `requestRecent` are what createResolver takes.
 */
export function startSteam({
  envToken,
  stateDir,
  log,
  SteamUser = SteamUserClient,
  GlobalOffensive = GlobalOffensiveClient,
}) {
  let token = chooseToken(envToken, loadToken(stateDir));
  // The volume always holds the newest token, and a volume gcbot cannot write fails here, at
  // start, rather than at the first renewal.
  if (token) saveToken(stateDir, token);

  const user = new SteamUser({
    renewRefreshTokens: true,
    autoRelogin: true,
    dataDirectory: path.join(stateDir, 'steam'),
  });
  const gc = new GlobalOffensive(user);
  let loggedOn = false;
  let playingBlocked = false;
  let retryMs = RETRY_FIRST_MS;
  let retryTimer = null;
  let stopped = false;

  // First listener, and synchronous: the renewed token is on disk before steam-user or anything
  // else here uses it.
  user.on('refreshToken', (renewed) => {
    saveToken(stateDir, renewed);
    token = renewed;
    log(`steam: refresh token renewed, expires ${expiresAt(renewed)?.toISOString() ?? '?'}`);
  });
  user.on('loggedOn', () => {
    loggedOn = true;
    retryMs = RETRY_FIRST_MS;
    log(`steam: logged on as ${user.steamID}`);
    user.gamesPlayed([CS2]);
  });
  user.on('disconnected', (eresult, msg) => {
    loggedOn = false;
    log(`steam: disconnected (${msg ?? eresult}); steam-user reconnects`);
  });
  user.on('error', (err) => {
    loggedOn = false;
    log(`steam: ${err.message} (eresult ${err.eresult ?? '?'}); retrying in ${retryMs / 1000} s`);
    scheduleLogOn();
  });
  user.on('playingState', (blocked) => {
    const wasBlocked = playingBlocked;
    playingBlocked = blocked;
    if (blocked) {
      log('steam: another session of the alt is playing a game; no GC until it stops');
    } else if (wasBlocked && loggedOn) {
      // steam-user only reports the change: CS2 is not played again unless asked.
      log('steam: the other session stopped playing; playing CS2 again');
      user.gamesPlayed([CS2]);
    }
  });
  gc.on('connectedToGC', () => log('gc: connected'));
  gc.on('disconnectedFromGC', (reason) => log(`gc: disconnected (${reason})`));
  // The GC refusing the alt (ClientLogonFatalError): globaloffensive stops saying hello, so the
  // GC stays down until gcbot restarts and status.mjs fails. An `error` with no listener would
  // throw from steam-user's message handling and end gcbot, and a restart policy would then log
  // the alt on again and again.
  gc.on('error', (err) => log(`gc: ${err.message} (code ${err.code ?? '?'})`));

  function logOn() {
    retryTimer = null;
    if (stopped) return;
    if (!usableToken(token)) {
      const expiry = expiresAt(token)?.toISOString() ?? 'unreadable';
      log(
        token
          ? `steam: the refresh token is not usable (expiry ${expiry}); sign the alt in again`
          : 'steam: no refresh token (STEAM_REFRESH_TOKEN or the state volume); sign the alt in'
      );
      return;
    }
    user.logOn({ refreshToken: token });
  }

  function scheduleLogOn() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(logOn, retryMs);
    retryTimer.unref?.();
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  logOn();

  // Sends one GC request and hands `onList(matches, data)` every `matchList` until the function
  // it returns is called (`data` is the whole message: its msgrequestid and accountid say what
  // it answers). Throws, listening to nothing, when the request cannot be sent.
  function ask(onList, send) {
    const listener = (matches, data) => onList(matches, data);
    gc.on('matchList', listener);
    try {
      send();
    } catch (err) {
      gc.off('matchList', listener);
      throw err;
    }
    return () => gc.off('matchList', listener);
  }

  return {
    isOnline: () => loggedOn && gc.haveGCSession === true,
    health: () => ({
      steam: loggedOn ? 'online' : 'offline',
      gc: loggedOn && gc.haveGCSession === true,
      tokenExpiresAt: expiresAt(token)?.toISOString() ?? null,
    }),
    request(code, details, onList) {
      return ask(onList, () =>
        gc.requestGame({
          matchId: details.matchId,
          outcomeId: details.outcomeId,
          token: details.token,
        })
      );
    },
    // MatchListRequestRecentUserGames: the list CS2 shows under Watch → Your matches (up to 8).
    requestRecent(steamid, onList) {
      return ask(onList, () => {
        if (gc.requestRecentGames(steamid) === false) {
          throw new Error(`globaloffensive refused ${steamid} as a player's SteamID`);
        }
      });
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      if (loggedOn) user.logOff();
    },
  };
}
