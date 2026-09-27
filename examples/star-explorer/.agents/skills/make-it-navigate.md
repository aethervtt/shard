# Make it navigate

Add `"nav"` to `plugins` in `shard.json` (`"nav/grid"` for grid-only 2D games: no WASM).

**3D: a navmesh.** Tag level geometry with `nav/NavSource`: its `physics/Collider` (or, without one,
its `render/Mesh3d`) and those of children bake. One `nav/NavMesh` entity holds the settings:

```json
{ "name": "navmesh", "components": { "nav/NavMesh": { "agentRadius": 0.4, "agentHeight": 1.8,
    "maxClimb": 0.3, "maxSlope": 45 } } },
{ "name": "ground", "components": { "core/Transform": {},
    "physics/Collider": { "shape": "cuboid", "halfExtents": [20, 0.5, 20] }, "nav/NavSource": {} } },
{ "name": "swamp", "components": { "core/Transform": { "translation": [6, 0, 0] },
    "physics/Collider": { "shape": "cuboid", "halfExtents": [3, 0.5, 3] },
    "nav/NavSource": { "area": 1 } } }
```

- Area costs are the `nav/Areas` resource: `"resources": { "nav/Areas": { "1": 4 } }` makes area 1
  four times as costly (0 excludes it). Slopes steeper than `maxSlope` and gaps narrower than the
  agent don't bake.
- Jumps and ladders: `nav/OffMeshLink` on an entity at one end, `to` the entity at the other.
- Bake: `shard bake nav` (or the `nav_bake` tool) writes the tiles to `.shard/cache/nav`; loading
  then skips Recast. Moving a source at runtime rebuilds only the tiles it touches.

**2D: a grid.** A `nav/NavGrid` with `source: "tilemap"` on a `sprite/Tilemap` entity makes a cell
per tile, blocked where the `layer` has a tile (or only `blockingTiles`). `source: "colliders"`
rasterizes fixed 2D colliders; `source: "data"` reads a `*.navgrid.json`. `diagonal`:
`no-corners`, `never`, or `always`. Editing tiles with `setTile` updates the grid.

**Agents.** `nav/NavAgent` walks to `destination` or follows `target` (an entity path), repathing when
it moves. `drive: "character"` writes `physics/CharacterIntent` (slopes, steps, collisions), `"velocity"`
the body's `physics/Velocity`, `"transform"` moves it directly. `nav/NavAgentState` has `status`
(idle, moving, arrived, unreachable) and `remaining`; systems read `nav/NavArrived` and
`nav/NavUnreachable` events. From code: `findPath(world, from, to, { out })`, `nearestPoint`,
`navRaycast` from `@aethervtt/shard-nav`.

Check it as data: `nav_path` says whether two points connect, `nav_describe` lists tiles, skipped
sources, and each agent's route. In gameplay tests:

```ts
expect((await game.nav.path([0, 0, 10], [6, 3, -12])).status).toBe('complete')
await game.step(600)
expect(await game.nav.agent('enemy')).toMatchObject({ status: 'arrived' })
```

Turn on the `navmesh` overlay (`debug_overlays`) to see polygons by area, links, and paths.
