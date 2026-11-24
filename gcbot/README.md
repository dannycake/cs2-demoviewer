# gcbot/ — share codes to replay URLs

A small Node service that turns a CS2 match share code (`CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`)
into the match's Valve replay URL (`http://replayN.valve.net/730/<reservation>_<TV port>.dem.bz2`),
which the server then ingests like any pasted URL. It is logged in to Steam as the user's alt
(never the main account), "plays" CS2 to get a Game Coordinator session, and asks the GC for
the match (`steam-user` + `globaloffensive`). It also asks the GC for a player's recent matches
(`/recent`), which is how to find out whether the GC lists them for an account other than the alt's.

It runs beside the server, reachable only on their private network (`http://gcbot:8097` in a
compose stack, never published), with its state on a volume mounted at `/state`. The server
finds it through `DEMOVIEWER_GCBOT_URL` (`server/README.md`).

## API

- `GET /health` → `200 {"steam":"online"|"offline","gc":bool,"tokenExpiresAt":ISO|null,"queued":n}`
  (`queued` counts lookups of both kinds not yet answered, the one in flight included).
- `POST /resolve {"sharecode":"…"}` → `200 {"matchId":"<decimal>","url":"http://replayN.valve.net/…dem.bz2","playedAt":<unix>|null,"info":{…}|null}` (`info`: the Game Coordinator's whole match object, 64-bit numbers as decimal strings and bytes dropped, which the server keeps beside the match),
  or `{"error":code,"message"}`:

  | status | error       | when                                                                  |
  | ------ | ----------- | --------------------------------------------------------------------- |
  | 400    | `invalid`   | no share code in `sharecode`, a body over 1 KiB, or not that JSON     |
  | 404    | `expired`   | the GC knows the match but gives no replay URL (kept about a month)   |
  | 404    | `not_found` | the GC has no match for the code (what a crosshair code gets)         |
  | 503    | `offline`   | Steam or the GC is not connected (also within a second of dropping)   |
  | 503    | `busy`      | more than 20 lookups already waiting                                  |
  | 504    | `timeout`   | the GC sent no answer in 20 s                                         |

  `sharecode` may be anything containing a code, such as CS2's "copy share link"
  (`steam://rungame/730/…/+csgo_download_match%20CSGO-…`). The GC is asked one lookup at a time,
  at least 2 s apart (it throttles an account that asks faster), and 10 s after a timeout, so
  that a late empty answer finds no lookup to fail as `not_found` (one later than 30 s still
  can: an empty list does not say which code it answers). A `matchList` answers a lookup only
  for its whole code: the match id, the reservation id on the last round's stats (the code's
  outcome id) and the TV port on the watchable match info (whose low 16 bits are the token). A
  list about another match, or the same match under another code (a late answer to an earlier
  lookup reaches the next one), is ignored. A caller that hangs up while its lookup still waits
  is taken out of the queue.
- `POST /recent {"steamid":"<SteamID64>"}` → `200 {"matches":[{"matchId":"<decimal>","sharecode":"CSGO-…"|null,"url":"http://replayN.valve.net/…dem.bz2"|null,"playedAt":<unix>|null,"map":"de_…"|null}…]}`:
  the matches the GC lists for that player, as CS2 shows them under Watch → Your matches (up to
  8), newest first (any without a time last). `sharecode` is made from the same three parts
  `/resolve` checks (the match id, the reservation id on the last round's stats, the TV port's low
  16 bits), so `/resolve` takes it for that match; it is null when the GC leaves one out. `url` is
  null once the replay is gone, `map` (the watchable match info's `game_map`) when the GC does not
  name it. An empty list is an answer. Or `{"error":code,"message"}`:

  | status | error     | when                                                                                |
  | ------ | --------- | ----------------------------------------------------------------------------------- |
  | 400    | `invalid` | `steamid` not a player's SteamID64 (17 digits), a body over 1 KiB, or not that JSON |
  | 503    | `offline` | as for `/resolve`                                                                   |
  | 503    | `busy`    | more than 20 lookups, of either kind, already waiting                               |
  | 504    | `timeout` | the GC sent no list for that player in 20 s                                         |

  The GC lists only the alt's own matches: asked for another account's on 2026-10-28 it sent
  nothing, and every such call ends in `timeout`. It waits the
  same 20 s as a share code, since nothing says recent games come faster, and goes through the
  same queue, so one the GC never answers holds share codes behind it for 30 s (the timeout and
  the quiet after it). One at a time, a request can only meet another's answer when that answer
  comes after its own request timed out; a `matchList` also says which request it answers
  (`msgrequestid`: 9147 a share code's, 9141 recent games) and whose games it lists
  (`accountid`), when the GC fills them in. A share code's lookup never takes a recent-games list
  (not even an empty one, which would have been `not_found`), and `/recent` takes only a list
  whose `accountid` names the player (as the GC's answer for the alt did), never a share code's,
  another player's or one that names nobody. Each request logs one line: `recent: <steamid>: 8 matches in
  312 ms (msgrequestid 9141, accountid …)`, or on a timeout also every list that came and was not
  taken (`…; ignored 1 list: msgrequestid 9147, accountid null, 1 match`), so an answer gcbot does
  not expect shows in the log instead of as silence.

## Configuration

| env                   | default   |                                                              |
| --------------------- | --------- | ------------------------------------------------------------ |
| `STEAM_REFRESH_TOKEN` | (none)    | the alt's refresh token (see Signing the alt in)             |
| `GCBOT_STATE`         | `/state`  | `refresh-token` (mode 600) and steam-user's files (`steam/`) |
| `GCBOT_PORT`          | `8097`    |                                                              |
| `GCBOT_HOST`          | `0.0.0.0` |                                                              |

The token used is whichever of the env's and the state's expires later, and it is written to
the state before logging on. steam-user renews it when Steam allows (`renewRefreshTokens`);
every renewed token is on disk (written to `refresh-token.tmp`, fsynced, renamed) before
anything uses it. Without a usable token gcbot runs and answers `offline`. The token is never
logged and never in argv.

## Signing the alt in

Use a separate Steam account (an alt), never your main one. On a desktop, with the alt's Steam
app at hand:

```sh
cd gcbot
npm ci
node src/login.mjs --state <dir>   # writes <dir>/refresh-token
node src/login.mjs                 # or stores it in 1Password (below)
```

It draws a QR code in the terminal (`--png <file>` also writes it as an image, to show on another
screen); scan it in the alt's Steam app and approve within 5 minutes. Steam replaces the code now
and then while it waits, and an old one fails to scan, so it draws each new one. It prints the
signed-in account and asks before storing, since only the alt belongs there, and if storing fails
it asks to try again rather than dropping the token. The refresh token lasts about 200 days.

- `--state <dir>` writes it to `<dir>/refresh-token` (mode 600, through a renamed temporary
  file), the file gcbot reads at start: use the directory you mount as `/state` (owned by uid
  1000, the image's `node` user), or copy the file there. `<dir>` must exist and be writable
  before the code is drawn.
- Without `--state` it goes to 1Password, at the reference in `gcbot.env.tpl` beside this README:
  a template for `op inject` holding the line
  `STEAM_REFRESH_TOKEN=op://<vault>/<item>/<field>`, which renders `gcbot.env`. login.mjs asks
  `op` for the vault before it draws a code (approve that prompt first; a dismissed one stops it
  before anyone scans), then writes the field (creating the item, or editing it keeping its
  other fields), piped to `op` as a JSON item on stdin. Render `gcbot.env` again and restart
  gcbot to use it. Without the template or that line it refuses, naming both ways.

Or paste a token into `gcbot.env` by hand: copy `gcbot.env.example` to `gcbot.env` (gitignored)
and pass it as the container's env file. gcbot uses whichever of the env's and the state's
tokens expires later. Renewal is the same scan; `status.mjs` starts failing a week before the
token expires.

If the GC never connects, the alt needs CS2 in its library (it is free); if the log says another
session is playing a game, the GC is unavailable until that session stops (gcbot then plays
CS2 again by itself). `gc: Logon Fatal Error: …` means the GC refused the alt: gcbot stays up
without the GC until it is restarted.

## Status

`node src/status.mjs` (in the container: `docker exec demoviewer-gcbot node src/status.mjs`)
prints `/health` and exits 0 when healthy, 1 when Steam or the GC is down or the token expires
within 7 days (the reasons on stderr), 2 when gcbot does not answer. `--alive` only checks that
it answers: that is the image's `HEALTHCHECK`, since a signed-out gcbot is still a running one.

## Development

```sh
cd gcbot
npm ci
npm test        # node --test; Steam, the GC and op are all fakes
```

`package.json` `overrides` takes two of steam-user 5.3.0's dependencies past its ranges, so `npm
audit` is clean: steam-appticket 2.0.1 (on protobufjs 7, which dedupes to the 7.6.6 everything
else uses, where 1.0.2 nested a protobufjs 6.11.6 with a critical advisory) and adm-zip 0.6.1
(above every advisory's range). gcbot never reaches either (app tickets; CDN depot downloads),
and steam-user calls the same functions in both. Never run `npm audit fix --force`: it "fixes"
them by installing steam-user 3.15.0, a 2017 release that cannot log on with a refresh token.
Drop an override once steam-user's own range takes a fixed version.

Nothing in the tests contacts Steam or Valve. The image, built from the repo root (BuildKit
reads `gcbot/Dockerfile.dockerignore`, so the context is only gcbot's manifest and sources):

```sh
docker build -f gcbot/Dockerfile -t demoviewer-gcbot .
docker run --rm -p 127.0.0.1:18097:8097 demoviewer-gcbot   # no token: answers offline
```

Files: `src/server.mjs` (HTTP, entry point), `src/resolver.mjs` (the queue),
`src/sharecode.mjs` (finding, decoding and encoding codes), `src/steamid.mjs` (a SteamID64's
account id), `src/steam.mjs` (the Steam and GC session),
`src/token.mjs` (choosing and saving the refresh token), `src/login.mjs` (the QR sign-in),
`src/status.mjs` (health check), `gcbot.env.example` (the env file, with every setting).
