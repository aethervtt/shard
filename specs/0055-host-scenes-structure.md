# 0055 — Host-driven scenes and incremental structure

- **Status:** accepted
- **Packages:** `@aethervtt/shard-mirror` (new), `@aethervtt/shard-structure` (new), `@aethervtt/shard-render`, `@aethervtt/shard-gpu`,
  `@aethervtt/shard-core` (polygon math)
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

- `@aethervtt/shard-mirror`: keyed sync from host documents to entities. It is O(n) over revisions, writes
  only changed fields, and allocates nothing when nothing changed.
- `@aethervtt/shard-structure`: walls, openings (doors and windows) and floors as components. Walls compile
  into chunked, per-material meshes; an edit rebuilds only the chunks it touches. Door leaves are
  their own instances.
- Upload accounting: bytes written to the GPU per frame, by category, and rebuild counts.
- Cached shadow maps that re-render only when a caster or the light changed.
- Fixtures at Aether's maximum sizes, with budgets checked in `pnpm bench`.

## Non-goals

- Vision, fog of war, line of sight and the planar authority itself. The host's server stays
  authoritative. `@aethervtt/shard-structure/planar` offers the barrier split as a pure function a host may
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
tokens.last                  // what the last call did: { spawned, applied, removed }
```

A `despawn(entity, world, key)` option replaces the default `world.despawn`, for documents whose
teardown is more than an entity (a host material releasing its GPU copy).

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
           hinge: 'start' | 'end', swing: 'left' | 'right', state: 'closed' | 'open' | 'locked',
           sight: 'normal' | 'none', movement: 'normal' | 'none' }
Floor    { points: list(vec2) (3–256, either winding), elevation: f32, material: handle('Material') }
StructureSettings (resource) { chunkSize: f32 = 8, doorSwingMs: f32 = 250, reducedMotion: bool }
StructureChunk { x: i32, z: i32 }        // on each (chunk, material) mesh entity structure spawns
DoorLeaf { opening: entity, angle: f32 }  // on each door leaf and window pane
```

`sight` and `movement` are Aether's opening channels; only `planarBarriers` reads them. Walls and
floors with no material draw in a plain grey.

**Units.** Structure is in world units (metres by convention), and the host converts its own
coordinates with **one fixed visual scale**. For Aether that's `world = px × pxToWorld`, a
constant of the adapter. It is never derived from the grid's game distance (`distance`, `unit`,
"5 ft per square"). Those give cells a game meaning for measurement (`@aethervtt/shard-grid/math`
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

- walls split around their openings, extruded to `height`: full-height spans between openings,
  the wall below a window's sill and above an opening's head (with its underside);
- door and window frames: two jambs and a head, plus a sill rail for windows, standing
  `frameDepth` out from each face, in the frame material (or a built-in wood, 0066);
- floors, triangulated once by ear clipping (`polygon.triangulate` in `@aethervtt/shard-core`,
  which bridges holes for vector fills and fog, 0057 and 0058).

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

**Door leaves.** Each door spawns a leaf entity: one shared unit-box mesh, hinged at its local
origin, in the frame material. It's a root entity, not a child of the opening (an Opening has no
Transform, and transforms propagate from roots); `DoorLeaf.opening` links it back, and it goes
when the opening does. A `state` change sets the leaf's target angle. `structure/doors` animates
it over `doorSwingMs` (instantly with `reducedMotion`), holding a frame demand (0052) while it
moves, and writes the leaf's Transform columns directly. A door toggle is therefore zero chunk
rebuilds and one instance slot per animated frame. Windows get a glass pane entity with a blended
material, which casts no shadow.

**Planar split.** `planarBarriers(walls, openings) → Segment[]` in `@aethervtt/shard-structure/planar` is
the same split compile uses, with `sight` and `movement` channels, as a pure function with no ECS
or GPU.

### Upload accounting

`GpuContext` counts bytes written through `writeBuffer`, `writeTexture` and
`copyExternalImageToTexture`, and buffers and textures created, per owner (0052) and category:
`instances`, `meshes`, `materials`, `textures`, `lights`, `shadows`, `view`, `other`.
Categories come from the label of the buffer (textures are always `textures`); buffers named after
their view (`camera:12/view`), `globals` and the culling tables are `view`. `gpu.uploads(owner)`
is the running total. `RenderStats` (still the per-view `Map`) closes each rendered frame into
`lastFrame` and a rolling 60-frame `recent`: bytes by category, `sceneBytes`, `created`,
`chunksRebuilt`, `meshesRebuilt` (meshes uploaded, new or changed) and `shadowMapsRendered`.
`render.describe` reports them as `uploads`. *Scene data* means everything but `view` (camera and
per-frame uniforms).

A moved instance's slot is 112 bytes: its 64-byte record and its 48-byte previous transform (for
motion vectors). The frame after a move, the previous transform catches up: 48 more bytes for the
same slot. Directional light data and shadow view matrices are written only when they change, so
a still frame writes no scene data at all.

A mesh whose new data fits its GPU buffers is rewritten into them (`GpuAssets`), with no buffer
created; one that grew gets new buffers.

### Cached shadows

`DirectionalLight`, `SpotLight` and `PointLight` get `shadowUpdate: 'always' | 'on-change'` (point lights
too: a table lit by shadowed torches is the common case). With `'on-change'`,
a light re-renders its map (or a cascade) only when the light moved, the cascade's fit moved, or a
shadow-casting instance inside its bounds changed. Instance stores already know the slots that
moved this frame; the queue tests their spheres, before and after the move, against each
cascade's cull planes (open toward the light). Anything else that changes what casts shadows
bumps `InstanceStore.shadowEpoch` and redraws every cached view once: a slot's batch, its
caster or visible flag, or a batch's mesh data (a chunk rebuilt in place). Deforming (skinned or
morphed) casters, a recreated shadow texture, and a draw skipped while its pipeline compiled all
redraw too. A top-down VTT camera that isn't moving, over a static structure, renders no shadow
passes.

### API sketch

```ts
import { createMirror } from '@aethervtt/shard-mirror'
import { structurePlugin, Wall, Opening, Floor, StructureSettings } from '@aethervtt/shard-structure'
import { planarBarriers } from '@aethervtt/shard-structure/planar'
world.spawn([DirectionalLight, { shadowUpdate: 'on-change' }], Transform)
app.world.resource(RenderStats).lastFrame.bytes.instances
```

### Agent surface

- `structure.describe`: counts, chunk grid, pieces per chunk, and the last compile's dirty chunks
  and time.
- `render.describe` gains `uploads` and `rebuilds` as above.
- `shard bench structure` runs the fixtures and prints each measurement against its budget
  (`@aethervtt/shard-structure/bench`).

### Fixtures

`packages/structure/fixtures/structure/` generates Aether-shaped scenes from a seed (pixels, ids,
revisions): `shadowStress()` and `maxScene()`. `@aethervtt/shard-structure/fixtures` has a
reference host adapter, `hostScene(world)`, that mirrors them onto the engine at 70 px = 1.5 m,
with tokens as a root and a disc child and props sized per cell. Aether's own adapter lives in
Aether.

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

- [x] A token move writes one instance slot to `instances` (its record and previous transform,
      112 bytes), and no other scene bytes.
- [x] A door toggle rebuilds 0 chunks, and each frame of its swing writes only the leaf's slot.
- [x] A wall edit rebuilds exactly the chunks its old and new geometry overlap (checked against a
      reference overlap test), with compile under 4 ms in `pnpm bench` for a typical 3 m wall.
- [x] A wall spanning 10 chunks, viewed so only one endpoint is on screen (its midpoint off
      screen), draws that endpoint (golden capture and a draw count above 0).
- [x] A 60 m concave floor polygon (a simple polygon, as Aether's contract requires, with deep
      notches that cross chunk boundaries), clipped into chunks, keeps its exact area (± 0.1%). No
      point of it is covered by two chunks, and no gap shows at chunk seams at 30° and top-down
      (golden).
- [x] Changing the grid's `distance`, `unit` or `diagonal` leaves every structure mesh, token
      transform and golden capture unchanged.
- [x] Doubling the grid's `size` doubles the world footprint of cell-sized tokens and per-cell
      props, and leaves every wall, opening, floor, drawing and object position unchanged.
- [x] `keyOf` on a pick hit against a token's visual child returns the token's host id.
- [x] `mirror.sync` of 5,000 unchanged walls takes under 0.2 ms and allocates nothing.
- [x] An unrelated host update (a Chat message: no mirror changes) writes 0 scene bytes, and in
      on-demand mode (0052) renders 0 frames.
- [x] The max fixture builds from nothing in under 300 ms in `pnpm bench` (host sync, compile and
      the first frame's uploads).
- [x] With `shadowUpdate: 'on-change'` and a still camera, an idle frame renders 0 shadow maps, and
      a token move renders only the cascades containing it.
- [x] `planarBarriers` output matches Aether's structural barrier fixtures (door open/closed,
      window sight channels) segment for segment.
- [x] Spawning and despawning the max fixture 20 times leaves `gpu.stats` at its baseline (taken
      after one warm-up cycle: the instance and cull buffers, and the shared leaf and prop meshes,
      stay).

## Open questions

- Should chunks follow Aether's adaptive size so draw counts match its current numbers?
  Proposed: fixed first, measured against Aether's 138 batches. Measured: the shadow-stress
  fixture compiles to 899 chunks and 5,041 meshes (8 materials), and the max fixture to 884 chunks
  and 8,812 meshes (64 materials), so a view draws hundreds to thousands of small batches.
  Merging a chunk's materials into one mesh (a material index per vertex), or larger chunks, is
  the next step if Aether's frame times need it.
