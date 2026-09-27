# 0027 — Debug drawing and picking

- **Status:** implemented
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-sprite`, `@aethervtt/shard-protocol`, `@aethervtt/shard-project`, `apps/cli`
- **Depends on:** 0005, 0007, 0011, 0013, 0022

## Context

When a scene looks wrong, you need to see what the engine thinks is there: bounds, light ranges,
cameras, paths, collision shapes. A game needs the same tools to draw a laser line or a
target reticle, or to answer "what did the player click?".

An agent is limited to screenshots. It can't hover over a pixel to find the entity there, and a
screenshot doesn't say which blob is `ship/cockpit`. Picking and labeled overlays close that gap:
they turn pixels back into entities and paths.

## Goals

- `Gizmos`: an immediate-mode drawing API (lines, arrows, boxes, spheres, frustums, grids, text
  labels) from any system. Drawings last for a frame or for a duration.
- Built-in overlays, toggled by a resource: bounds, light volumes, cameras, cascade splits,
  normals, transform axes, entity labels.
- GPU picking: an entity-ID pass on demand. `pick(camera, x, y)` returns the entity, world position,
  and normal.
- A CPU ray-picking fallback, against bounds and against mesh triangles when CPU data is available.
- Captures with overlays: `render.capture` can draw bounds and entity-path labels, so an agent can
  connect what it sees with scene paths.

## Non-goals

- A transform gizmo editor (translate/rotate/scale handles); an interactive editor isn't in scope
  (VISION non-goals). The drawing API makes one possible later.
- Collider visualization content (M6 physics adds its drawings through this API).

## Design

### Gizmos

```ts
const gizmos = world.resource(Gizmos)
gizmos.line(a, b, color)
gizmos.arrow(from, to, color)
gizmos.box(center, size, rotation, color)
gizmos.sphere(center, radius, color)
gizmos.frustum(viewProj, color)
gizmos.grid(center, normal, cells, spacing, color)
gizmos.label(position, text, color)            // built-in pixel font, faces the screen
gizmos.line(a, b, color, { duration: 2, depthTest: false, width: 3 })
gizmos.bounds(localAabb, affineRows, offset, color)   // an oriented box (overlays use it)
```

- Calls append to typed arrays (positions, rgba8 colors, flags), with no per-call allocation, so
  they're safe in systems. Every shape is line segments. The line buffer uploads once per frame,
  and lines draw as screen-space-width quads, 1–N pixels wide with anti-aliasing, in a `gizmos`
  pass after transparent geometry, particles, and the resolve, before post-processing and
  tonemapping.
- `depthTest: false` draws on top, and occluded parts of depth-tested gizmos draw dimmed
  (see-through hint). The pass compares against the resolved depth buffer in the shader.
- Labels use a font built into the renderer (Inter at 13 px, ASCII, baked into a 4-bit atlas),
  drawn pixel-aligned on a dark backing just above their anchor. Labels default to
  `depthTest: false`.
- Three lists: this frame's (cleared in `First`), timed ones (`duration`), and overlays (redrawn by
  their system on every render, so a capture of a paused game doesn't draw them twice).
- Headless builds keep the API, so recorded gizmos appear in captures and in `debug.gizmos` output
  as data.

### Overlays

`DebugOverlays { bounds, lights, cameras, cascades, normals, axes, labels, filter, name }` is a
resource. `filter` limits overlays to a component set or a path prefix. One system, in `Last` after
the forward queue, draws the enabled overlays through `Gizmos`:

- bounds: each visible mesh's local bounds through its transform (an oriented box).
- lights: point-light range spheres, spot cones at range, arrows along directional lights.
- cameras: other cameras' frustums (not the primary camera's, which you're looking through).
- cascades: the primary camera's shadow cascade boxes, tinted by index.
- normals: vertex normals of visible meshes, at most 1500 per mesh.
- axes: every transform's X, Y, Z.
- labels: scene paths above meshes (`#id` for unnamed meshes), and at the origin of named
  entities without a mesh.

`name` gives the text for labels and the path filter. It defaults to `scene/SceneMember.path`,
found by name so the renderer doesn't import the scene package.

### Picking

- **GPU:** when a pick is requested, the `picking` node renders visible meshes (sharing the culled
  lists from 0022, with each material type's vertex hook) into an `r32uint` entity target and an
  `rgba32float` target holding the world normal and the depth. The readback node copies the
  requested pixels asynchronously, and the pick resolves on the next frame. Depth rides in a color
  target because depth formats only copy out whole.
- If a pick pipeline is still compiling that frame, the request waits for the next one rather
  than missing.
- `pick(world, camera, x, y)` returns a Promise of `{ entity, path, position, normal, distance } |
  undefined`. The position comes from the depth through the unjittered view-projection, and the
  normal from the geometry.
- Other packages add pickable things through `Picking.drawers`. Sprites draw their world-space
  runs into the pick pass, with texels under half opacity not counted.
- **CPU:** `raycast(world, origin, direction, { maxDistance, all, boundsOnly })` tests bounds (a
  BVH over the world bounds of mesh entities, rebuilt when a mesh entity moves, changes mesh,
  appears, or goes away), then mesh triangles when the mesh has CPU positions. It reads the ECS and
  the `Meshes` store only, so it works without a GPU. `all` returns every entity along the ray (the
  nearest hit on each).
- Instanced, LOD, and world sprite entities are GPU-pickable. The raycast covers meshes (LOD
  entities by their most detailed level). Gizmos, screen sprites, and text aren't pickable.

### Agent surface

- Protocol methods, each also an MCP tool:
  - `render.pick { camera?, x, y }` → entity, path, world position, normal, and distance (`pick`).
    MCP `pick`.
  - `world.raycast { origin, direction, maxDistance?, all? }` → hits (`raycast`). MCP `raycast`.
  - `render.capture { overlays: ['bounds', 'labels'], filter?, components? }` → an image with
    entity paths drawn at their screen positions. The overlays apply to that capture only. MCP
    `screenshot` takes the same parameters.
  - `debug.overlays { overlays, filter?, components? }` sets which overlays show every frame (MCP
    `debug_overlays`). `debug.gizmos { limit }` lists what was drawn last frame as data (MCP
    `list_gizmos`).
- A generated skill, `inspect-a-scene.md`: capture with labels, pick what looks wrong, get that
  entity, patch it, capture again.

## Decisions

- **Immediate mode with typed-array storage.** Gameplay and debug code can draw from anywhere
  without managing entities, and without allocating per call.
- **GPU picking is on demand.** It costs nothing when nobody's picking. Reusing the culled lists
  keeps the pass cheap.
- **Labeled captures for agents.** Paths drawn on the image let a model connect what it sees with
  what it can patch. That's the core of the debugging loop.
- **A CPU raycast exists too.** Gameplay needs raycasts on the server and in tests without a GPU.
  Physics (M6) will add collider raycasts behind the same function.

## Acceptance criteria

- [x] Every gizmo shape renders as a golden image. 100k gizmo lines per frame add no allocations
      (no GC events over 30 frames) and cost under 1 ms of CPU time.
- [x] `render.pick` returns the right entity and path for 20 sampled pixels of a fixture with
      instanced, LOD, and sprite entities, with the world position within 1 cm of the analytic
      value.
- [x] `world.raycast` hits the same entities as GPU picking for the same rays, headless.
- [x] `render.capture { overlays: ['bounds', 'labels'] }` produces a golden image with readable path
      labels next to each entity.
- [x] Each overlay toggles through `debug.overlays`, and the `filter` limits it to matching
      entities.

## Implementation notes

- `packages/render`: `gizmos.ts` (the API, its lists, upload, and the `gizmos` node),
  `gizmo-font.ts` (the baked label font), `overlays.ts`, `picking.ts` (GPU pick, readback, CPU
  raycast and its BVH), `debug-shaders.ts`. `forwardPlugin` installs them. `drawMaterials` gained
  a `PASS_PICK` pass.
- Labels don't use the 0025 text package. The renderer can't depend on it, and labels have to work
  in every project, headless included, with no font asset to import. A small baked font does that.
  A game that wants styled world-space text uses `Text`.
- `packages/sprite`: sprite records carry their entity, `shard::sprite` has an `fs_pick` entry
  point, and the plugin registers a pick drawer. Tilemaps aren't pickable yet.
- Measured on the dev machine: 100k `line()` calls take 0.49 ms at best and about 0.6 ms median
  (no GC). Uploading those 3.2 MB takes another 0.3–0.9 ms, depending on load. The test holds the
  drawing calls to the budget and logs the upload.
- The BVH rebuilds rather than refits when something moves. That's cheap at the entity counts
  raycasts see today; refitting is the next step if a scene moves thousands of meshes every frame.
- `render.capture` with overlays turns them on for that capture and restores the previous
  overlays after, so a labeled screenshot doesn't leave labels in the game.
- The generated skill `inspect-a-scene.md` covers the loop: labeled screenshot, pick, get,
  patch, screenshot again.
- Tests: `render/src/gizmos.test.ts` (shapes golden, timed gizmos, the 100k-line check, GPU vs
  CPU picks, raycasts without a GPU, overlays and filters), `sprite/src/picking.test.ts` (20
  pixels over instanced, LOD, and sprite entities, positions within 1 cm), and
  `protocol/src/debug.test.ts` (the labeled capture golden, `render.pick` against `world.raycast`,
  `debug.overlays`, and `debug.gizmos`).

## Open questions

- None blocking. Deferred: transform handles for a future editor, built on this API.
