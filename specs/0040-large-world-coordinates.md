# 0040 — Large-world coordinates

- **Status:** accepted
- **Packages:** `@shard/core`, `@shard/transform`, `@shard/render`, `@shard/particles`,
  `@shard/physics`, `@shard/scene`, `@shard/save`
- **Depends on:** 0002, 0004, 0007, 0026, 0028, 0038

## Context

Every world position in Shard is f32 end to end: `Transform.translation`, `GlobalTransform`, the
instance buffer, lights, shadow cascades, particles, and Rapier. An f32 has 24 bits of mantissa, so
at 10 km from the origin a position is only good to about a millimetre and at 1 000 km to about
6 cm. That's enough for jitter you can see and physics you can feel. A star system is 10¹² m
across and a galaxy is 10²⁰ m, so the proof project can't be built on one f32 frame.

The standard fix, used by Bevy's `big_space` and most space games, is to split a position into
an integer **cell** and an f32 **offset** within the cell, and to render and simulate relative
to a **floating origin** that follows the camera. Nearby math stays in small f32 numbers, and
distant things stay exact because their cells are integers. Nesting grids (galaxy → star system →
planet) covers every scale without an f64 type.

Today every GPU buffer reads its positions from `GlobalTransform`, so the renderer changes very
little. If `GlobalTransform` is defined as "relative to the floating origin" instead of
"absolute", the instance buffer, lights, shadows, picking, sprites and audio all become
camera-relative without being touched.

## Goals

- `Grid` entities with a cell size and `GridCell` components on the entities inside them. A
  position is `cell × cellSize + translation`, exact at any distance.
- Grids nest and have their own `Transform`, so a planet's grid can orbit and spin inside a star
  system's grid, which sits inside the galaxy's grid.
- A `FloatingOrigin` entity (usually the camera). `GlobalTransform` is relative to the origin's
  cell, so everything near the origin stays small.
- Recentering: an entity whose translation leaves its cell moves to the neighboring cell. No
  visible jump, no physics impulse, and no TAA or motion-blur smear.
- Physics runs in the origin's frame and is shifted when the origin changes cells. Bodies far from
  the origin are paused, not simulated imprecisely.
- f64 helpers for code that needs absolute positions: distance between two entities in different
  grids, position of an entity in any grid's frame.
- Scenes, prefabs, saves, and the protocol read and write cells. A save made 10¹² m from the origin
  loads to the same millimetre.
- A project with no `Grid` behaves exactly as it does today, with zero extra cost.

## Non-goals

- An f64 `Transform`. Cells plus f32 offsets are cheaper, fit TypedArray columns, and keep every
  GPU path f32.
- Relativistic or orbital physics. Orbits are on rails (0046).
- Streaming scenes by cell (0043 streams terrain; scene streaming stays deferred).
- Large 2D worlds. 2D games keep one grid-less frame; `GridCell` works in 2D but isn't tested
  there.

## Design

### Components

```ts
Grid { cellSize: f64 = 2000, hysteresis: f32 = 100 }
GridCell { x: i32, y: i32, z: i32 }          // new field type: t.ivec3
FloatingOrigin {}                              // tag, at most one per world
```

- An entity is **in a grid** when its nearest `Grid` ancestor (or itself, for a nested grid) is
  that grid. Its position in the grid is `GridCell × cellSize + Transform.translation`. Entities
  without `GridCell` are in cell (0, 0, 0).
- Only direct children of a grid carry `GridCell`. Deeper descendants are positioned by
  their parent's transform as usual. A `GridCell` on an entity whose parent isn't a grid is
  `transform/cell-outside-grid`.
- A nested grid is an entity with both `Grid` and a `GridCell` in its parent grid. Its `Transform`
  (rotation included) places its frame in the parent grid, so a spinning planet is a rotation on
  its grid entity.
- Entities with no grid ancestor are in the implicit **root frame**, where everything works as it does today.
- `t.ivec3` is a new schema field (three i32, stored like `vec3`). `Grid.cellSize` is `t.f64`.

With i32 cells and nested grids:

| Grid | Suggested cell | Reach (±2³¹ cells) | f32 offset precision |
|---|---|---|---|
| Galaxy | 10¹² m | 2×10²¹ m (galaxy is ~10²¹) | ~60 km, fine for stars |
| Star system | 2 000 m | 4×10¹² m (~30 AU) | ~0.1 mm |
| Planet | 2 000 m | far beyond any planet | ~0.1 mm |

### The floating origin and `GlobalTransform`

- The origin is the `FloatingOrigin` entity's cell in its grid (its **origin grid**).
  `GlobalTransform` of every entity is its transform relative to the origin cell's corner,
  expressed in the origin grid's orientation. With no `FloatingOrigin`, the origin is cell 0 of
  the root frame, which is today's behavior.
- Propagation gets one new step before the existing one. `transform/grids` walks the grid tree
  (few entities) in f64 and computes, for each grid, an f64 affine from the grid's frame to the
  origin frame. The step is written into a scratch `Float64Array`. Then, for each direct child of a
  grid, root propagation seeds with
  `gridToOrigin × (cell − originCellInThatGrid) × cellSize + translation`. The cell difference is
  computed in integers first, then converted to f64, and the result rounded to f32. The existing
  inlined `fromTRS` path and child propagation are unchanged.
- Cell differences are integer math, so two ships 10¹² m from the world origin but 3 m from each
  other get a 3 m difference with f32 precision.
- If the origin grid, the origin cell, or any grid's transform changes, every entity under the
  affected grids is re-propagated that frame. A grid that doesn't move costs nothing on frames
  where the origin stays in its cell.
- Grids far from the origin (a planet 10¹¹ m away) still get a `GlobalTransform`. It's in the
  f32 range and imprecise, which is fine at that distance: it's a distant dot, and 0046 draws it as
  an impostor.

### Recentering

`transform/recenter` runs in PostUpdate before propagation. For each entity with `GridCell` whose
translation's largest component exceeds `cellSize / 2 + hysteresis`, it moves by whole cells:
`cell += k` and `translation -= k × cellSize`. It only runs on entities whose `Transform`
changed, so it's a change-detection query and not a full scan.

When the origin entity changes cells, the whole origin frame shifts by `Δ = oldCell − newCell`
cells. The `OriginShift` event (`{ grid, delta: ivec3, offset: vec3 }`, `offset = Δ × cellSize`
in origin-frame metres) lets consumers that keep state in the origin frame follow along:

- **Render history.** The previous-frame instance matrices, the previous view matrix, and the TAA
  history live in the old frame. On a shift, the renderer adds `offset` to `prevViewProj`'s
  translation and to the previous instance rows during the same upload. Reprojection lines up, so
  there's no smear. Shadow cascades are rebuilt from the new camera position as they are every frame.
- **Particles.** World-space particle positions live in GPU buffers. The simulate pass gets an
  `originOffset` uniform, added once on the frame of a shift.
- **Gizmos.** Retained world-space lines (`duration > 0`) are shifted on the CPU.
- **Physics.** See below.
- **Audio.** Nothing to do: listener and sources are read from `GlobalTransform` every frame.

User code that caches `GlobalTransform` positions across frames subscribes to `OriginShift`. Code
that needs a stable position stores `GridCell` + `Transform`, or calls `worldPosition64`.

### Physics

- Rapier stays the f32 build. It simulates in the origin frame: sync-in reads `GlobalTransform`,
  and sync-out writes back into `Transform` through the parent's inverse, as today.
- On `OriginShift`, every body and collider is translated by `offset` with
  `setTranslation(…, wakeUp: false)`. Velocities and contacts are unchanged. The interpolation
  buffers get the same offset. This is O(bodies) once per cell crossing, which is every 2 km at
  the default cell size.
- `PhysicsRange { radius: f32 = 20000 }` (resource). Bodies whose `GlobalTransform` is farther
  than `radius` from the origin are removed from the Rapier world and marked `PhysicsParked`. They
  keep their `Transform`, and velocity is stored on the component. They come back when in range.
  Queries (`physics.raycast`) never hit parked bodies. A distant ship doesn't fall through a
  planet it isn't near.
- Gravity sources (0028) keep working. They're positions in the origin frame like everything else.

### f64 helpers

```ts
// Position of `e` in `frame`'s coordinates (default: the origin frame), exact to f64.
worldPosition64(world, e, out: Float64Array, frame?: Entity): Float64Array
// The cell and translation that put `e` at `position` (f64) in `grid`; writes both components.
placeInGrid(world, e, grid: Entity, position: Float64Array): void
distance64(world, a: Entity, b: Entity): number
// Moves an entity to another grid, keeping its origin-frame pose (entering a planet's grid).
reparentToGrid(world, e, grid: Entity): void
```

- `affine64` in `@shard/core` math: the `affine` functions on `Float64Array`. The transform package
  uses it for the grid tree; the rest of the engine stays f32.
- `reparentToGrid` is how a ship moves from the system grid into a planet's grid on approach, so
  it co-rotates with the surface. It computes the new cell and translation in f64, then sets
  `GridCell`, `Transform`, and the parent together. It does this without a visible jump.

### Files and saves

- Scene and prefab files write `GridCell` like any component (`"transform/GridCell": [0, 0, 12]`).
  `Transform.translation` stays within a cell, so f32 rounding in JSON is harmless.
- Save files (0038) record `GridCell` in scene diffs and runtime entities, plus the
  `FloatingOrigin` entity. A load recomputes `GlobalTransform` from cells, so nothing depends on
  where the origin was at save time.
- `shard validate` checks cell/grid placement (`transform/cell-outside-grid`,
  `transform/translation-outside-cell` when a file's translation is more than one cell size from
  zero, which almost always means a hand-written absolute position).

### API sketch

```ts
import { Grid, GridCell, FloatingOrigin, OriginShift, worldPosition64 } from '@shard/transform'

const system = world.spawn(Grid({ cellSize: 2000 }))
const planet = world.spawn(Grid({ cellSize: 2000 }), GridCell({ x: 75_000, y: 0, z: 0 }),
  Transform({ rotation: quat.fromAxisAngle(Y, spin) }), ChildOf(system))
const ship = world.spawn(GridCell({ x: 74_990, y: 0, z: 0 }), Transform(), ChildOf(system))
world.spawn(Camera3d(), FloatingOrigin(), ChildOf(ship))

world.on(OriginShift, (e) => { myCache.shift(e.offset) })
```

### Agent surface

- `world.describe`/`app.describe` report the grid tree: each grid, its cell size, parent, how many
  entities it holds, and the origin's grid and cell.
- `entity.get` includes `worldPosition64` (in the origin frame, as a number array) alongside
  `GlobalTransform`, so an agent can read absolute distances without doing cell math.
- `entity.patch` accepts `{ "position64": [x, y, z], "grid": <entity> }` as a convenience that
  calls `placeInGrid`, so an agent can place a moon 3.8×10⁸ m away without splitting cells by hand.
- `debug.overlays` gains `grids`: the origin cell's bounds and neighboring cell edges.
- `.agents/transforms.md` gets a section on grids with the table above and when to use them.
- **Errors:** `transform/cell-outside-grid`, `transform/translation-outside-cell`,
  `transform/multiple-origins`.

## Decisions

- **Integer cells plus f32 offsets, not f64 transforms.** Columns stay TypedArray f32 and the GPU
  never sees f64. The integer cell difference makes near-origin math exact at any distance.
- **`GlobalTransform` is origin-relative.** It's the one place that changes. Every GPU buffer and
  most systems read `GlobalTransform` already, so they become camera-relative without being edited.
- **Nested grids instead of one huge grid.** Each scale gets a sensible cell size, and a planet's
  rotation is just its grid's transform, so surface entities don't move while the planet spins.
- **i32 cells.** Nesting covers galaxy scale. i64 would need BigInt or paired columns everywhere
  for no gain.
- **Park distant physics instead of simulating it.** Contacts 10⁸ m away are neither visible nor
  precise. Parking keeps Rapier's f32 build honest.
- **Shift render history on recentering, don't reset it.** A reset would flash TAA every 2 km.

## Acceptance criteria

- [ ] A cube 10¹² m from the root frame's origin, in a grid, viewed by a `FloatingOrigin` camera
      3 m away, renders identically (golden) to the same cube 3 m from a camera at the origin.
- [ ] `distance64` of two entities 10¹² m from the root frame's origin and 1 mm apart reports
      1 mm to within 1 µm, wherever the floating origin is (the cell difference is exact).
- [ ] A camera flying at 5 km/s for 60 s crosses 150 cells. Across every crossing, the
      frame-to-frame screen position of a static object changes by less than 0.01 px beyond its
      motion, and TAA history isn't reset (no reset counter increment).
- [ ] A rigid body stack resting 10⁸ m from the root origin, simulated with the origin on it, stays
      at rest for 600 frames (max drift < 1 mm). The same stack without grids at that distance
      visibly jitters (the test documents why this exists).
- [ ] A body carried across a cell boundary by a moving origin keeps its velocity to 1e-6 relative.
- [ ] Bodies beyond `PhysicsRange.radius` are parked and don't appear in `physics.raycast`. When the
      origin approaches, they resume with their stored velocity.
- [ ] A world-space particle trail stays continuous across an origin shift (no gap or offset in
      the golden).
- [ ] `reparentToGrid` moves a ship from a system grid into a rotating planet grid with a pose
      change of less than 1 mm in the origin frame.
- [ ] Save at 10¹² m, load in a fresh world: `worldPosition64` matches to the millimetre, and the
      headless world hash matches a run that never saved.
- [ ] A project with no `Grid` has no change in `pnpm bench` transform propagation (±3%). With 100
      static grids and the origin inside its cell, propagation of 100k entities costs no more than
      5% over no grids.

## Open questions

- Should the origin move to the camera's cell automatically when the `FloatingOrigin` entity is a
  ship and the camera is 3rd-person far behind it? Proposed: the origin entity is whatever carries
  the tag; games put it on the camera.
- None blocking. Deferred: grid-aware spatial queries in `world.query` (select entities in a cell
  range), and a `GridCell` for 2D games with endless scrolling.
