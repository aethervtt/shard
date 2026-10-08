# 0018 — Lights and shadows (Forward+)

- **Status:** implemented
- **Packages:** `@aethervtt/shard-render`
- **Depends on:** 0005, 0006, 0007, 0016

## Context

The forward renderer (0007) lights everything with one directional light and a flat ambient term.
Real scenes need point and spot lights by the hundred (cockpit panels, base interiors, a
settlement at night) and shadows from all three light types. Without shadows, objects float.

VISION commits to Forward+ and deferred rendering, both in physical units. This spec adds the
lights, the clustered light culling that makes many lights affordable in forward (and that
deferred reuses in 0021), and shadow maps.

## Goals

- `PointLight` and `SpotLight` components in physical units (lumens), with range and soft radius.
- Clustered light culling (Forward+): a compute pass bins lights into view-space clusters, so a
  fragment only evaluates the lights that reach it.
- Shadows for directional (cascaded), spot, and point (cube) lights, with PCF filtering and
  per-light bias.
- Casting and receiving shadows are opt-out per entity.
- Lights and shadows show up in `render.describe` and in debug views, so an agent can see why a
  scene is dark.

## Non-goals

- Area lights, IES profiles, light cookies (later).
- Contact-hardening soft shadows (PCSS), ray-traced or screen-space shadows (later).
- Global illumination beyond IBL (0019).
- Deferred shading (0021, which reuses the clusters and shadow maps from here).

## Design

### Lights

```ts
PointLight {
  color: color            // linear
  intensity: f32          // lumens; presets: candle 12, bulb 800, streetlight 15000
  range: f32              // meters; the light's contribution is windowed to zero here
  radius: f32             // meters; emitter size (softens specular, sets shadow penumbra later)
  shadows: bool
  shadowBias, shadowNormalBias: f32
}
SpotLight { ...PointLight, innerAngle: f32, outerAngle: f32 }   // degrees, measured from the axis
DirectionalLight { color, illuminance (lux), shadows, cascades: CascadeSettings }   // extended
```

- Luminous intensity is `lm / 4π` for both point and spot lights. Changing a spot's cone doesn't
  change its brightness, which is how artists expect it to behave (Bevy and Frostbite do the same).
- The falloff is physical inverse-square, multiplied by a smooth window
  `(1 - (d/range)⁴)²`, so lights end cleanly at `range` and clusters can cull them.
- The existing DirectionalLight gains `shadows` and `cascades`. Its illuminance stays in lux.

### Clustered culling (Forward+)

- Each view divides into 16×9×24 clusters: screen tiles, with depth slices that are exponential
  between near and a configurable `clusterFar` (defaults to the camera's far or 1 km).
- Each frame, a compute pass tests every visible light's bounding sphere, or cone for spots,
  against each cluster's AABB. It writes a compact light-index list (up to 128 lights per
  cluster) and per-cluster offset and count, all in storage buffers.
- Light data lives in a storage buffer (`array<Light>`, up to `maxLights`, default 1024), with only
  changed lights re-uploaded (change ticks).
- The lighting stage (`shard::pbr::lighting`) loops the fragment's cluster list after the
  directional lights. Materials don't change: they still only produce a `PbrInput`.
- Culling runs on the CPU too, with the same results, for headless tests and as a debug check.

### Shadows

- **Directional:** 4 cascades by default (`count`, `maxDistance`, `splitLambda` blending
  logarithmic and uniform splits). Each cascade is fitted to its frustum slice as a bounding
  sphere, so its size doesn't change as the camera rotates, and snapped to texels, so edges don't
  swim.
- **Spot:** one perspective shadow map per shadowed spot. **Point:** a cube map (six faces) per
  shadowed point light.
- **Storage:** three depth texture arrays (cascades, spots, point cube faces) sized by
  `shadowMapSize` (default 2048 for cascades, 1024 for others), with budgets `maxShadowedPoints` (4) and
  `maxShadowedSpots` (8). Lights over budget are ranked by screen-space influence, and the rest
  don't cast shadows that frame. `render.describe` reports which lights those are.
- **Filtering:** hardware comparison samplers with 3×3 PCF (Poisson-rotated when `softness > 0`).
  Depth bias and normal-offset bias are set per light.
- **Opt-out tags:** `render/NotShadowCaster` and `render/NotShadowReceiver`. By default every
  `Mesh3d` both casts and receives.
- **Graph:** shadow passes are render-graph nodes (`shadows/cascades`, `shadows/spot`,
  `shadows/point`) that run before `forward-opaque`, each with its own culling per light view
  (0022 later speeds this up).

### Presets and units

The schema presets follow the physical-units convention from 0007, as `LightPresets.*` values:

- Illuminance: `moonlight` 0.3, `overcast` 1 000, `daylight` 10 000, `direct-sun` 100 000.
- Point and spot intensity: `candle` 12, `bulb-40w` 450, `bulb` 800, `floodlight` 20 000.

### Agent surface

- `render.describe` lists visible lights per view, with type, intensity, range, whether each casts
  shadows this frame, and cluster statistics (max lights per cluster, overflows).
- `render.capture { debug: 'clusters' | 'cascades' | 'shadow-map:<light>' }` renders a debug view:
  a light-count heatmap, cascades tinted by index, or a raw shadow map.
- Errors and warnings: `render/cluster-overflow` (a cluster hit 128 lights; the hint suggests
  smaller ranges), `render/shadow-budget` (shadowed lights over budget).

## Decisions

- **Clustered, not tiled.** 3D clusters cull by depth too, which matters in deep scenes like
  interiors with long corridors. The same cluster data serves the forward and deferred paths.
- **The spot intensity doesn't depend on cone angle.** Narrowing a cone doesn't make the light
  brighter, which matches how people light scenes.
- **Windowed inverse-square.** Physically correct close to the light, with a clean cutoff that
  culling can rely on.
- **Stable cascades.** Sphere-fitted, texel-snapped cascades trade some resolution for edges that
  don't shimmer, and shimmer is the more visible failure.
- **Opt-out tags.** Most meshes should cast and receive. Tags keep the common case free of data.

## Acceptance criteria

- [x] An 800 lm point light 2 m above a white Lambertian plane produces the analytic luminance
      `L = (800/4π)/2² · ρ/π` at the point below it, within 2%, read back from an HDR capture.
- [x] 256 point lights in a scene render at 60 fps at 1920×1080 in the browser on the laptop,
      with GPU timings reported. The golden image matches in headless Dawn.
- [x] GPU and CPU clustering produce the same light lists for a fixture scene.
- [x] Directional, spot, and point shadows render as authored (golden images). Moving the camera by
      less than a texel doesn't change cascade shadow edges (pixel-identical).
- [x] `NotShadowCaster` and `NotShadowReceiver` remove an entity from shadow maps or shadow lookups.
- [x] Lights over the shadow budget are reported in `render.describe` and lit without shadows.
- [x] Changing a light's intensity or color re-uploads only that light (asserted through upload
      counters).

## Implementation notes

- **Components as built:** all three light types have `shadows`, `shadowBias` (meters: the receiver
  moves toward the light), `shadowNormalBias` (shadow-map texels along the surface normal), and
  `shadowSoftness` (texels of PCF radius beyond 3×3). `DirectionalLight.cascades` is
  `{ count: 4, maxDistance: 150, splitLambda: 0.8 }`. Up to four directional lights are lit; the
  first with `shadows` gets the cascades. Lights default to `shadows: false`, so existing scenes
  render as before. `render/NotShadowCaster` and `render/NotShadowReceiver` are tags.
- **Presets:** lux stays in `LightPresets` (with `moonlight: 0.3` added). Lumens are a different
  unit, so they're a separate `LuminousPowerPresets` (`candle`, `bulb-40w`, `bulb`, `floodlight`)
  with a `lumens()` helper, and they're the intensity schema's presets.
- **Light buffer:** `LightStore` holds 80-byte records in slots, `LightingSettings.maxLights`
  (1024) of them. A record is rewritten only when its transform or component changed, and only
  records whose f32 values differ are uploaded, in coalesced runs. `uploadedLights` and
  `uploadedBytes` are the counters the upload test reads, and `render.describe` reports them.
- **Clusters:** the CPU frustum-culls lights per view and writes a view-space list (position,
  range, spot axis, cos outer). The GPU pass reads that list. Cluster AABBs are computed on the
  CPU and uploaded only when the projection changes, so both paths test the same boxes and the
  GPU and CPU lists match exactly (256 lights, 0 mismatches). Each cluster has a fixed slot of
  128 indices rather than an atomically compacted list: no atomics, and a deterministic order.
  `clusterFar` lives in `LightingSettings` (0 = the camera's far plane, or 1 km). Point and spot
  lights don't reach fragments beyond it. The maximum and overflow counts come back through an
  async readback one frame late, for `render.describe` and the `render/cluster-overflow` warning.
- **Cascades:** each slice's bounding sphere comes from the projection alone, so its size doesn't
  change as the camera turns. The center is snapped to texels on all three light-space axes. Culling
  uses the four sides and the far side only; the depth range then reaches back to the nearest
  culled caster (quantized). With a static scene, moving the camera less than a texel leaves the
  cascade maps bit-identical (test).
- **Spot and point shadows:** spots use a perspective map slightly wider than the cone. Points
  render six faces into a 2D array layer each, a little wider than 90° so PCF taps near an edge
  stay on the face. The receiver picks the face by major axis and projects with the same matrices,
  so there are no cube-map conventions to get wrong. Spot and point maps are shared by all
  cameras, render once per frame, and grow their arrays when more layers are needed. Cascade
  arrays are per camera.
- **Budget ranking:** lights rank by the angular size of their influence sphere from the main
  (lowest-order) camera; lights outside its frustum rank below every visible one. Over-budget
  lights keep lighting, without shadows. They're listed in `render.describe` and logged once as
  `render/shadow-budget`.
- **Filtering:** a comparison sampler (`greater-equal`, reversed-Z) with 3×3 bilinear taps, or a
  16-tap Poisson disk rotated per pixel when `shadowSoftness > 0`. Masked materials run the
  surface stage in the shadow pass and discard, so their shadows have the same holes.
- **Graph nodes:** `light-clusters` (compute), `shadows/cascades`, and `shadows/local` (spots and
  points together, since they're shared per frame) run before `forward-opaque`. Shadow views are
  culled on the CPU here. 0022 moves that to the GPU.
- **Spherical emitters:** `radius` widens the specular lobe (Karis' roughness modification,
  energy-normalized).
- **Agent surface:** `render.describe` gains a `lighting` section with per-view visible lights
  (type, intensity, range, whether each casts shadows), cluster statistics, cascade splits, the
  shadow budget, and upload counters. `render.capture` takes
  `debug: 'clusters' | 'cascades' | 'shadow-map:<light>[:<layer>]'`; shadow maps come back as
  grayscale depth. In code the same things are `setDebugView`, `captureShadowMap`, and
  `describeLighting`.
- **glTF:** `KHR_lights_punctual` point and spot lights now import (candela × 4π → lumens, cone
  angles in degrees). A missing range ends where the light falls to 0.01 lux.
- **Measured:** the playground's `#lights` demo (256 moving point lights, 4 with point shadows,
  and a shadowed moon) runs at 60 fps at 1920×1080 in Chrome on the laptop (Apple M4), with
  per-pass GPU timestamps in the HUD. On Apple GPUs, passes overlap, so those timestamps don't sum
  to the frame time. The golden images render headless on Dawn.
- **Groundwork that landed with this spec:** the HDR target and tonemap pass (0019), and the
  persistent instance slots every view culls from (0022). The luminance test needs HDR readback,
  and shadow views need a shared instance buffer.

## Open questions

- None blocking. Deferred: PCSS contact hardening, and light cookies from textures.
