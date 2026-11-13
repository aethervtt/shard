# 0112 — Structure that blocks: colliders, navigation and doors

- **Status:** implemented (in three parts: the model and colliders; nav sources, gates and
  filters; budgeted rebuilds and replans)
- **Packages:** `@aethervtt/shard-structure`, `@aethervtt/shard-physics`, `@aethervtt/shard-nav`,
  `@aethervtt/shard-project`
- **Depends on:** 0028, 0029, 0037, 0055, 0066, 0067, 0092

## Context

Structure (0055, 0066, 0067) builds walls, doors and windows as render meshes only. It makes no
colliders and the navmesh never reads it, so a character walks through a wall and an agent paths
through one. The plugin also requires `render/forward`, so a `display: false` server (0092) can't
load it at all.

The game that needs this is like Project Zomboid. It's a server-authoritative town of a few hundred
buildings with hundreds of agents on one navmesh. Walls are broken, barricaded and built while it
runs, and doors open and shut all the time. Nav (0037) can't keep up with that today. Any change
re-gathers and rehashes every source in the world (`bake.ts`, `gather`), builds every dirty tile in
the same frame, and any tile change repaths every agent. It has one query filter per navmesh, and
it has no notion of a door.

## Goals

- A render-free structure model a headless server runs; render compile is one of its consumers.
- Colliders for walls, floors and roofs, with openings cut out, and for doors, windows and hatches
  by state. An edit touches only the colliders of what it changed.
- Structure as a direct nav source, with doors, windows and hatches as **gates** whose polygon
  flags change at runtime, and named filters that decide who passes.
- Edits re-bake only the tiles they touch, with no world gather, on workers under a frame budget;
  only agents whose paths cross a change replan.

## Non-goals

- Wall health and damage (game code removes or splits the wall), world streaming, line of sight.
- Detour TileCache and temporary obstacles (see Decisions), 2D structure, nav on clients.
- Replicating structure: games list `replicate(Wall)` and the rest (0087). Clients run the same
  model, so their colliders match the server's.

## Design

### Model, render and bridges

`@aethervtt/shard-structure` splits into four plugins:

| Plugin | Entry | Needs | Does |
|---|---|---|---|
| `structure/model` | `.` | `core/transform` | components, records, pieces, the edit log |
| `structure` | `.` | `render/forward` | chunk meshes, leaves, panes, contact shade (as today) |
| `structure/physics` | `./physics` | `physics3d` | colliders |
| `structure/nav` | `./nav` | `nav` | nav shapes and gates |

`structure`, `structure/physics` and `structure/nav` add `structure/model` when it's missing, so
hosts that add only `structurePlugin` keep working. `model.ts` imports nothing from render; it
evaluates walls (their shape and solid pieces, no frames), openings, slabs (triangulated, cutouts
accepted) and cutouts. Render compile keeps its own records (they hold leaves, chunk sets and
contact quads) but takes the same path through the shared pure functions: `wallShape`,
`curveDrawable` and `acceptCutouts` in `model.ts`, and `geometry.ts` and `curve.ts`. So with a
display, evaluation runs twice: once for the model, once for compile.

The model syncs twice a frame: `structure/sync-fixed` in `FixedUpdate`, before `PhysicsSystems`,
so an edit made in `Update` or an earlier fixed system is solid in that step; `structure/sync` in
`PostUpdate`. They share the tick they last saw, so an edit is read once. A run with no changes
costs a tick compare per table. Each run appends to an **edit log** of `{ entity, part, kind }`
(`kind`: `geometry`, `state` or `removed`), in entity order. Consumers read it from their own
cursor, and entries every cursor has passed are dropped, so no consumer rescans the world. A
consumer that starts late, or whose settings change, rebuilds from the records and reads on from
the log's end. `structure.describe` belongs to the model; the render state and colliders add
their sections to it.

The manifest gains an engine plugin `structure`. It adds `structure/model`, adds `structure` when
there is a display, and adds `structure/physics` or `structure/nav` when the manifest has
`physics3d` or `nav`. `display: false` keeps the model and the bridges.

### Blocking shapes

One function, `blockingShapes(record)`, gives physics and nav the same geometry. Pieces are
`wallPieces` output, at their level's elevation:

- **Straight wall pieces:** an oriented box (centre, half extents, yaw).
- **Curved wall pieces:** one convex hull per sampled interval of the centreline, which is the same
  subdivision compile draws (0066, `curveTolerance`).
- **Floors and roofs:** the slab's triangles (top, plus underside and rims when `thickness` > 0),
  with cutouts as holes, as compile triangulates them.
- **Frames don't block.** They stand 4 cm off the face and would turn every wall into many shapes.

### Colliders

Physics gains **owned static colliders**. These are colliders with no `Collider` component,
owned by an entity that query hits and events report:

```ts
physics.setStatic(owner, shapes, { layers, mask, friction })  // replaces the owner's set
physics.enableStatic(owner, on)                                // no rebuild
physics.clearStatic(owner)
```

They count in `physics.describe` (as `static`), draw in the `colliders` overlay, and answer
`raycast` and `overlap*` with `entity: owner`.

| Owner | Collider | Enabled |
|---|---|---|
| Wall | its pieces' shapes | always |
| Floor, Roof | slab trimesh | always |
| Door (Opening) | the whole hole (frames included), wall-thick | `state` closed or locked, and `movement: 'normal'` |
| Window (Opening) | the whole hole, wall-thick | `movement: 'normal'` |
| Hatch (Cutout) | the hole's slab | `state` closed or locked |
| Skylight (Cutout) | the hole's slab | always |

A door's collider is binary and doesn't follow the swing animation. The hole is the span
`wallPieces` cut the wall around (it reports each opening's `[s0, s1, sill, head]`), so the
wall's and the door's colliders meet with no gap. A `geometry` log entry rebuilds that owner's
set (a wall's, plus its openings' when the wall moved or its openings changed); a `state` entry
is one `enableStatic`. An opening's frame, swing or material is neither. Sets are created in
entity order within a sync, so replays hash the same (0028). `StructureSettings.colliders` holds
`{ enabled, layers, mask, friction }`; a patch may hold only some of them, and any change
rebuilds every structure collider. `StructureColliders` (a resource) holds the owners and what the
last update built, toggled and removed.

Static colliders map their Rapier handles to the owner in `colliderEntity`, so ray hits, contact
events and a character's ground report the owner without other changes. Collision events read a
collider's sensor flag by handle, since an owner isn't in `colliders`; an origin shift (0040)
moves static sets too.

### Nav: shapes, gates and filters

**Shapes.** `nav.shapes` holds non-entity sources: world-space triangles with an area code, keyed
by owner. Structure sets one entry per wall, floor and hatch (the hatch's hole, filled), and none
for roofs unless `StructureSettings.nav.roofs` is set.

**Gates.** `nav.gates` holds regions, keyed by owner, whose polygons get runtime flags:

- **Area gates** are a convex footprint (x, z) with a y range and an area code. The tile build
  marks it with `markConvexPolyArea` after erosion. Regions never merge across areas, so the gate's
  polygons are its own.
- **Link gates** are an off-mesh link (0037) with an area code.

A gate's footprint, range, area and link are part of its tiles' keys, but its flags aren't. When a
tile lands, nav finds the gate's polygons: polygons of its area whose centroid lies in the
footprint, or the link's polygon. It sets each one's flags to `areaFlags(area) | gate.flags`.
`setFlags` rewrites those flags with `navMesh.setPolyFlags`. It builds nothing and changes no key.

**Flag layout** (amends 0037). Detour flags are 16 bits:

- bits 0–11 are areas 0–11, one each, so excluding one of them is exact;
- bit 12 is shared by areas 12–62;
- bits 13–15 are gate state: `closed`, `locked` and `custom`.

**Structure's gates.** Areas come from `StructureSettings.nav`, which defaults to door 10, window
11 and hatch 9.

| Gate | Shape | Flags |
|---|---|---|
| Door | the gap through the wall, plus `gateMargin` (0.6 m) past each face; y within 0.5 m of the hole's floor | open: none. closed: `closed`. locked: `closed \| locked`. `movement: 'none'`: none |
| Window | a link across the wall at floor height, `windowReach` (0.5 m) past each face, if `sill ≤ windowClimb` (1.2 m) | `movement: 'none'`: none. Else `locked` |
| Hatch | the convex hull of the hole, on its host's surface (the hole itself is filled for nav) | closed or locked (shut, walkable): none. Open: `locked` |

`Opening.movement: 'none'` already means the opening doesn't block movement when closed (0055's
planar channel). It is how a game marks a window passable (smashed, open) or a door that never
blocks (a curtain). No new field.

**Filters.** `NavFilters` is a resource of up to 15 named filters, plus the default, which is
`NavAreas` as today. Detour's crowd has 16 filter slots. Each filter is
`{ areas?: Record<number, number>, exclude?: ('closed' | 'locked' | 'custom')[] }`, and its area
costs apply over `NavAreas`. `NavAgent.filter: string` (empty means default),
`findPath(…, { filter })` and `nav.path { filter }` take a name. Survivors are
`{ exclude: ['locked'] }`, and zombies are `{ exclude: ['closed', 'locked'] }`.

**Door width.** Erosion rounds the radius up to whole cells, each jamb can take a cell off the gap
(walls rasterize conservatively), and the passage needs about two cells left to survive contour
simplification. `structure/nav` warns `structure/door-too-narrow` once per door and navmesh when
`width < 2·⌈r/cs⌉·cs + 4·cs`. Measured on the town with doors at every grid alignment
(recast-navigation 0.43.1, r = 0.3 m): at 0.1 m cells every 1 m door passes and no 0.9 m one; at
0.05 m cells every 0.8 m door and no 0.7 m one; at 0.2 m cells 1.4 m passes (the rule asks 1.6 m,
one cell to spare).

A gate's footprint must reach past each face by more than the largest agent radius
(`gateMargin`): erosion clears that much beside the wall, and a gate left with only the sliver
inside the doorway is dropped by contour simplification, door and all. A shut gate's polygons are
excluded without erosion, so a path round them (an open hatch's hole) runs along their edge, and
an agent brushes it by its radius.

### Incremental bake

Each navmesh keeps a **tile index**: for every tile, the contributions overlapping it and its
border. A contribution is one `nav.shapes` owner, one entity `NavSource` subtree, a gate or a link.
Each holds its world triangles and their hashes (0037's per-triangle hash).

- A contribution that changes is re-gathered alone: a `nav.shapes.set`, or a watched entity's
  transform, collider, mesh or tag ticking. Its old and new tiles are marked dirty.
- A dirty tile's key is computed from its own contributions as in 0037. An unchanged key does
  nothing, a known key loads from `NavCache`, and anything else is queued for a build.
- `gather` and the per-frame world soup go away, for entity sources too. Framed navmeshes (0043)
  move each contribution into the frame as they did the soup.

### Budgeted rebuilds

```ts
NavBudget { ms: 1.5, tiles: 4, workers: true, replans: 6 }   // resource
NavWorkers                                                   // resource: the host's pool
```

- **Workers.** With a pool in `NavWorkers`, a dirty tile's triangles, areas, gates and links go to
  it as transferable arrays (job kind `nav/tile`), and `nav-worker.js` builds them with
  `tile-build.js`, the same plain-JavaScript builder the main thread runs. Each worker loads Recast
  once. Finished jobs apply in the order they were sent. The frame's main-thread nav work (reading
  and placing what changed, applying jobs, keying and packing tiles) stops at `ms`, after at least
  one tile. A tile dirtied again to a different key while its job runs is sent again, and the old
  result is dropped; one dirtied to the same key keeps its job.
- **Hosts.** The project's `nav` engine plugin sets `NavWorkers` to the platform's pool on Node.
  Browsers don't walk agents, so they build inline. A pool that can't load Recast (a bundle without
  it) warns `nav/workers-unavailable` once, and tiles build inline from then on.
- **Inline.** With no pool or `workers: false`, up to `tiles` tiles build each frame (at least
  one), in order and without a time check. Results are frame-exact, and `shard run`, replays and
  hash tests use this mode. With a pool, the frame a tile lands in depends on the machine, so agent
  behaviour can differ between runs. The tile bytes never do.
- **Cold bake.** A navmesh's first bake ignores `ms` and `tiles` and uses the whole pool.
  `navReady(world)` says whether every navmesh is baked, and `whenNavReady(world)` resolves when the
  bake system finds them so. `bakeNavigation(world)` bakes to completion now, without frames, for
  startup and `nav.bake`. Server game code spawns its world in systems, after `shard server`
  starts, so the server doesn't wait itself: game code awaits `whenNavReady` before letting players
  in if it needs to. `shard server` writes `NavCache` when it stops, so a restart loads warm.

### Replanning

- An agent's path records the Detour tile indexes (read from the polygon refs' bits) and gates it
  crosses, and its filter's excluded gate states. When tiles land, only agents that recorded one of
  their old slots are marked. A gate's flags changing marks only agents whose path crosses it and
  whose filter excludes a bit that changed. Agents with no full path are marked on any change,
  since it may open one. This replaces 0037's "any version bump repaths every agent"; a navmesh
  that grew (every ref changed) still replans everyone.
- Marked agents replan, at most `NavBudget.replans` a frame, in table order. Until then, Detour's
  corridor check stops an agent before a polygon its filter no longer passes.
- `NavGateAhead { entity, gate, flags }` fires once when an agent comes within its radius + 1 m of
  a `closed` gate on its path that its filter passes. The survivor's game code opens the door;
  until then its collider blocks.

### API sketch

```ts
import { structureModelPlugin, StructureSettings } from '@aethervtt/shard-structure'
import { structurePhysicsPlugin } from '@aethervtt/shard-structure/physics'
import { structureNavPlugin } from '@aethervtt/shard-structure/nav'
import { GATE_CLOSED, Nav, NavFilters, findPath, whenNavReady } from '@aethervtt/shard-nav'

app.addPlugin(structureModelPlugin).addPlugin(structurePhysicsPlugin).addPlugin(structureNavPlugin)
// StructureSettings.colliders { enabled, layers, mask, friction }
// StructureSettings.nav { enabled, floorArea: 0, doorArea: 10, windowArea: 11, hatchArea: 9,
//                         roofs: false, windowClimb: 1.2 }
world.insertResource(NavFilters, {
  survivor: { exclude: ['locked'] },
  zombie: { exclude: ['closed', 'locked'], areas: { 11: 0 } },  // and never through windows
})
world.spawn([NavAgent, { destination, filter: 'zombie', drive: 'character' }], Transform)
findPath(world, from, to, { filter: 'survivor' })              // through closed doors
world.set(door, Opening, { state: 'locked' })                  // setPolyFlags; no tile builds
await whenNavReady(world)

// The generic API structure uses (games may use it too):
const nav = world.resource(Nav)
nav.shapes.set(owner, positions, area)                          // world triangles, xyz × 3 each
nav.gates.set(owner, { points, yMin, yMax, area, flags: GATE_CLOSED })
nav.gates.set(owner, { link: { start, end, radius, bidirectional }, area, flags })
nav.gates.setFlags(owner, 0)
physics.setStatic(owner, [{ kind: 'cuboid', center, halfExtents, yaw }], { layers, mask, friction })
```

### Fixtures

`town({ seed, buildings = 200 })` in `@aethervtt/shard-structure/fixtures` lays out a grid of
20 m lots on a ground floor of about 300 × 280 m. Each building has one to three rooms, 0.2 m
walls 3 m tall (one in five curved), a front door, interior doors and windows, and 40 crates as
entity `NavSource` cuboids. Its navmesh has cell size 0.1, cell height 0.1, tile size 64 (6.4 m
tiles), agent radius 0.3 and height 1.8, which comes to 2,068 tiles. `townAgents(n)` places agents
with survivor and zombie filters.

### Agent surface

- `structure.describe` adds collider and gate counts by kind, the edit log's length, and
  door-width warnings.
- `nav.describe` adds shapes and gates (owner, flags, polygons), filters, the rebuild queue (dirty,
  in flight, landed this frame, worker or inline), and replans this frame and in total.
  `physics.describe` adds `static` sets. `nav.path` takes `filter`.
- The `navmesh` overlay colours gate polygons by flags (open, closed, locked).
- Errors: `structure/door-too-narrow` (warn), `nav/unknown-filter`, `nav/too-many-filters`,
  `nav/gate-unmatched` (warn: a gate whose tile has no polygon of its area in its footprint).

## Decisions

- **The model splits from render, and the bridges are plugins.** The server runs the same geometry
  path the client draws, with no render code loaded. Subpath entries keep Rapier and Recast out of
  hosts that don't use them.
- **Owned static colliders, not `Collider` entities.** A wall is several shapes with no Transform,
  and hits must report the wall. Thousands of derived entities would add sync and save churn for
  nothing.
- **Binary door colliders.** Gameplay needs only blocked or not. Following the swing would cost a
  kinematic body per door and shove whoever stands in its arc.
- **Doors are area gates with runtime flags, not links or obstacles.** The crowd steers through a
  real polygon with avoidance, and a toggle is `setPolyFlags` with no rebuild. A link would funnel
  everyone through one point and switch steering off on it.
- **Windows are link gates.** A window is crossed by climbing over the sill, which is what a link
  is.
- **Three state bits, and exact area exclusion only for areas 0–11.** Filters need state they can
  exclude. Areas beyond 11 can still be priced.
- **Up to 15 named filters.** Detour's crowd has 16 filter slots, and the default takes one.
- **No Detour TileCache.** Its obstacles are carve-only boxes and cylinders, it needs a second
  build pipeline and cache format, and plain Recast tiles (about 0.85 ms each) already fit a budget
  on workers.
- **A per-tile contribution index for every source.** Rebuilding only the touched tiles is
  pointless if finding them means walking the world.
- **Workers by default, inline when determinism matters.** A 0.1 m-cell tile is about a frame's
  whole budget on one thread. Counting tiles, not milliseconds, keeps inline runs frame-exact.
- **The host hands nav its pool; nav doesn't detect the platform.** Engine packages get host
  services through the platform, and only Node hosts walk agents.
- **One tile builder for both threads, in plain JavaScript.** A worker imports it with no loader,
  and a tile built on either thread is the same bytes.
- **Replan by membership, not a global version.** A broken wall across town shouldn't send 300
  agents through `findPath` at once.
- **`Opening.movement` marks passable windows.** It's the existing planar channel with the same
  meaning, so servers using `planarBarriers` agree with the navmesh.
- **Roofs collide but don't feed nav by default.** No agent walks on them, and they would only add
  polygons and build time.
- **Two syncs a frame.** An edit made before physics is solid in the same step, and an edit made
  later is drawn in the same frame.
- **Compile keeps its records and shares the evaluation, rather than reading the model.** Compile's
  records carry leaves, chunk sets, contact quads and cutaway tags; moving them would touch most of
  its 2,000 lines and every structure golden for no gain in what's drawn. Sharing the functions
  that decide geometry keeps the two from disagreeing; evaluating twice costs microseconds per edit.

## Acceptance criteria

On the town fixture, in headless tests (`structureModelPlugin`, `structurePhysicsPlugin`,
`structureNavPlugin`, `physics3d`, `nav`; no render plugin, no GPU context), except render parity.

- [x] **Headless.** The town gets every collider and a complete navmesh. No `Mesh3d` entity,
      `GpuContext` or render resource exists, and the manifest plugin `structure` under
      `display: false` gives the same result.
- [x] **Cold and warm.** From no cache, model, colliders and the complete navmesh are in within
      `structure/town-cold`. With the cache written, a fresh app gets there within
      `structure/town-warm` and Recast builds 0 tiles.
- [x] **Collider shapes.** For a straight, an arc and a Bézier wall, each with a door and a window,
      horizontal rays at 0.5 m intervals hit the wall face (± 1 cm plus `curveTolerance`) except in
      openings. A ray through a door gap hits the door's collider when it's closed or locked, and
      passes when it's open. A ray through a window gap hits the window unless `movement: 'none'`.
      Downward rays hit a floor except over a hole cutout, and hit a pitched roof at its slope.
- [x] **Collider edits.** Adding, removing or splitting one wall (despawn one, spawn two) creates
      and removes only that wall's and its openings' sets, with the counts in `physics.describe`.
      `structure/sync` plus `structure/physics` and `structure/nav` take at most `structure/edit`
      on the main thread. A door toggle creates and removes no collider.
- [x] **Nav edits.** For the same three edits, with workers and inline: the set of rebuilt tiles
      equals the tiles whose 0037 key differs on a from-scratch bake of the result (reference),
      and no contribution outside them is re-gathered (a gather counter). Every rebuilt tile lands
      within `nav/edit-frames` frames.
- [x] **No hitches.** 50 wall edits in one tick, with 300 agents walking: no frame's main-thread
      `structure/*`, `physics/sync-in` and `nav/bake` together exceed `structure/edit-burst`. Every
      tile lands within `nav/burst-frames` frames, and no single tile build exceeds `nav/tile`.
      300 agents' `nav/agents`, replans included, stay within `nav/town-agents` (p95).
- [x] **Doors and filters.** A door toggle builds 0 tiles, calls no Recast function, and takes at
      most `nav/gate`. From outside a one-door building to its back room, paths are complete for
      default, survivor and zombie when the door is open; complete for survivor and partial (ending
      at the door) for zombie when closed; partial for both when locked. With a second door,
      zombies route through it while the first is closed. Queries and crowd agents agree.
- [x] **Windows and hatches.** Toggling `movement` on a window, or `state` on a hatch, builds 0
      tiles. A filter that doesn't exclude area 11 paths through a passable window by its link,
      and not through a blocked one. Nobody paths onto an open hatch.
- [x] **Walls stop agents.** A character controller (0029) walking at 4 m/s into a wall, a closed
      door, and a window stops within 2 cm of the face plus the controller's offset, and stays out
      for 600 steps. Once the door opens, it walks through.
- [x] **Replans.** A zombie routed through a door that shuts replans within 2 frames and arrives by
      the other door, or ends `unreachable` at the closed one when there is none. A wall built
      across one agent's path replans that agent. Agents whose paths cross neither replan 0 times
      (`nav.describe` counts). A survivor reaching a closed door gets one `NavGateAhead`.
- [x] **Narrow doors.** A 1 m door on a navmesh with 0.2 m cells and a 0.3 m radius warns
      `structure/door-too-narrow` once. At 0.1 m cells it doesn't, and the door passes.
- [x] **Determinism.** Two inline runs with the same edits and door toggles at fixed frames give the
      same world hash. A worker run ends with the same tile keys and bytes.
- [x] **Render parity.** With `structurePlugin` added (GPU tier), colliders and tile keys are
      identical to the headless run, and 0055/0066/0067/0070's structure tests pass unchanged.
- [x] **0037 kept.** The nav tests pass with the new flag layout: exclusion is exact for areas
      0–11, and a NavSource edit still rebuilds only its tiles, now without a gather.

## Implementation notes

### Part 1: the model and colliders

In the criteria above, part 1 meets these halves, checked in `colliders.test.ts` and
`project/src/plugins.test.ts`:

- **Headless:** every collider of the town, no `Mesh3d`, no render resource, and the manifest's
  `structure` under `display: false` adds `structure/model` and `structure/physics` only.
- **Collider edits:** adding, splitting and removing a wall build exactly the wall's and its
  openings' sets (`StructureColliders.last`), a door toggle builds nothing and toggles one, and a
  frame or swing edit does neither. `structure/sync` plus `structure/physics` stay within
  `structure/edit`.
- **Determinism:** two runs of the same edits build the same sets in the same order.
- **Render parity:** with `structurePlugin`, the colliders match the headless run's; every
  existing structure test passes unchanged.

Physics: `setStatic`, `enableStatic`, `clearStatic` and `isStaticEnabled` on `PhysicsWorld`, with
`statics` (owner → set) and `describe().static`; `static.test.ts`.

Measured on an Apple M5 Max (not a named machine), 2026-11-12, on the 200-building town (1,006
walls, 1,813 owners, 4,149 Rapier colliders): the first sync and colliders take 15–41 ms; one wall
edit takes 0.015–0.025 ms median (one 3.2 ms outlier in 120, likely a collection); a door toggle,
4–10 µs.

### Part 2: nav sources, gates and filters

Checked in `nav/src/gates.test.ts` and `structure/src/nav.test.ts`, headless. Doors and filters,
windows and hatches, narrow doors, render parity (tile keys too) and 0037 kept are met. For nav
edits, adding, removing and splitting a wall rebuild exactly the tiles whose key changed (a
from-scratch bake of the result keys every tile the same), and the bake re-reads only the walls
edited (`stats.gathered`); tiles still build inline, in the frame of the edit, until part 3.

- **Nav:** `nav.shapes` and `nav.gates` (`NavShapes`, `NavGates`) on `NavState`; sources are
  indexed per tile on each navmesh (`index`, `binned`, `gateIndex`), and a frame's changes mark
  only their old and new tiles. Framed navmeshes move each source into their frame once, when it's
  indexed. Dirty tiles bake row by row (z, then x), the order a single source's gather met them:
  Detour links tiles as they're added, and a path through a corner four tiles share depends on it.
  `BAKE_FORMAT` is `shard-2`, since the flag layout changed every tile's bytes.
- **Gates** need an area of 1 to 62 (`nav/invalid-gate`): area 0 is the ground's. Link gates go
  into `nav.links` with OffMeshLinks, so agents cross windows the way they cross links.
- **Filters:** `NavFilters` (up to 15, by sorted name), `NavAgent.filter`, `findPath({ filter })`
  and `nav.path`. An agent naming a filter nav/Filters lacks paths with the default and warns once.
- **Structure:** `structureNavPlugin` (`./nav`), `structure/nav-fixed` before nav's agents and
  `structure/nav` before its bake; `StructureSettings.nav` adds `windowReach` and `gateMargin`.
  The town fixture's interior doors are 1 m (0.9 m doors don't pass its own navmesh), and its front
  doors open into the first room, clear of interior walls.

Measured on an Apple M5 Max (not a named machine), 2026-11-12, on the 200-building town (2,160
tiles, 12,914 polygons), inline: the cold bake takes 1.13–1.17 s on one thread (0.52 ms a tile);
a wall edit rebuilds 3 tiles in a 3.4–3.6 ms frame (median; worst 5.9–15.4 ms), which part 3's
workers and frame budget take off the main thread; a door toggle's frame takes 0.01 ms; the model
sync and nav bridge, 0.03–0.06 ms an edit.

### Part 3: budgeted rebuilds and replans

Checked in `nav/src/pool.test.ts` and `structure/src/pacing.test.ts`. The burst and the cold and
warm bakes run at the spec's size (200 buildings, 300 agents) under `pnpm bench`, and at 30
buildings and 60 agents under `pnpm test`, where only correctness is held.

- **As built, against the design:** `NavBudget` is `{ ms: 1.5, tiles: 4, workers: true,
  replans: 6 }`. `workers` is a switch, since the pool is the host's. `ms` and `replans` came down
  from 2 and 32: a burst's first frame also pays structure's own sync (about 1.6 ms for 50 walls),
  and a replan across the town costs about 0.4 ms. The frame's budget counts from the start of
  nav's work, so reading and placing edited sources and applying finished jobs are inside it.
- Navmesh bounds grow as tiles come in and are recomputed only after a tile goes, once the bake
  settles: recomputing them every frame walked all 2,160 tiles through Detour (about 1 ms).
- A navmesh is placed again only when its bounds change, and a re-index finds gates' polygons
  again on tiles kept as they are. Without that, a door shutting after a re-index didn't reach
  agents.
- Structure pushes its shapes and gates in its systems, so `bakeNavigation` before a world's
  first frame bakes nothing of it: tests run a frame first.

Measured on an Apple M5 Max (not a named machine), 2026-11-13, against the laptop's budgets, on the
200-building town (2,160 tiles) with 300 agents and a 3-worker pool: the cold bake takes 459–483 ms
and the warm load 60–77 ms; 50 wall edits in one tick dirty about 500 tiles, which land within 9 frames,
the worst frame's structure, physics sync-in and nav bake take 3.41 ms (median 1.58 ms), the
slowest tile build on a worker 0.88 ms (mean 0.57 ms), and `nav/agents` stays within 4.04 ms
(p95) while 128 agents replan.

### Added by 0113 (streaming)

- `structure/Backdrop` (a tag on a wall, floor or roof, or its `Level`): drawn, no colliders, no
  nav shapes or gates; openings and cutouts follow their host. The model's records carry `solid`
  in their signature, and observers catch the tag coming and going.
- Wall and slab signatures now include their `level`: a piece moved to another level at the same
  elevation kept the old one in its record.
- `navReadyIn(world, minX, minZ, maxX, maxZ)`: `navReady` over a rectangle (dirty, building and
  pool-built-but-unapplied tiles under it, with the border; unplaced source changes count as not
  ready).
- `NavMesh.maxTiles` (default 256): the initial capacity, outside the bake settings so tile keys
  don't change; raising it reserves once.

## Open questions

- **Closing a door on someone.** The collider enables anyway, and the character controller pushes
  the occupant out. Should structure refuse or delay the close instead? Proposed: no. Game code
  checks `physics.overlapShape` first if it cares.
- **Bashing doors.** Should a filter be able to price a closed door (zombies that break through) and
  not only exclude it? Detour can rewrite a polygon's area at runtime (`setPolyArea`), so gate
  state could switch area as well as flags. Proposed: later, when a game needs it.
- **Barricades.** A barricaded door or window could be `locked`, or the `custom` bit, so filters
  can tell the two apart. Proposed: the game picks; structure sets only `closed` and `locked`.
- **Tile size per navmesh.** 6.4 m tiles at 0.1 m cells keep one build under a frame. A town four
  times bigger has 8,000+ tiles, which needs 13 tile bits in Detour's 22. Proposed: measure on a
  800-building town before raising anything.
