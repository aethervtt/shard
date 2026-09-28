# 0056 — Modular builds and size budgets

- **Status:** implemented
- **Packages:** every `@aethervtt/shard-*` package, `apps/playground`, `bench/size` (new)
- **Depends on:** 0005, 0007, 0017

## Context

A Shard browser build isn't small, and nobody measures it. The playground imports every plugin and
ships a 1.13 MB entry, a 657 KB shared chunk, 2.85 MB and 2.1 MB Rapier chunks (the compat builds
inline their WASM as base64), 726 KB of Recast, and 4.3 MB of Basis WASM. That isn't a fair
renderer-only comparison with three.js, but it means "smaller than three" is unproven.

Two things stop a small app from getting a small build. First, packages register things when
imported: `defineImporter`, `defineAssetType`, `defineOverlay`, `setStandardFields`, and bare
`import './preview'`. None of them declares `"sideEffects"`, so bundlers keep everything that's
imported. Second, `forwardPlugin.ready` installs every render feature unconditionally (atmosphere,
clusters, shadows, deferred, post, pixel upscale, gizmos, picking), `renderPlugin` registers all
engine WGSL, and `@aethervtt/shard-render` depends on `@aethervtt/shard-noise`.

Aether ships three.js 0.160 from the root module inside a 3.18 MB app chunk, plus a 2.95 MB dice
worker, and doesn't measure either.

## Goals

- Registrations stay where they are, and plugins declare the modules and values they provide, so a
  bundle keeps exactly what the plugins it installs need. No bare side-effect imports.
- Every registration is idempotent and returns what it registered, so it can be provided.
- `"sideEffects": false` on every package, so importing a name keeps only what it uses.
- A minimal `forwardPlugin`, with each render feature as its own plugin, plus a preset that keeps
  today's behavior.
- WGSL modules registered by the feature that uses them.
- A size script that builds fixed fixtures, reports min, gzip and brotli per chunk, and fails on a
  budget. It includes a three.js baseline, built the same way, to compare against.
- WASM that loads lazily, in the chunk or worker that needs it.
- Versioned releases another repository can install and pin: JS plus `.d.ts`, workers included,
  consumable by Vite, webpack and Bun without special configuration.

## Non-goals

- Checks for specs that don't exist yet. 0052 adds `shadow-catcher` to core, next to the shadows; 0053 and
  0054 add the `dice` fixture and the "no Rapier on the main thread" and track-bundle checks; 0055
  adds the `vtt` fixture. Each lands its own fixture and budget with its spec.
- Minifying WGSL beyond comment and whitespace stripping.
- Server-side or Node build size.

## Design

### Definitions and registrations

Definitions (components, tags, resources, events, materials, data types, settings, asset types)
create an identity and a catalog entry in one call, and scene files, saves, the protocol and
animation tracks look them up by name. Catalog entries (importers, previews, asset schemas,
overlays, resolvers, import dependencies, procedural sources, instance kinds) are registered the same
way. Both stay module-level and register when their module evaluates.

What makes that safe with `sideEffects: false` is **reachability**. A bundler drops a module only
when nothing reachable uses it, so each plugin declares what it needs:

```ts
definePlugin({
  name: 'physics3d',
  provides: [componentsModule, collidersOverlay],   // import * as componentsModule from './components'
  build(app) { … },
})
```

`provides` takes module namespaces or values. Namespaces are convenient, but they keep every
export of the module. So packages where size matters (render, transform) list the definitions
themselves, grouped by feature. An installed plugin keeps what it provides; a package whose plugins
aren't installed drops out, and nothing reachable could have named its definitions.

Registration functions return what they registered (`export const noiseGraphPreview =
defineAssetPreview(…)`), so every registration is an export something can provide. The two that
appended (`defineAssetResolver`, `defineProceduralSource`) now add each value once.

**The rule, as a test.** `project/src/provides.test.ts` imports every source module of every engine
package and attributes each registry entry to the package that exports it (following one or two
levels in: a material's component, a data type's importer and file schema). It then checks that
each entry is reachable from a plugin of that package. An entry no module exports fails too, since
nothing could provide it.

**No bare side-effect imports.** The six `import './preview'`-style imports are gone; the plugins
that need those modules provide them. glTF's importer, which the project host imported bare, gets a
`gltfPlugin` the host installs.

**Name lookups across packages** (`'scene/SceneMember'`, `'physics/Collider'`, `'terrain/Planet'`
and others) stop caching a miss. They cache the definition once found and look again until then.

**Order.** `defineMaterial` used to need `setStandardFields()` to have run first, a module-level
call in `render/assets.ts`. Once a bundler prunes unused re-exports, nothing guarantees that order,
so the standard fields move to `standard-fields.ts`, which `materials.ts` imports directly.

**Bundles without plugins.** The generator worker (0042) bundles the project's code with the engine
inlined and runs no plugins, and a job may load any asset type. Its esbuild build sets
`ignoreAnnotations`, which keeps every module despite `sideEffects: false`. Project code bundles
keep `@aethervtt/shard-*` external, so they share the host's module instances and aren't affected.

### Render features as plugins

`forwardCorePlugin` is the core 3D renderer, and keeps the plugin name `render/forward` that
other plugins depend on. It holds what every lit 3D view needs:

- cameras, meshes, standard materials, instancing and GPU culling;
- clustered point and spot lights, directional lights, and cascaded and spot **shadows** (three.js
  keeps shadows in its core too, and `renderer-min` uses them);
- opaque and transparent phases and the depth resolve;
- the display stage (`display-nodes.ts`): tonemap with color grading and vignette, then the
  render-scale upscale at a fixed `RenderScale` (0051);
- the skin asset type, so models with skins import and load without the skinning plugin.

Each feature is a plugin that depends on it and registers its own WGSL:

| Plugin | Contents | Without it |
|---|---|---|
| `environmentPlugin` | `DefaultEnvironment`, `EnvironmentMap`, `Skybox`, `ProceduralSky`, IBL prefilter, sky node | lit by `AmbientLight` alone |
| `atmospherePlugin` | 0044; depends on `environmentPlugin` | no atmospheres |
| `postPlugin` | prepass, SSAO, fog, TAA, motion blur, DoF, bloom, auto exposure | the effect is skipped |
| `fxaaPlugin` | FXAA | skipped |
| `deferredPlugin` | the G-buffer path (0021) | `RenderPath deferred` cameras render forward |
| `gizmosPlugin` | `Gizmos`, `DebugOverlays`, overlays | nothing draws gizmos |
| `pickingPlugin` | `pick`, raycasts | picking is unavailable |
| `materialNoisePlugin` (`@aethervtt/shard-render/noise`) | noise slots in materials (0041) | such materials skip their draws |
| `skinningPlugin` | joint and morph deformation, the skeleton overlay (0032) | `SkinnedMesh` and `MorphWeights` meshes draw in their rest pose |
| `pixelPerfectPlugin` | the low-resolution target and whole-number upscale (0024) | `PixelPerfect` cameras render at full resolution |
| `dynamicResolutionPlugin` | the controller that moves `RenderScale` in auto mode (0051) | the scale stays where it's set |
| `renderDescribePlugin` | the lighting, culling and renderScale sections of `render.describe` | those sections are absent |

`forwardPlugin()`, in `standard.ts`, adds `forwardCorePlugin` and every feature, so the 75 call
sites that relied on it (tests, apps, examples, the CLI) didn't change. That inverts the naming
this spec first proposed (a minimal `forwardPlugin` plus `standardRenderPlugins()`) for the same
result without touching them.

**Off states.** Core owns the data its passes bind and features fill it:
`atmosphere-state.ts` (the `Atmospheres` store), `environment-state.ts` (each camera's prefiltered
environment, or placeholder textures), `PostFeatures` (the installed effect bits), `DeferredPath`
(a marker), `MaterialNoise` (a hook), and `overlay-registry.ts` (`defineOverlay` without the gizmo
renderer), `DeformPath` and `PixelPerfectPath` (markers). A camera, mesh or material asking for a
feature that isn't installed renders without it and logs `render/feature-missing` once, naming the
plugin to add. Components of
an absent feature (a `Skybox` with no `environmentPlugin`) aren't in a tree-shaken bundle at all,
so a scene naming one fails with `scene/unknown-component`; in Node, where nothing is tree-shaken,
they're simply ignored.

**WGSL.** The core forward shader imports one feature module, `shard::pbr::environment`, so that
module and the ones several features share (`post::common`, `post::tonemap`, `post::upscale`) are in
core's `ENGINE_SHADERS`. Modules only one feature uses live with it (`env::common` in the
environment's group, `pbr::gbuffer` in the deferred one). `registerEngineShaders` registers core's;
each feature calls `registerShaders` with its own group.

**Previews** (animation, particles) render in an app of their own with the full renderer. Their
registration stays in the provided module; the rendering moved behind a dynamic import.

### Baked shaders

WESL, the WGSL linker, was the largest dependency in `renderer-min` (139 KB minified). It links a
variant from its modules, defines and hook overrides, and apps that edit or add shaders at runtime
need it. An app whose variants are known ahead of time doesn't:

- `ShaderLibrary` imports WESL dynamically, on the first variant it has to link.
- `library.bake()` returns every variant used so far: its key (root, defines, overrides), a hash of
  the source of every module it links, and the linked WGSL. An app saves it after a run that draws
  what it draws.
- `renderPlugin({ shaderBake })` (or `library.preload(bake)`) serves those variants without linking
  while their hash matches. A changed module, a new define or a new override links as before, so a
  stale bake costs a WESL download, never a wrong shader.
- `renderer-min` ships `shaders.bake.json`. `bench/size/src/bake.test.ts` renders the scene headless
  with it and fails if any variant had to be linked; `SHARD_UPDATE_BAKE=1` rebakes after a shader
  change.

The linked code isn't compacted: brotli matches it against the module sources already in the bundle,
and stripping comments and indentation made the entry 0.8 KB larger.

### What belongs in core

`forwardCorePlugin`, `renderPlugin`, and the packages they import are what every Shard app pays
for. Something goes in core only if the smallest lit 3D scene (`renderer-min`) runs it every frame,
or if a feature's off state needs it. Everything else is a plugin:

- **A feature is a plugin** that depends on `render/forward`, registers its own WGSL, and is added
  to `forwardPlugin()` in `standard.ts`, so apps that don't choose keep getting everything.
- **Its components stay in core when a camera or mesh carries them in scenes** (`Bloom`, `SkinnedMesh`,
  `PixelPerfect`), so a scene still loads and the extraction can see what's asked for. Core
  reads a marker resource or a feature bit to know whether the plugin is there, and logs
  `render/feature-missing` once when it isn't. The feature's systems, nodes, shaders and stores move
  out.
- **Agent and editor surfaces are plugins too** (`render.describe` sections, gizmos, previews).
  The editor and `shard dev` install `forwardPlugin`; a shipped app doesn't pay for them.
- **Nothing is registered by importing a module.** Registrations stay at module level (see
  Decisions), reachable through a plugin's `provides`, which `project/src/provides.test.ts` checks
  for every package.
- **Heavy dependencies load lazily** when a real app can go without them: WESL (above), KTX2
  readers, preview rendering, Rapier, Basis, Recast.
- **A change that grows `renderer-min` needs a reason.** `pnpm size --check` fails 2% over budget.
  Lower the budget in the same change that shrinks a build.

Still in core that a later release could move: the large-world grid in `TransformPlugin` (13 KB
minified, part of the transform propagation hot path), the asset server's import and hot-reload
machinery (39 KB), and the schema `description` strings agents read (about 7 KB brotli of
`renderer-min`; a production build could drop them, if agents attaching to shipped apps can do
without them).

### WASM

- Rapier, the noise kernel, Basis and Recast already load lazily. The size script checks that none
  of them lands in an entry chunk.
- Rapier's compat builds carry their WASM as base64, which costs about a third more bytes and
  blocks streaming compilation. The `full` fixture records the compat size; switching to the
  plain-WASM builds is decided with 0053, where the dice worker is the first chunk that needs it.

### Size script

`pnpm size` builds each fixture in `bench/size/fixtures/` with Vite in app mode
(production, minified, the same settings Aether uses), then writes `bench/size/report.json`:
per fixture and per chunk, the min, gzip and brotli sizes, and which packages each chunk contains
(from the bundle's module graph).

| Fixture | What it contains |
|---|---|
| `renderer-min` | `renderPlugin` and `forwardCorePlugin`: a camera, a directional light with shadows, 100 standard-material cubes |
| `three-min` | the same scene in three.js 0.160 (`WebGLRenderer`, `MeshStandardMaterial`, `DirectionalLight`, PCF shadows), imported as Aether does |
| `full` | the playground: `forwardPlugin` and every other plugin |

`bench/size/budgets.json` holds a brotli budget per fixture and per chunk kind (entry, worker,
lazy). `pnpm size --check` fails if any grows more than 2% over budget, and `pnpm bench` runs it.
Budgets are lowered by hand when a change shrinks a build, so they ratchet.

### Releases for other repositories

Inside the monorepo, packages keep exporting `./src/index.ts`, with no build step (AGENTS.md).
`pnpm release` produces what another repository installs:

- **JS.** Each file's types are stripped one by one (esbuild's transform), with no bundling, so the module graph,
  `import.meta.url` and every `new URL('./x.ts', import.meta.url)` worker pattern survive with
  `.ts` rewritten to `.js`. Extensionless relative imports gain `.js` (or `/index.js`), so Node's ESM
  loader resolves them as bundlers do. The host's bundler then builds workers as it would its own, and the
  pool's plain-JS job modules (the noise worker) ship as files next to the code that loads them.
- **Types.** `.d.ts` files from `tsc --declaration --emitDeclarationOnly`.
- **Exports.** `package.json` `exports` rewritten to `dist/`, with `types` conditions and
  `sideEffects: false`. Internal `workspace:*` dependencies become the exact release version.
- **Versioning.** All `@aethervtt/shard-*` packages share one version, `0.MINOR.PATCH`. A minor
  bump may break, a patch never does, and `CHANGELOG.md` lists each release's spec numbers. Each package
  also records the git sha it was built from (`shard.buildSha`), so a host can pin by version and
  trace by commit.
- **Publishing.** Public, to npm under the `@aethervtt` org, from a workflow triggered by a `v*`
  tag, with npm provenance so each package links to the commit and run that built it. Apps and
  examples stay private. v0.0.1 is the first release, once this spec's criteria pass.

`bench/consumer/` is a fixture app outside the workspace. It installs the release tarballs, then
builds the `renderer-min` scene with Vite and with `bun build`, renders a headless frame on Dawn,
samples noise on the worker pool (proving a worker module survives the release), and typechecks
against the `.d.ts` only. `pnpm release --check` runs it.

### Agent surface

- `pnpm size --json` for agents. The report says which packages and WGSL modules each chunk
  carries, so "why is this big" has an answer.
- `render/feature-missing` validation errors name the plugin to add.

## Decisions

- **Registrations stay at module level; plugins declare them.** A definition's identity is its
  catalog entry, and scene files name definitions, so moving them into `build()` would break
  loading. Reachability through `provides` makes `sideEffects: false` safe instead: a module is
  dropped only when no installed plugin could need it. Catalog entries follow the same rule rather
  than moving into `build()`, so the CLI and tests, which import packages without plugins, keep
  working unchanged.
- **Clustered lights stay in core.** Every lit 3D scene needs them, and a separate lighting model
  for "a few lights" would be a second path to maintain.
- **A preset instead of feature detection from scene contents.** Scenes load after the build, so a
  bundler can't see which features they use. The app lists them, and `render/feature-missing`
  catches what's absent.
- **Compare against three built the same way.** A size claim is only fair with the same bundler,
  minifier and compression on an equivalent scene.

## Acceptance criteria

- [x] Every registration a package makes is exported and reachable from one of its plugins'
      `provides` (`project/src/provides.test.ts`), and no package has a bare side-effect import.
- [x] Registering a resolver or procedural source twice leaves one entry; the other registries were
      already keyed by name.
- [x] Every package declares `"sideEffects": false`, and the playground, examples, CLI and
      `pnpm test` pass unchanged.
- [x] `forwardCorePlugin` alone renders a lit, shadowed scene that matches its golden
      (`core.test.ts`), and the full set matches every existing golden.
- [x] A camera asking for an uninstalled effect or the deferred path, or a material with noise
      slots and no `materialNoisePlugin`, logs `render/feature-missing` once, naming the plugin.
- [x] `renderer-min` contains no atmosphere, deferred, post, noise, physics, text, particle or
      terrain code (from the report's module list).
- [x] `renderer-min`'s brotli JS size is at or below `three-min`'s. Measured (Vite 8, brotli 11):
      `renderer-min`'s entry went from 186 KB to 91.5 KB; `three-min` is 91.6 KB. Getting there took
      the feature plugins, lazy KTX2 readers and previews, and baked shaders with a lazy WESL
      (a 34 KB brotli chunk that loads only on a variant the bake lacks).
- [x] `bench/consumer` installs the release tarballs, builds with Vite and with `bun build`,
      typechecks against the shipped `.d.ts` with no Shard source present, renders a headless
      frame, and samples noise on the worker pool.
- [x] Every released package's `exports` resolve to `dist/` files that exist, and no released
      file imports a `.ts` path or `workspace:` specifier.
- [x] `pnpm size --check` fails when a fixture grows 2% over budget: checked against budgets 5% below
      the measured sizes (`--budgets <file>`), it names each fixture over and exits 1.

## Open questions

- Should the size check run in CI on every push, or only in `pnpm bench`? Proposed: `pnpm bench`,
  like the timing budgets.
