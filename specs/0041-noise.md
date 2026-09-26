# 0041 — Noise library

- **Status:** accepted
- **Packages:** `@shard/noise` (new), `@shard/core`, `@shard/platform`, `@shard/platform-web`,
  `@shard/platform-node`, `@shard/platform-tauri`, `@shard/shader`, `crates/shard-noise` (new)
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

- Sources: value, Perlin (gradient), OpenSimplex2 (2D, 3D, 4D), and cellular/Worley (F1, F2,
  F2−F1, cell value; Euclidean, Manhattan, Chebyshev), all seeded by a u32.
- Fractals and operators: fBm, ridged, billow, domain warp, add/multiply/min/max/lerp/select,
  remap, clamp, curve (piecewise-linear table), terrace, abs, power, constant, and scale/translate
  of the input. 0047 adds `craters`.
- `NoiseGraph` as a data asset (`*.noise.json`), validated, hot reloaded, and previewable.
- A CPU kernel in Rust compiled to WASM, which evaluates a graph over batches of points (arrays in,
  array out), with SIMD where the host supports it.
- A WGSL code generator: a graph becomes a module exporting `fn <name>(p: vec3f) -> f32`, usable
  from materials (0020), compute passes, and particle shaders through normal `#import`s.
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
- Analytic derivatives on the GPU path in v1 (the CPU kernel returns them; the GPU computes normals
  by finite differences, which 0043 already needs for chunk borders).
- Curl noise and flow noise for particles (later, on the same sources).

## Design

### Noise graph files

```json
{
  "$schema": "../../.shard/schemas/noise.schema.json",
  "output": "height",
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
- Each node's schema comes from one table in `@shard/noise`: the JSON Schema, the TS validator,
  the WASM opcode layout, and the WGSL codegen all read it. Adding an operator is one table entry
  plus a Rust and a WGSL function.
- Graph seeds are per source node and mixed with the seed the graph is evaluated with:
  `hashSeed(evalSeed, node.seed)`. The same graph gives a different planet per planet seed, and
  changing one node's seed changes only that layer.
- Validation: unknown node, cycle (`noise/cycle`), wrong arity, a 4D source fed a 3D domain, an
  octave count over 16 (`noise/too-many-octaves`). Errors carry a JSON pointer.
- The importer (`noise`) compiles the graph into a flat **program**: a topologically sorted
  instruction list with constants in one Float32Array. The artifact is that program, plus the
  generated WGSL text and a hash. Loading is a copy.

### CPU kernel (`crates/shard-noise`)

- A Rust crate with no dependencies beyond `core`, built to `wasm32-unknown-unknown` with and
  without `simd128`. `pnpm build:wasm` builds both, and the `.wasm` files are committed in
  `packages/noise/wasm/` so packages keep no build step. A CI check rebuilds and diffs them.
- The kernel interprets a program over a batch: `eval(program, xs, ys, zs, ws?, out, count)`. It
  works on columns in structure-of-arrays form, one instruction over the whole batch at a time
  (with registers in WASM memory), so the interpreter's dispatch is per instruction, not per
  point. That is how it gets near-native speed without JIT.
- Hashing is integer (a PCG-style 32-bit permutation of lattice coordinates and seed), with no
  permutation tables, so every source is seedable without per-seed setup.
- Optional outputs: gradient per point (`out, dx, dy, dz`) for sources and linear operators, used
  for CPU normals and slope masks.
- The TS side (`@shard/noise`) loads the kernel once per thread, like Rapier and Recast today, and
  exposes a sync API on the calling thread plus an async API through the pool.

### Sampling helpers

```ts
const graph = await assets.load(NoiseGraph, 'noise/planet.noise.json')

sampleNoise(graph, seed, points: Float32Array /* xyz… */, out: Float32Array): void  // sync
sampleGrid2d(graph, seed, { origin, size, resolution }, out): void
sampleSpherePatch(graph, seed, { face, x0, y0, extent, resolution, radius }, out): void
sampleOffset(graph, seed, origin: Float64Array, local: Float32Array, out): void  // see below
await noise.sampleAsync(graph, seed, points, out)     // on the worker pool; transfers buffers
```

- `sampleSpherePatch` generates points on a cube-sphere face (same mapping as 0043) and samples at
  `direction × radius`, split into the patch center (f64) and offsets from it (f32), so terrain CPU
  and GPU sample the same domain points at any radius.
- All helpers write into caller-owned arrays and never allocate per point. Sync calls on the main
  thread are meant for small batches (a raycast's worth), and the pool is for chunks.

### GPU codegen

- `graph.wgsl` is a module (0006) named `noise/<asset path>` that exports
  `fn noise_<name>(p: vec3f, seed: u32) -> f32` and shares a common `shard::noise` module with the
  sources. It's regenerated on import and hot reloads shaders that import it.
- Codegen emits straight-line WGSL, not an interpreter: nodes become `let` bindings in
  topological order, and octave loops stay loops with constant bounds. Inline constants make the
  compiler fold everything it can.
- Materials use it through a new `noise` field: `project.material('Rock', { …,
  noise: { detail: handle('NoiseGraph') } })` makes `noise_detail` available in hooks.
- A standard compute helper, `noiseComputeNode({ graph, domain: 'grid2d' | 'sphere-patch',
  out: storageBuffer })`, is what 0043 dispatches per chunk.
- Generated functions also have an offset form, `noise_<name>_at(origin: ptr<NoiseOrigin>,
  local: vec3f, seed: u32)`, which reads the per-source lattice offsets described below.

### Precision contract

- Inputs and intermediates are f32 on both sides. The CPU uses Rust's non-fused arithmetic in a
  fixed order that the WGSL mirrors.
- Tolerance: `|cpu − gpu| ≤ 1e-5 × (1 + |cpu|)` per sample for every source and operator, checked
  by a GPU test over 64k random points per node type on each CI GPU. Where the host has no GPU,
  the codegen runs through a WGSL-to-JS reference evaluator in tests to catch codegen bugs.
- Sampling an absolute f32 position `p` is only precise near the origin. Past about 10⁵, the
  lattice coordinate `frequency × p` loses the fractional bits that fine octaves depend on. At
  Earth radius, a 0.5 m octave would snap to ~40 cm steps. The plain `p` form is for small domains
  (textures, rocks, previews).

### Origin-offset sampling

Large domains are sampled as `origin + local`: `origin` is an f64 point (a chunk's center),
and `local` is a small f32 offset from it.

- For each source node, the CPU computes the source's lattice position of `origin` in f64:
  `frequency × transform(origin)`, which is skewed for simplex and passed through any domain
  scale, rotate, or translate nodes above the source. It splits that into an integer part `I`
  (three i32) and a fraction `F` (three f32). That's one `NoiseOrigin` record per source, 24 B
  each, a few hundred bytes per chunk for a big graph.
- The source then evaluates at lattice coordinate `I + (F + frequency × local)`. The float part
  stays small, and `floor` of it is added to `I` in integer math before hashing. Every number the
  sampler sees is small, so precision depends only on `local`'s size (a chunk), not on where the
  chunk is.
- Domain warp adds its displacement to the `local` part, since warp amounts are small. Nothing
  else in the graph sees positions.
- `I` must fit in i32: `frequency × |origin| < 2³¹`. That allows 2 cm features on a 4×10⁷ m
  planet, or 20 cm features at gas-giant radius. Past that, the importer rejects the graph with
  `noise/frequency-too-high` for the planet's radius. Octaves that fine are invisible from
  anywhere they'd apply.
- The CPU kernel does the same split with a native f64 `origin`, so CPU and GPU compute the same
  numbers, and the tolerance above holds at any planet size.
- Galaxy-scale sampling (0046 density) uses scaled coordinates. Star density is smooth, so it
  doesn't need offsets.

### Worker pool

```ts
// @shard/platform
interface Workers {
  readonly size: number
  run<T>(module: string, fn: string, args: unknown[], transfer?: Transferable[]): Promise<T>
}
```

- `platform.workers` is created lazily with `hardwareConcurrency − 1` workers (min 1, max 8).
  Each worker loads modules on first use, and `@shard/noise` registers its entry module. Web uses
  module workers. Node and headless CLI use `worker_threads`. Tauri uses web workers in the webview.
- Jobs are FIFO with a priority lane. `run` rejects with `platform/worker-crashed` if a worker
  dies, and the pool respawns it.
- Determinism: results never depend on which worker ran a job or in what order jobs finish.
  Callers apply results in request order when order matters (0043 applies chunks by key, not
  arrival).
- `platform.workers` of size 0 (tests that disable it) runs jobs inline on the calling thread, so
  every consumer works either way.

### Core additions

- `hashSeed(seed: u32, label: string | u32): u32`, which is the FNV-1a + finalizer already inside
  `Rng.fork`, made public so noise, generators, and systems derive child seeds the same way.
- `hash32(...values: u32)` for lattice-style integer hashing in TS where a generator needs it.

### Agent surface

- `.shard/schemas/noise.schema.json`, with every node type documented (what it does, its range,
  typical parameter values).
- `asset.preview` of a `NoiseGraph` renders a grayscale PNG (default 256², plane domain), with
  options `{ domain: 'plane' | 'sphere', seed, size, node }`. `node` previews an intermediate
  node, so an agent can see what `mask` looks like on its own.
- `noise.sample { graph, seed, points }` returns values (≤ 4 096 points), and
  `noise.stats { graph, seed, domain }` returns min, max, mean, and a histogram. An agent can
  check "is 30% of this planet underwater" numerically instead of by eye.
- MCP tools: `preview_noise`, `sample_noise`, `noise_stats`.
- A generated skill, `make-a-noise-graph.md`: layering continents, ridges, and masks, and reading
  the stats.
- **Errors:** `noise/cycle`, `noise/unknown-node`, `noise/arity`, `noise/too-many-octaves`,
  `noise/domain-mismatch`, `noise/frequency-too-high`, `platform/worker-crashed`.

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
  and makes precision independent of planet size.
- **Integer hashing instead of permutation tables.** Seeding is free and there's no table to keep
  in sync between Rust and WGSL.
- **The pool lives in the platform layer.** Noise is the first consumer, generators (0042) and
  terrain (0043) are next, and only platform packages may touch host threading APIs.

## Acceptance criteria

- [ ] Each source's output over 1M points has the documented range (e.g. simplex in [−1, 1]) and
      mean within 0.02 of zero, and the same seed gives the same values on Node, Chrome, and Tauri
      (bitwise, CPU).
- [ ] For every node type, GPU codegen and CPU agree within `1e-5 × (1 + |cpu|)` over 64k points.
- [ ] The CPU kernel samples a 6-octave fBm simplex 3D graph at ≥ 40M points/s per core with SIMD
      (bench), and allocates nothing per call once warmed up.
- [ ] `sampleSpherePatch` of a 257² patch on the pool completes in ≤ 8 ms for the planet graph
      above on the bench machine, with the main thread blocked for ≤ 0.2 ms.
- [ ] Editing a `.noise.json` in `shard dev` re-imports it, regenerates the WGSL, and a material
      using it re-renders within two frames.
- [ ] A cycle, an unknown node, and 20 octaves each fail validation with their code and a pointer
      to the node.
- [ ] `asset.preview` of the example graph matches a golden PNG, and `noise.stats` reports the same
      numbers headless and in a browser.
- [ ] With `platform.workers` of size 0, all noise tests pass inline.
- [ ] Origin-offset sampling of a 0.5 m-wavelength octave at 7×10⁷ m from the origin matches a
      test-only f64 reference evaluator within the normal tolerance, on CPU and GPU. Plain f32
      sampling at that distance fails the same test, which documents why offsets exist.

## Open questions

- None blocking. Deferred: a Studio graph editor, curl noise, and 4D looping noise for animated
  textures (the source exists; the helpers don't).
