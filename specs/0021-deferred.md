# 0021 — Deferred rendering path

- **Status:** accepted
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

- [ ] A fixture scene (directional plus 64 point lights, shadows, IBL, mixed materials) renders in
      forward and deferred within tolerance of each other (mean absolute difference < 2 levels).
- [ ] A scene with 1000 point lights and 4× overdraw renders faster in deferred than in forward
      (GPU timings), and at 60 fps at 1080p on the dev machine.
- [ ] A transparent material and an unlit custom material in a deferred view render forward, in
      the correct depth order (golden image).
- [ ] Each G-buffer debug buffer is captured as a golden image.
- [ ] Switching a camera's `RenderPath` at runtime takes effect the next frame without errors.

## Open questions

- None blocking. Deferred: decals written into the G-buffer, and SSR.
