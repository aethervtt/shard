# 0101 — Screen-space reflections

- **Status:** draft
- **Packages:** `@aethervtt/shard-render`
- **Depends on:** 0019, 0021, 0023, 0040, 0051, 0056, 0064, 0097

## Context

Shard reflects only its environment. `environment_light` (`render/src/shaders.ts`) samples the
prefiltered environment cube at a mip chosen by roughness, with a BRDF LUT (split-sum) and Lagarde
specular occlusion from SSAO. A wet street, a polished floor or a lake mirrors the sky but not the
buildings, the car, or the player standing on it. 0019, 0021 and 0023 all list screen-space
reflections as "later", and 0097's water needs them for docks and boats.

Screen-space reflections march each pixel's reflected ray through the depth buffer and, where it
hits, take the colour already rendered there. They're cheap, need no scene representation, and
work with everything that draws depth. They can't reflect what's off screen or behind something,
so they fade into the environment map where they fail.

The established techniques:

- **Hi-Z tracing**: march a min/max depth pyramid, taking large steps through empty space and
  refining near surfaces (Uludag, *GPU Pro 5*, "Hi-Z Screen-Space Cone-Traced Reflections";
  McGuire and Mara, *JCGT* 2014, for the screen-space DDA it refines).
- **Stochastic glossy reflections** (Stachowiak, Frostbite, SIGGRAPH 2015): one ray per pixel,
  importance-sampled from the GGX lobe, then a resolve that reuses neighbours' hits weighted by
  their BRDF and PDF, then temporal accumulation. Roughness blurs reflections the way the BRDF
  says, not with a fixed blur.
- **Previous-frame colour**: rays sample last frame's lit image, reprojected, so reflections can
  be computed before this frame's lighting and fed into it (Unreal, Godot do the same).

Shard has most of the inputs. The deferred G-buffer has normals, roughness and metallic
(`gbuffer1`). The forward prepass, which TAA, motion blur and SSAO turn on, writes normals and
velocity and already runs each material's surface hook. TAA keeps an HDR history per view, and
`prevViewProj` and jitter are in the view uniform. There's no depth pyramid yet.

## Goals

- `ScreenSpaceReflections` on a camera: glossy reflections of everything on screen, on opaque
  surfaces, on forward and deferred cameras.
- Roughness-correct blur through stochastic GGX rays, a neighbour-reuse resolve and temporal
  accumulation; mirror surfaces sharp, rough ones falling back smoothly to the environment.
- Fed into lighting as the specular environment term, blended with the environment map by a
  per-pixel confidence, so there's no seam where rays miss or leave the screen.
- A shared Hi-Z pyramid other features can read (0022's and 0045's Hi-Z occlusion culling is
  deferred until one exists).
- A trace function water (0097) calls for its own reflections.
- Both tiers. Nothing needs compute; the compute tier uses it where it's faster.
- Three quality levels, and nothing at all when no camera turns it on.

## Non-goals

- Reflections of off-screen or hidden geometry: reflection probes and planar reflections are 0102,
  ray tracing isn't planned. Misses fall back to whatever 0102 or the environment map gives.
- Reflections on transparent surfaces (they don't write the prepass). Water gets them through
  0097's pass, below.
- Screen-space global illumination (diffuse bounces).
- Refraction (0097's opaque copy covers what water needs).

## Design

### Inputs

- **Depth**: the resolved single-sample `depth` (0064 requires it on baseline; the full tier has it
  after `depth-resolve`).
- **Normal, roughness, metallic**: `gbuffer1` on deferred cameras. On forward cameras, the prepass
  target `prepass-normal` grows from `rg16float` (octahedral normal) to `rgba16float` with roughness
  and metallic in z and w: the same layout as `gbuffer1`, so SSR and SSAO read one layout through
  `postAliases`. The prepass already evaluates `pbr_input`, so this costs a store, not a material
  evaluation. SSR turns the prepass on for its camera, as SSAO does.
- **Colour**: last frame's HDR image before post-processing (pre-exposed), from TAA's history when
  TAA is on, otherwise a copy of `hdr` taken at the end of the transparent phase into an `ssr-history`
  target with mips. Reprojected with `prevViewProj`; scaled by `exposure / previousExposure`
  because pixels are pre-exposed. Floating-origin shifts (0040) move it as they move TAA's history.

### Hi-Z pyramid

- `hiz`: an `r32float` mip chain of `depth`, each texel holding the **maximum** of the four below
  (depth is reverse-Z, so the maximum is the nearest surface). Built once per view per frame when
  anything reads it, at phase Prepass + 60, after the prepass or G-buffer depth exists.
- Compute tier: one dispatch that writes up to 6 mips through workgroup memory, then a second for
  the rest. Baseline: one fragment pass per mip (rendering into mips works there, 0064; bloom and
  the environment prefilter already do).
- It's a graph resource any node can declare a read of. `render.describe` reports its size.

### Trace

Per traced pixel (half resolution by default):

1. Reconstruct position and the shading normal; skip pixels above `maxRoughness`, the sky, and
   pixels flagged not to receive reflections.
2. Draw a half-vector from the GGX distribution for the pixel's roughness with a blue-noise
   sequence that changes each frame (Stachowiak's visible-normal sampling), and reflect the view
   ray about it. Store the sample's PDF.
3. March in screen space through `hiz`: step down a level when the ray passes below the stored
   depth, up when it's clear, up to `steps` iterations, from level 0 near the origin. A hit needs
   the ray within `thickness` behind the surface; thickness scales with view depth.
4. Output the hit's screen position and PDF, or a miss.

The trace is a WGSL module, `shard::ssr::trace(origin, direction, maxDistance) -> SsrHit`, that
any pass can import with the `hiz` binding.

### Resolve

At full resolution, per pixel:

- Gather the hits of the pixel and its 4 nearest traced neighbours (8 on high), weight each by
  this pixel's BRDF over that ray's PDF (Stachowiak's ratio estimator), and sample the history
  colour at each hit with a mip chosen by the cone the roughness and hit distance open.
- **Confidence**: per hit, fades at the screen edge (last 10%), for rays toward the camera, near
  `maxDistance`, and as roughness approaches `maxRoughness`. Misses have confidence 0.
- **Temporal**: blend with the previous resolve (reprojected by velocity), clamped to the
  neighbourhood's colour box (variance clipping), with a weight that drops when the velocity
  disagrees, so moving objects don't ghost.
- Output `ssr` (`rgba16float`): reflected radiance and confidence.

### Lighting

- `environment_light` reads `ssr` through the lighting bind group (as `ssao_at` reads SSAO): the
  prefiltered environment sample becomes `mix(prefiltered, ssr.rgb, ssr.a)`, before the split-sum
  scale and specular occlusion. So SSR is weighted by Fresnel and the BRDF exactly as the
  environment is, and where confidence is 0 the result is unchanged.
- Forward cameras: SSR runs after the prepass and before `forward-opaque`. Deferred cameras: after
  the G-buffer and before lighting. Either way, this frame's lighting uses it.

### Water (0097)

- The water pass imports `shard::ssr::trace` and traces against `hiz` and 0097's opaque copy
  (this frame's colour, so no reprojection), one ray per pixel at full resolution on the surface,
  and blends by the same confidence into its environment reflection. Docks and boats reflect in
  the lake, with no history of their own.

### Settings

```ts
ScreenSpaceReflections {                          // on a camera, like Ssao and Bloom
  quality: 'low' | 'medium' | 'high' = 'medium'
  maxRoughness: f32 = 0.6                         // above it, the environment alone
  maxDistance: f32 = 100 (m)
  thickness: f32 = 0.2                            // fraction of view depth a hit may lie behind
  intensity: f32 = 1
}
```

| Quality | Trace resolution | Steps | Neighbours | Temporal |
|---|---|---|---|---|
| low | half | 24 | 4 | yes |
| medium | half | 48 | 4 | yes |
| high | full | 64 | 8 | yes |

- Baseline defaults to `low`; the camera's setting still wins.
- `extractPost` reads it like `Ssao`; without `ssrPlugin`, a camera that sets it logs
  `render/feature-missing` (0056).
- `ssrPlugin` is a `render/forward` feature plugin that registers its WGSL and nodes and declares
  its baseline strategy (`fragment passes`) with `addRenderFeatures` (0064). It isn't in
  `renderer-min` (`pnpm size --check`).

### Agent surface

- `render.describe` per view: SSR on or off and why, quality, trace and resolve resolutions,
  `hiz` levels, and the fraction of traced pixels that hit.
- `render.capture { debug: 'ssr' | 'ssr-confidence' | 'ssr-hits' | 'hiz' }`.
- GPU spans `gpu:ssr` (trace, resolve and Hi-Z), with `gpu:span/ssr` grouped as SSAO's are.
- **Errors:** `render/feature-missing` (no `ssrPlugin`); `render/ssr-no-history` (warning for one
  frame after a camera cut, when reflections start from the environment).

## Decisions

- **Before lighting, from last frame's colour.** Shard's lighting adds the environment inside the
  material's lighting function; computing SSR first and feeding it in as the environment term
  avoids subtracting and re-adding specular in a later composite, and keeps forward and deferred
  identical.
- **Stochastic rays, not a blur by roughness.** Blur filters bleed across edges and don't match the
  BRDF's shape; one importance-sampled ray, neighbour reuse and temporal accumulation do, at the
  cost of needing history.
- **One normal layout.** Growing `prepass-normal` to `gbuffer1`'s layout lets SSR and SSAO ignore
  which path a camera takes.
- **A shared Hi-Z.** SSR is its first user; occlusion culling can be its second.

## Acceptance criteria

- [ ] A mirror floor (roughness 0) under a red cube reflects the cube within 2 px of a ray-traced
      reference render of the same scene (golden), on forward and deferred cameras, which agree
      within the default tolerance.
- [ ] Reflections on roughness 0.05, 0.3 and 0.5 floors widen in step with the GGX lobe (the
      reflected cube's edge spread measured against the reference), and at 0.6 and above the image
      equals the environment-only render.
- [ ] Panning the camera until the cube leaves the screen fades its reflection into the environment
      with no frame where the image changes by more than 3% over the floor (capture).
- [ ] A static camera's reflections vary by under 1% per pixel over 60 frames after converging; a
      cube moving at 5 m/s leaves no ghost longer than 2 frames (capture).
- [ ] With SSR off, every existing golden is unchanged, including the prepass format change.
- [ ] `medium` at 1080p takes under `gpu:ssr` (proposed: 1.2 ms on `laptop`, 0.5 ms on `desktop`);
      `low` runs on WebGL2 in the curated demos.
- [ ] A lake (0097) reflects a dock and a boat, fading to the sky where they leave the screen.

## Open questions

- Should reflections include transparents and particles? Proposed: no; they'd need to write depth
  and a normal they don't have.
- Contact hardening by hit distance (sharper near the contact) beyond what the cone mip gives?
  Proposed: measure against the reference first.
