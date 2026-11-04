# Make a heightfield terrain (an open world)

A bounded landscape, 256 m to 64 km a side, shaped on purpose: a `*.terrain.json` file stacks
height layers (noise, heightmap images, splines that flatten, raise or carve) and paint layers, and an
entity with `terrain/Terrain` (it brings `transform/Grid`) draws, streams and collides with it. Add
`terrain` to `shard.json`'s plugins (with `render/forward` and `physics3d`). The file's schema is
`.shard/schemas/terrain.schema.json`; coordinates are metres from the terrain's corner.

```json
{ "size": [4096, 4096], "spacing": 1, "heightRange": [-200, 800], "seed": 7,
  "splines": { "road": { "points": [[120, "ground", 300], [900, "ground", 420]], "width": 8, "falloff": 14 } },
  "height": [
    { "noise": { "path": "assets/noise/hills.noise.json" }, "scale": 260 },
    { "image": { "path": "assets/terrain/valley.height.png" }, "at": [2048, 1800], "size": [1200, 900],
      "rotation": 20, "range": [0, 140], "blend": "max", "falloff": 80 },
    { "spline": "road", "mode": "flatten" } ],
  "layers": [{ "name": "grass" }, { "name": "rock", "triplanar": true }, { "name": "gravel" }],
  "paint": [{ "layer": "grass" }, { "layer": "rock", "slope": [32, 90], "blend": 6 },
            { "layer": "gravel", "spline": "road", "blend": 2 }] }
```

- Sizes are whole numbers of roots: 64 × spacing × 2^k a side, at most 64 roots (2048, 4096 or
  16384 m at 1 m spacing). `heightRange` is what the bake stores in 16 bits: keep it close to the
  real range (a clipped height is `terrain/out-of-range`).
- Heightmaps are 16-bit grayscale PNGs (name them `*.height.png`, or set `"importer": "heightmap"`
  in the `.meta`) or `.r16`/`.r32` raw files with `width` and `height` in the `.meta` settings.
- `shard import` bakes stale terrains into `.shard/cache/terrain` (only the blocks an edit touches);
  `shard terrain bake` forces it, `shard terrain stats` shows size on disk and time per block.
  `shard dev` rebakes after you save the file.
- Standing on it: characters, dynamic bodies, `NavAgent`s and `terrain/TerrainAnchor`s get
  heightfield colliders within `colliderRadius`, exactly the drawn ground. `terrainHeightAt(world,
  terrain, x, z)` is the ground under a point; `await loadTerrainRegion(world, terrain, rect)` first
  makes it exact away from anchors (spawn points). A plain `nav/NavMesh` paths on it.
- Rocks and trees: `terrain/Terrain.scatter` takes a `*.scatter.json` (scatter-props-and-foliage.md).
- Check it: MCP `terrain_map` (`{ "mode": "layers" }`, or `"bake"` to see which blocks an edit
  rebuilt), `sample_terrain` (`{ "points": [[120, 300], [124, 300]] }`: is the road flat across?),
  and `describe_terrain` (bake, pages, collider tiles). Overlays `terrain-lod`, `terrain-pages`
  and `terrain-colliders`.
