# 0131 — Clouds

- **Status:** draft
- **Packages:** `@aethervtt/shard-sky`, `@aethervtt/shard-render`, `@aethervtt/shard-cli`
- **Depends on:** 0019, 0040, 0041, 0044, 0064, 0096, 0108, 0130

## Context

0130 gives a sky a clock, a sun, a moon and stars, but no clouds. UDS offers clouds as a choice
of renderer: full volumetric, a cheap static texture that mimics it, panning 2D layers, stylized
voxels, or volumetric aurora in their place. A game picks the one its platform and art style can
afford, and the weather looks the same in all of them.

The volumetric technique is settled: Schneider's Nubis (Horizon Zero Dawn, 2015–2017) with
Hillaire's lighting (Frostbite, 2016), raymarched at reduced resolution with temporal
reprojection. 0049 planned it on a planet's shell. This spec keeps that plan for the volumetric
mode, and puts every mode behind one description of where the clouds are.

## Goals

- **One cloud field.** Altitude, thickness, coverage, cloud type, wind advection and phase are
  read by every renderer, so switching modes changes the look and not the weather.
- **Five renderers as 0130 sky modes:**
  - `volumetric`, the full 3D raymarch;
  - `voxel`, the same field drawn as hard cubes;
  - `static`, baked from `volumetric` and relit at runtime;
  - `2d`, panning noise layers;
  - `aurora`, volumetric aurora curtains with no clouds.
- **Viewable from the ground, inside the layer and above it**, with no seams between them.
- **A spatial coverage input (the cloud map)**, so 0133 can put a storm cell on the horizon while
  it's clear overhead. Clouds don't depend on weather.
- **Cloud shadows** on everything lit by the sun or moon, from every mode, through one WGSL
  function. They're optional.
- **Clouds in the IBL**, so overcast days are flat and grey.
- **Toon banding**, so clouds match a Toon camera.
- **A cheap baseline-tier path for every mode.**

## Non-goals

- Weather (0133). Without it, the `Clouds` fields are the cloud state.
- Clouds seen from orbit, and planet-wide weather maps (0049's, a later extension).
- An in-editor cloud painter. Coverage maps are textures any tool or generator can write.
- Light shafts through cloud gaps (0132's volumetric fog draws them near the ground), and
  lightning illumination (0133 adds a flash input below).

## Design

### The cloud field

```ts
Clouds {                              // on the Sky entity
  bottom: f32 = 1500, thickness: f32 = 3500       // metres above the ground (sea level)
  coverage: f32 = 0.45                            // 0 clear … 1 overcast
  type: f32 = 0.5                                 // 0 stratus · 0.5 cumulus · 1 cumulonimbus
  density: f32 = 0.03                             // extinction per metre at full density
  shapeScale: f32 = 1 / 20000, detailScale: f32 = 1 / 1500   // 1/m
  windInfluence: f32 = 1                          // × wind/Wind velocity (0096)
  direction: vec3, speed: f32                     // used when windInfluence is 0
  evolution: f32 = 0.02                           // how fast formations change shape, 1/s of phase
  phase: f32 = 0                                  // added to the advection offset: scrub or loop
  seed: u32 = 0
  coverageMap: handle('Texture')                  // optional world-space coverage (r) and type (g)
  coverageMapBounds: vec4 = [0, 0, 0, 0]          // xz min and size, metres
  wisps: f32 = 0.3                                // high cirrus layer, every mode but voxel
  albedo: color = [1, 1, 1]
  shadows: bool = true, shadowStrength: f32 = 1, shadowRange: f32 = 8000
  bands: u32 = 0                                  // 0: smooth, or the camera's Toon.bands if it has Toon
  quality: 'low' | 'medium' | 'high' = 'medium'
  voxelSize: f32 = 120                            // voxel mode, metres
}
```

- **Geometry.** The layer is a spherical shell. With a primary Atmosphere (0044), it's centered on
  the atmosphere, offset by `bottom` and `thickness` from `bottomRadius`. Without one, it's an
  Earth-sized sphere (6 360 km) centered under the world origin, positioned through 0040's
  floating origin. On a flat world, clouds converge at the horizon as they do in life, and the
  same code works on a planet.
- **Advection.** The offset is a function of the sky's tick (0130's `skyTick`: the server's on a
  client), in f64. The velocity (`Wind` at cloud altitude, scaled by `windInfluence`) is sampled at
  every `CLOUD_WINDOW` (10 s) of ticks since tick 0 and rises linearly between samples, so the
  offset is the sum of the whole windows' mean rates plus the current window's integral, then
  `phase`. A player who joins late sums the same windows and sees the same clouds, which needs the
  wind's history: while 0133's weather drives the wind it supplies it (`CloudMotion.windAt`).
  Otherwise the clouds read `Wind` now, which matches across late joiners only if it hasn't
  changed.
- **Density.** `shard::clouds::density(p, lod)` is Nubis's: a 128³ shape noise (Perlin-Worley and
  three Worley octaves), a height gradient for the local `type` from a 64×64 profile LUT, a
  coverage remap, then erosion by a 32³ detail noise. The noise volumes are generated once by 0041
  graphs through a 0042 generator and cached like any generated asset. All lookups are relative to
  the shell's center in km, with 0041's offset, so they stay precise at any distance.

### The cloud map

Coverage and type vary across the world through the **cloud map**: a camera-centered 2D texture
(512², `rg8`, covering `4 × shadowRange` by default) that every mode reads instead of the scalar
fields.

- It's built by a compute pass. The pass starts from `coverage` and `type` and blends in, in
  order: `coverageMap` if set, then each registered **cloud map source**.
- `addCloudMapSource(world, { name, shapes })` takes a list of discs and boxes, each with a
  coverage, a type, an edge width and a blend (`over`, `max`, `multiply`). 0133's weather zones
  and storms register here. Sky never imports weather.
- The map scrolls with the camera in texel steps, rebuilding only the strip that came into view,
  and fully rebuilds when a source changes.
- A storm 20 km away is a high-coverage disc on the map. Volumetric and voxel modes see a real
  cell on the horizon. The 2D and static modes treat it as a coverage change in that direction.

### Renderers

All modes write premultiplied in-scatter and transmittance, plus a depth (the transmittance-weighted
cloud distance). They're composited after the opaque pass, depth-tested against the scene, and
before aerial perspective, which then hazes them at their own distance.

- **`volumetric`.** Rendered at quarter resolution (half per axis; `high` uses half resolution)
  with a blue-noise jittered start and temporal reprojection (neighborhood-clamped, using 0040's
  history shift):
  - Steps adapt, up to 64 (`low` 32, `high` 96), with a coarse step in empty space and an early
    out at 99% opacity.
  - Each sample takes six light-march steps toward the sun or moon and is lit with Beer-Powder, a
    dual-lobe Henyey-Greenstein phase, multiple-scattering octaves (Wrenninge), and ambient from
    0044's sky-view LUT above and the ground albedo below.
  - Inside the layer, the march starts at the camera, so flying through a cloud is flying through
    fog. From above, it starts at the top of the shell.
- **`voxel`.** The same density, quantized to a `voxelSize` grid and thresholded to occupancy.
  - The march is an Amanatides–Woo DDA through the grid. The first hit gives a face normal, and
    a short DDA toward the light gives the shadow.
  - Faces are opaque and flat-shaded, with ambient from above or below and edge darkening per
    face. Distant voxels fade with transmittance instead of aliasing.
  - It's drawn at full resolution with no temporal history, so the edges stay hard.
- **`static`.** `shard sky bake --clouds <out>` raymarches `volumetric` headless over the upper
  hemisphere into an octahedral map (2048², `rgba16float` ×2) at three coverages (0.25, 0.55 and
  0.85, as array layers).
  - Each texel stores transmittance, ambient response, and the sun response as L1 spherical
    harmonics over sun direction (four coefficients). At runtime, `sunColor × SH(sunDir) +
    ambient × skyAmbient` relights it at any time of day, and coverage blends the layers.
  - It turns slowly with the wind direction. Weather changes cross-fade layers, so a static sky
    still clouds over.
- **`2d`.** Two tiling noise layers on planes at `bottom` and `bottom + thickness/2`, with
  perspective from intersecting the view ray with each plane.
  - Coverage remaps the noise. Two samples toward the sun give self-shadowing and a silver lining.
  - Everything is fragment-only, so it's the baseline fallback of `volumetric`, `voxel` and
    `aurora`.
- **`aurora`.** It raymarches a band 100–300 km up for curtains of curl-advected ribbon noise:
  - green emission low in the band, violet high;
  - emissive only, additive, no lighting;
  - gated by night as 0130's 2D aurora is.

  Clouds are off in this mode, as in UDS. `Sky.aurora` scales it.
- **Wisps.** A cirrus texture on a high plane, panned by the wind. Every mode but voxel draws it,
  with its opacity scaled by `wisps`.
- **Toon.** With `bands > 0`, or when the camera has `Toon` and `bands` is 0, the lit fraction
  (direct over direct plus ambient) is quantized into bands with `Toon.softness`. It's the same
  rule Toon applies to surfaces, so the clouds and the ground agree.

### Cloud shadows

- `shard::sky::cloud_shadow(world: vec3f) -> f32` is the transmittance from a point toward the
  shadow-casting celestial light, through the clouds. The forward and deferred lighting stages
  multiply that light by it, as does volumetric fog (0132).
- It's backed by a **cloud shadow map**: 512² `r16float`, camera-centered and texel-snapped,
  covering `shadowRange`, holding optical depth along the light.
  - `volumetric` and `voxel` fill it by marching low-detail density, 16 samples per texel.
  - `2d` and `static` fill it by projecting their noise along the light.
  - It updates every frame at about 0.1 ms, or every fourth frame at `low` quality.
- Beyond `shadowRange`, the function returns the cloud map's average transmittance for the
  coverage there, so far terrain darkens under overcast without a seam.
- `shadows: false` removes the pass and makes the function return 1. The WGSL is a variant, so
  without clouds the lighting shaders are byte-identical.
- For gameplay, `cloudShadowAt(world, position)` evaluates coverage and type from the CPU side of
  the cloud map (its inputs, not the GPU texture) into an approximate transmittance. It's
  deterministic and headless, and 0044's `sunTransmittanceAt` multiplies it in. It's documented as
  an approximation of what's drawn.

### Lighting and IBL

- Under overcast, the sun's direct light at the camera falls by `cloud_shadow` like everything
  else. The sky's in-scatter isn't occluded by the clouds, but the clouds cover it.
- Every mode provides a `bake` entry: a low-step version of itself for one direction. 0044's
  environment bake calls it when coverage at the camera changes by more than 0.05, or the type by
  more than 0.1, besides 0019's sun threshold. So overcast reflections and ambient are grey, and
  clear ones are blue.
- `cloudFlash` (new uniform, at most 4 points) lets 0133's lightning light the clouds from inside
  for a few frames.

### Quality and the baseline tier

- `quality` sets resolution, step counts and shadow map updates. `engine/Settings.quality` (0038)
  maps low, medium and high onto it unless the Sky sets its own.
- On the baseline tier, `volumetric`, `voxel` and `aurora` fall back to `2d` (0130's
  `sky/mode-fallback`). `static` and `2d` run as is. The cloud map and the shadow map are fragment
  passes there. That code lives in `src/baseline/` and loads with `import()`.

### Agent surface

- `sky.describe` gains `clouds`: mode (and fallback), coverage and type at the camera, the
  advection offset, the cloud map's sources, the quality, and GPU time per pass.
- `sky.clouds { position | direction }` returns coverage, type and cloud shadow at a point, or the
  cloud distance and transmittance along a view direction.
- `sky.cloudMap {}` returns the cloud map as a PNG, so an agent can see where coverage comes from.
- `shard sky bake --clouds <out.clouds.ktx2> [--seed N]` makes a static cloud asset.
- The docs skill `.agents/skills/set-up-a-sky.md` gains a section on choosing a mode, with each
  mode's cost.
- Errors: `sky/bad-cloud-layer` (thickness ≤ 0, or bottom below the ground), `sky/bad-coverage-map`
  (a map with no bounds), and `sky/static-clouds-missing` (static mode with no baked asset: it draws
  `2d` and says how to bake one).

## Decisions

- **Advection is a function of the tick, not an integral per tick.** Integrating per local tick
  gave each client its own clouds, depending on when it joined. Sampling the wind every 10 s since
  tick 0 makes the offset the same for anyone who can evaluate the wind's history. Catching up costs
  one sample per window passed (360 an hour).

- **One field, many renderers.** Weather, wind and coverage maps feed all five, so a game can
  change mode per platform or graphics setting without retuning anything. It's how UDS keeps its
  modes interchangeable.
- **Voxel mode is the volumetric field, quantized.** One density function and one cloud map keep
  storms and coverage identical across styles. A separate voxel system would drift from it.
- **Static clouds are baked from volumetric and relit with L1 SH.** Four coefficients per texel
  are enough for the low-frequency response of a cloud to sun direction. Three coverage layers let
  weather change the sky without rebaking.
- **The cloud map is the interface weather writes into.** Sky doesn't import weather, a game
  without 0133 can still place storms, and the camera-centered map costs the same at any world
  size.
- **A spherical shell even on flat worlds.** The horizon is right without special cases, and
  planets need no second implementation.
- **One shadow function for every mode.** Lighting, fog and gameplay ask the same question the
  same way, and modes only differ in how they fill the map.
- **Toon bands from the camera's Toon.** A stylized game gets matching clouds without a second
  set of settings.

## Acceptance criteria

- [ ] Goldens in the `weather` demo for every mode at noon, dusk and overcast, from the ground, plus
      `volumetric` from inside the layer and from above it, on the full tier. `2d` and `static` also
      on the baseline tier.
- [ ] A camera climbing from 2 m through the layer to 10 km and back over 20 s shows no
      discontinuity in `volumetric`: frame-to-frame mean luminance change stays under 5%.
- [ ] A 90°/s pan in `volumetric` stays within 3% mean absolute difference of a full-resolution,
      history-free render of the same frames (history rejection test).
- [ ] Switching mode at runtime keeps coverage, type and the advection offset (`sky.describe`
      before and after), and the cloud map is unchanged.
- [ ] After 3 600 ticks under a changing `Wind`, the advection offset is identical on a server and
      two clients (`shard run --net clients=2`). Setting `phase` back restores the earlier frame
      (golden difference under 0.5%).
- [ ] A cloud map source disc (coverage 1, radius 3 km) 15 km away appears as a cell above the
      horizon in that direction in `volumetric` and `voxel`, while coverage at the camera stays at
      its base value.
- [ ] Under a coverage-1 cumulonimbus layer, `cloud_shadow` at the ground is below 0.2, and
      `cloudShadowAt` on the CPU agrees with it within 0.1. Shadows move across the terrain at the
      wind's speed (tracked shadow edge over 10 s).
- [ ] `shard sky bake --clouds` gives the same bytes on two runs. Its noon render matches
      `volumetric`'s at the same coverage within a mean CIE76 ΔE of 8.
- [ ] Overcast IBL: a white diffuse sphere's irradiance under coverage 1 is at least 40% lower and
      less saturated than under coverage 0.1, at the same sun.
- [ ] A Toon camera with 3 bands draws clouds with exactly 3 lit levels (histogram of cloud pixels
      at `softness` 0).
- [ ] At 1440p from the ground on the desktop machine, these are within their budgets (all
      proposed, like 0049's 2.5 ms):

      | Mode | Budget key | Proposed |
      |---|---|---|
      | `volumetric` | `gpu:clouds-volumetric` | 2.0 ms |
      | `voxel` | `gpu:clouds-voxel` | 1.5 ms |
      | `static` | `gpu:clouds-static` | 0.15 ms |
      | `2d` | `gpu:clouds-2d` | 0.2 ms |
      | cloud shadow map | `gpu:cloud-shadows` | 0.15 ms |

- [ ] Without a `Clouds` component there are no cloud passes, lighting WGSL is byte-identical
      (`scripts/wgsl-identity.mjs`), and `renderer-min` is unchanged.

## Open questions

- None blocking. Deferred: clouds from orbit and planet-wide maps (0049's plan), a cloud painter,
  light shafts through cloud gaps at altitude, and a second volumetric deck.
