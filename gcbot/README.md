# gcbot/ — share codes to replay URLs

A small Node service that turns a CS2 match share code (`CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`)
into the match's Valve replay URL (`http://replayN.valve.net/730/<reservation>_<TV port>.dem.bz2`),
which the server then ingests like any pasted URL. It is logged in to Steam as the user's alt
(never the main account), "plays" CS2 to get a Game Coordinator session, and asks the GC for
the match (`steam-user` + `globaloffensive`).

It runs beside the server, reachable only on their private network (`http://gcbot:8097` in a
compose stack, never published), with its state on a volume mounted at `/state`. The server
finds it through `DEMOVIEWER_GCBOT_URL` (`server/README.md`).

## API

- `GET /health` → `200 {"steam":"online"|"offline","gc":bool,"tokenExpiresAt":ISO|null,"queued":n}`
  (`queued` counts lookups not yet answered, the one in flight included).
- `POST /resolve {"sharecode":"…"}` → `200 {"matchId":"<decimal>","url":"http://replayN.valve.net/…dem.bz2","playedAt":<unix>|null}`,
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
`src/sharecode.mjs` (finding and decoding codes), `src/steam.mjs` (the Steam and GC session),
`src/token.mjs` (choosing and saving the refresh token), `src/login.mjs` (the QR sign-in),
`src/status.mjs` (health check), `gcbot.env.example` (the env file, with every setting).
