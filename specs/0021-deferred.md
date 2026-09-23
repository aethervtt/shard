# 0021 — Deferred rendering path

- **Status:** implemented
- **Packages:** `@shard/render`
- **Depends on:** 0007, 0018, 0019, 0020

## Context

Forward+ (0018) handles many lights well, but every fragment of every overdrawn surface pays for
the full material and lighting cost. In dense scenes, such as a base interior with hundreds of
lights or a forest of alpha-tested foliage, deferred shading does the lighting once per pixel.
It also produces the G-buffer that SSAO, SSR, and decals want.

VISION asks for both paths, chosen per camera, with materials unchanged between them. Transparent
objects always render forward.

## Goals

- `RenderPath { mode: 'forward' | 'deferred' }` on a camera. Both paths render the same scene to the
  same HDR target.
- The material surface stage (`pbr_input`) is reused as-is. Deferred writes `PbrInput` to a
  G-buffer, and a lighting pass evaluates the same lighting stage.
- The lighting pass uses the clusters from 0018 and the IBL from 0019.
- Materials that can't be deferred (custom lighting, unlit, transparent) render forward
  automatically, after the deferred lighting, with correct depth.
- G-buffer channels are viewable for debugging.

## Non-goals

- MSAA in deferred (use FXAA or TAA from 0023).
- Visibility buffer, decals, SSR (later; the G-buffer layout leaves room).
- Per-pixel material IDs for multiple lighting models in one pass (custom lighting is forward).

## Design

### G-buffer

| Target | Format | Contents |
|---|---|---|
| gbuffer0 | `rgba8unorm-srgb` | base color RGB, specular occlusion (A) |
| gbuffer1 | `rgba16float` | octahedral normal (RG), roughness (B), metallic (A) |
| gbuffer2 | `rg11b10ufloat` | emissive luminance, pre-exposed |
| depth | `depth32float` | reversed-Z (shared with forward) |

That's 12 bytes per pixel plus depth. The `shard::pbr::gbuffer` module packs and unpacks it, so a
future layout change touches one file.

### Passes

1. `deferred-gbuffer`: opaque and alpha-mask meshes whose material is deferrable run the vertex
   stage and `pbr_input`, then pack the result. No lighting.
2. `deferred-lighting`: a full-screen compute (or fragment) pass per view reads the G-buffer and
   depth, reconstructs position, and evaluates `apply_lighting`: directional lights with shadows,
   then cluster lights, then IBL and ambient, then emissive. It writes `hdr`.
3. `sky` (0019), then `forward-transparent` and forward-only opaque materials, all depth-tested
   against the G-buffer depth.

A material is deferrable when its definition (0020) uses the standard lighting model and isn't
transparent. The renderer decides per material. Agents don't choose.

### Choosing a path

- The default is `forward`: simpler, supports MSAA, and fine up to a few hundred lights with
  clustering.
- `deferred` suits scenes with heavy overdraw or many lights, and it's required for G-buffer
  effects (SSAO uses the forward prepass when there's no G-buffer).
- `render.describe` reports per view which meshes went deferred and which went forward, and why.

### Agent surface

- `render.capture { buffer: 'albedo' | 'normal' | 'roughness' | 'metallic' | 'emissive' | 'depth' }`
  shows a G-buffer channel (deferred views) or the equivalent reconstructed from the forward
  prepass.
- `render.describe` adds per view: the path, the G-buffer memory, the count of forward-only meshes,
  and GPU time per pass.

## Decisions

- **Reuse the material stages, don't fork them.** Deferred packs the same `PbrInput` forward
  consumes, so every material and extension works in both paths by construction.
- **12-byte G-buffer.** It fits the standard metal-roughness model in three targets, a size
  WebGPU's color attachment limits and mobile bandwidth allow.
- **Custom lighting renders forward.** A single deferred lighting model keeps the lighting pass
  simple. Toon and unlit materials still render correctly, forward, on top.
- **Forward is the default.** It covers most scenes and keeps MSAA. Deferred is an opt-in
  optimization.

## Acceptance criteria

- [x] A fixture scene (directional plus 64 point lights, shadows, IBL, mixed materials) renders in
      forward and deferred within tolerance of each other (mean absolute difference < 2 levels).
- [x] A scene with 1000 point lights and 4× overdraw renders faster in deferred than in forward
      (GPU timings), and at 60 fps at 1080p on the dev machine.
- [x] A transparent material and an unlit custom material in a deferred view render forward, in
      the correct depth order (golden image).
- [x] Each G-buffer debug buffer is captured as a golden image.
- [x] Switching a camera's `RenderPath` at runtime takes effect the next frame without errors.

## Implementation notes

- **No separate plugin:** the forward renderer installs the deferred nodes, so adding
  `RenderPath { mode: 'deferred' }` to a camera is all it takes. Deferred views are always single-
  sampled: MSAA is dropped for them, and they anti-alias in post (0023).
- **G-buffer as specified**, with two packing details, both in `shard::pbr::gbuffer`:
  - gbuffer0's alpha holds the material's occlusion (it feeds both diffuse and specular IBL
    occlusion).
  - `NotShadowReceiver` survives the G-buffer as +2 on the metallic channel.

  gbuffer2 is `rg11b10ufloat` when the device has `rg11b10ufloat-renderable`, which
  `createGpuContext` now requests whenever the adapter has it (along with
  `indirect-first-instance` and `float32-filterable`). Otherwise it's `rgba16float`.
- **Passes:**
  - `deferred-gbuffer` draws deferrable batches with the material's vertex and surface stages.
  - `deferred-lighting` is a fullscreen fragment pass. It rebuilds the world position from depth
    through `invViewProj` and calls the same `apply_lighting` as forward, so directional shadows,
    clusters, IBL, and ambient are shared by construction, and adds the pre-exposed emissive.
  - `deferred-forward` draws the opaque batches the G-buffer can't take (custom lighting) with
    their forward pipelines, over the lit result.
  - Then `sky` and `forward-transparent`.

  Every pass depth-tests against the same depth buffer.
- **Graph rule change:** "readers run after every writer" can't express read-then-write-later
  (the lighting pass reads `scene-depth`, and `deferred-forward` writes it afterwards). Readers now
  run after writers in their own and earlier phases, and before writers in later phases. Existing
  orderings are unchanged.
- **Routing:** each batch knows whether it's deferrable (standard lighting, not blended). Culling
  a deferred view sorts non-deferrable opaque slots into a separate `forwardOnly` list, and
  transparent ones into the back-to-front list.
- **Debug views:** G-buffer channels are debug views (`setDebugView(world, camera, 'albedo')`, or
  `captureGBuffer`). The channel renders into an 8-bit `gbuffer-debug` buffer. A forward view asked
  for one fills a G-buffer for that frame, with its own single-sample depth. Depth comes from
  `captureBuffer(world, view, 'depth')`. `render.capture { buffer }` takes the channel names.
- **Agent surface:** `render.describe` gains a `deferred` section per view: the path, G-buffer
  bytes, deferred and forward mesh counts, and why each forward mesh went forward (custom lighting
  by type, or transparent). GPU time per pass is in the profiler as before. `gpu:frame` is new: first
  pass start to last pass end, which stays meaningful on tile-based GPUs, where per-pass timestamps
  overlap and sum to more than the frame.
- **Measured:** the playground's `#deferred` demo is 1000 point lights over four screen-covering
  layers of alpha-tested foliage (the case where early depth rejection can't hide overdraw), at
  1920×1080 in Chrome on the dev machine (Apple M4). Both paths run at 60 fps. The GPU frame takes
  9.3 ms forward and 5.0–6.2 ms deferred.
- **Found along the way:** the lighting node first listed the shadow passes only in `after`, so
  the graph culled cascades in deferred views. The lava-in-deferred comparison caught it.

## Open questions

- None blocking. Deferred: decals written into the G-buffer, and SSR.
