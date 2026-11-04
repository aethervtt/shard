# 0095 — Procedural trees

- **Status:** implemented
- **Packages:** `@aethervtt/shard-nature` (new, experimental), `@aethervtt/shard-gltf`,
  `@aethervtt/shard-scatter`, `@aethervtt/shard-project`, `apps/cli`, `apps/playground`
- **Depends on:** 0020, 0022, 0030, 0031, 0042, 0045

## Context

0045's `shard/Tree` and `shard/Bush` are placeholders. Each is one untextured mesh tinted from bark
to leaf by a part code. They have a handful of params, and their LODs come from meshoptimizer,
which collapses leaf cards badly. They're good enough to fill a planet, but not good enough to look
at up close.

[EZ-Tree](https://github.com/dgreenheck/ez-tree) (MIT, Daniel Greenheck) makes trees that do look
right. It has per-level branch params (angle, children, gnarliness, length, radius, sections,
segments, start, taper, twist), a growth force, deciduous and evergreen forms, textured bark,
alpha-cut leaf billboards, rounded canopy normals, and 15 presets (ash, aspen, oak and pine in
three sizes, and three bushes). It also splits growing from meshing: the RNG is used only while
growing the skeleton, so any number of LODs can mesh the same skeleton with no change in shape.
It's about 2 000 lines of JavaScript on three.js.

This spec ports EZ-Tree into a new package as a Shard generator, bakes trees to `.glb` from the
CLI, and is the base for growing past EZ-Tree later. The package is **experimental**. It stays if
its preset contact sheets look at least as good as EZ-Tree's own demo. That's a human call, made
once the acceptance criteria pass. If it fails, the package is deleted along with the `nature`
manifest plugin and the CLI's `nature` command, and nothing else in the engine depends on it.

`shard-nature` is meant to hold more natural features later. Water (spline rivers, lakes and
shores that blend into terrain) gets its own spec. The sky is already covered by 0044 (atmosphere,
implemented) and 0049 (volumetric clouds, cloud shadows, weather, accepted). Impostors for distant
trees get their own spec too, and they also serve 0073.

## Goals

- A `nature/Tree` generator that ports EZ-Tree's skeleton and meshing. Its shape comes from a
  `TreeSpecies` data asset with every EZ-Tree param, plus a seed. The same seed always gives the
  same bytes, in every JavaScript engine.
- The 15 EZ-Tree presets as species, converted to metres. Bark and leaf textures come from EZ-Tree
  for v1.
- LODs built from the skeleton, as EZ-Tree builds them (fewer rings, sides and leaves, single
  billboards), not by simplifying the mesh.
- One mesh and one material per tree. Bark and leaves are told apart by 0045's part code, so
  scatter, `Lod`, culling and HLOD's `instances` method take a tree as they take any generator mesh.
- Wind from 0045's `Wind` resource: leaves sway, branches a little, the trunk not at all.
- `shard gen nature/Tree … --out oak.glb`: a GLB with its LODs and standard glTF materials that
  re-imports into Shard as one LOD chain, and opens in other tools.
- A playground demo.

## Non-goals

- Impostors and billboard LODs (their own spec). Until it lands, a tree's last LOD is the coarsest
  skeleton mesh, cut off by the scatter rule's `range`.
- EZ-Tree's trellis, flat shading, and its demo app (grass, clouds, ground, audio).
- Growth simulation (space colonisation, light-seeking), seasons, and destruction.
- A dedicated tree editor in Studio. The inspector and `shard gen` contact sheets are the editing
  loop, as for every generator.
- Physics beyond scatter's colliders (`convex` from the coarsest LOD).
- Replacing `shard/Tree` and `shard/Bush`. If this package stays, a later change deprecates them.

## Design

### Package generators

No procgen change was needed. `defineGenerator` registers on import, a project that uses the
package imports it (the `nature` manifest plugin, through `@aethervtt/shard-project`), and the
generator worker bundle inlines everything the project imports. Like engine generators, a package
generator's code hash is its `run` source, so `nature/Tree` bumps `version` when growing or
meshing changes.

### Species and params

```ts
TreeSpecies {                            // data type (0031), `*.tree.json`
  form: 'deciduous' | 'evergreen'
  levels: list(struct {                  // [0] is the trunk, 1 to 4 entries
    length: f32 (m), radius: f32, angle: f32 (deg), children: u8 (≤ 128), start: f32,
    gnarliness: f32, taper: f32, twist: f32 (rad), sections: u8, segments: u8 (3–64),
  })
  force: { direction: vec3, strength: f32 }
  bark: { textureScale: vec2 }
  leaves: { count: u8 (≤ 128), start, angle (deg), size (m), sizeVariance,
            billboard: 'single' | 'double', roundedNormals: bool }
  lods: list(struct { sectionStride: u8, segmentFactor: f32, leafStride: u8, leafScale: f32,
                      billboard: 'single' | 'double' })   // LOD1 first; EZ-Tree's two by default
}

defineGenerator('nature/Tree', {
  params: { species: handle('nature/TreeSpecies'), scale: f32 = 1 },   // no species: oak_medium
  output: 'mesh',
})
```

- EZ-Tree keys per-level params by level number (`{ 0: 20, 1: 20 }`). Shard uses a list of
  structs, one row per level in the inspector. `children` on a level is how many branches of the
  next level grow from each of its branches. `angle` and `start` on a level apply to its own
  branches.
- The trunk's `radius` is in metres. Other levels' radius is a fraction of the parent's radius
  where the branch starts, as in EZ-Tree. Pines put 91 branches on the trunk, hence the 128 cap.
- `bark.textureScale.x` is how many times the texture wraps around a branch per metre of its radius
  (at least once). `y` stretches it along the branch: 1 keeps texels square, 0.5 suits Bark001's
  1:2 image. EZ-Tree mirrors bark V on alternate rings instead.
- Presets live in `src/presets.ts` (`TREE_PRESETS`), generated once from EZ-Tree's JSON. Lengths,
  the trunk radius and leaf size are multiplied by `EZ_UNIT` = 0.18 m. That puts oak_medium at
  12.8 m, oak_large at 19.5 m and pine_large at 12.3 m. The bushes use half that, so they stand
  1.7 to 2.8 m. EZ-Tree's bend and growth force scale with 1 / radius in its own unit, so growth
  divides radii by `EZ_UNIT` before using them, and the shapes stay EZ-Tree's.
- The bushes are named for their leaves: `bush_ash`, `bush_aspen` and `bush_pine` (EZ-Tree's
  `bush_1` to `bush_3`).
- Look (textures, tints, alpha cutoff) lives in the material, not the species. One species can be
  drawn with several materials (an autumn oak), and the mesh's cache key doesn't change when the
  look does.

### Growing and meshing

The port keeps EZ-Tree's structure. A breadth-first branch queue grows the skeleton: rings per
branch (origin, orientation, radius, distance along), and leaf placements (origin, orientation,
size, a random shade). Then a meshing pass writes rings and leaf cards per level of detail.

- three.js is gone. Orientations are quaternions in `Float64Array`s. EZ-Tree bends a branch by
  adding to an XYZ Euler's x and z, which is a world-X rotation before the orientation and a
  local-Z rotation after it, and that's what the port does. Interpolation between rings is nlerp.
  Every sine and cosine comes from `sinCos`, so the bytes match across engines.
- Every random draw comes from `ctx.rng`, in EZ-Tree's order. A seed gives a different tree than
  in EZ-Tree, but the same distribution.
- Before growing, `estimateTriangles` counts branches per level from `children` and throws
  `nature/too-big` past 2M triangles, before anything large is allocated.
- The mesh stands on its origin with y = 0 at the ground.
- LODs come from the species' `lods`, meshed from the same skeleton with tangents (bark normal
  maps). A deciduous branch's continuation takes its parent's rings and sides, and every level
  keeps each branch's first and last ring, so joints stay put.
- **Part codes** (0045's `uv1`): leaves have x = 1. Bark has x from 0 at the trunk to 0.3 at the
  outermost level, so sway reaches branches without moving the trunk. y is 0.5 on bark and a
  random shade per leaf. uv0 is bark UVs (around, and along by length), or 0–1 across a leaf card
  with v = 1 at its stem.
- Measured with the defaults (seed 7): LOD1 keeps 36–48% of a species' triangles and LOD2 16–27%.
  oak_medium is 13.8k triangles. Growing and meshing it with both LODs takes about 4 ms in Node.

### Material

`nature/Tree` is an 0020 extension of the standard material:

```ts
{ leafTexture: handle('Texture'), barkTint, leafTint: color, leafRoughness: f32, shade: f32,
  sway: f32, windDirection: vec3, windStrength: f32, gustScale: f32 }
```

- Bark uses the standard texture slots: `baseColorTexture`, `normalTexture`, and the roughness
  image in `metallicRoughnessTexture`. Its green channel is roughness and `metallic` stays 0.
- The fragment hook picks bark or leaf by `uv1.x > 0.5`. The leaf texture is sampled outside the
  branch, since `textureSample` needs uniform control flow. Leaves take `leafTint` × the texture,
  its alpha, and the geometric normal (the rounded canopy normals).
- Materials use `alphaMode: 'mask'` and `doubleSided: true`. The engine already runs masked
  materials' surface hook in the depth prepass and shadow passes, so leaf shadows are cut out
  with no extra work.
- Sway reuses `SWAY_WGSL` from `scatter`, scaled by the part code squared. Scatter's `applyWind`
  now writes `Wind` into any material whose type has wind fields, not only `scatter/Vegetation`,
  so scattered trees sway with it. Trees placed by hand keep their material's own wind values.
  (0096 replaced this: every tree reads `wind/Wind` through `shard::wind::sway`, and the
  material's wind fields are gone.)

### Textures and setup

The package's `assets/` holds EZ-Tree's bark sets `Bark001` to `Bark003` (ambientCG, CC0) and its
four leaf textures (ash, aspen, oak, pine; MIT under EZ-Tree's license), downscaled to 512 pixels
(1.9 MB in all), and `THIRD-PARTY.md` with EZ-Tree's license. `pnpm release` now ships a
package's `assets/` next to `dist/`, as it ships `wasm/` and `vendor/`.

`shard nature init [--dir assets/nature] [--force]` writes `natureStarterFiles(dir)` into the
project: 15 `species/<preset>.tree.json`, one `materials/<look>.material.json` per leaf type
(ash, aspen, oak, pine; `PRESET_LOOKS` maps presets to them), the 13 textures they use, and the
notice. Files that exist are skipped unless `--force`. From then on they're ordinary project
assets. `"nature"` in `shard.json` plugins adds `naturePlugin` (the shader). A scatter rule uses
them as it uses any generator item:

```json
{ "generator": "nature/Tree", "variants": 6,
  "params": { "species": { "path": "assets/nature/species/oak_medium.tree.json" } },
  "material": { "path": "assets/nature/materials/oak.material.json" } }
```

### GLB export

`gltf` has a writer: `writeGlb({ nodes, materials })`, where each node is a root with one mesh of
one or more primitives, and materials are glTF metallic-roughness materials with PNG or JPEG
images embedded. Every attribute gets its own buffer view. Indices are 16-bit when every vertex
fits, and textures share one repeating, mipmapped sampler. LODs are sibling nodes named
`<name>_LOD0`, `_LOD1`, …, which the importer's `lods: 'auto'` reads as one chain per primitive,
and which Blender and most engines read as LODs. `MSFT_lod` isn't written, since few tools read it.

`shard gen <generator> --out <file>.glb [--material <path>]` writes the first seed's mesh and its
LODs, named after the file. The CLI picks the export by material type:

- `nature/Tree`: `treeGlbScene` splits each level by part code into a bark primitive (opaque, the
  bark maps, `barkTint` folded into the base color) and a leaf primitive (`alphaMode: MASK`,
  `doubleSided`, `leafTint`, the leaf texture). uv1 is kept as `TEXCOORD_1`.
- Any other material: its standard fields on one primitive. No material: no material.

The spec first proposed a `toGltf` hook on material types. Two cases didn't justify a registry.
Add one when a third material type needs to export.

### Playground

`#trees` ("Procedural trees (experimental)", under Worlds) writes the starter files into a memory
project (textures through Vite), generates on web workers (`nature-worker.ts`), and draws each
tree with its two LODs, a sun with shadows, and a procedural sky. The gallery shows the 15 presets
in a grid. F switches to a forest of 500 trees from 45 meshes (three seeds per species), S reseeds,
and W cycles the wind (calm, breeze, gale).

### API sketch

```ts
import { naturePlugin, TreeGenerator, TREE_PRESETS, natureStarterFiles } from '@aethervtt/shard-nature'
import { writeGlb } from '@aethervtt/shard-gltf'

app.addPlugin(procgenPlugin(), naturePlugin)
const oak = await generate(world, TreeGenerator, { species: { path: 'assets/nature/species/oak_medium.tree.json' } }, 7)
// Headless, without assets: buildTree(TREE_PRESETS.oak_medium, new Rng(7), 1, meshBuilder.finish)
```

### Agent surface

- `nature/Tree`, `TreeSpecies` and the `nature/Tree` material appear in `shard docs`, the
  generated schemas (`.shard/schemas`), and `procgen.describe`. `nature` is listed among the
  manifest's built-in plugins.
- `shard gen nature/Tree --param species=assets/nature/species/pine_large.tree.json --seeds 1-9
  --out sheet.png` is the tuning loop: change a level's params, then look at nine seeds.
- `shard gen … --out tree.glb --json` adds `glb: { out, bytes, triangles }` (triangles per level).
- `shard nature init --json` reports `{ dir, written, skipped }`.
- **Errors:** `nature/bad-species` (no levels or more than 4, a force with no direction),
  `nature/too-big` (over 2M triangles, with the level to cut), `gltf/write-invalid` (an attribute
  of the wrong length), and `gltf/write-unsupported` (a texture that isn't PNG or JPEG).

## Decisions

- **A new package, not more `procgen` generators.** The experiment can be deleted in one change.
- **Port, don't depend.** EZ-Tree is tied to three.js, and generators must be pure and deterministic
  on Shard's RNG and trig. A port also lets the API become Shard's own.
- **Species as data assets, not a `preset` param.** Params have no "unset" state, so a preset plus
  overrides can't be expressed cleanly. A species file is complete, schema-validated, editable in
  the inspector, and a cache dependency of every tree made from it.
- **Structured LODs, not meshoptimizer.** Simplifying leaf cards removes whole leaves at random and
  leaves holes in the canopy. Meshing the skeleton with fewer rings, sides and leaves (with the
  rest scaled up) keeps the silhouette.
- **One mesh and one material, split by part code.** Scatter, `Lod`, the 0022 instance path and
  0073's `instances` method all assume one mesh and one material per item. Split only on export.
- **`_LOD<n>` names, not `MSFT_lod`.** Both import into Shard, but Blender and most DCC tools only
  understand the names.
- **Textures copied into the project.** Copied files work with every existing asset tool, and
  projects are expected to replace them.

## Acceptance criteria

- [x] `nature/Tree` is usable from a `.gen.json`, a scatter item, `generate()` and `shard gen`, in
      Node and in a browser worker, with no procgen change (playground `#trees`, CLI test).
- [x] Each of the 15 species generates, stands on the ground, and gives identical mesh bytes for
      the same seed and different ones for another (`tree.test.ts`).
- [x] Each species' LOD1 has at most 50% of LOD0's triangles and LOD2 at most 30%
      (`tree.test.ts`). A deciduous continuation starts exactly on its parent's last ring.
- [x] Growing `oak_medium` with its LODs takes under `nature/generate` (30 ms, proposed; measured
      about 4 ms on the laptop), checked under `pnpm bench`.
- [x] Leaves draw from `leafTexture` and are cut out by its alpha in color and in shadows: with a
      transparent leaf texture, no leaf pixels draw and the crown's shadow is gone
      (`render.test.ts`, on the GPU).
- [x] `shard nature init` writes 33 files, skips them the second time, and every species file
      validates and every material's textures exist (`tree.test.ts`, `cli.test.ts`).
- [x] `shard gen nature/Tree … --out oak.glb --material …` writes three `_LOD<n>` nodes with bark
      and leaf primitives, an opaque and a masked material, and four images (`cli.test.ts`). A
      written GLB with two-primitive LOD nodes imports back as two LOD chains (`writer.test.ts`).
- [x] The oak GLB opens in Blender with bark and leaf materials, textures and three LOD objects,
      and renders as a textured tree in EEVEE (checked by hand, 2026-11-03).
- [x] The playground demo runs on WebGPU and on WebGL2 (baseline): the gallery, and 500 trees at
      60 fps on the laptop (checked by hand, 2026-11-03).
- [x] A human has compared the trees with EZ-Tree's and decided to keep the package (2026-11-03),
      with leaf lighting as the first follow-up (below).

Deferred:

- **Leaf lighting.** Up close, leaves read as plastic: the rounded canopy normals spread one broad
  specular highlight across a card, and no light passes through a leaf. Leads: light transmission
  for back-lit leaves (the standard lighting has no transmission input, as 0045 found), lower
  specular on leaves, and blending the rounded normal toward the card's own normal near the camera.
- **A wind readback test** (trunk vertices at part code 0 don't move with `Wind` strength 1,
  leaves do). Sway is 0045's code, checked by eye in the demo.

## Open questions

- Should leaves sample a separate normal map? EZ-Tree has none. Proposed: decide with the leaf
  lighting work.
- Should textures stay in the package as virtual assets instead of being copied? Decided for v1:
  copy (see Decisions).
- Should the bushes be their own generator with fewer params? Proposed: no while they're species.
