# 0043 — Planet terrain

- **Status:** accepted
- **Packages:** `@shard/terrain` (new), `@shard/render`, `@shard/texture`, `@shard/physics`,
  `@shard/nav`, `@shard/procgen`
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
- Navmesh tiles baked per nearby chunk in its tangent frame.

## Non-goals

- Caves, overhangs, and voxel editing (a heightfield can't have them; voxel terrain is a later spec).
- Terrain deformation at runtime (later: a per-chunk delta layer).
- Flat (non-planet) heightmap terrain as a separate component. A `Planet` with a huge radius works
  for landscapes but isn't optimized for them; a flat quadtree is a later, smaller spec.
- Water rendering beyond a lit, transparent, wave-normal surface (VISION lists water as later).
- Gas giants (no surface; 0046 renders them as banded cloud spheres with deep atmospheres).

## Design

### Components and data

```ts
Planet {
  radius: f32 = 4000                        // metres, 1 km – 50 000 km
  shape: vec3 = [1, 1, 1]                   // ellipsoid axis ratios (lumpy asteroids, 0047)
  height: handle('NoiseGraph')              // output in [−1, 1], scaled by heightScale
  heightScale: f32 = 600                    // metres
  seed: u32                                 // mixed into every graph
  seaLevel: f32 = 0                         // metres above radius; NaN = no ocean
  climate: handle('NoiseGraph')             // outputs temperature and moisture (two nodes)
  biomes: handle('BiomeSet')
  resolution: u16 = 33                      // vertices per chunk edge (2^n + 1)
  minSpacing: f32 = 0.4                     // finest vertex spacing, metres; sets the max depth
  errorPixels: f32 = 2                      // split when projected error exceeds this
  colliderRadius: f32 = 600                 // CPU colliders for chunks within this of a body
}

// Data types (0031)
Biome { layers: list(struct { albedo, normal, orm: handle('Texture'), scale: f32 }),
        temperature: vec2, moisture: vec2, height: vec2, slope: vec2, blend: f32,
        scatter: handle('ScatterSet') /* 0045 */, tint: color }
BiomeSet { biomes: list(handle('Biome')), latitudeBias: f32, snowLine: f32 }
```

- The planet entity is a `Grid`. Chunk entities are its children with a `GridCell` and a
  translation at the chunk's center, so vertex positions are small f32 numbers relative to that
  center. That gives sub-millimetre precision on the surface at any planet size.
- The max depth is derived: the first level whose vertex spacing is ≤ `minSpacing`. With
  33 vertices per edge, that's depth 9 for a 4 km moon, 20 for Earth, and 21 for a 16 000 km
  super-Earth. Depth 24 is the cap, since node keys hold 24 bits per axis, and that's enough for
  0.4 m spacing up to ~50 000 km.
- `Planet` requires `Grid` and `Transform`, so its rotation is the planet's spin (0040) and chunk
  entities never move relative to it.

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
  allocation, and the tree is kept as flat TypedArrays indexed by node slot.
- A node renders only if all four of its children are ready or it is a leaf, so a split never
  shows a hole. The parent stays visible until the last child arrives.
- Physics and shadows add their own selection inputs. A body with `TerrainAnchor` (default: every
  dynamic body and character) forces depth ≥ `colliderDepth` around it within `colliderRadius`.
  Shadow cascades reuse the camera's selection.

### Crack-free LOD

- Neighbors may differ by one depth level. The quadtree enforces a 2:1 balance, splitting extra
  nodes when needed.
- **Skirts**: each chunk has a strip of vertices hanging below its border, hiding T-junction slivers.
- **Geomorphing**: each vertex stores its position plus the delta to where its parent level would
  put it (in `uvs1`). The vertex shader blends by distance within the node's LOD band, so splits and
  merges slide instead of pop. The morph needs per-vertex camera distance and the node's band in
  the vertex hook. 0020's `vertex_position` hook gains `uv1` and `color` arguments for this (an
  additive change; 0020's spec is updated in the same change).

### GPU generation

- Render support: **GPU-only meshes**. `Mesh.gpu({ vertexCount, indexCount, attributes, bounds })`
  makes a `Mesh` whose buffers have `STORAGE | VERTEX` usage and no CPU copy. The terrain writes
  them from compute, and the renderer treats them like any mesh. All chunks share one index buffer
  (per resolution, skirts included).
- Per chunk, `terrain/generate` (a compute node, once per frame for all views) dispatches the
  planet's generated WGSL. For `(resolution + 2)²` points (one-vertex border for normals), it
  writes height, climate, and biome weights to a scratch buffer, then a second kernel writes
  positions, normals (central differences), tangents, morph deltas, and packed biome weights into
  the chunk's mesh. Normals match across neighbors because borders sample the same domain points.
- **Precision at any radius.** Chunk centers and tangent frames are computed on the CPU in f64 and
  passed to the kernel. Noise is sampled with 0041's origin offsets, with the origin at the chunk
  center. A vertex's position relative to the chunk center is `dir(u, v) × (R + h) − center`, which
  cancels catastrophically in f32 at Earth radius. The kernel computes that one expression in
  two-float (hi + lo f32) arithmetic, about 20 extra ALU ops per vertex, so vertices are
  sub-millimetre on any planet.
- The chunk's geometric error, min/max height, and bounds are read back once per chunk, a few
  frames later (no stall), to feed selection. Until then, conservative bounds from the parent are
  used.
- Budget: `TerrainBudget { chunksPerFrame: 8, msPerFrame: 1.5 }` (GPU time measured by timestamp
  queries where available). Jobs are prioritized by projected error, then by distance.
- Chunk meshes are pooled per planet (default 2 048 slots) and evicted LRU among nodes not
  selected. Regenerating an evicted chunk is deterministic, so eviction is invisible.

### CPU heights and colliders

- `planetHeightAt(world, planet, direction, out?)` samples the height graph on the CPU (0041,
  sync) and returns metres above radius. It powers placement, gameplay queries, and headless tests.
- Collider chunks are generated on the worker pool at `colliderDepth` (default: the depth whose
  spacing is ≤ 1 m) for nodes within `colliderRadius` of any `TerrainAnchor`. Each becomes a
  fixed-body child entity with a `trimesh` collider in the chunk frame. They're cached in an LRU
  of 256 chunks and keyed by `(planet key, node key)`, so walking back and forth doesn't regenerate.
- **What you see is what you stand on.** GPU and CPU heights agree only within 0041's tolerance,
  which grows with `heightScale` (a few centimetres for Earth-like relief). So chunks that have a
  collider render from the collider's CPU vertices (uploaded once into the chunk's mesh) instead of
  the GPU ones. Only distant chunks use GPU heights, and there the difference is sub-pixel.
- Headless (no GPU), selection runs for anchors only and produces collider chunks. The render path
  is skipped, and the world hash is identical to a run with a GPU.
- The character controller (0029) works as is: `GravitySource` on the planet provides up, and
  colliders are ordinary trimeshes.

### Biomes and texturing

- Texture arrays arrive in `@shard/texture`: `Texture.create({ …, layers: n })` and a
  `TextureArray` importer (`*.texarray.json` listing files, all resized to one size and format).
  0016 deferred this to M7.
- Per vertex, the generation kernel computes biome weights from climate, height, slope, and
  latitude (a `smoothstep` window per biome range, with `blend` as the softness). It keeps the top
  four biomes and writes their indices and weights into the vertex (`color` holds weights and
  `joints` holds indices). A `BiomeSet` has at most 32 biomes, and each has up to 4 layers.
- The `terrain/Planet` material extends `standard`. Its `pbr_input` hook samples each of the four
  biomes' layers from one albedo, one normal, and one ORM texture array, triplanar in chunk-local
  space with height-based blending. Distant chunks (by LOD depth) switch to one sample per biome
  at a coarser scale, so orbit views don't shimmer.
- Materials can still be replaced: `Planet.material` takes any material that extends
  `terrain/Planet`, so a project can add lava glow or ice sparkle.

### Ocean

- If `seaLevel` isn't NaN, a second quadtree at `radius + seaLevel` uses the same selection and
  a flat (height 0) generation kernel. It renders through a `terrain/Ocean` material: transparent,
  forward, with scrolling normal maps, depth-based absorption against the terrain depth, and
  Fresnel reflection of the environment.
- `planetSurfaceAt` reports `{ height, underwater, depth }` for gameplay. Swimming and buoyancy are
  game code.

### Navigation

- `PlanetNav { agentRadius, agentHeight, maxSlope, radius: f32 = 150 }` on a planet bakes
  `NavMesh` tiles for collider chunks within `radius` of any `NavAgent`, one tile per chunk, in the
  chunk's tangent frame (up = radial at the chunk center).
- 0037 gains a `frame` field on `NavMesh`: bake and query in that entity's local space. Paths
  crossing chunk boundaries join tiles through Detour's tile links, since neighboring chunk frames
  differ by less than a degree at bake depth.

### Agent surface

- `terrain.describe { planet }` returns selected node counts by depth, chunks in flight, pool
  usage, GPU time per frame, collider chunks, and the biome under the camera.
- `terrain.sample { planet, directions | latlon }` returns height, biome weights, slope, and
  underwater, from the CPU path, headless-safe.
- `debug.overlays` gains `terrain-lod` (chunk edges colored by depth), `terrain-biomes` (dominant
  biome color), and `terrain-colliders`.
- `procgen.preview` of a planet generator (0046) renders it from orbit, and `terrain.map { planet,
  size }` returns an equirectangular PNG of height or biomes, so an agent can check "are there
  oceans and poles" in one image.
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
- **Skirts plus geomorphing instead of stitched index buffers.** One shared index buffer per
  resolution, no per-neighbor variants, and smooth transitions.
- **Offsets and two-float math instead of a radius cap.** The only f32 cancellation left is one
  expression per vertex, and fixing it costs a few ALU ops. That's cheaper than restricting the
  planets a game can have.
- **Tangent-adjusted cube mapping.** Nearly uniform chunk sizes with cheap forward and inverse
  mapping, which both kernels and gameplay queries use.

## Acceptance criteria

- [ ] A 4 km planet renders from 20 000 km away (six root chunks) down to standing on the surface.
      A scripted descent at 500 m/s never shows a hole (frame-by-frame hole detection against the
      sky color in a test render).
- [ ] The same holds for an Earth-radius planet (6 371 km) descending from 40 000 km to the surface
      in 120 s, and for a 16 000 km super-Earth. The visible chunk count at 2 m altitude is within
      2× of the 4 km planet's.
- [ ] On the Earth-radius planet, standing still on the surface, vertices show no jitter (screen
      position stable to 0.01 px over 600 frames), and a 0.5 m noise octave renders as smooth
      bumps, not steps (golden).
- [ ] No cracks: a render with skirts disabled and a debug seam shader shows zero seam pixels at
      2:1 boundaries in five golden views.
- [ ] Geomorphing: during a descent, no vertex's screen position jumps by more than 1 px between
      frames beyond camera motion.
- [ ] CPU `planetHeightAt` and the GPU chunk heights agree within 0041's tolerance times
      `heightScale` at 10 000 random points. Collider chunks render exactly the collider's vertices,
      so a character's feet are within 1 cm of the visible ground on the Earth-radius planet.
- [ ] A character dropped at 20 random points walks 100 m in a straight line headless without
      falling through, and the world hash matches across Node and Chrome.
- [ ] Generation stays within `TerrainBudget` in the bench, and with the default settings a
      descent keeps frame time under 16.6 ms on the reference GPU.
- [ ] A planet with an ocean shows water where `terrain.sample` reports underwater, and the
      `terrain.map` golden shows continents, poles (snow biome), and sea.
- [ ] A `NavAgent` on the surface paths 120 m across at least three chunk tiles.
- [ ] Editing the height graph in `shard dev` regenerates visible chunks within 1 s without
      holes, and colliders update too.

## Open questions

- Should chunk generation use the pool's CPU path on hosts with a weak GPU? Proposed: no. The GPU
  path is required for rendering; the CPU path exists for colliders and headless runs.
- None blocking. Deferred: runtime deformation, voxel caves, flat terrain, and horizon-based
  occlusion of props behind mountains (0045 may need it).
