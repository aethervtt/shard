# 0037 — Navigation

- **Status:** implemented
- **Packages:** `@shard/nav` (new), `@shard/project`, `@shard/node`, `@shard/testing`, `@shard/cli`
- **Depends on:** 0024, 0028, 0029

## Context

Creatures wander, flee, and follow the player; a 2D enemy chases through a tile maze; a drone
patrols a base. All of it needs paths around obstacles and a way to follow them. VISION's v1 set
is grid A*, navmesh generation and pathfinding, and steering.

Navmesh generation is a solved problem with a standard implementation: Recast and Detour. It
compiles to WASM (`recast-navigation`), runs in Node and browsers, and gives generation, path
queries, and crowd simulation. Grids are simple enough to write in TypeScript, and 2D games need
them first.

## Goals

- `NavGrid`: a 2D grid (from a tilemap layer, a collider scan, or data) with walkable flags and
  costs, A* with diagonal rules, and path smoothing.
- `NavMesh`: generated from colliders and meshes tagged `NavSource`, with agent radius, height,
  step, and slope settings, baked into a cache and rebuilt per tile when sources change.
- Path queries on either: `findPath(world, from, to, options)` returning corners, plus nearest
  walkable point and raycast along the mesh.
- `NavAgent`: follows paths with arrive, avoidance between agents, and repathing when the target
  moves. It moves through the character controller (0029), the rigid body, or the Transform.
- Off-mesh links (jumps, ladders) as components.
- Everything inspectable: the mesh, the grid, and each agent's path as overlays and data.

## Non-goals

- Navmeshes on planet-sized spheres (M7 generates terrain nav per chunk on top of this).
- Flying and swimming 3D volume navigation.
- Formation movement and large crowd flow fields (later; the crowd here is Detour's).

## Design

Two plugins: `nav` (grids and navmeshes; loads the Recast WASM in `ready`) and `nav/grid` (grids
only, no WASM; NavMesh entities report `nav/no-navmesh`). Both run `nav/bake` in PostUpdate after
transform propagation and `nav/agents` in FixedUpdate before physics.

### Grids

```ts
NavGrid { source: 'data' | 'tilemap' | 'colliders', width: u32, height: u32, cellSize: vec2,
          origin: vec2, diagonal: 'no-corners' | 'never' | 'always', tilemap: entity,
          layer: string, blockingTiles: list(u16), data: handle('NavGridData'), mask: u16 }
```

- Grids lie in the XY plane; row 0 is the bottom (lowest y). Corners take the query's z.
- `tilemap` makes a cell per tile of the named layer (default: the first), with size, cell size,
  and origin from the tilemap's transform and `tileSize`. A tile blocks when it's non-empty, or
  only when it's in `blockingTiles`. Edits through `setTile` apply cell by cell from the layer's
  edit log. `colliders` rasterizes fixed (and body-less) colliders in `mask` into `width × height`
  cells, again whenever colliders are added, removed, or edited. `data` is a `*.navgrid.json`
  (`width`, `height`, base64 `costs`, 0 = blocked), hot reloaded; `NavGridDatas.add` works too.
- A* runs over TypedArrays with a generation counter per search and a per-cell neighbor mask
  cached per grid version, so queries neither allocate nor clear. Moves cost world distance times
  the entered cell's cost; the octile heuristic keeps results optimal. Neighbors with the same f
  go on a stack instead of the heap (a consistent heuristic never lowers f), which in a maze's
  corridors is most pushes. A walled-off goal gives the path to the closest reachable cell.
- Paths are string-pulled into corners by line of sight on the grid (Amanatides–Woo), never
  through a blocked cell, a squeezed corner (unless `always`), or a cell costlier than both ends.

### Navmeshes

```ts
NavSource { area: u8 = 0 }        // this entity's Collider (else its Mesh3d), and children's
NavMesh { agentRadius: f32 = 0.4, agentHeight: f32 = 1.8, maxClimb: f32 = 0.3, maxSlope: f32 = 45,
          cellSize: f32 = 0.2, cellHeight: f32 = 0.1, tileSize: u16 = 64,
          boundsMin: vec3, boundsMax: vec3 }       // equal bounds: every source
OffMeshLink { to: entity, bidirectional: bool = true, radius: f32 = 0.5, area: u8 }
```

- Settings live on the NavMesh entity (no separate settings resource): one entity per agent size.
- The bake gathers world-space triangles: collider shapes triangulated (ball, cuboid, capsule,
  cylinder, cone, heightfield; convex and trimesh by their mesh), else the render mesh. Children
  without their own NavSource bake with their ancestor's area. Sensors don't bake; skipped
  sources show in `nav.describe`.
- Tiles sit on a world-aligned grid (tile (0, 0) starts at the origin), so geometry moving never
  shifts other tiles. Each tile is built by Recast from the triangles overlapping it plus its
  border, with source area codes kept on walkable triangles, and becomes Detour tile data.
- A tile's key hashes the settings, its coordinates, its vertical range, an order-independent
  hash of its own triangles, and the links starting in it. An unchanged key keeps the tile; a
  known key loads it from the tile cache; only the rest run Recast. So a moved rock rebuilds the
  tiles it touches, and nothing changed means no bake at all.
- The cache (`nav/Cache`) is one file, `.shard/cache/nav/tiles.bin`, not an asset: the geometry
  comes from scenes, which the asset database doesn't import. Project hosts read it after
  `app.init()` and before scenes load (`loadProjectNavCache`); `shard bake nav` and `nav.bake`
  write it with the tiles in use.
- Areas carry costs: the `nav/Areas` resource (`{ 1: 3 }`), where 0 excludes an area. Scene files
  and `setNavAreas` change it; queries and crowds pick it up the next frame. Poly flags hold a bit
  per area 0–14 so exclusion is exact.

### Queries

```ts
const path = findPath(world, from, to, { out?, nav?, agent?, areas? })
// { corners: Float32Array (xyz), count, length, status: 'complete' | 'partial' | 'none', nav }
nearestPoint(world, point, out); navRaycast(world, from, to, hit)   // hit: { t, point, normal }
```

Grid and mesh queries share the API: the query picks the `NavGrid` or `NavMesh` containing
`from` (or `nav`). Results go into caller buffers. Grid queries don't allocate; navmesh queries
allocate small result objects inside the WASM wrapper.

### Agents

```ts
NavAgent {
  destination: vec3, target: entity, speed: f32 = 3.5, acceleration: f32 = 8,
  radius: f32 = 0.4, stoppingDistance: f32 = 0.2, avoidance: bool = true,
  repathInterval: f32 = 0.5, drive: 'character' | 'transform' | 'velocity',
  stopped: bool, nav: entity
}
NavAgentState { status: 'idle' | 'moving' | 'arrived' | 'unreachable', remaining: f32,
                corners: u16, velocity: vec3 }             // readonly
```

- Writing NavAgent repaths. With `target`, the destination follows that entity, and repathing
  happens when it moves more than a cell (mesh: the agent's radius) or `repathInterval` passes.
- Mesh agents use Detour's crowd with velocity-obstacle avoidance. Detour's separation is off: it
  pushes across the whole query range, so agents at the edge of a group settled short of their
  goals. Physics-driven agents write their real position into the crowd before each step.
  Grid agents use seek, arrive, and separation among neighbors in a spatial hash; with the
  transform drive they slide along blocked cells instead of entering them.
- `drive: 'character'` writes `CharacterIntent.move` (0029), in the character's frame (2D: x
  only), so agents collide and walk on slopes. `'velocity'` writes the rigid body's `Velocity`
  (keeping its vertical part in 3D). `'transform'` moves the entity directly. Without the
  controller or body a drive needs, the agent moves its Transform and `nav.describe` says so.
- Agents cross off-mesh links along Detour's traversal, whatever the drive, keeping their height
  above the surface (a character's capsule center) and arcing over the rise between the ends.
- Agents are root entities: they read and write `Transform` as world space.
- `unreachable` means a partial path: the agent still heads for the closest point.
- `NavArrived` and `NavUnreachable` events fire on status changes.

### Agent surface

- `nav.path { from, to, nav?, areas? }` returns status, corners, and length. `nav.describe` lists
  grids (source, size, walkable cells, problem), navmeshes (tiles, polygons, bounds, the last
  bake's built, cached, and kept tiles, totals), skipped sources, the cache, and agents with
  status, remaining distance, drive, and route.
- `nav.bake { save = true, force }` rebakes and reports tiles built. MCP: `nav_path`,
  `nav_describe`, `nav_bake`. CLI: `shard bake nav [--scene] [--force]`. Gameplay tests:
  `game.nav.path`, `game.nav.describe`, `game.nav.agent(path)`.
- The `navmesh` overlay draws polygon edges by area, off-mesh links as arcs, grid walkable-area
  outlines, and each agent's path (red when unreachable).
- A skill, `make-it-navigate.md`: tag sources, bake, add an agent, test that it arrives.
- **Errors:** `nav/no-navmesh`, `nav/bake-failed`, `nav/out-of-bounds`, `nav/not-ready`,
  `nav/invalid-grid`, `nav/bad-cache`.

## Decisions

- **Recast and Detour through WASM.** It's the reference implementation, and a TypeScript port
  would be months to reach its robustness. Grids stay TypeScript because they're simple and 2D
  games shouldn't load WASM for them (`nav/grid`).
- **Bakes are cached tiles keyed by geometry.** Baking is slow, and the key means a clean
  checkout and a warm cache agree, as with imports (0014). Keying per tile rather than per mesh
  makes the runtime rebuild and the on-disk cache the same mechanism.
- **Agents drive the character controller.** Navigation decides where to go and physics decides
  what's possible, so agents don't clip through props.

## Acceptance criteria

- [x] Grid A* on a 256×256 maze finds the optimal path (checked against a reference Dijkstra) in
      under 2 ms, with no allocation per query after warm-up.
- [x] A navmesh baked from a test level of boxes and ramps connects both floors through the ramp,
      and excludes a slope steeper than `maxSlope`.
- [x] A warm bake loads from cache without running Recast. Moving one `NavSource` rebuilds only the
      tiles it touches.
- [x] 50 agents cross a room through each other to swapped positions without overlapping by more
      than 10% of radius, and all reach `arrived`.
- [x] An agent with `drive: 'character'` follows a path up a ramp, grounded throughout.
- [x] An off-mesh link lets an agent reach an otherwise disconnected platform.
- [x] A 2D enemy with a tilemap grid chases a moving player through a maze in a gameplay test
      (`examples/maze-chase`).

## Open questions

- None blocking.
