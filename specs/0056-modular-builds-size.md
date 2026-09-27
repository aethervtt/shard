# 0056 — Modular builds and size budgets

- **Status:** draft
- **Packages:** every `@shard/*` package, `apps/playground`, `bench/size` (new)
- **Depends on:** 0005, 0007, 0017, 0052

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
engine WGSL, and `@shard/render` depends on `@shard/noise`.

Aether ships three.js 0.160 from the root module inside a 3.18 MB app chunk, plus a 2.95 MB dice
worker, and doesn't measure either.

## Goals

- No import-time side effects. Registration happens in a plugin's `build()`.
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

- A public npm release. Releases go to a private registry (or tagged tarballs) for hosts that pin
  them; going public is a separate decision.
- Minifying WGSL beyond comment and whitespace stripping.
- Server-side or Node build size.

## Design

### Registration moves into plugins

Every top-level `define*`/`register*`/`set*` call and every bare side-effect import moves into a
function that the owning plugin's `build()` calls. The registries stay global (asset types must be
shared across apps, 0052) and registration stays idempotent. A test imports every package's index
in a fresh module graph and asserts that no registry changed. That's the rule, checked by CI.

A headless tool that loads assets without a plugin (the CLI's `import`, `validate`) calls
`registerAll()` from `@shard/project`, which calls every package's registration function.

### Render features as plugins

`forwardPlugin` keeps cameras, meshes, standard materials, one shadowless directional light,
opaque and transparent phases, tonemap and the display stage (0051). Everything else is a plugin
that depends on it:

| Plugin | Contents |
|---|---|
| `shadowsPlugin` | cascaded and spot shadows, `shadow-catcher` (0052) |
| `clusteredLightsPlugin` | Forward+ point and spot lights beyond the default few |
| `deferredPlugin` | G-buffer path (0021) |
| `environmentPlugin` | IBL, skybox, `DefaultEnvironment`, `ProceduralSky` |
| `atmospherePlugin` | 0044, and the `@shard/noise` dependency |
| `postPlugin` | bloom, auto exposure, DoF, motion blur, TAA, SSAO, fog, grading (each a flag) |
| `fxaaPlugin` | FXAA |
| `pixelArtPlugin` | pixel-perfect upscale |
| `gizmosPlugin`, `pickingPlugin` | 0027 |

`standardRenderPlugins(options)` returns today's full set, so the playground, `shard dev`,
examples and the CLI keep working unchanged. Components of an absent feature (an `Atmosphere` with
no `atmospherePlugin`) fail validation with `render/feature-missing`, naming the plugin to add.
They don't silently do nothing.

Each feature registers its own WGSL, so an app without atmosphere carries none of its shader
source.

### WASM

- Rapier stays a dynamic import, and dice put it in their worker (0053, 0054), so the main thread
  of a dice-only app has no Rapier at all.
- The noise kernel, Basis and Recast already load lazily. The size script checks that they don't
  land in any entry chunk.
- The compat builds' base64 costs about a third more bytes and blocks streaming compilation. The
  size script records both the compat and the plain-WASM Rapier builds for the dice worker; the
  cheaper one that works in Vite, webpack and Bun without a plugin is chosen when this spec is
  implemented.

### Size script

`pnpm size` builds each fixture in `bench/size/fixtures/` with Vite in app mode
(production, minified, the same settings Aether uses), then writes `bench/size/report.json`:
per fixture and per chunk, the min, gzip and brotli sizes, and which packages each chunk contains
(from the bundle's module graph).

| Fixture | What it contains |
|---|---|
| `renderer-min` | `renderPlugin`, `forwardPlugin`, `shadowsPlugin`: a camera, a directional light with shadows, 100 standard-material cubes |
| `three-min` | the same scene in three.js 0.160 (`WebGLRenderer`, `MeshStandardMaterial`, `DirectionalLight`, PCF shadows), imported as Aether does |
| `dice` | `dicePlugin` on a transparent surface, with its worker as a separate chunk |
| `vtt` | `renderer-min` + `@shard/structure` + `@shard/mirror` + instanced tokens |
| `full` | `standardRenderPlugins` and every plugin, like the playground |

`bench/size/budgets.json` holds a brotli budget per fixture and per chunk kind (entry, worker,
lazy). `pnpm size --check` fails if any grows more than 2% over budget, and `pnpm bench` runs it.
Budgets are lowered by hand when a change shrinks a build, so they ratchet.

### Releases for other repositories

Inside the monorepo, packages keep exporting `./src/index.ts`, with no build step (AGENTS.md).
`pnpm release` produces what another repository installs:

- **JS.** Each file's types are stripped one by one, with no bundling, so the module graph,
  `import.meta.url` and every `new URL('./x.ts', import.meta.url)` worker pattern survive with
  `.ts` rewritten to `.js`. The host's bundler then builds workers as it would its own:
  `trackWorker()` (0053) and the dice worker (0054) stay separate chunks in a Vite, webpack or Bun
  build.
- **Types.** `.d.ts` files from `tsc --declaration --emitDeclarationOnly`.
- **Exports.** `package.json` `exports` rewritten to `dist/`, with `types` conditions and
  `sideEffects: false`. Internal `workspace:*` dependencies become the exact release version.
- **Versioning.** All `@shard/*` packages share one version, `0.MINOR.PATCH`. A minor bump may
  break, a patch never does, and `CHANGELOG.md` lists each release's spec numbers. Each package
  also records the git sha it was built from (`shard.buildSha`), so a host can pin by version and
  trace by commit.
- **Publishing.** To a private registry (GitHub Packages), or as `.tgz` files attached to a git tag,
  for hosts that install from files.

`bench/consumer/` is a fixture app outside the workspace. It installs the release tarballs, then
builds with Vite and with `bun build`, runs a headless dice roll with its worker, and typechecks
against the `.d.ts` only. `pnpm release --check` runs it.

### Agent surface

- `pnpm size --json` for agents. The report says which packages and WGSL modules each chunk
  carries, so "why is this big" has an answer.
- `render/feature-missing` validation errors name the plugin to add.

## Decisions

- **Registration in `build()`, not import.** It's the only way `sideEffects: false` is truthful,
  and it makes registration order explicit.
- **A preset instead of feature detection from scene contents.** Scenes load after the build, so a
  bundler can't see which features they use. The app lists them, and `render/feature-missing`
  catches what's absent.
- **Compare against three built the same way.** A size claim is only fair with the same bundler,
  minifier and compression on an equivalent scene.

## Acceptance criteria

- [ ] Importing every package index in a fresh module graph changes no registry (test).
- [ ] Every package declares `"sideEffects": false`, and the playground, examples, CLI and
      `pnpm test` pass unchanged with `standardRenderPlugins`.
- [ ] `renderer-min` contains no atmosphere, deferred, post, noise, physics, text or particle code
      (from the report's module list).
- [ ] `renderer-min`'s brotli JS size is at or below `three-min`'s. If the first measurement misses,
      this spec records both numbers and the gap, and the budget becomes the plan to close it.
- [ ] The `dice` entry chunk contains no Rapier. Its worker contains Rapier exactly once, and the
      deterministic variant only.
- [ ] `@shard/physics/track` (0053) bundles with no `@shard/render` or `@shard/gpu` modules.
- [ ] `bench/consumer` installs the release tarballs, builds with Vite and with `bun build`,
      typechecks against the shipped `.d.ts` with no Shard source present, and runs a dice roll
      whose worker loads from its own chunk.
- [ ] Every released package's `exports` resolve to `dist/` files that exist, and no released
      file imports a `.ts` path or `workspace:` specifier.
- [ ] `pnpm size --check` fails when a fixture grows 2% over budget (test with an injected import).

## Open questions

- Should the size check run in CI on every push, or only in `pnpm bench`? Proposed: `pnpm bench`,
  like the timing budgets.
