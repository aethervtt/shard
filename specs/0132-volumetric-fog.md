# 0132 — Volumetric fog

- **Status:** draft
- **Packages:** `@aethervtt/shard-render`
- **Depends on:** 0018, 0019, 0023, 0044, 0064, 0069, 0130, 0131

## Context

0023's `Fog` is analytic: exponential height fog integrated along each view ray, lit by the sun
and the environment as if nothing cast a shadow. It's cheap and right for haze. It can't show
anything that needs light to vary inside the fog: sunbeams through a forest canopy or a window, a
flashlight cone in night mist, a street lamp's halo, ground mist that pools in a hollow, or a
foggy room that the sky doesn't light.

The real-time answer is a froxel volume. Wronski's "Volumetric Fog" (AC4, 2014) and Hillaire's
Frostbite talk (2015) lay out the steps that Unreal ships. Media are injected into a
camera-aligned 3D grid, each froxel is lit with shadows, the result is integrated front to back,
and the scene is fogged from the integral. 0044 already builds a froxel volume for aerial
perspective at kilometre scale. Volumetric fog is the same idea at tens of metres, with shadows
and local lights. UDS ties it to weather. Here, weather (0133) writes the same fields a game
could.

## Goals

- `VolumetricFog` on a camera: shadowed sun and moon light in fog, plus point and spot lights,
  including their shadow maps when they have one.
- The global medium is `Fog`'s own parameters, so the volume and the analytic fog beyond it are
  one medium with no seam.
- `FogVolume` entities for local fog: boxes and spheres with density, albedo, emission and
  animated noise, for ground mist, smoke-filled rooms and swamp hollows.
- Sky light inside fog follows 0069's sky visibility, so fog in a sealed room isn't lit by the sky.
- Cloud shadows (0131) darken fog under clouds.
- Temporally stable, with no flicker or crawling in a still scene.
- A baseline-tier fallback that keeps the global fog and the volumes' shapes.

## Non-goals

- Fog particles, smoke simulation, and fluid fog. `FogVolume` noise is procedural.
- Fog on transparent surfaces from their own depth. They take the fog of what's behind them, as
  they do with 0023's Fog and 0044's haze.
- Light shafts without fog. A clear day with `VolumetricFog` and `density: 0` shows none.
- Underwater fog, which is 0099's.

## Design

### Components

```ts
VolumetricFog {                        // on a camera, next to Fog
  distance: f32 = 96                   // metres the volume covers; analytic Fog continues beyond
  froxels: vec3 = [0, 0, 0]            // px per froxel in xy, and z slices; 0: from quality
  depthCurve: f32 = 2                  // slice distribution exponent (1 uniform, higher packs them near)
  anisotropy: f32 = 0.6                // Henyey-Greenstein g for every medium unless a FogVolume sets its own
  temporal: f32 = 0.9                  // history weight
  lights: bool = true                  // point and spot lights scatter
  quality: 'low' | 'medium' | 'high' = 'medium'   // 16 / 8 / 4 px froxels, 32 / 64 / 128 slices
}
FogVolume {                            // with a Transform
  shape: 'box' | 'sphere' = 'box'      // unit cube or sphere, scaled by the transform
  density: f32 = 0.05                  // extinction per metre at the center
  albedo: color = [0.9, 0.9, 0.9]
  emission: color = [0, 0, 0]          // cd/m² per unit density: glowing gas, a lit smoke haze
  edge: f32 = 0.25                     // fraction of the shape that fades to 0 at its boundary
  heightFalloff: f32 = 0               // 1/m, from the shape's bottom: mist that hugs the ground
  noise: f32 = 0.5, noiseScale: f32 = 0.2, noiseSpeed: vec3 = [0.3, 0, 0.1]
  blend: 'add' | 'max' = 'add'
  anisotropy: f32 = -1                 // -1: the camera's
}
PointLight / SpotLight gain volumetric: f32 = 1   // scattering scale; 0 leaves the light out of fog
```

`Fog`'s fields (density, height falloff, start, color as albedo, sun scattering as the phase g
when `VolumetricFog.anisotropy` isn't set) define the global medium inside and beyond the volume.
Weather (0133) changes `Fog.density` and `color`, and adds a global noise amount through
`fogNoise` (new, a `Fog` field, default 0).

### Passes

The plugin is `render/volumetric-fog`. It's added to `forwardPlugin()` like other features and
registers its WGSL, and nothing registers on import. All its passes are compute:

1. **Inject** (`volumetric-fog/media`). For each froxel center, jittered along depth by a
   per-frame blue-noise offset, it sums:
   - the global medium (height-exponential);
   - every `FogVolume` overlapping the froxel, culled per 8×8×8 tile from a list uploaded each
     frame (at most 64 volumes in view);
   - the shared 3D noise from 0131 (or 0041's, when the sky plugin is absent).

   Writes extinction and scattering albedo, and emission (`rgba16float` ×2).
2. **Light** (`volumetric-fog/light`). For each froxel:
   - sun and moon through 0018's cascades and `cloud_shadow` (0131), with the phase function;
   - ambient from the environment's irradiance SH, scaled by 0069's `sky_visibility` at the
     froxel (1 outdoors);
   - each clustered point and spot light in 0018's cluster grid, shadowed with its cube or spot
     shadow map when it has one. A torch in fog throws a cone, and the cone stops at a wall.
3. **Temporal** (`volumetric-fog/history`). Reprojects the previous lit volume by the camera's
   motion and blends it at `temporal`, rejecting history outside the frustum or after a big
   change in media. This smooths the jitter into a converged result.
4. **Integrate** (`volumetric-fog/integrate`). Marches each froxel column front to back,
   energy-conserving (Hillaire's integration), into in-scatter and transmittance per slice.

The fog is applied in the pass that already applies `Fog` (`post/fog`), or in `post/atmosphere`
when the camera has an atmosphere, so no fullscreen pass is added. A pixel inside `distance`
samples the integrated volume at its depth, with tricubic filtering in xy. A pixel beyond it takes
the volume's value at `distance`, then the analytic Fog from `distance` on, starting from the
volume's transmittance. The two meet at the same medium, so there's no step. Then 0044's aerial
perspective applies, as before.

Sky pixels are fogged up to `distance` and then analytically, so a thick fog hides the sky and a
light one doesn't.

### Weather and sky

- 0133 writes `Fog.density`, `Fog.color`, `fogNoise` and `heightFalloff` from its `fog` and `dust`
  channels. A dust storm is a low, dense, tinted medium. Morning mist is a high falloff and a low
  height.
- 0131's `cloud_shadow` dims sun scattering under clouds, so a break in an overcast sky throws a
  beam.
- The moon is a celestial light like the sun, so night fog glows faintly in moonlight, and lamps
  dominate.

### The baseline tier

Compute and 3D storage writes aren't available, so the feature registers an analytic baseline
strategy (code in `src/baseline/`, loaded with `import()`):

- The global medium falls back to 0023's analytic Fog.
- Each of the 8 nearest `FogVolume`s is added as an analytic ray-box or ray-sphere integral with
  uniform density and no noise or shadows, lit by the sun, ambient and `sky_visibility`.
- Local lights add a cheap in-scatter term per light (the closed-form point-light airlight
  integral) for the 4 nearest lights with `volumetric > 0`, without shadows.

It logs `render/feature-reduced volumetric-fog` once, naming what's missing.

### Cost control

- Froxel resolution follows the render resolution, so 0051's dynamic resolution scales it too.
- Lights are culled per froxel with the existing cluster grid. A light whose sphere is outside
  the volume costs nothing.
- `quality` and `engine/Settings.quality` (0038) pick the froxel size, slices and the number of
  shadowed lights sampled (`low` samples none).

### Agent surface

- `render.describe` gains `volumetricFog` per camera: the froxel grid, distance, volumes in view,
  lights scattering, and GPU time per pass.
- `fog.sample { position }` returns extinction, albedo and in-scattered radiance at a point (from
  the CPU media model for density, and the last read-back volume for light when available).
- The docs skill `.agents/skills/fog.md` covers analytic and volumetric fog, `FogVolume` recipes
  (ground mist, smoky room, dust storm), and cost.
- Errors: `render/fog-volume-too-many` (more than 64 in view; the nearest are kept), and
  `render/volumetric-fog-without-fog` (a `VolumetricFog` with no `Fog` and no `FogVolume`;
  nothing to light).

## Decisions

- **The global medium is `Fog`.** One set of parameters, read by both the volume and the analytic
  continuation, makes the boundary invisible by construction, and existing scenes switch on
  volumetric fog by adding one component.
- **A separate volume from 0044's aerial perspective.** The ranges differ by a factor of 300 (96 m
  against 32 km) and so do their needs: shadows and local lights near, none far. They share the
  application pass, so the cost is the volume and not another fullscreen read and write.
- **Local lights use the existing cluster grid and shadow maps.** No new light data, and a
  flashlight's beam stops where its shadow does.
- **Sky light scaled by 0069's sky visibility.** It's already computed for interior lighting, and
  it's what keeps fog in a sealed room from glowing blue.
- **Transparents take the fog behind them.** It's the rule 0023 and 0044 already follow. Per-pixel
  fog for transparents can come later as a material hook if a game shows the need.
- **An analytic baseline, not froxels in fragment passes.** Writing a 3D volume through 64 render
  passes would cost more than the frame. The analytic fallback keeps the shapes and the light, and
  drops the shadows.

## Acceptance criteria

- [ ] Golden in the `weather` demo: a dark room in the house at noon with fog shows a shaft of
      sunlight through the window, bounded by the window's shadow edge.
- [ ] Golden: at night in fog, a spot light (a flashlight) shows a visible cone that ends at a
      wall in its shadow map.
- [ ] At the volume's `distance`, mean luminance along a ground-level ray has no step: the change
      across the boundary is under 2%, measured over a uniform fog plane.
- [ ] A still camera over 60 frames: per-pixel luminance standard deviation in fogged regions under
      1% of the mean (temporal stability).
- [ ] Inside a sealed structure room, fog in-scatter from the sky is zero (sky visibility 0),
      while the same fog outdoors is lit.
- [ ] A `FogVolume` sphere with `heightFalloff` pools mist in a hollow (golden). Moving it updates
      the next frame. 64 volumes in view work, and 65 log `render/fog-volume-too-many` once.
- [ ] Under a 0131 cloud shadow, fog scattering of the sun drops by the same factor as surface
      lighting at that point (within 5%).
- [ ] Baseline tier: global fog and volumes match the full tier's shapes (golden with their own
      baseline images), and `render/feature-reduced` is logged once.
- [ ] At 1440p on the desktop machine, with the sun, the moon and 16 lights in view, the four
      passes stay within `gpu:volumetric-fog` (proposed: 0.8 ms, like Unreal's default 8 px grid).
      CPU upload of volumes stays under `render/fog-volumes` (proposed: 0.02 ms for 64) and
      allocates nothing in `pnpm bench`.
- [ ] Without `VolumetricFog`, no passes run, WGSL is byte-identical, and `renderer-min` is
      unchanged.

## Open questions

- None blocking. Deferred: per-pixel fog for transparent materials, fog that interacts with
  particles (smoke depositing into volumes), and volumetric shadows from clouds at altitude.
