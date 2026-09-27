# 0055 — Host-driven scenes and incremental structure

- **Status:** draft
- **Packages:** `@shard/mirror` (new), `@shard/structure` (new), `@shard/render`, `@shard/gpu`
- **Depends on:** 0001, 0007, 0018, 0022, 0052

## Context

A host application such as Aether keeps its own documents: tokens, walls, doors, props, chat. It
derives what to draw from them. Today Aether's three.js layer re-derives the whole scene after
every store change, including every Chat message. It compares whole-layer `JSON.stringify`
signatures, runs a full structural compile on any structural edit, rebuilds every door mesh on
every descriptor change, and rewrites every token matrix when one token is dragged. The equality
guards stop GPU uploads, but not the CPU work, and nothing proves which changes upload what.

Shard already does the GPU half well: instance slots upload only dirty rows (0022), transforms
propagate only dirty subtrees, and meshes re-upload only on a version bump. What's missing is
the host half: a cheap way to apply "these documents changed" to a world, geometry that rebuilds
only the chunks an edit touched, and counters that prove it.

Aether's structural scene contract (ADR-0072) sets the sizes: 5,000 walls, 1,024 openings,
256 floors of up to 256 vertices, 64 materials, 256 props of up to 64 distinct assets, and 500k
prop triangles. Its shadow-stress fixture is 5,000 walls, 64 doors, 256 props, 1 floor and
12 tokens.

## Goals

- `@shard/mirror`: keyed sync from host documents to entities. It is O(n) over revisions, writes
  only changed fields, and allocates nothing when nothing changed.
- `@shard/structure`: walls, openings (doors and windows) and floors as components. Walls compile
  into chunked, per-material meshes; an edit rebuilds only the chunks it touches. Door leaves are
  their own instances.
- Upload accounting: bytes written to the GPU per frame, by category, and rebuild counts.
- Cached shadow maps that re-render only when a caster or the light changed.
- Fixtures at Aether's maximum sizes, with budgets checked in `pnpm bench`.

## Non-goals

- Vision, fog of war, line of sight and the planar authority itself. The host's server stays
  authoritative. `@shard/structure/planar` offers the barrier split as a pure function a host may
  reuse, but nothing depends on it.
- Grid, drawings, measurement templates and labels. Each gets its own spec when Aether migrates.
- Multi-level structures (Aether's contract is single-level too).

## Design

### Mirror

```ts
const tokens = createMirror(world, {
  key: (doc: TokenDoc) => doc.id,
  rev: (doc: TokenDoc) => doc.rev,
  spawn: (doc, w) => w.spawn(Token, Transform, Mesh3d, MeshMaterial),
  apply: (entity, doc, w) => w.set(entity, Transform, { translation: [doc.x, 0, doc.y] }),
})

tokens.sync(docs)            // the host's full list: applies docs whose rev changed, despawns missing ones
tokens.upsert(doc); tokens.remove(id); tokens.entity(id)
tokens.keyOf(entity)         // the host id, for the entity or any descendant (a pick hit on a visual child)
```

`sync` walks the list once, comparing each `rev` with the stored one. An unchanged doc costs one
map lookup and one number compare. Removal uses a generation mark, not a second list. `apply` runs
only for changed docs, so a token move is one `Transform` write, which is one dirty instance slot.
Without `rev`, `sync` falls back to an `equal(prev, next)` the host supplies. The mirror never
stringifies anything.

A host that already knows what changed (Aether's patch stream does) calls `upsert`/`remove`
directly and never passes the full list.

### Structure

```ts
Wall     { a: vec2, b: vec2, height: f32, thickness: f32, elevation: f32, material: handle('Material') }
Opening  { wall: entity, kind: 'door' | 'window', offset: f32, width: f32, height: f32, sill: f32,
           frameWidth: f32, frameDepth: f32, frameMaterial: handle('Material'),
           hinge: 'start' | 'end', swing: 'left' | 'right', state: 'closed' | 'open' | 'locked' }
Floor    { points: list(vec2) (3–256), elevation: f32, material: handle('Material') }
StructureSettings (resource) { chunkSize: f32 = 8, doorSwingMs: f32 = 250, reducedMotion: bool }
```

**Units.** Structure is in world units (metres by convention), and the host converts its own
coordinates with **one fixed visual scale**. For Aether that's `world = px × pxToWorld`, a
constant of the adapter. It is never derived from the grid's game distance (`distance`, `unit`,
"5 ft per square"). Those give cells a game meaning for measurement (`@shard/grid/math`
`distance`, 0057) and don't place anything. Changing a scene's distance or unit changes no
geometry.

Grid **size** (pixels per cell) is different: it's visual. Things positioned in pixels (walls,
openings, floors, drawings, token and prop positions) stay where they are when it changes. Things
whose dimensions are defined in cells are resized, because their world size is
`cells × gridSizePx × pxToWorld`. For Aether that's token footprints (`size` in cells) and props
scaled per cell. The adapter computes these sizes; the engine only sees world units.

**Compile.** `structure/compile` runs in `PostUpdate`. It gathers walls, openings and floors
changed since its last run (`changed`/`added` query ticks, plus despawns). Each changed wall marks
every chunk its old and new geometry overlaps. An opening marks its host wall's chunks, but only when
its geometry fields (offset, width, height, sill, frame) changed; a `state` change marks nothing.
Each dirty chunk rebuilds its per-material meshes:

- walls split around their openings, extruded to `height`;
- door and window frames;
- floors, triangulated once by ear clipping.

**Geometry is clipped to chunks, never assigned whole.** A chunk owns exactly the part of each
piece that lies inside its square:

- a wall segment is split where it crosses a chunk boundary (in XZ, including its thickness), and
  each part is extruded in the chunk it lies in;
- a floor's triangles are clipped against each chunk square they overlap (triangle-rectangle
  clipping, then fan re-triangulation);
- frames are split the same way as walls.

The cut faces at a boundary get no caps, so the parts meet as one continuous surface. UVs are
world-space, so textures don't seam. Every chunk's bounds are the real bounds of its clipped
geometry (with wall height and thickness), not the chunk square. So culling can't drop a visible
part: a long wall whose endpoint is on screen has that endpoint's part in an on-screen chunk,
whatever happens to its midpoint.

A chunk's mesh is `Mesh.update`d in place, so its GPU buffer is rewritten, not reallocated, while
it fits. Each (chunk, material) is one `Mesh3d` entity, so frustum culling (0022) skips off-screen
chunks. An edit rebuilds exactly the chunks its old and new geometry overlap: one or two for a
typical wall, more for a long wall or a large floor, and never a chunk it doesn't touch.

**Door leaves.** Each door spawns a leaf child entity: an instanced leaf mesh per frame material.
A `state` change sets the leaf's target angle. `structure/doors` animates it over `doorSwingMs`
(instantly with `reducedMotion`), holding a frame demand (0052) while it moves. A door toggle is
therefore zero chunk rebuilds and one instance slot per animated frame. Windows get a glass pane
entity with a blended material.

**Planar split.** `planarBarriers(walls, openings) → Segment[]` in `@shard/structure/planar` is
the same split compile uses, with `sight` and `movement` channels, as a pure function with no ECS
or GPU.

### Upload accounting

`GpuContext` counts bytes written through `writeBuffer` and `writeTexture`, and buffers created,
per category: `instances`, `meshes`, `materials`, `textures`, `lights`, `shadows`, `view`.
Categories come from the label of the buffer or texture. `render.describe` reports the last
frame's and a rolling 60-frame sum, plus `chunksRebuilt`, `meshesRebuilt` and
`shadowMapsRendered`. *Scene data* means everything but `view` (camera and per-frame uniforms).

### Cached shadows

`DirectionalLight` and `SpotLight` get `shadowUpdate: 'always' | 'on-change'`. With `'on-change'`,
a light re-renders its map (or a cascade) only when the light moved, the cascade's fit moved, or a
shadow-casting instance inside its bounds changed. Instance stores already know the dirty slots;
the shadow pass tests them against each cascade's bounds. A top-down VTT camera that isn't moving,
over a static structure, renders no shadow passes.

### API sketch

```ts
import { createMirror } from '@shard/mirror'
import { structurePlugin, Wall, Opening, Floor, StructureSettings } from '@shard/structure'
import { planarBarriers } from '@shard/structure/planar'
world.spawn([DirectionalLight, { shadowUpdate: 'on-change' }], Transform)
app.world.resource(RenderStats).lastFrame.bytes.instances
```

### Agent surface

- `structure.describe`: counts, chunk grid, pieces per chunk, and the last compile's dirty chunks
  and time.
- `render.describe` gains `uploads` and `rebuilds` as above.
- `shard bench structure` runs the fixtures and prints the budgets.

## Decisions

- **Revisions over deep equality.** Aether's documents already carry `rev`. Comparing a number per
  doc is the only diff that's cheap at 5,000 walls on every message.
- **Clip geometry to chunks.** Assigning a whole piece to one chunk (by midpoint or bounding box)
  either culls visible parts or draws them twice. Clipping costs a few extra vertices at
  boundaries and makes both culling and dirty tracking exact.
- **Fixed chunk size.** Aether picks a chunk size per scene to target 64 pieces per chunk. A fixed
  8 m is simpler, is predictable for tests, and is configurable. It's revisited if the bench shows
  batches that are too small or too big.
- **One visual scale, separate from game distance.** Pixels locate geometry; "5 ft per square" is
  a rule for measuring. Mixing them would resize a map when someone relabels its units.
- **Door leaves as entities, not part of chunks.** Opening and closing is the most frequent
  structural change, and it should cost a transform.
- **Engine-owned structure, host-owned authority.** The engine draws walls; the server decides who
  sees through them.

## Acceptance criteria

Measured on the shadow-stress fixture (5,000 walls, 64 doors, 256 props, 1 floor, 12 tokens) and
on the max fixture (5,000 walls, 1,024 openings, 256 floors × 256 vertices, 64 materials,
256 props), both in `fixtures/structure/`:

- [ ] A token move writes one instance slot to `instances`, and no other scene bytes.
- [ ] A door toggle rebuilds 0 chunks, and each frame of its swing writes only the leaf's slot.
- [ ] A wall edit rebuilds exactly the chunks its old and new geometry overlap (checked against a
      reference overlap test), with compile under 4 ms in `pnpm bench` for a typical 3 m wall.
- [ ] A wall spanning 10 chunks, viewed so only one endpoint is on screen (its midpoint off
      screen), draws that endpoint (golden capture and a draw count above 0).
- [ ] A 60 m concave floor polygon (a simple polygon, as Aether's contract requires, with deep
      notches that cross chunk boundaries), clipped into chunks, keeps its exact area (± 0.1%). No
      point of it is covered by two chunks, and no gap shows at chunk seams at 30° and top-down
      (golden).
- [ ] Changing the grid's `distance`, `unit` or `diagonal` leaves every structure mesh, token
      transform and golden capture unchanged.
- [ ] Doubling the grid's `size` doubles the world footprint of cell-sized tokens and per-cell
      props, and leaves every wall, opening, floor, drawing and object position unchanged.
- [ ] `keyOf` on a pick hit against a token's visual child returns the token's host id.
- [ ] `mirror.sync` of 5,000 unchanged walls takes under 0.2 ms and allocates nothing.
- [ ] An unrelated host update (a Chat message: no mirror changes) writes 0 scene bytes, and in
      on-demand mode (0052) renders 0 frames.
- [ ] The max fixture builds from nothing in under 300 ms in `pnpm bench`.
- [ ] With `shadowUpdate: 'on-change'` and a still camera, an idle frame renders 0 shadow maps, and
      a token move renders only the cascades containing it.
- [ ] `planarBarriers` output matches Aether's structural barrier fixtures (door open/closed,
      window sight channels) segment for segment.
- [ ] Spawning and despawning the max fixture 20 times leaves `gpu.stats` at its baseline.

## Open questions

- Should chunks follow Aether's adaptive size so draw counts match its current numbers?
  Proposed: fixed first, measured against Aether's 138 batches.
