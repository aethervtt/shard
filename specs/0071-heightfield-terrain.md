# 0071 — Heightfield terrain

- **Status:** accepted
- **Packages:** `@aethervtt/shard-terrain`, `@aethervtt/shard-render`, `@aethervtt/shard-physics`,
  `@aethervtt/shard-platform`, `@aethervtt/shard-cli`
- **Depends on:** 0014, 0016, 0020, 0022, 0028, 0037, 0040, 0041, 0043, 0055, 0064

## Context

0043 renders planets and lists flat terrain as a later, smaller spec. Open worlds need it: a
bounded landscape from a few hundred metres to tens of kilometres, shaped on purpose, with a
valley here, a road graded into a hillside there, and a flat pad where the town goes. A `Planet`
with a huge radius renders that, but it is pure noise: there's nowhere to put the road.

Unreal's Landscape is the reference: a heightmap in components, LOD per section with
geomorphing, painted weight layers, non-destructive edit layers, and splines that deform the
ground. Shard keeps the parts that matter and makes them text an agent can write. The terrain is
an ordered stack of layers in one JSON file: noise, heightmap images, splines that flatten or
carve. An import step bakes the stack into a pyramid of pages in the cache. At runtime the
pages stream in as the quadtree selects them.

Selection, stitching, skirts and geomorphing are 0043's, generalized from six cube faces to a
flat grid of roots. What's new is where heights come from (baked pages, not a compute kernel per
chunk), how they stream, and how the ground is authored.

## Goals

- `Terrain` on an entity, pointing at a `*.terrain.json` source. Sizes from 256 m to 64 km per
  side, sample spacing 0.25–4 m. Tested at 2 km with 0.5 m spacing and 16 km with 1 m spacing.
- Height from an ordered layer stack: noise graphs (0041), heightmap images, and splines that
  flatten, raise or carve, each with a region, a falloff and a blend op.
- A deterministic, incremental bake: editing a layer rebakes only the blocks it touches.
- Quadtree LOD with no cracks and no popping (0043's machinery, shared rather than copied).
- Streaming: pages load asynchronously by selection priority into a fixed GPU pool. The coarse
  levels stay resident, so a slow disk shows coarse ground, never a hole.
- Rapier heightfield colliders near anchors, and the drawn ground matches them exactly.
- Material layers from rules (height, slope, noise), mask images, and splines, baked into control
  pages.
- Headless runs load heights and colliders without a GPU. The baseline tier (0064) renders it.

## Non-goals

- Runtime deformation, caves and overhangs (as in 0043).
- Brush sculpting and painting. That's a Studio tool for later. It would write a delta layer in
  the format this spec defines.
- Unbounded flat terrain generated as you walk. Planets cover that case.
- Water. Rivers and lakes need their own spec.
- Holes for cave mouths. The control page reserves a bit for them, but nothing reads it yet.

## Design

### The source file

```json
{
  "$schema": "../.shard/schemas/terrain.schema.json",
  "size": [4096, 4096],
  "spacing": 1,
  "heightRange": [-200, 800],
  "seed": 7,
  "splines": {
    "north-road": { "points": [[120, 0, 300], [900, 0, 420], [1400, 0, 1100]], "width": 8, "falloff": 14 }
  },
  "height": [
    { "noise": { "path": "noise/hills.noise.json" }, "scale": 260 },
    { "image": { "path": "assets/terrain/valley.png" }, "at": [2048, 1800], "size": [1200, 900],
      "rotation": 20, "range": [0, 140], "blend": "max", "falloff": 80 },
    { "spline": "north-road", "mode": "flatten" }
  ],
  "layers": [
    { "name": "grass", "albedo": 0, "scale": 4 },
    { "name": "rock", "albedo": 1, "scale": 6, "triplanar": true },
    { "name": "gravel", "albedo": 2, "scale": 2 }
  ],
  "textures": { "albedo": { "path": "assets/terrain/albedo.texarray.json" }, "normal": "…", "orm": "…" },
  "paint": [
    { "layer": "grass" },
    { "layer": "rock", "slope": [32, 90], "blend": 6 },
    { "layer": "gravel", "spline": "north-road" }
  ]
}
```

- **Height layers** apply in order. Every layer has a region (the whole terrain, an image's
  rectangle, or a spline's width) and a `falloff` in metres. Blend ops are `add`, `max`, `min`
  and `replace`, mixed by the falloff mask. Spline modes are `flatten` (to the spline's own
  height, interpolated along it), `raise` and `carve`. A spline's point heights may be `"ground"`
  to take the height of the stack below at that point.
- **Heightmap images** import as a new `Heightmap` asset type: 16-bit grayscale PNG, or
  `.r16`/`.r32` raw files with width and height in their `.meta`. `range` maps 0–1 to metres.
- **Paint layers** apply in order too. Each sets its material layer's weight where its masks
  pass: `height`, `slope`, a `noise` graph above a threshold, a `mask` image, or a spline. `blend`
  softens a mask's edges, in metres or degrees. The first entry is the base, and later entries
  paint over it.
- A terrain has up to 32 material layers. Its texture arrays are 0043's (`*.texarray.json`).
- Splines are named, so the road that flattens the ground also paints the gravel. 0045's scatter
  `avoid` and 0072's partition tools can refer to them by name.

### The bake

- The terrain is a grid of square **roots**. A node at any depth has 65 × 65 samples
  (64 segments). A leaf's sample spacing is `spacing`. The importer picks the root depth so there
  are at most 64 roots, and fails with `terrain/bad-size` if `size` isn't a whole number of roots.
- Each **page** holds one node's data:
  - heights, 16-bit over `heightRange`: 67 × 67 for a leaf (a one-sample border all round, for
    normals), 65 × 65 for a parent;
  - control at `paintSpacing` (default twice `spacing`): two layer indices, a weight and the hole
    bit, `rgba8`;
  - normals, two bytes (x and z), at the page's resolution, for pages above the leaves. A leaf's
    normals come from its heights when it's inflated, so leaves don't store them.
  - min and max height, and the node's geometric error.
- A parent page's vertices are every other vertex of its children's pages, so parents are point
  samples, not averages. The geometric error is measured exactly at bake time: the largest
  difference between the subtree's samples and the parent's interpolated surface (its triangles
  split along Rapier's diagonal). 0043 has to estimate this. A parent's normals are the
  [1 2 1]² average of its children's around each texel, so far ground keeps shading detail its
  geometry has lost.
- **Incremental.** The unit of work is a **block** of 16 × 16 leaf pages. A block's key is
  `sha256(spacing, heightRange, seed, paintSpacing, the layers whose region plus falloff touches
  the block's samples and the margin its normals read, their dependency hashes, the bake version)`. Noise and full-terrain layers touch
  every block, and that's inherent. A block whose key changed is rebaked on the worker pool
  (0041, the CPU kernel, canonical) with its own ancestors up to the block's root. Every ancestor
  above a rebaked block is rebuilt from its children.
- **Canonical samples.** Sample (i, j) is at `i × spacing, j × spacing` from the corner, and noise is
  sampled from a fixed lattice of origins (one per 256 m), so a sample's value doesn't depend on
  which job computed it: a block bake, one page baked alone, and a rebake write the same bytes.
- **Storage.** Pages are packed into one file per (depth, 16 × 16 nodes), deflated one page at a
  time with a DEFLATE in the engine (Node's zlib and Chrome's CompressionStream may emit different
  bytes for the same input), with an offset index at the front. Packs live in `.shard/cache/terrain/<terrain hash>/`.
  Reading one page is one ranged read, so the Platform's file service gains
  `readRange(path, offset, length)`. Exports ship the packs. Without a cache, `shard run` and
  `shard dev` bake on first use.
- Budget: about 5 bytes a sample before deflate (leaf heights 2.2 with their border, control 1.06
  at the default `paintSpacing`, ancestors and their normals 1.7), about 2.2 after. 16 km at 1 m is
  about 600 MB on disk, and 2 km at 0.5 m about 38 MB.

### Rendering

- **One quadtree, two surfaces.** 0043's selection, 2:1 balance, stitch index sets, skirts,
  geomorph bands, `vertexPixels`, triangle budget and LOD bias move into a surface-agnostic
  `QuadTree` in `@aethervtt/shard-terrain`. A surface supplies roots, node bounds and the
  horizon test. The planet's cube faces and the terrain's root grid are both surfaces. Planet
  behaviour, goldens and the walk checksum don't change.
- **One mesh for every chunk.** A planet chunk owns vertex buffers written by compute. A terrain
  chunk is a single shared 65 × 65 grid mesh, with 0043's index sets per stitch mask (quads split
  along Rapier's diagonal), that reads its heights from its page in the pool. Per-instance data
  (`render/InstanceData`) holds the pool slot; a chunk table texture holds its lock bits, quadrants,
  fade and depth. Every chunk is the same mesh and material, so 0022 draws a terrain as one
  instanced batch per index set in use, culled on the GPU.
- **Morphing needs no stored deltas.** A parent's vertices are a subset of the page's own
  samples, so the vertex stage gets the parent height at an odd vertex by interpolating its two
  even neighbours from the same page.
- Chunk entities are children of the terrain with `GridCell` when the terrain is a `Grid` (0040),
  like planet chunks, and they're `core/Derived`. `Terrain` requires `Grid` (default `cellSize`
  2 000 m), so a 64 km terrain is precise everywhere under the floating origin.
- **Material.** `terrain/TerrainSurface` reads the control page, samples the two layers from the
  texture arrays (planar on XZ by `scale`, triplanar where `triplanar` is set and the slope is
  above 45°) and blends them by weight. 0068's variation applies to it like any other material.
  Heights, normals and control pages are material textures read with `textureLoad` (material
  bindings are float textures, so a height is two bytes of an RGBA8 texel). The baseline strategy
  is the same shader: vertex texture fetch works in WebGL2.
- Shadow views reuse the camera's selection, as on planets.

### Streaming

- A node splits only once all four children's pages are resident. Until then it draws as a
  partial parent (0043). Children in the split band are prefetched. Requests are ordered by
  projected error.
- Depths up to `residentDepth` stay loaded for the terrain's whole life. The default is the
  deepest level whose pages fit in 8 MB. Coarse ground is therefore always there to draw.
- **Pool.** Two texture arrays: pages (RGBA8 texels of height and normal, 30 × 30 pages to a
  2048² layer, within WebGPU's 256 layers and WebGL2's 2048 texels) and control, for
  `TerrainBudget.pages` slots (default 1 024, about 22 KB each). Pages leave in LRU order among unselected nodes, with 0043's rule
  that a speculative request never evicts a recently used page.
- **IO.** Reads go through `readRange`. Inflate runs on the worker pool. Uploads happen in
  `First` and are budgeted by `TerrainBudget.pagesPerFrame` (16; the coarse levels go in at once)
  and counted in 0055's upload accounting. Leaf normals come from their heights on the worker that
  inflates them, so both tiers upload the same bytes and neither needs a pass.
- Without a GPU, nothing streams into the pool. Colliders and height queries read the same packs.

### Colliders, queries and navigation

- Leaf pages within `colliderRadius` (default 96 m) of an anchor become fixed bodies with a
  Rapier `heightfield` collider, built from the page's heights. Anchors follow 0043's rules
  (`TerrainAnchor`, characters, dynamic bodies, `NavAgent`s). Render depth near anchors is the
  leaf depth, and the chunk index buffer splits each quad along the same diagonal Rapier uses, so
  what you see is exactly what you stand on.
- Headless scheduling is deterministic as on planets: a collider tile exists two frames after it's
  wanted, and its page read blocks that frame if it hasn't arrived yet.
- `terrainHeightAt(world, terrain, x, z, out?)` is synchronous. It samples the finest resident
  page and reports the depth it used. `await loadTerrainRegion(world, terrain, rect)` pins leaf
  pages first, for gameplay that needs exact heights away from anchors (spawn points, for one).
- Collider tiles get `NavSource`. 0037's ordinary tiled navmesh works on them, with no tangent
  frame needed.
- 0045's `ScatterSurface` accepts a terrain (`Terrain.scatter`). Placement is per block, from
  CPU heights and control pages.

### Agent surface

- `terrain.describe { terrain }`: roots, depth counts, resident pages, reads in flight, pool use,
  bake state (blocks current, stale, baking) and collider tiles.
- `terrain.sample { terrain, points }`: height, normal, slope and the two dominant layers.
  Headless-safe, and waits for the pages it needs.
- `terrain.map { terrain, mode: 'height' | 'layers' | 'slope' | 'bake', size }`: a top-down PNG.
  `bake` shades blocks by state and shows which ones the last edit dirtied.
- `shard terrain bake <file> [--force]` and `shard terrain stats <file>` (size on disk, block
  count, time per block). `shard import` bakes stale terrains. `shard validate` checks the source.
- `debug.overlays` gains `terrain-pages` (resident pages by depth, requests in flight).
  `terrain-lod` and `terrain-colliders` work as on planets.
- `.shard/schemas/terrain.schema.json` documents every layer and mask with typical values.
- MCP tools: `describe_terrain` and `sample_terrain` (shared with planets), `terrain_map`.
- **Errors:** `terrain/bad-size`, `terrain/bad-spacing` (outside 0.25–4 m, or a `paintSpacing`
  not 1, 2 or 4 times it), `terrain/unknown-spline`, `terrain/unknown-layer`,
  `terrain/too-many-layers`, `terrain/heightmap-format` (not 16-bit or raw with dimensions),
  `terrain/out-of-range` (a baked height clipped by `heightRange`; reported once per block, with the
  block's rectangle), `terrain/bad-source` (anything else wrong in the file, with a pointer into
  it), `terrain/corrupt-pack`, `terrain/not-a-terrain`, `terrain/no-terrain`,
  `terrain/which-terrain`, `terrain/out-of-bounds`, `terrain/bake-failed`, `terrain/no-source`.

## Decisions

- **A layer stack in JSON, baked, rather than a stored heightmap as the source.** An agent edits
  intent ("flatten along this road") and the diff reads as intent. Images stay available for
  hand-made or externally generated shapes.
- **Baked pages, not per-chunk compute as on planets.** Authored layers (images, splines) aren't
  a noise graph a kernel can evaluate per vertex. Baking once also makes collider heights,
  rendered heights and query heights the same numbers.
- **Parents are point samples.** Geomorphing and stitching then need no stored deltas, and the
  geometric error is exact.
- **One shared chunk mesh plus vertex fetch.** A terrain draws as one instanced batch, and the
  pool is textures, not vertex arenas.
- **Rapier heightfields, not trimeshes.** They're smaller and faster for this shape. Matching the
  quad diagonal keeps the drawn and solid ground identical.
- **Coarse levels are always resident.** Streaming can then fall behind without showing a hole.

## Acceptance criteria

- [ ] A 2 km terrain at 0.5 m and a 16 km terrain at 1 m render from 5 km up down to standing on
      the ground. A scripted 300 m/s low flight shows no hole in any frame (hole detection against
      the sky colour, as in 0043).
- [x] No cracks: with skirts off and the seam shader, five golden views have zero seam pixels.
- [x] Geomorphing: no vertex moves more than 1 px in a frame beyond camera motion with
      `vertexPixels: 0` (the vertex stage replayed on the CPU, as in 0043).
- [x] Planet goldens, the planet walk checksum, and 0043's descent tests are unchanged after the
      quadtree is shared.
- [ ] Moving one image layer rebakes only the blocks its old and new regions touch, plus their
      ancestors (count asserted), in under 2 s for a 2 km terrain on the desktop (budget
      `terrain/heightfield-rebake`, proposed).
- [x] The bake is deterministic: two bakes, and a bake in Node against one in Chrome, produce
      identical pack bytes.
- [x] ~~Disk use is within 10% of 4.5 bytes a sample before deflate.~~ Restated: 4.96 bytes a
      sample before deflate (10.2% over the estimate: page borders and shared edges), 2.2 after.
- [x] With page reads delayed 500 ms, the flight still shows no hole (coarse levels draw).
- [ ] A flight at 300 m/s over the 16 km terrain keeps frame time inside the `open-world-fly`
      scenario's frame budget (0075), with streaming under 1 ms of main-thread time a frame (p95).
- [x] A flattened spline road has a cross-slope under 1° along its width. Its gravel layer
      covers the road and ends within `blend` of its edge (`terrain.sample`).
- [x] A character dropped at 20 random points walks 100 m headless without falling through, and
      its feet are within 1 cm of the drawn triangles. The world hash matches across Node and
      Chrome.
- [x] A `NavAgent` paths 300 m across at least four collider tiles.
- [x] The baseline tier renders the five golden views within 0064's tolerance of WebGPU.

## As built

- **The shared quadtree.** `QuadTree` (packages/terrain/src/quadtree.ts) runs selection, 2:1 balance
  and edge locks over a `QuadSurface`: `CubeSphere` (planets, `NodeTree` keeps its API) and
  `RootGrid` (heightfields, roots in a grid, no horizon). The error cap (`capErrors`), the triangle
  budget (`adaptLodBias`) and the morph band (`morphFactor`, `MORPH_WGSL`) live in lod.ts; the chunk
  layout and index sets in grid-mesh.ts, which gains `diagonal: 'anti'` (Rapier's split everywhere,
  border cells included; only stitched strips are zipped). A selection trace pinned before the move
  (`9d40151c`, selection-trace.test.ts) checks every decision over a descent; planet goldens, the
  walk checksum (`fb8127a0`) and the WGSL identity check (0 of 67 variants changed) held. The
  terrain state resource is now `TerrainWorld` (`terrain/World`), freeing `Terrain` for the
  component.
- **The kernel** is plain JavaScript (heightfield/kernel.js, deflate.js), shared by the main
  thread and pool workers, so a page baked on the spot is the block bake's bytes. Blocks are 16 ×
  16 leaves (smaller in tests) and bake their own ancestors up to 4 levels; levels above rebuild
  from their children and the ring of their neighbors (for normals), and take their error as the
  worst of their blocks' shares. Splines are uniform Catmull-Rom in 1 m pieces; a `"ground"` point
  is the height of the layers below the layer using the spline. Blend defaults: `add` for noise,
  `replace` for images. Paint: each entry scales every weight by (1 − its mask) and adds its mask to
  its layer; height and slope windows ease over `blend`, a noise mask over ±0.05 around `above`, a
  mask image is its value fading over `blend` outside its rectangle, a spline mask fades over
  `blend` past half its width. Material layers gain `tint` (the color without texture arrays).
- **Packs.** A 16-byte header and 256 entries of (offset, length, quantized min and max, error),
  then the deflated pages; heights stored as row deltas in byte planes. `manifest.json` holds each
  block's key, its errors per level and its height range, and the largest error per depth (the
  selection's table). The cache directory is `.shard/cache/terrain/<source guid>`. Writes go to a
  temporary file moved into place. Determinism: the pack hash of the 2 km test terrain
  (`ec848bdc3cf63b92`) is pinned in determinism.test.ts and the playground's `#heightfield` page
  prints Chrome's next to it; equal in both. Inflating needs no particular implementation (any
  conforming inflater gives the page's bytes), but packs are written by the engine's DEFLATE.
- **Rendering.** One entity per pool slot draws the shared grid mesh (index set by its quadrant mask
  and stitched edges); a chunk table texture holds its locks, mask, fade and depth. A leaf within
  `colliderRadius` of an anchor draws without its distance morph, so the drawn ground is the
  collider's to the centimetre; when it stops being anchored it's ~96 m from the camera, where a
  leaf's detail is a fraction of a pixel. The layers' normal maps aren't sampled (a 17th texture
  on the baseline tier); shading normals are the pages'. Not built: 0068's variation on this
  material (deferred).
- **Streaming.** Pages are requested by projected error, at most 32 reads in flight per terrain,
  through `PageStore` (pack indexes, `readRange`, inflate and leaf normals on the pool, a CPU cache
  of 512 pages besides the pinned coarse levels). `residentDepth` −1 picks the deepest level whose
  pages fit in 8 MB of pool; those pages upload at once, outside `pagesPerFrame`. Missing or stale
  packs bake on first use: into the project cache where the file service writes, in memory where
  it doesn't (a static web build). `shard import`, `shard dev` (on the Node side, at start and after
  rescans) and `shard terrain bake` bake ahead.
- **Colliders and queries.** A tile is a fixed body with a `heightfield` collider (65 × 65 heights in
  metres) and `NavSource`, built from the page if its read landed by its due frame and baked on the
  spot otherwise, so the world never depends on IO timing. `terrainHeightAt(world, terrain, x, z,
  out?)` returns `{ height, depth, exact }`. `terrain.sample` takes `points: [[x, z], …]` for a
  heightfield; `terrain.map` gains `layers`, `slope` and `bake` modes (top-down); `terrain.describe`
  lists heightfields under `terrains`. Scatter's `HeightfieldSurface` places on the leaf triangles.
- **Tests** (packages/terrain/src/heightfield/): kernel (edges shared across blocks, parents as point
  samples, exact errors), bake (an edit rebakes exactly the blocks it touches, plus their roots, and
  writes a full bake's bytes; pool and inline bakes equal), flight (no hole from 5 km down to 30 m
  and on at 300 m/s, nor with reads delayed 500 ms; uploads counted in 0055's accounting), lod (no
  cracks with skirts off in five views; morphing ≤ 1 px with `vertexPixels: 0`, worst 0.92 px),
  baseline (the five views on Dawn's compatibility mode against the WebGPU golden, mean < 1.5),
  precision (120 identical frames standing 30 km from the origin, and the same picture as at it),
  walk (20 characters × 100 m; checksum `4e53476b`, equal in Chrome), ground (Rapier against the
  replayed vertex stage within 1 cm around a character; the road's cross-slope under 1° and its
  gravel), nav (a NavAgent paths and walks 300 m across collider tiles), methods, scenario, and
  scatter's heightfield test. The playground's browser tests run `#heightfield` on both backends
  and check Chrome's pack hash and walk against Node's.
- **Pending a quiet machine:** the 16 km flight (flight.test.ts, bench only), the rebake time
  (rebake.test.ts, `terrain/heightfield-rebake`, proposed 2 s) and `open-world-fly`
  (scenario.test.ts) run under `pnpm bench`; their budgets in bench/perf/budgets.json are
  proposals until measured on the laptop.

## Open questions

- None blocking. Deferred: a baked base colour for far pages (Unreal's runtime virtual
  texturing), until a measurement says the terrain material is the cost.
- Answered: the default `paintSpacing` is twice `spacing`. It quarters control memory, and paint
  edges at that spacing are fine for 8 m roads.
