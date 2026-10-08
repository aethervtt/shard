# Make a planet you can land on

A planet is an entity with `terrain/Planet` (it brings `transform/Grid`) and the `terrain` plugin in
`shard.json` (with `render/forward` to draw it and `physics3d` to stand on it). Heights come from a
noise graph (make-a-noise-graph.md); chunks are generated on the GPU as the camera moves, from six at
orbit down to 0.4 m vertex spacing on the ground. Put the camera in the planet's grid with
`transform/FloatingOrigin` (large-worlds.md).

```json
{ "name": "planet", "components": {
    "transform/Grid": { "cellSize": 2000 },
    "terrain/Planet": { "radius": 600000, "heightScale": 3000, "seed": 7,
      "height": { "path": "assets/noise/planet.noise.json" },
      "climate": { "path": "assets/noise/climate.noise.json" },
      "biomes": { "path": "assets/biomes/planet.biomes.json" }, "ocean": true, "seaLevel": 0 },
    "physics/GravitySource": { "strength": 9.81, "radius": 600000 } } }
```

- Height: the graph's output (about −1 to 1) × `heightScale` metres above `radius`. The graph is
  sampled at points on the sphere in metres, so frequency 1e-5 is 100 km features. Keep `radius` under
  50 000 km (`terrain/radius-too-large`).
- Climate: a graph with `temperature` and `moisture` nodes (−1 to 1). Latitude and altitude cool it
  (`latitudeBias`, `snowLine` in the BiomeSet).
- Biomes: `*.biome.json` files (ranges of temperature, moisture, height, slope; a tint; up to four
  texture layers by slope) listed in a `*.biomes.json` with `albedo`, `normal`, and `orm`
  `*.texarray.json` texture arrays (`{ "layers": ["grass.png", "rock.png"], "size": 1024 }`).
- Standing on it: characters, dynamic bodies, and `terrain/TerrainAnchor` entities get collider chunks
  within `colliderRadius`, built from the same CPU noise as `planetHeightAt(world, planet, dir)`, and
  those chunks render their own vertices. Use `CharacterController` with `up: "gravity"`.
- Walking agents: add `terrain/PlanetNav` to the planet; a navmesh follows the `NavAgent`s.
- Check it: MCP `terrain_map` (`{ "mode": "biomes" }`) shows continents, sea, and poles in one image;
  `sample_terrain` gives height, water depth, slope, and biome at `[lat, lon]` points;
  `describe_terrain` lists chunks per depth, generation, and colliders. Overlays `terrain-lod`,
  `terrain-biomes`, and `terrain-colliders` show them in a screenshot.
- Edit the height graph while `shard dev` runs: visible chunks regenerate together, colliders too.
  `terrain/Budget` caps chunks per frame and GPU time.
- Frame time: `vertexPixels` (4) stops chunks splitting once vertices are that many pixels apart
  (normal tiles keep the finer relief in the shading), and `terrain/Budget.triangles` (2M) coarsens
  a planet a little at a time when it draws more, so frame time holds at any resolution.
  `describe_terrain` shows `detail.lodBias` above 1 while it's coarsening.
- Give it air: `"render/Atmosphere": {}` on the planet entity takes the planet's radius, draws
  the sky from the ground to orbit, and hazes distant terrain (tune-an-atmosphere.md).
- Rocks, trees and grass: give biomes (or the planet) a scatter set (scatter-props-and-foliage.md).
