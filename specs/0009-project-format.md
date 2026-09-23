# 0009 — Project format

- **Status:** accepted
- **Packages:** `@shard/project`
- **Depends on:** 0002, 0003

## Context

Everything in M3 needs a project to point at: the CLI runs one, the MCP server opens one, scene
files live in one. A project is a folder an agent can read top to bottom and understand: a
manifest, data files with schemas, the game's own code, and generated instructions that tell an
agent how this particular project works.

## Goals

- A `shard.json` manifest with a JSON Schema.
- A fixed folder layout.
- A project's code as one plugin, so projects extend the engine the same way engine packages do.
- Generated agent docs (`AGENTS.md` + `.agents/`) from the live registry: every component,
  resource, and event with its schema and description.
- `shard init` scaffolding (the CLI command is in 0012; the template lives here).

## Non-goals

- Bundling project code for Studio or the browser (user scripts spec, M4). In M3 the CLI loads
  project code through Vite's module runner.
- Asset import settings and `.meta` files (asset database, M4).

## Design

### Layout

```
my-game/
  shard.json            manifest
  AGENTS.md             generated: how to work on this project (safe to extend; see below)
  .agents/              generated: skills and reference (component catalog, error codes)
  scripts/main.ts       the project plugin (entry point)
  scripts/**            game code: components, systems, generators
  scenes/*.scene.json   scenes (0010)
  shaders/**            project shader modules (project::…)
  assets/**             source assets (M4)
  tests/*.test.ts       gameplay tests (0012)
  .shard/               cache; gitignored, always rebuildable
```

### Manifest

```json
{
  "$schema": "./.shard/schemas/shard.schema.json",
  "name": "star-explorer",
  "version": "0.1.0",
  "engine": "0.x",
  "entry": "scripts/main.ts",
  "startScene": "scenes/main.scene.json",
  "seed": 1,
  "window": { "width": 1280, "height": 720, "msaa": 4 },
  "plugins": ["render/forward", "input"]
}
```

`plugins` names engine plugins to enable (the built-in set is resolved by name); the project's own
plugin comes from `entry`. Validation errors use the usual `ShardError` paths.

### Project plugin

```ts
// scripts/main.ts
import { defineProject } from '@shard/project'
export default defineProject({
  name: 'star-explorer',
  build(app) { app.addSystems(Update, fly) },
})
```

`defineProject` is `definePlugin` with the project name enforced as the namespace for its
components (`star-explorer/Ship`), so project types never collide with engine types.

### Loading

`loadProject(platform, root)` reads and validates the manifest, then returns a `ProjectInfo`. A
host (CLI, Studio) builds the `App`: engine plugins from `plugins`, the project plugin from
`entry`, `seed` into `AppOptions`, then loads `startScene` (0010).

### Agent docs

`shard docs` (0012) regenerates, from the running app's registry:

- `.agents/components.md`: every component with description, fields, types, ranges, defaults,
  and what it requires. The same data as the JSON Schemas, readable.
- `.agents/errors.md`: error codes seen in the engine packages with their hints.
- `.agents/skills/*.md`: task recipes (add a component, write a system, build a scene, write a
  gameplay test, take a screenshot), each a short workflow using the CLI/MCP tools.
- `.shard/schemas/*.json`: JSON Schemas for `shard.json`, scene files, and every component.
- `AGENTS.md`: a generated block between `<!-- shard:generated -->` markers (project summary,
  commands, where things live) plus free text outside the markers that regeneration preserves.

## Decisions

- **The project is a plugin.** No special project API; everything an engine package can do, a
  project can do.
- **Docs are generated from the registry, not written by hand.** They can't go stale, and they
  describe the project's own components alongside the engine's.
- **Project namespace enforced.** Collisions are impossible and file contents say where a type came
  from.

## Acceptance criteria

- [ ] `shard.json` has a JSON Schema; invalid manifests fail with paths and hints.
- [ ] `loadProject` + a host builds an app from a sample project and loads its start scene.
- [ ] A project component outside the project namespace throws `project/namespace`.
- [ ] Regenerating docs preserves text outside the markers and updates the catalog when a component
      is added.
- [ ] The generated component catalog lists every registered component with its fields and
      descriptions.

## Open questions

- **Deferred to M4 (user scripts / bundling):** third-party engine plugins from npm in `plugins`,
  resolved by package name like `entry`. Built-in plugin names are all M3 needs.
