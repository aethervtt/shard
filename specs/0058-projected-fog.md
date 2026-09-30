# 0058 — Projected fog

- **Status:** implemented
- **Packages:** `@aethervtt/shard-fog` (new), `@aethervtt/shard-vector`, `@aethervtt/shard-render`
- **Depends on:** 0023, 0057

## Context

Aether has two kinds of darkness. *Vision* is what a player's tokens can see right now: the server
computes it and sends visible polygons plus a remembered (explored) multipolygon. *Manual fog* is
what the GM painted: ordered hide and reveal strokes (rectangles, polygons, brushes) over a base of
hidden or revealed. They compose as a union of darkness. While vision is active, the manual base is
forced to revealed, so only painted regions hide. A GM sees fog at 0.45 opacity and a player at 1.

Today Aether rasterizes this into a canvas texture on a scene-sized plane, feathered with a CSS
blur, and repaints the whole canvas on any change. On a Tabletop view, a flat plane covers the
floor, but tall props stick out of it.

`@aethervtt/shard-fog` draws fog from those inputs and nothing else. It never decides visibility. Which
tokens a player receives is the server's decision; the fog only darkens what's there.

## Goals

- Fog layers from ordered regions (rectangles, polygons with holes, brush strokes) over a base,
  with per-region strength and feather.
- Several layers composed as a union of darkness, with a per-viewer opacity and color.
- Applied in world space, so it covers floors, tokens, walls and props alike in both views.
- Incremental: appended strokes draw only themselves; changing the vision polygons redraws only
  the vision layer.

## Non-goals

- Computing vision, line of sight or exploration. These are inputs.
- Hiding entities. The host doesn't send what a player may not see, and fog makes no promise
  about it.
- Volumetric fog (0023 has distance fog; 0049 has weather).

## Design

### Layers

```ts
FogLayer {
  base: 'hidden' | 'revealed'
  extent: { min: vec2, max: vec2 }      // world XZ; outside it, the base applies
  texelSize: f32 = 0.05                 // metres per mask texel; clamped so the mask is ≤ 4096²
  color: color = '#000000'              // (and to the device's texture limit)
  opacity: f32 = 1
  regions: handle('FogRegions')         // ordered, with a revision
}
FogRegions {                             // data asset or resource-backed; the host writes it
  rev: u32
  regions: { op: 'reveal' | 'hide', strength: f32 = 1, feather: f32 = 0,
             shape: { kind: 'rect', x, y, w, h } | { kind: 'polygon', outer, holes }
                  | { kind: 'multipolygon', polygons } | { kind: 'brush', points, radius } }[]
}
FogSettings (resource) { compose: 'union', viewerOpacity: f32 = 1, floor: f32 = 0 }
```

For Aether, the vision layer is `base: 'hidden'` with the explored multipolygon (`reveal`,
strength 0.48, feather 10) and the visible polygons (`reveal`, 1, feather 18). The manual layer is
the GM's strokes, with the base the host chooses (forced to revealed while vision is active, as
Aether does now). `viewerOpacity` is 0.45 for a GM.

### Masks

Each layer owns one `r8unorm` mask over its extent: 1 is fog, 0 is clear. Regions draw in order:

- `hide`: `dst = dst + c × (1 − dst)`
- `reveal`: `dst = dst × (1 − strength × c)`

where `c` is the region's coverage. Coverage comes from geometry, not from a blur. Each shape is
tessellated by `@aethervtt/shard-vector` with a feather ring: an outer strip whose coverage ramps from 1 at
the edge to 0 at `feather`, around holes too. Brushes are a chain of capsules of `radius` plus the
ring. Every region's edge is soft by its own amount, with no blur pass and no bleed between
regions. A region's triangles can overlap (a brush's inner joins, a reflex corner's clamped miter),
so each region draws with a stencil that lets a texel take only the region's first triangle there;
core triangles (coverage 1) come first. A pass holds 255 regions, one stencil value each.

**Incremental.** A layer remembers `(rev, count)` and a hash of the regions it last drew. If the
new list extends the old one (the same prefix, a higher count), only the new regions draw onto the
existing mask; that's the brush-painting case. Any other change redraws the layer: clear to the
base, then all regions. Regions are tessellated once and cached by content, so a redraw is GPU
work only. A layer whose regions didn't change costs nothing.

### Composite

A pass after the transparent phase (`RenderPhase.Fog`) reconstructs each pixel's world XZ from
depth (sample 0 of the multisampled depth with MSAA), samples every layer's mask, takes the union
(`max` of value × opacity, the strongest layer's color), and darkens by it × `viewerOpacity` toward
that color. Pixels with no depth (background) use the floor plane at `FogSettings.floor`. The
`overlay` band (0057) and every band above it moved to their own pass after the composite
(`RenderPhase.Overlay3d`, only in views that have such content), since before this spec it drew in
the ground phase, before fog could exist. Up to four layers compose (`MAX_FOG_LAYERS`); more are
reported by `fog.describe` and don't compose. Fog therefore reads as a column over each point of the map: in the
Tabletop view it covers the top of a prop as well as the floor under it, and it looks the same as
the Map view from above. Selection outlines and overlay-band content draw after fog, so a GM's
selection stays visible.

### API sketch

```ts
import { fogPlugin, FogLayer, FogRegionsStore, FogSettings, setFogRegions } from '@aethervtt/shard-fog'
const manual = world.resource(FogRegionsStore).add({ rev: 1, regions: [...] })
world.spawn([FogLayer, { base: 'revealed', extent, regions: manual }])
setFogRegions(world, manual, { rev: 2, regions: [...regions, stroke] })  // appends; wakes the app
world.patchResource(FogSettings, { viewerOpacity: isGm ? 0.45 : 1 })   // wakes an idle app (0052)
```

Shapes are tessellated by `featheredCoverage` in `@aethervtt/shard-vector`. `referenceMask` is a
CPU raster of a layer made the way the GPU makes it (vertices snapped to 1/256 texel, the top-left
rule, each region's value rounded to 8 bits before blending and after), which tests hold the masks
to.

### Baseline tier (0064)

Masks are drawn by render passes and composited by a fragment pass, so fog runs on the baseline tier
unchanged. The composite reads layer masks as textures, not storage.

### Agent surface

- `fog.describe`: layers, extents, mask sizes, region counts, and whether the last update was an
  append or a full redraw, with its GPU time.
- `fog.sample { x, z }` returns each layer's value (read from its mask, bilinear) and the
  composite at a point, so a test can check fog without reading pixels.

## Decisions

- **Feather as geometry, not blur.** Per-region feather amounts are exact, it costs no extra
  passes, and it doesn't smear neighboring regions, which Aether's CSS blur does.
- **A world-space composite from depth, not a plane.** One mask covers both views and every
  height.
- **Masks per layer, composed at the end.** The vision layer changes every time a token moves;
  manual strokes change rarely. Separate masks keep either update from redrawing the other.

## Acceptance criteria

- [x] `fog.sample` inside a revealed polygon's hole returns the base; inside the polygon it returns
      0; at `feather / 2` outside the edge it returns 0.5 ± 0.05.
- [x] Hide and reveal regions applied in list order match a CPU reference raster of 200 mixed
      regions within 1/255 per texel.
- [x] Appending one brush stroke to 4,000 regions draws only that stroke (counted), in under 1 ms
      of GPU time (bench, with timestamp queries).
- [x] Changing only the vision polygons redraws the vision layer and leaves the manual mask
      untouched.
- [x] A redraw of 4,000 regions of 1,000 points each finishes in under 50 ms (bench).
- [x] In the Tabletop view, a prop standing inside a hidden region is covered to its top, and the
      Map view from above matches the Tabletop's fog footprint (golden captures).
- [x] `viewerOpacity` 0.45 over a hidden region darkens the pixel by 45% ± 1% (linear), with and
      without MSAA. Selection outlines draw unfogged.
- [x] A scene with no `FogLayer` has no fog pass in its graph.
- [x] While idle in on-demand mode, patching `viewerOpacity` or a layer's regions produces a frame
      that shows the change; with no change, the fog costs no frames.

## Open questions

- Should explored regions be kept as a mask the client accumulates, instead of a multipolygon the
  server sends? Proposed: no. Exploration is the server's; the client draws what it's given.
