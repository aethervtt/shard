# 0103 — Generated LODs for imported meshes

- **Status:** implemented
- **Packages:** `@aethervtt/shard-gltf`, `@aethervtt/shard-mesh`, `@aethervtt/shard-render`
- **Depends on:** 0015, 0022, 0032 (skinning), 0045 (the simplifier)

## Context

0022's `lods: 'auto'` import setting only finds levels a file already has: an `MSFT_lod` chain, or
siblings named `<name>_LOD0`, `_LOD1`…. Most models have neither. Asset-store props, scans, and
AI-generated models (Tripo, Meshy) come as one dense mesh, so every one of them draws at full
detail at any distance. 0045 already ships meshoptimizer's simplifier (`simplifyMesh`,
`simplifyLods`), and the importer has everything else it needs.

Two things stand in the way. The simplifier drops `joints`, `weights` and morph `targets` from
what it returns, and falls back to collapsing across UV seams (and then to the positions-only
"sloppy" simplifier) when seams stop it short. And `Lod` doesn't work on skinned or morphed meshes
in the renderer. The deform record describes level 0's mesh, so a lower level indexes level 0's
joints, weights, and morph deltas by its own vertex ids, and every pass draws it with the wrong
weights.

## Goals

- `lods: 'auto'` generates levels for meshes that have no authored chain, at import time, cached
  with the import. Loading never simplifies.
- Authored chains always win: a mesh in one gets nothing generated.
- Per-asset settings: on/off, the triangle fraction of each level, and the screen error at which a
  level takes over. The defaults suit a typical prop, so most need no settings.
- Skinned meshes: every level uses the source's skin and joints, so one pose drives them all, and
  each vertex keeps its source joints and weights. Nothing is recomputed.
- Morph targets carry through to every level.
- UV seams and hard normal edges stay intact, and the silhouette lasts as long as the triangle
  budget allows.
- Small loose parts (teeth, claws) may vanish at the last level, never before.
- `Lod` works on skinned and morphed meshes in every pass (main view, shadows, depth, G-buffer,
  motion vectors, picking, outlines), on both tiers, for authored chains too.

## Non-goals

- Crossfades between levels (0022 defers them).
- Impostors, or merging meshes across nodes. 0073's HLOD does that for whole cells.
- Generated levels for meshes from other importers. The pieces live in `@aethervtt/shard-mesh`
  (`generateLods`, `weldMesh`), so an importer can adopt them later.
- Retopology or remeshing. Levels only drop vertices, they never move them.

## Design

### Settings

```ts
lods: t.enum(['auto', 'authored', 'none']),           // 'auto' was authored-only before
lodTriangles: t.list(t.f32({ min: 0, max: 1 }), { default: [0.5, 0.2, 0.05] }),
lodPixelError: t.f32({ default: 1, min: 0 }),
```

- `auto` uses an authored chain when the node has one, and otherwise generates levels. `authored`
  is the old `auto`. `none` imports every node as is, as before.
- `lodTriangles` is one entry per generated level: the fraction of the source's triangles that
  level keeps. `[]` turns generation off while keeping authored chains.
- `lodPixelError` is the error, in pixels at 1080 rows, at which the next coarser level takes over.

### Which meshes

A primitive gets levels when `lods` is `auto`, it has at least 1,024 triangles, and its glTF mesh
is in no authored chain (as base or lower level) on any node. Levels are per primitive, made once
per mesh, and every node that uses the mesh gets a `Lod`.

### Building the levels: `generateLods` (`@aethervtt/shard-mesh`)

- **Weld first.** `weldMesh` merges vertices whose every attribute is bit-identical. Tangent
  generation (0016) unwelds a mesh into one vertex per corner. Without the weld every edge would
  be a seam and the simplifier could barely collapse anything. The welded mesh is also what level
  0 stores: same triangles, same values, a third of the vertices.
- **Each level comes from the source**, not from the previous level. It uses meshoptimizer's
  `simplifyWithAttributes`. Vertices are kept or dropped, never moved, so every attribute a level
  has (normals, UVs, tangents, colors, `uvs1`, joints, weights, morph deltas) is the source
  vertex's own value.
- **Collapse cost.** Position error, plus:
  - normals (weight 0.25) and UVs (0.5), as 0045 does;
  - skin: the vertex's weights times an 8-D unit vector per joint (seeded, so imports are
    deterministic), weight 0.5. Collapses that would stretch a triangle across a weight change
    (jaw corners, elbows) cost more;
  - morph: each target's delta (divided by the mesh's extent, so it counts like position error)
    summed into one of four xyz groups, weight 1. Vertices that move in a blink stay distinct from
    the ones that don't.
- **Seams and hard edges.** Never `Permissive`, never the sloppy fallback. meshoptimizer treats
  vertices at one position with different attributes as a seam and only collapses along it, so
  seams stay where they are and hard edges stay hard. When seams stop a level short of its target,
  it keeps more triangles than asked.
- **Borders** (open edges) collapse only along themselves, which is meshoptimizer's default. They
  aren't locked: a Tripo mesh has hundreds of open edges, and locking them would stall every level.
- **Loose parts.** A part is a connected set of triangles, by position.
  - Only the last level prunes, and only parts smaller than the error it reaches without pruning.
    It runs once plain, then with `Prune` bounded by that error. Unbounded, `Prune` removes whole
    bodies to reach the target: CesiumMan's last level came out empty.
  - An earlier level that loses a part runs again with that part's vertices locked, and with the
    part's triangles added to its budget. Without the extra budget, the simplifier deletes the
    rest of the mesh to make room: four locked parts over a 220-triangle target removed the body
    and 16 other parts. Locking one part can cost another, so it repeats until nothing is lost.
- **No empty levels.** A level with no triangles is dropped, and so is every level after it.
- **Stalls.** A level that keeps more than 80% of the previous level's triangles is dropped, and so
  is every level after it.

### Switch sizes

A level's `screenSize` is where the next level's error reaches `lodPixelError` pixels:

```
screenSize[k] = lodPixelError · diameter / (error[k + 1] · 1080)       // last level: 0
```

- `error` is meshoptimizer's estimate, in mesh units.
- `diameter` is the mesh's bounding-sphere diameter, the same sphere the renderer projects.
- Both scale with the instance transform, so the ratio holds at any scale.
- Sizes are clamped to decrease. The last level always draws, as with authored chains that have no
  coverage.

### Sub-assets

Level k of `Mesh/<name>` is `Mesh/<name>/LOD<k>`, and of `Mesh/<name>/<i>` it is
`Mesh/<name>/<i>/LOD<k>`. Its `info` adds `lod: { of, level, error }`. The scene's entity gets
`render/Lod` with the base mesh first, alongside its `SkinnedMesh` and `MorphWeights`, which are
unchanged.

### Caching

Levels are sub-assets of the import, so they're cached with it, keyed by the source hash, the
settings, and the importer version (bumped to 4). Changing a LOD setting re-imports that file only.

### Renderer: per-level deform data (amends 0022)

- Deform record word 11 (unused until now) holds `1 +` the first word of the slot's **level table**
  in the deform vertex data, or 0 for slots without `Lod`.
- The table has four words per level: skin base, morph base, vertex count, and target count. It's
  packed once per LOD set, refreshed in place when a level's mesh repacks, and every level's mesh
  data is marked used each frame, so a repack keeps it.
- `deform_vertex` already knows its level from the visible entry (`slot | level << 28`). Every
  culling path writes that entry for camera and shadow views alike. Above level 0 the function
  reads that level's row. A level with no skin data draws in bind pose, and morph pairs past a
  level's target count are skipped.
- The cull sphere still comes from level 0's joint radii. Generated levels are vertex subsets, so
  it covers them.

### Agent surface

- The three settings appear in `gltf/ImportSettings`, in the generated schema and docs.
- `asset.get` on a level shows its triangles and `lod` info, and the scene's `render/Lod` shows its
  switch sizes.
- `render.describe` (per-LOD counts) and `render.capture { debug: 'lod' }` work as before.

## Decisions

- **A new spec, not an amendment.** It spans the importer, the simplifier, and the renderer. 0015
  and 0022 point here.
- **Carry morph targets rather than skip.** Vertices aren't moved, so the deltas carry over
  exactly. Skipping would leave every face mesh with blend shapes at full detail forever.
- **Switch sizes from measured error, not fixed 4× steps.** A level draws once its error is
  subpixel, so a 50% level that's indistinguishable takes over immediately, and a coarse one waits.
- **Skin as a collapse cost, not a lock.** Locking joint boundaries would stall a creature's levels.
  Measured on the test crocodile at 5%, the skin cost cuts extra posed-deformation error by about a
  third, for 10% more geometric error.
- **Lock a lost part rather than simplify parts separately.** It only triggers past the default
  fractions (the test crocodile never needs it), and it's a few lines over meshoptimizer.
- **Pruning bounded by the level's own error.** "Too small to matter" then means smaller than
  what the level already gets wrong.
- **Weld level 0 too.** It renders the same, and it makes generated levels vertex subsets of it.

## Acceptance criteria

- [x] A 2,000-triangle mesh with no authored chain imports with `render/Lod`: the base plus three
      `LOD<k>` sub-assets, each within 10% of (or, when seams stop it, above) its fraction, sizes
      decreasing, the last 0. Importing again with the same settings reuses the cached artifacts.
- [x] A file with a `_LOD` chain or `MSFT_lod` gets no generated sub-assets. `lods: 'authored'`,
      `'none'`, and `lodTriangles: []` generate none either.
- [x] Every vertex of every level equals a source vertex in every attribute, joints, weights, and
      morph deltas included.
- [x] A closed mesh with UV seams and hard normal edges stays closed at every level, and no
      triangle spans a hard edge.
- [x] A mesh with 20 loose parts keeps all 20 at every level but the last.
- [x] A posed skinned mesh whose `Lod` draws level 1 renders the same, in the main view and its
      shadow, as level 1's mesh drawn on its own with the same skin and joints. The same holds
      for a morphed mesh.
- [x] The test crocodile: triangles and errors per level recorded in "As built".

## As built

The test crocodile (Tripo, 4 m, one skinned primitive, 28 joints; not in the repo). Welded by
position it has 50 parts (a 45k-triangle body and 49 teeth and claws of 92–207 triangles) and 742
true border edges. The other ~4,950 edges a per-index count reports as boundaries are UV and normal
seams.

| Level | Triangles | Vertices | Error | Parts | screenSize |
|---|---|---|---|---|---|
| 0 | 51,545 | 28,710 | — | 50 | 1.728 |
| 1 | 25,772 | 14,989 | 2.3 mm | 50 | 0.611 |
| 2 | 10,308 | 6,466 | 6.6 mm | 50 | 0.152 |
| 3 | 2,572 | 1,882 | 26.7 mm | 31 | 0 |

- Generating the three levels takes about 110 ms on the laptop (M4), once per import.
- Posed with the jaw open 35°, the tail bent 72° over four joints, and a front leg lifted 50°,
  every level deforms like the source. The extra posed-deformation error (a level's displacement
  against the nearest source point's) is 0.4, 0.9, and 2.6 mm.
- Level 0 has three vertices more than the file: MikkTSpace gives three vertices two tangents.
- The renderer bug: without the level table, the new skinned-LOD test differs from level 1 drawn
  alone by a mean of 4.5 per channel. With it, the two images match.

## Open questions

- None blocking. A per-node override (a node's `extras.shardLods`) can follow if a model needs
  different fractions for different parts.
