# 0105 — Terrain layer normal maps

- **Status:** draft (built)
- **Packages:** `@aethervtt/shard-terrain`
- **Depends on:** 0071, 0016, 0043, 0064

## Context

0071's terrain material parses `textures.normal` and each layer's `normal` index, but never samples
them. Its shading normals are the pages': exact for the ground's shape, and empty below the sample
spacing. Up close a 0.5 m heightfield shades gravel and rock as flat colour. The 0071 code comment
gives the reason: on the baseline tier the material would bind a 17th texture, and a stage holds
16 (0064's floor; the forward pass and instancing take 10, the terrain the other 6).

## Goals

- Per-layer normal maps from `textures.normal` (a `*.texarray.json`), at each layer's `normal`
  index. They apply on top of the page normals, planar and triplanar, and blend between a texel's
  two layers by their share.
- Both tiers, inside 16 textures.
- A documented convention, and a check of the zoo's Megascans maps against it.

## Non-goals

- Parallax or displacement from height maps.
- Per-layer normal strength. A flatter map is an asset change.

## Design

### Room on the baseline tier

The material binds `pages`, `control`, `chunks`, `layerTable`, `albedoArray` and `ormArray`. The two
small tables, `chunks` and `layerTable`, merge into one `rgba16float` data texture, `table`:

- Row 0 holds the layer table: two texels per material layer, 64 texels for 32 layers.
- Rows from 1 hold one texel per pool slot. These are the chunk entries (locks, quadrant mask,
  fade × 255, depth and the anchored bit), stored as integer-valued halves.

That frees a slot for `normalArray`, so the material binds 6 textures again. The chunk table is
written through a byte→half lookup, with no allocation, whenever it changes. Packing normals into
the ORM array was the other option. It would need an import-time repack of two assets into one and
would drop metallic.

### Sampling

- Arrays are OpenGL convention (+Y toward the image's top), the engine's for every normal texture.
  `"normalMap": "directx"` on a `*.texarray.json` flips green at import (0043/0016). The zoo's six
  Megascans maps were measured against their displacement maps. Green correlates with the
  displacement's downward gradient at +0.53 to +0.73, which makes all six OpenGL, so leave
  `normalMap` unset or set it to `"opengl"`.
- Planar layers sample at `q.xz / scale`, the same coordinates as albedo. The map's +X is world +X,
  and its +Y is world −Z, because texture v grows with z.
- Triplanar layers sample the same three projections as their albedo (zy, xy, xz). Each tangent
  normal is combined with the page normal by whiteout blending, then weighted by the albedo's
  triplanar weights.
- The two layers' normals mix by the texel's share and are renormalized. The page normal is used
  alone without an array, with `HeightfieldDebug.normalMaps` off, or in debug views.
- Mips come from the importer's normal usage (renormalized per level), so far ground converges on
  the page normals.

## Decisions

- **Merge the two tables, not the normals into ORM.** It's the smaller change: two `textureLoad`
  reads change their decode, and no asset format moves.
- **Whiteout over UDN or reoriented normal mapping.** Detail stays visible on slopes, at the
  cost of a normalize per projection.
- **No per-layer strength.** Megascans maps are calibrated, and a strength field invites a slider
  per layer that nothing needs yet.

## Acceptance criteria

- [x] A flat normal map (128, 128, 255) renders the same as no normal map (within 1 level).
- [x] A map leaning +X is brighter under a sun from +X than from −X. A map leaning +Y (OpenGL) is
      brighter under a sun from −Z, on both tiers. On a triplanar cliff facing +X, +X red leans
      toward world +Z (its face's own axis).
- [x] The baseline tier renders with normal maps on and binds 16 textures (no GPU errors). The five
      golden views pass within 0064's tolerance with the merged table.
- [x] 0071's goldens, morph and crack tests pass unchanged with the merged table.
- [x] A close-up of a zoo layer with normal maps on and off, shown (As built). The frame cost of the
      extra samples was not isolated (see As built).

## As built

- **The table** is `TerrainSurface.table`: `rgba16float`, 1024 texels a row, row 0 the layer table
  and rows from 1 the chunk table. Its CPU side keeps the chunk bytes, plus the layer row as halves,
  and writes both through a byte→half lookup when either changes.
- **Sampling** is in `sample_layer` (material.ts): `layer_tangent` flips y for the projection, then
  whiteout blending per projection. `TerrainSurface.maps.x` turns it on: the source has a normal
  array, `HeightfieldDebug.normalMaps` is on, and no debug view is showing.
- **Tests:** normals.test.ts. The orientation tests fail with normal maps off (119.0 against 118.7),
  so they test the maps and not the lighting.
- **The zoo** builds `normal.texarray.json` from its Megascans `*_Normal.jpg` in its own
  `build.py` (1024², `"normalMap": "opengl"`; the convention check also holds on the built maps).
  The close-up is of the rocky sand on a pond floor.
- **Cost:** in the zoo, at the default builder views, the game stayed at vsync (60 fps) on the M5
  Max with normal maps on. The extra samples weren't timed alone (the laptop's ablation bench would
  do it).

## Open questions

- None.
