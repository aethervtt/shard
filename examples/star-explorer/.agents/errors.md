# Error codes

Every engine error is a `ShardError` with one of these codes.

| Code | Source | Hint |
|---|---|---|
| `app/duplicate-plugin` | @shard/runtime | Unload it first (unloadPlugin). |
| `app/duplicate-system` | @shard/runtime | System names must be unique across all schedules. |
| `app/invalid-state` | @shard/runtime |  |
| `app/missing-plugin` | @shard/runtime |  |
| `app/not-initialized` | @shard/runtime | Await app.init() (or app.run()) first. |
| `app/plugin-cycle` | @shard/runtime |  |
| `app/system-cycle` | @shard/core | Remove one of the after/before constraints in this cycle. |
| `app/system-failed` | @shard/core |  |
| `assets/import-failed` | @shard/assets |  |
| `assets/invalid-importer` | @shard/assets |  |
| `assets/invalid-meta` | @shard/assets | Delete the .meta to get a new guid (references by guid will break), or restore it. |
| `assets/load-failed` | @shard/assets |  |
| `assets/move-target-exists` | @shard/assets |  |
| `assets/not-found` | @shard/assets | Check the path, or run `shard import` to import new files. |
| `assets/not-loaded` | @shard/assets |  |
| `assets/outside-roots` | @shard/assets |  |
| `assets/read-only` | @shard/assets | Use the CLI or Studio, which can write to the project folder. |
| `assets/unknown-importer` | @shard/assets | Remove "importer" from the .meta to pick one by file extension. |
| `assets/unknown-type` | @shard/assets | Add the plugin that defines it (e.g. render/forward for Mesh and Material). |
| `ecs/dead-entity` | @shard/core | It was despawned, or the id is stale. Check world.isAlive(entity) first. |
| `ecs/entity-limit` | @shard/core | High-count data (particles, foliage, tiles) belongs in buffers, not entities. |
| `ecs/missing-component` | @shard/core | Check world.has(entity, component) first, or use tryGet. |
| `ecs/missing-resource` | @shard/core | Insert it with insertResource, or add the plugin that provides it. |
| `ecs/no-resource-init` | @shard/core | Use insertResource with a value instead. |
| `gltf/accessor-out-of-range` | @shard/gltf | The file is truncated or its byteOffset/count are wrong. |
| `gltf/buffer-missing` | @shard/gltf | Keep .bin files next to the .gltf, under the same name the file references. |
| `gltf/invalid` | @shard/gltf | Only glTF 2.0 files are supported. |
| `gltf/tangents-unavailable` | @shard/gltf |  |
| `gltf/unsupported-extension` | @shard/gltf |  |
| `gpu/missing-feature` | @shard/gpu |  |
| `gpu/no-adapter` | @shard/gpu |  |
| `gpu/no-context` | @shard/gpu |  |
| `gpu/unsupported` | @shard/gpu | Use a browser or webview with WebGPU, or pass `gpu` (e.g. from the `webgpu` package in Node). |
| `input/unknown-action` | @shard/input | Use "<map name>.<action>", e.g. "game/Controls.jump". |
| `input/unknown-binding` | @shard/input | Use Gamepad:LeftStick, Gamepad:RightStick, { composite: "wasd" \| "arrows" }, or { up, down, left, right }. |
| `mesh/invalid` | @shard/mesh | positions/normals: 3 per vertex, uvs/uvs1: 2, colors/tangents/joints/weights: 4; indices must be < vertex count. |
| `mesh/invalid-artifact` | @shard/mesh | Re-import the source (`shard import --force`). |
| `platform/fs-not-found` | @shard/platform-node |  |
| `platform/fs-read-only` | @shard/platform-web | Writes need a writable host such as Studio or the CLI. |
| `project/bundle-failed` | @shard/node |  |
| `project/entry-failed` | @shard/node | The entry must be a module whose default export is defineProject({...}). |
| `project/entry-invalid` | @shard/node | End the file with `export default project`, where project = defineProject({...}). |
| `project/invalid-json` | @shard/project |  |
| `project/invalid-manifest` | @shard/project |  |
| `project/invalid-name` | @shard/project | Use lowercase letters, digits, and dashes, starting with a letter (e.g. "star-explorer"). |
| `project/migration-failed` | @shard/project | Bump the component version and convert the old value in `migrate`, or change the field back. |
| `project/namespace` | @shard/project |  |
| `project/no-bundler` | @shard/project | Pass "url" with a built bundle. |
| `project/not-found` | @shard/project | Run `shard init <dir>` to create a project, or run from a project folder. |
| `project/reload-failed` | @shard/project |  |
| `project/unknown-plugin` | @shard/project |  |
| `protocol/internal` | @shard/protocol |  |
| `protocol/invalid-components` | @shard/protocol |  |
| `protocol/invalid-params` | @shard/protocol |  |
| `protocol/no-files` | @shard/protocol |  |
| `protocol/no-preview` | @shard/protocol | Previews exist for textures, materials, meshes, and scenes. |
| `protocol/no-renderer` | @shard/protocol |  |
| `protocol/no-view` | @shard/protocol |  |
| `protocol/unknown-component` | @shard/protocol | schema.list returns every component name. |
| `protocol/unknown-entity` | @shard/protocol | Pass an entity id from world.query, or a scene path like "ship/camera". |
| `protocol/unknown-resource` | @shard/protocol |  |
| `protocol/unsettable-resource` | @shard/protocol | Only resources that are plain JSON objects can be set. |
| `render/duplicate-node` | @shard/render |  |
| `render/graph-cycle` | @shard/render | Check reads/writes and `after` on these nodes. |
| `render/missing-resource` | @shard/render | Declare it in a node's `writes` (as a transient texture) or import it. |
| `render/not-ready` | @shard/render | Await app.init() so the render plugin can create the GPU device. |
| `scene/already-loaded` | @shard/scene | Use reloadScene to replace it, or pass a different id. |
| `scene/asset-unavailable` | @shard/scene |  |
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
| `schema/redefinition-active` | @shard/core |  |
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
| `shader/unsupported-field` | @shard/shader | GPU structs take numbers, bools, enums, vectors, colors, and matrices. f64 fields are not allowed; object fields are skipped. |
| `shader/watch-unsupported` | @shard/shader |  |
| `testing/missing-component` | @shard/testing |  |
| `testing/unknown-entity` | @shard/testing | Use a scene path like "ship/camera" or an entity id. |
| `texture/decode-failed` | @shard/texture |  |
| `texture/invalid` | @shard/texture |  |
| `texture/transcoder-unavailable` | @shard/texture | Basis Universal ships in @shard/texture/vendor/basis; check the files are present. |
| `texture/unsupported-format` | @shard/texture | Use a single 2D image for now. |
