# 0017 — User scripts: bundling and hot reload

- **Status:** implemented
- **Packages:** `@aethervtt/shard-project`, `@aethervtt/shard-core`, `@aethervtt/shard-runtime`, `apps/cli`
- **Depends on:** 0002, 0003, 0009, 0011, 0012, 0014

## Context

A project's code (`scripts/**`, entered through `entry`) loads in exactly one place today: the
Node CLI, through tsx. A browser tab or Studio can't run a project at all, and nothing reloads. To
see a change to a system, you restart the process.

The agent loop depends on fast iteration: edit a system, watch the running game change, keep the
world as it was. So does playing a project in a browser. This spec gives project code one build
path on every host and a hot reload that keeps world state, migrates component data when a
schema changes, and falls back to the last good code when something breaks.

## Goals

- One bundler and one output for every host: the CLI, a browser tab, Studio, and later a web
  export.
- Engine packages are shared with project code, never bundled twice, so there is one component
  registry and one set of engine modules per app.
- Hot reload replaces the project's systems, observers, and definitions and keeps entities and
  resources.
- A component whose schema changed has its data migrated through JSON, the same path scene files
  use.
- Reload is atomic. A syntax error, a failing `build`, or a failed migration leaves the old code
  running and reports where the problem is.
- Type errors are available to agents as structured diagnostics.
- Errors thrown in project systems report a TypeScript source location.

## Non-goals

- Module-level HMR (Vite style). The unit of reload is the whole project bundle, which is simpler
  and keeps every system consistent with every definition.
- Keeping state held in module variables across reloads. Game state belongs in components and
  resources.
- Reloading engine plugins. Editing `packages/*` still means restarting.
- The Studio UI for opening projects (Studio spec). Studio uses `shard dev` (below).
- Export and minification (M9), which build on the same bundle.

## Design

### Bundling

`esbuild` bundles `entry` into a single ESM file with inline source maps. It's native esbuild in
Node, and bundling always happens in the process that owns the project folder: the CLI, or the
`shard dev` server for browsers.

- `@aethervtt/shard-*` imports are **external**. In Node they resolve to the same engine files the host
  loaded, so they share module instances. In browsers, `shard dev` serves the runner page with an
  import map that points each `@aethervtt/shard-*` specifier at the exact module URL the runner already
  imported.
- Other npm dependencies are bundled.
- `node:*` imports and Node built-ins fail with `project/node-builtin`. Project code has to run in
  a browser export.
- Build output goes to `.shard/build/main.<hash>.mjs`. The hash is the content hash, so a reload is
  a new URL and the module cache never serves stale code.
- An esbuild incremental context stays alive while watching, so a rebuild takes milliseconds.

The CLI switches from importing `entry` through tsx to importing the bundle. The CLI process keeps
tsx for the engine's own TypeScript, and `shard test` keeps using Vitest's TypeScript handling,
since tests import project modules directly.

### Reload

On a change under `scripts/` (debounced 50 ms), or on `project.reload`:

1. **Bundle.** Failure: report `project/bundle-failed` with file, line, and column. Stop.
2. **Import** the new bundle inside a **redefinition scope** for the project namespace. Inside the
   scope, `defineComponent`, `defineResource`, and `defineEvent` for names that already exist
   produce replacements instead of throwing `schema/duplicate-name`. Names outside the namespace
   still throw.
3. **Plan migrations.** For each redefined component, compare schema fingerprints (field names,
   kinds, strides, versions):
   - Same fingerprint: the new definition takes over the old storage as-is.
   - Different: serialize every instance with the old schema, run `migrate` if the version went
     up, then deserialize with the new schema. New fields get defaults, removed fields are dropped,
     and anything invalid fails the plan with `project/migration-failed`. The error names the
     component, the first failing entity's path, and a JSON pointer.
   - A component the new code no longer defines stays in the world with its old definition and is
     reported as orphaned. Nothing is deleted without being asked.
   - Schema'd resources migrate the same way. Other resources keep their instances.
4. **Build.** Run the new plugin's `build` against a staging copy of the project's registrations.
   A throw fails the reload with `project/reload-failed` and a source location.
5. **Swap** between frames. Remove every system, observer, set, and condition the old project
   plugin registered (the app records which plugin registered what), apply the migrations,
   register the new ones, and rebuild the schedules. System `setup` runs again, so queries are
   rebuilt against the new definitions. Pending events of removed event types are dropped.
6. **Report.** A `ProjectReloaded` ECS event and the protocol's `project` topic carry the
   duration, the migrated and orphaned components, and the systems added, removed, or changed.

Steps 1–4 touch nothing live, so any failure leaves the app running the last good code, the same
policy as shaders (0006) and assets (0014). Old bundle modules stay in the module cache. That leak
is a few hundred KB per reload and ends with the process.

Renames are migrations: bump the component's `version` and move the value in `migrate`, as for
scene files. Without that, a rename looks like a removed field plus a new one, and the old values
are lost. The reload report calls this out.

### Hosts

- **CLI (headless):** `shard run`, `shard mcp`, and `shard serve` watch `scripts/` when the
  platform can watch files. An agent that edits a script through MCP sees the next `step` run the
  new code.
- **`shard dev`:** a Vite server for the engine plus a runner page. It serves the project bundle,
  the asset artifacts (0014), and the catalog, and runs the protocol hub. The runner page loads
  the engine, fetches the bundle, starts the project, and connects to the hub, so `shard mcp
  --attach` drives it. Rebuilds are pushed over the hub connection, and the page reloads the
  project, not the page.
- **Studio** runs `shard dev` as a child process and points its webview at the runner. Its own UI
  comes with the Studio spec.

### Source locations

Bundles carry inline source maps. When a system throws, the runner (0003) and the protocol's
error log resolve the top project frame through the source map and attach
`source: "scripts/main.ts:42:7"` to the logged error. Bundle, reload, and migration errors carry
the same field. In Node the resolution uses `module.findSourceMap`. In browsers `shard dev`
resolves stack frames with the source maps it built.

### Type checking

`shard check [--json]` runs the TypeScript 7 compiler (`tsgo`) in `--noEmit` mode on the project
and returns diagnostics as `{ file, line, column, code, message }`. Bundling never waits for type
checks. A type error doesn't block a reload, but `shard check` and the MCP tool report it.

### API sketch

```ts
// @aethervtt/shard-project (engine side; headless-testable)
const reloader = createProjectReloader(app, { namespace: manifest.name })
const report = await reloader.reload(() => import(bundleUrl))  // steps 2–6
// report: { ok, ms, migrated: [...], orphaned: [...], systems: { added, removed, changed }, error? }

// @aethervtt/shard-core
withRedefinition('star-explorer', () => { /* evaluate module */ })

// apps/cli
const bundler = await createBundler({ root, entry, onBuild })   // esbuild context + watch
```

### Agent surface

- **Protocol:** `project.status` (last build and reload: time, errors with source locations,
  orphaned components), `project.reload` (force a rebuild and reload), and a `project` subscription
  topic for reload reports.
- **MCP:** `project_status`, `reload_project`, and `typecheck` (runs `shard check`, returns
  diagnostics). The `step` tool's result includes a note when the project reloaded since the last
  step, so an agent knows its edit took effect.
- **CLI:** `shard dev [--port]` and `shard check [--json]`.
- **Errors:** `project/bundle-failed`, `project/node-builtin`, `project/reload-failed`,
  `project/migration-failed`, `project/orphaned-component` (a warning).
- A generated skill (`.agents/skills/iterate-on-a-system.md`) walks through editing, checking
  `project_status`, stepping, and screenshotting.

## Decisions

- **Reload the whole bundle, not individual modules.** Systems and definitions change together.
  Partial reloads would let new systems run against old definitions, and a small project bundle
  rebuilds in milliseconds anyway.
- **esbuild, one path.** It's fast, incremental, and a single small native dependency. One
  bundle format serves Node, browsers, Studio, and export, so behavior can't differ by host.
- **Engine modules are external and shared.** The component registry is global per app. Bundling
  a second copy of `@aethervtt/shard-core` would create a second registry, so nothing the project defines
  would match what the engine queries.
- **Migrate through JSON.** The serializers and validators already exist for every component. Hot
  reload reuses them, and a migration that would corrupt data fails validation instead.
- **Keep orphaned components.** Deleting data because a definition vanished from a file is the
  kind of surprise that loses an afternoon of play-testing state.
- **Type checking is separate from reload.** A reload stays fast and never waits on the checker,
  and diagnostics are always one call away.

## Acceptance criteria

- [x] Editing a system's body in a running headless app changes behavior from the next frame. Every
      entity and resource the change doesn't touch hashes the same before and after.
- [x] Adding a field with a default to a project component, on 100k entities, migrates them all, and
      the values in other fields are unchanged. The migration takes under 300 ms.
- [x] A syntax error, a throwing `build`, and a migration that can't validate (a string field
      becoming `f32`) each leave the old code running and report an error with a source location
      or a JSON pointer. Fixing the file reloads normally.
- [x] A system that throws logs `source: "scripts/<file>.ts:<line>:<col>"` pointing at the throwing
      line, in Node and in the browser.
- [x] `import 'node:fs'` in a script fails the bundle with `project/node-builtin`.
- [x] `star-explorer` runs in a browser through `shard dev`. Saving a script reloads the project
      within 500 ms without reloading the page, and `shard mcp --attach` drives that page.
- [x] The engine and the project share one module instance per `@aethervtt/shard-*` package in both Node and
      the browser (asserted by identity of a registered component).
- [x] Rebuilding and swapping `star-explorer` takes under 100 ms, not counting the debounce.
- [x] `shard check --json` reports a deliberate type error with file, line, and column, and exits 1.

## Implementation notes

- **Redefinition keeps the id.** Core has `beginRedefinition(ns)` / `endRedefinition()`, not a
  synchronous `withRedefinition` callback, because bundles import asynchronously. Every
  redefinition can `undo()` itself. `World.redefine(def, migrate?)` swaps definitions, and
  `Table.redefine` rebuilds storage only when the layout changed.
- **The build isn't staged on a copy.** The reloader migrates data, unloads the old plugin, and
  builds the new one. On any throw it reverses all of that: it redefines back with the saved
  values, undoes the catalog changes, and rebuilds the old plugin. The atomicity is the same.
- **App:** `unloadPlugin`, `loadPlugin`, `systemsOf`, and `systemRun` exist, and the app records
  which plugin registered each system and set. Observers registered during a project build are
  captured by wrapping `world.observe`.
- **Resources** gained `reload: 'keep' | 'replace'` (default keep). Action maps use `replace`, so
  edited bindings apply, and `addActions` replaces a map with the same name. The spec's "schema'd
  resources migrate" doesn't apply yet, because resources have no schemas.
- **`systems.changed`** compares the source text of run functions, so it reports real edits (a
  change only to a closure variable doesn't count).
- **Fresh URLs:** each reload imports the bundle under a new URL (`?r=N`). Identical code rebuilds
  to the same content-hashed file, so reverting to an earlier version would otherwise import a
  stale cached module. This was found in the browser, and a Node regression test covers it.
- **Pausing:** a frame that throws pauses the app with `AppControl.pausedByError` and rejects
  pending `time.step` waiters (`AppControl.abort`), headless or in the browser. The next successful
  reload, the fix, resumes the app. `time.resume` clears the flag too.
- **`shard dev` pushes reloads over Vite's HMR socket** (`shard:project`, `shard:assets`), not a
  protocol hub. It doesn't host a hub, so it never competes with `shard mcp --attach` or
  `shard serve` for port 7811. The page dials the tool hub and retries with backoff. It was checked
  against `shard serve`'s hub, which is the same Hub class as `mcp --attach`.
- **`ProjectSession`** in `@aethervtt/shard-project` holds the reloader and the status and serves
  `project.status` and `project.reload`. `project.reload` takes `url`, or `error` for a dev server
  reporting a failed build. Hosts add methods through the new `methods` option on
  `createProtocolServer`, and publish events with `server.publish(topic, …)` on a `project` topic.
- **Source locations:** a small TypeScript source-map decoder (`SourceMap`, `inlineSourceMap`,
  `locateInBundle`) runs in browsers. In Node, `locateInProject` reads project frames once Node has
  already mapped the stack. The `Log.annotate` hook adds `source`, and wrapped errors
  (`app/system-failed`) are searched through `cause`. The browser page reported
  `scripts/main.ts:50:23` for a throwing system.
- **`openProject({ code: 'bundle' | 'source', watch })`.** `@aethervtt/shard-testing` uses `source`, so test
  files and the game share modules.
- **Template fix:** the template and example `tsconfig` needed `types: ['node', '@webgpu/types']`
  and matching devDependencies, because the engine ships as TypeScript source. The old template
  failed `tsc`.
- Measured: rebuilding and swapping star-explorer takes under 100 ms (in the test), a save shows up
  in the browser in 139 ms, and migrating a field on 100k entities takes under 300 ms (in the test).

## Open questions

- None blocking. Deferred: keeping selected module state across reloads (an opt-in
  `import.meta.hot`-style hook) if a real project needs it.
