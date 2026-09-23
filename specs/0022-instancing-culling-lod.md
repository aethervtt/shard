# 0022 — Instancing, culling, and LOD

- **Status:** accepted
- **Packages:** `@shard/render`
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

- [ ] After the first frame, a static scene of 100k instances uploads 0 instance bytes per frame.
      Moving 100 of them uploads roughly 100 × 64 bytes.
- [ ] 200k instances across 20 mesh types (plus 4 shadow cascades) render at 60 fps at 1080p on
      the dev machine, with CPU render preparation under 1 ms.
- [ ] GPU and CPU culling produce the same visible sets for camera and shadow views of a fixture.
- [ ] LOD switches at the configured screen sizes and doesn't flicker when the size oscillates
      within the hysteresis band (test). Shadows use the camera's level.
- [ ] `VisibilityRange` hides props beyond `end` in the camera and shadow views.
- [ ] Every existing golden image is unchanged by the new instancing path.

## Open questions

- None blocking. Deferred: hierarchical-Z occlusion culling (M7), and LOD crossfades.
