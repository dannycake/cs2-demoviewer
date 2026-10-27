# demoviewer web app

Vite + React 19 + TypeScript (strict) + three.js 0.186 + zustand. Two views, chosen from the
URL: `/` is the upload page (drop or pick a `.dem`, or paste a Valve replay URL or, while the
server takes them, a match share code) and `/d/<demoId>` is the viewer. The phase 1 server
serves the build output, `dist/`, as `DEMOVIEWER_WEB`; see the [root README](../README.md) for
running both.

```sh
npm ci
npm run dev        # http://localhost:5173, proxies /api, /maps, /players, /weapons, /viewmodels, /effects, /sounds to 127.0.0.1:8095
npm run build      # tsc --noEmit, vite build into dist/, then a gzip -9 .gz beside each text file
npm test           # vitest
npm run lint       # eslint
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/api/` | The server API: demo status polling, chunked gzip upload with retry from the failed chunk, URL ingest; manifests and versioned asset URLs (`assets.ts`) |
| `src/pack/` | Pack v1 reader (`docs/pack.md`) and the Web Worker that fetches and parses it |
| `src/geo/coords.ts` | Source units → three.js metres, yaw and view direction; the only place that converts |
| `src/sim/` | Sampling a player's state at a float tick; weapon names and families, the locomotion blend and the action index the player rigs play |
| `src/state/` | The playback store and clock, the keyboard map and the `?r=&t=` URL state |
| `src/audio/` | The sound (Sound, below): the banks' manifest and fetches, the Web Audio engine, the step set of a hull surface, the listener, and the director that plays the cues the clock crosses; `sim/sounds.ts` makes a round's cues |
| `src/radar/` | The 2D radar: the map's overview and images, the frame at a tick (players, deaths, kill lines, utility, grenades, the bomb), the Canvas 2D painter and the controller that lays out, redraws, zooms and picks |
| `src/scene/` | The three.js world: map loading and its look (lit materials, normals, cutouts), the hemisphere light and shadow-casting sun, per-map sky colour and fog, the post stack, the quality presets, player rigs, cameras, the per-frame update. A `Scene` draws one map: the 3D view makes one per demo. `Scene.ts` wires the parts and runs the frame; the map's world, hull, bake and doors are `mapassets.ts`, the players' models `players.ts`, the sky and fog `sky.ts`, what is made of the pack `packcontext.ts` |
| `scripts/make-detail.mjs`, `public/detail.png` | The 256² grey noise tiled over the maps at `medium` and `high`; `prebuild` makes its pixels from a fixed seed and rewrites the file only when the pixels in it differ, so a build leaves the committed file as it is whatever zlib compressed it |
| `src/components/`, `src/views/` | React UI, one CSS module per component; `src/styles/tokens.css` is a copy of the Skunk UI tokens with the brand hue set to Skunk violet |

## Using the viewer

| Key | What it does |
| --- | --- |
| Space | Play and pause |
| `←` / `→` | Previous or next round (`←` on the first round restarts it) |
| `,` / `.` | One sample back or forward, and pause |
| `1`–`0` | Follow player 1–10: POV switches to them, Free stays where it is; turns the director off |
| `V` | POV, the default camera: the followed player's own view |
| `C` | Free: the fly camera |
| `A` | The director ("Auto") on or off; turning it on switches to POV |
| `R` | The full-screen radar in place of the 3D view, or back; a camera key also goes back |
| `Q` | The next quality preset (low → medium → high) |
| `X` | Outlines through walls on or off (the names over heads follow them through walls) |
| `K` | The kill cam of the followed player's last death in the round |
| `H` | The highlights panel, open or closed |
| `N` | While a reel plays: its next segment |
| Escape | Closes the highlights panel, else leaves a reel back where it started; an open settings panel, player sheet, scoreboard or Share field takes the Escape first |
| Tab (held) | The scoreboard |
| In Free: `W A S D`, `Q`/`E`, Shift | Move, down and up, four times as fast |

Keys do nothing while a text field has focus, Space presses a checkbox or button reached with
the keyboard instead of playing (after a click on one, it still plays and pauses), and in Free
the fly camera's keys (`W A S D Q E`, so `A` and `Q` too) belong to it. A held toggle key acts
once (`←`/`→` and `,`/`.` repeat). `T` (the old top-down view, gone with the orbit camera)
and `F` (the old third-person Follow camera, gone since POV became the default) do nothing.
The two cameras are also buttons, top right, with "Auto", "Radar", "Highlights" and "Share"
beside them.

**POV** is the followed player's own view, narrowed to the scope's field of view while they
are scoped in. When they die it holds their death view, as CS2's death cam does: the eye
stays where they died, looking where they were looking, without their arms, for 2 s
(`sim/deathview.ts`), then cuts to the killer (or the nearest living teammate); a player you
picked yourself is held on, in their death view, until the round ends, and the next round is
POV on them again. The player list highlights whoever the camera cut to. **Free** is a fly
camera that starts where the last view was: right-drag looks, `W A S D` move, `Q`/`E` go down
and up, Shift is
four times as fast, and the wheel sets the speed (0.5–40 m/s, remembered in `localStorage`
as `demoviewer.flySpeed`); left-drag does nothing and there is no collision. The **director**
drives POV: it picks whose eyes to look through from the round's events, planned ahead,
cutting to a player 1.5 s before their kill, death, damage, plant or defuse when they beat
the current pick by enough and the current pick has had 4 s on screen, and to the defuser (or
a guard by the bomb) in the bomb's last 20 s; when its pick dies it holds their death view
for 2 s and then moves to the next living player. Picking a player yourself turns it off. It
is remembered
in `localStorage` (`demoviewer.director`). The quality select in the bar sets the quality
preset. The URL holds the moment, `?r=<round>&t=<tick>&cam=<camera>&p=<player>` (see
Share a moment, below): a link opens there, and the address bar is kept up to date (at most
once a second) while playing and as the camera or the player changes. There is no HD world:
the bar's HD toggle is gone, a saved `demoviewer.hd` is ignored, and the viewer never asks
for `world_hd.glb` (a map's manifest built before then still lists it and its `hd` field;
both are ignored). A map with
no assets on the server gets a notice naming it and the maps that are supported
(`src/views/notices.ts`), with "Watch without the map" to keep the player list, kill feed,
scoreboard and clock over an empty scene (a "No 3D map for <map>" banner stays); a demo with
no rounds says so.
The end of the transport bar reads what the page has downloaded since it opened, compressed
bytes over the wire (`src/net/traffic.ts`: the page's resource timing, plus the pack worker's
own download, which the page's timeline does not see; the exact count is the counter's
`data-bytes`). A cold Mirage load in POV is about 17.2 MB, the pack's 2.6 MB included, and the
first click adds the sounds round 1 needs, 0.8 MB (Sound, below).

`?debug=1` shows a corner with the preset (and the frame rate it was picked from, when it was
picked automatically, or "(device)" when the device set it), the frame rate while playing and
the triangles drawn. `?hud=0` draws the 3D view alone, without the HUD, to measure what the
HUD costs. `window.__demoviewer` exposes `{ stats: { fps, tris, probe, frames }, store,
memory(), probe(ms), camera(), hullDistance(x, y, z), rig(i), hudRenders(), sound }` for that
corner and the smoke tests: `memory()` is the renderer's texture, geometry, program and draw-call
counts, `probe(ms)` times how fast the scene draws at its preset, `camera()` is the pose of
the camera drawn last (scene metres, Source yaw and pitch in degrees, the vertical field of
view), its mode and the player POV shows,
`hullDistance` is a scene point's distance to the map's hull in metres (null without one),
`rig(i)` is player `i`'s rig as drawn last, `hudRenders()` counts the HUD's renders by
component, and `sound` is the sound director's live counts: `unlocked` (the audio context
runs: a gesture made it and the browser let it start), `played` and `skipped` (cues started,
and cues crossed whose key the manifest lacks, whose bank was not in yet, or while the context
did not run), `voices` (sounding now) and `banks` (decoded, in the order they came in). It is
there from when a demo opens (`views/viewer-hooks`); until the 3D view has a scene (a phone on
the radar), `stats` reads all zero and the scene's accessors throw.

## The HUD

Over the scene, sized from `--hud-size` (0.9 vw between 12 and 20 px, times the HUD size
setting), all in `components/hud/` from pure view models in `models.ts`. A component renders
again only when its model changes, not every frame (see Performance, below):

- **Round bar** (top centre): CT and T scores in solid team colour around the clock, which
  counts the freeze ("Buy time"), the round (1:55 from the freeze end) and, after a plant,
  the bomb's 40 s; "Round over" once it is decided. Pips under each score, solid while alive.
  Scores go by side and follow the teams across halftime.
- **Killfeed** (top right): the last five kills of the last 8 s while playing, the five latest
  whatever their age when paused; team-coloured names around the weapon's silhouette, our own
  badges (headshot, wallbang, through smoke, no-scope, blind, flash assist), the followed
  player's kills outlined. A row plays that kill's kill cam.
- **Player list** (left): per team, health, armour, the weapon's silhouette, kills this match;
  faded back in Free until hovered.
- **Minimap** (top left, above the brand line): the radar of the whole map (below); a click
  opens the full view. 14em square, 11em on windows under 800 px tall; Settings can hide it.
- **Player card** (bottom right, under the round feed, in POV): health, armour and
  helmet, kit, the weapon with its magazine, money and grenades (packs from 2026-10-22 on),
  kills and deaths, state tags. A click opens the scoreboard. After the player's death in the
  round, a "kill cam" button above it plays it (`K`). It sat bottom left until the minimap
  took that column's room.
- **Round feed** (bottom right, above the card): throws, plant, defuse, kills of the last 12 s.
- **Round strip** (above the transport): a cell per round in the winner's colour with how it
  was won, halftime gaps; a click goes to that round. The scrubber marks kills (the followed
  player's death in red), the plant, the defuse and each grenade, and shades the after-round.
- **Scoreboard** (Tab held, or the card): K, A, D, +/−, ADR, KAST, HS%, UD, FA and Rating for
  the match so far, then money and equipment (the columns are under Spectating, below). Opened
  from the card, it closes on a press anywhere else.
- **Highlights** (under the camera row), **the reel's banner** and **the round summary** (top
  centre, under the round bar): see Spectating, below.
- **Settings** (the gear): grenade labels, trails, damage numbers, the minimap, outlines
  through walls, names over heads, the round summary, a kill cam after each death, HUD size
  80–140 %, under "Audio" the sound on or off and its volume (0–100 %, 60 % by default; see
  Sound, below), and the keys; remembered as `demoviewer.settings` (a value that is not a
  boolean reads as the default; a volume outside 0–100 % is clamped).
- **First person**: the followed player's own crosshair, decoded from their share code
  (`sim/crosshair.ts`, all four formats) at the size they set for their screen height; the
  scope's lens and field of view when scoped (AWP 40° then 10°, the other snipers 40° then
  15°, AUG and SG 553 45°); their team's arms holding their weapon over the scene, played by
  CS2's own viewmodel clips (see First-person arms below; `scene/viewmodel.ts`); and the flash
  whiteout while they are blind. In their death view all of it is gone.

Grenades in flight are their model, a trail of the last 1.2 s and a label at a fixed screen
size; smokes, fires, flashes, HE and decoys have timed effects drawn from CS2's own particle
frames (`scene/utility.ts`):
- A smoke is CS2's `smoke` frames, every smoke's puffs in one batch drawn farthest smoke
  first, each puff a fixed frame (by a seed of its own) turning at 0.05 rad/s.
- An HE is CS2's fireball (one of the sheet's five, by a seed of the grenade, played once over
  0.8 s) over its ring on the ground, then six puffs of CS2's smoke rising and fading over
  2.5 s; so the timeline holds an HE for 3.3 s (`HE_S`), while the radar still rings it for
  0.6 s (`HE_BLAST_S`).
- A flash is the generated glow with CS2's flare over it, twice as bright, so its rays show
  past the glow (the flare alone read as a smear). A decoy pops as one of CS2's muzzle frames throwing three spark
  streaks.
- A fire's flames are one instanced mesh of CS2's own `fire_burning_character` frames, each
  with a `fire_small_sim_b` burst as it catches, catching from the middle outwards under a
  column of smoke (`scene/fire.ts`).

Shots draw a 60 ms tracer from the gun to where the bullet went (the shot's own logged eye
position and aim, recoil in it, to the first wall; for a hit, along the bullet's logged
direction to the player). Every gun draws one but the taser and the healthshot, and a miss's
ends where the hull's ray meets a wall (`hull.raycast`, past chainlink and the other surfaces
bullets pass), where its bullet hole is. Each shot flashes one of CS2's muzzle frames for
50 ms, as big as its gun's class (`muzzleClass`), at the front end of the gun in the shooter's
hand (`muzzleOf`); the player seen in first person flashes at their first-person gun at half
that size times the viewmodel's magnification, and not at all while scoped. A hit draws CS2's
blood splatter (1.25 times as big for a headshot, 1.5 for the killing hit), a dark red lit by
the light grid where the victim's eyes were (not a light), a red flash on the model and the
damage in a small monospaced column beside the hit player (yellow when the player being watched
dealt it). The planted bomb blinks faster towards the end and its blast shakes the camera
(`scene/impacts.ts`). Each of CS2's atlases is fetched from `/effects/` the first time an
effect needs it; until it arrives, or when the server has none, the generated sprites stand in
(a noise shader for the flames), with one warning.

A smoke hides what is behind it. The effects are drawn in batches that all stand at the origin
(`scene/flipbook.ts`), so three's sort cannot put them behind or in front of the smokes' batch
by depth: the smokes' batch is made first and drawn first of them, so whatever stands in front
of a smoke is drawn over it, and each sprite behind one is faded as it is pushed by the share
of each smoke shown between it and the eye (`scene/smokecover.ts`: the ray from the eye against
the smoke's sphere, only the part in front of the sprite, a radius of it hiding the sprite at
the smoke's opacity). That covers the muzzle flashes, the blood, the impact puffs, sparks and
chips, the HE's fireball, ring and smoke, the decoy's pops and the flash's glow and flare, in the
scene's draw and in the bloom's alike; the first-person player's own flash, in front of every
smoke, is never faded. Tracers are not: they show through a smoke, as the shots out of one do.

What the bullets leave on the map (`scene/bulletmarks.ts`): where a miss meets a wall, a puff
of dust in that surface's colour (`DUST_COLOR`) for 0.5 s, with sparks off metal and chips of
CS2's glass debris off glass, and a bullet hole of CS2's for the surface, 7 cm across with a
near-black core, which stays 10 s and fades over 2 more; a wallbang the same on each face it
went through (at most 4), on the side the bullet met it; and a hit, CS2's blood on the wall up
to 1.5 m behind the victim, for 30 s. The newest of each are kept (96 holes, 24 blood marks, 32
puffs, 48 sparks). A wall's surface is read from the hull's group names (`sim/surfaces.ts`:
`physics_group_<surface>`; `pass` for what bullets fly through, chainlink and grates, `nodecal`
for what CS2 never marks, a puff in stone's dust and no hole). On a baked map each mark is lit
by the light grid where it lies (`scene/gridlight.ts`: a hole and blood by their wall's normal,
the sun only where the wall faces it, `wallLight`; a puff by the air in front). Every mark of a
round is found once, when the round (or the timeline or the hull) changes, by the hull's rays,
and lit then; each frame only walks them back from the newest, so what shows is a function of
(round, tick). Known gaps:
- **Nuke reads as metal.** Its world's hull group is `physics_group_metal` (127,656
  triangles): 807 of 821 misses in the local Nuke demo spark and take metal holes on concrete.
  A follow-up decides the surface by the world mesh's material under the hit, as the roadmap's
  §7.7 proposed, not by the hull group.
- **Doors and breakables are not in the hull** (they are `entities.glb`'s, not
  `world_physics`). A miss at a closed door or an unbroken window marks the wall behind it,
  which the door hides; a wallbang through a door leaves no mark; the tracer runs into the
  door.
- **The HE looks thin in daylight**: one fireball sprite, a soft orange burst on a sunlit map.

All of it is posed from the round timeline (`sim/timeline.ts`) at the tick, out of pools made
up front. Rounds play on through the after-round (`post_end_tick`), so a plant or a blast after
the round was decided is shown.

## Spectating

CS2's spectator tools (milestone 4). Everything here comes from the pack at the round and
tick (the highlights, summaries and stats worked out once per pack), so seeking shows what
playing shows.

### Outlines and names over heads

With `X` (or "Outlines through walls" in Settings, on by default) every player is outlined in
the team colour, T `#f2a33a` and CT `#4da3ff` (`scene/outline.ts`): where the world hides the
player, a flat silhouette in the colour shows through the walls, and around the parts that
are seen, a 2 px rim. The followed player is outlined in white (in POV their model is not
drawn: the view is from their eyes).
A dying body has no outline, and outlines cast no shadow. The materials are not tone-mapped,
but at `high` the post stack tone-maps the whole frame, so there the colours sit a few levels
off (CT about `#5fa1f1`, T about `#f7aa4f`).

"Names over heads" (on by default) puts each living player's name over a health bar filled
in the team colour (`scene/nametags.ts`), at one size on screen from any distance; none over
the player whose eyes POV looks through. The names show through walls with the outlines, and
behind them with `X` off; they draw over smoke either way.

### Highlights

Found from each round's kills and bomb events (`sim/highlights.ts`):

- **3k, 4k, ace**: a player's enemy kills in one round;
- **clutch**: the last player alive on a side, with an enemy alive, whose side wins the round
  while they are still alive at its end ("1v3 clutch");
- **ninja defuse**: a defuse with a T still alive;
- **collateral** (two or more headshot kills at one tick with one gun), **no-scope**,
  **wallbang** and the round's **opening kill**.

A team kill, a suicide, the world or the bomb counts toward none of them. `H` or the
Highlights button (a star on a phone) opens the panel under the camera row: the match's
highlights by round, the current round's group at the top, each row the round's clock at the
moment (the round's last live second for a round-winning kill or a clutch, which land when
the timer reads 0:00), the player and the kinds; "Opening kills" adds the plain opening
kills. A row plays its highlight's whole window in POV on the player, from 3 s before its
first kill (2 s before a clutch begins; a ninja defuse from the defuser's start) to 1.5 s
after its last kill, the defuse or a clutch's round end, and plays on from there. "Play all"
plays the **reel** from that round on: every highlight but the plain opening kills, a 3k, 4k
or ace as one window per kill (3 s before to 1.5 s after), a clutch or a ninja defuse whole,
and one player's windows closer than 1 s merged. A kill made after the player's own death (a
grenade or fire that killed after they fell) plays in POV on its victim, ending on their
death view, as the kill cam does; windows on one player merge whether they are that player's
own or on them as a victim, so nothing plays twice, and the banner names the highlight the
segment opens with. A row with one plays as the reel does, a window per kill. The Mirage
demo has 50 highlights, 27 of them in the reel. While a reel plays, a banner under the round
bar names the player and the kinds and where the reel is ("2 / 7"), with Next (`N`) and Back
(Escape).

### Kill cam

`K`, the "kill cam" button over the player card after the followed player's death, or a row
of the killfeed replays a death from 5 s before it to 1 s after (inside the round's live part
and after-round, `sim/killcam.ts`): in POV on the killer when the killer is another player
still alive at the kill, otherwise in POV on the victim, ending on their death view (a
grenade whose thrower had died, the world, a suicide). The banner names both players. With
"Kill cam after each death" on (off by default) it plays by itself when playback passes the
followed player's death and the 2 s of their death view, in POV, and play goes on afterwards;
never in Free, whose camera stays where it was flown, nor on the full radar, which stays up.

A kill cam and the highlights are both reels (`state/reel.ts`): segments of a round, a window
and a player, played in POV at 1× with the player pinned and the director and the full radar
off. Back (Escape), or a kill cam's end, returns to where it started, with the round,
tick, camera, player, director, speed and play state from before (Free where it was flown);
a highlights reel plays on from where it got to. A seek, a round step, a player, camera or
director pick, `R` or a new demo ends a reel where the user went, with their camera, director
and speed back.

### Round summary

From a round's end through its after-round (with "Round summary" on, the default, and never
during a reel), a panel under the round bar (`sim/summary.ts`): the winner and how, the MVP
and why, each player's kills and damage in the round (the winners first, by damage), and each
player's money and buys at the start of the next round. Its close button hides it until the
next round. The MVP is the round's `round_mvp` when the pack has one (the local packs have
none); otherwise the planter when the bomb won the round for T, or the defuser of a CT win by
defuse, and otherwise the winner with the most enemy kills, then the most damage. A bomb that
goes off after a win by elimination leaves the MVP to the kills, as in the game. The buys are
the next round's `item_purchase` events up to its buy time's end, matched to players by Steam
ID; the packs repeat a player's buy list on every change, so a purchase listed again is
dropped (as is a genuine second purchase of the same item in one buy window), and items sold
back are dropped where the pack says so (the parser rarely does: 30 of the Mirage demo's
1,154 purchases), so a refunded item can show as bought. A pack without money or purchases
leaves those columns out rather than showing zeros.

### Scoreboard columns

For the match up to the moment shown (`sim/stats.ts`):

| Column | What it counts |
| --- | --- |
| K, A, D | Kills of enemies; assists on enemies' deaths; deaths (a team kill or a suicide counts only the death) |
| +/− | Kills minus deaths |
| ADR | Damage to enemies, each hit capped at the health left, per round started (the current round included) |
| KAST | The share of decided rounds with a kill, an assist, survival to the round's end, or a trade (the killer killed by a teammate within 5 s) |
| HS% | Kills that were headshots |
| UD | Utility damage: the HE grenade's and the fire's |
| FA | Flash assists (`player_death`'s `assistedflash`; the local Mirage pack carries none) |
| Rating | The public approximation of HLTV Rating 2.0 from per-round kills, deaths, assists, ADR and KAST, never below 0 |

KAST and Rating count only decided rounds (a kill this round shows in K before it shows in the
rating), and read "–" until the player has one. Then money and equipment. On a phone the
board keeps K, D, ADR and Rating.

### Share a moment

The Share button at the end of the camera row hands on a link to the moment
(`state/share.ts`): `/d/<id>?r=<round>&t=<tick>&cam=<pov|free|auto>`, with `p=<player>`
(1-based, as the digit keys; not with `auto`): the player on screen, which after an unpinned
follow's death is whoever the camera cut to, or Free's selected player; and in Free
`at=x,y,z,yaw,pitch,fov` (scene metres to 2 decimals, degrees to 1; a link of five numbers
opens at Free's own field of view). On a desktop it copies the link and says "Copied" for
2 s; on a phone (a coarse pointer) the share sheet takes it, and cancelling the sheet does
nothing; with no clipboard (a plain-http address on the LAN) or a failure, the link shows in
a field, selected, that closes on Escape or a press outside. A link opens at its round, tick
(rounded), camera, player (pinned) and pose; each part that does not make sense is dropped
on its own, and opening one never changes the saved Auto setting. An old link's `cam=follow`
(the third-person camera there was before) opens in POV.

## Phones

A phone (a coarse pointer on a screen under 600 px on its short side, `state/device.ts`) or a
mobile GPU starts at the `low` preset without measuring and without saving it ("low (device)"
in the debug corner). A phone opens on the full radar unless the link names a camera (`cam`):
the 3D world, its hull and the player models are not fetched until the 3D view first shows (a
camera button or key, or a link that names a camera), so a phone that only watches the radar
downloads about 3.3 MB for the Mirage demo; the 3D view, with the phone tier at `low`, brings
it to about 11.5 MB (`phone.spec.ts`).

Below 720 px wide or 480 px tall the HUD is narrow, either way up, and turning the phone
reflows it without a reload: the camera row has the top right to itself (Highlights and Share
as glyphs, no keys); the round bar, a reel's banner and the round summary sit under it held
upright, or top left on its side; three killfeed rows take the round feed's place over a
compact player card; the minimap goes; the player list is a "Players" button at the bottom
left that opens a sheet of 44 px rows (picking one follows and closes it); the transport
wraps onto rows with 44 px targets; and the scoreboard keeps K, D, ADR and Rating. On a
touch screen the settings drop the key list. The page never scrolls sideways.

Touch (`geo/pick.ts`): a tap (let go within 250 ms and 10 px) on a player in the 3D view
follows them (their chest within 40 px), and on empty space plays or pauses; on the full
radar it follows the player whose disc is within 40 px. Two fingers pinch the radar's zoom
(1–4×) about their midpoint and pan with it; one finger pans it. In Free a one-finger drag
looks, 0.2° a pixel, as the right mouse button does (the left still does nothing). A finger
drags the scrubber without scrolling the page. A tap that closes an open panel (Settings, the
player sheet, the scoreboard, Highlights, the Share field) only closes it, and so does a
mouse click on the radar.

### Memory

An iPhone's Safari closes a tab whose web process holds more than iOS allows ("A problem
repeatedly occurred"), and the 3D view did that as its textures came in: a phone decoded the
desktop's textures (Nuke's world 710 images at 256 px, 138 MB as RGBA; the players' 31 at
1024 px, 98 MB), and three.js kept every decoded image after its upload. Three things keep it
within a phone's means:

- **The phone tier.** At `low`, where every phone starts, the world is `world_lo.glb` and the
  players `ct_lo.glb` and `t_lo.glb` (`tools/README.md`, The phone tier): the same models with
  the world's textures within 128 px and the players' within 512, a quarter of the texels or
  less (Nuke's world 34.5 MB as RGBA, the two players 26.8 MB). They load where the manifests
  list them (`files['world_lo.glb']`, the players' `ct.lo` and `t.lo`); where they do not (an
  older assets tree), `low` loads the desktop's files. A
  change to or from `low` swaps the world and the players (the scene does it,
  `Scene.setQuality`): the view, the
  hull and the doors kept, the replaced models freed once nothing draws them; a change that
  names the files already drawn reloads nothing. The outgoing world and players are drawn as
  they were until the swap lands, not dressed in the new look: a new anisotropy on textures
  whose images were released (below) would read their GLBs again and decode and upload every
  texture, only to free them (Mirage, `medium` to `low`: 469 images uploaded and `world.glb`
  and `t.glb` read again before, 242 and neither since; back to `medium`, 480 and 255). A
  `low` measured on a desktop (under 40 fps at `medium` in the first second) keeps the files
  it was measured with, on every later demo of the page too: the tier is for a phone's memory,
  and its swap downloaded the world and the players a second time. Its look still reads their GLBs again for the new
  anisotropy, from the HTTP cache where it keeps them: in a Playwright context (Chromium's
  in-memory cache, as in a private window) Mirage's 10.3 MB `world.glb` was downloaded again,
  the players (about 2 MB each gzipped) came from the cache.
- **Base colour only.** The looks draw a GLB material's base colour texture and no other, so
  GLTFLoader is given only that one (`makeGltfLoader` drops the normal, occlusion,
  metal-roughness and emissive textures before parsing): Nuke's world decodes 365 of its 710
  images, each player 5 of its 15 or 16.
- **Decoded images released.** Every GLB texture (the world, its doors, the players, the
  weapons, the first-person arms) drops its decoded image once it is on the GPU
  (`scene/images.ts`), for a stand-in of its size, so an upload three.js makes again allocates
  the texture without reading a closed bitmap. Such an upload (a lost WebGL context restored,
  which iOS does to a tab in the background; a new anisotropy) asks for the image again: the
  GLB is fetched again by its versioned URL, one GLB at a time, the image cut out and decoded
  as GLTFLoader decodes it, uploaded and released again. A restored context draws nothing until
  the images under the scene and the arms are back (at most 10 s), so nothing draws black first.
  A GLB that has not come back in 20 s is given up (its fetch aborted), and one that comes back
  other than it was (a redeploy and a cache miss: the server does not check `?v=`) gives
  nothing back; either way its textures stay black until the page is reloaded, with one
  warning. In desktop Chromium (Nuke, POV, `low`) the page held 796 decoded images, 240.7 MB,
  before, and 36 to 46 (14 MB) after: the radar's two overview images, the lightmap, and the
  world textures not drawn yet (released when first drawn).

Measured on 2026-10-26 as an iPhone 13 in Playwright's WebKit (`scripts/phone-memory.mjs`):
the resident memory of WebKit's web process every 0.5 s for 32 s from opening the link, its
peak and its last reading (steady), against the local release server with the same assets.
Each figure is the mean of three runs, in MB (the range in brackets). "Before" is main's build
at `51f5cf4` (the desktop's files at every preset), "after" this one; `?cam=pov` opens straight
into the 3D view at `low`:

| Link | Nuke peak | Nuke steady | Mirage peak | Mirage steady |
| --- | --- | --- | --- | --- |
| `?cam=pov`, before | 1,622 (1,545–1,740) | 1,405 (1,333–1,470) | 1,351 (1,310–1,398) | 1,141 (1,114–1,181) |
| `?cam=pov`, after | 1,231 (1,190–1,278) | 990 (943–1,073) | 1,057 (1,054–1,059) | 827 (815–848) |
| the radar alone (no `cam`) | 617 (609–632) | 557 (555–560) | 675 (663–683) | 571 (571–572) |

Over the radar, the 3D view now takes about half what it took steady (Nuke 848 → 433 MB,
Mirage 570 → 256) and 40 % less at its peak (Nuke 1,005 → 614, Mirage 676 → 382). The radar is
the same with main's build (Nuke 610 and 552, Mirage 705 and 574, one run each). The plan's
target for Nuke, a peak of at most 1,000 MB and 800 steady, is not met. What is left, from runs
with parts of Nuke's 3D view answered 404 (`BLOCK`, two runs each): without the world, a peak of
886 and 721 steady, so the world holds about 345 MB of the peak and 270 steady; without the
players 919 and 837, so about 310 and 150; without the weapons and the first-person arms, the
hull, or the doors, each within the runs' spread (at most 60 MB of the peak); with every GLB
answered 404 (the "No 3D map" grid) 599 and 560, the radar's. The world's textures are small
now (its 365 base colour images within 128 px), and what makes up the rest of its share is not
yet isolated: its geometry decodes to 44.3 MB of accessors (569 primitives), which three.js
keeps after the upload and the GL here holds again, far less than 270 MB. Nor is the players'
share: their load parses 231 clips a model (1.5 MB decoded) and ten rigs of them stay. The two
shares come from two runs each against the three runs' mean, and they overlap (together they
come to more than the 3D view's peak over the radar).

A lost WebGL context (`RESTORE=15`, Nuke, three runs, after the load): the view drew again
1.24–1.35 s after `restoreContext()`, the same paused frame as before the loss (a mean
difference of 0.02 of 255 per channel, the luminance 72.29 before and after). The memory rose
from 965–1,142 MB just before the loss by 62–102 MB at most, and read 978–1,183 MB 10 s after
the restore. On Mirage it drew again after 0.53 s (839 → 954 → 857 MB).
Main's build, which kept its images, drew again after 0.77 s (1,409 → 1,448 → 1,420 MB).
Playwright's contexts keep no HTTP cache on disk, so there the GLBs were downloaded again (the
transport's counter grew by 15 MB on Nuke); with a persistent profile, as Safari has, all nine
came from the cache (`transferSize` 0).

These are WPE WebKit's figures, drawing WebGL with software GL in a container, where the
textures and buffers count in the web process; an iPhone draws WebGL in Safari's GPU process,
under its own limits. They compare builds. Only an iPhone can show that the tab no longer
crashes.

One run, in Playwright's image (its WebKit does not run on Arch), against a server on the host:

```sh
docker run --rm --network host --ipc=host -v "$PWD/scripts:/work:ro" \
  mcr.microsoft.com/playwright:v1.63.0-noble bash -c 'cd /tmp && npm init -y >/dev/null &&
  npm i -s playwright@1.63.0 >/dev/null 2>&1 && node /work/phone-memory.mjs
  /tmp/node_modules/playwright/index.mjs "http://127.0.0.1:8095/d/<id>?cam=pov" 32'
```

`-e BLOCK=<regex>` answers the matching requests 404, and `-e RESTORE=<s>` loses and restores
the WebGL context at that second (`-e OUT=/out` with a writable `/out` keeps the two frames
compared).

## Performance

The HUD reads the store through derived view models (`state/derive.ts`): `useDerived`
re-renders a component only when its model changes (`sameModel`), and values that move every
frame (the scrubber's position, the flash whiteout) go to the DOM as CSS custom properties or
styles through `useFrameWriter`, not through React. `e2e/perf.spec.ts` plays round 1 for 10 s
at 2560×1440 and `high` on player 1 (these figures in Follow, the default camera then):

| Run | After Task 2 | At the milestone's end, outlines and names on |
| --- | --- | --- |
| The 3D view alone (`?hud=0`) | 192.9 fps | 196.8 fps |
| With the HUD | 145.9 fps (+1.67 ms a frame) | 171.7 fps (+0.74 ms a frame) |
| With the HUD, CPU slowed 4× (CDP) | 30.3 fps | 33.4 fps |
| HUD renders in the 10 s | 44 | 44 |

Before, every HUD component rendered every frame (about ten components at the frame rate, some
15,000 renders in 10 s at 150 fps), and the HUD took the viewer from 179 to 148 fps. The check
is that the HUD adds at most 2.5 ms a frame, with 60 fps or more and at most 150 renders (and
more than none, so the HUD run had a HUD), while the clock advances in both runs. It is added
time, not a ratio: at about 200 fps a ratio of 0.95 would leave the HUD about 0.26 ms, less
than the minimap's redraw (about 0.5 ms; it repaints its canvas every frame while playing) and
the cost of compositing the DOM over WebGL (0.3–0.4 ms). `e2e/spectate.spec.ts` plays the same
moment with the outlines on and off: 170.8 fps on, 190.0 off at `high` (0.59 ms a frame), and
`viewer.spec.ts`, with outlines and names on, drew 170.0 fps at 2560×1440.

### Download

The viewer (`views/DemoView` and all it imports, three.js among it) is a chunk of its own that
`App` loads when a demo opens, so the upload page downloads the app's chunk alone: React, the
upload page and the router. `npm run build` on 2026-10-26: the app was one 1,416 KB script
(436 KB gzipped); now `index` is 242 KB (76.5 KB gzipped) and `DemoView` 1,172 KB (359 KB), with
the viewer's CSS split off as well. Measured with Playwright against the real server: `/`
downloads 148.6 KiB over the wire (74.5 KiB of script), against 505.6 KiB (424.8 KiB of script)
before. A demo page fetches the viewer's chunk after the app's, one more round trip (the page is
empty meanwhile, as while the app's script loads); a demo opened from the upload page (an upload,
a link, a share code) keeps the upload page on screen until the chunk is in. Both chunks load
through `use-chunk`, which holds the module in state and shows it in the render after it is in,
where `React.lazy` under Suspense was shown no sooner than 300 ms after its fallback, however
soon the chunk came. With Playwright against the real server (medians of seven, on a loaded
machine), a demo's own link commits the viewer 0.09 s after the navigation, against 0.38 s under
`React.lazy`, and asks for the demo's status then: a desktop first draws the 3D view at 0.21 s,
against 0.48 s, and a Pixel 7 has the radar up with the match at 0.36 s, against 0.65 s.

The 3D view (`components/Viewport`: three.js and the scene) is a chunk of its own too, which
DemoView loads the first time the 3D view shows: as the demo opens on a desktop or with a link
that names a camera, and on a phone opening on the radar only at its first POV or Free. Until the
chunk is in, the view says "loading the 3D view…", and it mounts as soon as the chunk is in
(`use-chunk`). The clock, the sound and the device's preset are DemoView's
(`views/viewer-hooks`), so the radar plays and sounds without it, and nothing outside the 3D view
imports a module that imports three.js. `npm run build` on 2026-10-27: `DemoView` 171 KB (62 KB
gzipped) and `Viewport` 1,008 KB (300 KB), where `DemoView` was 1,177 KB (362 KB). With
Playwright against the real server (medians of seven), a Pixel 7 opening a Mirage demo on the
radar downloads 2,971.1 KiB (137.4 KiB of script), against 3,344.5 KiB (428.4 KiB of script)
before; the hidden scene's own requests went with it (`detail.png` and the weapons' and
viewmodels' manifests, 80 KiB). Its first POV fetches the chunk, 293 KiB of the 11.7 MB the 3D
view then loads, and first draws 0.16 s after the tap, against 0.12 s when the page made the
scene as it opened and 0.41 s under `React.lazy` (the world in: 1.00 s, against 0.92 s and
1.28 s), on a local server. A desktop downloads 3 KiB more (one more chunk's headers and CSS).

All the chunks are under `/assets/` (cached for a year) with their `.gz` beside them. A deploy
removes the previous build's chunks: a page left open across one, opening a demo or first
showing the 3D view, reloads once (`chunk.ts`, at most once a minute) to get the new build's
chunk, instead of failing on the old one.

## The radar

The match flat on the game's own radar image (`radar.png`, and `radar_lower.png` on Nuke,
Vertigo and Train), placed by the map's `overview.json` (`radar/overview.ts`), drawn with
Canvas 2D: the minimap in the HUD and, on `R` or the Radar button, a full view in place of
the 3D one (the scene stops drawing under it). Bottom to top: the image, the site letters,
smokes (a disc with a white arc for the time left), fires, grenades in flight with the last
second of their track, flash and HE bursts, decoys, a kill line from killer to victim for a
second (white for a headshot), an × where each player died, the bomb (beside its carrier,
dropped, planted and blinking, defused in green, a red ring when it blows), and the players:
a disc in the team colour with the digit that follows them (in the full view), a view cone,
a tick on each shot, white while blind, a red ring when hit, the followed player last and
ringed. On a two-level map the minimap shows the followed player's level and the full view
both side by side; whatever is on the other level is hollow at half opacity. The full view
zooms with the wheel (1–4×, about the cursor), pans by dragging, resets on a double-click,
and follows the player clicked.

Every layer is a pure function of the round and the tick (`radar/frame.ts`, through the same
`Timeline` as the 3D scene), so the two always agree; a frame builds in 0.017 ms on Mirage
(every 32nd tick of every round). The canvas redraws in the next animation frame after any
change in the store, once however many come first (`radar/controller.ts`), and React renders
`components/Radar.tsx` once.

## Quality presets

The presets change how the world is drawn, and download the same map (its `entities.glb`
included), players and pack, but for the world and the players at `low`, which are their phone
tier (`world_lo.glb`, `ct_lo.glb`, `t_lo.glb`: the same models with smaller textures; Phones)
unless `low` was measured on the device rather than chosen or set for it,
and fetch the same effect atlases when an effect first needs one.
The one file a preset adds is the map's sky, `sky.webp` (tools/sky.mjs: CS2's own sky as a
2048×1024 equirect, 7–31 KB), fetched the first time a preset that shows the sky
(`medium` or `high`) draws the map, and kept with the scene; `low` never asks for
it. A map's bake (`light.json` and `lightmap.webp`, below) is part of the map at every
preset. What the rendering work added is in the bundle (the three.js post add-ons) and the
49 KB `detail.png`. The doors and windows are dressed in each preset's look as the world is
(on a map with a bake, lit by it: the probes' light in their `COLOR_0`, without the detail
texture), and the items on the ground and the grenades in flight as the players' weapons are
(unlit at `low` without a bake; lit beside the players on a map with one); every preset draws
them.

| Preset | Lighting | Sun shadow | Smooth normals, detail texture, anisotropy, map sky and fog | Post stack | Pixel ratio |
| --- | --- | --- | --- | --- | --- |
| `low` | unlit, phase 3's look; a map with a bake draws its world lit by it and its players lit by its light grid, tone-mapped | none; 1024² on de_cache, whose runtime sun beside its bake would otherwise light every interior (`LIVE_SUN_LOW_SHADOWS`; the world's map drawn once, the players' every frame) | off (dark background, no fog, no `sky.webp`) | off | 1 |
| `medium` (default) | Lambert, Neutral tone mapping: the world lit by the map's bake where it has one, else by the hemisphere and the sun; the players by the bake's light grid and the sun where there is a bake, else by the hemisphere and the sun | 2048² PCF; over a bake with the sun in it, two maps: the world's, drawn once, and the players', every frame; none for a bake without a sun | on | off | up to 1.5 |
| `high` | as `medium` | 4096² PCF, likewise | on | GTAO, bloom (on a baked world, only past three times the exposure's white, and the effects by their own light), vignette, SMAA | up to 1.5 |

The lit presets take each map's sun, sky light, bounce, sky colour and exposure from
`src/scene/atmosphere.ts`, fitted on 2026-10-22 so that the average colour of views at the
spawns and bomb sites matches CS2's own screenshots of the map (the 1080p map screenshots in
`pak01_dir.vpk`); Neutral tone mapping keeps the colours as they brighten.

Behind the map is the map's own sky, `sky.webp`, as `scene.background` (equirect, at the
atmosphere's `skyIntensity`). Below the horizon it is one flat colour, the sky's horizon
colour (tools/README.md, Sky), which the map's manifest gives as `sky.horizon`: that is the
fog's colour, so distant geometry melts into the sky, and the background while the texture
loads or when it fails (logged once, naming the URL). A map built without a sky keeps the
atmosphere's sky colour for both. The texture is sRGB, so three.js draws it untouched, as
it does the clear colour; through `high`'s post stack, which tone-maps the whole frame, it
is first drawn once into a half-float copy that the tone mapping turns back into it
(`SkyBehindNeutral`, the closed-form inverse of Neutral that the fog colour also goes
through, held under the bloom's threshold in force: `BLOOM_THRESHOLD`, or on a baked world
three times the exposure's white, so a baked map's sky is no longer dimmed to fit 0.9; a
colour too saturated for its brightness, which the curve never puts out, is dimmed with its
hue kept instead of coming back tinted, a bright blue sky violet), so every preset shows the
same sky up to the vignette. What a preset does not draw is freed from the GPU: the post stack's copy off
`high` (and made again when a lost WebGL context comes back), and at `low` the texture's
upload too (its image stays, so a later preset uploads it again without a request); at
`high` the source's upload goes once the copy is made. The texture has no mipmaps. The
cameras and the sun's shadow box are fitted to the collision hull's bounds when the map has
a hull (the skybox props around Ancient and Nuke stand outside it), else to the world's: on
all ten maps the hull-fitted box still holds every vertex of the world, across and in depth.

### Baked light

A map built with CS2's bake (`tools/README.md`, "The light"; all ten since 2026-10-25, each
with its lightmap and vertex light, tier H2) lists `light.json` in its manifest. The viewer then fetches it, and the `lightmap.webp` and
`probes.bin` it names, beside the world (`src/scene/baked.ts`), once per map: a swap of the world
(a change to or from `low`) reuses all three, a swap that failed to load and the one after it too. It draws
`light.json` version 2 only, the lightmap as `sqrt(light / range)`; version 1's was RGBM,
which this decode would misread, so a stale bundle meeting new assets, or a new one meeting
old ones, draws the map as without a bake. The lightmap is `sqrt(light / range)`, 8 bits a
channel in a lossless WebP, so it is decoded as data (`createImageBitmap` with no
premultiplying and no colour management, `NoColorSpace`, no flip, on the lightmap UV `uv1`),
squared and drawn as `rgb² · range` at `lightMapIntensity` π, which cancels three.js's 1/π
against the bake's Lambert without π. It has no mipmaps: the 1024² atlas is magnified
nearly everywhere a camera goes (with trilinear mipmaps, under 0.6 % of the pixels of five
views at `high` changed by more than 8 levels, all at thin far edges; on a phone at `low`,
390×844, the overview turning 0.2° a frame, the first frame moved 0.4 levels on average and
the frame-to-frame flicker fell 2–4 % on Mirage and Nuke, the share of pixels flickering by
more than 16 levels unchanged: the shimmer there is the geometry's and the textures'), and a
mip level would average neighbouring charts (and square roots, whose mean is not their
light's); it takes 4 MiB of GPU memory (5.3 with mipmaps). A primitive without the lightmap UV
carries its light in COLOR_0 as `sqrt(light / range)` too (6 bits), squared per vertex;
COLOR_0 is then light, never the diffuse colour.

The world's materials take the bake in place of the hemisphere and ambient terms, at every
preset (one composed shader hook per material with the foliage normal, `src/scene/hooks.ts`),
and no detail texture: its noise on top of the bake's own variation read as grain on Nuke's
lobby walls and Mirage's palace. Where the sun is in the bake, they take no runtime sun either, and
where a player's shadow falls (on surfaces facing the sun) the baked light is halved
(`PLAYER_SHADOW`). Where it is not (de_cache, `sun.baked` false) the runtime sun lights the
world past its shadow maps, the world's own and the players' (see the light grid below); a bake
without a sun (none, or Train's brightness 0) gets
no runtime sun and no shadow map. Point lights (the molotov's) light the baked world as any
other, but nearer: on a baked map a fire's light reaches 4 m at 2.5 (`FIRE_BAKED_LIGHT`), a
glow on the floor and walls around it, where the 9 m at 6 of the look without a bake lit a
whole room of Mirage's orange. The sun shines from `light.json`'s direction, which the shadow
box is fitted along. On a baked map the runtime sun is the bake's own, `light.json`'s linear
colour at π times its brightness, which is how the bake lit the world's sunlit surfaces: where
the sun is in the bake the players and the arms take it; on de_cache, whose sun is not, the
world takes it too, beside its irradiance-only lightmap (1.9 × π ≈ 6.0, where the atmosphere's
3.6 in its grey was about 1.4). Every map without a bake keeps the atmosphere's colour and
intensity (`sunColor`, `sunIntensity`).

On a baked map a smoke is grey-white (`SMOKE_ALBEDO` 0.8) lit as the scene is: the light grid's
cube where it stands, averaged over every direction (up/6 + down/6 + 2·side/3 under CS2's
weighting), and a quarter of the bake's sun past the grid's sun, sampled again only when the
smoke, the grid or the sun changes; it keeps a quarter of that light's colour (`SMOKE_TINT`) and
its brightness, so a smoke under Mirage's orange sun reads white, not sand, and one in Train's
grey hall grey. In POV inside it the fog closes in in that colour (`inSmokeFog`). Without a bake a
smoke is the fog's colour, as before. Its puffs are CS2's smoke frames, a mid grey where they
cover, times `SMOKE_FRAME_GAIN` (2.75), so they are as bright as the generated puff they
replaced. An HE's smoke is lit the same way, at a point 0.75 m over the blast (half its rise),
sampled once per HE, with `HE.smokeColor` as its albedo.

The players, the weapons in their hands and the first-person arms take their light from the
bake's light grid (`probes.bin`, `src/scene/probes.ts`): a cell every 2.5 m holding CS2's probe
cube as the light from above (its +Y face), from below (−Y) and from the side (the mean of its
four sides), and how much of the sun gets there. Each player is sampled once per
frame at the chest, a metre above the feet, trilinearly in linear light (each cell decoded
from its square-root bytes before it is weighed: the grid sets bright cells beside dark ones
at the borders of CS2's probe volumes) and clamped into the grid, so a player beyond its edge
takes the nearest cells. The sample replaces the hemisphere term, weighed by the normal as CS2
weighs its cube's faces, `up·max(n.y, 0)² + down·max(−n.y, 0)² + side·(1 − n.y²)` (closer to
CS2's whole cube than a linear weighting or the old up/down mix; tools/README.md "Light grid"
has the numbers); the arms take a copy of the sample of the player POV shows (after a death
view, whoever it cut to), with the world's up turned into the view. They take it only while
they are drawn: hidden while scoped or dead, which includes a death view (the eye held where
the player died, `sim/deathview.ts`), they take no light at all, neither the copy nor the ray
to the sun below. A version 1 `probes.bin` (before the side term) still loads: its side is the
mean of its up and down, which is what it gave a surface facing sideways. The sun reaches the
players past the shadow maps at `medium` and `high`, and the arms (drawn without one) as far as
one ray from the eye along the sun gets past the collision hull (`Hull.sees`); at `low`, which
has no shadow map, both take the grid's sun, except on de_cache, whose live sun keeps a 1024²
shadow map at `low` (`LIVE_SUN_LOW_SHADOWS`): there the players take the maps and the arms the
ray at `low` too. For that the shadow is split in two maps of the same box wherever a bake has
a sun, in the bake or drawn beside it (`src/scene/lighting.ts`): the sun's holds the world and its doors and windows and is drawn
once, again only when the map, the preset, the sun or the GL context changes, or on a frame a
door turns or a window breaks (`MapEntities.set` says so); a second light that lights nothing
holds the players and their weapons, drawn every frame. The players take both, so a player in
a shaded doorway, or behind a closed door, is out of the sun; the baked world takes only the
players', since its own shadows are in the bake, and so a door's shadow never darkens it
twice. That costs a second shadow map (at `high`, 4096² of depth and 4096²
of colour three.js allocates with it, 128 MiB; at `medium` 32 MiB). On de_cache, whose sun
is not in the bake, the world takes the runtime sun on top of its irradiance-only lightmap,
past both maps at once (the world's own shadows from the first, the players' from the second,
as the players take them), and the players the grid's light and the runtime sun past both. So
its world (1.74 M triangles) is drawn into the shadow once and not every frame, at `low` too:
on a phone-sized view at `low` (`e2e/phone.spec.ts` on cache.dem, round 1 + 0:30 following a
T, `DEMOVIEWER_E2E_PHONE_P=2`) a frame drew 2.92 M triangles before
and 1.18 M after, at 121–134 fps before and 183–188 after on this desktop's GPU, the 34.20 MB
fetched unchanged; the frames are the same to within a level at `low` and `medium`. On Train,
without a sun, the grid's light alone. A map without a bake keeps
the hemisphere and the sun for its players, as before, at every preset. The grenades in
flight, the items on the ground and the bomb are drawn in the players' look and lit as the
players are (`src/scene/itemlight.ts`): on a baked map each takes the grid's light where it is
in place of the hemisphere, and the sun past both shadow maps at `medium` and `high` (their
meshes take them) or by the grid's sun at `low`, so an item lying in the shade reads shaded at
every preset. Each is a copy of its weapon model with materials of its own (`cloneWeapon`, the
bomb included), so each has a sample of its own: an item on the ground or the bomb is read half
a metre over where it lies (the lowest height the grid's refit fits) when it is put down or
moves, a grenade on every frame it flies, and nothing is made per frame. A map without a bake
leaves them as before: the hemisphere and the sun.

The doors and windows (`entities.glb`) are lit as the world is: on a baked map their
`COLOR_0` is the probes' light at their spawn (tools/README.md), which the world's
vertex-light look draws, with no detail texture and no runtime sun where the sun is in the
bake; the light turns with a door. Redrawing the world's shadow map while a door swings costs,
for the frames of the swing only, what the world's shadow cost every frame before the split
(Nuke's lobby at `high`: 1,284 draw calls a frame with the world casting every frame, 732
without); a door's shadow in the players' map instead would have darkened the baked world
under it a second time. Measured on Nuke's first door swing at `high` (2560×1440, `baked.spec.ts`
"times the frames"), a frame while the door turns takes 1.6 ms more than one in a still second
(13.4 against 11.8 ms, four runs): the GPU drawing the world's 4096² map again. The redraw walks
and makes nothing: the world's and the doors' meshes are listed once per map and sit on their
own layer (`WORLD_CASTER_LAYER`), the only one the sun's shadow camera sees, so the map is drawn
of the scene itself and holds them alone.

A baked map is tone-mapped at its own exposure, `bakedExposure` in `src/scene/atmosphere.ts`,
refitted on 2026-10-25 at `high` against each map's own CS2 screenshot (`hero.png`): the median
brightness of the part of the frame both show alike, from about where the screenshot was taken
on Mirage (1.35), Nuke (1.4), Anubis (1.1), Dust2 (1.15), Overpass (0.85), Inferno (0.9, by the
sunlit wall beyond its arch) and Train (1.8), and from a view of the same kind, by eye, where
that viewpoint is not something the viewer draws (Cache 0.8, Vertigo 0.6, Ancient 0.9); the comment there has the poses and numbers,
and `medium` reads 5–8 % brighter. On a baked world `high`'s bloom takes only what is past
three times the exposure's white (`BAKED_BLOOM_WHITE`; `BLOOM_THRESHOLD`, 0.9, without a bake):
the bake's light is CS2's own, so sunlit pale stone sits at 3–5 in the scene and bloomed into a
haze over Anubis's sandstone and Vertigo's white containers at 0.9. The flames, the flash and
the HE fireball draw no brighter than the exposure's white, so that threshold would take their
glow too (Mirage's molotov lost a halo of 16 levels on average around it, the flash 3): on a
baked world the effects that add light bloom by their own light instead (`EffectsBloomPass` in
`src/scene/post.ts`). They are on a layer of their own (`EFFECTS_LAYER`: the fires, the flash's,
HE's and decoy's cores, CS2's HE fireball, the decoys' CS2 flashes and spark streaks, the
grenades' glow, the muzzle flashes and tracers, the bomb's blink and blast, and the sparks off
metal of `bulletmarks.ts`), which the bloom draws alone over black, before its bright pass,
into the colour of the target the scene was drawn into (the AO has copied that colour on by
then, and its depth, the scene's,
hides an effect behind a wall or a player); the bright pass takes the brighter of the scene past
the threshold and the effects' light, the whole of it (`EFFECTS_BLOOM_THRESHOLD` 0). No target
is allocated for it. Measured on Mirage at `high` (2026-10-25, the bloom's own contribution in
mean 8-bit levels over the effect): the molotov 13.7, the flash 6.9, the HE 2.7 (16, 3 and 2 at
0.9 before the bake's threshold, the sunlit world's haze around them included), with the world
away from them unchanged; it costs 0.01–0.12 ms a frame at 2560×1440 (a paused frame's mean over
4 s, effects bloom on against off, in the busiest round, a molotov and a flash; playing the
busiest round, 11.06 ms a frame before and after). `e2e/baked.spec.ts` shoots the three with it
and without it (`assets/spike/m2a-ff-<effect>[-off].jpg`) and requires the middle of the view
brighter with it (×1.18, ×1.07 and ×1.11 on 2026-10-25, the flash its glow with CS2's flare
over it, the HE CS2's fireball) and the corners unchanged. A muzzle flash, a
fireball or a flare behind a smoke is faded in the bloom's draw as in the scene's (the same
faded instances, `smokeCover`). A fire's flames are not: they are drawn after the smokes
(render order 2) and glow through one, as before. A map without a bake keeps the one bloom at
0.9, which takes the effects with the rest, exactly as before; `medium` and `low` have no
bloom. Mirage's fog starts at 200 m and is whole at 700 (the default's 120–420), so the
whole-map view is not washed in its cream
horizon. The exposure applies at every preset, `low` included: there what is
drawn unlit (the smokes and other effects, the utility labels, tracers and damage numbers) is
tone-mapped with it, while the flames divide the exposure out and the name tags, outlines and
x-ray are drawn untouched. A `light.json` or light grid that is missing, is not a bake this
viewer can draw, or does not decode is one warning, and the map draws exactly as without a bake,
its players included. A lightmap that is missing or does not decode beside a grid that loads is
one warning too, and only what it lights is drawn as without the bake: the vertex-lit
primitives, the doors and the players keep it (`loadBaked`'s `lightmapError`). On assets built with the bake, "as without a bake" is
not today's look: their `COLOR_0` is light where it was AO. So a release that ships baked
assets ships its image first and syncs the assets after, and never rolls the image back after
that sync without syncing the old assets again (tools/README.md, Syncing to a server). The
world's own shadow is drawn once (per map, preset, sun or GL context, and again on the frames
a door turns or a window breaks), not every frame, so a frame draws only the players into a
shadow map:
`high` on Nuke's lobby drew in 12.1 ms against 13.0 ms without the bake, in 732 draw calls
against 1,284 (median of five alternating 3 s probes during round 1, 2026-10-24; with Task
5's single shadow map it drew in 11.7 ms in the same 732 calls, the same within the noise:
best of six 11.5 ms both). `e2e/baked.spec.ts` checks the draw calls and that the world's
shadow is not drawn again while frames are drawn and no door moves, and that it is while one
swings.

With nothing saved, the viewer opens at `medium`, times the first second of the map and the
players, and picks `high` at 100 fps or more, `low` under 40 fps, or stays at `medium`; that
pick is not saved, so the next visit measures again. Choosing a preset (`Q` or the select)
saves it in `localStorage` (`demoviewer.quality`) and turns the measuring off. A device that
cannot run the post stack (no half-float render targets, or no anisotropic filtering) draws
`high` exactly as `medium`. Switching frees the previous preset's materials, shadow map and
post targets; the world's textures are kept.

## Players and weapons

Each player is a rig of `/players/t.glb` or `ct.glb` (231 clips, 1.94 and 2.12 MB
gzipped; `tools/README.md`; at `low`, `t_lo.glb` or `ct_lo.glb`, 1.40 and 1.45 MB, Phones), posed in layers every frame from the pack alone: directional
locomotion at the family's strides (rifle, pistol, knife; grenades and the c4 move with the
pistol set), the held weapon's own grip, actions (reloads, draws, knife swings, throws on
the upper body; planting and defusing on the whole body), gun recoil and hit flinches on
top, the aim (the spine bends with the pitch), then a procedural death.

Between the pack's 32 Hz samples (`src/sim/sample.ts`) a player moves along a cubic B-spline
over the samples, so there is no corner at each sample and the pack's whole-unit rounding is
evened out, turns and looks along a monotone cubic through every sample, and crouches
linearly, so the eye in POV never steps. The locomotion blend changes a little every frame
(a 0.15 s cross-fade, a weapon switch included), and strides play at the speed their planted
foot moves in the clip (run 195, walk 110, crouch 85 u/s), so the feet do not slide.
`e2e/smooth.spec.ts` measures all of it in the page.

The game's per-weapon idles, `idle_c4`, `idle_grenade`, `idle_molotov` and every gun's
`shoot_*` are deltas from a reference pose, `breathing`'s first frame. The rig adds a
weapon's idle over the family locomotion from that reference (the `pose` variant in
`scene/PlayerRig.ts`) and a shot as upper-body recoil from the clip's own first frame,
on a slot of its own so a flinch at the same moment does not cancel it. Played whole,
these clips put the arms out to the bind pose.

Weapons are the world models under `/weapons/` (45, 2.55 MB gzipped in all), fetched the
first time a player holds one (`WeaponCache` in `scene/weapons.ts`) and hung from the
`wpn` bone, which the clips animate as the weapon's own attachment, the way the game does:
by the model's `weapon` bone, whose rest pose the export keeps as `userData.attach`
(`placeHeld`). That pose turns the glTF axes (Y up, the barrel along +Z) into the game's,
which `wpn` uses (X forward, Z up), and carries an offset of its own per model, 11 cm on
the AK and 56 cm on the M4A4; held by their origins, every gun stood on end and most missed
the hands. First person puts the same bone at the family's place in view. A model without
the pose (an asset set from before it) gets the turn only. A T holds `knife_t`. A bomb carrier holding
something else wears the c4 on `spine_3`. A model that fails to load stays absent, with
one warning and no retry. Every file a manifest lists (map worlds and hulls, players,
weapons) is fetched as `<path>?v=<first 8 hex of its sha256>`, which the server caches
for a year without revalidating; a match downloads only the weapons its players hold.

### First-person arms

POV draws the followed player's team's arms (`/viewmodels/arms_ct.glb`, `arms_t.glb`, 85 and
79 KB gzipped) playing the held weapon's viewmodel clips (`/viewmodels/<model>.glb`, one per
weapon model, 6–46 KB gzipped; tools/README.md, Viewmodels), with the gun on their `wpn` bone
held as third person holds it (`placeHeld`). Both are fetched the first time POV shows them
and only once the `/viewmodels/manifest.json` is in (`ArmsCache` in `scene/arms.ts`), so a
match that is never watched in POV downloads none of it, and one that is downloads the arms
of the teams it follows and the clips of the weapons they hold (about 0.7 MB gzipped for
both arms and the 23 weapons of a typical match).

The files carry CS2's viewmodel skeleton, whose `root_motion` is the eye (+Z ahead, +X left,
+Y up in the glTF frame). The rig (`ArmsRig`) is turned 180° about Y to face the viewmodel
camera's −Z and moved by the game's `viewmodel_offset_x/y/z` (`ARMS_OFFSET`, inches right,
ahead, up: 2, 2, −2, the user's own config) at the 68° 4:3 `viewmodel_fov` (`VIEWMODEL_FOV`),
plus the walk bob. With no offset the AK's idle holds its `wpn` 0.132 m right, 0.063 m below
and 0.375 m ahead of the eye.

Which clip plays is `firstPersonPose` (`sim/firstperson.ts`), a pure function of the player's
actions that started in the last 6 s (`ActionIndex.recent`, finished or not: the clips outlast
the actions) and the tick: the newest shot, reload, draw, pin pull, throw (over- or underhand)
or plant that the held weapon has a clip for plays from its start for the clip's own length
(the AK's shot 0.77 s, the AWP's 1.6 s, the M249's reload 5.7 s), blending in over 0.1 s from
what played before it (a draw starts below the view and does not), then holds its last frame
and blends into the idle over 0.1 s; the idle runs on the round clock. A shot, reload or draw
counts only for the weapon it was made with; a knife's shot is its light swing; the Dual
Berettas fire right on even ticks and left on odd ones. The rig writes every clip's weight and
time each frame and evaluates the mixer at zero delta, so scrubbing or seeking backwards gives
the same pose. Nothing shows while scoped or dead, so nothing shows in a death view either.

The Dual Berettas' and the molotov's clips leave `wpn` at the eye and carry the model's parts
on its own `weapon_hand_r` and `weapon_hand_l`, which follow the hands (`HAND_PARTS`): the
model is cut in two at a plane in the `weapon` bone's frame (`keepWhere`; the pistols are
0.508 m apart, the lighter 0.10 m ahead of the bottle; the Berettas' holster is hidden), each
piece hangs on its bone as that part of the model hangs from it at rest, and each is turned
half round into the hand bones' mirrored frames (the right about Z, the left about X). Magazines and
bolts do not move: the weapon models have no skeleton. Until the arms, the weapon's clips and
its model are all in (or when the server has no viewmodels), the gun is drawn alone at its
family's place in view, kicked by shots, raised by a draw and dipped by a reload
(`viewmodelPose`, `VIEWMODEL_OFFSETS`).

## Doors, windows and ground items

Doors swing and windows break when they did in the match, and weapons, grenades and defuse kits
lie where they fell until someone picks them up. Both come from the pack alone
(`docs/pack.md`): `ENT1` lists the map's doors and breakables at their spawn and a change list
of their angles and breaks within each round, and `GND1` + `GNB1` the items on the ground as
runs of keys (where an item lies and how it is turned, written when that changes, and a `gone`
key when it is picked up). A pack made before these sections plays as before: every door at its
spawn, nothing on the ground.

The doors and windows are the map's `entities.glb` (one node per entity at its spawn transform,
named by hammer id; tools/README.md, Shrinking a map), fetched with the world when the map
changes and kept when the world swaps. `MapEntities` (`scene/mapents.ts`) gives each pack entity
the nearest node of its class whose spawn is within 2 units of the entity's (a door is a
`prop_door_rotating`, `func_door_rotating` or `func_door`, a breakable a `func_breakable`) and
warns once (`entities: …`, with positions) about any it cannot match; a node no entity finds
stays at its spawn. A door turns along its keys (`sim/mapents.ts`: linear between them, the
last one held). A window is hidden from its break on; for 0.6 s the break throws eight glass
chips and a puff of dust from its middle, drawn from the `debris` and `dust` atlases, which are
fetched from `/effects/` the first time a window breaks or a bullet first marks a wall (`dust`)
or glass (`debris`); a generated puff stands in until they arrive. The dust's colour is what
the screen shows (`BREAK.dustExposure`: the light dust chosen at Mirage's exposure without
its bake), the tone mapping's exposure divided out as the flames'
is, so it reads as the same light dust on a baked map, at its lower exposure, as on one without
a bake. The doors draw with the world (render order 0), so the team x-ray shows a player
behind a door as behind a wall.

CS2's glass, every material of its `csgo_glass.vfx` shader, exports from VRF as a blended
material with base alpha 1 and no texture, which drew opaque white or beige: the windows (Mirage's
before it breaks, Nuke's), the panes of doors and offices on Nuke and other maps, and Vertigo's
plastic-wrapped insulation. The look (`scene/look.ts` `GLASS`, keyed on the shader name the
glTF's extras carry into `userData`) draws it see-through instead, at an opacity of 0.3 (0.7
for frosted glass, whose vmat is named so: Nuke's milky panes give no sightline), without depth
writes, tinted by its `GlassTintColor` where it has one, at every preset and under the bake,
with no asset rebuild. Glass a map tints near-black by its base colour (Overpass's offices,
0.007–0.16) reads as dark tinted glass, not black panes. `baked.spec.ts` measures each pane
against the same glass drawn opaque (the GLBs answered with the shader renamed).

Ground items (`sim/ground.ts`, `scene/ground.ts`) are the weapons' world models under
`/weapons/` (the kit is `defuser.glb`), fetched as a held weapon's are, the first time a round
has one on the ground, and hidden until they arrive. They are posed in 48 slots made up front;
past 48 the oldest items are left out (the five local demos have at most 24 on the ground at
once, on Mirage and Overpass). The dropped bomb is not a ground item: it is drawn from the bomb
events, as before.

Everything is a pure function of the round and the tick, out of objects made up front: seeking
back to a moment draws the very frame playing drew (the e2e compares the canvas bytes). The
sections are small next to the pack (the server's packs of the five local demos, 2026-10-24;
"added" is what the three sections add to the gzipped pack):

| Demo | Doors and breakables | Door and break keys | Ground keys (runs) | `ENT1` gz | `GND1` + `GNB1` gz | Added | Pack |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Nuke | 4 doors, 2 windows | 96 | 5,171 (193) | 0.8 KB | 41.3 KB | 43.0 KB | 1.44 MB |
| Mirage | 1 window | 3 (all breaks) | 9,147 (338) | 0.2 KB | 72.2 KB | 73.8 KB | 2.62 MB |
| Inferno | 1 door | 0 | 7,766 (255) | 0.1 KB | 61.7 KB | 62.5 KB | 2.21 MB |
| Overpass | 1 door | 0 | 9,025 (305) | 0.1 KB | 71.2 KB | 72.3 KB | 2.49 MB |
| Cache | 1 door | 34 | 6,622 (263) | 0.3 KB | 54.0 KB | 54.9 KB | 2.24 MB |

## Sound

CS2's own sounds, placed in the world and heard from the camera (`src/audio/`, the cues in
`sim/sounds.ts`; the banks are built by the tools, `tools/README.md` "Sounds"). Each sound is
a key of the sounds manifest (`shot:ak47`, `step:concrete:ct`, `bomb:beep`) with the layers
CS2's soundevent plays: clips cut from one bank, a volume and pitch with their random spread,
CS2's distance curve and an offset (a shot at the gun's height). A round's cues are a pure
function of the pack, the round and the hull's surfaces (`roundCues`), made once per round:

- each shot (the silenced one from a silenced USP-S or M4A1-S) or grenade throw at the shooter,
  and each reload's out, in and bolt where the player then is, cut short by a death or a
  switch to another weapon;
- footsteps and landings, by the surface the map's hull names under the feet (its
  `physics_group_<surface>` nodes) and the step set CS2 walks that surface with (`plaster` on
  `concrete`), the CT or T set; without a hull, or on a surface the manifest does not know, the
  `default` set, made again once the hull arrives;
- each hit and death at the victim (head, a helmet, body, armour);
- each grenade bounce; the HE's and the flash's bursts, a smoke's release, a fire's start, its
  loop while it burns and its end, and a decoy's shots of the gun its thrower last fired (else
  the side's pistol);
- the bomb: the plant, a beep on each blink of its light, the defuse and the blast; and the
  round's countdown beeps, the go and the winner's announcer.

Nothing under `/sounds/` is fetched before the page's first click, tap or key press
(`pointerdown`, `pointerup`, `touchend`, `click` or `keydown` anywhere: HTML's
activation-triggering events, the gestures browsers want before audio), or while the sound is
off in Settings. A press a browser does not count (a finger's `pointerdown`, Esc) makes the
audio context suspended: the banks load, cues crossed meanwhile are skipped, and the next
gesture (the same tap's `pointerup`) starts it; each gesture does so again whenever the context
stops running (a phone call). On the `low` preset (what phones get) the context runs at 24 kHz,
so a typical Mirage match's banks decode to about 46 MB of memory, not 92 MB at 48 kHz, for
the sound above 12 kHz. Then the manifest comes (22.6 KB gzipped), and each bank a round names
(`/sounds/<bank>.webm?v=<hash>`, one mono Opus file per family: a gun, a grenade, the bomb,
hits and deaths, the round, a step set) the first time that round is shown, all through the
download counter. While playing, in a round's last 10 s, the next round's cues are made in
idle time, so its banks are in by the crossing. A bank that 404s or will not decode warns once
and stays silent; nothing else changes.

A one-shot cue plays once, when an advance of the clock crosses its tick, at 2× or slower; a
cue whose bank is still loading is skipped, never played late. A seek (the scrubber, `←`/`→`,
`,`/`.`, a round cell, a kill cam or a reel's jump), a pause, a speed above 2× or the mute plays
nothing and stops what is playing (a 0.05 s fade). A burning fire's loop is state: it sounds
while playing at up to 2× and its span holds the tick. The listener is the camera drawn last
(in POV the player's eye); under the full radar, the shown player's eye from the track. Gain
is CS2's: the layer's volume times its distance curve, the panner (HRTF) only places the
sound. At most 32 voices sound, the quietest dropped first, through a compressor on the master
(−6 dB, knee 6, ratio 12; the banks peak near +3 dBFS).

Where this departs from the spec's §7.10:
- **Footsteps come from the tracks**, not `player_footstep`, which the pack has about once
  every 5 s per player. A player alive, on the ground, not walking, crouched less than half and
  at 135.2 u/s or more steps every 0.3 s; a landing after 0.2 s or more in the air thuds.
  The Mirage match has 16,743 steps and 1,212 landings.
- **Beeps, bounces and decoy shots are derived**: the pack has no `bomb_beep`,
  `grenade_bounce` or `decoy_firing`. A beep is each blink of the planted bomb's light, a
  bounce a change of over 150 u/s in a grenade's velocity at over 50 u/s (0.15 s apart), and a
  decoy's shots are bursts drawn from its seed.
- **2× at most** (`SOUND_MAX_SPEED`): at 4× and 8× the replay is silent.
- Mix groups, occlusion and reverb are not modelled.

Known gaps: the go beep (`UI.CounterDoneBeep`) is silence in CS2's own files, and so it is
here. Some guns have no reload part in CS2's data (the Dual Berettas', G3SG1's, MAG-7's, R8's
and XM1014's bolt, the M249's and Negev's clip in and out, the Nova's, Sawed-Off's and XM1014's
out), so that part is silent. The USP-S and M4A1-S always sound silenced (the timeline's
`suppressed`; every shot in the Mirage match was). The first round shown, and a round jumped
to, make their cues on their first frame: 8–15 ms on Mirage in Chromium (510–982 casts down
the hull, 669–1,305 cues a round). Headless Chromium cannot hear, so whether the mix and the
60 % default are right is for an ear. Nor does it hold a context back for a gesture (every
context runs, whatever `--autoplay-policy` says), so that the first tap on a phone starts the
sound, with no burst, wants a real phone, an iPhone above all; as do the decoded banks' memory
there and its audio thread with 32 HRTF voices.

Measured on 2026-10-26 (CS2 build 2000935), on Mirage:
- **The budget** (§7.10: at most 3,000,000 B for a typical match): `test/sound-budget.test.ts`
  makes every round's cues on the real hull and adds up the banks they name: 42 of the 90,
  **2,754,050 B**. The 23 guns are 1,171,171, the five grenades 727,830, the bomb, player and
  round 222,478, and 11 step sets 632,571. The largest are `grenade_fire` 389,757 (both fires'
  starts, the loop and the fade), `grenade_he` 138,251, `weapon_m4a1s` 120,612,
  `grenade_smoke` 117,984 and `weapon_elite` 99,831. (`check-sounds.mjs`'s 2,883,973 B counts a
  step set for every surface the hull has, not only those stepped on.)
- **Downloads**, by the counter: a cold load opened 2 s before round 1's freeze ends, in POV,
  is 17.15 MB; the first click adds the manifest and round 1's 12 banks, 798,523 B, to
  17.96 MB. Played through at 8× (silent, but each round shown asks for its banks), with a pack
  the branch made from the same demo, the whole match comes to 23.0 MB: maps 9.14, players
  4.44, the sounds 2.79 (42 banks and the manifest), the pack 2.62, weapons 1.67, effects 0.92,
  the first-person arms and clips 0.78, and 0.64 the app and the rest. Less the first-person
  files, which §12 counts as extra, that is 22.2 MB, over §12's 20 MB for the match; without
  the sounds it is 19.4 MB, as milestone 2b measured.
- **The busiest 30 s** (round 3, ticks 12351–14271): 296 cues played, none skipped, from 23
  banks; recorded off the page's audio graph at volume 0.6, −14.7 LUFS integrated, peak
  −0.3 dBFS.
- **Frame rate** with the sound on: `sound.spec.ts` drew 140.8–162.4 fps over four runs at
  2560×1440 in POV, playing round 1 from 10 s after its freeze. `viewer.spec.ts` drew 167.8 at
  the same moment; its first key press unlocks the sound too.

## Tests

`npm test` needs no assets. The tests that check how the viewer reads a whole match (the
pack's sizes, the timeline's counts against the events, the scoreboard, the round summaries,
the highlights, the director, the radar frame and the sound cues) run on a synthetic match made
in code (`test/helpers/synthetic-match.ts`: ten players on Mirage's ground plan over eight
rounds, written by `encodePack` and read by `parsePack` as a real pack is), and again on a real
match's pack when `DEMOVIEWER_PACK` names one; packs of real matches are never committed. The
checks of one demo's own numbers (the Mirage pack's 24 rounds and 176 deaths, the director's
77 %) and the tests of the built assets skip unless their data is set:

```sh
DEMOVIEWER_PACK=~/.local/share/demoviewer/mirage-current.dvpk.gz \
ASSETS_DIR=$PWD/../assets npm test
```

A test that needs local data is named for it (`[needs DEMOVIEWER_PACK]`, `[needs ASSETS_DIR]`,
`[needs DEMOVIEWER_PACK_FP]`; `test/helpers/gates.ts`), and a run that skipped any ends by
saying how many, in which files and what to set (`test/helpers/skipped-reporter.ts`): a test
marked in a marked block needs both, and only the variables still unset are named. The time
limits in the unit tests are CPU time (`test/helpers/cpu-time.ts`), which other work on the
machine does not stretch as it does the wall clock.

(Make it in `~/.local/share/demoviewer` from the local Mirage demo with this checkout's CLI,
`demoviewer-pack-cli demos/mirage.dem mirage-current.dvpk.gz` (see the server README), and
again when the pack gains a section. Older packs lack the newer sections: `mirage-fp.dvpk.gz`
of 2026-10-22 has no `ENT1`, so the doors case of `effects.spec.ts` skips (saying so) on a
server holding it, and `mirage.dvpk.gz` of 2026-10-21 has no `TRK2` or `post_end_tick`, so the
round summaries are checked for no money there.)

The unit tests run in node. Component tests (`test/*.test.tsx`) render with
@testing-library/react in jsdom, chosen per file by a first line of
`// @vitest-environment jsdom`. `test/panel-boundaries.test.tsx` shows the setup: DemoView on a
synthetic pack, with `api/demos` and `pack/client` mocked, the Viewport and the Radar stubbed
(jsdom has no WebGL, no Worker and no 2D canvas) and `HTMLCanvasElement.getContext` answering
null. `test/helpers/fake-scene.ts` stands in for the 3D view's `Scene`.

`test/tools-parity.test.ts` runs the asset pipeline's own writers and readers (`tools/lib`)
beside the viewer's, and holds the light fixtures (`test/helpers/light-grid.ts`'s probes.bin
grids and `test/helpers/light-json.ts`'s light.json objects) to what the encoders write. The tools' modules load sharp, `@gltf-transform` and three from
`tools/node_modules`, so it needs `cd ../tools && npm ci` first; without that it is skipped and
says so on stderr. No other web test loads them.

`test/rig-real.test.ts` needs only `ASSETS_DIR`: it poses the real T and CT models with the
real weapon models and requires every weapon's hold to put the right hand within 0.3 m of the
`wpn` bone (the c4's left hand within 0.35 m), every gun's barrel within 10° of where the
player faces with the right wrist within 7 cm of the gun (13 cm for the Dual Berettas) and,
on two-handed guns, the left within 6 cm, the knife, c4 and grenades in the hand, and every
gun's shot to move the right hand less than 0.15 m. With `DEMOVIEWER_RIG_LOG=1` it prints
the distances and each model's parse time (T 0.2 s, CT 0.13 s under node, textures stubbed).

`test/sound-budget.test.ts` needs both: it makes every round's cues of the Mirage match on the
real hull, adds up the banks they name by the real sounds manifest's sizes and requires at
most 3,000,000 B, printing the total and the five largest banks (the figures are under Sound).

The Playwright smoke tests in `e2e/` run against a live server (default
`http://127.0.0.1:8095`, or `DEMOVIEWER_E2E_URL`) serving `dist/` and the assets. Run
`npx playwright install chromium` once. Each spec skips unless its variable is set:

```sh
DEMOVIEWER_E2E_DEM=~/.local/share/demoviewer/demos/mirage_old.dem \
DEMOVIEWER_E2E_DEMO=<id of an uploaded Mirage demo> npm run e2e
```

The specs wait on what the page does rather than for fixed times: `e2e/wait.ts` counts the
page's loads in flight from before its first script (fetches and the reading of their bodies,
image bitmaps decoding, `<img>` loads), and `settled` waits, paused, until none is left, the
3D view's frame counter stands still and no CSS animation of a finite length runs (what the
view loads after it says it is ready, the sky, the arms and their clips, a weapon or an atlas,
is then drawn, and a killfeed row over the canvas has slid in). No hook in `src/` serves it.
The sleeps left are measurement windows (the frame-rate samples, each 500 ms of `stats.fps`)
and the fly camera's held `W` in `effects.spec.ts`. A spec fails on an error the page did not
catch and on a render error one of the viewer's panels caught (`e2e/errors.ts`, `trackErrors`,
from the boundary's `demoviewer: render error` console line; `baked.spec.ts` fails on any
console error): a panel that fails leaves the rest of the viewer up, so a spec that does not
look at that panel would pass. With the round strip made to throw, viewer and radar passed
before and fail with it. On 2026-10-27 the whole suite (with
`DEMOVIEWER_E2E_NUKE` and `DEMOVIEWER_E2E_DEM` set) passed 38 of 38 twice in 9.2 and 8.9 min
against the local server.

`upload.spec.ts` drops the demo on `/` and waits for the viewer, then fails a chunk on
purpose and retries from it; each run uses two of the ten ingests a client may start per
hour. `quality.spec.ts` checks the automatic pick, prints each preset's frame rate while
playing, cycles `Q` ten times (each change waiting until the viewport is ready again: a change
to or from `low` swaps the world and the players for their phone tier) and requires the renderer's texture, geometry and program counts
to stay put and `high` to draw the same paused frame with the same triangles and draw calls,
and writes `e2e/out/quality-*.jpg`; it swaps `medium` to `low` and back counting the GLBs
fetched and the images uploaded (the incoming tier's files once each, none of the outgoing
one's), and slows the probe's GPU wait to measure `low` and requires the world and the players
to stay `world.glb`, `ct.glb` and `t.glb`. `viewer.spec.ts` opens round 1 from a URL position, plays
it in POV, checks the camera sits at player 1's eye (`window.__demoviewer.camera()`), writes
`e2e/out/mirage-r1.jpg` and requires 60 fps or more at 2560×1440, then switches to Free with
`C`, flies forward with `W` and writes `e2e/out/mirage-r1-free.jpg`; the minimap is up
throughout, so the 60 fps also holds with it. `radar.spec.ts` opens round 1 at 0:30, requires
the minimap to draw, `R` to show the full view with the 3D view's frame count standing still
under it and `V` to bring the 3D view back, and writes `e2e/out/radar-mini.jpg` and
`e2e/out/radar-full.jpg`. `camera.spec.ts` opens a match with no camera in its link and
requires POV on player 1, unpinned, with the director off (`e2e/out/pov-default.jpg`); paused
at moments of round 1 the camera must be within 1 cm and 0.1° of player 1's eye and view; it
plays round 1 at 8× in POV and logs the frame rate; it plays round 1's first death at 1× with
the victim followed: the camera holds their death view (the eye and view of their last live
sample) still until 2 s after their first dead sample, then shows someone alive
(`pov-death-view.jpg`), and pinned holds it to the round's end and is on them again in round
2; with `A` it stays in POV and, at the director's first cut away from a dead pick, shows that
pick's death view just before and the next pick's eyes just after (`pov-auto-before.jpg`,
`pov-auto-next.jpg`), and round 1 at 8× changes who is shown at least once; an old
`cam=follow` link opens in POV, pinned on its player. On 2026-10-24 against the local server
the camera sat 0.0000 m and 0.000° off player 1's eye and view, the death view held 2.01 s
(264 frames) before the cut, and round 1 at 8× drew 123 fps. Against the Docker
image on 2026-10-21: `mirage_old.dem` (57.8 MB) uploaded in 7.9 s, and the viewer drew
210 fps on the Mirage world with ten rigs. Against the image again on 2026-10-22, with the
presets: 209.5 fps at `high` (picked automatically from 238 fps at `medium`) in
`viewer.spec.ts`, and low 327, medium 216, high 197 fps in `quality.spec.ts`.

Milestone 4's specs: `perf.spec.ts` plays round 1 for 10 s at `high` three times, the 3D view
alone (`?hud=0`), with the HUD, and with the HUD under a 4× CPU slowdown, and requires the HUD
run at 60 fps or more, the HUD to add at most 2.5 ms a frame and to render at most 150 times
(the figures are under Performance). `spectate.spec.ts`, on round 1: finds a moment where the
map's hull hides a player from player 1's eyes in POV (the moments from the pack's positions, the
hiding from a sphere traced along `hullDistance`) and requires at least twice as many pixels
within ±12 of a team colour with `X` on as off, at `medium` with `?hud=0`
(`e2e/out/xray-on.jpg`, `xray-off.jpg`); opens the highlights with `H`, plays the first row (a
reel in POV within 0.25 m of its player's eye, under the banner) and comes back with Escape to
the tick it left; plays player 1's kill cam with `K` 2 s after their death (POV on the killer)
through to the tick it started from; copies a POV link with Share and opens it in a second page
at the same round, rounded tick, camera and player; reads the winner and the MVP off the round
summary at round 1's end + 1 s (`e2e/out/round-summary.jpg`); and prints the frame rate with
the outlines on and off, requiring 60 fps or more with them on. `phone.spec.ts` runs as
Playwright's Pixel 7: the full radar at load, at `low` (`?debug=1`'s `data-quality`), with no
`world*.glb`, `hull.glb` or `/players/` request; with Settings open a tap on an enemy's disc
only closes it, and the same tap again follows that side; taps on play and pause; a touch drag
along the scrubber moves the tick; POV fetches the world and the players, their phone tier
(`world_lo.glb`, `ct_lo.glb`, `t_lo.glb`, which the manifests must list) and none of the
desktop's (`world.glb`, `ct.glb`, `t.glb`), and draws; in the 3D view a tap on empty space plays and another pauses, and with Settings open only closes it;
the page never scrolls sideways (`e2e/out/phone-radar.jpg`, `phone-3d.jpg`). It prints the
bytes the 3D view fetched, its frame rate playing at `low`, the triangles a frame and how often
the world's shadow map was drawn while it played. It runs on any map's demo: the map is the
pack's, `DEMOVIEWER_E2E_PHONE_AT` opens another second of round 1 than 30, and
`DEMOVIEWER_E2E_PHONE_P` follows another player (1-based), for a demo whose enemy discs sit under
the Settings panel (cache.dem: `DEMOVIEWER_E2E_PHONE_P=2`). On 2026-10-24
against the local server every spec passed: `viewer.spec.ts` drew 170.0 fps at 2560×1440 with
outlines and names on.

Milestone 2b's spec is `effects.spec.ts`. It also needs a Nuke demo's id, in
`DEMOVIEWER_E2E_NUKE`.
- **molotov:** on each map, a molotov from a still free camera, 0.3, 2 and 6 s after it
  catches (`molotov-<map>-<s>.jpg`). The fire's two atlases must have been fetched; and the
  page, opened on the first round at its freeze end, before any shot, hit or grenade of it,
  must have fetched nothing under `/effects/` by then.
- **utility:** Nuke's first smoke, HE and flash from a free camera off each, 0.1, 0.5 and 3 s
  after it goes off (`<smoke|he|flash>-<s>.jpg`): CS2's smoke frames grey-white on Nuke, the
  fireball over its ring and its smoke rising, the flare. Each one's atlases (`smoke`;
  `explosion` and `smoke`; `flare`) must have been fetched, with no page error.
- **shots:** on Mirage, the first rifle, AWP and unsuppressed pistol shot that starts a burst,
  from 3 m off the shooter's side at the shot's tick (`shot-<rifle|awp|pistol>.jpg`), the
  first headshot 3 ticks after the hit (`shot-headshot.jpg`) and the rifle shot in POV
  (`shot-pov-rifle.jpg`, the flash at the first-person gun). `muzzle` and `blood` must have been
  fetched.
- **impacts:** on Mirage, the first spray of 6 or more rifle misses whose 5 holes land together
  on a wood wall, and the first on stone, in POV 0.1 s after (`impacts-spray-<kind>-pov.jpg`),
  2.5 m back from the holes 0.1 s and 3 s after and from the shooter's eye 3 s after; every one
  of the holes drawn then, and none 13 s after. The first wallbang kill whose bullet's line
  meets a hole, in POV and on its line from either side (`impacts-wallbang-*.jpg`). `decals`
  and `dust` must have been fetched.
- **smoke cover:** on Mirage, the match's longest burst of rifle misses fired into a smoke
  (each line within 1.5 m of the smoke's middle 5–15 m out), as its last shot leaves: in POV
  on the shooter (`smoke-cover-pov.jpg`, their own flash shown), from behind them and to one
  side (`smoke-cover-behind*.jpg`, the flash in front of the smoke) and from across the smoke
  looking back at them (`smoke-cover-across.jpg`, their flash hidden). For looking at beside
  the same shots of an earlier build.
- **doors:** Nuke's first swing, before, mid-swing and after (`door-*.jpg`). Seeking back to
  mid-swing must draw the same canvas bytes. Mirage's round 3 window, from the nearest player
  and then square on: 1 s before, the burst, and 1 s after (`window-*.jpg`). Every pack entity
  must find its node, `debris` and `dust` load only after the break, and no bullet's puff is
  drawn before it (`marks().puffs` 0), which would load the dust.
- **ground:** a Nuke kit and gun by a dead CT, the gun gone after its pickup and back on a
  seek (`ground-*.jpg`). At sample moments of both matches, the items drawn must be exactly
  those the keys lay down (`ground-counts.json`).
- **frame rate:** two views on Mirage at 2560×1440 and `high`, in POV on the view's player,
  each at 60 fps or more (`fps-<view>-pov.jpg`). One is the busiest round's moment and player
  with the most smokes and fires in view from their eyes; the other is the same over the whole
  match. Then 20 seeks
  over the five busiest rounds' moments, after which the renderer's memory counts must not grow.

On 2026-10-25, after milestone 2b's Tasks 4–6 and their final fix wave, the GPU cases ran
against the branch's release server with the local Mirage and Nuke demos: `effects.spec.ts`
(10), `baked.spec.ts` (11), `spectate.spec.ts` (6), `viewer`, `camera` and `phone`, 29 cases in
8.8 min.
- 28 passed. The one failure was `baked.spec.ts`'s bloom case at the flash: CS2's flare alone
  (Task 4) brightened the middle of the view only ×1.017 with the effects' bloom, under the
  case's ×1.02, where the generated glow gave ×1.073 on main (`2c199d8`). The flash now keeps
  the glow and draws the flare over it: `effects.spec.ts` and `baked.spec.ts` again, 20 passed
  in 7.8 min, the molotov ×1.182, the flash ×1.068 and the HE ×1.108; the busiest POV 139.6 fps
  and the best view 167.7, at 480/427/79 after 20 seeks.
- `viewer.spec.ts` drew 147.4 fps. The frame-rate views, in POV, drew 126–140 fps in round 24,
  which has 4 smokes and 2 fires burning at once, and 149–174 at the match's best view (two runs
  and the suite's).
- Memory held at 480 textures, 427 geometries and 79 programs after the first pass.
- `phone.spec.ts` on the Nuke demo needs `DEMOVIEWER_E2E_PHONE_AT=15`: at 30 and 45 s its radar
  step finds only 3 player discs on Nuke's radar.

Milestone 3's spec is `sound.spec.ts`. It opens round 1 of Mirage 2 s before the freeze ends,
with no audio context and nothing fetched under `/sounds/` until a click on the 3D view; then
Space plays it. 6 s on the sound must be unlocked with cues played, the banks decoded must
include `round` and a gun's, the page's requests under `/sounds/` must be the manifest and
exactly those banks (each carrying its hash from the manifest), and the counter (`data-bytes`)
must have grown by at least their bytes. Paused, `→` must play nothing and leave nothing
sounding. Then it plays round 1 from 10 s after its freeze in POV with the sound on, at 60 fps
or more at 2560×1440.

On 2026-10-26, at the end of milestone 3, the whole suite ran against the branch's release
server: Mirage with the `mirage-fp` pack, a Nuke demo, and `mirage_old.dem` for the upload. It
ran 38 cases in 11.1 min.
- 37 passed. The one failure was `effects.spec.ts`'s doors case: the `mirage-fp` pack
  (2026-10-22) predates `ENT1`, so it has no window break to find. With a pack made again from
  the same demo by the branch's `demoviewer-pack-cli` (2.62 MB), the case passed.
- `sound.spec.ts` drew 140.8–162.4 fps with the sound on (four runs), with 51 cues played in its
  first 6 s and none skipped. `viewer.spec.ts` drew 167.8 fps.
- The effects' frame-rate views drew 151.5 fps (the busiest) and 177.2 fps in POV.
- `perf.spec.ts`: the 3D view alone 178.6 fps, with the HUD 158.3 (+0.72 ms a frame), and 32.2
  under the 4× CPU slowdown.

On 2026-10-26, with the phone tier, against the branch's release server with the `mirage-fp`
pack:
- `phone.spec.ts` passed: the 3D view fetched `world_lo.glb`, `ct_lo.glb` and `t_lo.glb`, 11.02
  MB until it first drew and 11.50 MB 5 s on, and played at 217 fps at `low`. Against main's
  build it fails, as it should (`world_lo.glb` never requested).
- `quality.spec.ts`: 3 passed, with 289 textures, 378 geometries and 69 programs after every
  one of the ten cycles. The spec as it was, which read the counts as soon as the HUD showed the
  preset, failed: 246 textures after five cycles, then 310 while a world was swapping.
- `viewer.spec.ts` passed at 140.0 fps; `sound.spec.ts` passed, 51 cues played in its first
  6 s and 145.7 fps with the sound on.
