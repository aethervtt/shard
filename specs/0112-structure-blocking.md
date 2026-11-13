# 0112 — Structure that blocks: colliders, navigation and doors

- **Status:** draft
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
| `structure/model` | `.` | `core/transform` | components, records, pieces, chunk sets, the edit log |
| `structure` | `.` | model, `render/forward` | chunk meshes, leaves, panes, contact shade (as today) |
| `structure/physics` | `./physics` | model, `physics3d` | colliders |
| `structure/nav` | `./nav` | model, `nav` | nav shapes and gates |

`compile.ts` is split along this line. Evaluating walls, slabs, openings and cutouts, which yields
records, `wallPieces`, chunk sets and validation errors, moves to `model.ts`, which imports nothing
from render. `rebuildChunk`, leaves and contact stay in `compile.ts` and read the model.
`geometry.ts` and `curve.ts` are already pure.

The model's `structure/sync` runs twice a frame: in `FixedUpdate` before `PhysicsSystems`, so an
edit made in `Update` or an earlier fixed system reaches colliders in that step, and in
`PostUpdate` before `structure/compile`. A run with no changes costs a tick compare per table.
Each run appends to an **edit log** of `{ entity, kind: 'geometry' | 'state' | 'removed' }`.
Consumers (compile, physics, nav) read it from their own cursor. Entries every cursor has passed
are dropped, so no consumer rescans the world.

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
| Door (Opening) | a box filling the gap, wall-thick | `state` closed or locked, and `movement: 'normal'` |
| Window (Opening) | a box filling the gap | `movement: 'normal'` |
| Hatch (Cutout) | the hole's slab | `state` closed or locked |
| Skylight (Cutout) | the hole's slab | always |

A door's collider is binary and doesn't follow the swing animation. A `geometry` log entry rebuilds
that owner's set (a wall's, plus its openings' when the wall moved). A `state` entry is one
`enableStatic`. Sets are created in entity order within a sync, so replays hash the same (0028).
`StructureSettings.colliders` holds `{ enabled, layers, mask, friction }`.

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
| Door | the gap through the wall, plus 0.2 m beyond each face; y from the floor to +0.5 m | open: none. closed: `closed`. locked: `closed \| locked`. `movement: 'none'`: none |
| Window | a link across the wall at floor height, `agentRadius + 0.1` from each face, if `sill ≤ windowClimb` (1.2 m) | `movement: 'none'`: none. Else `locked` |
| Hatch | the hole's footprint on its host's surface | closed or locked (shut, walkable): none. Open: `locked` |

`Opening.movement: 'none'` already means the opening doesn't block movement when closed (0055's
planar channel). It is how a game marks a window passable (smashed, open) or a door that never
blocks (a curtain). No new field.

**Filters.** `NavFilters` is a resource of up to 15 named filters, plus the default, which is
`NavAreas` as today. Detour's crowd has 16 filter slots. Each filter is
`{ areas?: Record<number, number>, exclude?: ('closed' | 'locked' | 'custom')[] }`, and its area
costs apply over `NavAreas`. `NavAgent.filter: string` (empty means default),
`findPath(…, { filter })` and `nav.path { filter }` take a name. Survivors are
`{ exclude: ['locked'] }`, and zombies are `{ exclude: ['closed', 'locked'] }`.

**Door width.** Erosion rounds the radius up to whole cells, and thin walls rasterize a cell wide.
At 0.2 m cells a 1 m door is shut to every radius from 0.25 m to 0.4 m; at 0.1 m cells it passes up
to 0.35 m (measured, recast-navigation 0.43.1). `structure/nav` warns `structure/door-too-narrow`
once per door and navmesh when `width < 2·⌈r/cs⌉·cs + 2·cs`.

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
NavBudget { ms: 2, tiles: 4, workers: 'auto' | number, replans: 32 }   // resource
```

- **Workers.** A queued tile packs its triangles, areas, gates and links into transferable arrays
  and runs `buildTile` on the platform pool (kind `nav/tile`). Each worker loads Recast once.
  `nav/bake` submits in tile-key order and applies finished jobs in submission order. Main-thread
  work stops at `ms` a frame. A tile re-dirtied while its job ran is resubmitted, and the stale
  result is dropped.
- **Inline.** With `workers: 0` or no pool, up to `tiles` tiles build each frame (at least one), in
  order and without a time check. Results are frame-exact, and `shard run`, replays and hash tests
  use this mode. With workers, the frame a tile lands in depends on the machine, so agent behaviour
  can differ between runs. The tile bytes never do.
- **Cold bake.** A navmesh's first bake uses the whole pool and ignores `ms` and `tiles`.
  `whenNavReady(world)` resolves when it's complete. A server awaits it before it accepts players.
  The server writes `NavCache` when it stops, so a restart loads warm.

### Replanning

- An agent's path records the tiles (`decodePolyId`) and gates it crosses. A tile landing marks
  only the agents that recorded it, which replaces 0037's "any version bump repaths every agent".
  A gate's flags changing marks only those whose filter the change affects.
- Marked agents replan, at most `NavBudget.replans` a frame, oldest first. Until then, Detour's
  corridor check stops an agent before a polygon its filter no longer passes.
- `NavGateAhead { entity, gate, flags }` fires once when an agent's next corner is on a `closed`
  gate its filter passes, within `radius + 1 m`. The survivor's game code opens the door; until then
  its collider blocks.

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
- **Replan by membership, not a global version.** A broken wall across town shouldn't send 300
  agents through `findPath` at once.
- **`Opening.movement` marks passable windows.** It's the existing planar channel with the same
  meaning, so servers using `planarBarriers` agree with the navmesh.
- **Roofs collide but don't feed nav by default.** No agent walks on them, and they would only add
  polygons and build time.
- **Two syncs a frame.** An edit made before physics is solid in the same step, and an edit made
  later is drawn in the same frame.

## Acceptance criteria

On the town fixture, in headless tests (`structureModelPlugin`, `structurePhysicsPlugin`,
`structureNavPlugin`, `physics3d`, `nav`; no render plugin, no GPU context), except render parity.

- [ ] **Headless.** The town gets every collider and a complete navmesh. No `Mesh3d` entity,
      `GpuContext` or render resource exists, and the manifest plugin `structure` under
      `display: false` gives the same result.
- [ ] **Cold and warm.** From no cache, model, colliders and the complete navmesh are in within
      `structure/town-cold`. With the cache written, a fresh app gets there within
      `structure/town-warm` and Recast builds 0 tiles.
- [ ] **Collider shapes.** For a straight, an arc and a Bézier wall, each with a door and a window,
      horizontal rays at 0.5 m intervals hit the wall face (± 1 cm plus `curveTolerance`) except in
      openings. A ray through a door gap hits the door's collider when it's closed or locked, and
      passes when it's open. A ray through a window gap hits the window unless `movement: 'none'`.
      Downward rays hit a floor except over a hole cutout, and hit a pitched roof at its slope.
- [ ] **Collider edits.** Adding, removing or splitting one wall (despawn one, spawn two) creates
      and removes only that wall's and its openings' sets, with the counts in `physics.describe`.
      `structure/sync` plus `structure/physics` and `structure/nav` take at most `structure/edit`
      on the main thread. A door toggle creates and removes no collider.
- [ ] **Nav edits.** For the same three edits, with workers and inline: the set of rebuilt tiles
      equals the tiles whose 0037 key differs on a from-scratch bake of the result (reference),
      and no contribution outside them is re-gathered (a gather counter). Every rebuilt tile lands
      within `nav/edit-frames` frames.
- [ ] **No hitches.** 50 wall edits in one tick, with 300 agents walking: no frame's main-thread
      `structure/*`, `physics/sync-in` and `nav/bake` together exceed `structure/edit-burst`. Every
      tile lands within `nav/burst-frames` frames, and no single tile build exceeds `nav/tile`.
      300 agents' `nav/agents`, replans included, stay within `nav/town-agents` (p95).
- [ ] **Doors and filters.** A door toggle builds 0 tiles, calls no Recast function, and takes at
      most `nav/gate`. From outside a one-door building to its back room, paths are complete for
      default, survivor and zombie when the door is open; complete for survivor and partial (ending
      at the door) for zombie when closed; partial for both when locked. With a second door,
      zombies route through it while the first is closed. Queries and crowd agents agree.
- [ ] **Windows and hatches.** Toggling `movement` on a window, or `state` on a hatch, builds 0
      tiles. A filter that doesn't exclude area 11 paths through a passable window by its link,
      and not through a blocked one. Nobody paths onto an open hatch.
- [ ] **Walls stop agents.** A character controller (0029) walking at 4 m/s into a wall, a closed
      door, and a window stops within 2 cm of the face plus the controller's offset, and stays out
      for 600 steps. Once the door opens, it walks through.
- [ ] **Replans.** A zombie routed through a door that shuts replans within 2 frames and arrives by
      the other door, or ends `unreachable` at the closed one when there is none. A wall built
      across one agent's path replans that agent. Agents whose paths cross neither replan 0 times
      (`nav.describe` counts). A survivor reaching a closed door gets one `NavGateAhead`.
- [ ] **Narrow doors.** A 1 m door on a navmesh with 0.2 m cells and a 0.3 m radius warns
      `structure/door-too-narrow` once. At 0.1 m cells it doesn't, and the door passes.
- [ ] **Determinism.** Two inline runs with the same edits and door toggles at fixed frames give the
      same world hash. A worker run ends with the same tile keys and bytes.
- [ ] **Render parity.** With `structurePlugin` added (GPU tier), colliders and tile keys are
      identical to the headless run, and 0055/0066/0067/0070's structure tests pass unchanged.
- [ ] **0037 kept.** The nav tests pass with the new flag layout: exclusion is exact for areas
      0–11, and a NavSource edit still rebuilds only its tiles, now without a gather.

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
