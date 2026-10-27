# tools/ — asset pipeline

Scripts that turn the local CS2 install into the gitignored `assets/` tree the
server serves: per map a low-fi textured world GLB (and its phone tier), a
collision hull, the radar image(s) and `overview.json`; one CT and one T player
model with animation clips; CS2's sounds packed into Opus banks; and the manifests the web app
trusts.

Nothing ripped from CS2 ever goes into git. `assets/` (including `assets/raw/`)
and every `node_modules/` are gitignored.

## Prerequisites

- **Source2Viewer-CLI 20.1.7467.** Download the linux-x64 CLI build from the
  ValveResourceFormat GitHub releases
  (<https://github.com/ValveResourceFormat/ValveResourceFormat/releases>), unpack it,
  `chmod +x` the `Source2Viewer-CLI` binary, and point `S2V_CLI` at it (the default
  is `$HOME/.local/opt/source2viewer-cli/Source2Viewer-CLI`). Pin 20.1.7467: the
  current assets were built with it (each manifest records its `vrf`); the figures below
  that name VRF 20.0 came from 20.0.6980.
  `lib/env.sh` refuses to run without an executable `S2V_CLI`.
- **CS2**, installed through Steam. Set `CS2_DIR` if it is not at the default
  (see Environment).
- **Node >= 22** (`package.json` engines; tested on 26).
- **ffmpeg with libopus** on `PATH` (`build-sounds.mjs` decodes CS2's sounds and encodes the
  banks with it).
- **rsync** on both ends, and **flock** from util-linux
  (`build-assets.sh` and `sync-assets.sh` take a lock with it).
- **SSH key access** to the sync target (`DEMOVIEWER_ASSETS_REMOTE`, see Syncing to a
  server) for `sync-assets.sh`.

Then, in order: `npm install` in `tools/` (below), `tools/build-assets.sh all`,
and `tools/sync-assets.sh --dry-run` before the real sync.

## Setup and tests

```sh
cd tools
npm install        # package-lock.json is committed; dependency versions are pinned
npm test           # vitest run
```

Tests that need Valve files are skipped, not failed, when `CS2_DIR` does not
resolve.

The formats the viewer reads are also tested from the web side: `web/test/tools-parity.test.ts`
runs these tools' writers and gates (probes.bin, light.json, the lightmap and COLOR_0 encodings,
overview.json and the radar formula, entities.glb's root rotations, hull surfaces, the player
clips) beside the viewer's readers (through `web/test/helpers/tools.ts`), so run `cd web && npx
vitest run test/tools-parity.test.ts` after changing one. A gate must pass only what the viewer
reads.

## Environment

Every input is overridable from the environment; the defaults are:

| Variable     | Default                                                                         | Used for |
|--------------|---------------------------------------------------------------------------------|----------|
| `CS2_DIR`    | `$HOME/.local/share/Steam/steamapps/common/Counter-Strike Global Offensive`     | `game/csgo/gameinfo.gi`, `game/csgo/pak01_dir.vpk`, `game/csgo/maps/<map>.vpk`, build id from `game/csgo/steam.inf` (`ClientVersion=`) |
| `S2V_CLI`    | `$HOME/.local/opt/source2viewer-cli/Source2Viewer-CLI`                          | VRF exports (`--version` prints `Version: 20.1...`) |
| `ASSETS_DIR` | `<repo>/assets`                                                                 | where everything is written |

Bash scripts source `lib/env.sh`, which exports `CS2_DIR`, `S2V_CLI`,
`ASSETS_DIR`, `REPO_DIR`, `ACTIVE_DUTY` (space-separated) and `CS2_BUILD`, and
defines `die "<msg>"` (message to stderr, exit 1). Sourcing it exits 1 with a
one-line message naming the variable when `$CS2_DIR/game/csgo/gameinfo.gi` or
`$S2V_CLI` is missing.

## Output layout

The server serves `/maps/{path}`, `/players/{path}`, `/weapons/{path}`,
`/viewmodels/{path}`, `/effects/{path}` and `/sounds/{path}` from the folders of those names
under `$DEMOVIEWER_ASSETS`, and nothing else from it. The web app finds a map through
`/maps/<map>/manifest.json` (a 404 means the map is not available), the players through
`/players/manifest.json`, the weapons through `/weapons/manifest.json`, the first-person arms
and clips through `/viewmodels/manifest.json`, the effect atlases through
`/effects/manifest.json` (fetched the first time an effect needs one) and the sound banks through
`/sounds/manifest.json` (fetched only after the page's first click or key press, and not while
muted).

The root `assets/manifest.json` is **not served**: it is the deploy inventory that
`sync-assets.sh` checks. A GET for `/manifest.json` falls through to the web
fallback, which answers `index.html` with HTTP 200, so a fetch of it gets HTML
rather than an error. If phase 3 needs a list of maps, it must add a server route
for it or have the root manifest also written under `maps/` (for example
`maps/index.json`).

```
assets/manifest.json
assets/maps/<map>/manifest.json world.glb [world_lo.glb] hull.glb [entities.glb] (each with a .glb.gz) [world_lo.json] radar.png [radar_lower.png] [sky.webp sky.json] [lightmap.webp] [probes.bin light.json (each with a .gz)] overview.json [hero.png]
assets/players/manifest.json ct.glb ct.glb.gz t.glb t.glb.gz [ct_lo.glb t_lo.glb (each with a .glb.gz) ct_lo.json t_lo.json]
assets/weapons/manifest.json <name>.glb <name>.glb.gz   46 models: one per normalised weapon name, and the defuse kit
assets/viewmodels/manifest.json arms_ct.glb arms_t.glb <name>.glb (each with a .glb.gz)   first person
assets/effects/manifest.json <key>.webp build.json   11 flipbook atlases (CS2's particle and decal textures)
assets/sounds/manifest.json manifest.json.gz <bank>.webm build.json   90 Opus banks (CS2's sounds)
assets/raw/<map>/...            intermediate VRF exports (never served); sky/ and lightmaps/ from rip-lighting.sh
assets/raw/players/...
assets/raw/weapons/...
assets/raw/viewmodels/...
assets/raw/effects/...
assets/raw/sounds/...
assets/build.log                build-assets.sh output (never synced)
```

Scripts write into `<target>.tmp-<pid>` (a directory, or a single file) and `mv` it into
place at the end, so a failure never leaves a half-written output in place of the real
one. That is the one temp name (`lib/stage.mjs` for the node scripts, `lib/rip.sh` for the
rips), the pid always last: `<target>` is what the files make up, such as `maps/<map>`,
`weapons/<name>` (one item of several a script builds) or `maps/<map>/hero.png`. A script
that fails, or is stopped by a signal it handles, removes its temp files. One that is
killed outright (SIGKILL, a forced stop), or `shrink-map.mjs` stopped by any signal
(it has no handler, so that Ctrl-C works during its minutes-long AO bake), leaves
`<target>.tmp-<pid>` behind, and a rip killed mid-swap can leave
`raw/<x>.old-<pid>/` (or `raw/<map>/<group>.old-<pid>/`, a `rip-lighting.sh` group).
`build-assets.sh` reclaims these when it next starts (`node tools/lib/stage.mjs sweep
<dir>`): anywhere under `ASSETS_DIR`, without following symlinks, it removes each leftover
whose pid is no longer running, and moves an `<x>.old-<pid>/` back to `<x>` when that is
missing; one whose pid is running belongs to a script started by hand and stays.
`sync-assets.sh` never sends `*.tmp-*`.

## Maps

Active Duty pool: `de_ancient de_anubis de_dust2 de_inferno de_mirage de_nuke
de_overpass de_train de_vertigo`. `de_nuke`, `de_train` and `de_vertigo` also
have a lower-level radar (`radar_lower.png`). The pipeline also builds `de_cache`
(added 2026-10-23 for a match a player brought); `all` is `MAPS` (`lib/maps.mjs`,
`lib/env.sh`): the pool and de_cache. Another map is one more name in both lists
and a `BUDGET_OVERRIDES` entry measured from its first build.

## Ripping a map

```sh
tools/rip-map.sh de_mirage            # ≈ 8 s for Mirage, ≈ 21 s for Nuke
tools/rip-map.sh de_mirage --force    # re-export over an existing rip
```

`rip-map.sh` runs Source2Viewer-CLI against the map VPK and `pak01_dir.vpk` and
writes `assets/raw/<map>/`:

| File                | From |
|---------------------|------|
| `world.glb`         | `maps/<map>/world.vwrld_c` (`--gltf_export_format glb --gltf_export_materials`) |
| `world_physics.glb` | written by the same export: entity physics only (props, `func_brush`, trigger, place and nav volumes); not used |
| `world_collision.glb` | `maps/<map>/world_physics.vmdl_c` from the map VPK (`--gltf_export_format glb`; VRF names it `world_physics_physics.glb`): the world's own collision mesh, input to `hull.glb` |
| `*.png`             | the textures `world.glb` references by relative URI; they must stay beside it |
| `radar.png`         | `panorama/images/overheadmaps/<map>_radar_psd.vtex_c` |
| `radar_lower.png`   | `<map>_lower_radar_psd.vtex_c`, only when `pak01_dir.vpk` lists it |
| `overview.txt`      | `resource/overviews/<map>.txt` (KeyValues, Source units) |
| `rip.log`           | full CLI output of every export |
| `rip.json`          | `{ map, cs2Build, vrfVersion, exportedAt }` |

`model-poses.sh <map>` adds `model-poses.json` to the folder: the pose each skinned prop of the
world is drawn in (see Shrinking a map). A re-rip replaces the folder but keeps what other
scripts exported into it, hard-linked into the new export before the swap (nothing copied, and a
failed swap puts the previous export back with them): this file, and `rip-lighting.sh`'s
`lightmaps/` and `sky/` (below). Each one's own check decides whether it is exported again:
`build-assets.sh` writes `model-poses.json` again before every shrink, and `rip-lighting.sh`
redoes a group from another CS2 build, or every group with `--force`.

VRF writes `maps/<map>/…` and `panorama/images/overheadmaps/…` under its output
folder; the script flattens those into the names above. It exits 0 only when
`world.glb`, `world_physics.glb`, `world_collision.glb`, `radar.png` and
`overview.txt` all exist and are non-empty. A map whose `rip.json` exists is skipped unless `--force` is given or
its `cs2Build` differs from the installed build (then it is re-exported, with a
`WARNING` line naming both builds). A rip from the installed build but another VRF
than `S2V_CLI` is skipped too, with a `NOTE` naming both versions and
`tools/rip-map.sh <map> --force`: `shrink-map.mjs` stops on a pose table from another VRF
than the rip, and `model-poses.sh` always uses the installed one. Both read the
version through `lib/vrf.mjs`, the rest of the CLI's `Version:` line (every rip does,
through `lib/rip.sh`). A forced re-rip replaces the old directory only once the new
export is complete. On failure the temp directory is removed and the CLI output is kept as
`assets/raw/<map>.rip-failed.log`. Mirage is ≈ 375 MB raw (`world.glb` 108 MB,
705 textures), Nuke ≈ 690 MB (`world.glb` 244 MB).

VRF 20.0 logs `Only VCS file versions 59 through 71 are supported … 72` for
many materials (CS2's shaders are newer); the export still succeeds and the
textures are written.

## Shrinking a map

```sh
node tools/shrink-map.mjs de_mirage   # ≈ 1 min for Mirage (≈ 3 min for Nuke)
node tools/check-map.mjs de_mirage    # budgets table; exit 0 only when every row holds
```

`shrink-map.mjs` reads `assets/raw/<map>/world.glb`, `world_collision.glb` and, for the
bake, `lightmaps/` and the entity lump, and writes these files into `assets/maps/<map>/`
(`entities.glb` only on a map with doors or breakable windows, the bake files only with a
bake), through `<out>.tmp-<pid>/` and one rename per file (`lib/install.mjs`), so the radar,
overview, sky and manifest files beside them are left alone and a failed run changes nothing.
Optional files the run did not write (`entities.glb` on a map that lost its doors, the bake
files of a map that lost its bake, or tier V's lightmap) are removed, and so is `world_hd.glb`
(with its `.gz`; `lib/maps.mjs` `MAP_RETIRED`), the 1024 px world nothing has loaded since the
viewer's HD toggle went (c34ff97), which took a quarter of the shrink time (490 s of 1,882 s
over the ten maps) and 1,002 MB on disk:

| File           | Made by |
|----------------|---------|
| `world.glb`    | drop editor-only meshes → skinned props into the pose the game draws them in (below) → without a bake, strip `NORMAL`, `TANGENT`, `TEXCOORD_1/2`, `COLOR_*` (unlit rendering never reads them, and they stop weld from merging vertices) → doors and breakables out (below) → `dedup → prune → flatten → join → weld → simplify(ratio 0.35, error 0.002, lockBorder)` → the light: CS2's bake (below; the strip is the bake's own, after the light is taken per source vertex) or AO, in `COLOR_0` (and `TEXCOORD_1`) → WebP 256 px q60 → `prune → meshopt(high)` |
| `entities.glb` | only on a map with doors or breakable windows: their nodes (and those of the props parented to them) as the world has them after its pose and tint (and, without a bake, its strip), one root node per entity (below), out of the world before its geometry and light stages → strip `_TEXCOORD_4` and skinless `JOINTS_0`/`WEIGHTS_0` → `dedup → prune → weld` (no join, no simplify) → the light in `COLOR_0` at their spawn pose: on a baked map the full-resolution probes' vertex light (plus the baked sun) at the map's range, as the world's primitives without a lightmap UV get it (they move, so no lightmap UV; the light is taken before the world's strip removes `NORMAL`); without a bake AO with the world (after its geometry stage, culled to what a ray can reach) occluding → WebP 256 px q60 → `prune → meshopt(high)`. A map without any has none |
| `lightmap.webp` | the bake only: CS2's irradiance (+ the sun on a baked-sun map), 1024 px, `sqrt(light / range)` in 8 bits a channel, lossless WebP (see Lightmaps); not under tier V |
| `probes.bin`   | the bake only: the light grid for players (see Light grid) |
| `light.json`   | the bake only: `{ version: 2, range, lightmap: { file, size } \| null, sun: { dir, color, intensity, baked } \| null, probes: { file } }` (version 2 since the lightmap is `sqrt(light / range)`; a bake always names its grid) |
| `hull.glb`     | `world_collision.glb` → the same drop rule (it removes the player, grenade and ladder clip groups and the `physics_sky` group) → materials, textures and UVs stripped → `prune → weld → meshopt`, no simplify |
| `*.gz`         | gzip -9 of each GLB, `probes.bin` and `light.json` (`lib/gz.mjs`), which the server sends to browsers that accept gzip: Mirage's world 10.3 → 7.0 MB, its hull 1.43 → 0.81 MB. `node tools/gzip-maps.mjs <map>... \| all` writes the GLBs' for maps shrunk before 2026-10-22 without shrinking again; `check-map.mjs` checks each inflates to its file |
| `shrink.json`  | `{ map, trisIn, trisKept, trisOut, hiddenDropped, tinted, posed, entities, droppedNodes, keptNodes, droppedPrimitives, aoSeconds, aoVertices, hullTrisIn, hullTris, hullDroppedNodes, hullKeptNodes, hullDroppedPrimitives, bytes: { world, hull, entities? }, gzBytes: { world, hull, entities? }, bake, [bakeSkipped], seconds, stages, params }`; `trisKept` is the world's triangles going into its geometry stage (after the drop, less the doors and breakables), `posed` is `{ <model>: nodes }` for the skinned props it posed (`{}` for none), `entities` is `{ count, nodes, trisIn, tris, light, bytes, gzBytes }` (roots, nodes moved, triangles when they left the world and after weld, `light` `"probes"` or `"ao"`, sizes) or `null` without doors or breakables, and `bytes`/`gzBytes` carry `entities` exactly when `entities.glb` was built; `bake` is null without a bake (`bakeSkipped` says why), else `{ tier, fallback, range, sun, lightmapSize, lightmapBytes, gridSize, gridStep, gridProbed, gridBytes, lightmappedPrimitives, vertexLitPrimitives, chartDemotions, source, vertexLight, firstLoadBytes, firstLoadCap }` |

Before that rule, `shrink-map.mjs` drops the entities a match starts with switched off
(`lib/entities.mjs`): `rip-entities.sh <map>... | all` (and `rip-map.sh`) decompile the map's
entity lump to `raw/<map>/entities/default_ents.vents`, and every node whose model and
position are those of an entity with `startdisabled` goes: game-mode props and blockers such
as Nuke's Wingman silo and roll-up doors (`[PR#]props.2v2`), which otherwise close doorways a
5v5 match plays through, and the retake blockers (Nuke 9 nodes, Mirage 17, Inferno 31, Vertigo
49, Overpass 25; Dust2, Train, Ancient and Anubis none). Then tints are baked
(`lib/tint.mjs`): a `csgo_complex` material with `F_TINT_MASK` tints only where its
`g_tTintMask` is set, but VRF exports the tint as `baseColorFactor` over the whole texture
(Nuke: 201 of 607 materials, its yellow doors black or solid orange, its hazard stripes flat
red), so the colour is multiplied by `mix(1, tint, mask)` in linear light and the factor reset.

Before the tints, skinned props are put into the pose the game draws them in (`lib/poses.mjs`
`poseSkinnedProps`). VRF's world export writes a skinned model's vertices in the bind space of
its skeleton and drops the skeleton (the primitives keep `JOINTS_0`/`WEIGHTS_0`, no node has a
skin), but the game never draws the bind pose: it draws the model posed by the animation its
entity plays, a `prop_dynamic`'s `startinganim` or `idleanim`, otherwise the model's default
sequence (a door's `ref`). For most props the two agree. Six models hold a turn in their bind
pose that the animation does not, and are moved: each vertex by its joints' skinning matrices in
that animation's first frame, blended by its weights, with `NORMAL` and `TANGENT`. For the
doors, the `.vmdl`'s own physics hull (in model space, bound to no bone) and the map's doorways
agree with the animated pose, not the bind pose; for the rest, the viewer and how close their
vertices come to the world around them do:

| Model | Where | Exported (bind pose) | Drawn |
|-------|-------|----------------------|-------|
| `props_downtown/metal_door_112` (`ref`) | Overpass, its one door | lying flat, its 2.83 m height along the floor | upright in its doorway (free span 54.0 in for a 55.3 in door) |
| `de_nuke/…/metal_door_001_br` (`ref`) | Nuke, the four doors | upright but a quarter turn out of the doorway, as if open | across the doorway: the double door fills its 120.1 in opening, the single doors their 59.4 and 60.1 in ones (60 in doors) |
| `de_vertigo/hvac_fanblade_spinning_01` (`spin`) | Overpass ×2, Vertigo ×9 | the blades edge-on, a quarter turn out of their housings | facing out of their housings (90 % of vertices within 5.5–7.2 cm of the world around them, against 15.8–21.6 cm) |
| `de_vertigo/construction_safetyribbon_01` (`sway`) | Overpass ×1 | two streamers sticking out level from the railing | hanging 1.83 m down from the railing |
| `gg_vietnam/cloth03` (`sway`) | Mirage ×1 | a quarter turn about the vertical, out of its doorway (median vertex 0.89 m from any surface) | hanging in its doorway (0.08 m) |
| `de_vertigo/constructioncrane01_load` (`idle`) | Vertigo ×1 | a quarter turn about the vertical from the first frame | as that frame has it (the animation turns it anyway; nothing near it to check against) |

The skinning matrices are in `raw/<map>/model-poses.json`, beside the rip. It is Valve-derived
data, so it is never in git. `model-poses.sh <map>... | all` writes it, using `lib/env.sh`'s CS2
install and Source2Viewer-CLI (seconds per map; about 17 s of CPU for all ten), and `build-assets.sh` runs it
between `rip-map.sh` and `shrink-map.mjs`. For every model the map's raw world draws skinned
without a skin, the table holds:
- the `.vmdl` its entities name;
- the animation they play (`startinganim`, else `idleanim`, else the model's first clip, its
  default sequence);
- `pose`: each used joint's matrix in that clip's first frame (the value of a `CUBICSPLINE` key,
  not its in-tangent). It is `null`:
  - where every matrix is within 0.01 of the identity (32 of the 39 entries over the ten maps,
    mostly junk props with one bone);
  - where no entity names the model (Vertigo's intro helicopter, which a `point_template` spawns
    and its `PER_MAP` entry drops);
  - or where the model has no animation.

A model it cannot work out gets an `error` in place of its pose, and the run carries on with
the other models and maps. The errors are two `.vmdl`s under one file name, entities that play
different animations, a clip the model lacks, a vertex weighed on a joint its skin lacks, a
failed or unreadable export, or an export without a skin or clips whose stderr shows an
exception (the CLI prints one for a file it fails on and still exits 0; it also writes
`exceptions.txt` into its working directory, so it runs in the run's temporary export folder).
An export error keeps the CLI's stderr less its stack frames (`at …`), so the exception's name
and message stay. The table also records the `cs2Build` and `vrfVersion` that exported the
models (the version through `lib/vrf.mjs`, as `rip-map.sh` reads it).

`shrink-map.mjs` reads the table and stops:
- when its `cs2Build` or `vrfVersion` is not the rip's (`rip.json`), naming the fix for
  whichever is older: `tools/rip-map.sh <map>` for another CS2 build (it re-exports a rip from
  another build by itself) or `tools/rip-map.sh <map> --force` for another VRF (it skips a rip
  from the installed build), then `tools/model-poses.sh <map>`;
- when its world, after the drop, draws a skinned model the table does not list, or one it
  records an `error` for. A map whose world no longer draws that model shrinks as usual.

Without the table, only a map with no skinned model shrinks.

Built 2026-10-24 with the poses: Nuke's `world.glb`, `world_hd.glb` and `hull.glb` are
byte-identical (its doors leave the world) and its `entities.glb` grew 100 B; Overpass's world
moved by −212 B (`entities.glb` +20 B), Mirage's by −80 B, Vertigo's by −580 B. A map without a
posed model builds byte-identical.

After the world's drop, pose, tint and lights (and, on a map without a bake, its strip), and
before its geometry and light stages, the doors and breakable windows leave the world for
`entities.glb`, so the viewer can swing and break them as the match did and the world's light is
baked without them (`lib/entities.mjs`): every entity of a class in
`MOVABLE_CLASSES` (`prop_door_rotating`, `func_door_rotating`, `func_door`, `func_breakable`)
with a model and an origin that does not start disabled (`movableEntities`), and its mesh nodes
by the hidden-entity rule (model name and position, `entityNodes`), together with the nodes of
every entity parented to it at any depth (`parentname` naming its `targetname`, the `[PR#]`
prefix ignored): Vertigo's porta-potty doors are `prop_dynamic` models on `func_door_rotating`
entities that own only a 4-triangle latch. A node two entities claim stops the build. They have
had the world's drop, pose and tint, and its strip (on a baked map they keep their attributes
until their probe light is taken, then lose what the world's strip removes; they move, so they
ship no lightmap UV); in `entities.glb` they also lose `_TEXCOORD_4` and
`JOINTS_0`/`WEIGHTS_0` without a skin, which nothing reads. The world keeps those: stripping
them there changes which primitives join and weld (Mirage: 184 fewer triangles out, two fewer
primitives, `world.glb` 107 KB smaller), so it would be a change to the world, not a free
saving. `entities.glb` holds one root node per entity in the default scene, named
by its `hammeruniqueid`, at its spawn transform: translation = origin as glTF `(y, z, x) ·
0.0254`, rotation = `anglesToGltfQuat(angles)` (`S·R·Sᵀ`, Source's `AngleMatrix` with its axes
renamed to glTF's), no scale, and `extras: { classname, origin: [x, y, z], angles: [pitch, yaw,
roll], model }` in Source units and degrees, which is what the viewer matches the demo's
entities by (their spawn position). The entity's nodes are its children, with local =
inverse(spawn) × their world matrix, so a scaled model keeps its scale on the child. Without a
bake, meshes the doors share stay shared (Nuke's four doors are one mesh, baked once); on a baked
map each door gets its own copy, since its vertex light is the probes' where it stands
(`lib/light.mjs` `applyVertexLight`, the same as the world's primitives without a lightmap UV, at
the map's range, with the baked sun; the viewer draws it with the world's vertex-light look).
The light is taken at the spawn pose and turns with the door. `check-map.mjs` holds each
map to its entity lump: no `entities.glb` without doors or breakables; otherwise ≤ 500 KB, one
root per entity with that name, transform and extras (`entityRootProblems`), `COLOR_0` on every
primitive (AO, or the probes' light) and a `.gz` that inflates to it.

Built 2026-10-24 (CS2 build 2000935, VRF 20.1.7467). The world change is against the previous
build from the same raw export for Cache, Mirage, Overpass and Vertigo, and against a build of the
current export without the split for Nuke and Inferno (re-ripped since their previous build); in
every case `trisKept` fell by exactly `entities.trisIn`. Ancient, Anubis, Dust2 and Train have no
doors or breakables and no `entities.glb`; Train rebuilt with the split in place came out
byte-identical, and two runs on Nuke give byte-identical `world.glb`, `world_hd.glb` and
`entities.glb`.

| Map | Doors and breakables | `entities.glb` (`.gz`) | Triangles | `world.glb` / `world_hd.glb` |
|-----|----------------------|------------------------|-----------|------------------------------|
| de_cache    | 1 door (`prop_door_rotating`)          | 27.6 KB (19.3 KB) | 818   | −14.6 / −14.6 KB |
| de_inferno  | 1 door (`prop_door_rotating`)          | 13.7 KB (8.6 KB)  | 1,024 | −8.8 / −28.2 KB  |
| de_mirage   | 1 window (`func_breakable`)            | 3.3 KB (1.3 KB)   | 2     | −2.1 / −2.1 KB   |
| de_nuke     | 4 doors (one shared mesh) + 2 windows  | 18.1 KB (8.9 KB)  | 2,292 | −12.3 / −17.2 KB |
| de_overpass | 1 door (`prop_door_rotating`)          | 9.8 KB (6.0 KB)   | 388   | −7.6 / −35.8 KB  |
| de_vertigo  | 2 doors (`func_door_rotating`, each a latch with the porta-potty door, a `prop_dynamic`, parented to it) | 16.8 KB (10.8 KB) | 280 | −1.3 / −1.3 KB |

Those are the AO builds. Built with the bake (after the merge with milestone 2a), Mirage's
`entities.glb` is 3.3 KB (1.3 KB) and Nuke's 21.3 KB (10.0 KB): lit by the probes, each of
Nuke's four doors has its own copy of their one mesh.

A mesh node is dropped when its name matches `lib/filters.mjs` `DROP_NODE`
(overlays, blocklight, sky groups, fog cards, blockers, clips), or a primitive is
removed when its material's `extras.vmat.Name` starts with `materials/tools/` or
`materials/dev/`, or its `ShaderName` is `csgo_black_unlit.vfx` or
`csgo_effects.vfx`; a node left with no primitives is dropped. The same rule runs
on the hull. The effects shader
is in the list because Mirage's large white planes are `effects/smoke/dust_002`
dust sheets: a translucent texture that renders as an opaque white plane without
Valve's shader.

`lib/filters.mjs` `PER_MAP` adds to the rule for one map only (`shouldDrop(nodeName,
vmatName, shaderName, map)`; `dropNode` is a node-name RegExp, `dropShaders` a list of
ShaderName values), on the world and the hull, and `shrink.json` records the entry as
`params.drop.perMap` (`null` for a map without one):

| Map | Entry | Why |
|-----|-------|-----|
| `de_ancient`, `de_anubis`, `de_inferno`, `de_nuke`, `de_train` | `dropShaders: ['csgo_water_fancy.vfx']` | VRF exports every material of Valve's water shader untextured and OPAQUE, so the water renders as a flat white plane: Anubis's sea and canal (`anubis_water_coast`/`_canal`, 21k m² of bounding boxes, the large white sheet beside the map in the first screenshot), Ancient's pool (1.6k m²), Nuke's `nuke_water` (469 m²), Train's chemical spill (83 m²), Inferno's fountain (56 m²). Textured water on other shaders (Nuke's river, Ancient's cascades) is kept. Dust2, Mirage, Overpass and Vertigo have no material of that shader. |
| `de_vertigo` | `dropNode: /^news_helicoptor_/` | the news helicopter from the map intro (7,467 triangles) hangs 130 m above the roof and 250 m to the side of the tower. |

The water shader is in `PER_MAP` rather than `DROP_SHADERS` because the plan keeps the
global rule fixed; every Active Duty map that has the shader has the entry, so moving
it into `DROP_SHADERS` (through the design doc) would change no output.

**The light.** A map in `lib/maps.mjs` `LIGHTMAP_MAPS` (all ten) whose `raw/<map>/lightmaps/`
holds a whole bake (`lightmapInputs`, with the probe atlas) and whose entity lump has probe
volumes ships CS2's own baked light: the H2 tier of the M2a spike (Task 1b), `lib/light.mjs`.

- Before anything is stripped: lightmap UVs that miss the charts go (`fitsCharts`), the sun is
  baked into the irradiance on a baked-sun map, and the 1024 px `lightmap.webp` and the light
  grid are made (see Lightmaps and Light grid). A dynamic sun (de_cache) stays out of the bake,
  and Train's sun has no brightness, so it adds nothing.
- A primitive with at least 2 lightmap texels (at 2048) per vertex keeps its lightmap UV, as
  `TEXCOORD_1`; H2's `prune` keeps attributes (it would drop `TEXCOORD_1`, which no material
  reads) and meshopt quantizes texcoords at 14 bits (12 is ±0.25 texel at 2048). After simplify
  every `TEXCOORD_1` is checked against the charts again (`fitsCharts`): a primitive whose UV
  left them is vertex-lit instead (`bake.chartDemotions`; 0 on Mirage and Nuke).
- Every other primitive gets its light per vertex in `COLOR_0`: `rgb = sqrt(min(light / range,
  1))` rounded to 6 bits (codes 0, 4, … 252, 255), which the viewer squares and multiplies by
  `light.json`'s `range`. The three channels are rounded together (`lightBytes`: of each
  channel's code below and above, the triple that keeps the hue best), since rounded alone they
  step apart and tinted Nuke's grey silo pink and violet in patches. The lightmap is the same
  encoding at 8 bits. With a lightmap UV, the light is the 2048 px baked light at that UV
  (coverage-weighted from 8192, padded 4 texels), bilinear. Without one, it is the probe volumes
  at full resolution (never the coarse grid; `lib/probes.mjs` `probeSampler`, which allocates
  nothing per sample), 10 cm off the surface along its normal: the
  ambient cube along the normal plus, on a baked-sun map, `sun · max(N·L, 0) · (1 − _dlshd r)`.
  The light is taken per source vertex and pooled per material in 5 mm cells; after weld and
  simplify each final vertex takes the mean of its cell, so chart seams average and the bake
  splits no vertices.
- `light.json`'s `sun.baked` says the sun is in the lightmap and the vertex light already, so the
  viewer adds it only to what moves; false on de_cache, which keeps the runtime sun.
- If the map's first load (`lib/maps.mjs` `firstLoadBytes`: `world.glb.gz`, the radars,
  `overview.json`, `sky.webp`, `lightmap.webp`, `probes.bin.gz`,
  `light.json.gz`) passes its cap (`lib/budgets.mjs`: the map's first load before M2a + 2.5 MB,
  or + 5.0 MB in place of the 2.5 on the maps in `FULL_LIGHTING_EXTRA`), the map tries
  `world.glb`'s textures at 192 px instead of 256, then tier V (no lightmap, every primitive
  vertex-lit) at 256 and at 192 px: the plan's budget rule drops the textures before the
  lightmap. Each tier's lit geometry is built once and only its textures tried again;
  `entities.glb` keeps its.
  `lib/light.mjs` `TIER_LADDER` is the order, walked as written (`ladderRuns`); past its last
  step `check-map.mjs` fails the map.
  `shrink.json` `bake.tier`, `bake.worldTextureSize` and `bake.fallback` (every try's first
  load) say what shipped.

A map outside `LIGHTMAP_MAPS` bakes AO as before and has no bake files. A map on it never
falls back to AO: when its bake is missing or half there (no entity lump, no whole lightmaps
export, no probe atlas, no probe volumes, or a baked sun without `bakedshadowindex`),
`shrink-map.mjs` exits 1 before it reads the world, naming why. `rip-lighting.sh` fails such a
map's export, and `check-map.mjs` fails it without `light.json`, so a CS2 or VRF update that
drops or renames a lightmap texture stops the build instead of unbaking the map. Taking a map
off `LIGHTMAP_MAPS` is the one way to build it with AO; there is no flag for it.

AO (`lib/ao.mjs`): every triangle of every mesh node goes into one world-space
BVH; each vertex casts 16 cosine-weighted hemisphere rays (fixed Fibonacci
pattern) from 2 cm along its area-weighted face normal, a hit at d < 6 m occludes
by `1 − d/6`, and the stored grey is `0.25 + 0.75·ao` as normalized `u8` RGBA
(so every value is in 64–255). Any `COLOR_0` VRF exported is replaced. For `entities.glb` the
world occludes too (`bakeAo(doc, { occluders })`), but only the world's triangles whose bounds
come within `maxDist` + 2 cm of the entities' vertices go into the BVH, which changes no hit
(Inferno: its door against 39,774 of the world's 3.5 M triangles, 0.4 s instead of 2.1 s, the
same bytes).

Output is byte-identical across runs on the same raw export, `entities.glb` included (the AO's
ray pattern is fixed; the light bake, gltf-transform, sharp and meshopt are deterministic); only
the timings in `shrink.json` change (checked by SHA-256 of every output, twice on Mirage and Nuke,
2026-10-24).

With the bake and the doors (CS2 build 2000935, 2026-10-24, after the merge with milestone 2b;
the first load counts `entities.glb.gz`):

| Map | Tier | `world.glb.gz` | `entities.glb.gz` | `lightmap.webp` | `probes.bin.gz` | First load / cap | Triangles | Primitives (lightmap / vertex) | Shrink |
|-----|------|----------------|-------------------|-----------------|-----------------|------------------|-----------|--------------------------------|--------|
| `de_mirage` | H2 | 7,006,211 B | 1,328 B | 1,042,668 B | 135,570 B | 8,329,211 B / 8,953,417 B | 552,195 | 133 / 220 | 57 s (95 s before the bake, 68 s of it AO) |
| `de_nuke` | H2 | 12,947,745 B | 10,023 B | 856,630 B | 261,932 B | 14,270,085 B / 14,744,987 B | 1,512,738 | 148 / 421 | 169 s (329 s before the bake, 232 s of it AO) |

Against the bake before the merge, the doors and windows leaving the world took 854 B off
Mirage's `world.glb.gz` and 5,500 B off Nuke's, and `entities.glb.gz` added 1,328 B and 10,023 B:
the first load grew by 474 B and 4,523 B, leaving 0.66 MB and 0.55 MB under the caps. Two runs
on each map gave byte-identical outputs, and Vertigo (no bake export) builds byte-identical to
milestone 2b's `world.glb`, `world_hd.glb`, `hull.glb` and `entities.glb`.
The light grid's side term (`probes.bin` version 2) then added 33,684 B to Mirage's first load
and 71,255 B to Nuke's, leaving 0.62 MB and 0.47 MB under the caps; every other output stayed
byte-identical. All ten maps were then built with their bake (Task 11, 2026-10-25): see Active
Duty results; Mirage's and Nuke's files came out the same to the byte.

Mirage (CS2 build 2000934, VRF 20.0): 1,294,008 triangles in, 346 nodes dropped
(3,178 kept), 685,376 triangles out; AO 1,046,246 vertices in ≈ 107 s; `world.glb`
18.6 MB (353 WebP textures, 2.9 MB of them), `world_hd.glb` 34.0 MB, `hull.glb`
1.43 MB (133,133 triangles in, the player, grenade and ladder clip groups and
`physics_sky` dropped, 123,561 out); ≈ 120 s wall in all, ≈ 235 fps in `spike/viewer.html`.

The hull is not built from `world_physics.glb`: as VRF writes it from
`world.vwrld_c` that file holds only entity physics (props, `func_brush`, buy and
bomb zones, `env_cs_place` and nav volumes; 174 nodes, 8,002 triangles on Mirage,
173 of 174 materials under `materials/tools/`), which would draw the place volumes over whole areas of
the map. The world's own collision is `maps/<map>/world_physics.vmdl_c` in the
map VPK, which `rip-map.sh` exports as `world_collision.glb` (Mirage: 41 groups by
surface property, 14.4 MB raw). Its `physics_sky` group is the skybox shell
(Mirage: 76 triangles, a 17.5k m² ceiling facing down at 24 m plus 3.4k m² of
walls; Nuke: a 21.5k m² sheet facing up at −12.8..−8.1 m). The render export
holds no sky brushes at all, and the collision groups carry no material, so
`DROP_NODE` matches a trailing `_sky` to drop it by name.

`check-map.mjs <map> [--budget-override]` checks `assets/maps/<map>/` against the
budgets in `lib/budgets.mjs` (sizes in decimal MB): `world.glb` ≤ 20 MB with
400 k–800 k triangles and every primitive lit (with a bake, by `TEXCOORD_1` or `COLOR_0`, and
`TEXCOORD_1` only when `light.json` names a lightmap; without, `COLOR_0`),
`hull.glb` ≤ 2 MB, `entities.glb` ≤ 500 KB on every map that has one (with the entity
rows above; never overridden), no failing material (`lib/gltf.mjs` `listMaterialsFailing`,
with the map's `PER_MAP` shaders) in any of the GLBs, and `shrink.json` `seconds`
≤ 600. Those are the plan's Mirage acceptance (`BUDGET`). With a bake (`lib/light.mjs`
`lightChecks`): `light.json` valid (`lightJsonProblem`: only what the viewer's
`parseLightInfo` reads, so a sun with a direction and a brightness of 0 or more, and the light
grid named), `lightmap.webp` ≤ 2 MB and of the size `light.json` says
(none under tier V), `probes.bin` decoding to as many cells as its header says with
`light.json`'s range (the row names its version), `probes.bin.gz` and `light.json.gz` inflating
to their files, and `probes.bin.gz` ≤ 0.4 MB (D7; Vertigo's override 0.45 MB: its grid spans the
392 m tower, 57×157×76 cells of which 17,467 lie over a floor); bake files without `light.json`
fail, and so does a map in `LIGHTMAP_MAPS` without `light.json` (any other map built without a
bake has a SKIP row there). Every map's first load (`lib/maps.mjs` `firstLoadBytes`:
`world.glb`, `entities.glb`, the radars, `overview.json`, `sky.webp` and the bake, each as
its `.gz` where it has one) is held to its own cap: its first load before M2a + 2.5 MB
(`lib/budgets.mjs` `FIRST_LOAD_BEFORE_M2A`, measured in the main checkout's assets built from
228e0e4, before M2b too; an entry in `BUDGET_OVERRIDES` for every map but Mirage); on Anubis,
Dust2, Inferno and Overpass + 5.0 MB in place of the 2.5 (`FULL_LIGHTING_EXTRA`: the user chose
full lighting there, 2026-10-25).
`entities.glb` counts against the same allowance, since the release that ships the bake ships it
too, and the world it leaves is that much smaller. With `--budget-override`,
a map's `BUDGET_OVERRIDES` entry replaces the budgets it names, marked `(override)`
in the table: the eight maps other than Mirage miss the Mirage budgets with the
fixed pipeline, and stronger simplification either still misses them or shreds the
foliage (see Active Duty results), so each has per-map ceilings that mirror the
design doc's Active Duty ladder and change only with it. Mirage has no entry and is
held to `BUDGET` with or without the flag; `build-assets.sh` passes the flag. The
radar rows are required as well: `overview.json` must be a
valid `Overview` for the map whose sections include `default`, and `lower`
exactly when the map is in `LOWER_RADAR`; the image of every section must be a
1024×1024 PNG; and any `radar*.png` that no section names fails as dangling.

To look at the result, serve `world.glb` next to `spike/viewer.html` and open
`viewer.html?f=world.glb&unlit=1&ao=1` (`ao=1` turns on the vertex colours of the
unlit material), or for a baked map
`viewer.html?f=world.glb&lm=lightmap.webp&lmsqrt=<range>&vc=<range>` (the lightmap on
`TEXCOORD_1` and the vertex light on the rest, both squared and multiplied by `range` from
`light.json`; `rgbm=<range>` reads the RGBM lightmaps built before Task 4's fix round).

## Radar and overview

```sh
node tools/radar.mjs de_nuke   # well under a second
```

`radar.mjs` reads `assets/raw/<map>/overview.txt`, `radar.png` and (when ripped)
`radar_lower.png`, and writes into `assets/maps/<map>/`:

| File              | Made by |
|-------------------|---------|
| `radar.png`       | the raw radar re-encoded with sharp: PNG `compressionLevel 9` plus `adaptiveFiltering` (lossless, alpha kept), exactly 1024×1024; a square radar of another size is resized to 1024, a non-square one is an error |
| `radar_lower.png` | the same, only for a map whose overview declares a `lower` section (and `radar_<name>.png` for any other section name) |
| `overview.json`   | `lib/overview.mjs` `overviewFromKv`: `{ map, posX, posY, scale, size: 1024, sections: [{ name, image, altitudeMin, altitudeMax }], ctSpawn, tSpawn, bombA, bombB, inset }`, Source units; `sections` is `[default]` with altitudes ±10000 when the file has no `verticalsections` |

Sections and images must match both ways: a section whose raw image is missing,
or a raw `radar*.png` with no section, exits 2 with one line naming the file and
writes nothing. Files are written into `<out>.tmp-<pid>/` and renamed into
`<out>`, images first and `overview.json` last; a `radar*.png` in `<out>` that
no section names (left by an earlier run) is then removed, and every other file
there is left alone. Output is byte-identical across runs. Exit 1 is a usage
error or any other failure (missing `overview.txt`, unreadable KeyValues, a
non-square image).

Mirage (CS2 build 2000934): `posX -3230, posY 1713, scale 5`, one section,
`radar.png` 135.9 kB (raw 143.7 kB; `compressionLevel 9` alone gave 146.9 kB).
Nuke: `posX -3453, posY 2887, scale 7`, sections `default` (−495..10000) and
`lower` (−10000..−495), `radar.png` 92.5 kB, `radar_lower.png` 92.4 kB (raw 97.0
and 96.5 kB). Train and Vertigo also name their second section `lower`.

## Sky

```sh
tools/rip-lighting.sh de_cache   # a few seconds; skips a map already exported from this CS2 build
node tools/sky.mjs de_cache      # 1–4 s
```

The viewer draws each map's own sky behind it (`sky.webp`). `rip-lighting.sh <map>
[--force]` exports it into `assets/raw/<map>/sky/` (and the baked light into `lightmaps/`,
see Lightmaps): it
reads which sky CS2 draws from the decompiled entities, `lib/entities.mjs` `skyOf`, the
material (`skyname`) and yaw (`angles[1]`) of the first `env_sky` that does not start
disabled. Ancient, Anubis and Vertigo's own `env_sky` starts disabled (it only lights the
bake); only for such a map does it decompile the entity lump of the 3D skybox prefab its
`skybox_reference` loads (`skyboxMapOf`, e.g. `maps/prefabs/de_ancient/de_ancient_skybox.vpk`)
and take that prefab's `env_sky`, the sky drawn there. A map with a sky of its own never
needs the prefab's VPK. The material is taken from the map's VPK when it is there, else from
`pak01_dir.vpk` (all ten today, Cache's `materials/de_cache/sky/` included), with its
texture: `sky.json` `{ map, material, yaw, from, vpk, cs2Build, vrfVersion, exportedAt }`,
`sky.vmat`, `sky.exr`, `rip.log`, and `skybox_ents.vents` when the prefab was read. It follows `rip-map.sh`'s rules: a
group from the installed CS2 build is skipped unless `--force`, one from another build is
re-exported, and so, unlike a rip, is one from another VRF than `S2V_CLI`'s (`rip-map.sh`
carries the groups across a re-rip, so a VRF update reaches them only here), and a group is written into `sky.tmp-<pid>/` and renamed into place whole (a
failure keeps the CLI output as `sky.rip-failed.log`). A re-rip with `rip-map.sh` replaces
`raw/<map>/` but carries `sky/` and `lightmaps/` into it; `build-assets.sh` runs
`rip-lighting.sh` right after, which exports them again by the rules above.

The textures are BC6H cubes, 256² to 2048² a face, which VRF writes as one 2:1 lat-long EXR
(1024×512 to 8192×4096, linear, no fixed scale). `sky.mjs <map>... | all` makes
`assets/maps/<map>/sky.webp`, 2048×1024, WebP q75, sRGB:

- **Turn.** Column u of VRF's lat-long looks along Source azimuth −360°·u, and the env_sky's
  yaw adds to it: that way the sun in the skies of Overpass (a disc) and Cache sits 6° from
  each map's `light_environment` sun, Inferno's horizon glow 0.4° and Ancient's lighting
  sky 12°, where a mirror or a quarter turn misses by 50° or more. three.js's equirect
  lookup in the viewer's glTF space (Source x, y, z = glTF z, x, y) is then the same image
  rolled by (yaw − 270°) of its width (`skyShift`), with no mirror; in the viewer, Overpass's
  sun disc lands within 0.1° of where that puts it.
- **Exposure.** CS2 meters each frame (auto exposure), so the sky's authored brightness
  says little about how it reads (as authored, Cache's ×4 is white and Anubis's ×1.45 clips
  to cyan, where CS2's screenshots show grey cloud and deep blue). The median luminance of
  the pixels above the horizon is exposed to `SKY_MEDIAN` 0.43, Mirage's own (Mirage keeps
  ×0.99), then clamped at 1. Against the 1080p map screenshots in pak01 that reads right on
  every map; a 95th or 99th percentile left Anubis and Vertigo dark, and a median weighted
  by solid angle brightened every map against Mirage, Train and Cache most.
- **Below the horizon.** The textures hold whatever their authors put there (Mirage's sand,
  Cache's dark sea, a mirrored sky on Nuke and Train, a white glare on Anubis, Inferno and
  Vertigo): CS2 never shows it, as the 3D skybox (not exported) covers it, but the viewer's
  overview looks straight into it. It is replaced by the sky's horizon colour, the mean of the
  3° just above the horizon (`HORIZON_BAND_DEG`), which also fades in over the 3° above it
  (`BLEND_DEG`, smoothstep) so there is no line. The viewer gives its fog the same colour.
- **Size.** Larger skies are averaged down by a whole factor in linear light, the 1024-wide
  ones (Nuke) scaled up after encoding (Lanczos 3).

Beside `sky.webp` it writes `sky.json` `{ map, material, yaw, from, exposure, horizon }`
(`horizon` an sRGB `#rrggbb`), which `manifest.mjs` requires with `sky.webp` and copies into
the map's manifest as `sky: { horizon }`. A map with no enabled `env_sky` gets neither (ones
left over are removed): `sky.webp` is optional in the manifest, and the viewer keeps its
colour sky. `check-map.mjs` holds a `sky.webp` to 2048×1024 WebP and ≤ 1 MB. Output is
byte-identical across runs.

CS2 build 2000935, VRF 20.1 (`node tools/sky.mjs all`, 17 s for the ten):

| Map | Material (`materials/…vmat`) | `env_sky` of | Yaw | Lat-long | Exposure | Horizon | `sky.webp` |
|-----|------------------------------|--------------|-----|----------|----------|---------|------------|
| `de_ancient` | `skybox/sky_hr_aztec_02_v1` | the 3D skybox | 70° | 8192×4096 | ×1.13 | `#bfe2f1` | 16,464 B |
| `de_anubis` | `skybox/sky_de_annubis` | the 3D skybox | 270° | 2048×1024 | ×1.03 | `#ffffff` | 7,524 B |
| `de_cache` | `de_cache/sky/de_cache_sky_001` | the map | 116° | 4096×2048 | ×2.30 | `#b1b3ae` | 30,960 B |
| `de_dust2` | `skybox/sky_de_dust2` | the map | 0° | 2048×1024 | ×1.44 | `#e6ddc6` | 9,988 B |
| `de_inferno` | `skybox/test/s2_de_inferno_sky01` | the map | 245° | 4096×2048 | ×0.95 | `#fdffff` | 12,834 B |
| `de_mirage` | `skybox/sky_de_mirage` | the map | 0° | 2048×1024 | ×0.99 | `#fef7e7` | 6,830 B |
| `de_nuke` | `skybox/sky_de_nuke` | the map | 0° | 1024×512 | ×1.30 | `#f4ffff` | 8,062 B |
| `de_overpass` | `skybox/sky_de_overpass_01` | the map | 125° | 4096×2048 | ×2.90 | `#b9e2f7` | 10,156 B |
| `de_train` | `skybox/sky_overcast_01` | the map | 47.3° | 4096×2048 | ×0.82 | `#748499` | 19,268 B |
| `de_vertigo` | `skybox/sky_de_vertigo` | the 3D skybox | 247.5° | 2048×1024 | ×1.42 | `#fcffff` | 8,500 B |

## Lightmaps

```sh
tools/rip-lighting.sh de_mirage   # ~30 s for lightmaps/; skips a group already exported from this CS2 build and VRF
```

`rip-lighting.sh` also exports CS2's baked light, `maps/<map>/lightmaps/` in the map's VPK,
into `assets/raw/<map>/lightmaps/`, by the same rules as `sky/` (a group of its own: skipped
or exported independently of `sky/`):

- `irradiance.exr`: the lightmap, 8192², float32 channels A, B, G, R (A = 1), ZIP, ~300 MB.
  It holds bounce and sky light but **not the sun's direct light**.
- `direct_light_shadows.png`: the sun's shadow, 1 = shadowed, in channel `bakedshadowindex`.
  Only on a map whose sun is baked (`light_environment` `directlight "1"`; de_cache's is
  `"3"`, dynamic, so the engine draws it and its lightmap stays irradiance only).
- `env_light_probe_volume_atlas_z<nnn>.exr` (6 faces × D slices) and
  `env_light_probe_volume_atlas_dlshd_z<nnn>.png` (D): the light probes and their baked
  shadows, one file per z slice.
- `debug_chart_color.png`: one flat colour per lightmap chart (4096²), to tell a lightmap UV
  from a material UV.
- `lightmaps.json` `{ map, sunBaked, textures, atlasSlices, dlshdSlices, cs2Build, vrfVersion,
  exportedAt }` (`textures`: those exported) and `rip.log`.

A map in `lib/maps.mjs` `LIGHTMAP_MAPS` (every map the pipeline builds) must ship the bake:
when its VPK lacks any of these textures (`direct_light_shadows` only where the sun is baked),
the group fails before anything is exported, naming them, and the map's last export stays (a
`rip-map.sh` re-rip before it carries `lightmaps/` across).
For a map off that list, a VPK without `irradiance` has no baked light: the group then holds
only `lightmaps.json`, with `textures: []`, and the rip succeeds; another texture the VPK lacks
is left out of `textures` with a warning. `lib/lightmap.mjs` `lightmapInputs(dir)` is null,
which means no bake (the map builds as it did before), for a map never ripped and for any
half-set: no `irradiance`, no `debug_chart_color`, or a baked sun without
`direct_light_shadows`. Only a dynamic sun (de_cache) gives `shadow: null`; a missing probe
atlas gives `probes: false`. A texture the VPK lists that does not export, or a probe atlas
that is not 6 z slices (one per cube face) per `_dlshd` slice, fails the group. So does a
listing that does not show a file the VPK always holds (the map's entity lump; for the sky,
pak01's overview of the map): a failed listing is never taken for a missing file.

`lib/entities.mjs` `sunOf(entities)` reads the sun: the direction towards it in glTF axes,
its `color` in linear light, `brightness` as `intensity` (Lambert, no π), `baked`, and the
shadow channel. `intensity` is `brightness · brightnessscale` (the scale is 1.0 on all ten maps).
Train's sun has brightness 0 (an overcast sky).

`lib/lightmap.mjs` turns these into the lightmap the viewer ships (`shrink-map.mjs`, see
Shrinking a map; `LIGHTMAP_PARAMS`: 1024 px, 4 dilation passes, 8 bits): `readHdr` (RGB, row 0 at v = 0) → `bakeSun` on a baked-sun map
(adds `sun · intensity · max(N·L, 0) · (1 − shadow)` with N·L interpolated from the raw
`NORMAL` in lightmap space) → `coverage` of the lightmap UVs (`TEXCOORD_2` when a primitive
has one, else `TEXCOORD_1`; all-zero is unlit; `fitsCharts` catches a material UV, and
`dropLightmapUv` takes it off; a triangle no texel centre falls in covers, as `COVERED.footprint`,
the texels a bilinear lookup reads along its longest edge, because CS2 gives small and thin faces
a point or line chart: 36 % of Mirage's lightmap-UV triangles and 57 % of Nuke's have no area in
the atlas) → `downscale` by 8, averaging covered texels only, and footprint texels only in a
block no chart triangle covers, so they never shift a chart's own light (`bakeSun` likewise
draws them first, so a chart's triangles set the N·L of their own texels) →
`chooseRange` (the power of two from 2 to 64 at the covered texels' p99.9, before padding) →
`dilate` → `encodeLightmap` (`lightBytes` at 8 bits: `sqrt(min(light / range, 1))` per
channel, rounded jointly so the hue holds; light above the range is scaled down to it whole, +∞
is the range, NaN 0) → `lightmapWebp` (lossless RGB WebP; the viewer squares each channel and
multiplies by `range`).

The lightmap was RGBM in lossy WebP until Task 4's fix round (`light = rgb · a · range`,
q60). WebP's lossy mode stores colour at half resolution (4:2:0), and RGBM's multiplier changes
from texel to texel, so the colour of neighbouring texels mixed: pink, violet and green patches
on grey walls (Nuke's lobby beside the ladder, the black of its hazard rail turned blue, a green
face on Mirage's palace pillar). The hue was off by about a stop at the p99 texel on both maps,
at any quality (q60, q90, q100, `smartSubsample` alike), and lossless RGBM is 2.1 MB a map. The
measurements, against the float lightmap, over covered texels:

| Encoding | Mirage bytes | Nuke bytes | Hue error p99 (stops), Mirage / Nuke | Light error p99 |
|---|---|---|---|---|
| RGBM, lossy q60 (shipped before) | 686,170 | 634,262 | 1.23 / 1.01 | 0.19 / 0.22 |
| RGBM, lossy q90 | 927,634 | 901,034 | 1.16 / 0.99 | 0.13 / 0.16 |
| RGBM, lossless | 2,181,414 | 2,146,402 | 0.02 / 0.01 | 0.00 / 0.01 |
| RGBM, multiplier per 4×4 block, q60 | 419,156 | 409,798 | 10.5 / 9.8 | 1.21 / 1.70 |
| sqrt, lossy q90 | 341,564 | 258,962 | 1.81 / 1.50 | 0.52 / 0.91 |
| **sqrt, lossless, jointly rounded (shipped)** | **1,042,668** | **856,630** | **0.07 / 0.09** | **0.07 / 0.11** |

A lighter mottle that remains on walls in the viewer is web's detail texture (`detail.ts`), not
the lightmap: it goes with the detail turned off. A primitive without `NORMAL` gets the sun by its face normal. On CS2 build 2000935 (36–42 s and at most 2.3 GB of memory a map; Mirage's crate
`dust_shipping_crate_02_wood_color_1` fails the chart test):

| Map | `lightmaps/` | Covered at 8192 / 1024 | Range | `lightmap.webp` (lossless) |
|-----|--------------|------------------------|---------------|---------------|
| `de_mirage` | 347 MB | 72.2 % / 96.0 % | 8 | 1,042,668 B |
| `de_nuke` | 399 MB | 88.6 % / 98.8 % | 16 | 856,630 B |

## Light grid

`lib/probes.mjs` turns CS2's light probe volumes into `probes.bin`, a coarse grid the viewer
lights players with (`shrink-map.mjs` writes it, over the hull's bounds and sampled above the
hull's walkable floors), and `vertexLight` gives a surface its light from that grid. The shipped
geometry is lit from the full-resolution volumes instead (`probeSampler`, see
Shrinking a map). Its inputs are each `env_combined_light_probe_volume`
and `env_light_probe_volume` entity, plus the probe atlas in `raw/<map>/lightmaps/`:

- `probeVolumes(entities)` reads the volumes.
  - The box is `box_mins`..`box_maxs` in the entity's own frame: its `origin`, turned by its
    `angles` (Source's AngleMatrix: pitch, then yaw, then roll).
  - `light_probe_size_*` probes fill the box like texel centres: probe i sits at
    `mins + (i + 0.5)·(maxs − mins)/size`. `voxel_size` is not the spacing.
  - `priority` is `indoor_outdoor_level`.
- `readProbeAtlas(dir, volumes)` reads the atlas.
  - Face f of a volume's probes is the slice block `light_probe_atlas_z + f·D`. Atlas y 0 is
    the top row of both the EXR and the PNG slices.
  - The faces are in the order +x +y +z −x −y −z, in Source world axes, even for a rotated
    volume. `cube()` returns them as glTF +X −X +Y −Y +Z −Z.
  - The faces hold no sun. `_dlshd` r is the sun's shadow (1 = shadowed), so `sun()` is `1 − r`.
  - It keeps the atlas in half precision (`Float16Array`, Node 24+; float32 on older Node).
    Nuke's read peaks at 0.35 GB of memory, down from 0.49 GB, and Cache's atlas would be
    0.85 GB rather than 1.7 GB.
- `buildLightGrid(volumes, atlas, bounds, step, floors)` builds the grid.
  - Cells are `GRID_STEP` = 2.5 m apart, over the union of the volumes' boxes clipped to
    `bounds` (the hull's), never the world's.
  - Only cells up to `GRID_BAND` = 2.5 m above a walkable triangle are sampled at their centre.
    Those are triangles of the hull whose normal points up (y ≥ 0.7), from
    `walkableTriangles(hull)`.
  - A sampled cell takes the volume containing its centre with the highest priority, then the
    smallest box, trilinear between its probes.
  - Per cell it keeps CS2's cube as three terms, RGB each: `up` = +Y, `down` = −Y and
    `side` = mean(±X, ±Z), and the sun's visibility.
  - Then the cells around the players are refitted (see below). Every other cell copies the
    nearest sampled or refitted cell, so trilinear filtering anywhere in the grid reads real
    light.
- `vertexLight(grid, p, n, sun)` gives the light at a surface with unit normal n:
  `up·max(n.y, 0)² + down·max(−n.y, 0)² + side·(1 − n.y²) + vis·max(0, n·sun.dir)·sun.color·sun.intensity`,
  trilinear and clamped into the grid. The viewer shades players the same way. Pass
  `sun = null` where something else adds the sun.
- `probeSampler(volumes, atlas, offset)` gives geometry its light from the volumes at full
  resolution, not the grid (`shrink-map.mjs`, for primitives without a lightmap UV):
  `(p, n, sun, out) => out`, read `offset` m off the surface along `n`, from the volume the grid
  would take or, outside every volume, the nearest one clamped; the ambient cube along `n`
  (Σ n_axis² · face) plus the sun as above. A sample allocates nothing.

**The refit at volume borders.** Read trilinearly, a point mixes 8 cells, and near a volume's
border some of them sit in the other volume. An indoor player beside an outdoor volume then
reads outdoor light: on Nuke, 178 of the 182 points more than a stop off had that cause. The
refit fixes the cells around the players instead of their centres:

- Points are spread 1.5 m apart over every walkable triangle (at least one each), 0.5, 1 and
  1.5 m above it. Each point's own light is that of the volume the point is in.
- The cells are solved by least squares so the grid, read the way the viewer reads it, matches
  those points. Each cell is also pulled towards its centre sample.
- Up, down and side are each weighted for their own error in stops. That takes 3 reweighted
  rounds, so a point read too dark counts as much as one read too bright. The sun is
  unweighted.

Neither of the two simpler fixes tried helped `up`:

- A higher-priority volume claiming cells up to half a step outside its box. Nuke's >1-stop
  points went from 182 to 215. Within a whole step they went to 343: outdoor points beside
  indoor volumes went dark.
- The mean of 2³ sub-points per cell, each in its own volume. Nuke went to 209.

How the rules were found (CS2 build 2000935):

- **Rotated volumes.** Nuke has one (yaw 270), and 8 of the 10 maps have some. Each hypothesis
  was scored on that volume by the median |log2(face along the normal / lightmap irradiance)|
  of lightmapped surfaces facing an axis:

  | Hypothesis | Median (stops) |
  |---|---|
  | Positions turned by the angle matrix | 0.127 |
  | Positions turned the other way | 0.400 |
  | Positions not turned | 0.255 |
  | Faces in world axes (walls only) | 0.147 |
  | Faces in the volume's axes, a quarter turn (walls only) | 0.170 |
  | Faces a half turn (walls only) | 0.292 |
  | Faces three quarters of a turn (walls only) | 0.344 |

  The grid keeps only up, down and the mean of the four sides, and a yaw leaves those alone. So
  for the grid the face frame matters only for a volume with pitch or roll. Ancient has 1 such
  volume, Cache 4, Overpass 1 and Train 2, and none is measured. `cube()` callers that read the
  side faces one by one depend on it for yaw too.
- **Priority.** Where overlapping volumes split between the highest `indoor_outdoor_level` and
  the smallest box, the level's probe matches the lightmap better:

  | Map | Points | Level (stops) | Smallest (stops) |
  |---|---|---|---|
  | Nuke | 2,449 | 0.205 | 0.264 |
  | Mirage | 371 | 0.113 | 0.125 |

### `probes.bin`

All values are little-endian. `web/src/scene/probes.ts` mirrors this layout.

| Offset | Type | Field |
|-------:|------|-------|
| 0 | 4 × u8 | magic `DVLG` |
| 4 | u16 | version, 2 |
| 6 | u16 | 0 |
| 8 | 3 × f32 | `origin`: cell (0, 0, 0)'s centre, glTF metres |
| 20 | f32 | `step`, metres |
| 24 | 3 × u16 | `nx`, `ny`, `nz`: cells along glTF x, y (up), z |
| 30 | u16 | 0 |
| 32 | f32 | `range`, the map's light range, the same as the lightmap's |
| 36 | 10 B per cell | the cells, cell (x, y, z) at index `x + nx·(y + ny·z)` |

- Cell (x, y, z) is the light at `origin + (x, y, z)·step`. The file is
  `36 + 10·nx·ny·nz` bytes.
- Each cell is 10 bytes:
  - bytes 0–2: up R, G, B;
  - bytes 3–5: down R, G, B;
  - bytes 6–8: side R, G, B;
  - byte 9: the sun's visibility.
- Light bytes are `round(sqrt(clamp(v/range, 0, 1))·255)`, decoded as `(b/255)²·range`.
- The sun byte is linear: `round(clamp(vis, 0, 1)·255)`, decoded as `b/255`.
- There is no padding: both readers take the cells a byte at a time. Interleaved 10-byte cells
  also gzip smallest. Nuke's gzips to 261,932 B; padded to 12 bytes it is 274,619 B, and as
  ten planes, one per byte of the cell, 325,955 B.
- **Version 1** (146d893 to 4ef350d) is still read, so a stale asset set keeps working. Its
  cells are 8 bytes: up R G B, down R G B, the sun, and 0. Its up and down were
  `(±Y + mean(±X, ±Z))/2`. It has no side, so `decodeLightGrid` and the viewer take
  `(up + down)/2`, the light version 1 gave a surface facing sideways.
- `decodeLightGrid` throws on:
  - a buffer shorter than the header;
  - a bad magic, or a version other than 1 or 2;
  - a header that encoding would never write: a size below 1, a step or range not above 0, or
    a non-finite origin;
  - a length the header does not account for, at its version's cell size.

The grid is dense: the copied cells cost little once gzipped. Built from the raw rips (range
from the lightmap):

| Map | Grid at 2.5 m | Cells | Sampled / refitted | `probes.bin` | gzip -9 | Version 1, gzip -9 |
|-----|---------------|-------|--------------------|--------------|---------|--------------------|
| `de_mirage` | 60 × 13 × 61 | 47,580 | 14,601 / 14,211 | 475,836 B | 135,570 B | 101,886 B |
| `de_nuke` | 80 × 21 × 129 | 216,720 | 37,066 / 34,728 | 2,167,236 B | 261,932 B | 190,677 B |

- Both are within D7's 0.4 MB. The side term adds 33,684 B (Mirage) and 71,255 B (Nuke) to
  the first load.
- The grid takes 4.3 s (Mirage) and 16.9 s (Nuke) to build, most of it the refit (version 1:
  3.3 and 12.7 s).
- Builds are deterministic.

Error against the full-resolution volumes, each point lit by its own volume. The points are 1 m
above every 23rd walkable triangle, as in the review's harness; "held out" is every 23rd from
the 11th, 1.25 m up. Each term is the grid as the viewer reads it, `vertexLight` facing up,
facing down, and the mean of the four sideways axes, against the cube's +Y, −Y and the mean of
its four sides: |log2(grid / volume)| of the summed RGB, median / p90 / points over a stop.
Version 1 is read the same way, through its up/down mix:

| Map | Term | Version 1 | Version 2 | Held out, version 1 | Held out, version 2 |
|-----|------|-----------|-----------|---------------------|---------------------|
| Nuke (1,640 points) | up | 0.255 / 1.07 / 178 | 0.079 / 0.92 / 149 | 0.258 / 0.91 / 141 | 0.082 / 0.85 / 119 |
| | down | 0.404 / 1.08 / 195 | 0.122 / 0.60 / 74 | 0.353 / 0.98 / 157 | 0.108 / 0.53 / 55 |
| | side | 0.180 / 0.65 / 76 | 0.062 / 0.60 / 69 | 0.173 / 0.62 / 67 | 0.072 / 0.54 / 61 |
| Mirage (891 points) | up | 0.141 / 0.45 / 24 | 0.028 / 0.18 / 17 | 0.142 / 0.43 / 29 | 0.030 / 0.21 / 20 |
| | down | 0.236 / 0.71 / 34 | 0.071 / 0.28 / 7 | 0.229 / 0.67 / 24 | 0.071 / 0.29 / 5 |
| | side | 0.104 / 0.26 / 6 | 0.030 / 0.15 / 6 | 0.099 / 0.25 / 6 | 0.033 / 0.15 / 6 |

**Weighting.** CS2 lights a surface from its cube as Σ n_axis²·face. With the four sides held
as one, three weightings of up, down and side were scored over 256 normals spread over the
sphere at each point, by the luminance |log2(light / CS2's cube along n)|, median / p90:

| Map | From | Version 1's mix | `n.y²` (shipped) | Linear: `max(±n.y, 0)`, `1 − \|n.y\|` |
|-----|------|-----------------|------------------|------------------------------------------|
| Nuke | the volume's own cube | 0.193 / 0.64 | **0.120 / 0.56** | 0.153 / 0.61 |
| Nuke | the grid as shipped | 0.247 / 0.93 | **0.195 / 0.88** | |
| Mirage | the volume's own cube | 0.143 / 0.55 | **0.105 / 0.51** | 0.117 / 0.53 |
| Mirage | the grid as shipped | 0.189 / 0.63 | **0.156 / 0.59** | |

- The squared weighting is CS2's own for a cube whose four sides are equal, and it is the
  closest of the three on both maps. Within 30° of the horizon it scores, from the cube,
  0.182 / 0.70 against version 1's 0.228 / 0.76 on Nuke, and 0.166 / 0.64 against
  0.187 / 0.66 on Mirage.
- What it leaves is the four sides' own spread (a lit window on one side, a wall on the other),
  which one side term cannot hold. Its mean in stops reads about 0.06 bright within 30° of the
  horizon, because the mean of the sides is taken in linear light: it is not a bias in the
  light.
- The refit weighs each term by its own brightness. One weight for all three, from their mean,
  scored as well on Mirage and worse on Nuke (held out, up over a stop at 133 points and down
  at 64, against 119 and 55).

The refit, as Task 3 measured it on version 1's `up` (the mix of +Y and the sides):

| Map | Grid | Median | p90 | > 1 stop |
|-----|------|-------:|----:|---------:|
| Nuke | centres only | 0.096 | 1.11 | 182 of 1,630 |
| Nuke | refitted | 0.068 | 0.71 | 92 |
| Mirage | centres only | 0.057 | 0.31 | 21 of 888 |
| Mirage | refitted | 0.026 | 0.16 | 6 |

The sun's visibility (the sun byte is the same in versions 1 and 2):

| Map | Grid | p90 \|Δ\| | Shadowed, read ≥ 0.3 | Lit, read < 0.6 |
|-----|------|-----------:|---------------------:|----------------:|
| Nuke | centres only | 0.32 | 86 of 941 (9.1 %) | 26 of 501 (5.2 %) |
| Nuke | refitted | 0.28 | 79 (8.4 %) | 28 (5.6 %) |
| Mirage | centres only | 0.26 | 19 of 299 (6.4 %) | 12 of 382 (3.1 %) |
| Mirage | refitted | 0.19 | 3 (1.0 %) | 4 (1.0 %) |

- The refit holds on points it was not fitted at. On every 23rd triangle from the 11th, 1.25 m
  up, Nuke's >1-stop points go from 150 to 80 and its p90 from 0.94 to 0.64.
- What is left is at volume borders: 88 of Nuke's 92. There, cells 2.5 m apart cannot follow a
  wall between a dark indoor volume and a bright outdoor one.
- The sun channel stays coarse: a 2.5 m grid blurs shadow edges. On Nuke about 1 shadowed point
  in 12 reads at least 0.3 lit. The viewer takes players' sun from its shadow map at medium and
  high, so this is only the `low` preset's fallback.
- A finer step, refitted, on Nuke (version 1):
  - at 2 m, p90 0.57 and 74 points over a stop, at 0.30 MB gzipped;
  - at 2.5 m, p90 0.71 and 92 points, at 0.19 MB.

  `GRID_STEP` stays 2.5.

## Players

```sh
tools/rip-players.sh            # both models, about 5 s; skipped when rip.json from this CS2 build exists unless --force
node tools/shrink-player.mjs ct # under a second each
node tools/shrink-player.mjs t
node tools/check-players.mjs
```

`rip-players.sh` exports `PLAYER_MODELS` from `lib/players.mjs` (CT
`agents/models/ctm_sas/ctm_sas.vmdl_c`, T `agents/models/tm_phoenix/tm_phoenix.vmdl_c`)
from `pak01_dir.vpk` with `--gltf_export_animations --gltf_animation_list
<CLIPS_REQUESTED> --gltf_compose_additive --gltf_textures_adapt`, into
`assets/raw/players/`:

| File                    | What it is |
|-------------------------|------------|
| `ct/ctm_sas.glb`        | the skinned model with its clips; PNG textures beside it, referenced by relative URI |
| `ct/ctm_sas_physics.glb`| written by the same export: hitbox physics; unused |
| `t/tm_phoenix.glb`, `t/*.png`, `t/tm_phoenix_physics.glb` | the same for T |
| `rip.log`               | full CLI output of both exports |
| `rip.json`              | `{ cs2Build, vrfVersion, exportedAt, clipsRequested, models: { ct\|t: { vmdl, glb, unmatchedClips } } }`; `unmatchedClips` is what VRF's "animation filter matched no animations for:" line names |

It uses the same temp-dir, rename, `--force` and failure-log rules as
`rip-map.sh` (failure log: `assets/raw/players.rip-failed.log`). The model
paths and the clip list come from `lib/players.mjs`, so the two scripts cannot
disagree.

What VRF 20.0 exports for an agent (CS2 build 2000934):

- mesh groups `thirdperson_body`, `thirdperson_default_gloves`,
  `firstperson_default_gloves_arms`, `firstperson_sleeves` and, on CT, `defusekit`,
  as nodes `<vmdl>.<group>`, each with its own identical copy of the body skin
  (CT 94 joints, T 86);
- one weapon skeleton per weapon clip family (`animation/skeletons/weapons/*.vnmskel`,
  44 of them with the phase 3c clip set), each with a 3-triangle
  `.empty_mesh_reference` mesh that carries its own skin (45 skins in the raw file);
- clips named by resource path: the 231 of `CLIP_SET` VRF matches under
  `animation/anims/world/` (rifle, pistol, knife, per-weapon, grenade, c4 and
  `shared/`), plus the same short names under `animation/anims/viewmodel/`, which
  the shrink drops. VRF finds `shoot_rifle` for neither model (the per-weapon
  `shoot_<w>` clips cover it) and none of the `shared/death_*` clips exist for the
  agents (CS2 deaths are ragdolls). The model exports 907 world clips in all when
  no list is given (listed 2026-10-22 from a 1.1 GB unfiltered export). Raw
  exports are 98.7 MB (CT) and 92.1 MB (T), in 9 s each.

`shrink-player.mjs <ct|t>` reads `rip.json`, checks the raw file for the thirteen
`CLIPS_REQUIRED` (exit 2 naming the missing ones), then:

1. `selectThirdPerson` (`lib/players.mjs`) removes the `PLAYER_DROP_NODE`
   subtrees (the weapon skeletons VRF adds for the weapon clips, with their
   placeholder meshes and skins, and the two `firstperson_*` groups, which the
   game draws only in the viewmodel). Left in, the first-person arms render as a
   second pair of arms posed in front of the face. It also drops every clip
   outside `animation/anims/world/`, strips the channels of kept clips that
   animate a dropped node (the turn-in-place clips move the weapon skeleton; the
   viewer parents its own weapon model to the `wpn` bone), and renames the rest
   to their short names (`idle_rifle`, `run_n_rifle`, ...), the names the web
   app asks for. Dropped clips and stripped channels take their samplers with
   them: `Animation.dispose()` alone leaves the samplers alive, and their
   keyframes then survive `prune` (13.6 MB of orphans in a 24 MB file, seen
   2026-10-22).
2. `stripBoneChannels` drops every scale channel and the translation channels of
   every bone but `root_motion`, `pelvis`, `wpnPivot` and `wpn` (`TRANSLATED_BONES`):
   VRF exports all three for all 94 joints of every clip, and only the rotations move
   the rest of the skeleton. `wpnPivot` hangs off the root and every clip places it
   (and `wpn` under it) by translation; without those channels a held weapon sits at
   the player's feet.
3. `dedup` (merges the identical body skins into one) → `prune` →
   `textureCompress` WebP 1024 px q80.
4. `simplify(ratio 0.5, error 0.001)` on a clone, kept only if
   `skinSurvives(before, after)` (`lib/skin.mjs`): exactly one skin with the same
   joint count, every `JOINTS_n` index below it, the same skinned mesh nodes,
   every `JOINTS_n`/`WEIGHTS_n` of every primitive still there, every clip with the
   same channel count. Otherwise the unsimplified document goes on.
5. `resample(tolerance 3e-3)` drops keyframes a linear fit reproduces (quaternion
   components, ≈ 0.35°), then `dedup` of accessors (the channels of a clip share
   one time accessor before resampling, few after) and `prune`.
6. `meshopt` level `high` with `quantizationVolume: 'scene'`. The default `'mesh'`
   gives each mesh its own corrected copy of the skin (3 skins on CT).
7. The written bytes are read back and must pass `skinSurvives` against step 3's
   document; otherwise exit 1 and nothing is written. A `<side>.glb.gz` sibling
   (gzip level 9) is written beside the GLB for the server to send as
   `Content-Encoding: gzip`.

The `defusekit` node (`agents/models/ctm_sas/ctm_sas.vmdl_c.defusekit`) is kept on
CT so the viewer can show it only for players with a kit.

Output in `assets/players/`: `<side>.glb`, `<side>.glb.gz` and `<side>.shrink.json`
`{ model, side, clips, joints, trisIn, trisKept, trisOut, simplified, bytes, gzBytes,
animSeconds, clipsOptionalAbsent, droppedNodes, droppedClips, strippedChannels,
textures, raw, seconds, params }` (`joints` is the raw body skin's count). Files are
written into `assets/players.tmp-<pid>/` and renamed in; output is byte-identical
across runs.

`check-players.mjs` prints a budget table and exits 1 on any failing row. Per
side it checks: size ≤ 8 MB and the `.glb.gz` sibling ≤ 2.4 MB (what a browser
downloads); ≥ 80 clips including all of `CLIPS_REQUIRED`; exactly one skin, with
`<side>.shrink.json`'s `joints`; `JOINTS_0`+`WEIGHTS_0` on every primitive of
every skinned mesh node; and no material dropped by `filters.mjs`. It also lists
the requested clips VRF could not match for the side (informational).

`CLIP_SET` has also asked for `inair_stand_knife` since 2026-10-27 (233 names), after
the last players rip (CS2 build 2000935, 2026-10-23). That build ships it under
`animation/anims/world/knife/_default_knife/`, and the viewer plays it for a knife in
the air. The players are re-ripped only when CS2 updates, so until then the built
GLBs lack it (`idle_knife` plays instead) and check-players lists it among the
optional clips absent. A requested clip VRF does not match fails nothing unless it
is one of `CLIPS_REQUIRED`.

CS2 build 2000934, VRF 20.0.6980, the phase 3c clip set (`CLIP_SET`, 232 names
requested, `shoot_rifle` unmatched on both models):

| Side | Raw GLB | Raw tris | After selection | Out tris | `simplified` | Clips | Animation | Out size | gz | Joints | Textures |
|------|---------|----------|-----------------|----------|--------------|-------|-----------|----------|----|--------|----------|
| CT `ctm_sas`    | 98.7 MB | 34,566 | 18,452 | 15,520 | true | 231 | 237.1 s | 7.49 MB | 1.94 MB | 94 | 16 |
| T `tm_phoenix`  | 92 MB   | 27,251 | 17,715 | 14,667 | true | 231 | 237.1 s | 7.43 MB | 2.12 MB | 86 | 14 |

(Rebuilt 2026-10-22 with the weapon bones' translations kept: +170 KB raw, +30 KB gz
per side.)

`error 0.001` stops simplification at 83–84% of the triangles, well short of
the 0.5 ratio. Rendered in three.js on `run_n_rifle` and `crouch_n_rifle`, both
outputs pose like the raw model minus its first-person meshes. Of the output,
about 1 MB is the 1024 px textures; the rest is animation at ≈ 27 KB per second
raw and ≈ 4 KB per second gzipped. Measured on CT before `stripBoneChannels` and
with `resample 1e-4`: 31.9 MB / 7.1 MB gz; with the strip and 1e-3: 2.05 MB gz,
3e-3: 1.87 MB gz, 1e-2: 1.64 MB gz. Dropping the 35 `draw_*` clips saved nothing
worth having (1.95 vs 1.87 MB gz).

Many of the clips are deltas, not poses: every gun's `shoot_*`, the weapons' own
`idle_*` (`idle_ak`, `idle_awp`, ...), `idle_c4`, `idle_grenade`, `idle_molotov`,
`breathing` and the `flinch_*` clips keep most bones at the bind pose and move only
what differs from a reference pose, which is `breathing`'s first frame (it matches
every gun shoot clip's first frame within 1° on the body and weapon bones). Played
as poses they put the arms out to the sides at hip height, a metre from the weapon.
The viewer adds them over the family locomotion (`web/README.md`, players and
weapons). The family clips (`idle_rifle`, `run_n_pistol`, `reload_ak`, `draw_*`,
`throw_*`, `planting`, `flashed`) are whole poses.

## The phone tier

```sh
node tools/phone-tier.mjs de_nuke   # maps/de_nuke/world_lo.glb, about 7 s
node tools/phone-tier.mjs players   # players/ct_lo.glb and t_lo.glb
node tools/phone-tier.mjs all       # every map with a world.glb, then the players: 69 s for all
```

The models the viewer's `low` preset loads, which phones get (`web/README.md`, Phones): a
shipped GLB again with its textures made smaller and every other byte as it is (the same
nodes, meshes, accessors, materials, skins and clips), so a phone decodes a quarter of the
texels or less. The web app falls back to the shipped files where a manifest does not list
them.

| Made | From | Textures |
|------|------|----------|
| `maps/<map>/world_lo.glb` | `world.glb` | within 128 px, WebP q60 (`world.glb`'s quality) |
| `players/<side>_lo.glb` | `<side>.glb` | within 512 px, WebP q80 (`<side>.glb`'s quality) |

Each has a gzip -9 `.gz` (`lib/gz.mjs`) and a record, `world_lo.json` or `<side>_lo.json`:
`{ file, bytes, sha256, gzBytes, source: { file, bytes, sha256 }, params: { size, format,
quality }, textures: { count, fitted, copied, maxSide, rgbaBytes, sourceRgbaBytes } }`, with no
timestamp. A texture over the size is fitted within it as the shrinks fit theirs
(`lib/alpha.mjs` `fitImage`: colour and alpha resized apart, the alpha kept only on a texture
some MASK or BLEND material draws as its base colour) and encoded as WebP at the source's
quality; one within it is copied byte for byte. The GLB is edited, not read and written by
gltf-transform, which would decode and re-encode its meshopt-compressed geometry and clips: the
new images take the old ones' places in the binary chunk, every other range is copied with its
order and alignment, and the JSON changes only in those ranges' offsets and lengths and the
buffer's length. The output is checked against its source (`phoneProblems`: every byte but the
images', each image fitted or copied as above) in `<out>.tmp-<pid>/` and renamed into place,
the `.gz`, the GLB, then the record; a failed target leaves its files as they were, and `all`
goes on to the next and exits 1 at the end. A target whose record names its source's current
sha256 and these parameters, with the files the record describes, is skipped ("up to date").
Rebuilt from the same inputs, every file is byte-identical. It only reads `world.glb`, `ct.glb`
and `t.glb`.

`check-map.mjs` and `check-players.mjs` check it (rows `record`, `vs <source>`, `textures`,
`size` within its source's and `.gz` inflating to the GLB), with a SKIP row where it is not
built. `manifest.mjs` lists it only while its record names the source beside it (Manifests), so
a `world.glb` shrunk again without it makes the map's manifest refuse until `phone-tier.mjs`
runs; `build-assets.sh` runs it after `shrink-map.mjs` and after the players' shrinks. The tier
is built per assets tree: a checkout that merges this code has none until `phone-tier.mjs all`
and the manifests run there, and `sync-assets.sh` ships only what the tree has (the viewer then
falls back to the shipped files at `low`, silently).

Built on 2026-10-26 (`node tools/phone-tier.mjs all`, 1 min 9 s); RGBA is the decoded texels
without mipmaps:

| Model | Phone tier (gz) | Shipped (gz) | Textures (fitted, copied) | As RGBA, phone / shipped |
|-------|-----------------|--------------|---------------------------|--------------------------|
| Ancient `world_lo.glb` | 38.89 MB (26.80) | 40.19 MB (28.10) | 254 (254, 0) | 14.53 / 58.13 MB |
| Anubis | 19.68 MB (13.26) | 21.07 MB (14.59) | 440 (437, 3) | 23.76 / 94.67 MB |
| Cache | 31.78 MB (17.80) | 33.60 MB (19.61) | 453 (453, 0) | 25.66 / 102.65 MB |
| Dust2 | 21.73 MB (14.01) | 23.55 MB (15.78) | 625 (620, 5) | 31.88 / 126.84 MB |
| Inferno | 46.35 MB (29.49) | 49.64 MB (32.15) | 749 (738, 11) | 45.90 / 182.35 MB |
| Mirage | 9.09 MB (5.80) | 10.30 MB (7.01) | 376 (351, 25) | 22.08 / 84.54 MB |
| Nuke | 21.05 MB (11.97) | 22.03 MB (12.95) | 710 (709, 1) | 34.55 / 138.13 MB |
| Overpass | 29.47 MB (18.53) | 31.88 MB (20.90) | 898 (883, 15) | 49.80 / 196.81 MB |
| Train | 42.12 MB (26.35) | 44.59 MB (28.83) | 670 (668, 2) | 37.13 / 148.28 MB |
| Vertigo | 10.66 MB (6.74) | 11.18 MB (7.25) | 315 (311, 4) | 15.93 / 63.19 MB |
| `ct_lo.glb` | 7.00 MB (1.45) | 7.71 MB (2.16) | 16 (12, 4) | 14.22 / 47.25 MB |
| `t_lo.glb` | 6.71 MB (1.40) | 7.58 MB (2.26) | 15 (15, 0) | 12.58 / 50.33 MB |

A world downloads only 3–12 % less (most of it is meshopt geometry, and its 256 px WebPs were
small already: Nuke's images are 1.49 MB of its 22.03); a player 33–38 % less gzipped. What
shrinks fourfold is what a phone decodes. Every world keeps its texture count and its alpha
textures (Nuke's 19), and its accessors decode to the same values (checked on Nuke).

## Weapons

The viewer puts the weapon a player holds into the rig's `wpn` bone (phase 3c), so
every weapon world model is ripped once, keyed by the viewer's normalised weapon
name (`WEAPON_MODELS` in `lib/weapons.mjs`: `ak47`, `m4a1s`, `usp`, `knife`,
`knife_t`, the six grenades, `c4`, `healthshot`, `taser`; 45 in all). Weapons,
grenades and defuse kits lying in the world (the pack's `GND1`, milestone 2b) use
the same models, plus `GROUND_MODELS`: the kit, `defuser`
(`weapons/models/defuser/defuser.vmdl_c`), which nobody holds. `MODEL_PATHS`
(`MODEL_NAMES`, 46) is both tables, and what the four steps below work through;
`WEAPON_NAMES` stays the 45 held weapons, since it is also the viewmodels' list:

```
tools/rip-weapons.sh [--force]  # 46 VRF exports, about 2 s each; when rip.json from this CS2 build exists, only the models without a folder
node tools/shrink-weapon.mjs all   # or one name
node tools/check-weapons.mjs
node tools/manifest.mjs weapons
```

`rip-weapons.sh` writes `assets/raw/weapons/<name>/<file>.glb` with its textures,
`rip.log` and `rip.json` (`{ cs2Build, vrfVersion, exportedAt, models: { <name>:
{ vmdl, glb } } }`), into a temp dir first like `rip-players.sh`. When `rip.json`
is from the installed build it exports only the models with no `<name>/` folder
(none: it does nothing) and adds them: their folders go in beside the others,
`rip.log` grows, and `rip.json` gains their entries with their own `vrfVersion`
and `exportedAt`; nothing already there is replaced. That is how the kit joined a
rip made before it, without `--force` (which re-exports every model). VRF 20.0.6980
cannot read every model of CS2 build 2000934 (the AUG fails with `Unknown KVType
26`); 20.1.7467 reads them all and is the installed CLI since 2026-10-22 (the
20.0 copy is kept beside it as `~/.local/opt/source2viewer-cli-20.0`).

A weapon export is a few mesh-group nodes named `<vmdl>.<group>`: `body_legacy`
(the body the game draws at distance; 13.5 k triangles on the AK) and `body_hd`
(26 k), or a single `body` (grenades), plus extras such as the C4's `c4_screen`,
skinned to the model's skeleton, with its clips (`--gltf_export_animations`; without
it VRF drops the skeleton). The skeleton's root bone, `weapon`, is what the game puts
on the player's `wpn` bone: its rest pose turns the glTF axes back into the game's and
sits 11 cm from the model's origin on the AK, 56 cm on the M4A4. `shrink-weapon.mjs`
runs `takeWeaponAttach` (that rest pose onto the scene's `extras.attach =
{ translation, rotation }`, which three.js loads as `userData.attach`; then the
skeleton, skins, clips and joint attributes go) → `selectWeaponBody` (drops `body_hd`
when `body_legacy` exists) → `dedup` → `prune` → `weld` → `simplify(ratio 0.1,
error 0.01)`, again with `(0.5, 0.05)` when more than 8,000 triangles remain →
`textureCompress` WebP 128 px q70 → `prune` → `meshopt` → `<name>.glb`,
`<name>.glb.gz` and `<name>.shrink.json` (`{ model, name, attach, trisIn, trisKept,
trisOut, simplifyRounds, bytes, gzBytes, groups, textures, materials, raw,
seconds, params }`). Simplify is topology-bound here too: models are many
separate parts and stop at 2–5 k triangles however loose the error. A raw export
made without the skeleton (a rip from before 2026-10-22) fails with "run
tools/rip-weapons.sh --force". A `GROUND_MODELS` item has no `weapon` bone (the kit's
one bone is `weapon_hand_r`) and is never held: `takeModelAttach` drops its skeleton
the same way and writes no `extras.attach`.

`check-weapons.mjs` checks, per model: present with its `.gz` and `.shrink.json`,
≤ 250 KB, ≤ 12,000 triangles, no skin, no clip, at least one mesh, and for a held
weapon `extras.attach`; across all 46: ≤ 4 MB raw and ≤ 3 MB gz. A match downloads
only the models its players hold or that lie on the ground in a round it shows.

CS2 build 2000934, VRF 20.1.7467: 45 weapons, 3.43 MB (2.55 MB gz; 3.53 and 2.58
before the unused joint attributes went), 100 s to rip, 9 s to shrink. Largest:
SSG08 202 KB / 10,765 triangles after both passes (bolt, scope and strap in separate
pieces), XM1014 169 KB / 7,752, M4A1-S 162 KB, Negev 154 KB; the smokegrenade is
23 KB / 1,109. The AK-47 is 68 KB / 2,234 triangles with 4 textures. The kit (CS2
build 2000935, 2026-10-24): 1,982 → 547 triangles, 17 KB (13 KB gz), 3 textures;
the 46 are 3.47 MB (2.60 MB gz).

## Viewmodels (first person)

```sh
tools/rip-viewmodels.sh [--force]          # 45 clip folders, 362 clips, about 25 s
node tools/shrink-arms.mjs all             # or ct / t; about 4 s each
node tools/shrink-viewmodel-clips.mjs all  # or one weapon name; about 2 s for all 45
node tools/check-viewmodels.mjs
node tools/manifest.mjs viewmodels
```

What the viewer draws in POV: the followed player's team's arms holding the gun, moved by
CS2's own viewmodel clips. The clips are authored on
`animation/skeletons/characters/viewmodel.vnmskel`, not on the agents' world skeleton: the
arms hang from `root_motion` through `armUpperShoulder_*` and `armUpperStraighten_0_*`, so
clips retargeted onto an agent by bone name pose nothing sensible. `root_motion` is the eye:
identity in game space (its glTF rotation `(-0.5, -0.5, -0.5, 0.5)` is the export's axis
swap), constant in every clip, +Z forward, +X left, +Y up; the weapon skeleton's root
(`weapon`) sits exactly on `wpn` in every clip. So the arms are moved onto that skeleton
instead, and the clips are kept as authored.

`rip-viewmodels.sh` exports each folder of `VIEWMODEL_DIR_LIST` (`lib/viewmodels.mjs`) clip by
clip, `-f animation/anims/viewmodel/<dir>/ -e vnmclip_c -d --gltf_export_format glb`, into
`assets/raw/viewmodels/<dir>/<clip>.glb`, with `rip.log` and `rip.json` (`{ cs2Build,
vrfVersion, exportedAt, dirs: { <dir>: [clip...] } }`), under the same temp-dir, `--force` and
failure-log rules as the other rips. Each GLB holds one clip, the viewmodel skeleton and the
weapon's own skeleton (bolt, magazine, ...), each with a placeholder mesh.

`VIEWMODEL_DIRS` maps every weapon model name (`WEAPON_MODELS`) to its folder: `rifle/rifle_ak`,
`pistol/pistol_glock18`, `knife/_default_knife` and `knife/knife_default_t`,
`grenade/grenade_hegrenade`, `equipment/c4`, ...; the M4A1-S, the USP-S and the decoy use the
family defaults `rifle/_default_rifle`, `pistol/_default_pistol` and `grenade/_default_grenade`.

`shrink-arms.mjs <ct|t|all>` writes `assets/viewmodels/arms_<side>.glb`, `.glb.gz` and
`arms_<side>.shrink.json`: the agent's `firstperson_default_gloves_arms` and
`firstperson_sleeves` meshes from the players' raw export (the ones `selectThirdPerson` drops),
re-skinned onto the viewmodel skeleton copied from `rifle/rifle_ak/idle_ak.glb` (any clip
holds the whole skeleton). The meshes keep their joint order and inverse bind matrices; a joint
the viewmodel skeleton lacks (the `*_TWIST` bones, and the unweighted spine, leg and jiggle
joints) hangs from its nearest ancestor that it has, at its rest offset from it. The IK helper
bones (`HELPER_BONE`: `wpnHand_*`, `attachHand_*`, `wpnTip`, `wpnEnd`) are left out. Then
TANGENT and TEXCOORD_1+ go, and every texture but the base colour (the viewer's look draws
only that) → `dedup` → `prune` → `weld` + `simplify(0.5, 0.002)` kept only if `skinSurvives` →
WebP 256 px q80 → `meshopt` with scene quantization → gzip -9. The written file must pass
`skinSurvives` against the re-skinned document and keep every skeleton bone.

`shrink-viewmodel-clips.mjs <name>|all` writes `assets/viewmodels/<name>.glb`, `.glb.gz` and
`<name>.shrink.json` per weapon model name: no mesh, the viewmodel skeleton under a `viewmodel`
root (helpers left out), and the weapon's clips on it, named by kind. `selectClips` picks them
from the folder by its suffix `<s>` (what follows `draw_` in its shortest `draw_*` clip):

| Kind | Source | Weapons |
|------|--------|---------|
| `idle` | `idle_<s>`, else `idle1_<s>` | all |
| `draw` | `draw_<s>` (`draw_silenced_pistol` for the USP-S) | all |
| `shoot` | `shoot1_<s>`, else `shoot_right1_<s>`, else `light_miss1_<s>` | guns, the Zeus, knives |
| `shoot_left` | `shoot_left1_<s>` | Dual Berettas |
| `reload` | `reload_<s>` | guns that have one |
| `pullpin`, `throw`, `throw_underhand` | `pullpin_<s>`, `throw_overhand_<s>`, `throw_underhand_<s>` | grenades |
| `plant` | `plant_<s>` | c4 |

A channel on a helper bone, on the weapon's own skeleton, or that never leaves its bone's rest
pose (within 1e-5) is dropped; then `resample(1e-3)` and `meshopt`. The exception is
`WEAPON_BONES_KEPT`: the Dual Berettas and the molotov keep `weapon_hand_r` and
`weapon_hand_l`, hung under `wpn`: their clips leave `wpn` at the eye and carry the model's
parts (the two pistols; the bottle and the lighter) to the hands on these bones (the viewer
hangs each part on its bone). Every other weapon's idle holds `wpn` out from the eye, which
`check-viewmodels.mjs` checks. Bolt and magazine
motion is not kept: the weapon models (`shrink-weapon.mjs`) have no skeleton. Most idles are a
single pose; draws run 1.0–1.3 s, the AK's shot 0.77 s, the AWP's 1.6 s, the M249's reload 5.7 s.

`check-viewmodels.mjs` checks per side: ≤ 150 KB gz, ≤ 12,000 triangles, one skin with
`shrink.json`'s joints, `JOINTS_0`/`WEIGHTS_0` on every skinned primitive, no clip, and the
bones `root_motion`, `wpn`, `hand_L`, `hand_R`; per weapon: ≤ 60 KB gz, no mesh, `idle` and
`draw`, the clips `shrink.json` names, every channel on a bone the arms have (or a
`WEAPON_BONES_KEPT` one), and an idle that holds `wpn` 15 cm or more from the eye (for a
`WEAPON_BONES_KEPT` weapon, one that moves those bones instead); across all: ≤ 1.5 MB gz, and a typical match (both arms and the 23
`TYPICAL_MATCH` weapons) ≤ 1.0 MB gz, which is what a viewer downloads for first person.

CS2 build 2000934, VRF 20.1.7467: CT arms 8,054 triangles (16,114 raw), 94 joints (48 hung),
119 KB (85 KB gz); T arms 4,841 (9,536), 86 joints, 108 KB (79 KB gz). 45 clip files 3.94 MB
(1.10 MB gz), 6–46 KB gz each (the Medi-Shot smallest, the M249 largest); the AK-47 25.5 KB gz.
A typical match 0.70 MB gz. Output is byte-identical across runs.

## Effects

```sh
tools/rip-effects.sh [--force]        # 31 textures, about 12 s
node tools/build-effects.mjs [<key>…] # all atlases unless keys are named, about 3 s
node tools/check-effects.mjs
node tools/manifest.mjs effects
```

CS2's own particle and decal textures (spec §7.6), each packed into one WebP flipbook atlas
that the viewer fetches the first time an effect needs it. `EFFECTS` in `lib/effects.mjs` is
the table; the texture references come from the decompiled `.vpcf` systems (`inferno_fx`,
`explosions_fx`, `unified_weapon_fx`, `impact_fx`, `blood_impact`).

`rip-effects.sh` exports every source texture (`EFFECT_SOURCES`) from `pak01_dir.vpk` into
`assets/raw/effects/`, keeping VRF's paths: a flipbook comes out as one PNG per frame
(`<name>_seq<S>_<F>.png`, cropped to its content, so frames of one sequence differ in size) and
an `.mks` listing the sequences; a plain texture as `<name>.png`. `rip.json` is `{ cs2Build,
vrfVersion, exportedAt, files: { <vtex>: [<file>…] } }`. Temp dir, skip-when-current and
`--force` work as in `rip-weapons.sh`.

`build-effects.mjs` writes `assets/effects/<key>.webp` and `build.json`. Frames are picked by
`selectFrames` (`every` n keeps frames 0, n, 2n… of each authored sequence; `sequences` picks
sheets' sequences; `group: sequence` keeps the authored sequences, `source` makes one per
source, or per `set` of sources); each sequence is scaled by one factor so its largest frame
just fits the cell (`placeFrame`), centred, standing on the cell's bottom (`anchor: bottom`,
the flames) or centred; colour and alpha are resized apart (`resizeApart` in `lib/alpha.mjs`)
and the colour under each cell's transparent pixels is bled from its frame, so filtering never
darkens an edge. Cells run in rows of 1024 px from the top left (`layoutAtlas`). A decal whose
alpha averages ≥ 0.9 (the wood shots: a mod2x mark on neutral grey) takes its alpha from how far
it is darker than its median grey (`decalAlpha`). WebP at the row's quality, `alphaQuality` 90,
`effort` 6; output is byte-identical across runs. An atlas whose every pixel is opaque (the
explosion: grey fireballs on black, drawn additively, every cell full) is written without alpha.

`check-effects.mjs` checks each atlas against its budget, that its size matches `build.json`
and is a whole number of cells 1024 px wide, and that its frames fit; and the total against
`EFFECTS_BUDGET` (1,500,000 B).

CS2 build 2000935, VRF 20.1.7467:

| key | sources | frames → sequences | cell | anchor | q | size | budget |
|---|---|---|---|---|---|---|---|
| `fire` | `particle/fire_burning_character/fire_burning_character` | 131 in 9 | 64×112 | bottom | 80 | 350.9 KB | 450 KB |
| `fireburst` | `particle/fire_small_sim/fire_small_sim_b` | 131 in 4 | 64×64 | bottom | 60 (238 KB at 80) | 214.0 KB | 220 KB |
| `explosion` | `particle/explosion_fireballs/flame/explosion_fireball_01_flame`, every 2 | 40 | 128×128 | center | 80 | 12.4 KB | 300 KB |
| `smoke` | `particle/smoke/smokeburst/smokeloop_i_0_sc_hardedge`, every 4 | 32 | 128×128 | center | 80 | 168.2 KB | 200 KB |
| `dust` | `particle/smoke/smokeburst/smokeburst_e`, every 2 | 32 | 64×88 | center | 80 | 72.3 KB | 80 KB |
| `muzzle` | `particle/flames/flame_omni`, every 4 | 15 | 64×64 | center | 80 | 34.7 KB | 40 KB |
| `flare` | `particle/particle_flares/particle_flare_001` | 1 | 128×128 | center | 90 | 5.2 KB | 15 KB |
| `sparks` | `particle/sparks/sparks` seq 0–8; `effects/spark` | 10 → `[[0,9],[9,1]]` | 32×64 | center | 90 | 4.7 KB | 15 KB |
| `debris` | `particle/impact/fleks` seq 7–22 | 16 | 32×32 | center | 80 | 5.4 KB | 15 KB |
| `blood` | `particle/headshot/headshot` seq 0, 2–6; `particle/blood_splatter/bloodsplatter` seq 0, 7–9 | 10 → `[[0,6],[6,4]]` | 64×64 | center | 80 | 11.6 KB | 40 KB |
| `decals` | `decals/{concrete,metal,wood,glass,blood}/…` (19 textures, one sequence per surface) | 19 → `[[0,4],[4,3],[7,3],[10,3],[13,6]]` | 64×64 | center | 80 | 31.5 KB | 120 KB |
| **total** | | | | | | **910.9 KB** | **1,500 KB** |

All paths are under `materials/`. The `fire` sequences 0–4 are bright flame tongues, 5–8
browner, smokier ones; both are near-white and take their colour from the particle's tint, as
in the game. `explosion` and `effects/spark` are opaque (black around the light: draw them
additively).

## Sounds

```sh
tools/rip-sounds.sh [--force]    # the soundevents, the surfaces and about 1,800 sounds (200 MB), about 15 s
node tools/build-sounds.mjs      # 90 banks and build.json, about 8 s
node tools/check-sounds.mjs
node tools/manifest.mjs sounds
```

CS2's own sounds (spec §7.10), packed into one mono Opus/WebM *bank* per family that the viewer
fetches when a round that uses it is shown, and plays a clip from as a slice (offset, duration)
of the decoded bank. A family is a gun (`weapon_<name>`; both knives are `weapon_knife`), a
grenade (`grenade_he`, `grenade_flash`, `grenade_smoke`, `grenade_fire` for the molotov and the
incendiary, `grenade_decoy`), `bomb`, `player` (hits and deaths), `round` (the countdown beeps,
the round's end and the announcer) or a footstep set (`steps_<set>`). The viewer asks for a
sound by key; `lib/sounds.mjs` holds the tables: `STATIC_SOUNDS` (40 keys with one fixed event,
`throw:he`, `fire:loop`, `bomb:plant`, `hit:head`, `round:ct`…), `WEAPON_SOUNDS` (each weapon's
event prefixes, giving `shot:<w>`, `shot:<w>:silenced`, `reload:<w>:out|in|bolt` where CS2 has
the event) and `stepSets` (each surface's footstep set from `surfaceproperties_footsteps.txt`,
else its `base`'s, else `default`; `step:<set>:ct`, `step:<set>:t`, `land:<set>`).

`rip-sounds.sh` exports into `assets/raw/sounds/`, at the VPK's paths: the soundevent files
(`SOUNDEVENT_FILES`) and `surfaceproperties.vsurf` decompiled to KV3 text,
`scripts/surfaceproperties_footsteps.txt`, every sound under `sounds/weapons/` and
`sounds/player/` (`.wav` or `.mp3`), then each sound elsewhere that `build-sounds.mjs
--list-missing` names (the announcer, the UI beeps, grenade and landing impacts). `rip.json` is
`{ cs2Build, vrfVersion, exportedAt, absent }`, `absent` the files the VPK has nothing for. Temp
dir, skip-when-current and `--force` work as in `rip-weapons.sh`; beside a current rip it
exports only what `--list-missing` still names, which is nothing once the rip is whole.

`build-sounds.mjs` reads each key's event into layers (`resolveLayers`: the event's fields over
its `base` chain, then a layer per `soundevent_0N` child; per layer its file variants, volume,
pitch and their random spreads, CS2's distance curve and the position offset), decodes every
file to mono 48 kHz with ffmpeg, drops its tail under −80 dBFS (`trimTail`: inaudible, and most
of what a quiet decay costs), lays a family's files end to end with 0.05 s of silence between,
a file several keys play once, and encodes the bank (`-c:a libopus -b:a 48k -vbr on`, bit-exact:
the same rip gives the same bytes). It writes `assets/sounds/<bank>.webm` and `build.json` (`{
raw, params, banks, sounds, surfaces, missing }`, the header of `build-sounds.mjs` has the
shapes) through `assets/sounds.tmp-<pid>/`. A key whose event has no layer, or one of whose
files the rip lacks, is listed in `missing` and left out (none today). `UI.CounterDoneBeep`
(`round:go`) is silent in CS2's own files; it is kept as a one-sample clip, with a warning.

`check-sounds.mjs` holds each bank to 400 KB and to its size in `build.json`, all of them to
12 MB, needs every `STATIC_SOUNDS` key and every `TYPICAL_MATCH` weapon's shot (and silenced
shot) with none of that weapon's keys left out, and holds a typical match to 3,000,000 B: the
banks of the `TYPICAL_MATCH` weapons (`lib/viewmodels.mjs`: 15 guns and the knife), the five
grenade banks, `bomb`, `player` and `round`, and the step set of every surface
`assets/maps/de_mirage/hull.glb` has a node for (`physics_group_<surface>`,
`physics_passbullets_…`, read by `surfaceOfNode` and mapped through `build.json`'s `surfaces`, an
unknown surface on `default`; without that hull the row counts no steps). `typicalMatchBanks` in
`lib/sounds.mjs` names those banks.

The plan's spike (CS2 build 2000934) measured 64 KB for the AK-47 as one bank, 45 KB for 12
concrete steps, 82 KB for the HE, 57 KB for the bomb, and put a typical match at about 1.9 MB
(the guns about 1 MB, the grenades 0.35, the steps 0.3, the bomb, player and round 0.3). The
footstep sets came out larger: each holds CS2's 17-odd step variants and the landings with their
child layers. Measured 2026-10-25 (CS2 build 2000935, VRF 20.1.7467), 49 kbps on average:

| banks | count | bytes | seconds | clips |
|---|--:|--:|--:|--:|
| `weapon_*` | 36 | 1,823,161 | 325.9 | 226 |
| `grenade_*` | 5 | 727,830 | 125.1 | 65 |
| `bomb`, `player`, `round` | 3 | 222,478 | 32.9 | 36 |
| `steps_*` | 46 | 2,873,665 | 434.1 | 757 |
| **all** | **90** | **5,647,134** | **917.9** | **1,084** |

The largest banks are `grenade_fire` 389,757 B (36 clips, 65.0 s: both fire starts, the loop and
the fade), `grenade_he` 138,251, `weapon_m4a1s` 120,612, `steps_metalgrate` 120,121 and
`grenade_smoke` 117,984; the smallest `weapon_knife` 2,767. `weapon_ak47` is 63,644 B (7 clips,
11.4 s), `steps_concrete` 72,174 B (21 clips). **A typical match on Mirage is 2,883,973 B**: the
16 weapon banks 815,235, the grenade, bomb, player and round banks 950,308, and 20 step sets
1,118,430 (Mirage's hull names 32 surfaces, which step on cardboard, carpet, chainlink,
concrete, default, dirt, glass, glassbottle, metalbarrel, metalvehicle, metalvent, plastic_box,
rubber, solidmetal, wood, wood_basket, wood_ladder, wood_panel, wood_solid and woodbox; plaster,
rock, brick and boulder on concrete).

## Manifests

```sh
node tools/manifest.mjs de_mirage   # assets/maps/de_mirage/manifest.json
node tools/manifest.mjs players     # assets/players/manifest.json
node tools/manifest.mjs sounds      # assets/sounds/manifest.json and manifest.json.gz
node tools/manifest.mjs root        # assets/manifest.json
```

A map manifest lists every served file present with its size and SHA-256 (hex of
the file bytes), in this order: `world.glb`, `world_lo.glb` (the phone
tier, when built), `hull.glb`,
`entities.glb` (only when the map has doors or breakables), `radar.png`, `radar_lower.png`
(only when the map has a lower section), `sky.webp` (when there), `lightmap.webp`,
`probes.bin` and `light.json` (when the map's light is baked; no `lightmap.webp` under tier
V), `overview.json`. `shrink.json` and the manifest itself are not listed.

```json
{ "map": "de_mirage", "schema": 1, "cs2Build": "2000934", "vrf": "20.0.6980", "generated": "2026-10-21T20:53:30Z",
  "files": { "world.glb": { "bytes": 18641600, "sha256": "…" }, "hull.glb": {…}, "radar.png": {…}, "overview.json": {…} },
  "world": { "tris": 685376, "textureSize": 256, "ao": true }, "sections": ["default"] }
```

`cs2Build` and `vrf` (the version without its `+commit` suffix) come from
`assets/raw/<map>/rip.json`; `world.tris`, the texture sizes and `ao` from
`shrink.json`; `sections` (names, in order) from `overview.json`. The script
refuses (exit 1, naming the file, old manifest left alone) unless everything it
describes agrees: the four required files exist, every section's image exists and
every `radar*.png` has a section, `light.json` and the bake files it names are there together or
not at all, and the GLB sizes equal `shrink.json`'s
`bytes`, so a stale `shrink.json` cannot put the wrong triangle count in a manifest.
`entities.glb` is checked the same way where it exists; one that `shrink.json` does not
record (left from an earlier build), or one it records that is missing, is refused.
With the phone tier the manifest also has `"lo": { "textureSize": 128 }` after `world`.
Manifests written before `world_hd.glb` retired list it and have `"hd": { "textureSize": 1024 }`
after `world`; the web app tolerates both, and the next `manifest.mjs <map>` drops them (a
`world_hd.glb` still in the map's folder is not listed).

`assets/players/manifest.json` is `{ schema, cs2Build, vrf, generated, ct, t }`
with, per side, `{ model, clips, bytes, sha256, gz: { bytes, sha256 } }`: `model` is
the agent's short name (`ctm_sas`, `tm_phoenix`) from `raw/players/rip.json`,
`clips` the sorted clip names from `<side>.shrink.json`, `gz` the `.glb.gz`
sibling. It refuses when a GLB's size differs from its `shrink.json`, the `.gz`
is missing, or the `shrink.json` was made from another rip (`raw.cs2Build`). With the phone
tier a side also has `lo: { file, textureSize, bytes, sha256, gz: { bytes, sha256 } }`
(`file` is `ct_lo.glb` or `t_lo.glb`).

Both list a phone tier (The phone tier) only together with its record and only while the
record names the source beside it; the script refuses, naming `tools/phone-tier.mjs
<map>|players` to rerun, a phone tier without its record or a record without it, a GLB other
than the bytes and sha256 its record states, and a record made from another `world.glb` or
`<side>.glb`, and on the players a missing `<side>_lo.glb.gz`.

`assets/weapons/manifest.json` is `{ schema, cs2Build, vrf, generated, weapons }` with,
per weapon name, `{ model, tris, bytes, sha256, gz: { bytes, sha256 } }` (`model` is the
file's short name, `weapon_rif_ak47`); it refuses the same stale states as the
players' manifest.

`assets/viewmodels/manifest.json` is `{ schema, cs2Build, vrf, generated, arms, weapons }`:
`arms` per side `{ model, bytes, sha256, gz: { bytes, sha256 } }` (`model` the agent's short
name), `weapons` per weapon name `{ dir, clips, bytes, sha256, gz }` (`clips` sorted, from its
`shrink.json`); `cs2Build` and `vrf` from `raw/viewmodels/rip.json`. It refuses a GLB whose
size differs from its `shrink.json`, a missing `.gz`, and a `shrink.json` made from another rip.

`assets/effects/manifest.json` is `{ schema, cs2Build, vrf, generated, atlases }` with, per
`EFFECTS` key in table order, `{ file, bytes, sha256, width, height, cell, cols, frames,
sequences }` (`sequences` as `[firstFrame, count]`, frame 0 the top-left cell); `cs2Build` and
`vrf` from `raw/effects/rip.json`. It refuses a missing atlas, one whose size differs from
`build.json`, and a `build.json` made from another rip.

`assets/sounds/manifest.json` is `{ schema, cs2Build, vrf, generated, banks, sounds, surfaces }`:
`banks` per bank, sorted, `{ bytes, sha256, seconds }`; `sounds` and `surfaces` as `build.json`
has them, `sounds` per key `{ bank, layers }` with each layer `{ clips, volume, volumeRandom,
pitch, pitchRandom, curve, offset, loop }` (`clips` the file variants as `[offset, duration]`
seconds into the bank, `curve` CS2's `[units, gain]` points or `null`, `offset` in units),
`surfaces` a surface name or `vrf_unknown_key_<hash>` to its step set; `cs2Build` and `vrf` from
`raw/sounds/rip.json`. It refuses a missing bank, one whose size differs from `build.json`, a
sound in a bank `build.json` does not list, and a `build.json` made from another rip (another
CS2 build or VRF version). It is the one manifest with a gzip -9 `manifest.json.gz` beside it,
which the server sends a client that accepts gzip (449.7 KB of JSON, 22.6 KB gzipped), renamed
into place just before the manifest.

`assets/manifest.json` is `{ schema, generated, maps, players, weapons, viewmodels, effects, sounds }`: `maps` has one
entry per `assets/maps/<map>/manifest.json` that exists, sorted, as
`{ cs2Build, bytes, sections }` (`bytes` is the sum over the map's files, the phone
tier's included; before `world_hd.glb` retired it also had `hd`, whether that was listed); `players` is `{ cs2Build }`, or `null` without a
players manifest; `weapons` is `{ cs2Build, count }`, or `null` without a weapons
manifest; `viewmodels` is `{ cs2Build, arms, count }`, or `null` without a viewmodels manifest;
`effects` is `{ cs2Build, count, bytes }`, or `null` without an effects manifest; `sounds` is
`{ cs2Build, banks }` (`banks` the count), or `null` without a sounds manifest.

`generated` is UTC to the second, so manifests differ between runs while the files
they describe are byte-identical. Each manifest is written to
`<file>.tmp-<pid>` and renamed into place.

## Building everything

```sh
tools/build-assets.sh de_mirage          # one or more maps
tools/build-assets.sh all                # the Active Duty pool
tools/build-assets.sh all --force        # re-export the raw files too
```

Per map, stopping at the first failing step: `rip-map.sh <map> [--force]` →
`rip-lighting.sh <map> [--force]` → `model-poses.sh <map>` → `radar.mjs` → `sky.mjs` →
`shrink-map.mjs` → `phone-tier.mjs <map>` → `hero.sh <map>` → `check-map.mjs <map>
--budget-override` →
`manifest.mjs <map>`. `model-poses.sh` writes `raw/<map>/model-poses.json` beside the rip (the
pose each skinned prop is drawn in; Shrinking a map), which `shrink-map.mjs` needs on any map
whose world draws a skinned model. `radar.mjs` and `sky.mjs` read only the raw export and run
before `shrink-map.mjs`, whose first-load cap counts what they write. Then
once each asset kind in `lib/kinds.mjs` `KINDS` (the one list of them: `build-assets.sh` runs
the plan `node tools/lib/kinds.mjs plan` prints, `manifest.mjs` builds each kind's manifest and
root line from it, `sync-assets.sh` checks each listed kind has its manifest), today:
`rip-players.sh [--force]` → `shrink-player.mjs ct` → `shrink-player.mjs t` →
`phone-tier.mjs players` → `check-players.mjs` → `manifest.mjs players`; then `rip-weapons.sh [--force]` →
`shrink-weapon.mjs all` → `check-weapons.mjs` → `manifest.mjs weapons`; then
`rip-viewmodels.sh [--force]` → `shrink-arms.mjs all` → `shrink-viewmodel-clips.mjs all` →
`check-viewmodels.mjs` → `manifest.mjs viewmodels` (after the players: the arms come from
their raw export); then `rip-effects.sh [--force]` → `build-effects.mjs` → `check-effects.mjs`
→ `manifest.mjs effects`; then `rip-sounds.sh [--force]` → `build-sounds.mjs` →
`check-sounds.mjs` → `manifest.mjs sounds` (after the maps: `check-sounds.mjs` counts the step
sets of Mirage's hull); and last `manifest.mjs root`.
`--force` reaches only the rip steps, which otherwise skip what is already ripped
from the installed CS2 build; the other steps always run and reproduce the same
bytes from the same raw export.

**After a CS2 update**, run `tools/build-assets.sh all --force`. Without `--force`
the rip steps still notice a `rip.json` whose `cs2Build` is not the installed
build and re-export it (printing a `WARNING` with both builds), so the log
header's `CS2 build <n>` always matches the outputs; `--force` makes that explicit
and also re-exports a rip whose `rip.json` is unreadable. **After a Source2Viewer-CLI
upgrade** alone, `--force` is the only way to new rips: the CS2 build still matches, so
the rip steps skip.

A map's `manifest.json` is removed when its build starts, before any step can
change the files it describes, and rewritten only when the build finishes, so a
build that fails or is interrupted (Ctrl-C, kill, power loss) leaves the map
unlisted rather than described by a manifest of older files. The root
`assets/manifest.json` is removed when the run starts and written at its end from
the per-map manifests that exist, so it leaves a failed map out; an interrupted
run, or a failed `manifest.mjs root`, leaves none, and `sync-assets.sh` refuses
until a run finishes (`node tools/manifest.mjs root` rewrites it in a second from
the manifests that are there). A failing map
is reported (`FAIL <map> at <step>`, with the step's last 15 lines on the
terminal) and skipped; the next map goes ahead and the script exits 1 at the end.
Players fail the same way (`assets/players/manifest.json`). A bad `CS2_DIR` or
`S2V_CLI` stops the script at once with `lib/env.sh`'s one-line message, before
anything is written. Usage errors exit 2. The sounds' `manifest.json` goes with its
`manifest.json.gz` when their build starts: the server would otherwise still send the old `.gz`
to a client that accepts gzip.

The full output of every step goes to `assets/build.log`, which each run starts
afresh, with one `OK <map> (<s>s)` or `FAIL <map> …` line per map and per
`players`; the terminal gets one line per step. `build-assets.sh` holds a lock on
`build.log` while it runs, so a second build or a sync started meanwhile refuses.

`tools/build-assets.sh de_mirage` on this machine (raw files already ripped, CS2
build 2000934) took 179 s: `shrink-map.mjs` 175 s (AO 154 s of it; 105 s in an
earlier run, so the bake time moves with machine load), `radar.mjs`,
`check-map.mjs` and `manifest.mjs` about a second each, the players 3 s. The five
Mirage files came out byte-identical to the previous build (same SHA-256), and the
manifest lists 5 files, 54,190,639 bytes.

`tools/build-assets.sh all` on 2026-10-24 (milestone 2b's check; CS2 build 2000935, VRF
20.1.7467, every raw export already ripped, so the rip steps took 0 s): every map, the
players, the weapons (45 and the defuse kit), the viewmodels and the effects `OK`, exit 0, in
4,225 s while other work loaded the machine. Every `check-*` printed `all checks OK`.

| Map | Map build s (`shrink-map.mjs`) | `model-poses.json`: models, posed (bytes) | `entities.glb` (`.gz`) |
|-----|-------------------------------:|-------------------------------------------|------------------------|
| de_ancient  | 481 (478) | 0, 0 (137 B)    | none |
| de_anubis   | 280 (278) | 1, 0 (296 B)    | none |
| de_cache    | 539 (536) | 0, 0 (135 B)    | 27.6 KB (19.3 KB) |
| de_dust2    | 332 (330) | 0, 0 (135 B)    | none |
| de_inferno  | 664 (658) | 2, 0 (461 B)    | 13.7 KB (8.6 KB) |
| de_mirage   | 107 (96)  | 19, 1 (3,887 B) | 3.3 KB (1.3 KB) |
| de_nuke     | 326 (322) | 3, 1 (813 B)    | 18.1 KB (8.9 KB) |
| de_overpass | 550 (546) | 3, 3 (2,373 B)  | 9.8 KB (6.0 KB) |
| de_train    | 681 (675) | 4, 0 (1,020 B)  | none |
| de_vertigo  | 189 (183) | 7, 2 (1,505 B)  | 16.8 KB (10.8 KB) |

`model-poses.sh` took 0–10 s a map; the players 44 s, the weapons 18 s, the viewmodels 10 s,
the effects 4 s. The `entities.glb` sizes are those of the table under Shrinking a map.
`tools/sync-assets.sh --dry-run` then listed the six `entities.glb` (and `.gz`) and
`weapons/defuser.glb` as new on the server, and `effects/` with new timestamps only (the server
already had the same atlases).

`tools/build-assets.sh de_mirage` on 2026-10-25 (milestone 3's check; CS2 build 2000935, VRF
20.1.7467, every raw export already ripped) took 152 s, exit 0: Mirage 65 s (`shrink-map.mjs`
54 s), the players 42 s, the weapons 22 s, the viewmodels 10 s, the effects 4 s, and the sounds
9 s (`rip-sounds.sh` 0 s, `build-sounds.mjs` 8 s, `check-sounds.mjs` 1 s, `OK sounds`). Every
file the manifests list came out byte-identical to the previous build's; only the manifests'
`generated` and the `shrink.json` files' timings differ.

## Active Duty results

### With CS2's baked light (milestone 2a, 2026-10-25)

`flock …/assets/raw/.m2-rip.lock tools/build-assets.sh all` (CS2 build 2000935, VRF 20.1.7467),
after `rip-lighting.sh` exported the eight maps not exported before, one at a time (25–90 s and
351–746 MB of `raw/<map>/lightmaps/` each; Cache's probe atlas, 1,608 slices, the largest):
eight maps `OK` and the players, weapons, viewmodels and effects `OK` in 2,445 s; the rows
below are after the four maps' rebuild under their larger cap (the last bullet). Inferno failed
`check-map` (tier V's first load, 32,216,995 B, was over its cap) and Vertigo the light grid's
new row (416,865 B against 0.4 MB); with tier V's 192 px textures and Vertigo's 0.45 MB grid
override, `build-assets.sh de_inferno de_vertigo` was `OK` for both in 627 s. Every map passes
`check-map.mjs --budget-override`, and every `entities.glb` has the same roots (name,
translation, rotation, scale, extras, meshes) as milestone 2b's build on main. Sizes are bytes;
the first load is `lib/maps.mjs` `firstLoadBytes` (`world.glb.gz`, `entities.glb.gz`, the
radars, `overview.json`, `sky.webp` and the bake), the cap the map's first load before M2a +
2.5 MB, or + 5.0 MB in place of it on Anubis, Dust2, Inferno and Overpass; "Shrink" is
`shrink.json` `seconds`.

| Map | Tier | First load / cap | Under the cap | `world.glb.gz` | `lightmap.webp` | `probes.bin.gz` (cells) | `sky.webp` | `entities.glb.gz` | Triangles | Shrink |
|-----|------|------------------|--------------:|---------------:|----------------:|------------------------:|-----------:|------------------:|----------:|-------:|
| `de_ancient` | H2 | 30,101,971 / 33,793,380 B | 3.69 MB | 28,103,149 B | 1,715,086 B | 185,176 B (74×17×69) | 16,464 B | — | 3,483,264 | 175 s |
| `de_anubis` | H2 | 16,520,759 / 18,197,342 B | 1.68 MB | 14,590,901 B | 1,462,674 B | 252,206 B (84×18×62) | 7,524 B | — | 1,385,279 | 181 s |
| `de_cache` | H2 | 20,920,001 / 22,361,632 B | 1.44 MB | 19,611,920 B | 1,015,544 B | 153,107 B (64×19×64) | 30,960 B | 20,028 B | 1,738,364 | 258 s |
| `de_dust2` | H2 | 17,381,642 / 19,540,965 B | 2.16 MB | 15,777,071 B | 1,211,196 B | 214,854 B (73×13×84) | 9,988 B | — | 1,746,488 | 208 s |
| `de_inferno` | H2 | 33,992,103 / 34,369,898 B | 0.38 MB | 32,148,544 B | 1,499,768 B | 190,648 B (73×19×77) | 12,834 B | 9,332 B | 3,527,454 | 289 s |
| `de_mirage` | H2 | 8,329,211 / 8,953,417 B | 0.62 MB | 7,006,211 B | 1,042,668 B | 135,570 B (60×13×61) | 6,830 B | 1,328 B | 552,195 | 54 s |
| `de_nuke` | H2 | 14,270,085 / 14,744,987 B | 0.47 MB | 12,947,745 B | 856,630 B | 261,932 B (80×21×129) | 8,062 B | 10,023 B | 1,512,738 | 166 s |
| `de_overpass` | H2 | 22,777,517 / 24,998,162 B | 2.22 MB | 20,901,273 B | 1,412,364 B | 169,710 B (82×27×67) | 10,156 B | 6,225 B | 1,906,505 | 248 s |
| `de_train` | H2 | 30,473,777 / 30,990,298 B | 0.52 MB | 28,832,840 B | 1,179,606 B | 172,337 B (71×14×76) | 19,268 B | — | 3,287,132 | 230 s |
| `de_vertigo` | H2 | 8,972,174 / 8,993,776 B | 0.02 MB | 7,250,484 B | 1,075,798 B | 416,865 B (57×157×76) | 8,500 B | 11,287 B | 795,387 | 72 s |

- Every map ships tier H2 (the lightmap where a primitive has 2 texels a vertex, vertex light
  elsewhere) with 256 px textures. In the first build Anubis, Dust2 and Overpass passed + 2.5 MB
  at H2 and fell to tier V (vertex light only), Inferno to tier V with 192 px textures (31,869,898
  B cap; tier V 32,216,995 B at 256 px, 30,776,912 B at 192): the user chose full lighting with a
  larger cap for those four, their first load before M2a + 5.0 MB (`lib/budgets.mjs`
  `FULL_LIGHTING_EXTRA`, 2026-10-25), and `build-assets.sh de_anubis de_dust2 de_inferno
  de_overpass` built all four at H2 in 1,021 s (the rows above; scratchpad build log
  `build-4.log`). Vertigo's first load is 21,602 B under its cap, Inferno's 377,795 B.
- Known edge: Vertigo, 21,602 B (0.2 %) under its cap. A rebuild that adds 22 kB to its first
  load (a new CS2 build or VRF export, a larger sky or light grid) puts it over, and the ladder
  then ships it at H2 with 192 px textures, or at tier V, without a word but the shrink's tier
  line and `check-map`'s row. Its cap stays the ruled + 2.5 MB; check Vertigo's tier after any
  rebuild, and a change to the cap needs a ruling.
- Downloads on Mirage at the default preset (2026-10-25; a fresh browser at 2560×1440 with no
  saved preset, so detection picked `high`; a link without a camera, so POV; the transport's
  download counter, which adds the page's Resource Timing `transferSize` and the pack worker's
  download): a cold load, 3 s after the view is ready, is **17.2 MB** (17,191,132 B), and the
  whole match played at 8× (294 s, to the end of round 24) **19.9 MB** (19,926,480 B), within
  the plan's 20 MB by 73.5 kB. Milestone 2b measured 15.2 and 17.3 MB the same way in Follow.
  The whole match by route: `maps/` 9.14 MB (`world.glb` 7.01, `lightmap.webp` 1.04, `hull.glb`
  0.81, the radar 0.14, `probes.bin` 0.14, `sky.webp`, `light.json`, `entities.glb` and the
  manifest 0.01), `players/` 4.44, the pack 2.62, `weapons/` 1.67, `viewmodels/` 0.78 (POV's
  arms and clips, which Follow never fetched: 0.11 at the cold load), `effects/` 0.65, the app
  0.43, fonts 0.11, the rest 0.08. Against milestone 2b: the bake adds 1.88 MB to the map
  (`world.glb` +0.69 MB with its light in `COLOR_0` and the lightmap UV, the lightmap 1.04, the
  grid 0.14, the sky and `light.json` 0.01), and POV 0.76 MB of arms and clips over the match.
- de_cache's sun is dynamic (`directlight "3"`): its lightmap is CS2's irradiance alone, its
  vertex light the probes' alone, and `light.json` has `sun.baked` false, so the viewer draws
  its sun at runtime (the first build of that path: 258 s with its 1,608-slice atlas, one map at
  a time, without running out of memory; the peak was not measured). Train's sun has brightness 0: `sun.intensity` 0, no sun in
  the bake, none at runtime.
- The shrink is faster than with the AO bake on the big maps (Train 936 → 230 s, Inferno 563 →
  289 s, Ancient 438 → 175 s).

Rebuilt again 2026-10-22 after the scene-wide quantization fix (commit d68afb6: `meshopt`
with `quantizationVolume: 'scene'` and 16-bit positions, so a wall and the floor it meets round
their shared edge to the same points instead of opening hairline cracks that showed the sky at
the lit presets). Every world got smaller, not larger, and the seams are gone on screen:

| Map | `world.glb` before → after | `world_hd.glb` before → after |
|-----|----------------------------|-------------------------------|
| de_mirage   | 11.66 → 11.38 MB | 27.0 → 26.7 MB |
| de_vertigo  | 14.22 → 13.30 MB | 43.2 → 42.2 MB |
| de_anubis   | 24.10 → 23.42 MB | 61.2 → 60.5 MB |
| de_dust2    | 25.78 → 24.61 MB | 58.9 → 57.7 MB |
| de_nuke     | 27.68 → 26.05 MB | 76.5 → 74.9 MB |
| de_overpass | 44.18 → 42.78 MB | 181.6 → 180.2 MB |
| de_ancient  | 58.53 → 57.27 MB | 149.0 → 147.7 MB |
| de_train    | 61.08 → 58.72 MB | 224.0 → 221.6 MB |
| de_inferno  | 64.18 → 61.32 MB | 179.6 → 176.7 MB |
| all nine    | 331.4 → 318.8 MB | 1,000.9 → 988.3 MB |

The maps were rebuilt into a scratch `ASSETS_DIR` (raw exports symlinked) with
`shrink-map.mjs`, `check-map.mjs --budget-override` and `manifest.mjs <map>`, then each finished
map directory was swapped into `assets/maps/` with two renames, so a server reading `assets/`
never saw a half-built map; 0.6–11 min per map under load. The rows below are from the
previous rebuild.

Rebuilt 2026-10-22 after the normals-strip follow-up (`shrink-map.mjs` now removes `NORMAL`,
`TANGENT`, `TEXCOORD_1/2` and `COLOR_*` before welding; commit 2209168): every world shrank by
25–40 % with no visible change and the nine maps are 1.42 GB served (was 1.69 GB). The rows
below are from that rebuild; the notes still describe the first build's findings. Overpass's
710 s shrink exceeded the 600 s wall budget while other work loaded the machine, which is why
that budget now only warns.

`tools/build-assets.sh all` on this machine (CS2 build 2000934, VRF 20.0.6980):
every map and the players `OK` in 3,667 s (first build). The first run, before `PER_MAP` and
`BUDGET_OVERRIDES` existed, took 4,415 s including the rips of the seven maps not
ripped before (23–73 s each) and failed the eight maps other than Mirage at
`check-map.mjs` on the Mirage budgets.
Between the two runs only the `world.glb` and `world_hd.glb` of the six maps with a
`PER_MAP` entry changed; every hull and all files of Dust2, Mirage and Overpass came
out byte-identical (same SHA-256). Sizes are decimal MB; "shrink s" is the second
run, with the first in brackets where it was slower; the screenshots are
`spike/viewer.html?f=world.glb&unlit=1&ao=1` (whole map in view), in `assets/spike/`
(gitignored). The Nuke, Overpass and Inferno rows are from a rebuild of those three
after the final review narrowed `clip` and `sky_` in the drop rule (`tools/build-assets.sh
de_nuke de_overpass de_inferno`, all `OK` in 1,472 s), with the earlier run in brackets.

| Map | `world.glb` MB | Tris | `world_hd.glb` MB | Hull MB | Sections | Shrink s | Screenshot | Notes |
|-----|---------------:|-----:|------------------:|--------:|----------|---------:|------------|-------|
| `de_ancient` | 58.53 | 3,471,988 | 148.95 | 12.89 | default | 438 | `de_ancient-phase2.jpg` | `PER_MAP` water: the pool showed as white patches between the trees. 9.20 M raw triangles (walls of individual bricks, banyan trees); simplify stops at 38%. |
| `de_anubis` | 24.10 | 1,379,495 | 61.17 | 8.23 | default | 213 | `de_anubis-phase2.jpg` | `PER_MAP` water: the sea and the canal were a white sheet beside the map; the canal bed is there underneath. Stone blocks modelled one by one. |
| `de_dust2` | 25.78 | 1,744,309 | 58.91 | 4.61 | default | 197 | `de_dust2-phase2.jpg` | No `PER_MAP` entry; nothing to fix in the screenshot. |
| `de_inferno` | 64.18 | 3,542,954 | 179.61 | 31.94 | default | 563 | `de_inferno-phase2.jpg` | `PER_MAP` water (the fountain). The lit `window_opaque_1b_lit_sky` windows are kept since the final review. AO 557 s of the wall time (4.60 M vertices), over the 600 s budget; the collision mesh is render-grade (2.68 M triangles). |
| `de_mirage` | 11.66 | 546,164 | 27.00 | 1.43 | default | 86 | `de_mirage-phase2.jpg` | The acceptance map: meets every budget with no override; files and manifest bytes (54,190,639) as before. |
| `de_nuke` | 27.68 | 1,503,774 | 76.50 | 1.74 | default, lower | 304 | `de_nuke-phase2.jpg` | `PER_MAP` water (`nuke_water`, the lower level at −20.6 m); the river is a textured material and stays. Hull within 2 MB. The desk clipboards (7,498 raw triangles) are kept since the final review. |
| `de_overpass` | 44.18 | 1,923,151 | 181.57 | 10.50 | default | 710 | `de_overpass-phase2.jpg` | No `PER_MAP` entry; nothing to fix in the screenshot. The desk clipboards (2,752 raw triangles) are kept since the final review. |
| `de_train` | 61.08 | 3,288,498 | 224.01 | 16.86 | default, lower | 936 | `de_train-phase2.jpg` | `PER_MAP` water (the chemical spill). AO 699 s (5.04 M vertices; 816 s in the first run), over the 600 s budget. |
| `de_vertigo` | 14.22 | 791,427 | 43.17 | 2.10 | default, lower | 196 | `de_vertigo-phase2.jpg` | `PER_MAP` drops the intro's news helicopter (hung 250 m off to the side). The model is 411 m tall (the tower down to the street), so the whole-map view is a thin tower; `de_vertigo-phase2-top.jpg` is the roof close up. |

`node tools/check-map.mjs <map> --budget-override` is `all checks OK` for all nine;
without the flag only Mirage passes. Every map renders at 217–235 fps in the viewer
on this machine. The nine maps are 1.70 GB served, two thirds of it `world_hd.glb`.
Why the other eight miss the Mirage budget (the newer maps model detail as geometry,
and simplify stops at 38–55% of the triangles on topology, not on the error bound),
the spike past the fixed parameters (`lockBorder` off: Anubis 857 k, Vertigo 826 k,
Ancient 1.03 M with its foliage shredded), and how the ceilings are derived are in
the design doc's Active Duty ladder.

## Syncing to a server

```sh
tools/sync-assets.sh --dry-run     # print what would change, send nothing
tools/sync-assets.sh
tools/sync-assets.sh --allow-unlisted   # a tree that builds only some maps or kinds (a scratch remote)
```

**Order: deploy the image first, then sync, and never roll the image back after a sync.**
Since milestone 2b, `world.glb` no longer holds the doors and breakable windows. They are in
`entities.glb`, which a viewer from before milestone 2b never fetches: assets synced under that
image would show holes where the doors and windows were. Since milestone 2a, a baked map's
`world.glb` carries vertex light in `COLOR_0` (and the lightmap UV in `TEXCOORD_1`) where it
carried AO, and its `entities.glb` the probes' light: a viewer from before milestone 2a has no
baked path and would draw that light as AO, with no fallback. The new image on the old assets is
safe: their manifests list no `entities.glb` or bake files, so the viewer draws the doors and
windows the old `world.glb` still holds, with its AO. Rolling the image back after a sync needs
the old assets synced again first (the root README's Deploy has how to keep them). The tree
synced is `$ASSETS_DIR`, main's `assets/` by default: build it with `tools/build-assets.sh all`,
or, for milestone 2a, refresh it from the m2a worktree's built assets after the merge (the root
README's Deploy has the command).

**The first sync after `world_hd.glb` retired** deletes it, and its `.gz`, from the server
(below), and a web image from before c34ff97 still fetches it for a viewer with HD on, who would
lose the 3D view. So, in this order:
1. Deploy a web image at or after c34ff97 and confirm it is the one live (production runs
   c34ff97 since 2026-10-27).
2. Rewrite the ten map manifests, then the root one: `node tools/manifest.mjs <map>` for each
   map of `lib/maps.mjs` `MAPS`, then `node tools/manifest.mjs root`. Each takes under a second
   and needs no shrink; the sync refuses a map manifest that still lists `world_hd.glb`.
3. `tools/sync-assets.sh --dry-run`: its second pass should list each map's
   `*deleting maps/<map>/world_hd.glb` and `world_hd.glb.gz` among its deletions, and no
   manifest deleted. Then `tools/sync-assets.sh`.

Runs `rsync -a --delay-updates --exclude /raw --exclude /spike --exclude build.log
--exclude '*.tmp-*' --filter 'H /maps/*/world_hd.glb' --filter 'H /maps/*/world_hd.glb.gz'
--itemize-changes "$ASSETS_DIR/" "$DEMOVIEWER_ASSETS_REMOTE/"` twice. The `H` (hide) rules are
`lib/maps.mjs` `MAP_RETIRED`, read with `node`: a sender-side exclude, so a map shrunk before
`world_hd.glb` retired never sends it, and the second pass's `--delete` takes the remote's copies
off (an `--exclude` would protect them). `/raw`
and `/spike` are anchored at the tree's top and match a symlink as well as a folder: a
worktree's `assets/raw` is a symlink to the shared raw tree, which `raw/` (folders only) would
send as a link. The first pass adds `--exclude manifest.json --exclude manifest.json.gz`: every
file but the manifests, deleting nothing, so the old manifests still find every file they list.
The `.gz` waits too because the server sends it in the manifest's place to a client that accepts
gzip (the sounds manifest has one): sent in the first pass, it would name banks not there yet.
The second sends the manifests and adds `--delete --delete-delay`, deleting what the tree no longer has (excluded
paths on the remote are left alone), which leaves the remote as one `rsync --delete` would. So a
manifest is replaced only once every file it lists is in place: a viewer never gets a new
manifest beside an old `world.glb`, or naming a `probes.bin` or `sky.webp` not there yet. For
the seconds between the passes an old manifest can meet a new file instead: a map opened then
draws its new `world.glb` as without a bake (its light read as AO) until it is opened again,
but no manifest ever names a file that is missing. Within a pass, `--delay-updates` holds every changed file in a
`.~tmp~/` directory and renames them all into place at its end, and `--delete-delay` deletes
after that, so an interrupted pass leaves the files it was sending on their old version, and
one interrupted before the second pass leaves every manifest on its old version. The cost is
extra space on the remote equal to the changed files while a pass runs: up to about 1.7 GB for
a full rebuild, on the target's disk. `--dry-run` runs both passes without
sending anything, so the second lists the files the first would have sent again.
The target, `DEMOVIEWER_ASSETS_REMOTE` (`[user@]host:/path`, or a local path), is the
directory the deployment mounts read-only as `/assets`. It comes from the environment, or
else from `tools/sync-assets.conf` (another file with `SYNC_ASSETS_CONF`), whose last
`DEMOVIEWER_ASSETS_REMOTE=` line names it:

```sh
# tools/sync-assets.conf: read, never sourced; no quotes, trailing blanks dropped.
DEMOVIEWER_ASSETS_REMOTE=deploy@example-host:/srv/demoviewer/assets
```

With neither, the sync refuses. rsync creates the remote
directory but never its parents, so a missing parent fails the sync instead of
being created: on a server whose data disk is not mounted, a path made there would
land on the root filesystem. `*.tmp-*` keeps a running
script's half-written output out. It refuses while
`build-assets.sh` is running, when `assets/manifest.json` is missing, and when a
map the root manifest lists (or the players, weapons, viewmodels, effects or sounds, when it lists
them) has no `manifest.json` of its own, or a map's manifest still lists a retired file
(`MAP_RETIRED`), which the sync would delete from beside it: rerun `node tools/manifest.mjs <map>`
for each map it names, then `node tools/manifest.mjs root` (the ten manifests built before
`world_hd.glb` retired all list it). It also refuses when the root manifest leaves out a map of
`lib/maps.mjs` `MAPS` or an asset kind of `lib/kinds.mjs` `KINDS` (players, weapons,
viewmodels, effects, sounds: absent or `null`), naming them: `manifest.mjs root` lists only the
maps whose manifest exists and writes `null` for a kind without one, and a build removes a map's
or a kind's manifest when it starts, so a build that failed one (a CS2 update that breaks the
bake fails all ten maps) leaves it out, and the second pass's `--delete` would take its manifest
off the server, which then cannot open the map or loses the kind. Rebuild them
(`tools/build-assets.sh <map>...`, which builds every kind on each run), or pass
`--allow-unlisted` to sync a tree that builds only some of them on purpose (a scratch remote). It
needs neither `CS2_DIR` nor `S2V_CLI`, since it only
reads what the build wrote, but it does need `node` for those checks.

## Files

| File            | What it does |
|-----------------|--------------|
| `lib/env.sh`    | Input resolution for bash scripts (see Environment). |
| `lib/rip.sh`    | The rip protocol every `rip-*.sh` but `rip-entities.sh` sources after `lib/env.sh`, so each keeps only its export list: `rip_begin <dest>` (a fresh `<dest>.tmp-<pid>/` with an empty `rip.log`), `rip_cli <what> <args…>` (the CLI with its command line and output appended to `rip.log`, dying with the tail of that output on a non-zero exit), `rip_cli_output`, `rip_commit` (the previous export moved aside to `<dest>.old-<pid>/`, the new one renamed in, the old one put back if that fails), `rip_added` (for an export added beside the old one), `rip_field <json> <key>`, `rip_fresh <json> [<vrf>]` (records the installed CS2 build, and that VRF when given), `rip_vrf`; and the one EXIT trap: any failure removes the temp dir, keeps `rip.log` as `<dest>.rip-failed.log`, and puts back a previous export still moved aside. |
| `lib/cli.mjs`   | `isMain(import.meta.url)`: whether a module is the script node was started with, both paths realpathed (a script run through a symlinked checkout knows itself), and never under `node -e`/`-p`, whose `argv[1]` is an argument (a bash script importing a lib by its path there). Every script with a command line runs its main only then, so any of them can be imported for its exports (phone-tier.mjs reads the shrinks' `PARAMS`). |
| `lib/kinds.mjs` | `KINDS`: the asset kinds built once a run after the maps (players, weapons, viewmodels, effects, sounds), in build order, each `{ name, steps, check, gz, root, rootLine }`; `kindOf(name)`, `kindPaths(kind)` → `{ out, raw, manifest, manifests }`, `buildPlan(kinds?)`; `node tools/lib/kinds.mjs names|plan` for `build-assets.sh`. A new kind is an entry here and its builder in `manifest.mjs` `KIND_MANIFESTS` (a test holds the two together). |
| `lib/maps.mjs`  | `ACTIVE_DUTY` (the nine map names) and `LOWER_RADAR` (the maps with a lower radar), `MAP_GLBS` (every map's GLBs), `MAP_OPTIONAL_GLBS` (`entities.glb`) and `MAP_RETIRED` (`world_hd.glb`: removed by a shrink, never synced). Keep in step with `lib/env.sh`. Also `LIGHTMAP_MAPS`, `MAP_BAKE_FILES`, `MAP_FIRST_LOAD` and `firstLoadBytes(dir, names?)` (what a client downloads to open a map, `entities.glb` among it, `.gz` siblings counted). |
| `lib/paths.mjs` | `paths(map)` → `{ raw, out, world, hull, entities, radar, radarLower, overview, manifest, sky, rawSky, rawLightmaps }` under `ASSETS_DIR` (read on every call); `PLAYERS_DIR`, `ROOT_MANIFEST`, `SOUNDS_DIR`, `RAW_SOUNDS_DIR`. |
| `lib/entities.mjs` | `parseEntities(text)` (class, model, origin, angles, name, parent name, start state, hammer id, spawn animation, and every key in `kv`), `hiddenAtStart`, `hiddenNodes`; `MOVABLE_CLASSES`, `movableEntities`, `entityNodes`, `anglesToGltfQuat`, `splitMovables(doc, movables, entities)` → `{ doc, nodes }`, `entityRootProblems(doc, movables)`, `entityChecks({ movables, doc, bytes, budget })` (check-map's rows); `skyOf(...lists)`, `skyMaterialOf(entities)`, `skyboxMapOf(entities)`, `sunOf(entities)`, `vec3`, `UNIT`. |
| `lib/poses.mjs` | `poseSkinnedProps(doc, models)` → `{ posed, unknown, errors }` (skinned props into their drawn pose), `animationPose(doc, anim?)` → `{ anim, joints }` (each joint's skinning matrix in an animation's first frame), `usedJoints(doc)`, `modelOf(node)`, `readModelPoses(rawDir)` (`raw/<map>/model-poses.json` or null), `staleModelPoses(table, rip, map)` (why the table is not the rip's, and the fix), `MODEL_POSES_FILE`. |
| `lib/vrf.mjs` | `parseVrfVersion(text)` (the rest of the first `Version:` line), `vrfVersion(cli)`; `node tools/lib/vrf.mjs <cli>` prints it. The one parser of the CLI's version, for every rip (`lib/rip.sh` `rip_vrf`) and `model-poses.mjs`. |
| `model-poses.sh` / `model-poses.mjs` | `<map>... \| all`: `raw/<map>/model-poses.json` from the map's raw world and Source2Viewer-CLI exports of its skinned models (see Shrinking a map). |
| `lib/stage.mjs` | The one temp name and what writes through it (see Output layout): `tmpPath(target, pid?)` (`<target>.tmp-<pid>`), `writeFileAtomic(file, data)`, `writeFilesAtomic([[file, data]…])` (every file written before any is renamed), `writeJsonAtomic(file, obj, { gz? })`, `staging(target)` → `{ dir, file, write, commit(into, names), abort }`, `renameInto(from, into, names)`; `leftoverOf(name)`, `pidAlive(pid)` and `sweepLeftovers(root)`, which `node tools/lib/stage.mjs sweep <dir>` runs for `build-assets.sh`. |
| `lib/map-build.mjs` | `MapBuild(map, paths, { log?, now? })`: one shrink-map run's staging directory and stage log, which main, the bake and the tier ladder (`shrink-map.mjs` `walkTiers`) share in place of a bag of closures: `stage(key, msg)` (the timed line and `stages`), `seconds()`, `write`, `unwrite`, `has`, `file`, `gzip(names)` (`gzBytes`), `firstLoad(names)`, `install()` (`installMapOutputs`, then the staging directory goes) and `abort()`. |
| `lib/install.mjs` | `installMapOutputs(tmp, out, written)`: renames every file a shrink wrote (GLBs, bake files, `.gz` siblings, `shrink.json`) into place and removes the optional outputs it did not write (a stale `entities.glb`, stale bake files) and the retired ones (`world_hd.glb`). |
| `rip-map.sh`    | `<map> [--force]`: VRF exports into `assets/raw/<map>/` (see Ripping a map). |
| `rip-lighting.sh` | `<map> [--force]`: the map's sky (material, texture, prefab entities) into `assets/raw/<map>/sky/` (see Sky), and its baked light into `assets/raw/<map>/lightmaps/` (see Lightmaps). |
| `lib/lightmap.mjs` | The lightmap (see Lightmaps): `lightmapInputs`, `readHdr`, `readShadow`, `readChart`, `lightmapUv`, `dropLightmapUv`, `fitsCharts`, `coverage`, `bakeSun`, `downscale`, `dilate`, `chooseRange`, `lightBytes`, `encodeLightmap`, `decodeLightmap`, `lightmapWebp`, `LIGHTMAP_PARAMS`. |
| `lib/light.mjs` | The shipped bake (see Shrinking a map): `LIGHT_PARAMS`, `texelsPerVertex`, `keepsLightmapUv`, `sampleLight`, `materialIds`, `sourceLight`, `applyVertexLight`, `lightJson`, `lightJsonProblem(json)` (check-map's light.json row), `lightChecks`, `litCheck`. |
| `lib/exr.mjs`   | `readExr(file)` → `{ width, height, data }`, RGBA float32 rows top-down, through three's `EXRLoader`. |
| `sky.mjs`       | `<map>... \| all`: `assets/maps/<map>/sky.webp` and `sky.json` (see Sky); exports `buildSky(exr, { yaw })` → `{ webp, exposure, horizon }`, `skyExposure(exr)`, `skyShift(yaw, width)`, `skyMap(map)`, `SKY_WIDTH`, `SKY_HEIGHT`, `SKY_QUALITY`, `SKY_MEDIAN`, `HORIZON_BAND_DEG`, `BLEND_DEG`, `SKY_MAX_BYTES`. |
| `lib/filters.mjs` | `shouldDrop(nodeName, vmatName, shaderName, map?)`, `DROP_NODE`, `DROP_VMAT_PREFIXES`, `DROP_SHADERS`, `materialFails(vmatName, shaderName, map?)`, `PER_MAP`, `perMap(map)`, `perMapParams(map)`, `shouldDropWith(entry, …)`, `vmatOf(material)`. |
| `lib/budgets.mjs` | `BUDGET` (the Mirage acceptance), `BUDGET_OVERRIDES` (per-map ceilings, the design doc's Active Duty ladder, plus each map's first-load cap), `OVERRIDABLE`, `budgetFor(map, override)`, `FIRST_LOAD_BEFORE_M2A`, `FIRST_LOAD_EXTRA`, `kb(bytes)` and `mb(bytes)` (the map tools' `19 KB` and `8.33 MB`). |
| `lib/ao.mjs`    | `bakeAo(doc, { rays, maxDist, occluders })` → `{ vertices, seconds, occluderTris }` (`occluders`: a document whose triangles in reach shade the bake but are not baked); `triangleSoup(doc, { under, within })` (world-space triangles, quantized positions decoded); `AO_DEFAULTS`. |
| `lib/kv.mjs`    | `parseKv(text)`: Valve KeyValues1 into nested objects of strings. |
| `lib/overview.mjs` | `overviewFromKv(map, kv, images)` → `Overview` (section names in lower case only, as the viewer reads them), `sectionsFromKv(map, kv)`, `sectionImage(name)`, `overviewProblem(ov, map)` (check-map's overview.json row), `worldToRadar(x, y, ov)`, `RADAR_SIZE`. |
| `lib/gltf.mjs`  | `createIO()` (NodeIO with all extensions and the meshopt codec, warnings printed once each), `countTris(doc)` (per node instance), `listMaterialsFailing(doc, map?)`, `stripAttributes(doc, names)` (`JOINTS_n`/`WEIGHTS_n` only off meshes no skinned node draws); re-exports `MeshoptEncoder`, `MeshoptDecoder`, `MeshoptSimplifier`. |
| `shrink-map.mjs` | `<map>`: `world.glb`, `hull.glb`, `entities.glb` on maps with doors or breakables, `shrink.json`, and with a bake `lightmap.webp`, `probes.bin`, `light.json` (see Shrinking a map). |
| `radar.mjs`     | `<map>`: `radar.png`, `radar_lower.png` when the map has a lower section, `overview.json` (see Radar and overview); exports `buildRadar(map, rawDir, outDir)`. |
| `hero.sh` / `hero.mjs` | `<map>... \| all`: CS2's own screenshot of the map (pak01 `panorama/images/map_icons/screenshots/1080p/<map>_png.vtex_c`) as `hero.png`, 1200×630 cropped to cover, the background of the match preview card the server draws for Discord; in no manifest (the browser never loads it). A map CS2 has no screenshot of is reported and skipped (its card shows the radar). `hero.mjs <screenshot.png> <out.png>` exports `buildHero(src, out)`. |
| `check-map.mjs` | `<map> [--budget-override]`: budget table for `assets/maps/<map>/`; exit 1 on any failing row. The rows are `checkMap(map, { paths, budget })`'s, which `test/gates.test.mjs` runs over fixture maps, as it does each gate's below. |
| `lib/report.mjs` | The gates' table: `row`, `warnRow`, `collector()` (a gate's rows as it adds them), `failures(rows)`, `reportLines(title, rows)`, `exitWithReport(title, rows)` (prints, exits 1 on any FAIL). |
| `lib/players.mjs` | `PLAYER_MODELS`, `SIDES`, `CLIP_SET` (the allow list by family), `WEAPON_CLIP_SUFFIX`, `WEAPON_SHOOT_CLIP`, `CLIPS_REQUIRED`, `CLIPS_OPTIONAL`, `CLIPS_REQUESTED`, `TRANSLATED_BONES`, `WORLD_CLIP_PREFIX`, `PLAYER_DROP_NODE`, `clipBase(name)`, `worldClipBases(doc)`, `selectThirdPerson(doc)`, `stripBoneChannels(doc)`, `disposeClip(anim)`, `orphanSamplers(doc)`, `playerPaths(side)`. |
| `lib/skin.mjs`  | `skinSurvives(before, after)`, `clipNames(doc)` (sorted animation names). |
| `rip-players.sh` | `[--force]`: VRF exports of the CT and T agents into `assets/raw/players/` (see Players). |
| `lib/weapons.mjs` | `WEAPON_MODELS` (normalised name → vmdl path), `WEAPON_NAMES`, `GROUND_MODELS` (the kit), `MODEL_PATHS`/`MODEL_NAMES` (both), `selectWeaponBody(doc)`, `takeModelAttach(name, doc)`, `weaponPaths([name])`. |
| `rip-weapons.sh` | `[--force]`: VRF exports of the 45 weapon world models and the kit into `assets/raw/weapons/`, or of the missing ones only beside a current rip (see Weapons). |
| `shrink-weapon.mjs` | `<name>\|all`: `assets/weapons/<name>.glb`, `.glb.gz` and `.shrink.json`; exports `shrinkWeapon(name, io, rip)` and `PARAMS`. |
| `check-weapons.mjs` | budget table for `assets/weapons/` (`checkWeapons()`); exit 1 on any failing row. |
| `lib/viewmodels.mjs` | `VIEWMODEL_DIRS` (weapon model name → clip folder), `VIEWMODEL_DIR_LIST`, `CLIP_KINDS`, `CLIP_OVERRIDES`, `REQUIRED_KINDS`, `HELPER_BONE`, `WEAPON_BONES_KEPT`, `TYPICAL_MATCH`, `clipSuffix(names)`, `selectClips(name, names)`, `trackAtRest(values, rest)`, `copySkeleton(doc, src, weaponBones)`, `copyClip(doc, bones, src, name, weaponBones)`, `listClips(dir)`, `viewmodelPaths([name])`, `armsPaths(side)`. |
| `rip-viewmodels.sh` | `[--force]`: VRF exports of the viewmodel clip folders into `assets/raw/viewmodels/` (see Viewmodels). |
| `shrink-arms.mjs` | `<ct\|t\|all>`: `assets/viewmodels/arms_<side>.glb`, `.glb.gz` and `.shrink.json`; exports `shrinkArms`, `selectFirstPerson`, `reskinArms`, `stripUnseen`, `PARAMS`. |
| `shrink-viewmodel-clips.mjs` | `<name>\|all`: `assets/viewmodels/<name>.glb`, `.glb.gz` and `.shrink.json`; exports `shrinkViewmodelClips` and `PARAMS`. |
| `check-viewmodels.mjs` | budget table for `assets/viewmodels/` (`checkViewmodels()`); exit 1 on any failing row. |
| `lib/effects.mjs` | `EFFECTS` (the atlas table), `EFFECT_KEYS`, `EFFECT_SOURCES`, `EFFECTS_BUDGET`, `ATLAS_WIDTH`, `parseMks(text)`, `layoutAtlas(count, cell)`, `placeFrame(w, h, seqMaxW, seqMaxH, cell, anchor)`, `selectFrames(effect, sheets)`, `decalAlpha(data)`, `effectsPaths()`. |
| `lib/alpha.mjs` | `fitTextures(doc, limit)`, `fitImage(image, limit, keepAlpha)`, `resizeApart(data, width, height, w, h)`, `bleed(data, width, height)`, `alphaTextures(doc)`, `fitWithin(size, limit)`. |
| `rip-effects.sh` | `[--force]`: VRF exports of the effect textures into `assets/raw/effects/` (see Effects). |
| `build-effects.mjs` | `[<key>…]`: `assets/effects/<key>.webp` and `build.json` (see Effects). |
| `check-effects.mjs` | budget table for `assets/effects/` (`checkEffects(P?)`); exit 1 on any failing row. |
| `lib/kv3.mjs` | `parseKv3(text)`: Valve KeyValues3 text (what VRF decompiles soundevents and surface properties to) into plain objects. |
| `lib/sounds.mjs` | The sound tables (see Sounds): `SOUNDEVENT_FILES`, `SOUND_DIRS`, `STATIC_SOUNDS`, `WEAPON_SOUNDS`, `weaponSoundKeys(events)`, `stepSets(footsteps, vsurf, events?)`, `resolveLayers(events, name)`, `surfaceOfNode(name)` (a hull node's surface), `typicalMatchBanks(build, weapons, nodeNames)` (check-sounds' typical match). |
| `lib/sound-bank.mjs` | `BANK_PARAMS`, `decodeClip(file)`, `trimTail(pcm, thresholdDb?)`, `packBank(clips, gapS?)` → `{ pcm, spans }`, `encodeBank(pcm, out)` (see Sounds). |
| `rip-sounds.sh` | `[--force]`: VRF exports of the soundevents, the surface properties and the sounds into `assets/raw/sounds/` (see Sounds). |
| `build-sounds.mjs` | `[--list-missing]`: `assets/sounds/<bank>.webm` and `build.json` (see Sounds); `--list-missing` prints the VPK paths the rip still has to export. Exports `buildSounds(rawDir, outDir)`, `missingFiles(rawDir)`, `VPK_PATH`. |
| `check-sounds.mjs` | budget table for `assets/sounds/`, the typical match among it (`checkSounds(dir?)`); exit 1 on any failing row. |
| `shrink-player.mjs` | `<ct\|t>`: `assets/players/<side>.glb` and `<side>.shrink.json` (see Players). |
| `check-players.mjs` | budget table for `assets/players/` (`checkPlayers()`); exit 1 on any failing row. |
| `manifest.mjs`  | `<map>\|players\|weapons\|viewmodels\|effects\|sounds\|root`: the manifests (see Manifests); exports `mapManifest(map, outDir, rawDir)`, `playersManifest(outDir, rawDir)`, `weaponsManifest(outDir, rawDir)`, `viewmodelsManifest(outDir, rawDir)`, `effectsManifest(outDir, rawDir)`, `soundsManifest(outDir, rawDir)`, `rootManifest(assetsDir)`, `fileEntry(file)`, `MAP_FILES`, `SCHEMA` (it writes each manifest with `lib/stage.mjs` `writeJsonAtomic`). |
| `build-assets.sh` | `<map>... \| all [--force]`: every step for the named maps, then the players, the weapons, the viewmodels, the effects, the sounds and the root manifest; log in `assets/build.log` (see Building everything). |
| `sync-assets.sh` | `[--dry-run] [--allow-unlisted]`: rsync of the served tree to `$DEMOVIEWER_ASSETS_REMOTE` (see Syncing to a server). |
| `spike/`        | Throwaway prototypes the fixed pipeline parameters came from; not part of the pipeline. |

The `package.json` scripts `shrink:map`, `radar`, `check:map`, `players:shrink`,
`check:players`, `weapons:shrink`, `check:weapons`, `arms:shrink`, `viewmodels:shrink`,
`check:viewmodels`, `effects:build`, `check:effects`, `sounds:build`, `check:sounds` and `manifest` run from `tools/`
(`npm run shrink:map -- de_mirage`, `npm run players:shrink -- ct`,
`npm run manifest -- root`).
