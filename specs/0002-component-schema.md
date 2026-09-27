# 0002 — Component schema and reflection

- **Status:** implemented
- **Packages:** `@aethervtt/shard-core`
- **Depends on:** none

## Context

TypeScript types disappear at runtime, and the engine needs runtime type information for almost
everything: ECS storage layout, scene files, validation, the inspector, and the agent API. Without
one runtime schema, each of those grows its own hand-written description of every component and
they drift apart.

The schema is also the main thing an agent reads to understand a project. Field descriptions,
ranges, units, and defaults are written for that reader.

## Goals

- `defineComponent(name, fields, options)` returns a component definition with full static types.
- One definition drives: storage layout (0001), JSON serialization, validation, JSON Schema export,
  default values, and TypeScript type inference.
- Field metadata for agents and tools: `description`, `default`, `min`/`max`, `unit`, `hidden`,
  `readonly`.
- Stable, namespaced names (`core/Transform`, `game/Health`) that survive refactors.
- Versioning with migrations, so old scene files keep loading.
- The same system describes resources, events, and data assets.

## Non-goals

- Generating schemas from TS types with a compiler plugin. Runtime definitions are the source of
  truth; TS types are inferred from them.
- Binary serialization format (later, for saves and networking).

## Design

### Field types

| Type | Storage | JSON |
|---|---|---|
| `t.f32`, `t.f64` | Float32Array / Float64Array | number |
| `t.i8` `t.i16` `t.i32` `t.u8` `t.u16` `t.u32` | matching TypedArray | integer |
| `t.bool` | Uint8Array | boolean |
| `t.vec2` `t.vec3` `t.vec4` `t.quat` | Float32Array, stride 2/3/4/4 | `[x, y, …]` |
| `t.color` | Float32Array, stride 4 (linear RGBA) | `"#rrggbb[aa]"` or `[r, g, b, a]` |
| `t.enum(['idle', 'walk', 'run'])` | Uint8Array (index) | string |
| `t.entity` | Float64Array (-1 = null) | entity id, entity path (resolved by the scene loader), or null |
| `t.string` | object column | string |
| `t.handle('Mesh')` | object column | `{ guid, path }` (see Asset handles) |
| `t.list(inner)` | object column | array |
| `t.struct({...})` | object column | object |
| `t.json` | object column | any JSON (escape hatch, discouraged) |

### Asset handles

`t.handle(type)` references an asset: `mesh: t.handle('Mesh')`, `clip: t.handle('AudioClip')`.

- **Serialized** as `{ "guid": "…", "path": "assets/furniture/sofa.glb#Mesh0" }`. The GUID is the
  reference and survives renames; the path is for readers and is rewritten when the asset moves.
- **Input** may give only `path` or only `guid`. The loader resolves the other and writes both back.
- **Sub-assets** are addressed with `#Label` (a mesh or material inside a glTF, a sprite in an atlas).
- **Validation** checks existence and type: `schema/asset-not-found`, `schema/asset-type-mismatch`.
- **Runtime** storage is a reference-counted handle object in an object column. Loading, lifetime,
  and hot reload belong to the assets spec.

### Field options

Every type accepts options: `t.f32({ default: 100, min: 0, max: 100, unit: 'hp', description: '…' })`.
Parameterized types take options as their last argument: `t.enum(['a', 'b'], { default: 'b' })`.

Missing fields take their default. A field with `required: true` has no fallback, and leaving it out
is `schema/missing-field`.

### Definitions

```ts
export const Health = defineComponent(
  'game/Health',
  {
    current: t.f32({ default: 100, min: 0, description: 'Current hit points' }),
    max: t.f32({ default: 100, min: 1 }),
  },
  { description: 'Hit points. Entity dies when current reaches 0.', version: 1 },
)

export const Player = defineTag('game/Player', { description: 'The controlled avatar' })

type HealthData = Infer<typeof Health> // { current: number; max: number }
```

Names must be `namespace/PascalName` (`schema/invalid-name`). Each definition gets a dense,
process-wide numeric id when it's defined, used internally by the ECS; names are what gets
serialized. Each world has a `Registry` that rejects a second definition under a taken name
(`schema/duplicate-name`).

Resources and events (`defineResource<T>`, `defineEvent<T>`) are typed with TS generics and appear
in the registry by name and description. Describing them with field schemas, and data assets,
come with the scene and asset specs.

### Derived capabilities

From one definition:

- `layout` — column descriptors consumed by ECS tables.
- `defaults()` — a fresh default value object.
- `serialize(value)` / `deserialize(json)` — to and from plain JSON.
- `validate(json, ctx?)` — returns a list of `ShardError` with JSON pointer paths
  (`schema/type-mismatch` at `/current`, `schema/out-of-range`, `schema/unknown-field` with a
  "did you mean" hint, `schema/missing-field` for required fields).
- `ctx` (`SchemaContext`) optionally resolves entity paths and assets.
- `jsonSchema()` — JSON Schema 2020-12, with descriptions, used by editors, agents, and the MCP
  server to validate scene files before running anything.

### Versioning

`version` defaults to 1. Bumping it requires a `migrate(from, json) => json` function that upgrades
one step, from `from` to `from + 1`; `def.upgrade(json, fromVersion)` runs the chain. Data newer
than the build is `schema/future-version`. Scene files
record the component version they were written with; the loader migrates on read and writes the
current version back.

### Agent surface

- `registry.describe()` returns every registered component, resource, and event with its
  JSON Schema. This is what gets written into a project's generated agent docs.
- Validation errors carry exact paths, so an agent can fix `scenes/lobby.scene.json` at
  `/entities/12/components/game~1Health/current` without guessing.

## Decisions

- **Runtime definitions, inferred static types.** Works with erasable-only TS, needs no compiler
  plugin, and the runtime data exists for tools and agents.
- **Names are namespaced strings.** `core/`, `render/`, etc. for engine, `game/` or a project
  prefix for users. Avoids collisions between plugins.
- **Colors stored linear.** Authoring is sRGB hex; conversion happens on deserialize so the
  renderer never guesses. Arrays are linear (and may exceed 1 for HDR). Serialization writes hex
  when it round-trips exactly, and a linear array otherwise.
- **Handles are plain `AssetRef { type, guid, path }` values for now.** Reference counting and
  loading belong to the assets spec, which will replace the storage without changing the JSON.

## Acceptance criteria

- [x] `Infer<typeof C>` produces the exact TS type for every field type in the table.
- [x] `validate` catches wrong types, out-of-range values, unknown and missing fields, each with
      the correct JSON pointer.
- [x] `jsonSchema()` output validates the same inputs `validate` accepts (tested with a JSON Schema
      validator against a fixture set).
- [x] Round trip: `deserialize(serialize(v))` equals `v` for every field type.
- [x] A component at version 2 with a migration loads version-1 JSON correctly.
- [x] Registering a duplicate name throws `schema/duplicate-name`.
- [x] ECS tables (0001) build their columns from `layout` alone.

## Open questions

- Flattening numeric `t.struct` fields into TypedArray columns. Deferred until a profile asks
  for it.
