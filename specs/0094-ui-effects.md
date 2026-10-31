# 0094 — UI effects: gradients, shadows, glow, cut corners, text outlines

- **Status:** accepted
- **Packages:** `@aethervtt/shard-ui`
- **Depends on:** 0036, 0025, 0064

## Context

0036's boxes are a solid fill, a border, and rounded corners. Game HUDs want more than that: a
name banner with a slanted end, a panel that fades out to the right, a bright accent stripe along
an edge, a drop shadow under a card, a glow around a selected slot, a diamond ornament, and large
numbers with an outline and a shadow. Today each of those needs a hand-made texture.

All of them are cheap in the shader 0036 already has. Boxes are signed distance fields, so a
shadow or a glow is the same distance blurred, a cut corner is one more half-plane, and a gradient
is a mix along an axis. Glyphs are MSDF, and 0025's world and screen text already draw outlines and
shadows from the field.

## Goals

- Gradients: linear (any angle) and radial fills between two colors with alpha, with a ramp range
  that can be made a hard edge (stripes and accent lines).
- Box shadows (offset, blur, spread) and glows (blur, spread, additive), outside the box only.
- Cut corners: a straight cut per corner with separate horizontal and vertical sizes. That covers
  chamfers, slanted ends, parallelograms, hexagons, arrow tags, and diamonds. Borders, gradients,
  shadows, glows, and images follow the shape.
- UI text outline and shadow (or glow), drawn so one glyph's outline never covers its neighbor.
- All of it settable from themes and state variants (`button:hovered` can add a glow).

## Non-goals

- More than two gradient colors, conic gradients, or gradient borders. Nest nodes instead.
- Inset shadows, several shadows on one node, backdrop blur.
- Concave shapes, curves other than 0036's radii, or arbitrary polygons.
- Hit testing against the shape: hits still use the node's rect, as rounded corners do today.
- Transitions between states (0036's non-goal stands).

## Design

### Fields

New `UiStyle` fields (all in UI pixels unless noted; each at its default takes the theme's value,
as 0036's fields do):

```ts
UiStyle {
  // ...0036's background, borderColor, borderWidth, radius, opacity
  cut: vec4            // per corner (tl, tr, br, bl): horizontal size of a straight cut (0: none)
  cutHeight: vec4      // vertical size of each cut (0: same as cut, a 45° chamfer)
  gradient: 'none' | 'linear' | 'radial'
  gradientColor: color // the end color; background is the start
  gradientAngle: f32 = 180   // degrees, CSS's convention: 0 to the top, 90 to the right
  gradientRange: vec2 = [0, 1] // where the ramp starts and ends along the gradient
  shadowColor: color = [0, 0, 0, 0.5]
  shadowOffset: vec2, shadowBlur: f32, shadowSpread: f32
  glowColor: color = [1, 1, 1, 0.6]
  glowBlur: f32, glowSpread: f32
}
UiText {
  // ...0036's fields
  outlineWidth: f32 (px), outlineColor: color = [0, 0, 0, 1]
  textShadowColor: color = [0, 0, 0, 0.6]
  textShadowOffset: vec2 (px, y down), textShadowSoftness: f32 (0..1 of the distance range)
}
```

- A shadow draws when its offset, blur, or spread is nonzero; a glow when its blur or spread is.
  A text shadow draws when its offset or softness is nonzero (0025's rule). So
  `"shadowBlur": 12` alone gives a usable shadow.
- Theme style fields are one flat namespace across UiStyle and UiText, hence `textShadow*`.

### Shape

A node's shape is its rect with per-corner radii (0036) and per-corner cuts. A cut corner's
radius is ignored. A cut's sizes clamp to the box, and the cuts along one edge scale down
together when they'd overlap. So a cut as tall as the box is a slanted end, and a square with
every cut at half its size is a diamond.

The shader's distance is the rounded box intersected with each cut's half-plane (`max`). Inside a
convex shape that's the exact distance, so a border is the band where `d > -borderWidth` for
every shape. Outside, it's mitered at the cuts' vertices, which keeps shadows of cut shapes
sharp-cornered.

### Gradients

The fill is `mix(background, gradientColor, f)` on premultiplied colors, so a gradient to a
transparent color fades without a dark fringe. `f` ramps from 0 to 1 between `gradientRange`'s two
positions along:

- **linear:** the axis at `gradientAngle`, from the side it starts to the opposite corner, sized
  as CSS sizes it (`|w sin θ| + |h cos θ|`).
- **radial:** the ellipse centered in the box, 0 at the center and 1 at the middle of each edge.

A range of zero width is a hard edge, antialiased over one pixel. `"gradientRange": [0.9, 0.9]`
with angle 180 is a stripe along the bottom edge that follows a cut.

### Shadows and glows

Each is one extra quad before the node's box: the box's shape moved by `shadowOffset`, grown by
the spread, with coverage `½ erfc(d / (σ√2))`, where `σ = blur / 2` as in CSS. The quad grows by
1.5 × blur to hold it. Coverage is cut out where the box itself is (CSS's rule), so a translucent
panel doesn't darken from its own shadow. A glow adds its light instead of blending over:
premultiplied with zero alpha. Order: glow, shadow, box, image, text.

### Text effects

A text with an outline or a shadow draws its glyphs twice. The first pass draws effects only (a
transparent fill) and the second draws fills only, so outlines and shadows never cover a
neighboring glyph. Effect glyph quads grow by the shadow offset, and samples clamp to the glyph's
atlas rect as in 0025. The outline is capped where the distance field ends (half the font's range).

### Records

The quad record grows from 28 to 44 floats (11 vec4s): two cut vectors, a second color (the
gradient end, or a glyph's outline color), and a params vector (a gradient's direction and range,
a shadow's offset, spread, and blur, or a glyph's shadow offset, outline width, and softness).
Glyph shadows use the border color slot. Kinds 4 to 7 are linear box, radial box, shadow, and
glow. All of them batch with boxes (no texture). The baseline tier reads the same records from
its data texture (0064). Nothing about uploading changes: unchanged frames upload nothing.

`resolveStyle` now gathers a style's base and state layers once per node rather than once per
field, so the larger field set doesn't multiply its cost.

### Agent surface

The new fields appear in the UiStyle and UiText schemas, in theme schemas and validation
(`ui/unknown-state`, `schema/unknown-field` as before), and in `shard docs`'s HUD skill. A node
with a visible gradient takes the pointer, as one with a visible background does.

## Decisions

- **Cuts as two vec4s, not polygons.** Eight numbers cover the shapes HUDs use, keep the shape
  convex (exact distances, cheap borders and shadows), and theme like radii do.
- **Glow is additive, a shadow blends.** That's the visible difference between them, and both
  come from the same premultiplied pipeline: zero alpha adds.
- **Two-color gradients with a range.** One record holds them, and a hard range covers stripes
  and accents. More stops are nested nodes.
- **Shadows aren't drawn under their box.** CSS's behavior. Without it, translucent panels go
  dark.

## Acceptance criteria

- [x] A golden image (both tiers) renders a slanted name banner with a linear gradient, a panel
      with a cut corner, a hard-edged accent stripe following the cut, and a drop shadow. It
      also has a glowing diamond, a radial-gradient medallion, and outlined, shadowed text.
- [x] A cut corner's pixel is the background behind the node, and a pixel just inside the cut is
      the node's fill.
- [x] A drop shadow darkens pixels outside the box by its offset, and a translucent box over it
      is no darker than without the shadow.
- [x] A glow brightens the pixels around a node and isn't drawn under it.
- [x] A theme state variant (`button:hovered`) adds a glow, and hovering the button shows it.
- [x] Theme files validate the new fields with the field types' own errors.
- [x] 0036's HUD golden still matches, and an unchanged frame still uploads nothing.

Covered in `packages/ui`: `render.test.ts` (the `effects` golden on both tiers with pixel checks for
the cut, the stripe, the shadow, the glow, and the diamond; the hover glow from a theme variant;
0036's `hud` golden unchanged) and `ui.test.ts` (theme validation). The playground's UI demo has a
duel plate built only from theme styles.

## As built

- Measured on the laptop: `ui/layout` for 2,001 nodes is 0.72 ms under `pnpm bench` (unchanged).
  The `full` size fixture grew 3.3 KiB (3722.5 → 3725.8 KiB all-JS); its budget rose 4 KiB.
  `renderer-min` doesn't bundle UI.
- The UI shader translates through naga to GLSL ES 3.00 for the WebGL2 fallback (both sRGB
  variants, both stages).
