# 0063 — Screen-space lens fields

- **Status:** implemented
- **Packages:** `@aethervtt/shard-render`
- **Depends on:** 0023, 0052

## Context

Some effects bend what's behind them: Aether's Black Hole die distorts the table around it after a
natural 20 (Aether ADR-0098). The dice draw on their own transparent surface, above the DOM, and
the table draws on another. A surface can't refract pixels it doesn't own, so the table's own view
has to do the bending, driven by data the effect publishes: bounded screen-space fields.

## Goals

- `LensFields`: a bounded resource of screen-space fields any plugin can publish.
- `lensPlugin`: a post pass that displaces a view's own pixels inside live fields, leaves every
  other pixel exact, and costs nothing when no field is live.

## Non-goals

- Refracting the DOM or another app's canvas. The pass only ever samples its own view.
- Physically based lensing. It's an artistic displacement.
- Bending a `PixelPerfect` camera's view (0024). Its view draws a low-resolution image whose pixels
  aren't the target's CSS pixels; it renders unbent.

## Design

```ts
LensFields (resource) { fields: { screen: Vec2, radius: f32, strength: f32, ttlMs: f32, source: Entity }[] }  // at most 4
Lens { }                                                      // on a Camera3d: this view consumes fields
```

A field is in the target's CSS pixels. It lives `ttlMs` after its last refresh, then drops:
`ttlMs` counts down by each frame's time, and a refresh sets it again. `strength` is -1 to 1: above
0 magnifies the middle, below 0 pulls the surroundings in (the black hole), and 0 bends nothing.
Publishers refresh their fields while their effect runs, and clear them on dismissal, device loss
or disposal:

```ts
publishLensField(world, field)          // publishes or refreshes the source's field; false when 4 others are live
clearLensFields(world, source?)         // one source's fields, or all
forwardLensFields(from, to, offset?)    // copies one app's fields into another's (see below)
```

Expiry is core's, in `forwardCorePlugin` (`render/expire-lens-fields`, in `RenderSet.Begin`), so a
publisher without `lensPlugin` still drops its fields on time. It drops anything past 4, whatever a
host patched in, and holds the frame demand `render/lens-fields` while any field is live, so an
on-demand app runs the frame a field expires in and idles after. A `Lens` camera without
`lensPlugin` logs `render/feature-missing` and renders unbent.

`lensPlugin` (`@aethervtt/shard-render`) adds a post pass, `post/lens`, to any view with a `Lens` component.
It displaces that view's own pixels inside each live field, and only there:

- the view renders normally;
- inside a field's radius, the pass samples its own scene color at displaced coordinates, through
  a bounded mask;
- pixels outside every field are the normal render, exactly;
- the dice that published a field are never sampled by it.

The pass runs on the finished view target, after the display stage (tonemap, FXAA, upscale) and
before overlays (`RenderPhase.Display + 20`). It copies the fields' bounding box out of the target
into its own texture, then draws that copy back displaced, scissored to the box, and discards every
fragment outside all fields. A pixel outside every field is never written, so it stays exactly as
rendered. A pixel at distance `u` (a fraction of the radius) samples from `u · (1 − s · (1 − u)²)`:
unchanged at the rim, so there's no seam, and never outside the field. Overlapping fields add their
displacements. The copy is sampled bilinearly between texel centers, so a pixel the field doesn't
move comes back exactly.

The source is never sampled because the pass bends only its own view, before any later view or
overlay draws. The dice render in their own view: on their own surface, or from a camera with a
later `order`. A view that draws the source itself would bend it. Cameras have no render layers yet
(0057 adds them), so until then a `Lens` view keeps the dice out of its frustum.

It samples only what the view itself draws: never the DOM, never another app's canvas. With no live
field it isn't in the graph. The pass's extra target is at most 2,097,152 pixels, with no MSAA,
allocated only while a field intersects the view and released when none does. That's the same
bound as Aether's ADR-0098. The target grows in place as fields move, never past the bound. A
bounding box larger than the bound is cut down around its middle; pixels outside the cut stay unbent,
and `render.describe` reports `clipped`. A camera that stops rendering with `Lens` releases its
target too.

Fields reach the table either way: the dice and the table run in one app on two surfaces (0052),
so `LensFields` is shared; or the host forwards the dice app's fields to the table app with
`patchResource` each frame they're live. `forwardLensFields(dice.world, table.world)` does that
patch with copies, since each app counts its own fields down. Each field is in its own target's CSS
pixels, and the two canvases rarely share an origin: a page-wide dice canvas sits over a table
canvas below the host's top bar. `offset` is the table target's origin in the dice target's CSS
pixels, subtracted from each center. When the host stops forwarding, the
table's copies expire on their own. Reduced motion, effects off, the large-pool tier, a hidden
document, device loss and disposal all clear the dice's fields.

### Agent surface

- `render.describe` lists live fields per view, and whether `post/lens` ran and at what target size.
  Its `lens` section has `fields` (the resource) and, per `Lens` view, the fields that intersect it
  (in CSS pixels), `ran`, the copied `region` and the lens `target` size in pixels, and `clipped`.

## Decisions

- **The consuming view bends its own pixels.** Capturing the page into a texture would copy private
  UI and cross canvas boundaries. A view displacing what it already drew needs neither.
- **A bounded mask over a normal render.** Replacing the whole frame changed blending far from the
  field in Aether's first attempt. Compositing only inside the field keeps far pixels exact.
- **On the view target, after the display stage, not in HDR.** In the HDR chain, FXAA and bloom would
  spread the bent pixels past the field's rim, so pixels outside it wouldn't stay exact. The target
  is also what a canvas lets you copy (surfaces are `COPY_SRC`, not `TEXTURE_BINDING`).
- **`ttlMs` counts down, rather than a refresh timestamp.** The field is plain data a host can patch
  or forward, with no clock to agree on between apps. The forwarded copy expires when the source's
  would have.
- **Expiry in core, the pass in a plugin.** A dice app publishes but doesn't consume. Its fields
  still have to expire and release its frames. renderer-min grows about 0.4 KB brotli (entry
  95.6 → 96.0 KB) for the component, the resource and the expiry system.

## Acceptance criteria

- [x] With `lensPlugin`, a table view behind a landed die with a field changes pixels inside the
      radius, and leaves every pixel outside it byte-identical to the same frame without the field.
      The source die isn't displaced. The field expires `ttlMs` after its last refresh and the
      pass leaves the graph.
- [x] The lens target never exceeds 2,097,152 pixels, and it's released when no field is live
      (`gpu.stats`).
- [x] Two apps on one device (0052): fields published by one and patched into the other each
      frame distort the second app's view, and the second app goes idle again once they expire.
