# Build a large world: grids and the floating origin

Positions are f32. Past about 10 km from the origin they lose millimetres, and past 1 000 km they
visibly jitter. For anything bigger (a star system, a planet you can land on), put entities in a
`transform/Grid` and mark the camera `transform/FloatingOrigin`. A small level doesn't need any of this.

A position in a grid is `GridCell.cell × Grid.cellSize + Transform.translation`. The cell is an exact
integer and the translation stays under half a cell, so everything near the camera is precise.
`GlobalTransform` is relative to the origin's cell, so it stays small too.

```json
{ "name": "system", "components": { "transform/Grid": { "cellSize": 2000 } }, "children": [
  { "name": "planet", "components": {
      "transform/Grid": { "cellSize": 2000 },
      "transform/GridCell": { "cell": [75000000, 0, 0] },
      "core/Transform": { "rotationEuler": [0, 20, 0] } } },
  { "name": "ship", "components": {
      "transform/GridCell": { "cell": [74996000, 0, 0] },
      "core/Transform": { "translation": [120, 0, -40] } },
    "children": [ { "name": "camera", "components": {
      "render/Camera3d": {}, "transform/FloatingOrigin": {} } } ] } ] }
```

| Grid | Suggested cell | Reach (±2³¹ cells) | f32 offset precision |
|---|---|---|---|
| Galaxy | 10¹² m | 2×10²¹ m | ~60 km, fine for stars |
| Star system | 2 000 m | 4×10¹² m (~30 AU) | ~0.1 mm |
| Planet | 2 000 m | far beyond any planet | ~0.1 mm |

- Only direct children of a grid carry `GridCell`. Deeper descendants use their parent's transform as
  usual. A nested grid (a planet) is a `Grid` with a `GridCell` in its parent grid; spin it with its
  own `Transform` rotation and everything on its surface turns with it.
- Moving things: write the translation as usual. `transform/recenter` moves an entity into the next
  cell once it goes `cellSize / 2 + hysteresis` past the centre. Don't write a far position into
  `translation`: `shard validate` reports `transform/translation-outside-cell`.
- One `FloatingOrigin` per world (`transform/multiple-origins`), usually on the camera. When it
  changes cells, `transform/OriginShift` fires with the offset: code that caches `GlobalTransform`
  positions across frames adds `offset` to them.
- From tools: `patch_entity` with `{ "position64": [3.8e8, 0, 0], "grid": "system" }` places an entity
  exactly and splits the cell for you. `get_entity` returns `worldPosition64` (relative to the origin
  cell), and `app.describe` lists the grids and where the origin is.
- In code (cold paths, f64): `worldPosition64(world, e, out, frame?)`, `distance64(world, a, b)`,
  `placeInGrid(world, e, grid, position)`, and `reparentToGrid(world, ship, planetGrid)` to move a
  ship into a rotating planet grid without a jump.
- Physics runs in the origin's frame, so bodies near the camera are precise; saves store cells, so a
  save 10¹² m out loads to the millimetre.
