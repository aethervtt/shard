# 0037 — Navigation

- **Status:** accepted
- **Packages:** `@shard/nav` (new)
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
  step, and slope settings, baked into a cached asset and rebuilt per tile when sources change.
- Path queries on either: `findPath(world, from, to, options)` returning corners, plus nearest
  walkable point and raycast along the mesh.
- `NavAgent`: follows paths with arrive, avoidance between agents, and repathing when the target
  moves. It moves through the character controller (0029) or directly on the Transform.
- Off-mesh links (jumps, ladders) as components.
- Everything inspectable: the mesh, the grid, and each agent's path as overlays and data.

## Non-goals

- Navmeshes on planet-sized spheres (M7 generates terrain nav per chunk on top of this).
- Flying and swimming 3D volume navigation.
- Formation movement and large crowd flow fields (later; the crowd here is Detour's).

## Design

### Grids

```ts
NavGrid { width: u32, height: u32, cellSize: vec2, origin: vec2, diagonal: 'never' | 'no-corners' | 'always',
          source: 'data' | 'tilemap' | 'colliders', tilemap: entity, layer: string,
          data: handle('NavGridData') }
```

- `tilemap` source marks cells walkable when the tile is empty on the named layer (or by a tile
  flag list). `colliders` rasterizes fixed 2D colliders into cells. Data is a
  `*.navgrid.json` (base64 costs, 0 = blocked).
- A* uses a binary heap over TypedArrays with a generation counter per search, so queries don't
  allocate or clear. Paths are string-pulled into corners (line of sight on the grid).

### Navmeshes

```ts
NavSource { area: u8 = 0 }                               // this entity's colliders and mesh feed the bake
NavMeshSettings (resource or per NavMesh entity) {
  agentRadius: f32 = 0.4, agentHeight: f32 = 1.8, maxClimb: f32 = 0.3, maxSlope: f32 = 45,
  cellSize: f32 = 0.2, cellHeight: f32 = 0.1, tileSize: u16 = 64, bounds: aabb
}
NavMesh { settings..., baked: handle('NavMeshData') }
OffMeshLink { to: entity, bidirectional: bool = true, radius: f32 = 0.5, area: u8 }
```

- Baking collects the world-space triangles of every `NavSource` (collider shapes triangulated,
  or the render mesh), runs Recast per tile, and stores Detour tile data. `shard bake nav` and the
  `nav.bake` method write it as a `NavMeshData` asset under `.shard/cache`, keyed by a hash of the
  source geometry and settings, so a warm cache loads instantly and a changed rock rebuilds one
  tile at runtime.
- Areas carry costs (`NavAreas` resource: `{ 0: 1, 1: 3 }`, e.g. swamp is slower).

### Queries

```ts
const path = findPath(world, from, to, { agent?, areas?, out })   // Float32Array corners, count
nearestPoint(world, point, out); navRaycast(world, from, to, out)
```

Grid and mesh queries share the API: the query picks the `NavGrid` or `NavMesh` containing
`from`. Query results reuse caller buffers.

### Agents

```ts
NavAgent {
  destination: vec3, target: entity, speed: f32 = 3.5, acceleration: f32 = 8,
  radius: f32 = 0.4, stoppingDistance: f32 = 0.2, avoidance: bool = true,
  repathInterval: f32 = 0.5, drive: 'character' | 'transform' | 'velocity'
}
NavAgentState { status: 'idle' | 'moving' | 'arrived' | 'unreachable', remaining: f32,
                corners: u16, velocity: vec3 }             // readonly
```

- With `target`, the destination follows that entity, and repathing happens when it moves more
  than a cell or `repathInterval` passes.
- Mesh agents use Detour's crowd for steering and avoidance. Grid agents use simple seek, arrive,
  and separation among neighbors in a spatial hash.
- `drive: 'character'` writes `CharacterIntent.move` (0029), so agents collide and walk on slopes.
  `'velocity'` writes the rigid body's `Velocity`. `'transform'` moves the entity directly.
- `NavArrived` and `NavUnreachable` events fire on status changes.

### Agent surface

- `nav.path { from, to }` returns corners and length. `nav.describe` lists grids and meshes (tiles,
  polygons, bake time, cache hits) and agents with status and remaining distance.
- `nav.bake` rebakes and reports tiles built. The `navmesh` overlay draws polygons by area, off-mesh
  links, and each agent's path.
- A skill, `make-it-navigate.md`: tag sources, bake, add an agent, test that it arrives.
- **Errors:** `nav/no-navmesh`, `nav/bake-failed`, `nav/out-of-bounds`.

## Decisions

- **Recast and Detour through WASM.** It's the reference implementation, and a TypeScript port
  would be months to reach its robustness. Grids stay TypeScript because they're simple and 2D
  games shouldn't load WASM for them.
- **Bakes are cached assets keyed by geometry.** Baking is slow, and the key means a clean
  checkout and a warm cache agree, as with imports (0014).
- **Agents drive the character controller.** Navigation decides where to go and physics decides
  what's possible, so agents don't clip through props.

## Acceptance criteria

- [ ] Grid A* on a 256×256 maze finds the optimal path (checked against a reference Dijkstra) in
      under 2 ms, with no allocation per query after warm-up.
- [ ] A navmesh baked from a test level of boxes and ramps connects both floors through the ramp,
      and excludes a slope steeper than `maxSlope`.
- [ ] A warm bake loads from cache without running Recast. Moving one `NavSource` rebuilds only the
      tiles it touches.
- [ ] 50 agents cross a room through each other to swapped positions without overlapping by more
      than 10% of radius, and all reach `arrived`.
- [ ] An agent with `drive: 'character'` follows a path up a ramp, grounded throughout.
- [ ] An off-mesh link lets an agent reach an otherwise disconnected platform.
- [ ] A 2D enemy with a tilemap grid chases a moving player through a maze in a gameplay test.

## Open questions

- None blocking.
