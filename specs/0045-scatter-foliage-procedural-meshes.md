# 0045 — Scatter, foliage, and procedural meshes

- **Status:** accepted
- **Packages:** `@shard/procgen`, `@shard/mesh`, `@shard/terrain`, `@shard/render`
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

- Placement is per terrain chunk at a fixed **scatter depth** per rule, chosen so a chunk holds
  about 64–1 024 items. Every chunk key at that depth gets a seed of
  `hashSeed(planetSeed, chunkKey, ruleIndex)`.
- Candidates come from a jittered grid in chunk space with cell size `spacing` (at least one cell
  per `1/density` m²). The cell's hash gives its jitter and acceptance roll against density and
  masks. This is blue-noise-like, order-independent, and seamless across chunks, because cells are
  on a global lattice of the face and not per chunk.
- Height, normal, slope, and biome weights at each candidate come from the CPU kernel for props
  (0041, canonical, on the pool) and from the chunk's GPU data for foliage.
- The output per prop is `(itemIndex, position, rotation, scale)` in the chunk frame, cached per
  `(set hash, chunk key)` in an LRU like collider chunks.

### Props

- When a prop chunk comes within `range` of the camera or a `TerrainAnchor`, its placements
  spawn as children of the terrain chunk entity: a prefab instance, or `Mesh3d` + `MeshMaterial`
  + `Lod` for generator items, plus a collider when `collider` is set. Spawning is budgeted
  (`ScatterBudget.propsPerFrame = 2 000`) and prioritized by distance.
- Spawned props are marked `procgen/Generated` and `scatter/Prop { rule, index }`, where `index` is
  the placement's stable id within its chunk. Saves (0038) record only changes: a prop the player
  destroyed is saved as `removed: [chunkKey, rule, index]` and stays gone when its chunk
  regenerates.
- Distance ranges come from 0022's `VisibilityRange`, and LODs are the generator's LOD meshes.

### Foliage

- A render-side **GPU instance layer**: `FoliageLayer` resources owned by the renderer, one per
  (mesh, material). Each has a storage buffer of compact 16 B instances: position as unorm16×3
  over the chunk's bounds (sub-millimetre), a chunk slot, packed yaw and tilt, scale, and color
  variation. There's also an indirect-args buffer. Chunk slots index a per-frame buffer of chunk
  matrices (origin-relative, from the terrain chunk entities' `GlobalTransform`), so origin
  shifts (0040) cost one small upload.
- When a terrain chunk at foliage depth becomes visible within `range`, a compute pass places its
  candidates from the chunk's GPU heights and biome weights and appends them to the layer through a
  per-chunk slot range. Chunks leaving range free their range. There's no CPU involvement per
  instance.
- Per view, a culling compute pass does a frustum and distance test and writes the visible list plus
  indirect args. It also computes density thinning with distance (fewer blades farther out, each
  one wider), so the far edge of `range` fades instead of ending in a line.
- The draw uses 0020 materials through a foliage vertex entry point that decodes the instance and
  then runs the material's `vertex_position` hook. The foliage material template extends `standard`.
  Its vertex hook adds wind: a global `Wind { direction, strength, gustScale }` resource (0049
  replaces it with a view of the planet's wind field) sampled
  from 2D noise, weighted by vertex height in the blade. It shades two-sided and alpha-tested, with
  a translucency term. Foliage renders in shadows only within `shadowRange` (default 30 m).

### Mesh toolkit (`@shard/mesh`)

```ts
const b = MeshBuilder.create()
b.icosphere(3)                              // or box, cylinder, lathe(profile), tube(curve, r)
b.displace((p, n) => noise.sample(p) * 0.3) // along normals, sync; or displaceNoise(graph, seed, amt)
b.extrude(faceSet, distance)
b.merge(other, transform)
b.weld(epsilon); b.normals({ angle: 40 }); b.tangents(); b.uvsTriplanar(scale)
const mesh = b.finish()                     // MeshData
const lods = simplifyLods(mesh, [0.5, 0.2, 0.05])   // meshoptimizer, WASM
```

- The builder stores data in growable TypedArrays (no per-vertex objects). `displace` with a
  callback is for generator code, which runs off the main thread (0042), and `displaceNoise` uses the
  batch kernel.
- `simplifyLods` uses meshoptimizer's simplifier (the npm `meshoptimizer` package's WASM), which
  keeps UV seams and borders. `ctx.mesh.finish(mesh, { lods })` in 0042 calls it.
- `treeSkeleton({ trunk, branches, levels, gravity, seed })` builds a recursive branch graph, and
  `tubeAlong` skins it. Leaf cards are quads placed along the last branch level, with UVs into a
  leaf atlas.

### Engine generators

| Generator | Output | Key params |
|---|---|---|
| `shard/Rock` | mesh + LODs | radius, roughness, flatness, facets, detail |
| `shard/Tree` | mesh + LODs | height, trunkRadius, levels, branching, spread, leafDensity, leafSize |
| `shard/Bush` | mesh + LODs | radius, stems, leafDensity |
| `shard/GrassClump` | mesh | blades, height, width, bend, spread |
| `shard/Crystal` | mesh + LODs | count, length, radius, spread, sides |

Each ships with preview goldens at nine seeds and default params that look good without tuning.

### Agent surface

- `.shard/schemas/scatter.schema.json`, with each mask and field documented with typical values
  ("grass: density 4–10/m², range 40–80 m").
- `scatter.describe { planet? }` returns, per rule: placed counts in range, spawned props,
  foliage instances visible, and time spent.
- `scatter.sample { planet, position, radius }` lists placements near a point (rule, item, position)
  from the CPU path, headless-safe for props. An agent can ask "what's within 10 m of the landing
  pad" and move the pad.
- `procgen.preview` of a `ScatterSet` renders a 64 m × 64 m patch of a test surface (or a given
  planet location) from above and at eye level.
- `debug.overlays` gains `scatter` (placement dots colored by rule) and `foliage-chunks`.
- MCP tools: `describe_scatter`, `sample_scatter`.
- **Errors:** `scatter/unknown-rule` (in `avoid`), `scatter/density-too-high` (would exceed the
  per-chunk cap), `scatter/item-not-mesh` (a generator item whose output isn't a mesh).

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

- [ ] The example planet with three biome scatter sets shows rocks, trees, and grass in the right
      biomes (golden from five fixed viewpoints). Restarting or running on another host places them
      identically (placement hash match).
- [ ] Placement is seamless: across 100 chunk borders, the minimum distance between items of one
      rule is ≥ `spacing` and density within 10% of the target.
- [ ] Walking 1 km on a planet keeps prop spawn and despawn under 1 ms per frame of main-thread time,
      and ≥ 20 000 props are live within range with frame time under 16.6 ms on the reference GPU.
- [ ] Foliage draws ≥ 2M blades per view within 60 m at under 3 ms GPU (reference GPU), with no
      per-instance CPU work (profiler shows zero CPU time in foliage per frame beyond dispatch).
- [ ] A destroyed prop stays destroyed after walking away far enough to unload its chunk, walking
      back, and after save/load.
- [ ] Each engine generator's nine-seed contact sheet matches its golden, and every LOD has ≤ the
      requested triangle fraction (±10%) with no UV seam cracks.
- [ ] A `ScatterSurface` on a flat plane mesh with the same `ScatterSet` places props and foliage.

## Open questions

- Tree imposters beyond the last LOD: octahedral imposters baked per variant would let forests
  reach the horizon. Proposed: defer until the planet demo shows the tree `range` popping.
- None blocking. Deferred: Hi-Z occlusion, player-interactive foliage bending, and scatter density
  painting.
