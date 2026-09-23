# 0027 — Debug drawing and picking

- **Status:** accepted
- **Packages:** `@shard/render`, `@shard/protocol`, `apps/cli`
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
gizmos.label(position, text, color)            // uses 0025 text, billboarded
gizmos.line(a, b, color, { duration: 2, depthTest: false })
```

- Calls append to typed arrays (positions and colors), with no per-call allocation, so they're safe
  in systems. The line buffer uploads once per frame, and lines draw as screen-space-width
  quads, 1–N pixels wide with anti-aliasing, in a `gizmos` pass after transparent geometry and
  before tonemapping. They're HDR-bright, so they read over any scene.
- `depthTest: false` draws on top, and occluded parts of depth-tested gizmos draw dimmed
  (see-through hint).
- Headless builds keep the API, so recorded gizmos appear in captures and in `debug.gizmos` output
  as data.

### Overlays

`DebugOverlays { bounds, lights, cameras, cascades, normals, axes, labels, filter }` is a resource.
`filter` limits overlays to a component set or a path prefix. Each overlay is a system that draws
through `Gizmos`.

### Picking

- **GPU:** when a pick is requested, the `picking` node renders visible meshes (sharing the culled
  lists from 0022) into an `r32uint` entity-index target and a depth target, then reads back a small
  region around the requested pixel asynchronously. It resolves on the next frame.
- `pick(world, camera, x, y)` returns a Promise of `{ entity, path, position, normal, distance } |
  undefined`. The position comes from depth; the normal from depth derivatives or the G-buffer.
- **CPU:** `raycast(world, origin, direction, options)` tests bounds (a BVH over mesh bounds,
  rebuilt incrementally), then mesh triangles when the mesh keeps CPU data (runtime meshes do). It
  works headless without a GPU.
- Instanced, LOD, and sprite entities are pickable. Gizmos and screen text aren't.

### Agent surface

- Protocol methods, each also an MCP tool:
  - `render.pick { camera?, x, y }` → entity, path, and world position (`pick`).
  - `world.raycast { origin, direction }` → hits (`raycast`).
  - `render.capture { overlays: ['bounds', 'labels'], filter? }` → an image with entity paths drawn
    at their screen positions.
  - `debug.overlays` to toggle overlays, and `debug.gizmos` to list what was drawn this frame as
    data.
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

- [ ] Every gizmo shape renders as a golden image. 100k gizmo lines per frame add no allocations
      (heap snapshot test) and cost under 1 ms of CPU time.
- [ ] `render.pick` returns the right entity and path for 20 sampled pixels of a fixture with
      instanced, LOD, and sprite entities, with the world position within 1 cm of the analytic
      value.
- [ ] `world.raycast` hits the same entities as GPU picking for the same rays, headless.
- [ ] `render.capture { overlays: ['bounds', 'labels'] }` produces a golden image with readable path
      labels next to each entity.
- [ ] Each overlay toggles through `debug.overlays`, and the `filter` limits it to matching
      entities.

## Open questions

- None blocking. Deferred: transform handles for a future editor, built on this API.
