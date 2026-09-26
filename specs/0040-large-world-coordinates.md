# 0040 — Large-world coordinates

- **Status:** implemented
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
Grid { cellSize: f64 = 2000, hysteresis: f32 = 100 }   // transform/Grid
GridCell { cell: ivec3 }                               // transform/GridCell, new field type t.ivec3
FloatingOrigin {}                                      // transform/FloatingOrigin, a tag, one per world
```

- An entity is **in a grid** when its nearest `Grid` ancestor (or itself, for a nested grid) is
  that grid. Its position in the grid is `GridCell × cellSize + Transform.translation`, so
  `cell × cellSize` is the cell's centre. Entities without `GridCell` are in cell (0, 0, 0).
- `Grid` and `GridCell` require `Transform`.
- Only direct children of a grid carry `GridCell`. Deeper descendants are positioned by
  their parent's transform as usual. A `GridCell` on an entity whose parent isn't a grid is
  `transform/cell-outside-grid`.
- A nested grid is an entity with both `Grid` and a `GridCell` in its parent grid. Its `Transform`
  (rotation included) places its frame in the parent grid, so a spinning planet is a rotation on
  its grid entity.
- Entities with no grid ancestor are in the implicit **root frame**, where everything works as it does today.
- `t.ivec3` is a new schema field (three i32, stored like `vec3` in an `Int32Array`). `Grid.cellSize`
  is `t.f64`.
- A grid may also sit under an ordinary entity (no `GridCell` then). Its frame composes that
  entity's transform chain in f64. Change detection can't see that chain cheaply, so a world with
  such a grid solves grid frames every frame.

With i32 cells and nested grids:

| Grid | Suggested cell | Reach (±2³¹ cells) | f32 offset precision |
|---|---|---|---|
| Galaxy | 10¹² m | 2×10²¹ m (galaxy is ~10²¹) | ~60 km, fine for stars |
| Star system | 2 000 m | 4×10¹² m (~30 AU) | ~0.1 mm |
| Planet | 2 000 m | far beyond any planet | ~0.1 mm |

### The floating origin and `GlobalTransform`

- The origin is the `FloatingOrigin` entity's cell in its grid (its **origin grid**): the cell of
  its ancestor (or itself) that is a direct child of a grid. `GlobalTransform` of every entity is
  its transform relative to the origin cell's centre, expressed in the origin grid's orientation.
  With no `FloatingOrigin`, or with no `Grid` in the world, the origin is the root frame's origin,
  which is today's behavior. With several origins, the first one found wins.
- Propagation gets one new step before the existing one, inside `core/transform-propagate`. It
  walks the grid tree (few entities) in f64 and stores, for each grid, a reference cell `ref` near
  the origin and an f64 affine `A` with `origin = A · ((cell − ref) × cellSize + p)`. The origin
  grid has `A = identity` and `ref` = the origin cell; grids above it solve upward from it
  (`A_P = A_G · T(−ref_G × cs_G) · M_G⁻¹`, `ref_P` = the child grid's cell), every other grid
  solves down from its parent (`ref = 0`). The frames live in the `transform/GridFrames` resource
  (`Float64Array`/`Int32Array` slots), where physics and the renderer read them. Then each direct
  child of a grid gets `A · ((cell − ref) × cellSize + TRS)`: the cell difference in integers, the
  product in f64, the result rounded to f32. Grid entities get their frame, rounded to f32. The
  existing inlined `fromTRS` root path and child propagation are unchanged; entities in the root
  frame compose with the root frame's matrix only when it isn't the identity.
- Cell differences are integer math, so two ships 10¹² m from the world origin but 3 m from each
  other get a 3 m difference with f32 precision.
- If the origin grid, the origin cell, or any grid's transform changes, every entity under the
  affected grids is re-propagated that frame (a grid whose solved frame is bit-identical to last
  frame's doesn't count). When no grid table changed and the origin stays in its cell, the solve is
  skipped: static grids cost one change check per grid table.
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
in origin-frame metres, the amount to add to an old-frame position) lets consumers that keep
state in the origin frame follow along. Propagation sends it (for `world.reader`) and triggers it
(for `world.observe`, which runs before anything else sees the new frame). When the origin changes
grids, `delta` is zero and `offset` is where the old origin point lands in the new frame; the
rotation between the two frames isn't part of the event.

- **Render history.** The previous-frame instance matrices, the previous view matrix, and the TAA
  history live in the old frame. An observer on the shift adds `offset` to every instance slot's
  current and previous translation, and right-multiplies each camera's `prevViewProj` (and a
  frozen culling frustum) by `translate(−offset)`. Reprojection lines up, so there's no smear, and
  TAA history only resets when it's created, resized, or lost (`RenderCounters.taaResets` in
  `render.describe` counts that). Shadow cascades are rebuilt from the new camera position as they
  are every frame.
- **Particles.** World-space particle positions live in GPU buffers. The simulate pass gets an
  `originOffset` uniform. Each emitter accumulates shifts until its next update dispatch, so a
  paused or still-compiling emitter doesn't lose one; particles spawned that frame are already in
  the new frame. The CPU backend shifts its array directly.
- **Gizmos.** World-space lines and labels, retained or drawn earlier this frame, are shifted on the
  CPU.
- **Physics.** See below.
- **Audio.** Nothing to do: listener and sources are read from `GlobalTransform` every frame.

User code that caches `GlobalTransform` positions across frames subscribes to `OriginShift`. Code
that needs a stable position stores `GridCell` + `Transform`, or calls `worldPosition64`.

### Physics

- Rapier stays the f32 build. It simulates in the origin frame: sync-in reads `GlobalTransform`,
  and sync-out writes back into `Transform` through the parent's inverse, as today.
- Poses read from transforms (body creation, teleports) and written back (sync-out, interpolation,
  the character controller) go through the grid's f64 frame for direct grid children, not the
  grid entity's f32 `GlobalTransform`. Sync-out moves a body's `GridCell` itself when its
  translation leaves the cell (same rule as `transform/recenter`), so the next sync-in doesn't read
  the change as a teleport.
- On `OriginShift`, every body and every collider without a body is translated by `offset` with
  `setTranslation(…, wakeUp: false)`. Velocities and contacts are unchanged. The interpolation
  buffers get the same offset. A zero-length step follows so the broad phase (and so raycasts)
  sees the new positions before the next physics step. Rapier re-checks contacts and wakes
  sleeping bodies anyway; they settle again on their own. This is O(bodies) once per cell
  crossing, which is every 2 km at the default cell size.
- `PhysicsRange { radius: f32 = 20000 }` (resource). While grids are active, bodies farther than
  `radius` from the `FloatingOrigin` entity are disabled in Rapier (`setEnabled(false)`, which
  keeps colliders, joints, and mass, and costs nothing in the step) and marked `PhysicsParked
  { linear, angular }` with their velocity. They keep their `Transform`, and resume within
  0.95 × `radius` so an origin at the edge doesn't flap. `PhysicsParked` is saved: for a body
  without `Velocity` it's the only record of its motion. Colliders without a `RigidBody` aren't
  parked; give distant static geometry a fixed body. Queries (`physics.raycast`) never hit parked
  bodies. A distant ship doesn't fall through a planet it isn't near.
- An origin grid that moves or rotates carries the origin frame with it without an `OriginShift`,
  and physics doesn't compensate. Put the origin in the frame that should hold still (a planet's
  grid on its surface).
- Gravity sources (0028) keep working. They're positions in the origin frame like everything else.

### f64 helpers

```ts
// Position of `e` in `frame`'s coordinates (default: the origin frame), exact to f64.
worldPosition64(world, e, out: Float64Array, frame?: Entity): Float64Array
// The cell and translation that put `e` at `position` (f64) in `grid`; writes both components
// and makes `e` a child of `grid`.
placeInGrid(world, e, grid: Entity, position: ArrayLike<number>): void
distance64(world, a: Entity, b: Entity): number
// Moves an entity to another grid, keeping its origin-frame pose (entering a planet's grid).
reparentToGrid(world, e, grid: Entity): void
// The exact f64 affine from `e`'s frame to the origin frame, solved fresh from transforms.
originMatrix64(world, e, out: Float64Array): Float64Array
```

- The helpers solve grid frames fresh from `Transform` and `GridCell`, so they're right between
  propagations (right after a spawn). They're cold paths.

- `affine64` in `@shard/core` math: the `affine` functions on `Float64Array`, plus `translateAt`
  and `transformVectorAt`. The transform package uses it for the grid tree; the rest of the engine
  stays f32.
- `reparentToGrid` is how a ship moves from the system grid into a planet's grid on approach, so
  it co-rotates with the surface. It computes the new cell and translation in f64, then sets
  `GridCell`, `Transform`, and the parent together. It does this without a visible jump.

### Files and saves

- Scene and prefab files write `GridCell` like any component
  (`"transform/GridCell": { "cell": [0, 0, 12] }`).
  `Transform.translation` stays within a cell, so f32 rounding in JSON is harmless.
- Save files (0038) record `GridCell` in scene diffs and runtime entities, plus the
  `FloatingOrigin` entity. A load recomputes `GlobalTransform` from cells, so nothing depends on
  where the origin was at save time.
- `shard validate` checks cell/grid placement (`transform/cell-outside-grid`,
  `transform/translation-outside-cell` when a grid child's translation in the file is more than one
  cell size from zero, which almost always means a hand-written absolute position, and
  `transform/multiple-origins`). They're scene errors, so a scene with them doesn't load. The cell
  check skips a prefab's root, a variant's children, and children of instances, whose parent the
  file can't see.

### API sketch

```ts
import { Grid, GridCell, FloatingOrigin, OriginShift, worldPosition64 } from '@shard/transform'

const system = world.spawn([Grid, { cellSize: 2000 }])
const planet = world.spawn(Grid, [GridCell, { cell: [75_000, 0, 0] }],
  [Transform, { rotation: spin }], [ChildOf, { parent: system }])
const ship = world.spawn([GridCell, { cell: [74_990, 0, 0] }], Transform, [ChildOf, { parent: system }])
world.spawn(Camera3d, FloatingOrigin, [ChildOf, { parent: ship }])

world.observe(OriginShift, ({ data }) => myCache.shift(data.offset))
```

### Agent surface

- `app.describe` reports the grid tree when the world has grids: each grid, its cell size, parent,
  cell, how many entities it holds, and the origin's entity, grid, and cell.
- `entity.get` includes `worldPosition64` (in the origin frame, as a number array) alongside
  `GlobalTransform` when the world has grids, so an agent can read absolute distances without
  doing cell math.
- `entity.patch` accepts `{ "position64": [x, y, z], "grid": <entity> }` as a convenience that
  calls `placeInGrid` (`grid` defaults to the entity's current grid), so an agent can place a moon
  3.8×10⁸ m away without splitting cells by hand.
- A `grids` overlay (registered with `defineOverlay`): the origin cell's bounds and its neighbors'
  edges.
- The generated `.agents/skills/large-worlds.md` covers grids, with the table above and when to
  use them.
- **Errors:** `transform/cell-outside-grid`, `transform/translation-outside-cell`,
  `transform/multiple-origins`, `transform/not-a-grid`, `protocol/not-a-grid`,
  `protocol/invalid-position64`.

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

- [x] A cube 10¹² m from the root frame's origin, in a grid, viewed by a `FloatingOrigin` camera
      3 m away, renders identically (golden) to the same cube 3 m from a camera at the origin.
- [x] `distance64` of two entities 10¹² m from the root frame's origin and 1 mm apart reports
      1 mm to within 1 µm, wherever the floating origin is (the cell difference is exact).
- [x] A camera flying at 5 km/s for 60 s crosses 150 cells. Across every crossing, the
      frame-to-frame screen position of a static object changes by less than 0.01 px beyond its
      motion, and TAA history isn't reset (no reset counter increment).
- [x] A rigid body stack resting 10⁸ m from the root origin, simulated with the origin on it, stays
      at rest for 600 frames (max drift < 1 mm). The same stack without grids at that distance
      snaps to the 8 m f32 spacing there (the test documents why this exists).
- [x] A body carried across a cell boundary by a moving origin keeps its velocity to 1e-6 relative
      (200 m cells at 300 m/s: Rapier caps body speed at 400 m/s).
- [x] Bodies beyond `PhysicsRange.radius` are parked and don't appear in `physics.raycast`. When the
      origin approaches, they resume with their stored velocity.
- [x] A world-space particle trail stays continuous across an origin shift (no gap or offset in
      the golden).
- [x] `reparentToGrid` moves a ship from a system grid into a rotating planet grid with a pose
      change of less than 1 mm in the origin frame.
- [x] Save at 10¹² m, load in a fresh world: `worldPosition64` matches to the millimetre, and the
      headless world hash matches a run that never saved.
- [x] A project with no `Grid` has no change in `pnpm bench` transform propagation (±3%). With 100
      static grids and the origin inside its cell, propagation of 100k entities costs no more than
      5% over the same hierarchy without grids. 100k changed grid children propagate no slower
      than 100k ordinary children.

## Open questions

- Should the origin move to the camera's cell automatically when the `FloatingOrigin` entity is a
  ship and the camera is 3rd-person far behind it? Proposed: the origin entity is whatever carries
  the tag; games put it on the camera.
- None blocking. Deferred: grid-aware spatial queries in `world.query` (select entities in a cell
  range), and a `GridCell` for 2D games with endless scrolling.
