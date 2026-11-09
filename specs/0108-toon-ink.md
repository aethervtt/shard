# 0108 — Toon shading and ink

- **Status:** draft (built)
- **Packages:** `@aethervtt/shard-render`
- **Depends on:** 0018, 0019, 0021, 0023, 0032, 0057, 0103

## Context

A game wants its walkable world to look like a comic: light in hard bands on the models' own
colors and textures, and inked lines on silhouettes and inside them, while a second camera in the
same app (a card duel, a HUD) renders as before. A material can't replace the lighting stage
(`apply_lighting` isn't a hook), so a prototype faked banded sunlight as emissive. It dropped point
and spot lights, kept some grazing specular, and leaned on internal shader modules. Inking every
mesh with `Outline` hit three faults of its own:

1. A skinned mesh's ring drew around its rest pose. The outline mask packed its style into the
   top four bits of each visible-list entry, which the deform stage reads as the LOD level (0103):
   with generated LODs and a second style in view, a skinned slot read another level's skin data.
2. A ring drew only outside every outlined silhouette, and jump flood seeded every outlined
   pixel: outlining the ground hid every other ring over it.
3. When an entity and a descendant both had an `Outline`, the one processed first won.

## Goals

- Toon shading per camera: bands (or a ramp of tones), edge softness and the shadow side's tone,
  for every light type, with received shadows, ambient light and SSAO kept, on every lit material
  (standard and extended), forward and deferred, skinned meshes included.
- Ink per camera: lines where depth or surface direction jumps (silhouettes, creases, occlusion
  edges), with width, color and thresholds; stable as the camera moves, orthographic included.
- A skinned or morphed mesh's outline follows its drawn pose.
- `Outline` rings draw outside their own silhouette, over other outlined objects; a stated rule
  for nested Outlines; selection and hover draw on top of ink.
- Nothing changes for a camera without `Toon` or `Ink`, and nothing runs for them.

## Non-goals

- Per-material toon settings, or an opt-out per entity. The camera decides; a later spec can add
  a material override.
- Toon on GPU foliage (0045) and terrain's own shaders: they keep physically based lighting.
- A lighting hook for arbitrary custom lighting models.
- Ink on blended (transparent) surfaces or ground bands: they aren't in the depth prepass.

## Design

### Toon

`Toon` on a `Camera3d` turns the view's lighting stage into banded diffuse:

```ts
Toon {
  bands: u32 = 2          // tones, the shadow side included: 2 lit/shadow, 3 adds a half-lit band (2–8)
  softness: f32 = 0.05    // width of each band's edge in light amount (0 hard, 1 a smooth ramp)
  shadowColor: color = black  // what a light still gives the side facing away, as a fraction
  ramp: color[]           // explicit tones, darkest first (2–8); replaces bands and shadowColor
}
```

For each light, the **light amount** `a` in 0–1 is how directly the surface faces it (n·l),
times its received shadow, a spot light's cone and interior lighting's wall visibility (0069). The
ramp maps `a` to a tone: tones `r0…rN-1`, edges evenly spaced at `(k-1)/(N-1)` for k in 1…N-1, so
the first sits on the terminator; each edge steps over `softness`. Without `ramp`, `rk` runs from
`shadowColor` to white. The light adds `base_color / π × tone × light color` times its distance
falloff, which stays smooth (as in Godot's toon diffuse). Toon has no specular, direct or from the
environment, and treats metals as their base color. Ambient light (uniform or the environment's
irradiance), SSAO, interior sky visibility and emissive are kept.

The camera's settings ride in the view uniform (`ViewUniform.toon`, `toonRamp`, `toonRampHigh`: N
and softness, then eight tones), so a view switches without a recompile. Lit pipelines take a
`TOON` define, linked from `shard::toon`, which `toonPlugin` registers; forward (opaque,
transparent, ground) and deferred lighting key it per view. Without `Toon`, the shaders link as
before.

### Ink

`Ink` on a `Camera3d` draws lines over the HDR image, first in the post chain (so fog, aerial
perspective and TAA treat them like the scene):

```ts
Ink {
  width: f32 = 1.5        // CSS px (texels on a PixelPerfect camera), 0.5–8
  color: color = [0.02, 0.02, 0.03, 1]  // linear; mixed in before tonemapping
  depthThreshold: f32 = 0.1  // m: how far a surface must jump back from the plane of its neighbours
  normalThreshold: f32 = 35  // degrees between neighbouring surface directions
}
```

Three fragment passes over the view's depth and normals (the prepass in forward views, which `Ink`
turns on; the G-buffer in deferred ones):

1. **Edges.** A pixel is on a line if it's geometry and either (a) a neighbour lies farther than
   the plane through this pixel and its opposite neighbour by more than `depthThreshold` (linear
   depth; a silhouette against the sky always counts), or (b) the right or lower neighbour's
   normal turns by more than `normalThreshold` and no depth jump separates them. Device depth is
   affine across a plane in screen space for both projections, so planes, at any slant, never
   draw lines and don't shimmer as the camera moves. Depth lines sit on the nearer surface only.
2. **Rows.** Distance to the nearest edge pixel along the row, within the line's radius.
3. **Composite.** The Euclidean distance from the rows (separable), turned into coverage of a line
   `width` wide, mixes `color` over the input.

### Outlines

- The mask's visible entries hold the slot alone (level 0, the mesh the mask draws). Style, owner
  and precedence come from a per-view `@data` array indexed by slot, so skinned and morphed meshes
  deform with their own data on any LOD.
- The mask stores, per pixel, the nearest outlined surface's style, depth, owner (the Outline's
  entity) and precedence. A pixel seeds jump flood if a neighbour is outside every outlined
  silhouette, or belongs to another owner that is lower in precedence, or equal and farther away.
  The composite skips pixels of the seed's own owner and of owners above it in precedence. A ring
  so draws outside its own silhouette, over other outlined surfaces behind or below it.
- `Outline.priority` (i32, default 0) orders nested Outlines: a renderable takes the highest
  priority among the Outlines on it and its ancestors; on a tie, the nearest one. Rings of higher
  priority also draw over the silhouettes of lower ones (hover over a mesh outlined for ink).
- Rings composite after the tonemap, so they draw over `Ink` lines and go away with the Outline.

### API sketch

```ts
import { Ink, Toon } from '@aethervtt/shard-render'
world.add(worldCamera, Toon, { bands: 3, shadowColor: [0.25, 0.22, 0.35, 1] })
world.add(worldCamera, Ink, { width: 2, depthThreshold: 0.15 })
world.add(duelist, Outline, { color: [1, 0.8, 0.2, 1], width: 3, priority: 1 })
```

### Agent surface

`Toon` and `Ink` are schema components (scene files, inspector, JSON Schema, generated docs).
`render.describe` gains `toon` (per view: tones, softness) and lists `ink` among a view's post
effects with its GPU time. Without `toonPlugin`, `Toon` and `Ink` log `render/feature-missing`.

## Decisions

- **Per camera, not per material.** "The world camera is a comic" is one switch for every model,
  including imports nobody edits, and leaves the duel's camera alone.
- **Settings in the view uniform, the code behind a define.** No recompile when a setting moves,
  and no cost to views without Toon.
- **Band the facing term, not the distance falloff.** Physical point lights have no top to band
  against; the facing term is 0–1 for every light type.
- **Ink before the HDR chain.** TAA resolves jittered lines into stable antialiased ones, and fog
  hazes distant lines; colored ink is graded and tonemapped like the scene (black stays black).
- **Planarity from device depth.** No grazing-angle lines, at any slant or projection.
- **Precedence by priority, then nearness.** Deterministic; hover on a root outlines the whole
  model while a child keeps its own Outline otherwise.

## Acceptance criteria

- [x] With `Toon`, a lit sphere shows `bands` distinct tones under a sun and under a point light;
  softness 0 against 1 changes the edges; `ramp` sets the tones; the shadow side takes
  `shadowColor` of the light; a box in a received shadow takes the shadow tone.
- [x] A second camera without `Toon` or `Ink` renders bit-identical before and after another
  camera in the same app gets them.
- [x] Toon works on a skinned mesh, and in deferred views.
- [x] With `Ink` under an orthographic camera, box silhouettes, the wall-ground crease and a box's
  edge facing the camera draw lines; the ground plane draws none at any angle; moving the camera
  moves the lines with the boxes and adds none.
- [x] A skinned mesh's ink and outline follow its pose, LOD levels and several styles included.
- [x] An outlined box on an outlined ground keeps its ring; nested Outlines follow priority, then
  nearness; a hover outline over an inked object draws on top, and removing it restores the image.

## Open questions

- None.
