# Scatter rocks, trees and grass

Add `scatter` to `shard.json`'s plugins. A `*.scatter.json` (a `scatter/ScatterSet`) holds rules;
put it on a biome (`"scatter": { "path": "assets/scatter/forest.scatter.json" }` in a `*.biome.json`:
it applies where that biome dominates), on the planet (`terrain/Planet.scatter`: everywhere), or on
a flat level's ground mesh (`scatter/ScatterSurface` next to its `render/Mesh3d`).

```json
{ "rules": [
  { "name": "trees", "items": [{ "generator": "shard/Tree", "variants": 6 }],
    "density": 0.02, "spacing": 4, "masks": { "slope": [0, 25] }, "scale": [0.7, 1.3],
    "collider": "ball", "range": 400 },
  { "name": "grass", "kind": "foliage", "items": [{ "generator": "shard/GrassClump", "variants": 4 }],
    "density": 5, "avoid": ["trees"], "range": 50 } ] }
```

- Two kinds. `prop` rules spawn entities (`scatter/Prop`, with LODs and an optional collider) in
  chunks around cameras and `TerrainAnchor`s; `foliage` rules are GPU instances near cameras only,
  millions of them, no entities. Grass, flowers and small pebbles are foliage; anything you bump into is a prop.
- Items are mesh generators (`shard/Rock`, `shard/Tree`, `shard/Bush`, `shard/GrassClump`,
  `shard/Crystal`, or a project's) with `params` and `variants` (4–8 shapes read as unique), or
  prefabs. Without a `material`, engine generators get `scatter/Vegetation` tinted for their kind.
- `density` is per m² where the masks pass, `spacing` the least distance between items. Too dense
  for the spacing is `scatter/density-too-high` (it says the most that fits). Rule order is priority:
  `avoid` names earlier rules. `align` 0 stands items upright, 1 along the slope. `sink` buries
  them by a share of their height.
- Placement is a global jittered lattice: the same seed puts the same tree in the same place on every
  visit and machine. A prop the game despawns stays gone (saved in `scatter/Removed`).
- Check it: MCP `preview_generator` with `{ "generator": "assets/scatter/forest.scatter.json" }`
  shows the set on a 64 m patch from above and at eye level; `describe_scatter` gives per-rule
  counts; `sample_scatter` lists props near a point (`{ "entity": "landing-pad", "radius": 10 }`).
  Overlays `scatter` and `foliage-chunks` show placements in a screenshot.
- `scatter/Budget` caps props spawned per frame; `scatter/Wind` sways foliage and leaves.
