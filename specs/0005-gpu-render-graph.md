# 0005 — GPU layer and render graph

- **Status:** accepted
- **Packages:** `@shard/gpu`, `@shard/render`
- **Depends on:** 0003, 0004

## Context

The galaxy demo drew 600k stars with hand-written WebGPU calls in one system. That doesn't scale
to shadows, post-processing, 2D, UI, compute particles, and multiple cameras all sharing a frame.
Those need two things:

1. A thin GPU layer that caches pipelines, bind group layouts, and samplers, grows buffers, and
   reports errors in a way an agent can act on.
2. A render graph: passes declare what they read and write, and the graph orders them, allocates
   transient textures, and runs them.

## Goals

- Device setup with requested features/limits, device-lost handling, and structured GPU errors.
- Caches for render/compute pipelines (async creation), bind group layouts, and samplers.
- Growable GPU buffers and a per-frame upload path that works straight from ECS columns.
- A render graph with render, compute, and copy nodes; automatic ordering; transient texture pool.
- Frame phases: extract → prepare → queue → graph execute.
- Per-node GPU timings (timestamp queries) and a texture readback path for screenshots.
- Multiple views (cameras) per frame, each with its own target.

## Non-goals

- A second render world or pipelined rendering (0003 decided single world).
- WebGL2.
- Bindless or multi-draw-indirect (not in core WebGPU; revisit behind feature detection).

## Design

### GPU layer (`@shard/gpu`)

```ts
const gpu = await createGpuContext({
  canvas,                          // optional: omit for offscreen/headless
  features: ['timestamp-query'],   // requested if available
  requiredFeatures: [],            // fails with gpu/missing-feature if absent
})
```

- **`GpuBuffer`**: wraps `GPUBuffer` with `ensureCapacity(bytes)` (doubles, rebuilds dependent
  bind groups through a version counter) and `write(data, offset)`. The galaxy demo's hand-rolled
  growth becomes this.
- **`PipelineCache`**: keyed by a stable hash of the descriptor plus shader variant key. Uses
  `createRenderPipelineAsync`; until a pipeline is ready, draws that need it are skipped (and
  counted) instead of hitching the frame.
- **Layout and sampler caches**: equal descriptors return the same object.
- **Errors**: `pushErrorScope`/`popErrorScope` around pipeline and resource creation.
  Validation errors become `ShardError('gpu/validation', …)` naming the node, pipeline, or resource
  label. Every GPU object gets a label.
- **Device lost**: emits a `GpuDeviceLost` event; the render plugin recreates the device and
  rebuilds cached resources from their descriptors.

### Frame phases (`@shard/render`)

All in the `Last` schedule, as ordinary systems in sets:

1. **Extract**: read the world (cameras, visible meshes, lights) into render-side resources.
   Same world, so this is reading, not copying into another world.
2. **Prepare**: create/grow GPU resources, upload instance data and uniforms.
3. **Queue**: build per-view draw lists into phases (`Opaque3d`, `AlphaMask3d`, `Transparent3d`,
   `Opaque2d`, `Transparent2d`, `Ui`). Opaque sorts front-to-back by pipeline then depth;
   transparent sorts back-to-front.
4. **Graph**: execute the render graph for each view, submit once per frame.

Plugins add systems to these sets. The renderer core knows nothing about specific materials.

### Render graph

```ts
graph.addNode('shadow-maps', {
  writes: [{ texture: 'shadow-atlas', format: 'depth32float', size: [4096, 4096] }],
  run: (ctx) => { /* encode passes with ctx.encoder */ },
})
graph.addNode('main-opaque', {
  reads: ['shadow-atlas'],
  writes: ['view-color', 'view-depth'],
  run: (ctx) => { … },
})
```

- Nodes declare named texture/buffer resources they read and write. The graph orders nodes by
  those dependencies (with explicit `after` for side effects), detects cycles
  (`render/graph-cycle`), and culls nodes whose outputs nothing reads.
- **Transient resources** (declared with a descriptor in `writes`) come from a pool keyed by
  descriptor and are reused across frames. Aliasing within a frame is a later optimization; the
  API doesn't change for it.
- **Imported resources**: the swapchain texture, persistent buffers.
- **Sub-graphs per view**: each camera runs the view sub-graph against its own targets.
- Node kinds: render (gets a pass encoder with attachments set up from `writes`), compute, and raw
  (gets the command encoder, for copies and custom work).

### Timings and readback

- With `timestamp-query` available, each node writes begin/end timestamps; results are read back
  a few frames later and recorded into the profiler as `gpu:<node>`.
- `captureView(view)` copies the view's final color into a mappable buffer and resolves to RGBA8
  pixels plus size. This is the base for screenshots in the agent loop (M3).

### Headless

The GPU layer runs without a canvas: views render to offscreen textures. In Node, the `webgpu`
package (Dawn) provides `navigator.gpu`, so the CLI and GPU tests can render and read back pixels
without a browser.

### Agent surface

- `render.describe()`: nodes in execution order with reads/writes, views, phase item counts,
  pipelines pending compilation.
- Per-node GPU ms in the profiler.
- `captureView` for screenshots.
- `gpu/*` and `render/*` error codes, each with the label of the object involved.

## Decisions

- **Graph declared per frame from persistent node definitions.** Nodes register once; each frame
  the graph re-resolves which run (views change, nodes get culled). Cheap at our node counts.
- **Async pipelines, skip until ready.** A missing frame of one object beats a 100 ms hitch.
- **Labels everywhere.** WebGPU errors are only useful with labels, and agents need them.
- **Dawn in Node for headless.** Same WebGPU API, no separate code path.

## Acceptance criteria

- [ ] The galaxy demo is ported to `GpuBuffer` + a graph node and keeps its frame time.
- [ ] Nodes run in dependency order; a cycle throws `render/graph-cycle` naming the nodes;
      nodes whose outputs are unused don't run.
- [ ] Transient textures with equal descriptors are reused across frames (pool size stable over
      1,000 frames).
- [ ] Equal pipeline descriptors return the same cached pipeline; draws are skipped (not
      blocked) while a pipeline compiles.
- [ ] A deliberately invalid pipeline produces `gpu/validation` with the pipeline's label.
- [ ] With `timestamp-query`, per-node GPU timings appear in the profiler.
- [ ] `captureView` returns correct pixels for a cleared-to-color view, in the browser and in Node
      via Dawn.
- [ ] Two cameras render to two targets in one frame.

## Open questions

- **Deferred to implementation:** whether the `webgpu` npm package (Dawn) is stable enough on
  macOS/Windows/Linux for CI. Checked first when this spec is built; if it isn't, GPU tests and
  headless capture run in headless Chromium via Playwright instead. The API doesn't change either way.
