# 0023 — Post-processing

- **Status:** implemented
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-protocol`
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

- [x] Each effect renders a golden image on a fixture scene, with no effects matching the 0019
      output exactly.
- [x] Auto exposure moving from an interior (≈100 lux) to daylight converges to within 0.25 EV of
      its target inside the configured adaptation time (test through frame stepping).
- [x] Depth of field blur size matches the thin-lens circle of confusion for the aperture and
      focus distance, within 10%, on a test pattern at known depths.
- [x] TAA lowers an edge-aliasing metric on a high-contrast fixture versus none, and doesn't ghost
      on a moving object beyond the clamp's tolerance (golden sequence).
- [x] With every effect enabled, a 1080p frame's post-processing costs under 3 ms of GPU time on the
      laptop. Removing a component removes its node (graph culling check).

## Implementation notes

- **The chain is aliases.**
  - Each HDR effect node (`post/fog`, `post/taa`, `post/motion-blur`, `post/dof`, `post/bloom`)
    reads `<name>-in` and writes `<name>-out`.
  - A view's aliases wire the active ones in order, alternating between two HDR textures
    (`post-a`, `post-b`), and point `post-hdr` at the last output. The tonemap and the exposure
    meter read `post-hdr`.
  - An effect without its component has no node in that view's graph, and costs nothing.
  - The alias sets are cached per combination of effects, MSAA, and path, so nothing allocates per
    frame.
- **Effects that need geometry data:**
  - A `prepass` node draws the opaque scene once more, single-sampled, writing depth, an
    octahedral normal (same encoding as `gbuffer1`), and velocity (`rg16float`, uv units).
  - It runs for TAA, motion blur, and forward SSAO. Deferred SSAO reads the G-buffer instead.
  - Deferred views with TAA or motion blur also run the prepass: the G-buffer has no velocity
    target.
  - The main pass doesn't reuse the prepass depth yet, so the prepass is a full extra draw of the
    opaque scene.
- **Velocity:** instances keep last frame's transform in a second buffer (48 bytes per slot).
  - It's written when a transform changes. A slot that moved last frame but not this one catches up,
    so a stopped object has no velocity, and the cost follows what moves.
  - The view uniform carries this frame's and last frame's unjittered view-projection.
  - Background pixels get the camera's rotation from those matrices.
- **SSAO** is GTAO at half resolution with a depth-weighted upsample.
  - Presets are 1×4, 2×4 (the default), and 3×6 slice directions × steps, fewer than first planned,
    because SSAO was the most expensive effect.
  - It feeds a new view binding (15) that lighting multiplies into ambient and IBL occlusion, for
    opaque surfaces only. Without `Ssao` the binding is a 1×1 white texture.
- **TAA:**
  - Halton (2, 3) jitter over 8 frames.
  - Velocity from the nearest depth in a 3×3 neighborhood, and 5-tap Catmull-Rom history.
  - YCoCg clip toward the neighborhood box, and Karis-weighted blending at 10% per frame.
  - History lives in two textures per view, reset when the size changes.
  - With TAA, a forward view drops to single-sample.
- **Anti-aliasing and MSAA** are per camera now. `Antialiasing.mode: 'msaa'` is 4×, and cameras
  without the component keep `forwardPlugin({ msaa })`. FXAA (3.11, quality preset 12) runs after
  the tonemap: `ldr` becomes a transient texture and FXAA writes the view target.
- **Auto exposure:**
  - A compute pass meters one pixel per 4×4 block into a 256-bin histogram of EV100 (1/8 EV per
    bin), weighted by metering mode.
  - The histogram comes back asynchronously, and the mean EV ignores the darkest 10% and brightest
    2% of the weight.
  - The CPU system `render/auto-exposure` then moves `Exposure.ev100` toward
    `metered − compensation`, within [minEv, maxEv], at `speedUp` or `speedDown` EV per second.
  - It starts from the camera's own exposure. With a `PhysicalCamera` that's the photographic EV,
    and adaptation takes over from there. That's simpler than the "adapt around the base" first
    planned, because two sources of truth for EV made the bounds ambiguous.
  - The meter lags the scene by its readback: a frame or two in a browser, up to ~20 under headless
    Dawn. The convergence test times adaptation from when the meter reports the change.
- **Depth of field:**
  - The signed thin-lens CoC is `k − k·s/d` pixels (`cocParams`, `cocRadiusPixels`), capped at
    `maxBlur` × height.
  - Three passes: color plus the 2×2-max CoC at half resolution, a 48-tap golden-angle gather over a
    disc the size of the pixel's own CoC, and a full-resolution composite. In the gather, a tap
    counts where its own blur reaches.
  - Bokeh weights brighter-than-white taps up to 9×.
  - Without a `PhysicalCamera` it uses f/2.8 at the focal length of a 24 mm sensor matching `fovY`.
- **Bloom** follows the design: a Karis-weighted 13-tap prefilter with a soft threshold, 13-tap
  downsamples and tent upsamples over 3 to all mip levels (by `radius`), and a composite that mixes
  (energy-conserving) with threshold 0 and adds with a threshold. Motion blur takes 8 taps along
  the velocity, scaled by the shutter's fraction of the frame and capped at `maxBlur`.
- **Fog:** optical depth has a closed form for exponential height fog. The in-scattered light is
  the fog color times the sky (the environment's SH toward up, or the ambient light) plus the first
  directional light through a Henyey-Greenstein phase (g 0.76), blended by `sunScattering`. The pass
  binds the forward view group, so it shares the lights and environment.
- **Grading and the vignette** ride in the tonemap pass:
  - White balance (Unity's LMS method), contrast around 0.18, saturation, and lift/gamma/gain run in
    scene-linear HDR, then the vignette, then the curve.
  - A LUT is sampled through the texture's linear view, so sRGB-tagged PNGs work as stored.
- **Agent surface:**
  - `render.describe` has a `post` section per view: active effects in order with GPU ms, the
    anti-aliasing mode, whether the prepass runs, and `ev100` with `meteredEv100`.
  - Span timings (`gpu:span/post`, `gpu:span/ssao`) run from a group's first pass start to its last
    pass end. Per-pass stamps overlap on tile-based GPUs and add up to more than the frame.
  - `render.capture { buffer }` documents `post-hdr`, `velocity`, `ssao`, `bloom`, and `dof-half`.
- **Measured on the laptop (Apple M4, Chrome, 1920×1080):**
  - Timestamps don't isolate post there: a lightly loaded GPU runs downclocked, and the last pass's
    stamp includes the swapchain wait. The measure used is the frame-time difference in a GPU-bound
    scene (`#crowd?nolod&still`, 26.5 ms without effects).
  - Bloom, auto exposure, depth of field, fog, grading, vignette, and FXAA together add 1.5 ms.
  - TAA, motion blur, and SSAO bring the prepass, whose cost is the scene's geometry: 0.3 ms in the
    `#post` demo, 14.7 ms for 200k full-detail instances.
  - In the `#post` demo at 5120×2880, where the frame is GPU-bound, all effects add 16 ms, about
    2.3 ms scaled to 1080p's pixel count.
- **Found along the way:**
  - The SSAO node was culled until the passes that shade listed `ssao` in their reads.
  - The GPU timer's 64-pass limit dropped the stamps of later passes, which made the frame look
    shorter than it was. It's 96 now.
  - GPU-culled views didn't count batches whose material wasn't ready as pending, so asset previews
    could capture before textures arrived: the protocol preview test flaked under load.
  - WGSL rejects chained comparisons.

## Open questions

- None blocking. Deferred: SSR, lens flares, a public post-effect hook for project nodes, and
  reusing the prepass depth in the main pass (depth-equal, no overdraw shading).
