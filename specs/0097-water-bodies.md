# 0097 — Water bodies and surface

- **Status:** draft
- **Packages:** `@aethervtt/shard-water` (new), `@aethervtt/shard-render`, `@aethervtt/shard-mesh`,
  `@aethervtt/shard-terrain`
- **Depends on:** 0019, 0020, 0022, 0044, 0056, 0064, 0071, 0096

## Context

Shard has one kind of water: 0043's planet ocean. It's a sphere at sea level with four sine
normals and alpha from depth: no displacement, refraction, foam or shoreline. A level needs lakes,
rivers, an ocean, pools and aquariums, and water that reads as a body of water, not a plane.

Unreal's Water plugin is the reference most people know. Bodies are splines (ocean, lake, river
with width, depth and velocity per point). A water zone owns one shared, LOD-morphing surface mesh
and a top-down "water info" texture (surface height, ground height, velocity), so bodies blend
with no seams. Its Single Layer Water shading uses absorption (1/m per channel), scattering and a
phase function, and refracts a copy of the scene. Its known weaknesses are what this spec avoids:
water is a surface with no sides (a cutaway needs a hand-made plane, and a lake running past a
cliff ends in a hard flat edge), exclusion is static (no way to clear the water inside a moving
hull), and underwater is detected by collision.

This spec is the base of the water family. It adds bodies, a surface that is a closed volume you
can see the sides of, shading, masks and CPU queries, on both tiers. Waves (0098), underwater and
optics (0099), and interaction (0100) are opt-in plugins on top of it.

## Goals

- Bodies: `Ocean`, `Lake` (closed spline), `River` (open spline with width, depth and flow per
  point), and `WaterVolume` (a box, cylinder, sphere or convex mesh filled to a level: pools,
  tanks, aquariums, a floating blob).
- Water as a **volume**: every body has a surface and sides. Where a side is buried in terrain you
  never see it; where it's exposed (a cliff, a tank wall, a floating blob) it renders as water seen
  through its side, with the waterline following the surface. Thin water fades out at the shore, so
  there's no flat-plane edge anywhere.
- Shading: absorption and scattering per body, refraction of the scene behind, reflections of the
  sky and environment, shore foam, river flow, and wind ripples. The sky, atmosphere and (when 0049
  lands) clouds show up in it.
- **Water masks**: moving or static shapes that remove water inside them (a boat's hull, a cave, a
  diving bell).
- `waterAt(world, position, out)`: surface height, depth, flow, body and whether the point is under
  water. Headless and deterministic.
- WebGPU and WebGL2. Nothing here needs compute.
- Opt-in: `waterPlugin()` costs nothing until a body exists.

## Non-goals

- Waves beyond wind ripples (0098), underwater rendering, caustics and light shafts (0099),
  buoyancy, wakes and spray (0100).
- Planet-scale spherical oceans. 0043's ocean stays; bringing these bodies to planets is open.
- Simulated rivers (shallow-water equations, flooding). Rivers follow their spline; a simulation
  can feed the same info texture later.
- Screen-space and planar reflections of objects. v1 reflects the sky and the environment map.
- Carving terrain. 0071 heightfield splines (`carve`) already make riverbeds; water reads terrain
  and never edits it.

## Design

### Bodies

```ts
WaterBody { kind: 'ocean' | 'lake' | 'river' | 'volume', optics: handle('WaterOptics'),
            priority: i32 = 0, wind: 'global' | { speed: f32, direction: vec3 } = 'global' }
WaterSpline { points: list({ position: vec3, width: f32, depth: f32, flow: f32 }), closed: bool }
WaterVolume { shape: 'box' | 'cylinder' | 'sphere' | 'convex', size: vec3,
              mesh?: handle('Mesh'), fill: f32 = 1 }        // fill: 0..1 of the shape's height
```

- **Ocean**: a level (the entity's y) everywhere, optionally bounded by a closed `WaterSpline`
  (the shore polygon, so it doesn't flood inland basins).
- **Lake**: a closed `WaterSpline` at the entity's y. `width` and `depth` are unused.
- **River**: an open `WaterSpline`. Each point sets the surface height (its y), `width`, `depth`
  (a bed, when there's no terrain under it) and `flow` (m/s downstream; negative flows upstream).
  Sampled as uniform Catmull-Rom, the sampler terrain's `SourceSpline` uses, moved to
  `@aethervtt/shard-mesh` so both share it. Where a river's end lies inside a lake or the ocean,
  its height and flow blend into that body over `max(width, 10 m)`.
- **WaterVolume**: water inside a shape, up to `fill`. A `convex` volume takes a mesh that must be
  convex (checked when it loads, `water/not-convex`). Volumes don't join the zone (below); they
  render on their own.
- `WaterOptics` (a data asset, `*.water.json`): absorption per channel (1/m), scattering per
  channel (1/m), phase `g`, surface roughness, foam colour and amount, and ripple strength.
  Presets ship: `clear` (Pope & Fry pure water: 0.34 / 0.057 / 0.009 m⁻¹ in RGB), `ocean`,
  `coastal`, `lake`, `river`, `murky`, `pool`.

### Zone and info texture

Like Unreal, the bodies that share a surface (ocean, lakes, rivers) render through one mesh and
one top-down texture, so where they meet there's no seam.

- **Info texture**: a camera-centred clipmap of 4 levels at 256² (4 m, 16 m, 64 m and 256 m
  texels), `rgba16float` each: water surface height, ground height under the water, flow xy. A
  second `rg8` layer holds the body index and the shore distance.
- It rebuilds incrementally when the camera moves by a texel or a body changes:
  1. Ground: a top-down depth pass of terrain and static opaque meshes marked `WaterFloor` (0071's
     heightfield draws itself; other geometry opts in).
  2. Bodies: each rasterizes its surface height and flow, in `priority` order.
  3. Shore distance: a jump-flood from the shore (where surface height meets ground) in a
     `fragmentKernel` (0064), so it's the same code on both tiers.
- **CPU mirror**: `waterAt` doesn't read the GPU texture back. It evaluates the same bodies on the
  CPU (spline distance, the ground from 0071's `terrainHeightAt` or a `WaterFloor` mesh raycast),
  so it's deterministic and works headless.

### Surface mesh

- Camera-centred rings of tiles (as 0043's quadtree and Crest's LOD rings): each ring is twice the
  scale of the one inside, vertices morph between levels by distance, and the outermost ring of an
  ocean runs to the horizon. A vertex reads its height from the info texture; outside any body it
  collapses below the ground, and the fragment stage discards.
- The surface draws in a dedicated **water pass** after opaque geometry and before transparents
  (below). Its instance data goes through 0022's instance buffer, so GPU culling applies.

### Water as a volume

Every body is a closed volume: the surface on top, and sides going down to the bed.

- **Sides**: for a lake or the ocean, a wall following its outline from the surface down to below
  the ground there; for a river, walls along both banks; for a `WaterVolume`, the shape itself. Side
  fragments above the displaced surface at their x,z are discarded, so the cut follows the waves
  (0098), and a 2–3 px meniscus line is drawn where the surface meets a side.
- **Thickness**: the volume's back faces are drawn first into a half-resolution depth target. A
  surface or side fragment's water thickness along the view ray is `min(back face, opaque depth) −
  its own depth`. Absorption (Beer–Lambert per channel) and in-scattering use that thickness, so a
  pool's corner, a waterfall's edge, or a sphere of water darken by how much water you look through.
- **No hard edges**: where a side is buried in terrain, the depth test hides it. Where the surface
  thins to nothing at a shore, the thickness goes to zero and the water fades into the refraction
  of the ground; foam (below) draws the line. A lake whose spline runs past a cliff ends in a wall
  of water with a curved waterline instead of a flat sheet stopping in mid-air.
- **Volumes**: a `WaterVolume`'s lid is the shape cut at the fill height. Convex shapes cut into a
  convex polygon on the CPU when `fill` or the shape changes. A sphere of water at `fill: 1` has no
  lid at all: it's a closed blob.

### Shading

The water pass shades every surface and side fragment completely, and writes depth.

- **Prerequisite (render)**: an **opaque copy**, a new `render/forward` feature plugin
  (`opaqueCopyPlugin`, 0056 rules): after opaque geometry, a copy of the HDR colour (half
  resolution, with mips for rough refraction) and the resolved depth, exposed to materials and
  nodes that declare `reads: ['opaque-color', 'opaque-depth']`. It runs only in frames where
  something reads it. Glass and heat haze can use it later.
- **Refraction**: the opaque copy, sampled at the pixel offset by the surface normal × thickness
  (clamped), and rejected when the offset sample is in front of the water (no leaking of objects
  above the surface into it).
- **Colour**: `refracted × T + inscatter × (1 − T)`, where `T = exp(−absorption × thickness)` and
  inscatter is the sun and sky light scattered toward the camera with the body's phase `g`.
- **Reflection**: the camera's environment (0019's `EnvironmentMap` or `ProceduralSky`, and 0044's
  atmosphere bake when there is one), with Fresnel (Schlick, n = 1.333), and the sun's specular
  from each `DirectionalLight`, shadowed by its cascade.
- **Ripples**: two scrolling normal maps (procedural, baked at startup) whose strength and speed
  follow `windAt` (0096). Rivers advect them along flow with two-phase flow-map blending (Vlachos,
  Portal 2), so they don't stretch.
- **Shore foam**: from the info texture's shore distance and the wave height (0098), with a noise
  texture so it breaks up.
- **Why a pass, not a transparent material**: the water writes depth and composites what's behind
  it itself (as Unreal's Single Layer Water does), so 0044's aerial perspective and 0023's fog,
  which work from depth, haze the water by its own distance, not the seabed's. Transparents draw
  after it and over it, sorted as today.
- **Baseline (WebGL2)**: the same pass. The opaque copy is a blit; the back-face thickness target
  is an `R16F` render target. Nothing in this spec needs compute.

### Masks

```ts
WaterMask { shape: 'box' | 'sphere' | 'capsule' | 'mesh', size: vec3, mesh?: handle('Mesh') }
```

- Water inside a mask isn't drawn: its surface, sides, and (0099) underwater fog.
- Primitive masks (up to 16 near the camera) are tested analytically in the water pass's fragment
  stage. Mesh masks (a hull's interior, closed and watertight) draw their front and back faces into
  a half-resolution `rg16float` target, and water fragments whose depth falls between the two are
  discarded. Masks follow their entity's transform each frame, so a moving boat stays dry inside.
- Static masks (a cave under the sea) can also be marked `bake: true`; they're written into the
  info texture's body index as "no water" and cost nothing per frame.
- `waterAt` respects masks, so a point inside a hull isn't under water.

### Queries

```ts
waterAt(world, position: Vec3, out: WaterSample): WaterSample
// { body, surfaceHeight, depth (surface − point), groundHeight, flow: Vec3, normal: Vec3,
//   underwater: boolean, optics }
```

- No allocation; CPU-only; deterministic. With 0098 loaded, `surfaceHeight` and `normal` include
  the waves from its CPU evaluator.

### API sketch

```ts
import { waterPlugin, WaterBody, WaterSpline, WaterVolume, WaterMask, waterAt } from '@aethervtt/shard-water'

app.addPlugin(waterPlugin())
world.spawn([WaterBody, { kind: 'lake', optics: { path: 'assets/water/lake.water.json' } }],
            [WaterSpline, { closed: true, points }], [Transform, { translation: [0, 12, 0] }])
world.spawn([WaterBody, { kind: 'volume', optics: { path: 'assets/water/pool.water.json' } }],
            [WaterVolume, { shape: 'box', size: [4, 2, 8], fill: 0.85 }], Transform)
```

### Agent surface

- `water.describe` (MCP `describe_water`): bodies, their extents and optics, the zone's clipmap
  levels, masks, pass time, and info texture rebuilds per frame.
- `water.sample { position }` runs `waterAt`.
- `render.capture { debug: 'water-info' | 'water-thickness' | 'water-masks' }`.
- A generated skill, `make-water.md`: a lake from a spline, a river into it, a tank, a hull mask.
- **Errors:** `water/bad-spline` (fewer than 3 points for a closed spline, 2 for a river, a
  self-intersecting lake), `water/open-mask-mesh` (a mesh mask that isn't closed),
  `water/not-convex` (a `convex` volume's mesh isn't), `water/no-optics`
  (warning: the default `clear` is used), `water/too-many-masks` (warning).

## Decisions

- **One pass that shades completely and writes depth.** Fog, aerial perspective and anything that
  reads depth then treat water correctly, and transparents still sort over it.
- **A zone texture, as Unreal does.** Bodies blend with no seams, foam and attenuation get depth
  and shore distance per pixel, and it costs one clipmap update, not per-body work each frame.
- **Sides are part of every body.** Water you can see the edge of is the default, not a special
  case; buried sides cost a depth test.
- **CPU queries never read back.** Gameplay and headless runs need the answer this tick, the same
  on every machine.
- **Masks move.** A moving hull is the common case (boats, submarines, diving bells).

## Acceptance criteria

- [ ] A lake, a river flowing into it and the ocean share one surface with no visible seam where
      they meet (golden image), and the river's flow shows in its ripples.
- [ ] A lake whose spline runs past a cliff ends in a wall of water whose top follows the surface
      (golden), and the same lake's shore fades into the ground with no visible edge.
- [ ] A `WaterVolume` box at `fill: 0.85` behind glass, and a sphere at `fill: 1` in mid-air, look
      darker where they're thicker (golden, plus a thickness readback).
- [ ] A boat with a mesh mask moving through the lake has no water inside its hull in any frame
      of a 10 s capture, and `waterAt` inside the hull says it isn't under water.
- [ ] Objects above the water never appear in its refraction (golden at a grazing angle).
- [ ] `waterAt` matches the info texture's surface height within 1 cm at 1 000 points, headless
      and on the GPU.
- [ ] The water pass takes under `gpu:water` (proposed: 1.5 ms on `laptop` at 1080p for the lake
      scene) on WebGPU, and runs on WebGL2 (`demos.test.ts` curated set).
- [ ] A scene with `waterPlugin()` and no bodies adds no passes (`render.describe`).

## Open questions

- Planar or screen-space reflections of nearby objects (docks, boats)? Proposed: SSR on the water
  pass only, in its own spec (Shard has no SSR yet; 0021 lists it as later).
- Water on 0043 planets? Proposed: after 0098, as a curved zone around the camera.
- A river shallow-water simulation (waterfalls, floods)? Proposed: later, writing into the same
  info texture.
