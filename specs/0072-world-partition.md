# 0072 — World partition and streaming

- **Status:** accepted
- **Packages:** `@aethervtt/shard-partition` (new), `@aethervtt/shard-scene`, `@aethervtt/shard-save`,
  `@aethervtt/shard-assets`, `@aethervtt/shard-protocol`, `apps/cli`
- **Depends on:** 0010, 0011, 0014, 0030, 0038, 0040, 0071

## Context

A scene file (0010) loads all at once. That's fine for a level, but an open world has tens of
thousands of placed things over many square kilometres. Loading all of it costs memory, spawn
time and draw calls for content nobody can see. As a single file, it's also one huge diff an
agent can't read.

Unreal's World Partition fixes both: the map is a grid of cells, each actor is stored in its own
file and belongs to a cell by position, and cells load and unload around streaming sources (the
player, the camera). Shard does the same with the formats it already has. A cell is an ordinary
scene file in a folder named for its grid, an agent edits the cell it's looking at, and the
runtime spawns and despawns whole cells around the sources.

0071's terrain streams its own pages and lives in the always-loaded scene. 0073 fills in what's
beyond the load range with baked stand-ins.

## Goals

- A `*.partition.json` asset: one or more grids (cell size, load range) and an always-loaded
  scene. Cells are plain scene files in `<grid>/<x>_<z>.scene.json`.
- Entities in cell files are authored in partition space, so moving one to another cell doesn't
  change its numbers.
- Cells load and unload around `StreamingSource`s (active cameras by default), with hysteresis
  and a spawn budget. A cell appears complete, with its assets loaded, in one frame.
- Runtime changes to an unloaded cell survive (a destroyed crate stays destroyed), and saves
  include them through 0038's diffs.
- Headless runs stream deterministically, so `shard test` and world hashes work in a partition.
- Tools to place entities in the right cell, validate cross-cell references, and see the
  partition as an image.
- Fixture: an 8 km × 8 km partition of 128 m cells holding 100 000 entities.

## Non-goals

- Data layers (sets of cells switched on and off by game state). That's a later spec, and the
  folder layout leaves room for it.
- Level instances (a building's cells reused in several places). Prefabs (0030) cover most of
  this.
- Server-driven streaming for multiplayer.
- Streaming terrain. 0071 does that itself.
- Splitting a cell's spawn across frames. Cells are kept small enough to spawn in one (see
  *Loading*).

## Design

### Files

```
worlds/island/
  island.partition.json
  always.scene.json          terrain, sky, sun, player, game managers
  main/                      a grid
    0_0.scene.json
    1_0.scene.json
    -3_2.scene.json
  large/                     a coarser grid for big things
    0_0.scene.json
```

```json
{
  "$schema": "../../.shard/schemas/partition.schema.json",
  "always": { "path": "always.scene.json" },
  "grids": [
    { "name": "main", "cellSize": 128, "loadRange": 384 },
    { "name": "large", "cellSize": 1024, "loadRange": 3000 }
  ],
  "vertical": false
}
```

- Cell `(x, z)` of a grid covers `[x × cellSize, (x + 1) × cellSize)` on X and Z. With
  `vertical: true`, cells are 3D (`x_y_z`), for space and very tall worlds.
- A cell file is a normal scene: assets block, entities, children, instances. Root translations
  are in partition space. A root entity belongs in the cell that contains its translation. One
  that doesn't is `partition/outside-cell` in `shard validate`, which names the right file.
- Grids differ in load range, not kind. A cathedral seen from 2 km goes in `large`, and a crate
  goes in `main`. `shard partition place --auto` picks the smallest grid whose cell size is at
  least the entity's bounds diameter.
- The importer writes an index (cells per grid, entity counts, bounds, file hashes) as the
  partition's artifact. The runtime never lists directories, and exports ship the index.

### References

- An entity field in a cell may point into its own cell or into the always scene. Anything else
  is `partition/cross-cell-reference`: the target comes and goes on its own schedule.
- The always scene may not point into a cell, for the same reason.
- Game code finds a streamed entity with `partitionEntity(world, 'main/3_1/house/door')`. It
  returns the entity, or `null` while the cell is unloaded.

### Runtime

```ts
PartitionInstance { partition: handle('partition/Partition'), enabled: bool = true }
StreamingSource { enabled: bool = true, rangeScale: f32 = 1, priority: u8 = 0 }
CellBound {}                    // a runtime-spawned entity that belongs to the cell it's in
StreamingBudget {               // resource
  entitiesPerFrame: 2000, readsInFlight: 8, unloadDelay: 2,   // seconds
  blocking: 'auto',             // 'auto' | true | false
  camerasAreSources: true
}
```

- `PartitionInstance` goes on the root entity. It loads the always scene as a child and then
  streams cells under it. The root may be a `Grid` (0040). Each cell gets a **cell root**, a child
  with `GridCell` and a translation for the cell's origin, and its entities are spawned under that
  root in cell-local coordinates (partition space minus the cell origin, computed in f64).
  Saving a cell converts back.
- **Which cells.** Source positions are read with `worldPosition64` and converted into partition
  space. A cell is wanted when its nearest point is within `loadRange × rangeScale` of a
  source. A loaded cell unloads after it has been beyond 1.2 × that for `unloadDelay` seconds. The
  check runs when a source has moved more than an eighth of the smallest cell size, or every 30
  frames. It walks only the cells in each source's range, using the index.
- **Order.** Wanted cells go nearest first, weighted by source `priority`, with the grid's range
  as the unit of distance, so a `large` cell 2 km away and a `main` cell 250 m away rank alike.

### Loading

1. **Read and parse** off the frame (`readText`, then JSON parse on the worker pool), up to
   `readsInFlight` at a time. In `shard dev` the cell is validated too, cached by file hash.
   Measure before keeping the worker: handing a parsed object back costs a structured clone,
   about what the parse saved. The worker pays off if it produces something cheaper to spawn
   than JSON (columns per component), and small cells may parse faster on the main thread.
2. **Assets.** Request loads for the cell's handles (0014) and wait until they settle.
3. **Spawn** the whole cell in one command batch in `First`, once its assets are ready, so it
   appears complete on the frame it appears. A frame spawns cells until `entitiesPerFrame` is
   spent, and always spawns at least one.
4. **Unload** despawns the cell root's subtree. `assets.collect()` runs at most every 2 s, after
   unloads.

Spawning a cell all at once keeps the model simple: there's no half-spawned cell for physics,
rendering or game code to handle. Cells over `entitiesPerFrame` are reported by
`shard partition stats` as `partition/cell-too-big`, with a suggested cell size.

**Blocking mode.** With `blocking: 'auto'`, headless apps and fixed-step tests stream
blocking: a cell that becomes wanted is read, its assets loaded and it's spawned before that
frame's `Update`. A world hash then depends only on input, as 0012 requires. Interactive
hosts stream asynchronously. Hashes from those runs aren't comparable, and `world.hash` says
which mode produced it.

### Entities that move, and runtime state

- A cell's entities stay members of their cell wherever they move. A rolling barrel that leaves
  its cell unloads when its home cell does. Things that roam (player, vehicles, companions) belong
  in the always scene or are spawned at runtime.
- Runtime-spawned entities belong to no cell and stay loaded, unless they have `CellBound`. A
  `CellBound` entity joins the cell containing its position when it's spawned and unloads with
  that cell (dropped loot, a corpse).
- **Unloaded state.** When a cell unloads, its changes are captured with 0038's rules: field diffs
  against the cell file, despawned paths, and its `CellBound` entities in full. They're kept in
  the `PartitionState` resource and applied when the cell loads again. Untouched cells produce an
  empty diff and cost nothing. `save/NoSave` entities aren't captured.
- `saveGame` writes `PartitionState` plus the diffs of loaded cells in a `partition` section.
  `loadGame` restores it before streaming resumes. A diff whose cell file has changed
  applies like any other stale scene diff (`save/stale-entity`).
- A cell file edited on disk reloads in place if loaded (0010's `reloadScene`), keeping its
  runtime diff.

### Tools

- `shard partition new <dir> --grid main:128:384`: the partition file, always scene and folders.
- `shard partition place [--auto]`: moves each misplaced root entity, with its subtree and any
  scene assets it uses, into the right cell file, creating it if needed. Its output lists the moves.
- `shard partition stats`: cells per grid, entities per cell (largest first), file sizes, and
  `cell-too-big` warnings.
- `shard validate` covers `outside-cell` and cross-cell references.
- Studio and `shard dev` stream around the editor camera. `partition.load` pins cells, so an
  agent can inspect a place without moving the camera there.

### Agent surface

- `partition.describe`: grids, loaded, pending and pinned cells, entities live, spawn time last
  frame (p95 over 120 frames), reads in flight, and the size of `PartitionState`.
- `partition.cells { rect?, grid? }`: cells in a region with state, entity count and file path.
- `partition.locate { entity | path | position }`: the cell file an entity or point belongs to.
- `partition.load { cells | around: { position, radius } }` and `partition.unpin`.
- `partition.map { size, mode: 'state' | 'density' }`: a top-down PNG of cells shaded by
  state or entity count, with sources marked.
- `debug.overlays` gains `partition-cells` (cell borders by state, load range circles).
- MCP tools: `describe_partition`, `locate_in_partition`, `partition_map`, `load_cells`.
- **Errors:** `partition/outside-cell`, `partition/cross-cell-reference`,
  `partition/cell-too-big`, `partition/bad-cell-name` (a file in a grid folder that isn't
  `<x>_<z>.scene.json`), `partition/unknown-grid`, `partition/duplicate-path` (two cells define one
  root path; paths include the cell, so only hand-made renames cause it).

## Decisions

- **Cells are scene files in folders, not a new format.** Validation, prefabs, instances, hot
  reload and saves work on them unchanged. An agent reads one 128 m square at a time.
- **Partition-space coordinates in files.** Moving an entity across cells is a file move with no
  arithmetic, and positions in different cells compare directly.
- **Whole cells spawn in one frame, after their assets.** Nothing has to cope with half a cell.
  The price is a cell size limit, which the tools report.
- **No cross-cell references.** A reference that's null whenever its target's cell is unloaded
  is a bug waiting to happen. The always scene is the place for anything shared.
- **Diffs for unloaded cells reuse 0038.** There's one diff format, and a pristine world stores
  nothing.
- **Blocking streaming headless.** Determinism is a core promise. Streaming order mustn't depend
  on disk speed.

## Acceptance criteria

- [ ] The fixture (8 km, 128 m cells, 100 000 entities across `main` and `large`) loads its
      always scene and the cells around the camera in under 1 s on the reference machine.
- [ ] Flying across the fixture at 100 m/s, every `main` cell within 0.8 × `loadRange` of the
      camera is spawned on every frame after the first second. Streaming main-thread time is
      under 2 ms a frame at p95.
- [ ] Live entities stay under 1.5 × the count in a full load range for the whole flight, and
      memory returns to within 10% of its starting value after flying back.
- [ ] No frame shows a partly spawned cell: each cell's entities all appear in the same frame
      (spawn ticks compared).
- [ ] A crate destroyed in a cell is still gone after flying 2 km away and back, and after a
      save and load. A `CellBound` item dropped there is still there.
- [ ] Two headless `shard run --frames 2000` flights over the fixture give the same world hash,
      in Node and in Chrome with blocking forced on.
- [ ] `shard validate` reports a reference from one cell into another with its file and
      pointer. `shard partition place` moves 50 misplaced entities to the right files, and a
      second run moves none.
- [ ] Editing a loaded cell file in `shard dev` updates it in place within 1 s, keeping its
      runtime diff.
- [ ] With the partition root as a `Grid` 10⁹ m from the world origin, entities in a cell show no
      jitter (0040's 0.01 px test).

## Open questions

- Answered: a dynamic body that leaves its cell stays a member of its home cell, as in Unreal.
  `CellBound` on a runtime entity covers loot, and moving authored entities between cell files at
  runtime would make diffs hard to read.
- Deferred, wanted: 2D streaming, for a metroidvania or any large 2D map. The same model on X and
  Y (`plane: 'xy'`, cells `<x>_<y>.scene.json`), with sources from `Camera2d` and 2D physics
  bodies. Probably also cells shaped by rooms rather than a square grid, so a room loads whole
  with its neighbours prefetched through its doors. It needs its own short spec when a 2D project
  wants it.
