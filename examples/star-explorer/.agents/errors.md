# Error codes

Every engine error is a `ShardError` with one of these codes.

| Code | Source | Hint |
|---|---|---|
| `app/duplicate-plugin` | @shard/runtime |  |
| `app/duplicate-system` | @shard/runtime | System names must be unique across all schedules. |
| `app/invalid-state` | @shard/runtime |  |
| `app/missing-plugin` | @shard/runtime |  |
| `app/not-initialized` | @shard/runtime | Await app.init() (or app.run()) first. |
| `app/plugin-cycle` | @shard/runtime |  |
| `app/system-cycle` | @shard/core | Remove one of the after/before constraints in this cycle. |
| `app/system-failed` | @shard/core |  |
| `ecs/dead-entity` | @shard/core | It was despawned, or the id is stale. Check world.isAlive(entity) first. |
| `ecs/entity-limit` | @shard/core | High-count data (particles, foliage, tiles) belongs in buffers, not entities. |
| `ecs/missing-component` | @shard/core | Check world.has(entity, component) first, or use tryGet. |
| `ecs/missing-resource` | @shard/core | Insert it with insertResource, or add the plugin that provides it. |
| `ecs/no-resource-init` | @shard/core | Use insertResource with a value instead. |
| `gpu/missing-feature` | @shard/gpu |  |
| `gpu/no-adapter` | @shard/gpu |  |
| `gpu/no-context` | @shard/gpu |  |
| `gpu/unsupported` | @shard/gpu | Use a browser or webview with WebGPU, or pass `gpu` (e.g. from the `webgpu` package in Node). |
| `input/unknown-action` | @shard/input | Use "<map name>.<action>", e.g. "game/Controls.jump". |
| `input/unknown-binding` | @shard/input | Use Gamepad:LeftStick, Gamepad:RightStick, { composite: "wasd" \| "arrows" }, or { up, down, left, right }. |
| `mesh/invalid` | @shard/mesh | positions/normals: 3 floats per vertex, uvs: 2, colors: 4; indices must be < vertex count. |
| `platform/fs-not-found` | @shard/platform-node |  |
| `platform/fs-read-only` | @shard/platform-web | Writes need a writable host such as Studio or the CLI. |
| `project/entry-failed` | @shard/node | The entry must be a module whose default export is defineProject({...}). |
| `project/entry-invalid` | @shard/node | End the file with `export default project`, where project = defineProject({...}). |
| `project/invalid-json` | @shard/project |  |
| `project/invalid-manifest` | @shard/project |  |
| `project/invalid-name` | @shard/project | Use lowercase letters, digits, and dashes, starting with a letter (e.g. "star-explorer"). |
| `project/namespace` | @shard/project |  |
| `project/not-found` | @shard/project | Run `shard init <dir>` to create a project, or run from a project folder. |
| `project/unknown-plugin` | @shard/project |  |
| `protocol/internal` | @shard/protocol |  |
| `protocol/invalid-components` | @shard/protocol |  |
| `protocol/invalid-params` | @shard/protocol |  |
| `protocol/no-files` | @shard/protocol |  |
| `protocol/no-view` | @shard/protocol |  |
| `protocol/unknown-component` | @shard/protocol | schema.list returns every component name. |
| `protocol/unknown-entity` | @shard/protocol | Pass an entity id from world.query, or a scene path like "ship/camera". |
| `protocol/unknown-resource` | @shard/protocol |  |
| `protocol/unsettable-resource` | @shard/protocol | Only resources that are plain JSON objects can be set. |
| `render/duplicate-node` | @shard/render |  |
| `render/graph-cycle` | @shard/render | Check reads/writes and `after` on these nodes. |
| `render/missing-asset` | @shard/render |  |
| `render/missing-resource` | @shard/render | Declare it in a node's `writes` (as a transient texture) or import it. |
| `render/not-ready` | @shard/render | Await app.init() so the render plugin can create the GPU device. |
| `scene/already-loaded` | @shard/scene | Use reloadScene to replace it, or pass a different id. |
| `scene/asset-unavailable` | @shard/scene | Use a scene asset ("#name") or a procedural mesh ("procedural:sphere?radius=1"). |
| `scene/conflicting-fields` | @shard/scene |  |
| `scene/derived-component` | @shard/scene |  |
| `scene/duplicate-name` | @shard/scene | Names must be unique among siblings; they form entity paths. |
| `scene/invalid` | @shard/scene |  |
| `scene/invalid-asset` | @shard/scene | Materials: { "type": "Material", "value": {...} }. Meshes: { "type": "Mesh", "procedural": "sphere", "params": {...} }. |
| `scene/invalid-name` | @shard/scene |  |
| `scene/invalid-procedural-param` | @shard/scene |  |
| `scene/not-loaded` | @shard/scene |  |
| `scene/unknown-component` | @shard/scene | Use a registered name like "core/Transform" or "render/Camera3d" (see .agents/components.md). |
| `scene/unknown-entity-path` | @shard/scene |  |
| `scene/unknown-field` | @shard/scene |  |
| `scene/unknown-procedural` | @shard/scene |  |
| `scene/unknown-procedural-param` | @shard/scene |  |
| `scene/unknown-resource` | @shard/scene |  |
| `scene/unsupported-version` | @shard/scene |  |
| `schema/ambiguous-name` | @shard/core | Two modules define the same name. Rename one, or import the shared definition. |
| `schema/asset-not-found` | @shard/core | Check the path, or that the asset has been imported. |
| `schema/asset-type-mismatch` | @shard/core |  |
| `schema/duplicate-name` | @shard/core | Two definitions share a name. Rename one, or import the existing definition. |
| `schema/future-version` | @shard/core |  |
| `schema/invalid-enum` | @shard/core |  |
| `schema/invalid-field` | @shard/core |  |
| `schema/invalid-name` | @shard/core | Use "namespace/PascalName", e.g. "game/Health". |
| `schema/invalid-version` | @shard/core | Versions are integers starting at 1. |
| `schema/missing-field` | @shard/core | Give a "guid", a "path", or both. |
| `schema/missing-migration` | @shard/core |  |
| `schema/out-of-range` | @shard/core |  |
| `schema/type-mismatch` | @shard/core | Use "#rrggbb", "#rrggbbaa", or a linear [r, g, b, a] array. |
| `schema/unknown-field` | @shard/core |  |
| `schema/unknown-preset` | @shard/core |  |
| `schema/unresolved-entity` | @shard/core | Entity paths are resolved by the scene loader; check the path exists. |
| `shader/compile` | @shard/shader |  |
| `shader/hook-signature-mismatch` | @shard/shader |  |
| `shader/invalid-path` | @shard/shader | Use lowercase `package::dir::name`, e.g. `project::water`. |
| `shader/link` | @shard/shader |  |
| `shader/link-unknown-module` | @shard/shader | Check the import path, or register the module. |
| `shader/link-unresolved` | @shard/shader |  |
| `shader/unknown-hook` | @shard/shader | Only functions marked @hook can be overridden. |
| `shader/unsupported-field` | @shard/shader | GPU structs take numbers, bools, enums, vectors, colors, and matrices. f64 and object fields are not allowed. |
| `shader/watch-unsupported` | @shard/shader |  |
| `testing/missing-component` | @shard/testing |  |
| `testing/unknown-entity` | @shard/testing | Use a scene path like "ship/camera" or an entity id. |
