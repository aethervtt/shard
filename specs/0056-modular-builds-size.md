# 0056 — Modular builds and size budgets

- **Status:** accepted
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

- Definitions stay where they are, and plugins declare the ones they provide, so a bundle keeps
  exactly the definitions of the plugins it installs.
- Catalog-only registrations (importers, previews, overlays, resolvers) move into plugin `build()`,
  and every registration is idempotent.
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

- Checks for specs that don't exist yet. 0052 adds `shadow-catcher` to `shadowsPlugin`; 0053 and
  0054 add the `dice` fixture and the "no Rapier on the main thread" and track-bundle checks; 0055
  adds the `vtt` fixture. Each lands its own fixture and budget with its spec.
- Minifying WGSL beyond comment and whitespace stripping.
- Server-side or Node build size.

## Design

### Definitions and catalogs

Two kinds of registration exist, and they get different rules.

**Definitions** (components, tags, resources, events, materials, data types, settings, asset
types) create an identity and a catalog entry in one call. Scene files, saves, the protocol and
animation tracks all look them up by name, and a second call under the same name breaks that
(`schema/ambiguous-name` for components, a new id for resources). So they stay module-level
`export const`s, evaluated when their module is.

What makes that safe to tree-shake is **reachability**. `Plugin` gains `provides`:

```ts
definePlugin({
  name: 'physics3d',
  provides: { components: [RigidBody, Collider, Velocity, …], resources: [Physics, …], events: [Contact, …] },
  build(app) { … },
})
```

An installed plugin references its definitions, so their modules stay in the bundle and register.
A package whose plugins aren't installed drops out entirely, definitions included, and nothing
reachable could have named them: a scene that uses `physics/RigidBody` needs `physics3d` anyway.
A registry test checks that every definition exported by a package appears in some plugin's
`provides` in that package, so a new component can't be forgotten.

**Catalog entries** (importers, asset previews, asset schemas, overlays, asset resolvers, import
dependencies, procedural sources, instance kinds, the ref parser, the standard material fields,
texture capabilities, environment bakers) carry no identity. They move out of module scope into a
`register…()` function per package that its plugins' `build()` calls. Each one is keyed by name
and idempotent: `defineAssetResolver` and `defineProceduralSource` stop appending duplicates. The
six bare side-effect imports (`import './preview'` and the like) go away. A test imports every
package index in a fresh module graph and asserts that no catalog registry changed.

**Name lookups across packages** (`'scene/SceneMember'`, `'physics/Collider'`,
`'terrain/Planet'` and others) stop caching a miss. They cache the definition once found and look
again until then, so a package installed later is still seen.

A headless tool that loads assets without installing plugins (the CLI's `import`, `validate`,
`docs`) calls `registerAll()` from `@aethervtt/shard-project`, which calls every package's
`register…()`; `shard validate` also reports a scene component whose plugin isn't in the
manifest, naming the plugin (`scene/plugin-missing`).

### Render features as plugins

The core forward shader (`shard::pbr::lighting`) imports clustered lights, shadows, the
environment and SSAO, and the view bind group has fixed slots for them. So features can't just be
left out: each has an **off state** that core provides. That's a define that compiles the
feature's WGSL out, and a placeholder resource in its slot (an empty cluster list, a 1×1 shadow
array, a black environment cube, a white AO texture). A feature plugin replaces the off state with
the real passes, resources and WGSL modules.

`forwardPlugin` keeps what every 3D view needs:

- cameras, meshes, standard materials, instancing and culling;
- clustered point and spot lights plus directional lights: they're the lighting model, and a
  VTT needs dozens of lights;
- opaque and transparent phases, the depth resolve;
- the display stage: tonemap, the render-scale upscale and the fullscreen pass, which move out of
  post into core (0051).

Everything else is a plugin that depends on it:

| Plugin | Contents | Off state in core |
|---|---|---|
| `shadowsPlugin` | cascaded and spot shadows, `shadow-catcher` (0052) | no shadow passes; lights unshadowed |
| `environmentPlugin` | IBL prefilter, skybox, `DefaultEnvironment`, `ProceduralSky` | flat ambient from `AmbientLight` |
| `atmospherePlugin` | 0044 | no atmosphere nodes or baker |
| `deferredPlugin` | G-buffer path (0021) | forward only |
| `postPlugin` | prepass, SSAO, bloom, auto exposure, DoF, motion blur, TAA, fog, grading (each a flag) | white AO, fixed exposure |
| `fxaaPlugin` | FXAA | none |
| `pixelArtPlugin` | pixel-perfect upscale | none |
| `gizmosPlugin`, `pickingPlugin` | 0027 | none |
| `materialNoisePlugin` (`@aethervtt/shard-render/noise`) | noise slots in materials (0041 graphs in WGSL) | materials without noise slots |

Material noise slots are the only reason `@aethervtt/shard-render` imports `@aethervtt/shard-noise`
today. They move to the `@aethervtt/shard-render/noise` subpath, so the render index no longer
reaches noise, and a material type that declares noise slots without `materialNoisePlugin` fails
with `render/feature-missing`. The unused `NoiseCompute` node goes away.

`standardRenderPlugins(options)` returns today's full set, so the playground, `shard dev`, the
examples and the CLI keep working unchanged. (The playground's local demo plugins named
`deferredPlugin`, `postPlugin` and `iblPlugin` are renamed.) A component of an absent feature (an
`Atmosphere` with no `atmospherePlugin`) fails validation with `render/feature-missing`, naming the
plugin to add; it doesn't silently do nothing.

`renderPlugin` registers only core WGSL; each feature registers its own. `plugin.ts` stops
importing every `*-shaders` module, so an app without atmosphere carries none of its shader source.

**Imports that drag render in.** Several packages import all of render for one small thing:
physics and nav for `Meshes` and `defineOverlay`, sprite, text, terrain and particles for
`Visibility`, save for `LightingSettings`. Once render's modules have no import-time work, a named
import keeps only what it uses. Two cycles need breaking: `overlays.ts` imports
`ForwardStateResource` from `forward.ts` (so `defineOverlay` reaches the whole forward graph), and
`animation` and `particles` load their previews, which import `renderPlugin` and `forwardPlugin`,
from their indexes. Previews move behind their packages' `register…()` and load lazily.

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
| `renderer-min` | `renderPlugin`, `forwardPlugin`, `shadowsPlugin`: a camera, a directional light with shadows, 100 standard-material cubes |
| `three-min` | the same scene in three.js 0.160 (`WebGLRenderer`, `MeshStandardMaterial`, `DirectionalLight`, PCF shadows), imported as Aether does |
| `full` | `standardRenderPlugins` and every plugin, like the playground |

`bench/size/budgets.json` holds a brotli budget per fixture and per chunk kind (entry, worker,
lazy). `pnpm size --check` fails if any grows more than 2% over budget, and `pnpm bench` runs it.
Budgets are lowered by hand when a change shrinks a build, so they ratchet.

### Releases for other repositories

Inside the monorepo, packages keep exporting `./src/index.ts`, with no build step (AGENTS.md).
`pnpm release` produces what another repository installs:

- **JS.** Each file's types are stripped one by one, with no bundling, so the module graph,
  `import.meta.url` and every `new URL('./x.ts', import.meta.url)` worker pattern survive with
  `.ts` rewritten to `.js`. The host's bundler then builds workers as it would its own, and the
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

- **Definitions stay at module level; plugins declare them.** A definition's identity is its
  catalog entry, and scene files name definitions, so moving them into `build()` would break
  loading. Reachability through `provides` makes `sideEffects: false` safe instead: a module is
  dropped only when no installed plugin could need it.
- **Catalog-only registrations move into `build()`.** They have no identity, so there's nothing to
  keep them at import time, and moving them makes registration explicit and ordered.
- **Clustered lights stay in core.** Every lit 3D scene needs them, and a separate lighting model
  for "a few lights" would be a second path to maintain.
- **A preset instead of feature detection from scene contents.** Scenes load after the build, so a
  bundler can't see which features they use. The app lists them, and `render/feature-missing`
  catches what's absent.
- **Compare against three built the same way.** A size claim is only fair with the same bundler,
  minifier and compression on an equivalent scene.

## Acceptance criteria

- [ ] Importing every package index in a fresh module graph changes no catalog registry
      (definitions are allowed), and no package has a bare side-effect import (test).
- [ ] Every definition a package exports appears in a `provides` of one of its plugins (test).
- [ ] Registering any catalog entry twice leaves one entry (test per registry).
- [ ] Every package declares `"sideEffects": false`, and the playground, examples, CLI and
      `pnpm test` pass unchanged with `standardRenderPlugins`.
- [ ] Each feature plugin's off state renders: `renderer-min` without `environmentPlugin`,
      `postPlugin` or `atmospherePlugin` matches its golden, and the full set matches today's
      goldens.
- [ ] An `Atmosphere` without `atmospherePlugin`, or a material with noise slots without
      `materialNoisePlugin`, fails validation with `render/feature-missing` naming the plugin.
- [ ] `renderer-min` contains no atmosphere, deferred, post, noise, physics, text, particle or
      terrain code, and no WGSL of those features (from the report's module list).
- [ ] `renderer-min`'s brotli JS size is at or below `three-min`'s. If the first measurement misses,
      this spec records both numbers and the gap, and the budget becomes the plan to close it.
- [ ] `bench/consumer` installs the release tarballs, builds with Vite and with `bun build`,
      typechecks against the shipped `.d.ts` with no Shard source present, renders a headless
      frame, and samples noise on the worker pool.
- [ ] Every released package's `exports` resolve to `dist/` files that exist, and no released
      file imports a `.ts` path or `workspace:` specifier.
- [ ] `pnpm size --check` fails when a fixture grows 2% over budget (test with an injected import).

## Open questions

- Should the size check run in CI on every push, or only in `pnpm bench`? Proposed: `pnpm bench`,
  like the timing budgets.
