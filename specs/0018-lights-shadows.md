# 0018 — Lights and shadows (Forward+)

- **Status:** accepted
- **Packages:** `@shard/render`
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

- [ ] An 800 lm point light 2 m above a white Lambertian plane produces the analytic luminance
      `L = (800/4π)/2² · ρ/π` at the point below it, within 2%, read back from an HDR capture.
- [ ] 256 point lights in a scene render at 60 fps at 1920×1080 in the browser on the dev machine,
      with GPU timings reported. The golden image matches in headless Dawn.
- [ ] GPU and CPU clustering produce the same light lists for a fixture scene.
- [ ] Directional, spot, and point shadows render as authored (golden images). Moving the camera by
      less than a texel doesn't change cascade shadow edges (pixel-identical).
- [ ] `NotShadowCaster` and `NotShadowReceiver` remove an entity from shadow maps or shadow lookups.
- [ ] Lights over the shadow budget are reported in `render.describe` and lit without shadows.
- [ ] Changing a light's intensity or color re-uploads only that light (asserted through upload
      counters).

## Open questions

- None blocking. Deferred: PCSS contact hardening, and light cookies from textures.
