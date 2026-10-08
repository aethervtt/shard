# 0043 — Planet terrain

- **Status:** implemented
- **Packages:** `@aethervtt/shard-terrain` (new), `@aethervtt/shard-render`, `@aethervtt/shard-texture`, `@aethervtt/shard-physics`,
  `@aethervtt/shard-nav`, `@aethervtt/shard-procgen`
- **Depends on:** 0016, 0020, 0022, 0028, 0029, 0031, 0037, 0040, 0041, 0042

## Context

The proof project's headline feature is a planet you can see from orbit, fly down to, land on,
and walk across. That needs a terrain that is a sphere, spans eight orders of magnitude of viewing
distance, is generated from a seed rather than stored, and streams in fast enough that descending
at hundreds of metres per second never shows holes.

The standard shape is a **cube-sphere**: six quadtrees, one per cube face, projected onto a sphere.
A chunk splits into four when its screen-space error is too big. Chunk heights come from a noise
graph (0041) evaluated on the GPU for rendering and on the CPU for colliders near the player.
Chunks are ordinary `Mesh3d` entities, so instancing, culling, shadows, the deferred path, and
picking work without special cases.

Rocky planets range from kilometre-sized moons to super-Earths. Earth is 6 371 km, and a
super-Earth is up to about 2.5× that. The design works the same at every size. Selection is by
screen-space error, so the number of visible chunks barely depends on radius; a bigger planet just
has a deeper tree. Gas giants have no solid surface and aren't terrain; 0046 renders them.

## Goals

- `Planet { radius, height, seaLevel, biomes, … }` on an entity with a `Grid` (0040). Everything
  about the surface comes from its noise graphs and biome data.
- Rocky planets from 1 km to 50 000 km radius, tested at 4 km, Earth (6 371 km), and a 16 000 km
  super-Earth.
- Cube-sphere quadtree LOD from orbit (six root chunks) down to ~0.4 m vertex spacing, split by
  screen-space error, with no cracks and no popping.
- GPU chunk generation: a compute pass per chunk evaluates the height and biome graphs and writes
  vertex data directly into GPU-only mesh buffers.
- CPU colliders for chunks near physics bodies (canonical heights, 0041), plus a sync
  `planetHeightAt` query for gameplay.
- Biomes as data assets, chosen per point from temperature, moisture, height, slope, and latitude,
  and textured by splat layers with triplanar mapping from a texture array.
- A sea-level ocean surface with its own quadtree.
- Streaming with a per-frame budget, priority by visible error, and an LRU of generated chunks.
- Headless runs build colliders and heights with no GPU, so gameplay tests work in `shard test`.
- A navmesh on the surface around agents, in a tangent frame.

## Non-goals

- Caves, overhangs, and voxel editing (a heightfield can't have them; voxel terrain is a later spec).
- Terrain deformation at runtime (later: a per-chunk delta layer).
- Flat (non-planet) heightmap terrain as a separate component. A `Planet` with a huge radius works
  for landscapes but isn't optimized for them; flat terrain is 0071.
- Water rendering beyond a lit, transparent, wave-normal surface (VISION lists water as later).
- Gas giants (no surface; 0046 renders them as banded cloud spheres with deep atmospheres).

## Design

### Components and data

```ts
Planet {
  radius: f64 = 4000                        // metres, 1 km – 50 000 km
  shape: vec3 = [1, 1, 1]                   // ellipsoid axis ratios (lumpy asteroids, 0047)
  height: handle('NoiseGraph')              // output in [−1, 1], scaled by heightScale
  heightScale: f32 = 600                    // metres
  seed: u32                                 // mixed into every graph
  ocean: bool = true                        // a sea surface at seaLevel
  seaLevel: f32 = 0                         // metres above radius
  climate: handle('NoiseGraph')             // outputs temperature and moisture (two nodes)
  biomes: handle('terrain/BiomeSet')
  resolution: u16 = 33                      // vertices per chunk edge (2^n + 1)
  minSpacing: f32 = 0.4                     // finest vertex spacing, metres; sets the max depth
  errorPixels: f32 = 2                      // split when projected error exceeds this
  vertexPixels: f32 = 4                     // stop splitting at this screen vertex spacing (0: off)
  colliderRadius: f32 = 96                  // CPU colliders for chunks within this of an anchor
  skirts: bool = true                       // off only for the seam test
}
TerrainAnchor { enabled, radius }           // extra collider anchors (bodies and characters are anchors anyway)
TerrainBudget { chunksPerFrame: 8, triangles: 2_000_000, msPerFrame: 1.5, pool: 2048, colliderCache: 256 }

// Data types (0031): *.biome.json and *.biomes.json
Biome { layers: list(struct { layer: u16, scale: f32 }),   // layers of the set's texture arrays
        temperature: vec2, moisture: vec2, height: vec2, slope: vec2, blend: f32, tint: color }
BiomeSet { biomes: list(handle('terrain/Biome')), albedo, normal, orm: handle('Texture') /* arrays */,
           latitudeBias: f32, snowLine: f32 }
```

- The planet entity is a `Grid`. Chunk entities are its children with a `GridCell` and a
  translation at the chunk's center, so vertex positions are small f32 numbers relative to that
  center. That gives sub-millimetre precision on the surface at any planet size.
- The max depth is derived: the first level whose vertex spacing is ≤ `minSpacing`. With
  33 vertices per edge, that's depth 9 for a 4 km moon, 20 for Earth, and 21 for a 16 000 km
  super-Earth. Depth 24 is the cap, since node keys hold 24 bits per axis, and that's enough for
  0.4 m spacing up to ~50 000 km.
- `Planet` requires `Grid`, `Transform`, and `Visibility` (chunk entities inherit visibility from
  it), so its rotation is the planet's spin (0040) and chunk entities never move relative to it.
  Chunk entities are tagged `core/Derived`: saves and the world hash skip them.

### The quadtree

- Cube-to-sphere mapping is the "tangent-adjusted" cube map (per-face `tan(π/4 · u)`), which keeps
  chunk areas within 1.4× of each other. `faceToDirection` and `directionToFace` are exported, and
  0041's `sampleSpherePatch` uses the same mapping.
- Node keys are `(face, depth, x, y)`, packed with 3 + 5 + 24 + 24 bits into two u32s. They're
  stable and hashable.
- `terrain/select` runs in PostUpdate after transform propagation. Per camera it walks the six
  trees and computes each node's projected error from its geometric error (its max height
  deviation from its parent's surface, recorded at generation) and its distance to the camera's
  frustum. It splits above `errorPixels`, merges below half of it, and culls nodes beyond the
  horizon (a sphere-horizon test) or outside the frustum. The walk uses scratch arrays with no
  allocation, and the tree is kept as flat TypedArrays indexed by node slot. Pixels are CSS
  pixels (0051): the view's height is `displayHeight / pixelRatio`, so a Retina display selects
  the same chunks as a standard one.
- **Screen-space detail limit.** `vertexPixels` (default 4) caps each depth's error at
  `errorPixels / vertexPixels` times its vertex spacing, so rough terrain stops splitting once
  vertices are that many pixels apart. Without it, cost followed the roughness of the noise graph:
  the playground's Earth drew ~2.7M triangles for 2.45M pixels near the ground (18.5 ms of GPU at
  2.5 MP, 1 330 chunks, 5 km up), and 800–1 000 chunks even in a 160×120 view. Selection and morph
  bands read the capped table, so morphing still ends where splits happen; skirts keep the
  measured errors. Changing either setting at runtime regenerates every chunk (they carry their
  morph error). Price: each split's parent-to-child displacement is larger, so the new chunk's
  0.5 s fade paces it and vertices move up to ~4 px a frame in a 500 m/s descent, continuously
  (at most 1/30 of the displacement a frame), never a pop.
- **Normal tiles.** Shading detail finer than the geometry comes from a normal tile per chunk:
  its grid at twice the vertex density (65² texels for 33² vertices), sampled from the height graph
  on the GPU in the chunk's job and written by a normals kernel with the vertex pass's central
  differences (a normals-only job for chunks drawn from collider meshes). Tiles live in an
  `rgba8unorm` array of 2048² layers (961 tiles each, grown as the pool grows; 16 MB a layer). The
  fragment finds its tile and position through `uv1.x = i + j·n + n²·tile` (the vertex stage
  derives lock codes from `(i, j)`) and render's new `vertex_extra` hook. The tile grid's points
  are grouped by a lattice a quarter of the chunk (not 64 m), so a coarse chunk's tile costs ~25
  noise setups, not 4 489; tiles don't need bit-identical edges. Off above 33 vertices per edge. To
  fit in 16 sampled textures a stage, the planet material uses the new `standardTextures: false`
  (it never used the standard slots). At 2.5 MP near the ground: 11.7 ms and 462 chunks with the
  cap and tiles, against 21.3 ms and 979 uncapped, with the fine relief still in the shading.
- **Triangle budget.** `TerrainBudget.triangles` (2M per planet; 0 off) steers a LOD bias that
  multiplies `errorPixels` for selection and morphing: up 1% a frame while the planet draws more,
  down 0.5% a frame once under 85% of it, 1 to 16. Frame time then holds at any resolution and on
  any GPU, trading detail gradually. Slow on purpose: the bias moves split distances, so morphs
  shift with it. `terrain.describe` shows `detail { vertexPixels, lodBias, triangles }`.
- **Point lattice by level.** Sample points are grouped by lattice origins so noise inputs stay
  small in f32. With a fixed 64 m lattice every point of a coarse chunk was its own group, and each
  group carries per-octave origins for each graph: flying low in the browser uploaded 7.7 MB of
  origins a frame (12.9 ms of `terrain/encode` in Chrome). A point's lattice now follows its level
  (the coarsest depth it's a vertex at, from its grid index's trailing zeros): 64 m for points only
  fine chunks have, up to a quarter chunk at that level, at most 4 096 m (inputs within 2 km, a
  quarter millimetre in f32). Every chunk sampling a point picks the same lattice, so shared
  vertices stay bit-identical; the same flight uploads 0.58 MB and encodes in 1.2 ms. Heights move
  by fractions of a millimetre, so the walk checksum changed (Node and Chrome still match).
- **A full pool doesn't thrash.** Only a request needed this frame (on screen, or blocking a
  split) may evict a recently used chunk; a speculative one (prefetch, out of view) takes a free
  slot or one idle for 60 frames, or waits. Before, prefetches evicted each other once the pool
  filled: at 2460×1790 a still camera regenerated 8 chunks every frame indefinitely.
- A split never shows a hole. While some children aren't ready, the parent draws only the
  quadrants they would cover (a *partial parent*: an index set per quadrant mask) and the ready
  children draw the rest. Children that replace a parent fade in from the parent's shape over
  0.5 s, so a late split slides instead of popping. Children near the split distance are
  prefetched, and a slot whose node blocks a split this frame is never evicted.
- Physics and shadows add their own selection inputs. A body with `TerrainAnchor` (default: every
  dynamic body and character) forces depth ≥ `colliderDepth` around it within `colliderRadius`.
  Shadow cascades reuse the camera's selection.

### Crack-free LOD

- Neighbors may differ by one depth level. The quadtree enforces a 2:1 balance, splitting extra
  nodes when needed.
- **Stitching**: an edge that meets a coarser neighbor draws only its even vertices, the
  neighbor's, so there is no T-junction (a vertex on the neighbor's edge up to rounding shows
  pixel-sized holes). Index sets are cached per (quadrant mask, stitched edges), and a slot switches
  between them with `Mesh.setIndices`, keeping one mesh and one batch per slot.
- **Skirts**: each chunk has a double-sided strip hanging below its drawn border, covering what
  rounding still leaves, from either side.
- **Geomorphing**: each vertex stores the delta to where its parent level would put it (tangent.xyz;
  tangent.w is the height) and its lock code and the depth's error (uv1). The vertex shader blends
  by distance within the node's LOD band. Edges locked to a coarser neighbor take the parent's
  shape, edges toward a finer one keep their own, center lines of a partial parent keep their own,
  and edges never fade. The per-instance lock bits, fade, and quadrant mask ride in
  `render/InstanceData` (two numbers per instance). 0020's hooks read them through accessors in
  `shard::mesh` (`vertex_uv1()`, `vertex_tangent()`, `vertex_world(p)`, `vertex_instance_data()`)
  rather than new hook arguments, so existing overrides keep compiling.

### GPU generation

- Render support: **GPU-only meshes**. `Mesh.gpu({ vertexCount, indices, bounds, share?,
  baseVertex? })` makes a `Mesh` whose buffers have `STORAGE | VERTEX` usage and no CPU copy; with
  `share` it draws another GPU mesh's buffers from `baseVertex`. Chunk slots live 256 to an arena
  (one set of buffers), so consecutive chunks draw with no rebinding; the forward and shadow passes
  skip redundant binds, and GPU culling carries the base vertex in its indirect arguments. Index
  arrays are shared (one GPU buffer per array).
- Per chunk, `terrain/generate` (a compute node, once per frame for all views) dispatches the
  planet's generated WGSL. For `(resolution + 2)²` points (one-vertex border for normals), it
  writes height, climate, and biome weights to a scratch buffer, then a second kernel writes
  positions, normals (central differences), tangents, morph deltas, and packed biome weights into
  the chunk's mesh. Normals match across neighbors because borders sample the same domain points.
- **Precision at any radius.** The CPU prepares each job's points in f64: the vertex's zero-height
  position relative to the chunk center and its direction, so the kernel only adds `dir × h` in
  f32 (no two-float math needed). Noise is sampled with 0041's origin offsets relative to a lattice
  origin every 64 m (`SNAP`), not the chunk center, and domain points are `dir × R + NOISE_OFFSET`
  (away from OpenSimplex2's tie planes, where CPU and GPU rounding pick different lattice points).
  So a vertex two chunks (or two depths) share samples the same numbers: edges are bit-identical.
- Geometric errors are measured per depth when the planet's graphs change (sample chunks, made
  non-increasing, with a safety factor), not per chunk. Each chunk's min/max height is read back a
  frame or two later (no stall) to tighten its bounds; until then the planet's range is used.
- Budget: `TerrainBudget { chunksPerFrame: 8, msPerFrame: 1.5 }`. All of a frame's jobs run in one
  timed compute pass; where timestamps exist, the per-frame job count drops so the pass stays under
  `msPerFrame`. Jobs still queued (kernels compiling) count against the next frame. The highest
  projected errors go first.
- **Hot reload.** An edited graph bumps the planet's version. Old chunks keep drawing until the new
  kernels compile; then every visible chunk and its ancestors regenerate in one frame (outside the
  budget), and other stale nodes stop counting as ready, so old and new never meet at a seam.
- Chunk meshes are pooled per planet (default 2 048 slots) and evicted LRU among nodes not
  selected. Regenerating an evicted chunk is deterministic, so eviction is invisible.

### CPU heights and colliders

- `planetHeightAt(world, planet, direction, out?)` samples the height graph on the CPU (0041,
  sync) and returns metres above radius. It powers placement, gameplay queries, and headless tests.
- Collider chunks are generated on the worker pool at `colliderDepth` (the depth whose spacing is
  ≤ 1 m) for nodes within `colliderRadius` of any anchor: `TerrainAnchor` entities, characters,
  dynamic bodies, and `NavAgent`s when the planet has `PlanetNav`. Each becomes a fixed-body child
  entity with a `trimesh` collider. Scheduling is deterministic: a chunk becomes a collider two
  frames after it's wanted, from the pool's result if it's in, else built on the main thread.
  They're cached in an LRU (`colliderCache`, 256).
- **What you see is what you stand on.** GPU and CPU heights agree only within 0041's tolerance,
  which grows with `heightScale` (a few centimetres for Earth-like relief). So chunks that have a
  collider render from the collider's CPU vertices (copied into the chunk slot's buffers) instead
  of the GPU ones, and render depth near anchors stops at `colliderDepth`. Only distant chunks use
  GPU heights, and there the difference is sub-pixel.
- Headless (no GPU), selection runs for anchors only and produces collider chunks. The render path
  is skipped, and the world hash is identical to a run with a GPU.
- The character controller (0029) works as is: `GravitySource` on the planet provides up, and
  colliders are ordinary trimeshes.

### Biomes and texturing

- Texture arrays arrive in `@aethervtt/shard-texture`: `Texture.create({ …, layers: n })` and a
  `TextureArray` importer (`*.texarray.json` listing files, all resized to one size and format).
  0016 deferred this to M7.
- The kernel writes climate per vertex (uv = temperature, moisture). The `terrain/PlanetSurface`
  material's `pbr_input` computes biome weights per fragment from a biome table texture (a
  `smoothstep` window per range, `blend` the softness; effective temperature subtracts
  `latitudeBias · |latitude|` and height over `snowLine`), keeps the top four, and samples their
  layers from the set's albedo, normal, and ORM arrays, triplanar in planet space (repeating every
  1 024 m so f32 stays precise), by slope. A `BiomeSet` has at most 32 biomes, each up to 4
  layers. The CPU does the same math for `terrain.sample` and `terrain.map`.
- Material type fields bind as `texture_2d_array` with `arrays: [...]` (0020).

### Ocean

- With `ocean`, a second quadtree at `radius + seaLevel` uses the same selection and a flat
  generation kernel that also writes the water depth. It renders through a `terrain/Ocean` material:
  transparent, forward, with procedural wave normals, depth-based color from the water depth, and
  Fresnel reflection of the environment.
- `planetSurfaceAt` reports `{ height, underwater, depth }` for gameplay. Swimming and buoyancy are
  game code.

### Navigation

- `PlanetNav { agentRadius, agentHeight, maxSlope, radius: f32 = 150 }` on a planet keeps one
  `NavMesh` in a tangent frame (up = radial) at the ground under its `NavAgent`s, baked from the
  collider chunks within `radius` (they get `NavSource`). The frame moves, and the navmesh rebakes,
  once the agents drift half the radius away. One frame is flat enough over a few hundred metres,
  and Detour's ordinary tiles join across chunks.
- 0037 gains a `frame` field on `NavMesh`: bake, query, and steer agents in that entity's local
  space.

### Agent surface

- `terrain.describe { planet }` returns selected node counts by depth, chunks in flight, pool
  usage, GPU time per frame, collider chunks, and the biome under the camera.
- `terrain.sample { planet, directions | latlon }` returns height, biome weights, slope, and
  underwater, from the CPU path, headless-safe.
- `debug.overlays` gains `terrain-lod` (chunks shaded by depth), `terrain-biomes` (dominant
  biome color), and `terrain-colliders` (collider chunk borders and anchors).
- `terrain.map { planet, size, mode }` returns an equirectangular PNG of height or biomes, so an
  agent can check "are there oceans and poles" in one image. (A planet generator's
  `procgen.preview` comes with 0046.)
- MCP tools: `describe_terrain`, `sample_terrain`, `terrain_map`.
- **Errors:** `terrain/radius-too-large` (over 50 000 km), `terrain/bad-resolution` (not 2^n + 1),
  `terrain/too-many-biomes`, `terrain/climate-outputs` (climate graph lacks temperature or
  moisture nodes).

## Decisions

- **Chunks are normal `Mesh3d` entities.** Culling, LOD visibility, shadows, the deferred path,
  picking, and debug views work unchanged. A parallel terrain renderer would duplicate all of that.
- **GPU-only meshes written by compute.** Terrain vertices never touch the CPU on the render path,
  and the same mesh feature serves 0045's GPU foliage.
- **CPU colliders from the canonical kernel.** Physics has to work headless and match across
  machines, and only a few dozen chunks near bodies need them.
- **Stitching, skirts, and geomorphing together.** Geomorphing alone left T-junction sparkles with
  skirts off; index sets per (mask, stitched edges) are cached and shared, and switching them is a
  cheap index swap on the slot's mesh.
- **CPU-prepared local offsets instead of two-float math.** The CPU already builds each job's
  points in f64, so the kernel never sees the cancelling expression.
- **Canonical sampling.** Lattice-origin snapping and the noise offset make shared vertices
  bit-identical across chunks and depths, which is what crack-free edges and matching normals need.
- **Tangent-adjusted cube mapping.** Nearly uniform chunk sizes with cheap forward and inverse
  mapping, which both kernels and gameplay queries use.

## Acceptance criteria

- [x] A 4 km planet renders from 20 000 km away (six root chunks) down to standing on the surface.
      A scripted descent at 500 m/s never shows a hole (frame-by-frame hole detection against the
      sky color in a test render).
- [x] The same holds for an Earth-radius planet (6 371 km) descending from 40 000 km to the surface
      in 120 s, and for a 16 000 km super-Earth. The visible chunk count at 2 m altitude is within
      2× of the 4 km planet's (uncapped: the LOD structure; `vertexPixels` thins small planets
      more, 2.1×).
- [x] On the Earth-radius planet, standing still on the surface, vertices show no jitter (screen
      position stable to 0.01 px over 600 frames), and a 0.5 m noise octave renders as smooth
      bumps, not steps (golden).
- [x] No cracks: a render with skirts disabled and a debug seam shader shows zero seam pixels at
      2:1 boundaries in five golden views.
- [x] Geomorphing: during a descent no vertex pops. ~~No vertex's screen position moves more than
      1 px between frames beyond camera motion~~, restated: that holds uncapped (`vertexPixels:
      0`, no triangle budget); with the default cap vertices morph continuously, under 6 px a frame
      at 500 m/s and no more at half speed, where a pop would move tens of px at once.
- [x] With `vertexPixels`, rough terrain draws well under two thirds of the uncapped chunks
      without holes, and normal tiles keep its relief in the shading. Over
      `TerrainBudget.triangles` the planet coarsens until it fits, and refines back after.
- [x] CPU `planetHeightAt` and the GPU chunk heights agree within 0041's tolerance times
      `heightScale` at 10 000 random points. Collider chunks render exactly the collider's vertices,
      so a character's feet are within 1 cm of the visible ground on the Earth-radius planet.
- [x] A character dropped at 20 random points walks 100 m in a straight line headless without
      falling through, and the world hash matches across Node and Chrome.
- [x] Generation stays within `TerrainBudget` in the bench, and with the default settings a
      descent keeps frame time under 16.6 ms on both machines (budget `terrain/descent-frame`).
- [x] A planet with an ocean shows water where `terrain.sample` reports underwater, and the
      `terrain.map` golden shows continents, poles (snow biome), and sea.
- [x] A `NavAgent` on the surface paths 120 m across at least three chunk tiles.
- [x] Editing the height graph in `shard dev` regenerates visible chunks within 1 s without
      holes, and colliders update too.

## As built

- Tests: `packages/terrain/src/*.test.ts` cover every criterion. The descent runs a hole detector
  every frame (4 km, Earth, and 16 000 km, zero holes; 198 / 225 / 192 chunks standing at 2 m);
  seams use the debug shader with skirts off in five golden views; geomorphing replays the vertex
  stage on the CPU (worst step under 1 px); CPU/GPU heights match at 10 000 points and feet are
  within 1 cm of the drawn collider triangles; 20 characters walk 100 m; the walk checksum is pinned
  (`fb8127a0` since the level-based point lattice below; `0da23929` before) and the
  playground's `#terrain` page shows Chrome's next to it; the bench holds a
  960×540 descent to p95 frame time under 16.6 ms (CPU p95 8.5 ms, GPU p95 9.3 ms) at no more than
  8 jobs a frame; hot reload regenerates every visible chunk in 4 frames with no hole pixels.
- Deferred: scatter per biome (0045), a custom planet material (needs material type inheritance),
  and distance-based single-sample texturing.
- Example: star-explorer's `scenes/planet.scene.json` (a 600 km planet with climate, five biomes,
  and an ocean) and `tests/planet.test.ts`.

## Open questions

- Should chunk generation use the pool's CPU path on hosts with a weak GPU? Proposed: no. The GPU
  path is required for rendering; the CPU path exists for colliders and headless runs.
- None blocking. Deferred: runtime deformation, voxel caves, flat terrain, and horizon-based
  occlusion of props behind mountains (0045 may need it).
