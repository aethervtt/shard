# 0041 — Noise library

- **Status:** implemented
- **Packages:** `@shard/noise` (new), `@shard/core`, `@shard/platform`, `@shard/platform-web`,
  `@shard/platform-node`, `@shard/platform-tauri`, `@shard/shader`, `@shard/render`,
  `@shard/protocol`, `crates/shard-noise` (new)
- **Depends on:** 0002, 0006, 0014, 0016

## Context

Every M7 generator starts with noise: planet heights, biome temperature and moisture, scatter
density, rock displacement, cloud and nebula textures, star density across the galaxy. The same
noise must run in two places: on the GPU, to build terrain chunks and textures fast, and on the CPU,
for anything gameplay depends on (a collider, where a tree stands, whether a spot is underwater).
Headless tests have no GPU at all.

Hand-writing noise stacks in TypeScript and WGSL separately would drift. The agent-friendly
version is a **noise graph** as data: a small JSON tree of sources and operators that an agent
edits and previews, which is interpreted by a WASM kernel on the CPU and compiled to a WGSL
function for the GPU.

This spec also adds the engine's first worker pool. Sampling a 257² chunk is 66k evaluations of a
several-octave graph, which shouldn't run on the main thread. VISION reserved `crates/` for WASM
kernels, and this is the first one.

## Goals

- Sources: value (2D, 3D), Perlin (2D, 3D), simplex (2D, 3D, 4D), and cellular/Worley (2D, 3D;
  F1, F2, F2−F1, cell value; Euclidean, Manhattan, Chebyshev), all seeded by a u32.
- Fractals and operators: fBm, ridged, billow, domain warp, add/multiply/min/max/lerp/select,
  remap, clamp, curve (piecewise-linear table), terrace, abs, power, constant, and scale/translate
  of the input. 0047 adds `craters`.
- `NoiseGraph` as a data asset (`*.noise.json`), validated, hot reloaded, and previewable.
- A CPU kernel in Rust compiled to WASM, which evaluates a graph over batches of points (arrays in,
  array out), with SIMD where the host supports it.
- A WGSL code generator: a graph becomes a module exporting `fn noise_<name>(p, seed) -> f32`,
  usable from materials (0020), compute passes, and particle shaders through normal imports.
- CPU and GPU agree to a stated tolerance. The CPU result is canonical.
- **Origin-offset sampling**, so precision doesn't depend on where the domain is. A chunk on an
  Earth-sized planet (6.4×10⁶ m) or a gas giant (7×10⁷ m) samples its finest octaves as precisely
  as one at the origin.
- A worker pool in the platform layer (web workers, Node `worker_threads`), with the WASM kernel
  loaded in each worker and transferable TypedArrays in and out.
- Public seed hashing in core (`hashSeed(seed, label)`), used by noise, RNG forks, and generators.

## Non-goals

- A node-graph editor UI (Studio, later). Graphs are JSON first.
- Bitwise equality between CPU and GPU. GPUs fuse multiply-adds and differ in transcendental
  precision; the tolerance below is the contract.
- Analytic derivatives. The CPU returns gradients by central differences (`sampleNoiseGradient`);
  the GPU computes normals by finite differences, which 0043 already needs for chunk borders.
- Curl noise and flow noise for particles (later, on the same sources).

## Design

### Noise graph files

```json
{
  "$schema": "../../.shard/schemas/noise.schema.json",
  "output": "height",
  "extent": 1,
  "nodes": {
    "continents": { "fbm": { "source": "simplex", "octaves": 5, "frequency": 0.8, "gain": 0.5,
                              "lacunarity": 2.0, "seed": 1 } },
    "mountains":  { "ridged": { "source": "simplex", "octaves": 6, "frequency": 3.2, "seed": 2 } },
    "mask":       { "remap": { "input": "continents", "from": [0.1, 0.4], "to": [0, 1],
                               "clamp": true } },
    "warped":     { "warp": { "input": "mountains", "by": "continents", "amount": 0.15 } },
    "height":     { "add": ["continents", { "multiply": ["warped", "mask"] }] }
  }
}
```

- A graph is a map of named nodes, plus `output` naming the root. A node input is a node name, an
  inline node, or a number. Names make agent edits local ("lower `mountains.frequency`").
  Optional fields: `dimensions` (2, 3, or 4; default 3), `extent` (the largest distance from the
  origin it's sampled at, e.g. a planet radius), and `description`.
- One table in `@shard/noise` (`nodes.ts`) describes every node type: its parameters, defaults,
  ranges, and docs. The validator, the JSON Schema, and the agent docs read it; the compiler and the
  WGSL generator switch on the node type. Adding an operator is a table entry, a compiler case, a
  Rust instruction, and a WGSL template.
- Graph seeds are per source node and mixed with the seed the graph is evaluated with:
  `hashSeed(evalSeed, node.seed)` (fractals then take `hashSeed(that, octave)` per octave). The
  same graph gives a different planet per planet seed, and changing one node's seed changes only
  that layer.
- Validation reports every error at once, each with a JSON pointer: `noise/unknown-node` (at the
  reference), `noise/cycle` (at the node that closes it), `noise/arity`, `noise/too-many-octaves`
  (more than 16), `noise/domain-mismatch` (a 4D source in a graph without `"dimensions": 4`),
  `noise/unknown-type`, `noise/invalid-param`, `noise/invalid-node`, `noise/invalid-graph`.
- The importer (`noise`) compiles the graph into a flat **program**: instructions in topological
  order (12 i32 words each) with constants in one Float32Array, plus one **origin term** per source
  octave (below). The artifact is the source JSON, that program, the generated WGSL, and a hash.
  Loading is a copy.
- Domain nodes (`scale`, `translate`) fold into each source's lattice transform at compile time;
  `warp` evaluates `by` once per axis (x with the node's own seeds, y, z, and w with salted ones)
  and adds the displacement to the local position. A node reached under different domains compiles
  once per domain.

### CPU kernel (`crates/shard-noise`)

- A Rust crate with no dependencies (std only for `floor` and `sqrt`, which compile to single wasm
  instructions), built to `wasm32-unknown-unknown` with and without `simd128`. `pnpm build:wasm`
  builds both, and the `.wasm` files are committed in `packages/noise/wasm/` so packages keep no
  build step. `pnpm check:wasm` rebuilds them and fails if they differ (the repo has no CI yet; the
  builds are reproducible byte for byte).
- The kernel interprets a program over blocks of 256 points: registers are one block each, and one
  instruction runs over the whole block before the next, so dispatch is per instruction, not per
  point. Sources loop octave by octave with that octave's constants in registers.
- Lanes are an `F4`/`I4` type: one v128 with `simd128`, arrays of four without. Both backends do the
  same operations in the same order (IEEE `min`/`max`, no fused multiply-add), so the SIMD and scalar
  builds give bitwise-equal results.
- Hashing is integer, with no permutation tables, so every source is seedable without setup: value
  and cellular noise mix the primed lattice coordinates with lowbias32; gradient sources use
  FastNoiseLite's xor of primed coordinates times an odd constant, keeping the product's top bits.
  (A PCG permutation needs per-lane variable shifts, which `simd128` doesn't have.)
- Simplex is OpenSimplex2 on the rotated body-centered-cubic lattice in 3D, and the classic simplex
  lattice in 2D and 4D. Gradient sources are scaled to put their peaks just under 1 and clamped to
  [-1, 1].
- The TS side loads the kernel once per thread, like Rapier and Recast. `kernel.js` and `worker.js`
  (the memory layout, origin splits, and point generators, and the pool job) are plain JavaScript
  with a `.d.ts`, because worker threads import them without a bundler or a TypeScript loader.

### Sampling helpers

```ts
const graph = await NoiseGraph.create(json)       // or a loaded NoiseGraph asset

sampleNoise(graph, seed, points /* xyz… */, out)  // sync, absolute positions
sampleOffset(graph, seed, origin /* f64 */, local /* f32 */, out)
sampleGrid2d(graph, seed, { origin, size, resolution, z? }, out)
sampleSpherePatch(graph, seed, { face, x0, y0, extent, resolution, radius }, out)
sampleNoiseGradient(graph, seed, points, out, dx, dy, dz, h?)
await sampleSpherePatchAsync(platform.workers, graph, seed, patch, out)   // and the other helpers
```

- `sampleSpherePatch` generates points on a cube-sphere face (the tangent-adjusted mapping 0043
  uses; `faceToDirection` and `directionToFace` are exported) and samples `direction × radius` as
  the patch center (f64) plus offsets from it (f32), so terrain CPU and GPU sample the same domain
  points at any radius. `sampleGrid2d` does the same from the grid's center.
- Sync helpers write into caller-owned arrays and allocate nothing once warmed up. They're meant
  for small batches (a raycast's worth); the pool is for chunks. Async helpers split a patch or grid
  by rows across the pool's workers, each job with the whole area's origin, so how a request is split
  never changes a value.
- Every helper takes an optional `node` to sample an intermediate node instead of the output.

### GPU codegen

- `shard::noise` holds the sources and helpers; each graph is a WESL module at `noise::<path>`
  (`assets/noise/planet.noise.json` is `noise::assets::noise::planet`) exporting
  `noise_<name>(p: vec3f, seed: u32) -> f32` (vec4f for 4D graphs). The importer regenerates it;
  `registerNoiseGraph` puts it in a shader library, and a changed graph relinks what imports it.
- Codegen translates the compiled program: one `let` per instruction in program order, octaves
  unrolled, every constant inlined, so the compiler folds everything it can.
- The offset form, `noise_<name>_at(origin: ptr<function, NoiseOrigins_<name>>, local, seed)`, reads
  one `NoiseOrigin { cell: vec4i, frac: vec4f }` record per source octave (32 B each), computed on
  the CPU by `noiseOrigins(graph, origin)`.
- Materials name their graphs at the type level, by path, because a graph is code:
  `project.material('Rock', { …, noise: { detail: 'assets/noise/rock.noise.json' } })` adds
  `noise_detail(p, seed)` to `material::rock`. Draws wait until the graph loads; editing the file
  re-registers the module and relinks the material as soon as the asset reloads.
- `NoiseCompute` (in `@shard/render`) fills a storage buffer over a grid or a sphere patch with the
  offset form, and `noiseComputeNode({ graph, domain: 'grid2d' | 'sphere-patch', next })` runs it
  from the render graph; 0043 dispatches one per chunk. Grids compute their local points in the
  shader; sphere patches upload the same f32 local points `sampleSpherePatch` uses.

### Precision contract

- Inputs and intermediates are f32 on both sides. The WGSL mirrors the kernel operation for
  operation (same constants, same order); the remaining difference is the GPU's fused
  multiply-adds, about an ulp of the lattice position per source.
- Tolerance: `|cpu − gpu| ≤ 1e-5 × (1 + |cpu|)` per sample for every source and operator over 64k
  points spanning a chunk's worth of lattice cells (±4 units at frequencies near 1), checked on
  Dawn in Node. An operator that amplifies its input passes that difference on: a remap with slope
  k or a terrace of sharpness s is checked at k (or 1/(1 − s)) times the tolerance, and a graph at the
  product of its gains. Every test host has a WebGPU adapter (Dawn), so no WGSL-to-JS evaluator was
  needed.
- Sampling an absolute f32 position `p` is only precise near the origin. Past about 10⁵, the
  lattice coordinate `frequency × p` loses the fractional bits that fine octaves depend on. At
  Earth radius, a 0.5 m octave would snap to ~40 cm steps. The plain `p` form is for small domains
  (textures, rocks, previews).

### Origin-offset sampling

Large domains are sampled as `origin + local`: `origin` is an f64 point (a chunk's center),
and `local` is a small f32 offset from it.

- Each source octave has an origin term: `a` (frequency × the domain scale above it, as f32
  values), `b` (frequency × the domain offset, f64), and its skew. For an origin, TS computes the
  octave's lattice position `skew(a × origin + b)` in f64 and splits it into an integer cell `I`
  (i32 per axis) and a fraction `F` (f32). That's one 32-byte record per octave, a few hundred
  bytes per chunk. The same records go to the kernel and to the GPU, so both compute the same
  numbers.
- The source then evaluates at lattice coordinate `I + (F + skew(a × local))`, adding the integer
  part of the sum to `I` in integer math before hashing. Every number the sampler sees is small, so
  precision depends only on `local`'s size (a chunk), not on where the chunk is.
- Domain warp adds its displacement to the local part. Nothing else in the graph sees positions.
- `I` must fit in i32: `frequency × |origin| < 2³¹`. That allows 2 cm features on a 4×10⁷ m
  planet, or 20 cm features at gas-giant radius. With `extent` set, the importer rejects finer
  octaves with `noise/frequency-too-high`; sampling past the range throws the same code.
- Galaxy-scale sampling (0046 density) uses scaled coordinates. Star density is smooth, so it
  doesn't need offsets.

### Worker pool

```ts
// @shard/platform
interface Workers {
  readonly size: number
  run<T>(module: string, fn: string, args: readonly unknown[],
         options?: { transfer?: readonly ArrayBuffer[]; priority?: 'high' | 'normal' }): Promise<T>
  dispose(): void
}
```

- `platform.workers` is made on first use with `hardwareConcurrency − 1` workers (min 1, max 8;
  `workers` in the platform options overrides it). Each worker runs a small host script that imports
  job modules by URL on first use. Web and Tauri use module web workers from a blob URL; Node and
  the headless CLI use `worker_threads`, unref'd while idle so commands exit. Typed arrays in a
  result move back instead of being copied; the compiled `WebAssembly.Module` is posted with each
  noise job and instantiated once per worker.
- Jobs are FIFO with a priority lane, one per worker at a time. `run` rejects with
  `platform/worker-crashed` if a worker dies (the pool replaces it), with the job's own error code
  if it throws, and with `platform/workers-disposed` after `dispose`.
- Determinism: results never depend on which worker ran a job or in what order jobs finish.
  Callers apply results in request order when order matters (0043 applies chunks by key).
- A pool of size 0 (`createInlineWorkers`, or `workers: 0`) runs jobs inline on the calling thread,
  and `workersOf(platform)` falls back to one on hosts without threads, so every consumer works
  either way.

### Core additions

- `hashSeed(seed: u32, label: string | u32): u32`: the mix `Rng.fork` always used (FNV-1a of the
  label multiplied into the seed), made public; `Rng.fork` now calls it, and fork seeds are
  unchanged. Numeric labels hash as four little-endian bytes, which the kernel and WGSL mirror.
- `hash32(seed, x, y?, z?, w?)`: the kernel's lattice hash of an integer cell, for generators that
  need per-cell decisions consistent with the noise. Fixed arity, so it doesn't allocate.

### Engine changes

- `ShaderLibrary` relinks the variants already in use as soon as a module changes (batched in a
  microtask) instead of at their next request, and material pipelines keep drawing with the
  previous pipeline while a replacement compiles. An edited shader or noise graph shows up within
  two frames with no blank frame in between.
- `asset.preview` takes type-specific `options`, passed to the type's preview function.

### Agent surface

- `.shard/schemas/noise.schema.json`, with every node type documented (what it does, its range,
  an example).
- `asset.preview` of a `NoiseGraph` renders grayscale, black at its minimum and white at its
  maximum (default 256², plane domain), with options `{ domain: 'plane' | 'sphere', seed, size,
  node }`. `node` previews an intermediate node, so an agent can see what `mask` looks like alone.
- `noise.sample { graph, seed, points, origin?, node? }` returns values (≤ 4 096 points); `graph`
  may be inline JSON, to try an edit before saving. `noise.stats { graph, seed, domain, thresholds }`
  returns min, max, mean, stdDev, a 16-bin histogram, and the fraction below each threshold, with
  sphere samples weighted by area. An agent can check "is 30% of this planet underwater" numerically.
- MCP tools: `preview_noise`, `sample_noise`, `noise_stats`.
- A generated skill, `make-a-noise-graph.md`: layering continents, ridges, and masks, and reading
  the stats.
- **Errors:** `noise/cycle`, `noise/unknown-node`, `noise/arity`, `noise/too-many-octaves`,
  `noise/domain-mismatch`, `noise/frequency-too-high`, `noise/unknown-type`, `noise/invalid-param`,
  `noise/kernel-not-loaded`, `platform/worker-crashed`, `render/noise-graph-missing`.

## Decisions

- **Graphs as data, compiled twice.** One JSON source gives the CPU and GPU the same function. It
  is also exactly the thing agents are good at editing.
- **CPU is canonical.** Gameplay and headless tests can't depend on GPU availability or vendor
  float behavior. The GPU is for volume, the CPU for truth.
- **Rust WASM kernel with committed `.wasm`.** The TS packages stay build-free. The same kernel runs
  in Node, browsers and Tauri, as VISION intended for `crates/`.
- **Instruction-at-a-time batches.** Interpreting per point would cost a dispatch per node per
  sample. Per batch, the dispatch cost disappears and the inner loops vectorize.
- **Origin offsets instead of f64 on the GPU.** WGSL has no portable f64. Splitting each
  source's lattice position into an integer and a fraction on the CPU costs a few bytes per chunk
  and makes precision independent of planet size. The split is done once, in TS, for both sides.
- **Integer hashing instead of permutation tables.** Seeding is free and there's no table to keep
  in sync between Rust and WGSL.
- **The pool lives in the platform layer.** Noise is the first consumer, generators (0042) and
  terrain (0043) are next, and only platform packages may touch host threading APIs.
- **Material graphs per type, not per material.** A graph compiles to shader code, so choosing one
  per material would compile a pipeline per material; materials vary seeds and scales instead.
- **Render depends on noise.** Material slots and the compute helper need the render graph and the
  material system, so they live in `@shard/render`; `@shard/noise` stays free of render.

## Acceptance criteria

- [x] Each source's output over 1M points has the documented range (simplex, Perlin, and value in
      [−1, 1]) and a mean within 0.02 of its documented mean (zero for value, Perlin, simplex, and
      cell values; the cellular distances' means are documented per variant), and the same seed gives
      the same values on Node, Chrome, and Tauri (bitwise, CPU): the tests pin a checksum, the
      playground's `#noise` page shows the same one (and the same stats) in Chrome, and SIMD and
      scalar builds agree bitwise. Tauri runs the same `.wasm` in its webview; that wasn't checked
      separately.
- [x] For every node type, GPU codegen and CPU agree within `1e-5 × (1 + |cpu|)` over 64k points
      (times the slope gain for amplifying operators, as above).
- [x] The CPU kernel samples a 6-octave fBm simplex 3D graph at ≥ 40M points/s per core with SIMD
      (bench: 40–42M on the bench machine, 40.2M in Chrome), and allocates nothing per call once
      warmed up.
- [x] `sampleSpherePatch` of a 257² patch on the pool completes in ≤ 8 ms for the planet graph
      above on the bench machine (about 2 ms on 8 workers; 3 ms on web workers in Chrome), with the
      main thread blocked for ≤ 0.2 ms (about 0.05 ms).
- [x] Editing a `.noise.json` in `shard dev` re-imports it, regenerates the WGSL, and a material
      using it re-renders within two frames.
- [x] A cycle, an unknown node, and 20 octaves each fail validation with their code and a pointer
      to the node.
- [x] `asset.preview` of the example graph matches a golden PNG, and `noise.stats` reports the same
      numbers headless and in a browser.
- [x] With `platform.workers` of size 0, all noise tests pass inline.
- [x] Origin-offset sampling of a 0.5 m-wavelength octave at 7×10⁷ m from the origin matches a
      test-only f64 reference evaluator within the normal tolerance, on CPU and GPU, over a chunk
      (±4 m). Plain f32 sampling at that distance fails the same test, which documents why offsets
      exist.

## Open questions

- None blocking. Deferred: a Studio graph editor, curl noise, and 4D looping noise for animated
  textures (the source exists; the helpers don't).
