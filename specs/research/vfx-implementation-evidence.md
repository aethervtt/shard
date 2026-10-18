# VFX implementation evidence — 0082 and 0083

Implemented for [PR #31](https://github.com/aethervtt/shard/pull/31), 2026-10-18.
The engine changes live in `packages/render`; sequence integration lives in `packages/effects`.
`apps/playground/vfx.html` is a runnable integration example with original host-catalog textures.
It is not a visual authoring editor.

## Functional evidence

| Contract | Reproduction and assertions |
|---|---|
| Bounded ribbon history | `packages/render/src/vfx.test.ts`: ring capacity, duplicate samples, lifetime expiry, pause, stop/drain, teleport reset, resizing, component removal |
| Attachments and origin | Parent/bone transforms, archetype migration, translated trail history, isolated worlds; receiver and projector origin translation preserves decal UVs and relative placement |
| Beams | Seeded displacement with fixed endpoints, live target updates and removal, local polylines, duplicate segments, invalid width curves, initially paused geometry |
| Decal projection | Six independent half-space clipping tests; finite geometry/UVs; angled box faces; back-face rejection; masks, transforms, visibility, mesh versions, singular transforms and invalid size |
| Bounds and diagnostics | 256 ribbons, 64 projectors, output/input triangle limits, invalid direct component capacities, unsupported skinned receivers; no partial mark on overflow |
| Sequence ownership | `packages/effects/src/visual.test.ts`: activation intervals, endpoint bindings, pause including draining trails, overlap rejection, skipped windows, dead endpoint failure, owned cleanup and borrowed target preservation |
| Schemas and authoring | `packages/project/src/project.test.ts`: generated Trail/Beam/Decal schemas and `.agents/vfx.md`; shared component definitions drive validation and inspector fields |
| Actual graphics | `apps/playground/src/vfx.test.ts`: WebGPU and minimum-profile WebGL2; isolated trail/beam/decal pixels, opaque beam/decal occlusion, excluded receiver pixels unchanged, perspective/orthographic views, visible fade, seed replay |
| GPU lifecycle | The same browser test checks separate per-camera uniforms, prunes removed views, recreates the device, verifies retained geometry and visible beam pixels afterwards; cancellation/completion leave zero VFX draw records |

The browser test saves `*-ribbons.png`, `*-decal.png`, `*-orthographic.png`, `*-fading.png`
and backend JSON containing runtime snapshots and pixel counts. It asserts no browser/GPU errors.
The dedicated workflow uploads these as `vfx-browser-<tested-merge-sha>`; performance reports use
`vfx-performance-<tested-merge-sha>`. Local captures are also retained under
`.shard/evidence/vfx-recovery-fixed/`; downloaded hosted artifacts are under `.shard/evidence/`.

Local verification: full workspace typecheck and lint pass; 11 renderer correctness checks,
12 effect runtime/visual checks and 9 project integration checks pass. The browser test passes
both backends. Lint retains five existing warnings outside this change. Project GPU tests need
adapter access; their sandbox-only attempt could not open an adapter and passed with GPU access.

## Hosted measurements

[Initial VFX run](https://github.com/aethervtt/shard/actions/runs/39147326718) measured:

- **AMD EPYC 9V74 80-Core Processor:** 128 trails × 64 points plus 32 cached decals,
  **1.041537 ms median**, **1.103050 ms p95**, **zero observed garbage collections**.
- Cold projection of 32 decals against one 12-triangle cube: **0.193821 ms median**,
  **0.348434 ms p95**. This small bounded fixture is not a claim about dense production meshes.

[Follow-up VFX run](https://github.com/aethervtt/shard/actions/runs/39147582177) measured:

- **AMD EPYC 7763 64-Core Processor:** the same steady workload,
  **1.979374 ms median**, **2.005323 ms p95**, **zero observed garbage collections**.
- Cold projection: **0.097472 ms median**, **0.917503 ms p95**.

These are unknown hosted machines in the performance registry. CI records observations and
checks allocation stability; it does not enforce the proposed 2 ms/8 ms laptop/desktop budgets
on an unmatched machine. No local build or benchmark was run.

## Packaging and regression gates

CI runs playground build, `pnpm size --check`, `pnpm release --check`, shader identity,
workspace typecheck/lint, Linux/Windows correctness and browser regressions.
The PR must pass every gate on its final revision before merge.

Compared with the previously merged run, full-plugin JavaScript grew **3716.5 → 3722.6 KiB**
Brotli. The full budget increases by **7 KiB**, corresponding to the added optional features.
Minimal renderer JavaScript grew **164.2 → 164.8 KiB** from schemas/feature warnings and remains
within its unchanged budget; baseline fallback remains **31.2 KiB**. No baseline-only code leaks
into the full-tier initial path, and existing WGSL is checked unchanged.

## Validation-driven corrections

Reviewing hosted images exposed a difference between adapters that a permissive pixel-presence
check did not catch: the resolved MSAA subsample could hide most of a coplanar decal's front face.
The decal pipeline now uses positive reversed-Z depth/slope bias. Browser tests require over
2,000 changed decal pixels and independently assert that an opaque blocker still hides the mark.
The test blocker covers the entire receiver; hiding only the beam was insufficient for this case.
The dedicated package job installs both Bun and Mesa for the existing consumer-release checks.
Plugin-reachability coverage explicitly includes both optional VFX plugins.

## Product boundaries

- Trails/beams are independent optional VFX plugins, coordinated with particles through effects.
  They do not emit from simulated particles or implement collision/damage.
- Decals are unlit color/emissive overlays on rigid, CPU-readable, opaque mesh receivers.
  Skinned/morph/compute-deformed receivers and PBR normal/roughness modification are deferred.
- Alpha compositing uses stable record creation order. Intersecting translucent strips are not
  sorted per segment or per pixel.
- A receiver index scales with the host's receiver entities. Projection has a broad-phase AABB
  check and per-projector triangle/output bounds; any receiver change conservatively invalidates
  projector caches. Dense moving receiver scenes need separate production profiling.
- Sampling is frame-aligned. Identical seeds and sampled motion replay; different timesteps need
  not produce identical trail geometry. The demo explicitly takes its initial sample before playback.
- Hosts own catalog resolution, persistence and gameplay. Aether can store documents and textures
  in its existing assets/database; no disk-path or URL-loading requirement is introduced.
