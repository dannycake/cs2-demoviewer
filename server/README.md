# demoviewer server

A Rust service that takes a CS2 demo (chunked upload, a Valve replay URL, or a match share code
that gcbot turns into one), parses it with the vendored `parser` crate, writes a compact gzip'd
replay pack (`.dvpk.gz`), caches packs by the demo's SHA-256, and serves packs, map/player
assets and the web app over HTTP on port 8095.

Workspace layout:

| Path | What it is |
| --- | --- |
| `crates/pack` | `demoviewer-pack`: pack types, binary writer and reader, the format (`src/format.rs`) |
| `crates/server` | `demoviewer-server`: the HTTP server, plus the `demoviewer-pack-cli` bin |
| `vendor/parser`, `vendor/csgoproto` | LaihoE/demoparser, vendored (see below) |

The web app served at `/` lives in [`../web`](../web) (Vite + React + three.js); the server
serves its build output, `web/dist`, from `DEMOVIEWER_WEB`.

Map and player assets are Valve's, generated locally by the tools in `../tools` into the
gitignored `../assets/`, and are for non-commercial use only. They are never committed and
never baked into the image; the server only serves whatever directory it is given.
`tools/build-assets.sh <map>... | all` rips them from the local CS2 install with
Source2Viewer-CLI, shrinks them, checks them against the budgets and writes the manifests
(`assets/manifest.json`, `assets/maps/<map>/manifest.json`, `assets/players/manifest.json`,
`assets/weapons/manifest.json`, `assets/viewmodels/manifest.json`, `assets/effects/manifest.json`,
`assets/sounds/manifest.json`);
`tools/sync-assets.sh` rsyncs the served part to the server. See [`../tools/README.md`](../tools/README.md).

## Run locally

From this directory:

```sh
DEMOVIEWER_ASSETS=../assets cargo run --release -p demoviewer-server
curl localhost:8095/healthz        # ok
```

To serve the web app as well, build it (`cd ../web && npm ci && npm run build`) and add
`DEMOVIEWER_WEB=../web/dist`. The default, `./static`, is only the image's layout: the
placeholder page that used to live in `server/static/` was removed in phase 3, so without
the variable `/` answers 404 while the API and the assets still work. While working on the
web app, `npm run dev` in `web/` serves it on port 5173 with hot reload and proxies `/api`,
`/maps`, `/players`, `/weapons`, `/viewmodels`, `/effects` and `/sounds` to this server.

State goes to `./data` (gitignored). `RUST_LOG` sets the log filter (default `info`).

Parse one demo without the server, or summarise a pack:

```sh
cargo run --release -p demoviewer-server --bin demoviewer-pack-cli -- demo.dem out.dvpk.gz
cargo run --release -p demoviewer-server --bin demoviewer-pack-cli -- out.dvpk.gz
```

## Run in Docker

The `Dockerfile` is at the repo root and builds from there, because the image holds both the
server and the web app: a `node:22-slim` stage runs `npm ci && npm run build` in `web/`, a
Rust stage builds the server, and the runtime image copies `web/dist` to `/app/static`, which
`DEMOVIEWER_WEB` points at. The Rust stage is `rust:1.99.1-bookworm`, the compiler
`rust-toolchain.toml` pins for the desktop too, and it copies that file in, so the image
builds with the version it names; bump the two together. From the repo root:

```sh
docker build -t demoviewer .
mkdir -p server/data
docker run --rm -p 8095:8095 -v "$PWD/server/data:/data" -v "$PWD/assets:/assets:ro" demoviewer
```

The build is hermetic apart from fetching crates and npm packages: no `build.rs` clones
anything or runs `protoc`. The image runs as `app`, uid 1000, so a bind-mounted `/data` must be
writable by uid 1000. Create the directory before `docker run`; if Docker creates it, it is
owned by root and the server exits with `opening /data: Permission denied`. The same goes for
the data directory on a server: chown it to `1000:1000`, whatever owner its other services use.
`docker stop` shuts the server down gracefully.

The image has no curl, so the server binary is its own health check, the Dockerfile's
`HEALTHCHECK` (every 30 s; `docker ps` shows the container `healthy` once one passes):
`demoviewer-server healthcheck` GETs `/healthz` from `127.0.0.1:$DEMOVIEWER_PORT` (the server
in the same container, with the same environment) and exits 0 when it answers `200 ok`, or 1,
with the reason on stderr, when the port is closed, something else answers, or nothing
answers within 3 s. `docker inspect` shows that output for the last few checks.

```sh
docker exec <container> /app/demoviewer-server healthcheck && echo healthy
```

A profile is taken off the site (someone asked) with `hide`, and put back with `unhide`; any
form of Steam id works (steamid64, a profile link, a friend code). The list is `hidden.json` in
`DEMOVIEWER_DATA`, read again by the running server within a minute:

```sh
docker exec <container> /app/demoviewer-server hide 76561198000000001
```

The image is about 150 MB (148 MB on 2026-10-21). A rebuild after a change to `web/` alone
reuses the cached Rust stage and takes about 15 s. Smoke test of that build, run on port 8096
beside a local server: `mirage_old.dem` dropped on the page at `localhost:8096` was parsed in
0.66 s with an empty `/data` (2.6–3.5 s from drop to a playing viewer), and round 1 played at
2× (128 ticks per second of wall time) at 220–300 fps at 2560×1440.

## Deploying

A deployment runs the image beside gcbot (`../gcbot/README.md`), for example as one compose
stack, and builds the image on a build machine rather than on the server. What it sets:

- A host port mapped to the container's 8095, on `127.0.0.1` for a tunnel or reverse proxy
  on the same host, and on the LAN address if the LAN should reach it directly.
- `/data` and `/assets` (read only) bound to directories on a disk that keeps them: packs are
  kept forever unless `DEMOVIEWER_CACHE_BYTES` is set. Both are owned by `1000:1000`.
  `tools/sync-assets.sh` rsyncs the assets into the `/assets` directory
  (`../tools/README.md`, Syncing to a server).
- `DEMOVIEWER_PUBLIC_URL`, the address visitors use, for the preview tags' absolute links.
- `DEMOVIEWER_GCBOT_URL=http://gcbot:8097`: gcbot, in the same stack and reachable only on its
  network. The upload page offers the share-code field while gcbot says Steam and the Game
  Coordinator are connected.
- `DEMOVIEWER_TRUSTED_PROXIES`: the address the tunnel's or proxy's connections arrive from
  (see Configuration). A tunnel daemon on the host, not in a container, reaches the container
  from the gateway of the stack's network, such as `172.24.0.1/32`, so that address and
  `127.0.0.0/8` are the ones to trust.
- The health check above, every 30 s, and a 6 GiB memory limit (the parse child alone may
  take 4 GiB).

## Configuration

| Variable | Default | Image default | Meaning |
| --- | --- | --- | --- |
| `DEMOVIEWER_PORT` | `8095` | `8095` | Listen port, on `0.0.0.0`. A value that is not a port stops the server. |
| `DEMOVIEWER_DATA` | `./data` | `/data` | Uploads, work files, packs, match summaries (`matches/<sha256>.json`, one per pack), every demo's original (`originals/<sha256>.dem.zst`, zstd level 10, kept forever), tracked players' FACEIT histories (`faceit/<steamid>.json`, kept by the FACEIT poller), match pages' preview cards (`og/<sha256>.jpg`, drawn on first request; the `og/<sha256>.png` of the card before 2026-10-24 are left), `demos.json` (every demo record, written behind each change and flushed to the disk before a client is told the change, or once that write has failed, which is logged and tried again every 5 s, so a failing disk delays no one; `demos.json.prev` is the file before its last write). A `demos.json` torn by a crash (cut short, empty, not JSON) does not stop the server: it is kept as `demos.json.corrupt-<unix time>` and the records come from `demos.json.prev`, losing that last write (with both torn, from none: earlier links then answer `404`); the log says which as an error. One that is JSON but not records this server knows (written by a newer server, before a rollback) does stop it, with an error naming the file. |
| `DEMOVIEWER_ASSETS` | `./assets` | `/assets` | Served under `/maps/`, `/players/`, `/weapons/`, `/viewmodels/`, `/effects/`, `/sounds/` and `/site/`. |
| `DEMOVIEWER_WEB` | `./static` | `/app/static` | The built web app (`web/dist`; locally `../web/dist`); `index.html` answers the web app's own routes and a `404` carrying it any other path that is not a file; under `/assets/` a missing file is a plain `404`. |
| `DEMOVIEWER_TRUSTED_PROXIES` | `127.0.0.0/8, ::1` | same | Peers whose `CF-Connecting-IP` / `X-Forwarded-For` headers identify the client. **Set it to the address the Cloudflare tunnel's connections arrive from in the deployment** (for a tunnel on the host, the stack network's gateway, see Deploying), or every visitor through the tunnel shares one rate-limit bucket. Any other peer is rate-limited by its own address, so headers cannot be forged from the LAN or from another container. |
| `DEMOVIEWER_CACHE_BYTES` | unset | unset | Unset: packs are kept forever. A number of bytes: past it, the least recently used packs are deleted first and their demos read as expired. A value that is not a number stops the server. |
| `DEMOVIEWER_MIN_FREE_BYTES` | 5 GiB | 5 GiB | Free space the data volume keeps: an upload start or completion, a URL or a new share code is refused with 507 when what it could write would take the volume below it, and a job stops in `error` before a download or a pack write that could, and when inflating a compressed demo reaches it. A value that is not a number stops the server. |
| `DEMOVIEWER_PUT_IDLE_SECS` | `60` | `60` | A chunk `PUT` that delivers no byte for this long is dropped with 408; a chunk may take 15 minutes in all. |
| `DEMOVIEWER_PREVIEWS` | on | on | Match pages carry OpenGraph tags and a preview image. `1`/`true`/`on`/`yes` or `0`/`false`/`off`/`no`; anything else stops the server. |
| `DEMOVIEWER_PUBLIC_URL` | unset | unset | Where visitors reach the site (`https://skunk.club`), for the absolute links in preview tags; a `/` is added to its path. A value that is not an `http`/`https` address stops the server. |
| `DEMOVIEWER_GCBOT_URL` | unset | unset | gcbot's API (`http://gcbot:8097`), which turns share codes into replay URLs. Unset: share codes are refused with 503. Its `/health` is asked every 30 s; a lookup may take 90 s. A value that is not an `http`/`https` address stops the server. |
| `DEMOVIEWER_REDIRECT_HOSTS` | unset | `cs.skunk.to` | Old hosts, comma-separated: a request to one is sent to the same path and query at `DEMOVIEWER_PUBLIC_URL` for good (`301` for `GET`/`HEAD`, `308` otherwise, cached a day). Any other host, the health check's `127.0.0.1` among them, is served. Ignored, with a warning, without `DEMOVIEWER_PUBLIC_URL`. |
| `DEMOVIEWER_TRACKING_KEY` | unset | set, from the secrets store | The key tracked players' match-history authentication codes are sealed with in `tracking.json` (XChaCha20-Poly1305, the player's steamid bound in): 64 hex digits, anything else stops the server (without printing it). The codes never print, and stopping tracking deletes the code from the file before it answers. Unset: nobody can start tracking (`503`). |
| `DEMOVIEWER_FACEIT_API_KEY` | unset | set, from the secrets store | The FACEIT Data API key, for profiles' FACEIT level, Elo, win rate and match count, FACEIT nicknames in the one input, FACEIT room links (`faceitMatch`) and the FACEIT history poller; 8 to 128 printable characters without whitespace, anything else stops the server (without printing it). Calls go one a second at most and every call pauses 5 s after a 429. Unset: the unofficial lookup (level and Elo only), no poller, and room links answer `503`. |
| `DEMOVIEWER_STEAM_API_KEY` | unset | set, from the secrets store | The Steam Web API key, for profiles' name, avatar, account age, country, bans and CS2 hours and for custom URL names; 32 hex digits, anything else stops the server (without printing it). Calls go one a second at most, pause 5 s after a 429, and past 30 waiting a lookup is turned away. Unset: no Steam calls; those facts show "—" and custom URL names do not resolve. |
| `DEMOVIEWER_INDEXNOW_KEY` | unset | set, a literal in the env template | The IndexNow key: 8 to 128 letters, digits and `-`, anything else stops the server. It is public by design: the server answers `GET /{key}.txt` with it, which is how Bing and the others check the site owns it. With `DEMOVIEWER_PUBLIC_URL` too, new match, tournament and profile pages are queued as they appear and sent to IndexNow every 5 minutes (one POST, at most 10,000 URLs; a failure is tried once more). Unset: no key file, nothing sent. |
| `DEMOVIEWER_INDEXNOW_URL` | `https://api.indexnow.org/indexnow` | unset | Where submissions go. A test override (point it at a local listener); a value that is not a URL stops the server. |
| `DEMOVIEWER_IMPORT_DIR` | unset | unset | A demo corpus to import, only ever read (mount it read-only): its `index.jsonl` lists one demo per line, `file` being the path under the directory (`.dem`, `.dem.bz2` or `.dem.gz`), `sha256` the file's, `event` the tournament. At startup and every 24 h, each demo not yet imported becomes a match like any other (pack, summary with the event, original), parsed in the background when no upload, URL or share code is waiting. What is imported is logged in `imported.json` in `DEMOVIEWER_DATA`; a demo that failed is tried again at the next scan, and a line that is not a demo is skipped with a warning. |
| `RUST_LOG` | `info` | `info` | `tracing` env filter. |

An unset or empty variable means the default. The limits are fixed in `Config::default()`
(`crates/server/src/config.rs`):

| Limit | Value |
| --- | --- |
| Largest upload or URL download | 500 MiB (`524_288_000` bytes) as transferred |
| Largest demo after inflating | 1 GiB (`MAX_DEM_BYTES`, `crates/server/src/ingest/decompress.rs`), and at most 20 times the compressed file (`MAX_INFLATE_RATIO`; demos shrink only about 1.5 times); a bzip2 or gzip upload or download is inflated up to this, then refused |
| Upload chunk size | 32 MiB (`33_554_432` bytes); every chunk but the last is exactly this size |
| Chunk PUTs | 2 per chunk plus 2 per upload (every chunk may be sent twice); 4 in progress per client (the address that started the upload), 32 in all; a gzip chunk may inflate at most 20 times (`crates/server/src/uploads.rs`) |
| Ingests per client address per hour | 10 (upload starts, URL ingests and share codes that start a lookup; IPv6 is counted per /64, and each /48 may make 10 times that across its /64s, `PER_48`) |
| Attempts per client address per hour | 120 (`Config::attempts_per_hour`): upload starts, URL posts and share-code posts, refused ones and share codes answered from the index included, counted before any disk or index work; IPv6 per /64 and /48 as for ingests |
| Unfinished uploads | 2 × 500 MiB declared per client, 10 GiB in total, counted in memory and read back from the uploads' `meta.json` at startup; untouched for an hour (`STALE_UPLOAD`), they are deleted and leave the budget: looked for when an upload starts, at most once a minute, and at startup |
| Packs | kept forever, unless `DEMOVIEWER_CACHE_BYTES` sets a cache limit |
| Failed demos | the record (so the link says what went wrong, or that the replay expired from the cache) is kept 24 hours from the failure or expiry (`FAILED_RECORD_TTL`), however old the demo, then forgotten (the link answers `404`): checked at startup and every 10 minutes (`FORGET_FAILED_EVERY`) |
| URL ingest | 2 downloads at a time, 5 redirects, 15 minutes per download; a download that cannot start within 30 minutes (`DOWNLOAD_WAIT`) fails as too busy |
| URL and share-code jobs on their way | 32 at once from everyone (`Config::max_fetches`), 3 per client (`FETCHES_PER_CLIENT`): from the post until the file reaches the parse worker (looked up, waiting for a download slot, downloading); past either, a post is refused before it gets a record or spends an ingest |
| Share codes | one lookup at a time and at most 20 waiting (more are refused as busy); Valve's "expired" or "no such match" is remembered for the code for 10 minutes; gcbot's answer is taken only for the very code, its replay URL (`/730/<reservation id>_<TV port>.dem.bz2`) naming the code's outcome id and the TV port's low 16 bits its token, besides the match id |
| Parse | one demo at a time, in a child process (`demoviewer-server parse-worker`) with 4 GiB of writable memory (`RLIMIT_DATA`; a 237 MB demo needs under 1 GiB), killed after 10 minutes. A round longer than an hour, or tracks over 16 million samples in all, is refused |

The client address is `CF-Connecting-IP`, else the last `X-Forwarded-For` entry (the one the trusted proxy appended), else the
peer address.

## API

Errors are JSON `{"error": "..."}` with the status shown. Demo and upload ids are base58 of
16 random bytes.

| Method and path | Request | Answers |
| --- | --- | --- |
| `GET /healthz` | | `200` `ok` |
| `POST /api/uploads` | JSON `{"size": u64, "name"?: string}` | `201 {"uploadId", "chunkSize"}`; `400` empty file; `413` over 500 MiB; `429` rate limited or too many unfinished uploads; `503` upload budget full; `507` the disk is nearly full |
| `PUT /api/uploads/{id}/{n}` | raw chunk `n` (0-based); `Content-Encoding: gzip` is inflated | `204`, also for a repeated chunk (it is replaced); `400` wrong length or out of range; `404` unknown upload; `413` chunk over `chunkSize`, or a gzip chunk that inflates more than 20 times; `415` other encodings; `429` more than 4 chunks at once, or the upload's PUTs are used up (start it again); `503` the server is receiving 32 chunks already |
| `POST /api/uploads/{id}/complete` | | `202 {"demoId"}` (queued); `200 {"demoId", "cached": true}` when the same demo is already packed (the new id aliases it); `409` `missing chunk n`; `404` unknown upload; `507` the disk is nearly full; `429` 2 of the client's completed uploads are already waiting for or going through the parse worker (the second only while more than half the places are free), `503` 4 are in all (`Config::max_queued_uploads`); after any of the last three the upload is as it was, to complete again |
| `POST /api/demos` | JSON `{"url": string}`, `{"sharecode": string}` or `{"faceitMatch": string}`, one of them | URL: `202 {"demoId"}`; `400` refused URL; `429` rate limited, or 3 of the client's demos are already on their way; `503` 32 demos are on their way; `507` the disk is nearly full (`DEMOVIEWER_MIN_FREE_BYTES`; none of the last three spends an ingest). Share code (`CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`, also inside other text such as CS2's "copy share link"): every post counts against the client's attempts first (`429` past 120 an hour); one demo per code, so a code the site has had before answers its demo (found by an index of the codes, never a scan), `200 {"demoId", "cached": true}` once done and `202 {"demoId"}` while it is being fetched, without spending an ingest. Only the very code does (match id, outcome id and token): a code with only the match id in common, and a code for a match the site has from an upload or a replay URL, is looked up as new and then joins that match's pack by sha. A new one is `202 {"demoId"}` and starts at `resolving` (gcbot asks Valve, then it is fetched like a URL); `400` not a share code; `404` Valve said in the last 10 minutes that this code's replay expired or that it has no such match; `429` rate limited, or 3 of the client's demos are already on their way; `503` no `DEMOVIEWER_GCBOT_URL`, gcbot offline, 20 lookups already waiting, or 32 demos on their way; `507` the disk is nearly full (none of the last five spends an ingest). A failed lookup ends the demo in `error` with the reason, as does an answer that is not a Valve replay URL for this very code. FACEIT room (`faceitMatch`: a match id or a `faceit.com/<lang>/cs2/room/<id>` link): `400` too long, or not a room link; a match the site has answers its demo (`200 {"demoId", "cached": true}` once done, `202` while on its way); `429` rate limited, or too many lookups from the client; `404` FACEIT has no such match; `422` `FACEIT demos must be uploaded` (the match has no demo URL on an allowlisted host, which is every match while `FACEIT_DEMO_HOSTS` is empty); `503` no `DEMOVIEWER_FACEIT_API_KEY`, FACEIT busy or not answering, or no place for another demo (`507` disk nearly full); otherwise `202 {"demoId"}` |
| `GET /api/demos/{id}` | | `200 {"id", "status", "map", "rounds", "error", "summary"}`, status one of `resolving`, `queued`, `downloading`, `parsing`, `done`, `error`; `summary` is the match summary once `done` (`map`, `rounds`, `scoreT`, `scoreCt`, `durationS`, `serverName`, `gameBuild`, `players` [`{steamid, name, team, kills, deaths}`], `createdUnix`, `playedUnix`, `matchId`; steamids and match ids are decimal strings), `null` before and for packs parsed before summaries existed; `404` unknown |
| `GET /api/demos/{id}/pack` | | `200` the `.dvpk.gz` bytes with `Content-Type: application/octet-stream`, `Content-Encoding: gzip`, `Cache-Control: public, max-age=31536000, immutable`; `409` `not ready`, which includes a pack evicted from the cache (the demo then reads `error` with an expired message); `410` the pack file is gone but the index still said `done` (the demo is then marked expired the same way); `404` unknown |
| `GET /api/site` | | `200 {"sharecodes": bool}`: whether the upload page may offer a share-code field (`DEMOVIEWER_GCBOT_URL` is set and gcbot is online). Nothing else is listed: a match is reached by its link, or from a player's profile |
| `GET /api/players/{steamid}` | | `200` the player's profile from the matches held (every 5v5 match counts in the totals and maps, Wingman and smaller modes are only listed): `steamid`, `name` (Steam's, else the latest match's), `avatar`, `steam` (`sinceYear`, `country`, `cs2Hours`, `vacBans`, `gameBans`), `tracking`, `premier` (`rating` after the latest Premier match, 0 unrated, `wins`, `demoId`), `competitive` (`map`, `rank`), `totals` (`rating`, `openingWon`, `openingLost`, `kd`, `adr`, `hsPct`, `matches`), `maps`, for a player with a `faceit/<steamid>.json` (one the FACEIT poller tracks, or tracked before: then rows offer only the room link) `faceitHistory` (their newest 20 FACEIT matches, newest first: `matchId`, `finishedUnix`, `map`, `score`, `won`, `competition`, `replay` (a demo id, or `null` when the demo has to be uploaded), `roomUrl`; left out otherwise), the newest 100 `matches` (`demoId`, `map`, `mode`, `event`, `playedUnix`, `result` `w`/`l`/`t`, `score` own team first, `kills`, `deaths`, `rating`, `rank`) and `matchCount`; every field is always there, `null` when unknown. A profile not fetched from Steam yet counts as a lookup (below); past the limit it comes without Steam's facts. `404` not a 17-digit SteamID64; `410 {"error", "hidden": true}` a hidden profile |
| `GET /api/players/{steamid}/matches?offset=n` | | `200` the next 100 of the player's matches from `offset`, newest first; `404` and `410` as above |
| `GET /api/lookup?q=<text>` | | What the one input names. Any Steam id form (steamid64, `STEAM_X:Y:Z`, `[U:1:N]`, an account id, a friend code, a profile or invite link) answers `200 {"kind": "profile", "steamid"}` without asking Steam. A custom URL name (an `/id/` link or a bare word) asks Steam, counted against the client's 60 lookups an hour (`429` past them): found, `profile`; a bare word Steam does not resolve is then tried as a FACEIT nickname when there is a `DEMOVIEWER_FACEIT_API_KEY` (one Data API call, the same lookups count, never a hidden player), found, `profile`; failing that it answers `200 {"kind": "players", "players": [{"steamid", "name", "matches"}]}` when players of that name are held (at most 10, never a hidden one). `400` a match (share code, replay or demo link: the input opens it itself) or text over 200 characters; `404 {"error": "No Steam account or player called “…”"}`; `503` Steam busy (30 lookups waiting) or not answering |
| `GET /maps/{path}`, `GET /players/{path}`, `GET /weapons/{path}`, `GET /viewmodels/{path}`, `GET /effects/{path}`, `GET /sounds/{path}`, `GET /site/{path}` | | files from `DEMOVIEWER_ASSETS/maps/...`, `.../players/...`, `.../weapons/...`, `.../viewmodels/...` (the first-person arms and clips), `.../effects/...` (the effect atlases, fetched the first time an effect needs one), `.../site/...` (the rank icons, the Steam logo and the homepage video, with their manifest) and `.../sounds/...` (the Opus sound banks, `video/webm`, and their manifest). A `<file>.gz` sibling (the tools write one beside every GLB, and beside the sounds manifest) is sent as is with `Content-Encoding: gzip` to a client that accepts gzip. `Cache-Control` is `public, max-age=31536000, immutable` when the request carries a `v` query (`?v=<sha256 prefix>`, what the web app sends for every file a manifest lists) and `no-cache` otherwise, so manifests are always revalidated; a 404 carries neither |
| `GET /auth/steam` | | Sign in through Steam (OpenID 2.0): `302` to Steam's sign-in page, with a random state in the `__Host-skunk-state` cookie (`HttpOnly; Secure; SameSite=Lax`, 10 minutes). `503` without `DEMOVIEWER_PUBLIC_URL` |
| `GET /auth/steam/return` | Steam's answer | `302` to `/track` with the `__Host-skunk` session cookie (`HttpOnly; Secure; SameSite=Lax`, 30 days) when the state matches the cookie, the answer names this site's return address and Steam's endpoint, Steam signed every field read, the claimed id is a Steam account and Steam confirms the signature (`check_authentication`); else `302` to `/track?signin=failed`. Sessions are kept in `sessions.json` as the SHA-256 of each token, never the token, and survive restarts |
| `POST /auth/signout` | | `204`, the session ended and its cookie cleared; `403` unless the request comes from this site (`Origin`, or `Sec-Fetch-Site: same-origin`) |
| `GET /api/me` | | `200 {"steamid", "name", "avatar", "tracking"}` for the signed-in visitor; `401` without a session |
| `POST /api/me/tracking` | JSON `{"authCode", "token", "olderToken"?}` | Shares the signed-in player's match history: `202 {"tracking": "on"}`. The code and tokens are checked against Steam once each (`GetNextMatchSharingCode`, one call, two with `olderToken`) before anything is kept; Steam's refusal names the field: `400 {"field": "authCode" \| "token" \| "olderToken", "error"}` (also for a shape that is not a code or a token, checked first). The walk starts at the oldest token given, and the tokens' own matches are fetched too. `401` not signed in; `403` not from this site; `503` without `DEMOVIEWER_STEAM_API_KEY` and `DEMOVIEWER_TRACKING_KEY`, or Steam not answering. Then the tracker checks the player's history every 15 minutes, one match at a time behind users; Steam refusing the code or token stops it (the profile says "Tracking stopped") |
| `DELETE /api/me/tracking` | | `204`, the sealed code deleted from `tracking.json` before the answer; `401`, `403` as above |
| `GET /id/{name}`, `GET /profiles/{steamid}`, anything under either | | `200` the web app's `index.html` with `<meta name="robots" content="noindex">` (a profile page: Steam's own addresses with this site's host). No preview tags. `Cache-Control: no-cache` |
| `GET /guides/{slug}` | | `200` the web app's `index.html` with the guide's text in the head for crawlers, its `Article` and breadcrumb JSON-LD; the guides are `watch-cs2-demos-in-your-browser`, `track-your-cs2-matches` and `watch-faceit-demos`. `404` and `noindex` for any other slug, which the page does not repeat. |
| `GET /feed.xml`, `GET /events/{slug}/feed.xml` | | `200` an Atom feed of the newest replays, site-wide or for one tournament; `404` without `DEMOVIEWER_PUBLIC_URL` (the links must be absolute) or for an unknown event |
| `GET /oembed?url=<page>` | | `200` the link-type oEmbed JSON (`provider_name`, `author_name`, `title`) for a match, tournament or profile page of this site, which Discord reads for the lines above an embed; `404` for any other address or without `DEMOVIEWER_PUBLIC_URL`; `501` for a `format` other than `json` |
| `GET /{key}.txt` | | `200` `text/plain`, the `DEMOVIEWER_INDEXNOW_KEY` and nothing else. Only that exact path exists, and only with the key set |
| `GET /d/{id}` | | `200` the web app's `index.html` with `<meta name="robots" content="noindex">` in its head, whatever the id (matches are listed on their players' profiles, never for search engines). For a done demo with a match summary, also the title (`Mirage 13–9 · cs.skunk.to`, the winner's score first) and, with previews on, OpenGraph and Twitter tags: `og:title`, `og:description` (`<top fragger> led with <k> kills and <adr> ADR · <n> rounds in <m> min · <place> · <date>. Watch it in 3D.`: the most kills, then damage; the place as the HUD says it, `Valve matchmaking, eu_west` for Valve's servers; the date when played or else when stored, UTC), `og:site_name`, `og:type`, `twitter:card`, `theme-color` (the winners' side's colour, Discord's embed edge; violet in a draw), and with `DEMOVIEWER_PUBLIC_URL` set `og:url`, `og:image` (`.jpg`), its type, size and alt text. Names are HTML-escaped; a hidden player is named "—". `Cache-Control: no-cache` |
| `GET /og/{id}.jpg` | | `200` the match's 1200×630 preview card, a JPEG: CS2's screenshot of the map (`assets/maps/<map>/hero.png`, `tools/hero.sh`) darkened, or its radar faint on the right without one; the date and length, the map, the score in the colours of the sides the teams finished on, each round as a square in its winner's colour with a gap at each half, and both teams' players with kills, deaths and ADR, the top fragger in the team's colour. `Cache-Control: public, max-age=86400`; drawn once per pack, one at a time, and kept in `og/` (a card with a hidden player, named "—" on it, is kept apart as `og/<sha>-<tag>.jpg`, and the card that named them is deleted); `/og/{id}.png` answers the same JPEG (pages Discord read before the card was one); `404` with previews off, or when the id is not a done demo with a summary |
| `GET /assets/{path}` | | the web build's bundles, from `DEMOVIEWER_WEB/assets/...`, with `Cache-Control: public, max-age=31536000, immutable` (their names carry a content hash); `404` for a file this build does not have, such as a previous build's chunk asked for by a tab left open across a deploy (never `index.html`, which its browser would keep as that script for a year) |
| `GET /d/{id}/`, `/track/`, `/legal/`, `/guides/{slug}/`, `/events/{slug}/` | | `301` to the address without the trailing `/`, query kept, so each page has one address |
| `GET /{path}` | | other files from `DEMOVIEWER_WEB`, each with `Cache-Control: no-cache`; any other path is `404` with the web app's `index.html` and `noindex` (the app still draws its own not-found page) |

URL ingest accepts only `http`/`https` URLs on Valve's replay servers, a host matching
`^replay\d+\.valve\.net$`, and FACEIT's demo hosts (`FACEIT_DEMO_HOSTS`, named exactly; empty
until the API spike fills it). Since 2026-10-24 a demo file anywhere else is refused, whatever its
name; upload it or paste its share code instead. Every redirect hop has to stay on those
hosts, and a replay host that resolves to a private, loopback, link-local, CGNAT or unspecified
address is refused, on every hop and again at connect time. The post checks the URL itself
(`400`) but resolves nothing: the download resolves each hop, so a replay host that does not
resolve, or resolves to such an address, ends the demo in `error`. Downloads may be bzip2, gzip
or a raw demo.

A demo that is not a CS2 demo, is cut short, or has no complete round ends in
`status: "error"` with a message. The demo's original is kept, zstd-compressed, in
`originals/<sha256>.dem.zst` (written before the parse, so a demo that fails is kept too; one
file per sha); the work copies are deleted once it is packed or has failed.

Upload walk-through:

```sh
f=demo.dem; size=$(stat -c %s "$f"); chunk=33554432
up=$(curl -s -X POST localhost:8095/api/uploads -H 'content-type: application/json' \
  -d "{\"size\":$size}" | jq -r .uploadId)
for n in $(seq 0 $(( (size + chunk - 1) / chunk - 1 ))); do
  dd if="$f" bs=$chunk skip=$n count=1 status=none |
    curl -s -X PUT --data-binary @- "localhost:8095/api/uploads/$up/$n"
done
id=$(curl -s -X POST "localhost:8095/api/uploads/$up/complete" | jq -r .demoId)
curl -s "localhost:8095/api/demos/$id"                 # poll until "done"
curl -s -o pack.dvpk.gz "localhost:8095/api/demos/$id/pack"
```

## Tests

```sh
cargo test --workspace --exclude parser
```

The golden tests parse real Valve matchmaking demos, which are local only and never in git.
They are `#[ignore]`d; point `DEMOVIEWER_DEMOS` at a directory holding `mirage.dem` and
`mirage_old.dem` (the demo bundled with upstream's parser) and run them in release mode:

```sh
DEMOVIEWER_DEMOS=~/.local/share/demoviewer/demos \
  cargo test -p demoviewer-server --release --test golden_mirage -- --ignored
```

## Vendored parser

`vendor/parser` and `vendor/csgoproto` are copied from
[LaihoE/demoparser](https://github.com/LaihoE/demoparser) at commit `45ca85a`. Upstream's
build scripts `git clone` GameTracking-CS2 and run `protoc` at build time; here both
`build.rs` files are `fn main() {}` and the committed, generated
`vendor/csgoproto/src/protobuf.rs` is the source of truth, so builds need no git, no protoc
and no network beyond crates.io. Keep the build scripts empty. `vendor/README.md` lists every
change and how to update.
