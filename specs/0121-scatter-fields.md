# 0121 — Scatter fields from code

- **Status:** draft (built 2026-11-15). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-scatter`, `@aethervtt/shard-terrain`
- **Depends on:** 0045, 0071, 0119

## Context

0045's scatter places by slope, height and a noise graph above a threshold, and `avoid` keeps a
rule clear of earlier rules' items. Nothing keeps trees off a road, a house pad or a lake: those
are in the game's own plan, not in a noise graph. Risen's regions (its spec 0009) want forests by
zone, tree rows along field edges and creeks, yard trees on lots, and nothing on roads, pads or
water. The terrain generator (0119) already knows all of that, since it grades the ground to it.

## Goals

- A terrain generator can name **fields**: functions of (x, z) giving a density from 0 to 1.
- A scatter rule's `masks.field` names one. Its density thins the rule (a candidate stays with
  probability density × the rule's acceptance), and 0 excludes it: one field is both density and
  exclusion.
- Props and foliage both honour it, deterministically, with the same placements on every machine.

## Non-goals

- Fields on mesh and planet surfaces. They come from a heightfield's generator; a planet's biome
  table already does this job there.
- Fields from images or splines. 0071's paint masks and spline names cover hand-made terrains.

## Design

```ts
defineTerrainGenerator('risen/Ground', {
  …,
  fields: {
    // Density 0–1 at count points (x, z pairs in the terrain's frame).
    trees: (plan, xz: Float64Array, count: number, out: Float32Array) => { … },
    grass: (plan, xz, count, out) => { … },
  },
})
```

```json
{ "name": "oaks", "kind": "prop", "density": 0.02, "spacing": 5,
  "masks": { "slope": [0, 30], "field": "trees" }, "items": [ … ] }
```

- On a heightfield surface, `field` names a field of one of the terrain's generators (the first
  of its stack's generators that has it), with that generator's params from the source. The same
  prepared state serves the terrain's pages and its fields (0119), so a road the ground is graded
  to is the road the trees keep off.
- **Props:** the lattice is 0045's. A cell's accept draw `u` is compared with `accept × field(x,
  z)` at the cell's jittered point instead of `accept`, so a field of 1 places exactly what it did
  without one, and lowering the field only removes items. The field is evaluated once per chunk
  for every candidate that passed the plain accept test (one call, a batch of points).
- **Foliage:** the patch's per-vertex density (0045's 33 × 33 grid, which the GPU placement
  interpolates) is multiplied by the field at each vertex.
- Values are clamped to [0, 1]; a non-finite one is `terrain/bad-generator-output`.
- Fields run on the main thread, where heightfield placement runs (0045 places mesh and
  heightfield chunks inline).

### Agent surface

- `scatter.describe` shows each rule's `field`.
- **Errors:** `scatter/unknown-field` (no generator of the surface's terrain has the field, or the
  surface isn't a heightfield), with the fields that exist in the hint.

## Decisions

- **A density, not a boolean.** Exclusion is density 0; forest edges and thinning near a road come
  free.
- **Thinning keeps the lattice.** Comparing the same accept draw against a lower threshold means a
  field never moves an item, only removes it, so edits to the plan near one tree don't reshuffle
  the forest.
- **Points, not grids.** Prop candidates are jittered points; a grid API would make every
  generator interpolate.

## Acceptance criteria

- [x] A rule with a field of 1 everywhere places exactly the items it places without the field.
- [x] With the test generator's road field (0 on a 10 m road, 1 elsewhere), no tree lands on the
      road and the counts elsewhere match the unmasked rule; grass density is 0 at every patch
      vertex on the road. *Restated:* GPU-placed grass instances weren't checked one by one (see
      As built).
- [x] A field of 0.5 keeps about half the items (within 5% over 2 000 candidates), every one of
      them an item the unmasked rule also places.
- [x] A rule naming a field no generator has reports `scatter/unknown-field`, listing the fields.

## As built

- `TerrainGeneratorOptions.fields`; `generatorAccess(spec).field(name, …)` clamps to [0, 1] and
  reports non-finite values. `stackField(stack, name)` and `stackFieldNames(stack)` resolve a
  field among a stack's generators.
- Scatter: `masks.field` (a string, '' for none) becomes `CompiledRule.field`; surfaces may
  implement `resolveField` and `fieldNames` (`Surface`), and `MeshSurface.configure` resolves each
  rule's field once. Heightfield surfaces resolve through the terrain's stack; meshes and planets
  have none, so a field there is `scatter/unknown-field` too.
- Props: `fieldDensity` evaluates the field once per chunk at the jittered points of the cells that
  passed the plain accept draw. Foliage: the patch density is multiplied per vertex. Grass between
  two patch vertices takes the GPU's interpolated density, so blades can reach up to one patch cell
  (a chunk's size / 32) onto a road's edge; the test checks the vertices, not GPU instances.
- `scatter.describe` lists a rule's `field`.
- **Tests**: scatter/src/fields.test.ts (a 6 × 6 chunk block across the road: `one` equals no
  field, `road` removes exactly the items on the road and keeps the rest, `half` keeps a subset
  within 5% of half; foliage vertices on the road at 0; the unknown field's hint lists `road, half,
  one`).

## Open questions

- None.
