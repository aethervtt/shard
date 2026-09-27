# 0063 — Screen-space lens fields

- **Status:** accepted
- **Packages:** `@shard/render`
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

## Design

```ts
LensFields (resource) { fields: { screen: Vec2, radius: f32, strength: f32, ttlMs: f32, source: Entity }[] }  // at most 4
Lens { }                                                      // on a Camera3d: this view consumes fields
```

A field is in the target's CSS pixels. It lives `ttlMs` after its last refresh, then drops.
Publishers refresh their fields while their effect runs, and clear them on dismissal, device loss
or disposal.

`lensPlugin` (`@shard/render`) adds a post pass, `post/lens`, to any view with a `Lens` component.
It displaces that view's own pixels inside each live field, and only there:

- the view renders normally;
- inside a field's radius, the pass samples its own scene color at displaced coordinates, through
  a bounded mask;
- pixels outside every field are the normal render, exactly;
- the dice that published a field are never sampled by it.

It samples only what the view itself draws: never the DOM, never another app's canvas. With no live
field it isn't in the graph. The pass's extra target is at most 2,097,152 pixels, with no MSAA,
allocated only while a field intersects the view and released when none does. That's the same
bound as Aether's ADR-0098.

Fields reach the table either way: the dice and the table run in one app on two surfaces (0052),
so `LensFields` is shared; or the host forwards the dice app's fields to the table app with
`patchResource` each frame they're live. Reduced motion, effects off, the large-pool tier, a hidden
document, device loss and disposal all clear the dice's fields.

### Agent surface

- `render.describe` lists live fields per view, and whether `post/lens` ran and at what target size.

## Decisions

- **The consuming view bends its own pixels.** Capturing the page into a texture would copy private
  UI and cross canvas boundaries. A view displacing what it already drew needs neither.
- **A bounded mask over a normal render.** Replacing the whole frame changed blending far from the
  field in Aether's first attempt. Compositing only inside the field keeps far pixels exact.

## Acceptance criteria

- [ ] With `lensPlugin`, a table view behind a landed die with a field changes pixels inside the
      radius, and leaves every pixel outside it byte-identical to the same frame without the field.
      The source die isn't displaced. The field expires `ttlMs` after its last refresh and the
      pass leaves the graph.
- [ ] The lens target never exceeds 2,097,152 pixels, and it's released when no field is live
      (`gpu.stats`).
- [ ] Two apps on one device (0052): fields published by one and patched into the other each
      frame distort the second app's view, and the second app goes idle again once they expire.
