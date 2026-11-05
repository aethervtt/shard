# 0104 — Terrain editing: sculpting and painting at runtime

- **Status:** draft (built)
- **Packages:** `@aethervtt/shard-terrain`, `@aethervtt/shard-water`, `@aethervtt/shard-cli`
- **Depends on:** 0071, 0097, 0037, 0038, 0105

## Context

0071 bakes a heightfield from a layer stack and calls brush sculpting and painting a non-goal: "a
Studio tool for later. It would write a delta layer in the format this spec defines." Builder
games need it at runtime, not in an editor: in a zoo builder the player digs a pond, raises a
viewing mound and paints sand into an enclosure while the camera keeps moving, and every edit has
to show under the pointer on the frame it's made.

This spec adds the delta layers (one for height, one for paint), the brushes and shapes that write
them, undo, a save format, and the runtime path that rebakes only the leaf pages an edit touches.
It also covers what a game needs around edits: an event per edit, water that sees the new ground,
a ray cast for aiming tools, and a preview drawn on the ground.

## Goals

- Sculpt brushes along a stroke: raise, lower, smooth, flatten (to the height under the stroke's
  start, or a given one) and roughen, with radius, strength and falloff per stroke.
- Shapes: circle, rectangle, polygon and a spline with a width. Each sets the ground to a height,
  raises or lowers it, or slopes it between two heights. Edges are hard, or soft at a wall angle.
- Paint brushes and shapes write material layers into a paint layer. Erasing returns to what the
  source's paint rules give.
- Edits are data in the terrain's stack: serializable, in the bake's block keys, replayed by a
  load. Undo and redo per stroke or shape.
- Only touched leaves rebake. While dragging, the drawn surface, `terrainHeightAt` and the
  colliders under the brush catch up within two frames.
- `TerrainEdited` events, water ground that follows edits, `terrainRaycast`, `terrainPreview`.
- Tested on the zoo's map: 1024 m at 0.5 m, six layers.

## Non-goals

- Holes, caves and overhangs (0071's reserved hole bit stays unread).
- Height-based paint blending, and more than two material layers per control texel (see Decisions).
- Re-placing scatter (0045) under an edit. The event carries the rectangle; scatter regrowth is
  later.
- A Studio tool UI. The API and protocol methods are what one would use.
- Growing `heightRange` at runtime (see Decisions).

## Design

### Where the edit layers sit

The source gains two virtual entries, one in `height` and one in `paint`. Each is the place in its
list where the edits apply. By default each sits just before the first spline entry of its list,
or at the end of a list without one. Roads and paths therefore flatten and paint over edits under
them. A list may say where instead with one `{ "edits": true }` entry:

```json
"height": [
  { "noise": { "path": "hills" }, "scale": 16 },
  { "edits": true },
  { "spline": "path", "mode": "flatten" }
]
```

The zoo's `height` list (hills, path, pond) puts edits after the hills. The pond is an `add` layer
above them, so digging and raising compose with it.

- A spline point at `"ground"` reads the stack without edits. Sculpting under a path's control
  point doesn't move the path.
- Flatten, set and slope targets are heights at the edit layer: the stack below plus the sculpt
  delta. Layers above it (paths, the pond's `add`) still apply on top.

### The two layers

- **Sculpt**: metres added to the stack at every leaf sample, as `Float32Array` tiles of 64 × 64
  samples. Tile (tx, tz) holds samples (tx·64 + i, tz·64 + j). A missing tile is all zero. The kernel's
  `evalHeights` adds the delta where the stack reaches the edit position. A block bake, a leaf
  baked alone and a runtime rebake therefore all write the same bytes (0071's canonical samples).
- **Paint**: per paint texel (the `paintSpacing` lattice), up to two painted layers and their
  weights (0–65535), in 64 × 64 texel tiles of `Uint16Array` (layer, layer, weight, weight). At its
  position in the paint list a record does what a paint entry does: every weight below scales by
  (1 − its coverage), then its layers add their weights. Later entries (paths) paint over it.
  Coverage 0 is the source's paint, so erasing scales the record's weights toward 0.
- Heights stay 16-bit over `heightRange`. Edits that would go past it are clamped there, and the
  edit's event reports `clamped`.

### Brushes

`editor.stroke(options, x, z)` starts a stroke and `stroke.to(x, z, dt)` drags it. Dabs land every
`spacing` metres along the path (default radius / 4). With `rate` set, at least `rate × dt` dabs
also land each frame, so holding still keeps raising. A dab's weight at distance r from its center
is `strength × falloff(r / radius)`. That is 1 out to `(1 − falloff) × radius` and a smoothstep to
0 at the radius. `falloff` runs 0–1 (default 0.5).

| Brush | Per dab, at weight w | strength |
|---|---|---|
| raise / lower | delta ± w | metres |
| smooth | toward a box blur of radius ⌈0.1 × radius⌉ samples, by w | 0–1 |
| flatten | toward `height` (default: the edit-layer height under the first dab), by w | 0–1 |
| roughen | delta + w × value noise (period `scale`, default radius / 4), in −1…1 | metres |
| paint | the layer's weight up by w (`paint: "<layer>"`), or erase (`paint: null`) | 0–1 |

All dabs a `to()` call adds apply at once to one region read of the edit-layer heights. Brushes
are deterministic: the same calls give the same tiles.

### Shapes

```ts
editor.shape({ shape: { polygon: [[x, z], …] }, set: 4, edge: { angle: 35 } })
```

- Shapes: `circle { at, radius }`, `rect { at, size, rotation }`, `polygon [[x, z], …]` (closed),
  and `spline { points: [[x, z], …], width }` (0071's Catmull-Rom, the flat width as a road's).
- Operations: `set: h`, `raise: m`, `lower: m`, and `slope: [h0, h1]`. A spline slopes along its
  length, and any other shape from point `from` to point `to`. For paint, `paint: layer | null`
  with `strength`.
- Edges (d is the distance outside the shape):
  - Hard, the default: the shape's samples change and no others.
  - `{ angle: θ }`, for sculpting. Outside the shape the ground is held to a cone from the shape's
    target: `clamp(g, t − d·tanθ, t + d·tanθ)` for set and slope, and `g ± max(0, a − d·tanθ)`
    for raise and lower. A pond cut at 35° gets 35° banks, and a plateau gets 35° sides.
  - `{ falloff: m }`, the only edge paint has: the change fades over m metres, as 0071's falloffs
    do. Sculpting takes it too.

### Undo, redo and saving

- A stroke or shape is one step. The first time a step touches a tile, the step keeps that tile's
  prior contents. Undo swaps them back and keeps the current ones for redo. A new step clears
  redo. History holds 64 steps or 64 MB, and the oldest step goes first.
- `editor.save()` returns `TerrainEditsData`: the grid it's for, the layer names, and each nonzero
  tile as base64 of its deflated byte planes (0071's DEFLATE). `editor.load(data)` replaces the
  layers and clears history. A game puts the data in a persisted resource (0038) and loads it after
  `loadGame`.
- Loading before the terrain's first bake bakes the edits in on the worker pool. Loading later
  rebakes the union of old and new tiles' leaves on the runtime path.
- Block keys (0071) gain the digest of the edit tiles under each block. The packs' source hash
  becomes the asset's hash plus the edits' digest. A save with edits rebakes only the blocks they
  touch.

### The runtime rebake

Edits write tiles at once (cheap), then queue the leaves whose samples, or whose one-sample
border, they changed. The `terrain/heightfield-edits` system runs in `PostUpdate`, after
`terrain/heightfields`:

1. **Leaves.** Each queued leaf rebakes within `TerrainBudget.editMs` (default 4 ms) a frame; the
   rest wait for the next frame. A leaf on the CPU rebakes only the samples the edit changed, and
   the control texels over them (`patchLeaf`; paint alone skips the heights). Others rebake whole
   with `bakeLeaf`, about 0.55 ms on the zoo's map. Every sample is canonical, so both write what a
   bake writes.
2. **Overrides.** Rebaked pages go into the page store's overrides. They take precedence over the
   packs, are never evicted, and a read landing for one is discarded.
3. **Ancestors**, once the queue is empty. Only the texels the change reaches are rebuilt, in
   only the pages that hold them: heights and paint as point samples of the children, normals as
   0071's [1 2 1]² average of the children's (which reaches 2^L samples at level L, across page
   edges into the ring of neighbors). Every page read must be on the CPU; one that isn't is read
   first, and the rebuild waits a frame. Parents' normals come from their children's bytes, not the
   bake's f64 chain, so they can differ from a fresh bake by up to 2 in a byte. The next bake
   replaces them.
4. **Bounds and errors.** Node min and max come from the rebuilt pages, so culling sees a raised
   hill. A depth's error is the largest it has measured, never lowered. It grows if the edited
   samples are farther from an ancestor's surface than the error the bake recorded.
5. **GPU.** Pages in the pool are rewritten in place right away, ahead of streaming's
   `pagesPerFrame`. Others load from the overrides when selected.
6. **Colliders.** Tiles over rebaked leaves get their heights again. Spawned ones get their
   `Collider` set in place, so physics rebuilds them and NavSource tiles rebake (0037).
7. **Events and the edit log.** Once an edit's leaves and ancestors are in, `TerrainEdited` is sent,
   and its rectangle goes to `rt.editLog`.

`rt.version` doesn't change: it means "rebaked, reload everything" to colliders, the pool and
water.

### Around edits

- **`TerrainEdited`** (`terrain/Edited`): `{ terrain, rect: [x0, z0, x1, z1], height, paint,
  cause, clamped }`. `rect` is in terrain metres and covers every changed sample. `cause` is
  `'stroke' | 'shape' | 'undo' | 'redo' | 'load'`. A stroke sends one event for each frame that
  changed the ground.
- **Water.** `water/bodies` reads every terrain's edit log. The info clipmap marks the texels under
  new rectangles unfilled, so they refill from the new pages (within its 32 768 texels a frame).
  `waterAt` reads pages directly and is current at once. The shore fade is screen-space and already
  correct.
- **`terrainRaycast(world, terrain, origin, direction, maxDistance?, out?)`**: a world-space ray (a
  `screenToRay` ray) against the finest CPU page under each step of a DDA over leaf cells. It skips
  cells by page min and max, and intersects the two triangles of each cell, split as the mesh and
  Rapier split them. Near anchors that is exactly the drawn ground. Farther out it is within
  `errorPixels` of it on screen.
- **`terrainPreview(world, terrain, preview | null)`**: the terrain material draws the outline of a
  brush (radius and falloff rings) or a shape (outline, falloff or wall extent, and a tinted fill)
  on the drawn surface. The shape arrives as up to 32 points in uniforms; bigger polygons and
  splines are resampled. No texture is used, so the baseline tier keeps its 16 (0105). 0083's decals
  can't do this: they clip against the shared flat grid mesh.

### API sketch

```ts
const editor = terrainEditor(world, terrain)
const s = editor.stroke({ brush: 'raise', radius: 10, strength: 0.15, falloff: 0.6, rate: 30 }, x, z)
s.to(x2, z2, dt)            // every frame while dragging
s.end()                     // one undo step; s.cancel() reverts it
editor.stroke({ paint: 'sand', radius: 6, strength: 0.5 }, x, z)
editor.shape({ shape: { spline: { points, width: 4 } }, slope: [12, 10], edge: { angle: 30 } })
editor.undo(); editor.redo(); editor.pending   // leaves left to rebake
const data = editor.save(); editor.load(data)
const hit = terrainRaycast(world, terrain, origin, dir)   // { point, normal, distance, x, z }
terrainPreview(world, terrain, { brush: { at: [x, z], radius: 10, falloff: 0.6 } })
```

### Agent surface

- `terrain.edit { terrain, shape | stroke, … }`: one shape edit, or a stroke given as points, with
  the same options as the API. It returns the event's rectangle once the edit is in.
  `terrain.undo` / `terrain.redo { terrain }`. MCP: `edit_terrain`.
- `terrain.describe` adds `edits`: sculpt and paint tiles, the data's size, pending leaves, and
  undo and redo depth.
- `terrain.map` `bake` mode shades the leaves the last edit rebaked.
- **Errors:** `terrain/bad-edit` (a bad shape, op or option, with a pointer), `terrain/edits-mismatch`
  (data for another grid), `terrain/unknown-layer` (paint), `terrain/bad-source` (two `edits`
  entries in a list).

## Decisions

- **Deltas, not absolute heights.** A sculpt rides on the stack, so an author can retune the
  hills under a player's edits. Flatten and set store their target minus the ground below.
- **Edit layers below the source's splines by default.** Paths and roads stay graded and painted
  under player edits, which is what the user asked for. `{ "edits": true }` moves them.
- **Save the tiles, not the strokes.** The size is bounded by the area edited, not the edits
  made, and a load needs no replay.
- **Rebake leaves with the bake's own kernel.** Live pages equal a reload's, byte for byte (leaves
  and ancestors' heights and control). Patching only the changed samples is cheap enough that
  caching the stack below the edits isn't needed.
- **Two layers per control texel stays.** Painting a third material where two already blend keeps
  the two heaviest weights. The lighter of the old pair drops, and its weight lets the source show
  through until the brush covers it. At strength 1 the new layer simply replaces. Four layers a
  texel would double control memory and the fragment's layer samples (each three arrays,
  triplanar ×3) for a case a soft brush crosses in a metre.
- **1 m control texels are enough for hand painting.** Brushes are metres across and blend over
  their falloff; bilinear control blends over 1 m. `paintSpacing: 0.5` costs 4× control: a
  leaf's control goes from 4.4 KB to 16.9 KB, pool pages from 22.3 KB to 34.9 KB, and packs
  about +3.2 bytes a sample before deflate (+13 MB raw on the zoo's map). It is a source setting
  if a game wants crisp painted lines.
- **`heightRange` doesn't grow at runtime.** Heights are 16-bit over it, so growing it requantizes
  every page in the terrain. A source sets headroom for edits: the zoo's −40…60 m gives a 40 m pit
  under its 16 m hills at 1.5 mm steps. Changing it in the source rebakes with the edits kept,
  since they're metres.
- **Commit as leaves finish, not atomically.** A 200 m cut over several frames shows its leaves
  landing over a few frames, with skirts covering the seams, instead of stalling a frame.

## Acceptance criteria

- [x] A stroke of each brush, and a shape of each kind, leave leaf pages byte-identical to a fresh
      bake of the source with the same edit data (ancestors' heights and control too).
- [x] `save` → `load` into a new world, before its first bake or into a running one, gives
      identical pages and `terrainHeightAt`.
- [x] Undo restores the previous pages byte for byte, and redo the edited ones.
- [x] One dab rebakes exactly the leaves whose samples or border it changed (count asserted).
- [x] After `to()`, within two frames: `terrainHeightAt`, a Rapier ray onto the collider tile
      (within 1 cm), and the drawn image of the ground under the brush show the new ground.
- [x] A flattened spline path over a raised patch keeps its height and its gravel.
- [x] A hard-edged `set` changes no sample outside the shape. A 35° wall's steepest sample is under
      36°.
- [x] Painting a third layer over two keeps the two heaviest; at strength 1 the new layer stands
      alone. Erasing returns the control bytes to the source's.
- [x] Every edit sends one `TerrainEdited` (each stroke frame one) whose rectangle covers every
      changed sample.
- [x] Under a lake, an edit changes `waterAt`'s ground and the clipmap's ground texel within two
      frames.
- [x] `terrainRaycast` from 20 random camera rays hits within 1 cm of `terrainHeightAt` at its xz.
- [x] A brush preview and a shape preview draw in a render test, on both tiers.
- [ ] Dragging a 20 m brush across the zoo map: edit work p95 within `terrain/edit-brush` a frame
      (bench), and the zoo game holds 60 fps on the laptop. Measured on an M5 Max, not the laptop
      (As built).
- [ ] A 200 m polygon cut is in (event sent) within `terrain/edit-shape` (bench). Measured on an M5
      Max, not the laptop.

## As built

- **Code** (packages/terrain/src/heightfield/): edits.ts (the layers, brushes, shapes, history,
  save format; headless), editor.ts (the runtime path, `TerrainEdited`, `terrainEditor`,
  `loadTerrainEdits`), raycast.ts, preview.ts. The kernel gains the edit layers in `evalHeights` and
  `evalControl` and `patchLeaf`; the page store gains overrides, `patchLeaf` and `texelsOf`; the bake
  gains per-block edit digests (`blockEditTiles`, `editsDigest`) and sends a block's pool job only
  its tiles (copies). An empty edit layer changes no byte: 0071's pinned pack hash holds.
- **Fixed on the way:** a page re-requested after it left the GPU pool, but still in the CPU cache,
  never uploaded again (its texels were dropped after the first upload). Uploads now remake texels
  (`texelsOf`). The zoo, which keeps every leaf on the CPU, could hit it.
- **Water** (packages/water): `water/bodies` reads every terrain's `editLog` into
  `groundEdits` (world rectangles, at most 64 before it refills everything). The info clipmap marks
  the texels under them unfilled.
- **Agent surface:** `terrain.edit`, `terrain.undo`, `terrain.redo`; `terrain.describe` gains
  `edits`; `terrain.map`'s bake mode shades the leaves the last edit rebaked magenta; MCP
  `edit_terrain`.
- **Tests:** edits.test.ts (the criteria above but the GPU ones, and the protocol methods),
  raycast.test.ts, edit-render.test.ts (on screen within two frames; previews on both tiers),
  water's terrain-edits.test.ts, and edit-bench.test.ts (bench only). The latency tests lift
  `editMs`: they check that nothing waits an extra frame, and the bench checks the budget.
- **Measured on an Apple M5 Max** (not a machine in bench/perf/machines.json; the laptop budgets
  stay proposals). The bench is the zoo's map in Node, every leaf on the CPU, a 20 m brush moving
  3 m a frame. Edit work a frame, p50/p95: raise 1.06/1.59 ms, smooth 1.07/1.41 ms, paint
  0.58/0.74 ms. A 200 m polygon cut (set, 35° walls): 46–50 ms to apply it (one frame, on the main
  thread), then 86 ms of rebakes over 7–8 frames, all in by 150 ms.
- **In the zoo game** (Chrome, Metal, 1280 × 800, M5 Max): dragging a 20 m brush across the map with
  the camera following held vsync throughout. Frames ran 16.7 ms at p50 and p95 and 16.8 ms at
  worst over 600 frames, for raise, paint and smooth alike, against 16.7/16.8 idle. Edit work was
  0.5–1.0 ms p50 and at most 1.6 ms p95. The 200 m cut was in after 306 ms, with one 50 ms frame (the
  apply) and the rest at vsync.
- **Not built:** time-slicing a shape's own apply (the 50 ms frame above). Scatter doesn't
  re-place under edits.

## Open questions

- None blocking. Deferred: scatter re-placing under edits; a Studio sculpt tool on this API.
