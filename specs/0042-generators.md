# 0042 — Generators as assets

- **Status:** implemented
- **Packages:** `@aethervtt/shard-procgen` (new), `@aethervtt/shard-assets`, `@aethervtt/shard-scene`, `@aethervtt/shard-save`,
  `@aethervtt/shard-noise`, `@aethervtt/shard-project`, `@aethervtt/shard-node`, `@aethervtt/shard-protocol`, `@aethervtt/shard-cli`
- **Depends on:** 0010, 0014, 0017, 0030, 0031, 0041

## Context

VISION's fifth principle is that procedural is the default medium. An agent is good at describing
rules and parameters and bad at placing 10 000 rocks by hand. Today "procedural" means eight mesh
primitives behind `procedural:` refs in scene files (0010). M7 needs generators that projects
write: a rock mesh from a seed, a biome texture, a star system's entities, a creature's skeleton.

A generator is a pure function, `(seed, params) → output`, where the output is a mesh, a texture,
a data value, or a tree of entities. Because it's pure, its output can be cached by the hash of its
inputs. A planet looks the same every visit, and an agent can change one parameter and compare
before and after. The asset database already has content-addressed caching, dependency
invalidation, and hot reload, so a generator is an importer whose "source file" is its parameters.

## Goals

- `project.generator(name, { params, output, run })` in `scripts/`. `params` is a component
  schema. `output` is `'mesh' | 'texture' | 'data' | 'entities'` (or a data type).
- Generator files, `generators/**/*.gen.json`: generator, seed, and params, validated by the
  generator's schema, imported and cached like any asset, and usable anywhere a handle of the
  output type is.
- `procedural:` refs extended to project generators (`procedural:star-explorer/Rock?seed=3`).
- Runtime generation, `generate(world, gen, params, seed)`, for things a game makes on the fly
  (one planet per star), with an in-memory LRU and an on-disk cache keyed by input hash.
- `GeneratorInstance` in scenes and prefabs: spawns an entities-output generator's result as
  children and regenerates when its inputs change.
- Generators run on the worker pool (0041) and are deterministic: seeded RNG and noise only, with
  wall clock and `Math.random` unavailable.
- Composition: a generator can call another (`ctx.generate`), which becomes a cache dependency.
- Agents can run, preview, and compare generators by seed and parameter without writing a scene.

## Non-goals

- Wave function collapse, L-systems, and dungeon generators (later; they're generators written
  on top of this).
- Generators that read the running world (they're pure; games pass what they need as params).
- GPU generators as a separate kind. A generator can dispatch compute through `ctx.gpu` when a
  GPU exists, but its CPU result must be what gameplay uses (0041's rule).
- Studio graph UI for generators.

## Design

### Defining a generator

```ts
// scripts/rock.ts
export const Rock = project.generator('Rock', {
  params: {
    radius: t.f32({ default: 1, min: 0.05, unit: 'm' }),
    roughness: t.f32({ default: 0.3, min: 0, max: 1 }),
    detail: t.u8({ default: 3, min: 0, max: 6 }),
    shape: t.handle('NoiseGraph'),
  },
  output: 'mesh',
  version: 1,
  run(ctx, p) {
    const mesh = ctx.mesh.icosphere(p.detail)
    const shape = ctx.load(p.shape)                   // a dependency: editing it regenerates
    displaceAlongNormals(mesh, shape, ctx.seed, p.radius, p.roughness)
    return ctx.mesh.finish(mesh, { tangents: true, lods: [0.5, 0.2] })
  },
})
```

- The name is namespaced (`star-explorer/Rock`). Engine packages define theirs with
  `defineGenerator` from `@aethervtt/shard-procgen` (`shard/Rock`, `shard/Tree`, … in 0045).
  `project.generator('Rock', …)` needs `project` in scope, and a module the entry imports can't
  import the entry back (ES module cycles evaluate it first). So a generator in its own module
  calls `defineGenerator('star-explorer/Rock', …)`, as the example's `scripts/rock.ts` does.
- A generator is also a reference to itself (`{ type: 'Generator', guid, path: name }`), so it goes
  straight into a `t.handle('Generator')` field. `procgen.describe` lists every generator.
- `run(ctx, params)` returns the output synchronously, or a promise when it awaits `ctx.generate`
  or `ctx.gpu`.
- Output types:
  - `mesh`: `MeshData`, plus optional LOD meshes, becoming a `Mesh` asset with sub-assets.
  - `texture`: a `TextureData` (0016 `Texture.create` shape) with any format the texture package
    supports.
  - `data`: a value of a data type (0031), e.g. `output: StarSystemInfo`.
  - `entities`: a **fragment**, the same shape as a prefab file's entity tree (0030), with
    components by name, children, and asset handles. Handles may point at other generators'
    outputs through `ctx.generate` results. It's the root entity (whose components merge into the
    instance) or a list of children. It loads as a `Prefab`, and components are checked against
    their schemas (`procgen/output-mismatch` with a pointer).
  - `data` without a type is any JSON value, loading as a `Data` asset.
  - `audio` (added by 0050): PCM channels plus an optional loop range, becoming an `AudioClip`.

### The context

```ts
interface GenContext {
  readonly seed: u32
  rng: Rng                                 // seeded from hashSeed(seed, generatorName)
  childSeed(label: string | u32): u32      // hashSeed(seed, label): stable per label
  noise: NoiseApi                          // 0041, sync, on this worker
  load<T>(ref: AssetRef<T>): T             // declared deps, preloaded before run
  generate<T>(gen: Generator<T>, params, seed): Promise<AssetRef<T>>
  mesh: MeshBuilderApi                     // 0045 grows this; 0042 ships the builder basics
  gpu?: GpuGenApi                          // absent headless; results must not be canonical
  warn(message: string, path?: string): void
}
```

- **Determinism** is enforced where it's cheap. The worker runs generator code with `Math.random`,
  `Date.now`, and `performance.now` replaced by functions that throw
  `procgen/nondeterministic`, and `ctx.rng` is the only randomness. Inline (no worker module) the
  guard covers `run`'s synchronous part, because the main thread keeps running between awaits.
  `shard check` flags those calls statically in modules that define generators. `ctx.mesh` builds
  with `+ * sqrt` only (no trig), so a mesh is the same bytes in V8 and WebKit.
- `ctx.load` only accepts handles that appear in `params` (or constants in the generator
  definition). They're preloaded on the main thread and passed in, so a generator never does I/O.
- `ctx.generate` records `(generator, params, seed)` as a child and returns its reference right
  away, without waiting for it. The reference is the child's identity (see *Where outputs live*),
  not its content, so a parent's output doesn't depend on its children's bytes. The child is made
  when something loads it and is cached on its own. A star system asking for eight planets makes
  eight entries, and changing one planet's params re-runs the system and that planet only (the
  other seven are cache hits). A child whose code changes regenerates alone, and the system's
  cached fragment still points at it.
- `ctx.gpu` is absent in this implementation: generators run on the CPU everywhere.

### Cache keys

`key = sha256(generatorName, version, codeHash, canonical(params), seed, depHashes)`

This is the content key. Each output also has an **identity**, the hash of `(generatorName,
canonical(params), seed)`, and is registered as the virtual asset `gen:<identity>` (sub-assets
`gen:<identity>/LOD1`). Code and dependency changes swap the content behind an identity in place,
so everything holding the handle sees the new mesh.

- `codeHash` is the hash of the generator's module and everything it imports inside `scripts/`,
  taken from the bundler's module graph (0017). Editing a helper that `Rock` uses regenerates
  every rock; editing an unrelated script doesn't. The entry and the module that calls
  `defineProject` are left out (with what only they import), since every module reaches them
  through `project`. Hosts without a module graph fall back to hashing `run`'s source text.
- `canonical(params)` is the normalized value with defaults filled in, keys sorted, and floats
  written at f32 precision, so `1` and `1.0000000001` hit the same entry. Handles are their path
  (guids differ between copies of a project).
- `depHashes` are the artifact hashes of loaded assets (the handles in `params`). Nested
  generators aren't part of the key (see *The context*).
- `version` is a manual bump for changes the hash can't see (a vendored table, say).

### Where outputs live

- **Generator files** (`*.gen.json`) are imported by the `procgen` importer. The artifact is the
  output in its type's normal artifact format (mesh codec, texture, JSON), stored in the
  content-addressed cache (0014). Their GUIDs and handles work everywhere, so a prefab can use
  `{ "path": "generators/rocks/boulder.gen.json" }` as its mesh (and `#LOD1` for a level of
  detail). `generators/` is a default asset root. A `#Generator` sub-asset holds the generator,
  seed, and params, for `GeneratorInstance`. Two additions to the asset server make this work:
  `ImportContext.asset(path)` waits for another source's import in the same scan and records its
  source and `.meta` as dependencies (the `NoiseGraph` a rock loads). `ImportContext.depend(id,
  hash)` records a non-file input (`generator:<name>`, its version and code hash), checked on
  every scan through `defineImportDependency`.
- **`procedural:` refs** now resolve project and engine generators by name, with params in the
  query string (numbers, bools, and asset paths; structs and lists as URL-encoded JSON) and
  `seed`. A ref is the output's identity, so equal canonical params are one asset, and it's the
  `path` of every `gen:` asset (floats written as the shortest decimal of the same f32). That
  way a fragment's handles resolve in any process. `procedural:box?size=2` keeps working
  unchanged. Scenes resolve them through `defineProceduralSource`. The catalog resolves them,
  and generators by name, through `defineAssetResolver`.
- **Runtime** `generate()` results are virtual assets (`gen:<identity>`) with the same store and
  reachability unloading as other assets (`collect` unloads unreachable ones, and they're made
  again on the next load). On hosts that can write the project, records are written to
  `.shard/cache/generated/<2>/<key>` (one file: a JSON header and the artifacts' bytes). On
  other hosts they go to platform storage (IndexedDB) with a size cap. An LRU of 256 MB
  (`shard.json` `procgen.cacheSize`, in MB) bounds memory. Virtual assets may be made
  asynchronously now: an async `create` leaves the entry `loading`, `load` waits for it, and a
  reload keeps the old object until the new one is ready.

### GeneratorInstance

```ts
GeneratorInstance { generator: handle('Generator'), seed: u32, params: json, overrides: json }
```

- On an entity, an `entities` generator's fragment is spawned as its children, as
  `SceneInstance`/`PrefabInstance` do (0030). Children are marked `procgen/Generated` and aren't
  saved into scene files; saves (0038) record only the instance and any runtime changes to the
  children as diffs.
- `params` is validated against the generator's schema at load and on patch
  (`procgen/bad-params`). Changing `seed` or `params` regenerates, replacing the children and
  keeping entities whose fragment path is unchanged, so references to them survive.
- `generator` can point at a generator by name (`{ "generator": { "path": "star-explorer/StarSystem" } }`)
  or at a generator file's `#Generator` (`{ "path": "generators/sol.gen.json#Generator" }`), whose
  seed and params act as defaults the instance overrides. A `seed` of 0 means the file's seed.
- It's a third kind of scene instance next to SceneInstance and PrefabInstance
  (`defineInstanceKind` in `@aethervtt/shard-scene`). Kinds say whether respawns keep entity ids (this one
  does) and whether they run on generated entities too. This one does, so a galaxy fragment can
  hold lazy `GeneratorInstance`s for its systems. Saves and scene files write `overrides` for
  every kind.

### Hot reload

A script reload with a changed `codeHash` invalidates that generator's entries. Loaded outputs
regenerate in the background, and each swaps in place when ready (meshes and textures update
their object, as imported assets do; instances respawn their children). The reload report lists
them under `procgen.regenerated`.

### API sketch

```ts
import { generate, GeneratorInstance } from '@aethervtt/shard-procgen'

const mesh = await generate(world, Rock, { radius: 2, roughness: 0.6 }, 42)   // AssetRef<Mesh>
world.spawn(Mesh3d({ mesh }), MeshMaterial({ material: stone }), Transform())

world.spawn(GeneratorInstance({ generator: StarSystem, seed: starSeed, params: { … } }))
```

### Agent surface

- `.shard/schemas/gen.schema.json` covers generator files, with `params` switching schema by
  `generator` (a `oneOf` per generator), so editors and agents validate params before import.
- `.agents/generators.md` lists each generator: its params with units and ranges, its output,
  and an example file. `shard docs` regenerates it when scripts change.
- `procgen.run { generator, params, seed }` returns a summary: output type, key, time, cache hit,
  vertex and triangle counts or texture size, bounds, entity counts by component, and warnings.
- `procgen.preview { generator, params, seed, seeds?: "1-9" | [..], size }` returns a PNG
  (`generator` is a name, a unique short name, or a `*.gen.json` path). Meshes
  render in a neutral studio setup from a three-quarter view, textures show as-is, entities render
  as a scene framed on their bounds, and `seeds` lays out a contact sheet with labels. This is the
  main loop for tuning a generator: change a param, preview nine seeds, compare.
- `procgen.describe` lists generators, cache stats, and in-flight jobs.
- CLI: `shard gen <generator|file> [--seed N | --seeds 1-9] [--param k=v] [--size 256] --out sheet.png`,
  plus `--json` for the summaries (`scripts:Rock` names the project's `Rock`). `shard validate`
  validates every `*.gen.json` against its generator (an import error with a pointer).
- MCP tools: `run_generator`, `preview_generator`, `describe_generators`.
- A generated skill, `make-a-generator.md`: define params, write `run`, preview seeds, place it
  with a `.gen.json` or `GeneratorInstance`.
- **Errors:** `procgen/unknown-generator`, `procgen/bad-params`, `procgen/nondeterministic`,
  `procgen/output-mismatch` (run returned the wrong output type), `procgen/generator-failed`
  (wraps a thrown error with the generator, seed, and params), `procgen/cycle` (a generator that
  generates itself with the same inputs).

## Decisions

- **A generator is an importer whose source is its parameters.** Caching, invalidation, hot reload,
  GUIDs, and reachability all come from 0014 instead of a second system.
- **Pure functions with enforced determinism.** Cache keys are only valid if the same inputs give the same
  output. Throwing on `Math.random` catches the common mistake at the first run, not after a
  cache poisoning.
- **Code hash from the module graph.** A manual version alone goes stale silently, and hashing all
  scripts regenerates everything on every edit.
- **Entity output is a prefab-shaped fragment.** Spawning, overrides, saving, and hot reload are
  already solved for prefabs. A generator doesn't get its own entity-creation API.
- **Workers by default.** Generation is the work most likely to hitch a frame. Running it off
  the main thread from day one keeps generators honest about purity too. Worker threads load
  plain modules, and project code imports `@aethervtt/shard-*`. So Node hosts (`openProject`, the CLI,
  `shard dev`) bundle the project with `@aethervtt/shard-procgen/worker` into one self-contained module
  (`.shard/build/procgen-worker.<hash>.mjs`, the engine inlined) and hand its URL to
  `configureProcgenHost`. The playground points it at a Vite-served module instead. Without a
  worker module, jobs run inline after an await. Dependencies travel as artifacts, and the noise
  kernel as its compiled module. After a hot reload the bundle rebuilds in the background (jobs
  wait for it) only if a generator's code hash changed. Otherwise the last one still runs the same
  generator code. So an `entities` output from a worker is checked against the component schemas
  on the main thread, which has the current ones.
- **Outputs are identities; content is keyed.** A handle to `gen:<identity>` stays valid while its
  content changes, which is what hot reload and GeneratorInstance respawns need. Keying parents
  by their children's content would make every child edit re-run the parent for nothing.
- **Main-thread work is sliced.** Posting jobs (at most two per worker in flight), hashing inputs,
  and turning results into assets each wait for a turn. Turns run back to back for about 0.5 ms,
  then yield to the event loop. Results come back as one packed buffer that moves from the worker
  and is written to the disk cache as is.

## Acceptance criteria

- [x] A project `Rock` generator imported from `generators/boulder.gen.json` yields a `Mesh`
      usable by a prefab. Its bytes are identical across Node, Chrome, and Tauri for the same seed.
      (Node inline and on the pool, and the playground's `#procgen` checksum in Chrome. Tauri runs
      the same web build; its WebKit run is still to do.)
- [x] A second import with unchanged inputs is a cache hit (no `run` call). Editing a param,
      the seed, a helper module `Rock` imports, or its `NoiseGraph` each re-runs it. Editing an
      unrelated script does not.
- [x] `Math.random()` in a generator fails with `procgen/nondeterministic`, naming the generator,
      and `shard check` reports the call site.
- [x] `procedural:star-explorer/Rock?seed=3&radius=2` in a scene resolves, and two refs with the
      same canonical params share one asset.
- [x] A `GeneratorInstance` with an `entities` generator spawns its fragment. Patching `seed` over
      the protocol regenerates within one frame of the job completing, keeping unchanged
      entities' ids.
- [x] A star-system-shaped generator that `ctx.generate`s eight children re-runs only the changed
      child and the parent when one child's params change.
- [x] Generating 200 rock meshes (detail 4) on the pool keeps every frame under 2 ms of main-thread
      procgen work in the bench. (Steady state: after workers start and the result path is
      compiled, with GC pauses subtracted. Node tests run without incremental marking so GC is
      reported as pauses.)
- [x] `shard gen scripts:Rock --seeds 1-9 --out sheet.png` writes a 3×3 labeled contact sheet that
      matches a golden, and `--json` reports keys and cache hits.
- [x] A save of a scene with a `GeneratorInstance` contains the instance and no generated
      children, and loading it reproduces the same world hash. (By scene path: entity ids are
      reused differently after a load, as in 0038's tests. Runtime changes to children come back
      as the instance's overrides.)

## Open questions

- Should `entities` fragments be allowed to contain nested `GeneratorInstance`s that generate
  lazily (a galaxy of systems of planets), or must nesting go through `ctx.generate`? Decided:
  both. The GeneratorInstance kind runs on generated entities, so nested instances are lazy.
- None blocking. Deferred: a disk-cache eviction policy beyond LRU by size, and sharing the
  generated cache between machines.
