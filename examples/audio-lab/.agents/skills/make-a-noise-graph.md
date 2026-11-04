# Make a noise graph

Terrain heights, biome masks, rock displacement, and cloud textures all start as a noise graph:
`assets/noise/<name>.noise.json`, validated against `.shard/schemas/noise.schema.json` (errors point
into the file). One file gives the CPU (gameplay, headless tests) and the GPU (materials, compute)
the same function.

```json
{ "output": "height",
  "nodes": {
    "continents": { "fbm": { "source": "simplex", "octaves": 5, "frequency": 0.8, "seed": 1 } },
    "mountains":  { "ridged": { "source": "simplex", "octaves": 6, "frequency": 3.2, "seed": 2 } },
    "mask":       { "remap": { "input": "continents", "from": [0.1, 0.4], "to": [0, 1], "clamp": true } },
    "warped":     { "warp": { "input": "mountains", "by": "continents", "amount": 0.15 } },
    "height":     { "add": ["continents", { "multiply": ["warped", "mask"] }] } } }
```

- An input is a node name, an inline node, or a number. Sources (value, perlin, simplex, cellular)
  and fractals (fbm, ridged, billow) take `seed` and `frequency` (features per unit). Operators:
  add, multiply, min, max, lerp, select, remap, clamp, curve, terrace, abs, power, constant; domain:
  warp, scale, translate. The schema lists every parameter with its range.
- Layer, don't hand-tune one node: a low-frequency fbm for continents, ridged for mountains, a
  `remap` of the continents (clamped to [0, 1]) as a mask so mountains only rise on land, and a
  small `warp` so ridges bend. Change one layer's `seed` to reroll only that layer.
- Frequencies are per unit of the domain. For a planet of radius R, continents are around 1/R to 4/R.
  Set `"extent"` to the radius and the importer rejects octaves too fine to address that far out.
- Check it numerically, not by eye: MCP `noise_stats` with `{ "graph": "assets/noise/planet.noise.json",
  "domain": "sphere", "thresholds": [0] }` says what fraction of the surface is below 0 (under water).
  `sample_noise` gives exact values at points; pass `"graph"` as JSON to try an edit before saving.
- Look at it: `preview_noise` (or `preview_asset` with `options`) renders it in grayscale, on a plane or a
  sphere; `"node": "mask"` shows one intermediate node on its own.
- In code: `sampleNoise` (near the origin), `sampleOffset` (any distance: an f64 origin plus small
  offsets), `sampleSpherePatch` / `sampleGrid2d`, and `...Async` versions on the worker pool.
- In a material: `project.material('Rock', { shader: 'project::rock', noise: { detail:
  'assets/noise/rock.noise.json' } })` makes `noise_detail(p: vec3f, seed: u32) -> f32` available
  to `import material::rock::noise_detail;`. Saving the graph re-renders the material.
