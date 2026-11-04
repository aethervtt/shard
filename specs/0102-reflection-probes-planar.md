# 0102 — Reflection probes and planar reflections

- **Status:** draft
- **Packages:** `@aethervtt/shard-render`, `apps/cli`
- **Depends on:** 0018, 0019, 0021, 0064, 0097, 0101

## Context

0101's screen-space reflections only see what's on screen and in front. Everything else falls back
to the camera's environment map (0019): one prefiltered sky cube and its SH9 irradiance for the
whole world. Indoors that's wrong in an obvious way: a corridor's polished floor reflects the open
sky, and a room's ambient light is the sky's. A mirror on a wall shows nothing behind the player,
because the player's back isn't on screen. A calm lake loses its far shore as soon as the shore
leaves the top of the screen.

Engines fill this gap with two tools:

- **Reflection probes**: a cube map captured at a point and prefiltered like the environment.
  Surfaces inside the probe's volume use it instead of the sky. Box-projection parallax correction
  (Lagarde, "Local Image-based Lighting with Parallax-corrected Cubemaps", SIGGRAPH 2012) makes a
  box-shaped room's reflections line up with its walls. Probes blend where their volumes overlap.
  Unity, Unreal and Godot all have them; the same capture gives local diffuse ambient (SH
  irradiance), so a dark room is dark.
- **Planar reflections**: the scene rendered a second time, mirrored about a plane, into a texture
  that the plane's material samples. Exact for flat mirrors, calm water and polished floors, and the
  most expensive option: a whole extra view.

## Goals

- `ReflectionProbe`: a captured, prefiltered cube with SH9 irradiance and a box or sphere volume,
  used by every lit material inside it on forward and deferred cameras.
- Box-projected parallax correction, blending between overlapping probes, and a blend distance at
  volume edges.
- Baked probes (`shard probes bake`, cached like terrain pages) and realtime probes (re-captured
  over several frames).
- `PlanarReflection`: a mirrored view of the scene for a plane, sampled by materials on it (mirrors,
  floors, 0097's water).
- One order for every reflection: SSR → planar → local probes → the camera's environment, each
  filling what the one before it couldn't.
- Both tiers.

## Non-goals

- Ray-traced reflections and global illumination (no hardware ray tracing in WebGPU).
- Light probe grids for diffuse GI (irradiance volumes, DDGI). Probes give local ambient, not
  bounced light that varies inside a room.
- Probe placement by tools. Agents and authors place them; `shard probes suggest` is open.

## Design

### Reflection probes

```ts
ReflectionProbe {
  shape: 'box' | 'sphere' = 'box', size: vec3 = [10, 4, 10]     // influence volume, local
  blendDistance: f32 = 1 (m)                                     // fade inside the volume's edge
  boxProjection: bool = true                                     // parallax-correct to the box
  mode: 'baked' | 'realtime' = 'baked'
  priority: i32 = 0, intensity: f32 = 1
  captureOffset: vec3 = [0, 0, 0]                                 // where the cube is captured from
  resolution: 64 | 128 | 256 = 128
}
```

- **Capture**: six 90° views from the probe's position into a cube, rendered with the scene's
  opaque geometry, sky and lights, but without SSR, planar reflections, other probes' specular
  (their ambient yes), post or transparents. Then the same prefilter the environment uses
  (`environment.ts`, compute on the full tier, `fragmentKernel` on baseline) gives 6 roughness
  mips and SH9 irradiance.
- **Storage**: probes live in one `rgba16float` 2D array texture of octahedral maps (one layer per
  probe, mips per roughness), not a cube array: cube arrays exist neither in WebGPU compatibility
  mode nor in WebGL2, and one layout keeps both tiers the same. Up to 64 probes resident (256 on
  high); SH9 coefficients go in a `DataStore` (0064).
- **Selection**: probes are binned into 0018's light clusters alongside lights (CPU clusters on
  baseline, as for lights). A pixel takes up to 2 probes from its cluster, highest priority, then
  smallest volume, and blends them by their edge weights; whatever weight is left goes to the
  camera's environment.
- **Shading**: `environment_light` gets the probe lookup in place of the global cube: the
  reflection vector is box-projected (intersected with the probe's box from the shaded point and
  re-aimed from the capture point), the octahedral map sampled at the roughness mip. Irradiance
  comes from the blended SH9 instead of the environment's. 0101's SSR then blends over it by its
  confidence as it does over the environment today.
- **Baked**: `shard probes bake [scene]` renders every baked probe headless (Dawn in Node), writes
  `.shard/cache/probes/<scene hash>/<probe>.ktx2` keyed by the hash of the scene's static content
  within the probe's capture range and its settings, and skips probes whose key didn't change.
  `shard dev` rebakes stale probes in the background after a save; stale ones keep drawing.
  A baked probe needs the bake; without it, `render/probe-not-baked` and the environment is used.
- **Realtime**: re-captured round-robin, one cube face per probe per frame by default
  (`ReflectionProbes.facesPerFrame`), so a realtime probe refreshes every 6 frames. For a moving
  sun, a door opening, a vehicle interior.
- **Ambient**: SH9 from the nearest probes replaces the sky's irradiance indoors, so 0023's SSAO and
  probes together darken rooms the sky shouldn't reach.

### Planar reflections

```ts
PlanarReflection {                              // on an entity whose mesh is (near) flat
  resolution: f32 = 0.5                         // of the camera's
  normalDistortion: f32 = 0.05                  // how far surface normals bend the lookup
  clipOffset: f32 = 0.02 (m)
  maxDistance: f32 = 500 (m)
  layers?: ...                                  // what's drawn in the reflection (ViewVisibility)
}
```

- The plane is the entity's local XZ plane. For each camera that sees it (frustum and screen-size
  culled, at most `ReflectionPlanes.max` = 2 per frame, nearest and largest first), the engine
  renders a mirrored view: the camera reflected about the plane, an oblique near plane on the
  mirror (Lengyel's oblique frustum) so nothing under the plane leaks in, and back-face winding
  flipped.
- The mirrored view draws opaque geometry, the sky, transparents and particles, with shadows from
  the main view's cascades; no SSR, no planar reflections, no post except exposure. It writes an
  `rgba16float` target with mips.
- Materials on the plane sample it at the pixel's screen position, offset by the surface normal ×
  `normalDistortion`, with the mip from roughness. The standard material does this when its
  entity has a `PlanarReflection` (a pipeline variant), replacing the environment term where the
  sample is valid. 0097's water uses it as its reflection on calm bodies.
- Both tiers: it's another view through the existing graph. Its cost is the main cost of the
  feature, so `render.describe` reports it per plane.

### Order

Per pixel, the environment term is built back to front:

1. the camera's environment (0019), or the sky;
2. local probes, blended by their weights;
3. a planar reflection on its plane, where valid;
4. SSR (0101) by its confidence.

Each step only covers what it can see, so no surface ever reflects less than the step before.

### API sketch

```ts
app.addPlugin(reflectionProbesPlugin(), planarReflectionsPlugin())
world.spawn([ReflectionProbe, { size: [8, 3, 20], mode: 'baked' }], [Transform, { translation: [0, 1.5, 0] }])
world.spawn([Mesh3d, { mesh: floor }], [MeshMaterial, { material: polished }],
            [PlanarReflection, { resolution: 0.5 }], Transform)
```

### Agent surface

- `render.describe`: probes (baked or stale, resolution, which clusters use them), realtime faces
  this frame, planar views drawn and their cost.
- `render.capture { debug: 'probes' }` tints pixels by the probe they use; `'probe-volumes'` draws
  the volumes; `'planar'` shows a plane's reflection target.
- `shard probes bake [scene] [--force]`, `shard probes status`. MCP `bake_probes`.
- **Errors:** `render/probe-not-baked`, `render/too-many-probes` (warning, the lowest priority are
  dropped), `render/planar-not-flat` (a `PlanarReflection` mesh whose normals stray over 5° from
  its plane), `render/feature-missing` without the plugins.

## Decisions

- **Octahedral 2D arrays, not cube arrays.** The baseline tier has no cube arrays; one storage
  layout keeps probe code identical on both tiers.
- **Probes in the light clusters.** Clusters already answer "what affects this pixel"; probes are
  one more kind of item, with no new per-pixel search.
- **Baked by default, cached like terrain.** Probes almost never change, and a capture is six views
  plus a prefilter.
- **Planar is opt-in per plane, with a hard cap.** It doubles the scene's cost where it's used;
  probes and SSR cover most surfaces.

## Acceptance criteria

- [ ] A corridor with a box probe reflects its own walls in a polished floor, lined up with them by
      box projection (golden against a reference with the probe captured at the shaded point).
- [ ] Walking between two overlapping probes changes the reflection with no frame differing by
      more than 3% over the floor (capture).
- [ ] A closed room with a probe and no openings is lit by its SH9 ambient, not the sky's (pixel
      test: under 20% of the sky-lit ambient).
- [ ] `shard probes bake` bakes 20 probes once, then rebakes only the probe whose room changed
      (count asserted); stale probes keep drawing until replaced.
- [ ] A wall mirror shows the player behind the camera, with nothing from behind the mirror
      leaking in (golden), on both tiers.
- [ ] A calm lake (0097) with `PlanarReflection` reflects its far shore when SSR can't (golden).
- [ ] 16 resident probes cost under `gpu:probes` (proposed: 0.2 ms at 1080p on `laptop`); one planar
      view at half resolution under `gpu:planar` (proposed: 40% of the main view's opaque time).

## Open questions

- `shard probes suggest`: placing probes per room from the navmesh or scene bounds? Proposed: after
  the first demo shows what authors get wrong.
- Should realtime probes capture transparents? Proposed: no in v1.
