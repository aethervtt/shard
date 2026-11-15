# 0119 — Terrain from code, baked near players

- **Status:** draft (built 2026-11-15). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-terrain`, `@aethervtt/shard-procgen`, `@aethervtt/shard-node`,
  `apps/cli`, `apps/playground`
- **Depends on:** 0041, 0042, 0071, 0104, 0113

## Context

0071 bakes a terrain source (noise, images, splines) into packs before anything streams: the first
use bakes every block. That suits a hand-shaped 4 km valley. It doesn't suit a map whose ground is a
function: Risen's regions (its ADR 0009) are a seed and parameters, about 20 × 16 km, and the
ground under a house's pad is `groundAt(plan, x, z)`, the same number on the server, every client
and the cell generators. A 1 m image of that is 1.3 GB, and a full bake is minutes of work and about
740 MB of packs that the region file already describes.

Two things are missing. A source can't say "heights come from this code": the only in-memory path
is `sourceAsset()` in `terrain/testing`, and its layers are images, noise and splines. And
`HeightfieldRuntime.prepare()` bakes every stale block before streaming starts. This spec adds
**generator layers** (heights and material weights from a registered function, run on the worker
pool, keyed by its name, version and params) and a **near bake**: pages made on demand where the
camera and anchors need them, with coarse levels sampled from the generator directly instead of
built up from the leaves.

## Goals

- `defineTerrainGenerator(name, { params, version, prepare, heights, weights })`: a pure function of
  (params, x, z), registered by project code, run on the main thread and on pool workers.
- A source layer `{ "generator": "risen/Ground", "params": { … } }` in `height`, and a paint entry
  naming the same generator for its material weights.
- `"bake": "near"`: no packs and nothing stored. Pages bake when selection, colliders or queries
  want them, nearest anchors first; coarse levels come straight from the generator, so the first
  frame needs only the resident levels, not the whole terrain.
- The same bytes everywhere: a leaf baked on a worker, on the main thread, in Node and in Chrome,
  and by 0071's ahead bake of the same source are identical, so colliders never depend on timing.
- `terrainSource(world, json)`: a public in-memory source, for sources made in code.
- Sized for 20 480 × 16 384 m at 1 m.

## Non-goals

- Storing generated pages (Risen's ADR 0002: nothing generated is stored). A disk cache can come
  later if a measurement asks for it.
- Running the generator on the GPU. It's arbitrary TypeScript.
- Networked terrain edits. 0104's edits still work on a near terrain (below), unsynced as today.

## Design

### Generators

```ts
export interface TerrainArea {
  /** Metres from the terrain's corner of sample (0, 0); samples at x0 + a × step. */
  x0: number
  z0: number
  step: number
  nx: number
  nz: number
}

export const Ground = defineTerrainGenerator('risen/Ground', {
  params: { region: t.string(), seed: t.u32() },
  version: 3,
  deterministicMath: true,
  // Once per thread per (version, params): what sampling reads (a region plan).
  prepare: (params) => buildPlan(params),
  // Metres at every sample, row by row (nz rows of nx).
  heights: (plan, area, out: Float64Array) => { … },
  // Weights 0–1 per sample for each named material layer: out[(b × nx + a) × L + l].
  layers: ['grass', 'field', 'forest', 'gravel', 'mud'],
  weights: (plan, area, heights: Float64Array, out: Float32Array) => { … },
})
```

- A generator is a pure function of its params and (x, z): a sample's value never depends on the
  area it was asked for in. That is the rule that makes every bake path write the same bytes, and
  0071's canonical-samples test checks it.
- `params` is a component schema (0002), so params are validated and defaulted like a generator's
  (0042). `version` is bumped when the code changes what it returns. `deterministicMath` is 0042's
  guard (transcendental `Math` throws while it runs, and `shard check` flags them).
- `prepare` runs once per thread per (name, version, params) and its result is kept while the
  terrain lives: Risen builds its region plan there, a few seconds, once per machine and once per
  worker. Without it, the state is the params.
- Redefining a name replaces it (hot reload). A terrain using it rebakes its pages.

### Source layers

```json
{
  "size": [20480, 16384], "spacing": 1, "heightRange": [-50, 450], "bake": "near",
  "height": [{ "generator": "risen/Ground", "params": { "region": "knox", "seed": 1 } }],
  "layers": [{ "name": "grass" }, { "name": "field" }, { "name": "forest" }, { "name": "gravel" }, { "name": "mud" }],
  "paint": [{ "layer": "grass" }, { "generator": "risen/Ground" }]
}
```

- A generator height layer has `params`, `blend` (default `replace`) and no region: it covers the
  terrain. Layers after it (a spline road, an image) apply on top as usual, and `"ground"` spline
  points read it.
- A generator paint entry applies its `weights` with 0104's paint rule: every weight scales by
  (1 − their sum, clamped to 1), then each layer gains its own. Its params are those of the height
  layer naming the same generator, unless it has its own. Each name in `layers` must be a material
  layer (`terrain/unknown-layer`).
- The stack (heightfield/stack.ts) holds `generators: { name, version, params }[]`, cloneable, and
  the kernel's per-thread access gains `generator(spec)`, which finds the definition in this
  thread's registry and its prepared state. Missing on the main thread, the terrain waits for it
  (`waiting: terrain generator risen/Ground`) and warns once (`terrain/unknown-generator`).
- A source's hash includes each generator's name, version and canonical params, so any of them
  changing is a new source: an ahead bake rebakes, and a near terrain drops its pages.

### Where generator jobs run

Generator code is project code, so its jobs run in the bundle that already carries it: 0042's
procgen worker module (the project's code plus `@aethervtt/shard-procgen/worker`), which every
host builds and 0073's HLOD already shares.

- procgen gains **worker tasks**: `defineWorkerTask(name, fn)` registers a function, the worker
  module exports `runTask(name, args)`, and `runWorkerTask(name, args, options)` posts it to the
  host's pool (inline, after an await, without one). `defineTerrainGenerator` registers the
  terrain's task the first time it's called, so the worker has it whenever it has a generator.
  Nothing registers on import.
- A stack without generator layers keeps using the terrain's own `worker.js`.

### The near bake

`"bake": "near"` (the default with a generator layer; `"ahead"` otherwise, and allowed with one).

- **Leaves** bake one page per job with 0071's `bakeLeaf`: heights with their border and control,
  exactly the ahead bake's bytes. The main thread bakes the same page inline when a collider tile
  is due before the job lands (0071's rule), and gets the same bytes.
- **Parents** bake one page per job, from the generator directly: the layers at twice the page's
  resolution (131 × 131 samples with a margin), heights at the page's own samples (point samples,
  as 0071's parents are: the same heights the ahead bake gives), normals by central differences on
  the finer grid, control at the page's texels with slopes from that grid, and the page's error
  measured against the finer grid. Nothing below a page is needed to make it.
- **Errors.** 0071 measures each node's error exactly over its whole subtree. A near page knows
  only the next level, so a parent's error is twice its measured one (a fractal's tail halves each
  level; checked below against the ahead bake's exact errors). The selection table takes each
  depth's largest; depths no page has reached yet take half the depth above, and the table only
  grows as pages bake.
- **Resident levels** (0071's `residentDepth`, 8 MB by default) bake before streaming starts:
  for 20 × 16 km that's depths 0 and 1, 100 pages.
- **Priority.** Jobs queue by priority, at most two per worker in flight: anchors' leaves first
  (nearest first), then selection's requests by projected error, then prefetch. Each frame the
  leaves within `colliderRadius + leafSize` of an anchor are prefetched, so a tile due two frames
  after it's wanted usually finds its page.
- **Memory** is 0071's CPU page cache (512 pages and the resident ones); an evicted page bakes
  again when it's wanted. Nothing else is kept.
- **Bounds.** A parent's height range is its own samples' padded by its error; a leaf's is exact.
  Tree nodes take a page's range when it bakes.
- **Edits** (0104) ride in the stack as before; each job takes only the edit tiles its page reads.

### API sketch

```ts
import { defineTerrainGenerator, terrainSource, Terrain } from '@aethervtt/shard-terrain'

const source = terrainSource(world, {
  size: [20480, 16384], spacing: 1, heightRange: [-50, 450],
  height: [{ generator: 'risen/Ground', params: { region: 'knox', seed: 1 } }],
}, { name: 'knox' })
world.spawn([Grid, { cellSize: 2000 }], [Terrain, { source }], Transform)
```

`terrainSource` validates the source (0071's errors), registers it as `mem:<name>` (again with the
same name: updated in place) and returns its handle. Its noise graphs and heightmaps are found by
path through the asset server.

### Agent surface

- `terrain.describe` gains `bake: { mode: 'near', baked: { leaves, parents }, queued, running,
  bakedInline, msPerLeaf, msPerParent }` per heightfield, and `generators` (name, version, params).
- `shard terrain bake` skips near sources (they have nothing to store) and says so; `shard terrain
  stats` says a source is near instead of reading packs.
- `shard check` flags nondeterminism in modules that call `defineTerrainGenerator`.
- **Errors:** `terrain/unknown-generator` (warning, while it waits), `terrain/generator-failed` (the
  generator threw, with its message), `terrain/bad-generator-output` (a NaN or infinite height, or a
  weights array of the wrong length), `terrain/bad-source` for a generator layer with a region.

## Decisions

- **Pages, not 0071's blocks, are the unit of a near bake.** A block bakes a square kilometre to
  give one leaf; a page job takes a few milliseconds, so the bake follows the player closely and
  the pool stays responsive.
- **Parents from the generator, not from their children.** This is what lets coarse levels exist
  without a full bake. Their heights equal the ahead bake's; their normals and errors are
  estimates, and nothing that must match across machines (colliders, queries, scatter) reads them.
- **Generator jobs in the procgen worker module.** It's the one bundle every host already builds
  with the project's code; a second one would double the bundling and the worker memory.
- **No store.** A Risen client needs only the region file; pages are cheaper to make again than to
  keep (below, measured).

## Acceptance criteria

- [x] A leaf baked by a near job, inline on the main thread, and by an ahead bake of the same source
      is byte-identical (500 leaves of a generator with noise and grading), and the near leaves'
      hash matches between Node and Chrome (the playground's `#heightfield` page).
- [x] A near parent's heights equal the ahead bake's parent at every sample, and its estimated
      error is within [1×, 4×] of the ahead bake's exact error at every depth of the test terrain.
- [x] A 20 480 × 16 384 m near terrain at 1 m streams its first frame after baking only its resident
      levels (100 pages), and a character dropped at a random point stands on a collider tile within
      the 2-frame collider delay, with no full bake (pages baked counted).
- [x] A character walking 300 m at 6 m/s never waits for ground: every tile it needs is a page that
      landed (no inline bake after the first frame).
- [x] Redefining the generator with a new version rebakes: pages clear, the terrain version bumps,
      and the new heights show.
- [x] A generator that returns NaN reports `terrain/bad-generator-output` naming the generator and
      the area.

## As built

- **Generators** (heightfield/generator.ts): `defineTerrainGenerator` validates the name, builds the
  params schema, and keeps a registry by name with a revision per definition. `generatorAccess`
  prepares a generator once per thread per (name, revision, params), wraps each call in 0042's
  `guardNondeterminism`, and checks the output (`terrain/bad-generator-output`, naming the point).
  Defining one registers two worker tasks, `terrain/near-page` and `terrain/bake-block` (an ahead
  bake of a stack with generators runs in the generator module too).
- **Worker tasks** (procgen/src/tasks.ts): `defineWorkerTask`, `runTask` (exported by
  `@aethervtt/shard-procgen/worker`; every host's bundle list gained it: `shard-node`'s, the
  export's, the playground's two), `runWorkerTask` (inline after an await without a pool).
- **Kernel**: `LAYER_GENERATED`; a `replace` generator layer writes the generator's number itself,
  not `h + (v − h)`, so the terrain is `groundAt` quantized. Generator paint uses 0104's rule with
  weights over 1 normalized. `bakeParent` (131 × 131, error against the finer grid) and
  `bakeNearPage` (either kind, with the pool's texels). `evalControl` gained the finer-grid stride,
  slope spacing and paint-edit lattice it needs for parents.
- **Near bake** (heightfield/near.ts, pages.ts): `NearBake` owns the queue (bands: anchor, resident,
  camera; two jobs per worker), the page entries and the per-depth error table; `PageStore.load`
  takes a band and priority and bakes through it, `leafNow` bakes inline through it (counted as
  `bakedInline`). Collider tiles ask with the anchor band at top priority the frame they're wanted;
  `prefetchNearLeaves` asks for every leaf within an anchor's radius plus a leaf, nearest first.
- **Again after a change** the old pages keep drawing (streaming stays on) until the new resident
  levels are in; then the cache clears and the version bumps. A generator redefined is noticed by
  its revision each frame.
- **Ahead bakes of generator stacks** key blocks by the generator spec and fold it into the source
  hash (`bakeSourceHash`), so a version or params change rebakes.
- **`terrainSource(world, json, { name })`** registers `mem:<name>`; dependencies by path through
  the asset server.
- **Tests**: heightfield/generated.test.ts (parsing and keys; near, inline and ahead leaves equal on
  500 leaves, hash `63a7910f` pinned and checked in Chrome by the playground's browser test;
  parents' heights equal and estimated errors within [1×, 4×] per depth; the 20 × 16 km stream and
  walk; rebake on redefinition; NaN), node/src/terrain-generator.test.ts (pages in the generator
  worker module equal the main thread's), the playground's `#heightfield` page (prints `near`).
- **Measured** at 20 480 × 16 384 m: specs/research/regions-terrain-2026-11-15.md.

## Open questions

- None blocking. Deferred: a disk cache of near pages (desktop builds, slow generators), if a
  measurement says first frames are slow.
