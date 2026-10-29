# 0093 — Published CLI

- **Status:** accepted
- **Packages:** `apps/cli` (`@aethervtt/shard-cli`, published), `@aethervtt/shard-node`,
  `@aethervtt/shard-net`, `scripts/release.mjs`
- **Depends on:** 0012, 0085, 0092

## Context

Every engine package is on npm, but the `shard` command isn't: `apps/cli` is private and only runs
inside the repository. Projects made by `shard init` outside the repository already list
`@aethervtt/shard-cli` as a dependency, so they can't even install. A game built from npm packages
gets no `shard dev`, `shard test`, `shard server`, `shard lobby` or `shard run --net`.

The CLI assumes the repository in four places: it starts through `tsx` from its TypeScript source;
`shard dev` builds its import map from the repository's `packages/` folder and each package's
string `exports['.']`; the agent docs' error catalog scans each package's `src/`; and the release
script packs only `packages/*`.

## Goals

- `@aethervtt/shard-cli` on npm, released with the engine at the same version.
- `npx @aethervtt/shard-cli init my-game` makes a project that installs and runs from npm.
- In a project with the CLI installed, `npx shard <command>` (or `pnpm exec shard`) runs every
  command, as `pnpm exec shard` does inside the repository today.
- The same CLI keeps working unchanged inside the repository (workspace links, source exports).

## Non-goals

- The unscoped `shard` name on npm: it belongs to another package. Plain `npx shard` works only
  where the CLI is installed.
- `npm create @aethervtt/shard`. A small `@aethervtt/create-shard` can follow.
- Studio (`apps/studio`) and the playground stay private.

## Design

### Packaging

- `scripts/release.mjs` packs `apps/cli` besides `packages/*` (an explicit list of publishable
  apps), with the same exact internal versions.
- The CLI's own code ships compiled to `dist/` like the packages. `bin/shard.mjs` stays: it still
  registers `tsx`, now only for project code (`code: 'source'` imports of a project's `.ts`), so
  `tsx` stays a dependency.
- `runner/` (the `shard dev` page: `index.html`, `main.ts`, `audio-preview.*`) ships as files;
  Vite compiles them at run time as it does in the repository.
- `playwright` becomes an optional peer dependency (like `verify`'s) and loads with `import()`.
  `shard audio preview` without it fails with `cli/missing-playwright`, naming the install
  command; `shard capture` already loads it lazily through `verify`.

### Finding the engine

One function, `enginePackages(from)` (`@aethervtt/shard-node`), lists the installed
`@aethervtt/shard-*` packages, reading each `package.json`: its name, its root, and its entry (a
string `exports['.']` in the repository, `exports['.'].default` when published). It follows
`@aethervtt/shard-*` dependencies from its own package and from `from` (the CLI and the project),
then adds the core's siblings: that covers the repository, npm's hoisted layout, and pnpm's
isolated one, where siblings aren't enough. Both `shard dev`'s import map and `collectErrorCodes`
use it:

- The import map points each package at its resolved entry. `shard dev`'s Vite config excludes
  `@aethervtt/shard-*` from dependency pre-bundling, so the runner and the project bundle load the
  same module instances. Excluded packages' own dependencies (CommonJS such as `jpeg-js` among
  them) are still pre-bundled through Vite's `pkg > dep` form, for installed packages a page can
  load (not the CLI, `node`, `platform-node`, `testing`, or `ws`).
- `collectErrorCodes` scans `src/` when a package has it and `dist/` otherwise (compiled JavaScript
  keeps `new ShardError('code', …)` and its hint), and names the source by `package.json` name.
- `fs.allow` covers every engine package root.

### Tests

`shard test` inlines `@aethervtt/shard-*` in Vitest (`server.deps.inline`). Installed from npm, the
engine would otherwise load outside Vitest's module graph, and its `import()` of the project entry
(in `openProject` or `loadHeadlessCode`) would make a second copy of the project's components next
to the one the test file imported.

### Templates

`shard init` outside the repository writes the CLI's own version range (`^0.4.0`) instead of
`0.x`, so a new project pins the engine it was made with.

### Agent surface

Unchanged commands. Errors: `cli/missing-playwright`.

## Decisions

- **Keep `tsx`.** Projects are TypeScript, loaded as source by tests and headless runs; compiling
  them first would change how `shard test` resolves modules.
- **Explicit publishable apps.** Publishing every app would ship Studio and the playground.

## Acceptance criteria

`pnpm release --check` (and `pnpm release --cli-check` alone) installs coin-rush with every tarball,
CLI included, in a temporary folder outside the repository, and checks:

- [x] `shard validate`, `shard run --frames 60`, and `shard run --net clients=2` (converged).
- [x] `shard docs` writes an error catalog with the engine's codes (`net/…`, `ecs/…`).
- [x] `shard test` passes the project's tests.
- [x] `shard init` writes a project pinned to `^<version>`.
- [x] `shard dev` serves a page whose import map points at installed `dist` entries. Loading it in
      Chromium (connected to `shard server`, drawing every replicated entity) was checked by hand.
- [x] Inside the repository every CLI test still passes unchanged.
- [ ] `shard audio preview` without Playwright fails with `cli/missing-playwright` (built, not yet
      exercised by a test).

Found on the way and fixed in `@aethervtt/shard-net`: `commands()` returns none and `sendEvent`
delivers locally when an app has no networking, so a multiplayer project's `onServer` systems run
in a plain `shard run`.

## Open questions

- Package size: Vite, Vitest, esbuild and the Dawn binaries make `npx` slow the first time.
  Measure, and consider a smaller `@aethervtt/shard-server` (server and lobby only) if it matters.
