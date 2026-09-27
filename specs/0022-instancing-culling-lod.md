# 0022 — Instancing, culling, and LOD

- **Status:** implemented
- **Packages:** `@shard/render`, `@shard/core`, `@shard/gltf`, `@shard/protocol`
- **Depends on:** 0007, 0018, 0020

## Context

The forward queue (0007) culls every mesh on the CPU each frame and re-packs and uploads the
instance data of everything visible, even when nothing moved. At 10k cubes that fits the budget.
The proof project needs far more: scattered rocks, grass, and flora over a planet's surface
(hundreds of thousands of instances), ships and debris in space, and several shadow views per
frame, each needing its own culling.

This spec makes static content free after its first frame, moves culling to the GPU, and adds
level of detail and distance culling, so the per-frame cost scales with what changes and what's
visible, not with what exists.

## Goals

- Persistent instance data on the GPU: each instance has a slot, and only changed transforms are
  re-uploaded (change ticks). A static scene uploads nothing after its first frame.
- GPU frustum culling in a compute pass writing compacted instance lists and indirect draw
  arguments, one dispatch per view (camera and shadow views).
- `Lod`: mesh levels chosen by projected screen size, with hysteresis.
- `VisibilityRange`: distance culling per entity, for small props.
- A CPU path with identical results, for headless checks and devices without indirect drawing
  support.

## Non-goals

- Occlusion culling, hierarchical-Z, meshlets (later: GPU-driven rendering, M7).
- Automatic LOD mesh generation (simplification is an importer feature, later).
- Dithered LOD crossfades (later; v1 switches with hysteresis).

## Design

### Persistent instances

- Each (mesh, material) batch owns a growable storage buffer of instance records: the affine
  transform (48 bytes), bounds sphere, and flags (casts and receives shadows, LOD mask).
- Entities get a slot on insert and release it on removal, with a free list and periodic
  compaction. `GlobalTransform` change ticks mark slots dirty. Dirty slots upload in coalesced
  ranges.
- `render.describe` reports bytes uploaded per frame, so regressions show up.

### GPU culling

```
cull (compute, per view): for each instance in a batch
  if sphere outside frustum or outside VisibilityRange or LOD level ≠ this batch's level: skip
  idx = atomicAdd(&args[batch].instanceCount, 1)
  visible[batch.offset + idx] = instance
draw: drawIndexedIndirect(args[batch]) reading visible[] as the instance list
```

- One dispatch covers all batches of a view, using a batch table in a storage buffer. Shadow views
  (cascades, spots, point faces) cull with their own frustums in the same pass.
- The vertex stage reads the transform through `visible[instance_index]` → `instances[...]`, so
  the forward, prepass, shadow, and G-buffer pipelines share it.
- Readback isn't needed. Visible counts reach `render.describe` through a small async readback,
  one frame late.

### LOD

```ts
Lod { levels: [{ mesh: handle('Mesh'), screenSize: f32 }], hysteresis: f32 = 0.1, bias: f32 = 0 }
```

- `screenSize` is the projected bounding-sphere diameter as a fraction of viewport height. The
  first level whose threshold the object exceeds is chosen, and a level only changes once the size
  crosses a threshold by more than `hysteresis`.
- Selection happens per view: shadow views use the main camera's selection, so shadows don't pop
  independently.
- `Lod` replaces `Mesh3d.mesh` as the source of the drawn mesh when present. glTF imports can map
  `MSFT_lod` or name suffixes (`_LOD0`…) to `Lod` components through an importer setting.

### Visibility ranges

`VisibilityRange { start: f32, end: f32 }` in meters from the camera, with a small fade margin,
applied in the cull pass.

### Agent surface

- `render.describe` per view reports: batches, instances, visible after culling, per-LOD counts,
  bytes uploaded, and culling time.
- `render.capture { debug: 'lod' }` tints meshes by LOD level. `{ debug: 'culling' }` freezes the
  culling camera so you can fly around and see what was culled.

## Decisions

- **Persistent slots with dirty ranges.** Most instances in a world don't move each frame, so the
  cost should follow change, not count.
- **GPU culling with indirect draws in v1.** The CPU path already hits limits at the proof
  project's scatter densities. Culling shadow views on the GPU is where the win compounds.
- **Screen-size LOD with hysteresis.** It works for any field of view and resolution, and
  hysteresis prevents flicker without crossfade machinery.
- **Shadows follow the camera's LOD.** Independent selection causes shadows to pop out of step
  with their casters.

## Acceptance criteria

- [x] After the first frame, a static scene of 100k instances uploads 0 instance bytes per frame.
      Moving 100 of them uploads roughly 100 × 64 bytes.
- [x] 200k instances across 20 mesh types (plus 4 shadow cascades) render at 60 fps at 1080p on
      the dev machine, with CPU render preparation under 1 ms.
- [x] GPU and CPU culling produce the same visible sets for camera and shadow views of a fixture.
- [x] LOD switches at the configured screen sizes and doesn't flicker when the size oscillates
      within the hysteresis band (test). Shadows use the camera's level.
- [x] `VisibilityRange` hides props beyond `end` in the camera and shadow views.
- [x] Every existing golden image is unchanged by the new instancing path.

## Implementation notes

- **One instance buffer for every batch.** Every `Mesh3d` entity owns a slot in a single
  storage buffer of 64-byte records:
  - the affine transform rows (48 bytes);
  - the batch index, or `LOD_BIT | set` for an entity with `Lod`;
  - the flags (visible, caster, receiver, has range, has LOD);
  - the visibility range as two f16s;
  - the entity id.

  Batches own no instance memory. The bounding sphere is per batch, taken from the mesh's box (its
  half-diagonal), and scaled per slot by the largest axis of the transform. Freed slots go on a
  free list. There's no compaction: a slot's index never changes while its entity lives.
- **Uploads follow change ticks.** Dirty slots upload in coalesced runs. `render.describe`
  reports `culling.uploadedBytes`. With 200k static instances it's 0, and moving 100 uploads
  exactly 6400 bytes.
- **Skipping unchanged tables took a core change.** Visiting every row each frame costs ~6 ns a
  row, which is 1.2 ms at 200k, over budget before anything else runs. Now:
  - `Table` tracks the newest change tick per component (`lastChanged(def)`, and `touch(def)` for
    code that writes `changedTicks()` directly, as transform propagation does).
  - It also tracks `lastStructural`, the tick a row last moved in or out. That's needed because
    rows that move tables keep their old change ticks.
  - `compute-visibility` now marks only rows whose visibility flips.

  `prepare-instances` skips any table where nothing changed, and CPU preparation for 200k static
  instances dropped from 1.3 ms to 0.03 ms.
- **The cull is one compute pass per frame.** It has three dispatches: reset the indirect
  arguments, cull camera views, cull shadow views (cascades, spot maps, point faces). Every
  (view, batch) pair gets an indirect draw with `indirect-first-instance`.
  - Visible entries are `slot | level << 28`, so the vertex stage gets the LOD level too.
  - Nothing is read back within the frame. Counts reach `RenderStats` and `render.describe`
    through an async readback a frame or two late. `GpuCuller.whenIdle()` lets tests wait for
    them.
- **What stays on the CPU:**
  - Transparent instances. They need a back-to-front sort, and only the members of blended batches
    are visited.
  - Everything, on devices without `indirect-first-instance`, or with `Culler.enabled = false`.
    The CPU path runs the same tests in the same order with f32 math, so the sets match exactly
    (tested for a camera, 4 cascades, and a spot light over 600 mixed instances).
- **Cascade fitting on the GPU path** can't take the union of what each cascade culled, so it fits
  to the bounds of every shadow caster (cached until an instance changes).
- **LOD:**
  - `Lod.levels` holds up to 8 levels.
  - Selection mirrors `selectLod` exactly. From no previous level it takes the first threshold the
    size reaches. After that, a level changes only once the size crosses a threshold by more than
    `hysteresis`. Smaller than the last level means not drawn.
  - The chosen level is kept per camera, per slot, on the GPU, and each camera's shadow views read
    its choice without updating it.
- **`VisibilityRange` has no fade margin:** it's a hard cut at `start` and `end`. Fading needs the
  dithered crossfade that LOD transitions also lack.
- **glTF import:** a `lods` import setting (`auto` by default, or `none`).
  - `auto` turns an `MSFT_lod` chain, or sibling nodes named `<name>_LOD0`, `_LOD1`…, into one
    entity with `Lod` (named `<name>` in the second case).
  - Level k uses the same primitive of each lower node's mesh.
  - `MSFT_screencoverage` is a fraction of screen area, so its square root becomes the
    `screenSize`. Without it, levels step down by 4× and the last level always draws.
- **Agent surface:**
  - `render.describe` has a `culling` section with the mode (gpu or cpu), instances, batches, LOD
    sets, and bytes uploaded.
  - It also reports CPU time for the three preparation systems (total and each), the cull pass's
    GPU time, and per view: batches, visible count, per-LOD counts, the shadow view count, and
    whether culling is frozen.
  - `render.capture { debug: 'lod' }` tints meshes by level: green, yellow, orange, red.
  - `{ debug: 'culling' }` freezes the camera's cull frustum and eye, and they stay frozen across
    later captures until `{ debug: 'none' }`.
- **Measured:** the playground's `#crowd` demo, at 1920×1080 in Chrome on the dev machine (Apple
  M4):
  - The scene is 200k static instances of 20 mesh types with LOD chains (every fifth a small prop
    with a 120 m `VisibilityRange`), under a sun with 4 cascades, with the camera orbiting.
  - It runs at 60 fps with a 5.9 ms GPU frame, 78k instances visible, and 0.08 ms of CPU
    preparation.
  - `?nolod` (every instance at full detail) is geometry-bound at 49 fps. Frame time scales
    linearly with instance count, so the triangles are the cost there.
- **Found along the way:**
  - The culler kept references to the caller's reused plane arrays, so every view culled with the
    last view's frustum. It copies them now.
  - WESL rejects `set` and `local` as identifiers.
  - The visible buffer lacked `COPY_SRC`, so test readbacks came back as zeros.
  - `setRange` ran for every ranged row each frame and allocated in `toHalf`. It runs on change
    now.
  - The asset preview's render loop didn't wait for skipped draws, the way `settle` does.
  - Found by the physics demo (0028): a grown `GpuBuffer` starts empty, but the store only
    uploaded dirty slots, so everything uploaded before the 257th instance vanished. Growing the
    instance or previous-transform buffer now marks every live slot dirty. Tested in
    `instances.test.ts`.
- Found by planet terrain at 2460×1790 (with 0044):
  - GPU culling issued one indirect draw per live batch, visible or not. A planet keeps ~2 000
    pooled chunks, mostly hidden, so ~1 200 empty draws a frame each paid their binds and calls.
    Views now skip small batches (up to 8 members) whose instances are all hidden.
  - Opaque draws went in batch order, so far terrain was shaded before near terrain covered it.
    Camera views now order opaque draws nearest first within each run sharing a pipeline, a
    material, and (for GPU mesh arenas) vertex buffers, so reordering never adds binds: one
    typed-array sort of packed keys, no allocation. GPU frame at 2460×1790, MSAA 4×: 12.1 → 10.1 ms.

## Open questions

- None blocking. Deferred: hierarchical-Z occlusion culling (M7), and LOD crossfades.
