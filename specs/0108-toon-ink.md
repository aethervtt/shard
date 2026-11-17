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
- Far ground stays clean: lines inside silhouettes fade out with distance on perspective cameras,
  while silhouettes (a ridge against the sky, a house against a hill) keep theirs. Near ink and
  orthographic ink don't change.
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
  fade: vec2 = [60, 250]     // m along the view: lines inside silhouettes fade out between them
  silhouette: f32 = 0.1      // past the fade, a depth line stays when what's behind lies this
                             // fraction of the distance farther
}
```

Three fragment passes over the view's depth and normals (the prepass in forward views, which `Ink`
turns on; the G-buffer in deferred ones):

1. **Edges.** A pixel is on a line if it's geometry and either (a) a neighbour lies farther than
   the plane through this pixel and its opposite neighbour by more than `depthThreshold` plus
   the neighbour's own step (linear depth; a silhouette against the sky always counts), or (b)
   the right or lower neighbour's normal turns by more than `normalThreshold` and no depth jump
   separates them. Device depth is affine across a plane in screen space for both projections,
   so planes, at any slant, never draw lines and don't shimmer as the camera moves. The
   neighbour's step is how far its tangent plane (from the normal buffer, in view space) moves in
   depth over the one pixel back to this one: a surface seen at a grazing angle steps far back
   from pixel to pixel, so smooth and faceted curved surfaces draw no lines inside their
   silhouette at any angle. Depth lines sit on the nearer surface only.
   Each edge has a strength. Within `fade[0]` (and always on orthographic cameras, or with
   `fade[1]` 0) it is 1, so near ink is exactly as before. Past it, a depth edge whose gap is at
   least `silhouette × distance` stays 1 (the sky's always is); everything else takes the fade, 1
   to 0 between `fade[0]` and `fade[1]`, and a depth edge between half that gap and all of it
   takes the larger of the fade and a smoothstep over the gap, so lines don't pop.
2. **Rows.** Along the row, within the line's radius: the distance to the nearest full edge, and
   to the nearest fading edge with its strength.
3. **Composite.** The Euclidean distance from the rows (separable), turned into coverage of a line
   `width` wide (a fading edge's scaled by its strength, the larger of the two), mixes `color`
   over the input.

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
  hazes distant lines; colored ink is graded and tonemapped like the scene (black stays black), and never shows brighter than what it covers, so lines don't glow in the dark.
- **Planarity from device depth.** No grazing-angle lines, at any slant or projection.
- **Curved surfaces: less the far surface's step, from its normal.** The plane test alone inked a
  rolling sea in dashes. Each facet kink (or bend between pixels) leaves a residual of about
  footprint × kink angle / sin² of the grazing angle, which passes any fixed threshold. A tangent
  plane at the grazing angle steps footprint / sin of it per pixel, and a convex kink can't turn
  by more than the grazing angle without hiding what lies past it, so the residual never exceeds
  the step. An occluder against a grazing surface leaves a gap of its height in pixels times that
  step, so anything over about a pixel tall keeps its line. The step comes from the farther
  neighbour: at a crest's silhouette, the near pixel is edge-on and its own step is unbounded.
  Rejected: a threshold scaled by this pixel's step (it erases exactly those silhouettes); a
  plane through the far side's two pixels (depth only, but it misses bends within a pixel: half
  the dashes stayed); a per-material opt-out (a bit in the prepass and G-buffer, and it drops a
  crest's real line over the water behind it). The normal buffer holds shading normals: where a
  material's normals disagree with its geometry (detail normals the mesh doesn't carry), some
  lines can stay.
- **Far ink: a fade by distance and a silhouette gap relative to it.** A fold's fall-back grows
  with the pixel's footprint (proportional to distance) and with 1/sin² of the grazing angle, so
  a threshold scaled by footprint alone still inks hills near the horizon. Real occlusions fall
  back by a large fraction of their distance (a house 300 m out in front of a hill 30 m behind
  it); gentle folds by well under 1%. So interior lines fade by distance and depth lines past the
  fade must clear `silhouette × distance`. Fading the line's strength rather than raising the
  threshold keeps lines from popping as the camera moves. Orthographic footprints don't grow
  with distance, so the fade is perspective-only. A per-material opt-out (terrain) would need a
  bit in the prepass and G-buffer; the fade covers every far surface without one.
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
- [x] A smooth, faceted, gently rolling surface seen from 3 m up out to 40 m draws no ink inside
  its silhouette (it drew 109 pixels of dashes with the plane test alone), and a box standing on
  it keeps its outline.
- [x] Heightfield terrain seen at a grazing angle out to 2.7 km: the far half of the frame has
  under 40% of the ink it had without the fade, and under 30% of its ground inked; a 10 m box
  300 m away keeps its silhouette. Within the fade's near distance (perspective) and on an
  orthographic camera 400 m away, the image is byte-identical with and without the fade.
- [x] An outlined box on an outlined ground keeps its ring; nested Outlines follow priority, then
  nearness; a hover outline over an inked object draws on top, and removing it restores the image.

## Open questions

- None.
