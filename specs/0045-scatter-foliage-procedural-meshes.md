# 0045 — Scatter, foliage, and procedural meshes

- **Status:** implemented
- **Packages:** `@aethervtt/shard-scatter` (new), `@aethervtt/shard-procgen`, `@aethervtt/shard-mesh`,
  `@aethervtt/shard-terrain`, `@aethervtt/shard-render`
- **Depends on:** 0020, 0022, 0030, 0031, 0041, 0042, 0043

## Context

A planet from 0043 is bare rock with textured biomes. Walking on it needs rocks, trees, bushes,
crystals, and grass, placed by rule and not by hand, and in two very different quantities. There
are a few thousand props near the player, which you can bump into and scan, and millions of grass
blades and flowers that only have to look right.

Props are ordinary entities. The instancing and culling from 0022 handles tens of thousands, and
they need colliders and gameplay components. Grass can't be entities at a million per view, so it
is GPU-only instances placed by compute per terrain chunk, drawn indirectly, and never seen by the
ECS.

The shapes themselves come from generators (0042). This spec grows the mesh builder into a small
procedural modelling toolkit and ships engine generators for the common kinds: rocks, trees,
bushes, grass, and crystals. It also adds automatic LODs through meshoptimizer.

## Goals

- `ScatterSet` data assets: rules that place prefabs or generated meshes by density, spacing,
  masks (biome, height, slope, noise), alignment, and random transform ranges.
- **Props:** deterministic CPU placement per terrain chunk, spawning instanced entities (with
  optional colliders) as chunks come near, and despawning as they leave.
- **Foliage:** GPU placement per chunk into GPU-only instance buffers, with frustum and distance
  culling in compute, wind sway, and distance fade. No entities.
- Placement works on any surface. Planets (0043) are the main target, and a `ScatterSurface` on a
  mesh entity uses the same rules on a flat level.
- Mesh toolkit: builder, normals and tangents, icosphere, noise displacement, extrude, lathe, tube
  along a curve, a branching tree skeleton, leaf cards, merge, and `simplify` for LODs.
- Engine generators: `shard/Rock`, `shard/Tree`, `shard/Bush`, `shard/GrassClump`, and
  `shard/Crystal`, each with a handful of params and good-looking defaults.
- Seed-stable: the same planet seed puts the same tree in the same place on every visit and
  every machine.

## Non-goals

- Hand-painted scatter or density maps (a later Studio tool; density comes from rules).
- Hi-Z occlusion culling (0022 deferred it to M7). It's out unless the acceptance benches here
  need it; horizon culling from 0043 plus distance ranges cover planets. It would be its own spec.
- L-systems and space-colonization trees (later generators on the same toolkit).
- Physically simulated foliage (bending from the player, cut trees). Sway is a shader effect.
- Imposters/billboards for trees beyond the last LOD (open question).

## Design

### Scatter rules

```json
{
  "$schema": "../../.shard/schemas/scatter.schema.json",
  "rules": [
    {
      "name": "boulders",
      "kind": "prop",
      "items": [
        { "prefab": { "path": "prefabs/boulder.prefab.json" }, "weight": 1 },
        { "generator": "shard/Rock", "params": { "radius": 1.5, "roughness": 0.5 },
          "variants": 6, "material": { "path": "materials/rock.material.json" }, "weight": 3 }
      ],
      "density": 0.004,
      "spacing": 6,
      "masks": { "slope": [0, 35], "height": [2, 400], "noise": { "graph": { "path": "noise/patches.noise.json" }, "above": 0.2 } },
      "align": 0.6,
      "scale": [0.6, 1.8],
      "sink": 0.2,
      "collider": "convex",
      "range": 400
    },
    {
      "name": "grass",
      "kind": "foliage",
      "items": [{ "generator": "shard/GrassClump", "params": { "blades": 12 }, "variants": 4 }],
      "density": 6,
      "masks": { "slope": [0, 25] },
      "wind": 1,
      "range": 60
    }
  ]
}
```

- `ScatterSet` is a data type (0031). Biomes (0043) reference one each, so a rule applies where its
  biome's weight is dominant, and the rule's own `masks` refine that. A top-level
  `Planet.scatter` set applies everywhere.
- Rule kinds are `prop` and `foliage` here. 0048 adds `creature` for spawning fauna on the same
  lattice.
- `density` is per m², `spacing` is the minimum distance between items of the rule, `align`
  blends between world-up (radial) and the surface normal, `sink` pushes items into the ground by a
  fraction of their height, and `range` is the distance from the camera at which the rule's items
  exist.
- `items` pick by weight. A generator item with `variants: n` generates n meshes, with seeds
  `childSeed(i)` of the rule's seed, and each placement picks one. Six rock shapes cover a planet
  without generating a mesh per rock.
- Rule order is priority. `"avoid": ["boulders"]` keeps grass out of a boulder's footprint (by
  the placed item's radius).

### Placement

- Placement is per quadtree node at a fixed **scatter depth** per rule: props pick the depth whose
  chunks hold about 256 items (64–1 024); foliage uses the collider depth, deeper only if a chunk
  would hold more than one dispatch places (16 384).
- Candidates come from a jittered lattice on each cube face, aligned to the chunks, so it's
  global: a cell is `max(1/√(2·density), spacing/0.6)` metres, every cell's random numbers are
  `hash32(ruleSeed, cellX, cellY, face, stream)` (the GPU computes the same ones), and its item
  sits in the middle `1 − spacing/cell` of the cell, so neighbors are always `spacing` apart. A cell
  is accepted with chance `density × cell area`, the area measured per chunk (cube-sphere cells
  aren't square). A density the spacing can't fit is `scatter/density-too-high`, naming the most
  that fits. Order-independent and seamless across chunks; where two faces meet, the lattices
  don't, so `spacing` holds within a face.
- Height, normal, slope, and biome weights at each prop candidate come from the CPU kernel (0041,
  canonical; on the pool, finished inline at a fixed due frame like collider chunks).
- The output per prop is item, variant, position, rotation, scale, cell index (its stable id),
  footprint radius and shade, in the chunk frame, cached per (rules version, rule, chunk) in an
  LRU. `avoid` drops candidates inside the avoided rule's items' footprints, from that rule's
  chunks around this one (placed first, on the pool).

### Props

- When a prop chunk comes within `range` of the camera or a `TerrainAnchor`, its placements
  spawn under a `scatter/Chunk { surface, rule, chunk }` entity (a child of the planet with a
  `GridCell`, at the chunk's center): a prefab instance, or `Mesh3d` + `MeshMaterial` + `Lod` +
  `VisibilityRange` for generator items, plus a collider when `collider` is set (`convex` from the
  coarsest LOD, `trimesh`, `ball`, `cuboid`). Spawning is budgeted (`ScatterBudget.propsPerFrame =
  250`: each prop costs a few microseconds with its LODs and collider, and 250 keep a frame under
  1 ms), nearest first, and a chunk with more spawns over several frames, in a fixed order, so
  which frame a prop appears on depends only on frames. Chunks despawn past 1.15 × `range`.
- Spawned props are `procgen/Generated`, `core/Derived`, and `scatter/Prop { index }`, where `index`
  is the placement's stable id within its chunk (the parent `scatter/Chunk` names the rule and
  chunk; `propIdentity` reads all three). Saves (0038) record only changes: a prop the game
  despawns is recorded in the persisted `scatter/Removed` resource as `"rule|chunk|index"` and
  stays gone when its chunk spawns again.
- Distance ranges come from 0022's `VisibilityRange`, and LODs are the generator's LOD meshes.

### Foliage

- A render-side **GPU instance layer** (`foliagePlugin`, part of `forwardPlugin`): a
  `FoliageLayer` per foliage rule, holding its variant meshes (and their LODs) and one material.
  Each has a storage buffer of compact 16 B instances, one per lattice cell of each chunk slot:
  position as unorm16×3 over the chunk's bounds (sub-millimetre), mesh, octahedral up, yaw, scale,
  shade and a thinning rank. Chunk slots index a buffer of chunk-to-world rows, which scatter writes
  each frame from the surface's frame (origin-relative), so origin shifts (0040) cost one small
  upload. The core renderer only holds a `FoliagePath` hook its opaque, G-buffer and cascade
  passes call.
- A foliage chunk's ground is a patch: the chunk's own vertex grid as terrain builds it at the
  collider depth (on the pool, the same numbers as a collider chunk, so grass stands on the drawn
  ground), with the rule's density per vertex (masks and biome on the CPU). The placement compute
  pass hashes each cell as the CPU would, interpolates the patch's triangles (split like the
  ground's), and writes the cell's instance, or none. Render chunks at other depths aren't
  involved, and nothing runs on the CPU per instance.
- Per camera, culling runs in three compute passes: classify (frustum, `range`, thinning, LOD by
  distance), a prefix sum of the counts, and a scatter into each drawable's range of one visible
  list (so memory is one entry per instance, whatever the mesh count). Thinning drops instances by
  rank past half the range (down to 30% at its end), widening the survivors and shrinking the last
  12% to nothing, so the edge fades. Lower levels of detail (`shard/GrassClump`'s: fewer, wider
  blades at 2 segments, then single triangles) draw from 0.3 and 0.6 of the range.
- The draw uses 0020 materials through foliage roots (forward, G-buffer, shadow) whose vertex stage
  decodes the instance and runs `shard::mesh::mesh_vertex`, so the material's `vertex_position` and
  `vertex_extra` hooks apply; `vertex_instance_data()` gives (fade, shade). Back faces flip their
  normal. Engine generator items default to `scatter/Vegetation`, a standard material tinted by
  the generators' part codes, whose vertex hook adds wind from the `scatter/Wind { direction,
  strength, gustScale }` resource (0049 replaces it), weighted by the vertex's height in the
  blade. Foliage casts only into the nearest cascade, within `shadowRange` (default 30 m) and that
  cascade's split; that cascade redraws every frame while foliage sways. It doesn't draw in the
  depth prepass or picking (TAA's motion vectors and SSAO skip it).

### Mesh toolkit (`@aethervtt/shard-mesh`)

```ts
const b = MeshBuilder.create()               // ctx.mesh.create() in a generator
b.icosphere(3)                              // or box, cylinder, lathe(profile), tube(curve, r)
b.displace((p, n) => noise(p) * 0.3)        // along normals, sync
b.displaceNoise((pts, out) => ctx.noise.sample(graph, seed, pts, out), 0.3)  // one batch
b.extrude(faceSet, distance)
b.merge(other, transform)                   // a builder or MeshData, a column-major 4×4
b.weld(epsilon); b.normals({ angle: 40 }); b.tangents(); b.uvsTriplanar(scale)
const mesh = b.finish()                     // MeshData
await loadMeshSimplifier()                  // once per thread; generator jobs do it for you
const lods = simplifyLods(mesh, [0.5, 0.2, 0.05])   // meshoptimizer, WASM
```

- The builder stores data in growable f64 TypedArrays (no per-vertex objects) and uses only
  + − × ÷ and sqrt, with trig through `sinCos` (a polynomial), so a mesh is the same bytes in every
  JavaScript engine. `uv1(i, u, v)` sets a second uv set. `displace` with a callback is for
  generator code, which runs off the main thread (0042); `displaceNoise` takes a batch sampler.
- `simplifyLods` uses meshoptimizer's attribute-aware simplifier (the npm `meshoptimizer`
  package's WASM, loaded with `import()`). Levels keep a subset of the source's vertices, so UVs,
  normals and seams are the source's; if seams stop it short of the target, it retries
  permissive, then sloppy. `ctx.mesh.finish(mesh, { lods })` calls it, and generators may also
  return their own LOD meshes.
- `treeSkeleton({ trunk, branches, levels, spread, gravity, seed, … })` builds a recursive branch
  graph, `tubeAlong` skins it, and `leafCards` places two-sided cards along chosen levels: quads
  with UVs into a leaf atlas, or pointed leaf shapes that need no texture (the default).

### Engine generators

| Generator | Output | Key params |
|---|---|---|
| `shard/Rock` | mesh + LODs | radius, roughness, flatness, facets, detail |
| `shard/Tree` | mesh + LODs | height, trunkRadius, levels, branching, spread, leafDensity, leafSize |
| `shard/Bush` | mesh + LODs | radius, stems, leafDensity |
| `shard/GrassClump` | mesh + LODs | blades, height, width, bend, spread |
| `shard/Crystal` | mesh + LODs | count, length, radius, spread, sides |

Each ships with preview goldens at nine seeds and default params that look good without tuning.
Every mesh stands on its origin and writes a part code in its second uv set (x: 0 bark, stone or
root to 1 leaf or tip; y: a shade), which `scatter/Vegetation` tints by.

### Agent surface

- `.shard/schemas/scatter.schema.json`, with each mask and field documented with typical values
  ("grass: density 4–10/m², range 40–80 m").
- `scatter.describe { surface? }` returns, per surface and rule: chunks in range, placements,
  spawned props, lattice candidates, foliage chunks and instances visible and casting, props
  spawned and despawned last frame, and main-thread time.
- `scatter.sample { surface, position | entity | latlon, radius }` lists prop placements near a
  point (rule, item, variant, position, distance, scale, chunk, index, removed) from the CPU path,
  headless-safe, spawned or not. An agent can ask "what's within 10 m of the landing pad" and move
  the pad. Foliage is GPU-only and not listed.
- `procgen.preview` (and `asset.preview`) of a `*.scatter.json` renders it on a 64 m × 64 m flat
  patch, from above and at eye level, side by side.
- `debug.overlays` gains `scatter` (placement dots colored by rule) and `foliage-chunks`.
- MCP tools: `describe_scatter`, `sample_scatter`.
- **Errors:** `scatter/unknown-rule` (in `avoid`), `scatter/density-too-high` (more than the
  spacing can fit), `scatter/item-not-mesh` (an item without a mesh generator or prefab, a
  generator whose output isn't a mesh, or a prefab in a foliage rule), `scatter/duplicate-rule`,
  `scatter/no-items`.

## Decisions

- **Two tiers: entities for props, GPU instances for foliage.** Props need colliders, saves,
  and gameplay. Foliage needs volume. One path can't serve a thousand interactive rocks and a
  million grass blades well.
- **A global jittered lattice, not per-chunk Poisson sampling.** It's deterministic,
  order-independent, and seam-free, and a chunk can be placed in isolation on any worker.
- **Variants instead of a mesh per placement.** A few generated shapes per rule keep memory and
  instancing batches small, and random transforms make them read as unique.
- **meshoptimizer for LODs.** It's the standard, it ships as WASM, and it preserves attribute seams.
  Writing a simplifier isn't where the engine's value is.
- **Removed props are saved as ids, not entities.** Regenerated chunks stay light and a save stays
  small, however far the player has explored.

## Acceptance criteria

- [x] The example planet with three biome scatter sets shows rocks, trees, and grass in the right
      biomes (golden from five fixed viewpoints). Restarting or running on another host places them
      identically (placement hash match).
- [x] Placement is seamless: across 100 chunk borders, the minimum distance between items of one
      rule is ≥ `spacing` and density within 10% of the target.
- [x] Walking 1 km on a planet keeps prop spawn and despawn under 1 ms per frame of main-thread
      time, and ≥ 20 000 props are live within range with frame time under 16.6 ms (budget
      `scatter/props-frame`). (Measured on the laptop, not yet on the desktop.)
- [ ] Foliage draws ≥ 2M blades per view within 60 m within budget `gpu:foliage` (3 ms on the
      desktop), with no per-instance CPU work (profiler shows zero CPU time in foliage per frame
      beyond dispatch). The count and the CPU side pass. The GPU time is unmeasured on the desktop,
      and the laptop takes about 18 ms (the note on `gpu:foliage` in `bench/perf/budgets.json`).
      0075 part B replaces the number with foliage holding its `scatter-walk` slice.
- [x] A destroyed prop stays destroyed after walking away far enough to unload its chunk, walking
      back, and after save/load.
- [x] Each engine generator's nine-seed contact sheet matches its golden, and every LOD has ≤ the
      requested triangle fraction (±10%) with no UV seam cracks.
- [x] A `ScatterSurface` on a flat plane mesh with the same `ScatterSet` places props and foliage.

## As built

- Tests: `packages/scatter/src/*.test.ts`. The lattice test places a 10 × 10 block of chunks and
  checks the least distance and the density; `props.test.ts` covers spawning, `avoid`, despawning,
  removed props through a walk and a save, and a `ScatterSurface`; `foliage.test.ts` draws GPU grass
  on a `ScatterSurface` that keeps off the boulders; `planet-render.test.ts` renders the test planet
  (20 km, three biomes with their own sets) from five viewpoints against goldens;
  `checksum.test.ts` pins the placement checksum (`9acc927a`), the same inline and on the pool, and
  the playground's `#scatter` page shows Chrome's next to it (they match).
  `bench.test.ts` walks 1 km at 6 m/s (spawn and despawn at most 1 ms a frame, GC pauses taken
  out), keeps 20 000+ props live under 16.6 ms, and counts 2.2M blades in view with the scatter
  system's CPU time flat. Render's `foliage.test.ts` places, draws (forward and deferred) and
  removes a layer. Mesh: `builder.test.ts`; procgen: `engine/engine.test.ts` and the contact sheet
  goldens in `engine/sheets.test.ts`.
- Measured on an Apple M4 (Metal Dawn): a 1 km walk's worst frame of spawning is under 1 ms at
  250 props a frame (each prop costs about 3.5 µs with LODs and a collider); grass at 2.2M blades
  costs about 18 ms of GPU, half vertex work and half shading, after LODs and nearest-cascade
  shadows took it down from 70 ms.
- Example: star-explorer's grass, forest and rock biomes scatter `assets/scatter/*.scatter.json`,
  and `tests/scatter.test.ts` checks them headless.
- Deferred: the translucency term (the standard lighting has no transmission input; back faces
  flip their normal instead), foliage in the depth prepass and picking, and imposters.

## Open questions

- Tree imposters beyond the last LOD: octahedral imposters baked per variant would let forests
  reach the horizon. Proposed: defer until the planet demo shows the tree `range` popping.
- None blocking. Deferred: Hi-Z occlusion, player-interactive foliage bending, and scatter density
  painting.
