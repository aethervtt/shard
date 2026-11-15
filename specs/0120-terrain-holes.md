# 0120 — Terrain holes

- **Status:** draft (built 2026-11-15). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-terrain`, `@aethervtt/shard-scatter`
- **Depends on:** 0071, 0119

## Context

A house with a basement sits on a pad, and its basement is inside the ground: you walk down the
stairs into a room below the terrain's surface. The ground over the footprint has to be open, in
what's drawn and in what's solid. 0071 reserved a hole bit in its control pages for cave mouths and
nothing reads it. Risen's spec 0009 needs it for walkout basements ("a basement's footprint is a
hole in the terrain, its surface and its collider"), from the same generator that grades the pad
(0119), so the hole and the pad can't disagree.

## Goals

- A terrain generator (0119) may give `holes`: whether the ground is open at a point. A source
  opts in with `"holes": { "generator": "risen/Ground" }`.
- Open cells don't draw (forward, depth prepass and shadows) and aren't solid: a character walks
  through the hole onto whatever is below, and a NavAgent's navmesh has a gap there.
- Holes at leaf-cell resolution with the default paint spacing (1 m cells at 1 m spacing).
- Height queries, ray casts and scatter know about holes.

## Non-goals

- Holes from images, splines or edits. A source names one generator; more kinds can join the same
  bits later.
- Holes on coarse levels. Past the leaves' distance a basement is under its house anyway; parents
  draw closed.
- Caves and overhangs (the ground under a hole is whatever the game builds).

## Design

### The mask

```ts
defineTerrainGenerator('risen/Ground', {
  …,
  // 1 where the ground is open at the area's samples (cell centres), row by row.
  holes: (plan, area, out: Uint8Array) => { … },
})
```

```json
{ "holes": { "generator": "risen/Ground" } }
```

- `params` defaults to the height layer's naming the same generator, as paint entries do (0119).
- The control page's fourth byte (0071's hole bit) becomes a 2 × 2 quadrant mask of the texel's
  cells: texel (a, b) owns leaf cells [a·k, a·k + k) × [b·k, b·k + k), where k is leaf samples per
  paint texel, and bit `2·qz + qx` says its quadrant is open. With the default k = 2 that's one bit
  per cell; with k = 1 bit 0 is the one cell; with k = 4 each bit is 2 × 2 cells.
- The bake asks the generator once per page for every quadrant's centre, in the same pass as the
  control texels (`evalControl`), so ahead blocks, near leaves (0119), inline leaves and 0104's
  patched leaves all write the same bytes. Parent pages carry no holes.

### Drawing

- A terrain whose source has holes draws with the `mask` blend mode, and its surface stage gives
  alpha 0 over an open cell of a leaf page. The standard forward pass, the depth prepass and the
  masked shadow pipeline then all discard there; terrains without holes stay opaque (no cost).
- Geomorphing doesn't move a hole: an anchored leaf is drawn exactly, and holes exist only where a
  leaf is drawn.

### Colliders and navigation

- Rapier's JavaScript heightfield has no per-cell removal, so a collider tile whose page has an
  open cell becomes a `trimesh`: the leaf's 65 × 65 vertices and two triangles per closed cell, split
  along the same diagonal as the heightfield, so the closed ground is exactly the heightfield's.
  Tiles without holes stay heightfields. The trimesh is a `Mesh` asset owned by the tile.
- `NavSource` reads the trimesh like any other, so the navmesh has the hole.

### Queries

- `terrainHeightAt` adds `open` (the leaf page's cell is open; `false` from a coarse page).
- `terrainRaycast` passes through open cells.
- Scatter's heightfield surface places nothing on an open cell.

### Agent surface

- `terrain.describe` counts collider tiles with holes (`colliders.withHoles`).
- `terrain.sample` gains `open` per point.
- **Errors:** `terrain/bad-generator` (a generator listed as `holes` without a `holes` function),
  `terrain/bad-generator-output` (a mask value other than 0 or 1).

## Decisions

- **Quadrant bits in the existing byte** rather than a new page plane: no format change for
  terrains without holes, and per-cell resolution at the default paint spacing.
- **Trimesh tiles only where needed.** Heightfields stay the fast path; a tile with a basement is
  a few per town.
- **The generator's mask, not a list of footprints.** The pad and the hole come from the same plan,
  so a grading change can't leave a hole beside its house.

## Acceptance criteria

- [x] A 10 × 8 m footprint opens exactly its cells in every leaf over it, the same bytes ahead,
      near and inline, and nothing outside it.
- [x] A character standing over the footprint falls through it onto a floor 3 m below; one beside it
      stands on the ground, within 1 cm of the heightfield's surface.
- [x] A NavAgent's path across the terrain goes around the hole.
- [x] A golden view of the hole shows the floor below through it, on WebGPU and on the baseline tier.
- [x] `terrainHeightAt` and `terrain.sample` report `open` over the hole, and no scatter item lands
      in it.

## As built

- **Bits**: `evalControl` asks the generator once per call for every quadrant centre of the leaf
  lattice's texels (`k > 1`: 2 × 2 a texel; `k = 1`: one) and packs them into byte 3. Parent
  pages, ahead (`bakeBlock`, `parentPage`) and near (`bakeParent`), write 0 there. `cellOpen` and
  `pageHasHoles` (kernel.js) read them; the shader does the same arithmetic.
- **Drawing**: `alphaMode` is `mask` (cutoff 0.5) only when the source has `holes`; `maps` carries
  the leaf depth, holes on, and leaf samples per texel. The surface stage sets alpha without an
  early return: a `return` in that branch put the texture sampling after it in non-uniform control
  flow, and the pipeline failed to build, so the whole terrain stopped drawing. Caught by
  rendering a close view on `main` and on the branch side by side.
- **Colliders**: a page with any hole bit becomes a trimesh tile (a `Mesh` in `render/Meshes`,
  dropped with the tile); `TileSet.withHoles` counts them (`terrain.describe`'s
  `colliders.withHoles`).
- **Queries**: `pageOpen(rt, page, x, z)`, `TerrainHeight.open`, `HeightfieldSample.open`,
  `terrain.sample`'s `open`; `terrainRaycast` skips open cells; scatter's `HeightfieldIndex.heightAt`
  returns false over one.
- **Tests**: heightfield/holes.test.ts (80 open cells for the 10 × 8 m footprint, nothing else, the
  same control bytes ahead and near, parents clear; a character falls through onto a floor at 107 m
  and one beside the hole stands within 1 cm of one on the same ground without holes; a path from
  one side to the other stays out of the footprint; `terrain.sample`; the golden `holes-full` on
  WebGPU and Dawn's compatibility mode, mean under 1.5), scatter/src/fields.test.ts (no ground for
  scatter over the hole).

## Open questions

- None.
