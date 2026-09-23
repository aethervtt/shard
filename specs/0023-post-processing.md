# 0023 — Post-processing

- **Status:** accepted
- **Packages:** `@shard/render`
- **Depends on:** 0005, 0007, 0019, 0021

## Context

With HDR frames and a tonemap pass (0019), the frame can be finished properly: bloom on glowing
panels, auto exposure when flying from a dark cave into sunlight, fog over a planet's valleys,
depth of field and motion blur from the physical camera (0007), anti-aliasing for deferred views,
SSAO to ground objects, and color grading for the look.

Each effect is a component on the camera, so it's data an agent can toggle and tune with
`entity.patch`, and each is a render-graph node that culls itself when its component is absent.

## Goals

- Effects as camera components with schemas: `Bloom`, `AutoExposure`, `DepthOfField`,
  `MotionBlur`, `Antialiasing`, `Ssao`, `Fog`, `ColorGrading`, `Vignette`.
- A fixed, documented order in the render graph. Effects without a component cost nothing.
- Depth of field and motion blur driven by `PhysicalCamera` (aperture, focus distance, shutter),
  so photography settings mean what they say.
- Motion vectors (a velocity buffer) from per-object previous transforms, shared by TAA and motion
  blur.
- GPU time per effect in `render.describe`.

## Non-goals

- Screen-space reflections, lens flares, chromatic aberration, film grain (later).
- Volumetric fog and light shafts (later).
- User-defined post effects as materials (a render-graph node does that; the effects here are
  built from the same node API, so they show the pattern).

## Design

### Order

```
opaque (forward or G-buffer + lighting) ── ssao feeds lighting's occlusion
  → sky → transparent → fog → TAA → motion blur → depth of field → bloom
  → auto exposure (measures) → tonemap + color grading + vignette → FXAA → display
```

- SSAO needs normals and depth. Deferred views have them. Forward views get a depth-normal prepass
  when `Ssao` or `Antialiasing: taa` is present (the same prepass the motion vectors use).
- Auto exposure measures the HDR luminance after bloom and writes `Exposure.ev100` for the next
  frame, so it composes with the physical camera. When both are present, `PhysicalCamera` sets the
  base EV and `AutoExposure` adapts around it within its bounds.

### Components (fields abbreviated)

| Component | Fields | Notes |
|---|---|---|
| `Bloom` | intensity, threshold (cd/m²), knee, radius | Downsample and upsample mip chain (dual filter), energy-conserving |
| `AutoExposure` | minEv, maxEv, compensation, speedUp, speedDown, metering (average, center, spot) | Luminance histogram in compute, adapts in EV per second |
| `DepthOfField` | mode (gaussian, bokeh), focusDistance (m), maxBlur | Circle of confusion from `PhysicalCamera` aperture and focal length, half-resolution gather |
| `MotionBlur` | samples, maxBlur | Shutter angle from `PhysicalCamera.shutter` and frame time |
| `Antialiasing` | mode (none, fxaa, taa, msaa) | TAA: Halton jitter, history reprojection, neighborhood clamping. MSAA: forward only |
| `Ssao` | radius (m), intensity, quality | GTAO-style horizon search, half resolution, bilateral upsample |
| `Fog` | color, density, heightFalloff, start, sunScattering | Exponential height fog, in-scattering tinted by the sky and sun (0019) |
| `ColorGrading` | temperature, tint, saturation, contrast, lift/gamma/gain, lut | Parametric, or a 3D LUT texture asset (32³, from a PNG strip) |
| `Vignette` | intensity, smoothness | Applied in the tonemap pass |

- Presets live in the schemas: `AutoExposure` has `indoor` and `outdoor` bounds, and `Bloom` has
  `subtle` and `strong`.
- Motion vectors: the instance data (0022) keeps the previous frame's transform, and the prepass
  or G-buffer writes screen-space velocity. The camera's own motion is included.

### Agent surface

- Every effect is a component, so `get_schema`, `patch_entity`, and scene files all work on it.
  Capturing before and after a patch is how an agent tunes a look.
- `render.describe` per view lists active effects in order, with GPU milliseconds each and the
  current auto-exposure EV.
- `render.capture { buffer: 'velocity' | 'ssao' | 'bloom' }` shows an effect's intermediate
  buffer.

## Decisions

- **Effects are components.** They get schemas, validation, presets, hot patching, and scene-file
  storage without a separate settings system.
- **A fixed order, not a user-sorted stack.** The correct order is well known (fog before TAA,
  exposure measured after bloom, grading at the tonemap). Making it configurable only makes
  mistakes possible.
- **The physical camera drives depth of field and motion blur.** One set of photographic
  settings controls exposure, blur, and bokeh consistently.
- **TAA and motion blur share one velocity buffer.** One prepass serves both, and SSAO when forward.

## Acceptance criteria

- [ ] Each effect renders a golden image on a fixture scene, with no effects matching the 0019
      output exactly.
- [ ] Auto exposure moving from an interior (≈100 lux) to daylight converges to within 0.25 EV of
      its target inside the configured adaptation time (test through frame stepping).
- [ ] Depth of field blur size matches the thin-lens circle of confusion for the aperture and
      focus distance, within 10%, on a test pattern at known depths.
- [ ] TAA lowers an edge-aliasing metric on a high-contrast fixture versus none, and doesn't ghost
      on a moving object beyond the clamp's tolerance (golden sequence).
- [ ] With every effect enabled, a 1080p frame's post-processing costs under 3 ms of GPU time on the
      dev machine. Removing a component removes its node (graph culling check).

## Open questions

- None blocking. Deferred: SSR, lens flares, and a public post-effect hook for project nodes.
