# Shard — agent guide

Shard is a WebGPU-first 2D/3D game engine in TypeScript, built for AI-driven authoring.
Read `VISION.md` before any architectural change. Features are built from specs in `specs/`.

## Layout

- `packages/*` — engine packages (`@aethervtt/shard-*`). Each exports `./src/index.ts` directly; no build step.
- `apps/playground` — Vite browser sandbox (`pnpm playground`, port 5180).
- `apps/studio` — Tauri 2 app (`pnpm studio`). Rust lives in `apps/studio/src-tauri`.
- `apps/cli` — the `shard` binary: headless runs, screenshots, gameplay tests, the protocol hub,
  and the MCP server.
- `examples/*` — sample projects made with `shard init`; their tests run in `pnpm test`.
- `specs/` — one spec per feature, plus `ROADMAP.md`.

## Commands

```sh
pnpm install
pnpm typecheck     # tsc (TypeScript 7) in every package
pnpm test          # vitest
pnpm lint          # biome; `pnpm format` to auto-fix
pnpm bench         # ECS benchmarks, then every test serially at exact spec time budgets
pnpm size          # bundle sizes of the bench/size fixtures (--check against budgets.json)
pnpm release       # build and pack every package into dist-release/ (--check: install and use them)
pnpm playground    # browser sandbox
pnpm studio        # desktop app
```

Inside a project (e.g. `examples/star-explorer`), `pnpm exec shard <command>`; every command
takes `--json`:

```sh
shard validate                        # manifest, assets, and scenes; lists every error
shard import / shard mv <from> <to>   # import changed asset files / move one, fixing references
shard check                           # type-check the project's scripts
shard dev                             # play it in a browser; saves hot reload in place
shard run --frames 600                # headless run, prints a deterministic world hash
shard screenshot scenes/main.scene.json --out shot.png
shard test                            # gameplay tests in tests/*.test.ts
shard track scene.json --out t.bin    # record a physics track (0053) headless; prints its hash
shard capture plan.json               # real-browser shots, checked steps, perf records (0062)
shard compare / shard approve <shot> --reason "…" / shard perf-check <records> --plan plan.json
shard docs                            # regenerate AGENTS.md block, .agents/, .shard/schemas
shard serve / shard mcp [--attach]    # protocol hub / MCP server
```

Run `pnpm typecheck && pnpm test && pnpm lint` before calling work done. Run `pnpm bench` too
when touching ECS storage, queries, anything on a per-frame path, or code a timing test covers.
Tests come in two tiers:

- `pnpm test` (local, and CI with `SHARD_CI=1`) checks correctness only. Files run in parallel and
  CI renders on a software GPU, so time budgets are unlimited and "allocates nothing" checks are off.
  CI retries a failed test once; timeouts there are 5x.
- `pnpm bench` checks performance: every file serially, at the specs' exact budgets, with allocation
  checks on. Run it on a machine doing nothing else.

Write every timing assertion through `budget()`, `slack` or `allocationChecks` (or
`timingMode === 'bench'`), and timeouts with `timeout()`, all from `@aethervtt/shard-core/test-env`.
A test that flakes in `pnpm test` is a bug: fix it, or skip it with an entry in `TODO.md`'s
"Skipped tests" (what's known, the date, and the lead), never a local retry.
CI splits test files across four runners (`SHARD_TEST_SHARD`, `scripts/test-shard.mjs`); a new test
file that takes minutes there belongs in `scripts/test-weights.json` so the split stays even.
Vendored third-party code (`**/vendor`) and test fixtures (`**/fixtures`) aren't linted or edited.
The playground's browser tests (0062) need `pnpm exec playwright install chromium` and a GPU; without
them they skip. Its `verify.html` fixture and `plans/` are what `shard capture` runs against.

## Rules

- **Work from a spec.** Non-trivial features start as `specs/NNNN-slug.md` (see `specs/README.md`).
  If implementation forces a design change, update the spec in the same change.
- **Dependency direction.** `core` imports nothing from the engine and has no DOM or GPU types
  (its tsconfig has `lib: ["ES2023"]` only). Only `platform-*` packages may import a host API
  such as `@tauri-apps/*`. Engine packages get host services through `@aethervtt/shard-platform`.
- **Erasable TypeScript only.** No `enum`, `namespace`, or parameter properties
  (`erasableSyntaxOnly`). Use `as const` objects and union types.
- **Errors are `ShardError`** with a namespaced `code` (`package/what-happened`), plus `hint` and
  `path` when useful. Never throw bare strings.
- **Keep the core renderer small** (spec 0056, "What belongs in core"). A render feature the smallest
  lit scene doesn't run each frame is a plugin that depends on `render/forward`, registers its own
  WGSL, and is added to `forwardPlugin()`. Its scene components stay in core, which logs
  `render/feature-missing` when the plugin is absent. Nothing registers on import. Heavy
  dependencies load with `import()`. `pnpm size --check` guards `renderer-min`.
- **Hot paths don't allocate.** In per-frame code (systems, render, ECS iteration): no closures,
  no array/object literals, no `for…of` over iterators that allocate. Use TypedArrays and reuse
  scratch objects. Add a benchmark when you touch a hot path.
- **Hot loops: prefer out-parameters and inlined math.** V8 boxes a non-integer number returned
  from a call it doesn't inline, so `dot`/`length`/`rng.float()`-style calls in a per-frame loop can
  allocate. Functions that write into `out` never do. Avoid `Math.hypot` in hot code: it allocates
  when not inlined (use `Math.sqrt(x * x + y * y + z * z)`). Shared math called with many array types may
  also not inline at all; inlining `fromTRS` in transform propagation was a 3.5x win.
- **One schema drives everything.** Don't hand-write serializers, validators, or inspector code
  for components; derive them from the component schema.
- **Tests sit next to code** as `*.test.ts`. Engine logic must be testable headless (no GPU, no DOM).
- Match surrounding code: 2 spaces, single quotes, no semicolons (Biome enforces it).
