# Error codes

Every engine error is a `ShardError` with one of these codes.

| Code | Source | Hint |
|---|---|---|
| `animation/invalid-clip` | @shard/animation |  |
| `animation/invalid-joint-map` | @shard/animation |  |
| `animation/invalid-mask` | @shard/animation |  |
| `animation/no-model` | @shard/animation | Clips from .anim.json animate whatever plays them: preview the scene that uses it with a screenshot. |
| `animation/no-player` | @shard/animation | Add animation/AnimationPlayer to the model root first. |
| `animation/unknown-socket` | @shard/animation | Put animation/BoneSocket { "name": ... } on the joint; on a model, add it with a SceneInstance override on the joint path. |
| `animgraph/bad-blend` | @shard/animation | Give each clip its own threshold. |
| `animgraph/bad-condition` | @shard/animation | Conditions use parameter names, numbers, !, &&, \|\|, and comparisons: "grounded && speed > 0.1". |
| `animgraph/bad-parameter` | @shard/animation | Use letters, digits, _ and ., starting with a letter. |
| `animgraph/bad-state` | @shard/animation |  |
| `animgraph/bad-transition` | @shard/animation | Without either it would fire every frame. |
| `animgraph/duplicate-layer` | @shard/animation |  |
| `animgraph/invalid-json` | @shard/animation |  |
| `animgraph/no-animator` | @shard/animation | Add animation/Animator (with a graph) to the entity first. |
| `animgraph/unknown-clip` | @shard/animation | glTF clips are "assets/model.glb#Animation/Name"; get_asset on the model lists them. |
| `animgraph/unknown-component` | @shard/animation |  |
| `animgraph/unknown-field` | @shard/animation |  |
| `animgraph/unknown-mask` | @shard/animation | Masks are *.mask.json files; check the path. |
| `animgraph/unknown-parameter` | @shard/animation |  |
| `animgraph/unknown-state` | @shard/animation |  |
| `animgraph/unreachable-state` | @shard/animation | Add a transition into it, or remove it. |
| `app/duplicate-method` | @shard/runtime |  |
| `app/duplicate-plugin` | @shard/runtime | Unload it first (unloadPlugin). |
| `app/duplicate-system` | @shard/runtime | System names must be unique across all schedules. |
| `app/invalid-state` | @shard/runtime |  |
| `app/missing-plugin` | @shard/runtime |  |
| `app/not-initialized` | @shard/runtime | Await app.init() (or app.run()) first. |
| `app/plugin-cycle` | @shard/runtime |  |
| `app/system-cycle` | @shard/core | Remove one of the after/before constraints in this cycle. |
| `app/system-failed` | @shard/core |  |
| `assets/duplicate-extension` | @shard/assets | Every data type needs its own extension. Pick another one. |
| `assets/import-failed` | @shard/assets |  |
| `assets/invalid-importer` | @shard/assets |  |
| `assets/invalid-meta` | @shard/assets | Delete the .meta to get a new guid (references by guid will break), or restore it. |
| `assets/load-failed` | @shard/assets |  |
| `assets/move-target-exists` | @shard/assets |  |
| `assets/no-listing` | @shard/assets | Import on a host with file listing (the CLI, the dev server, Studio). |
| `assets/not-found` | @shard/assets | Check the path; it starts at the project root, e.g. "data/weapons/laser.weapon.json". |
| `assets/not-loaded` | @shard/assets |  |
| `assets/outside-roots` | @shard/assets |  |
| `assets/read-only` | @shard/assets | Use the CLI or Studio, which can write to the project folder. |
| `assets/unknown-importer` | @shard/assets | Remove "importer" from the .meta to pick one by file extension. |
| `assets/unknown-type` | @shard/assets | Define it (project.dataAsset) before loading its files. |
| `audio/decode-failed` | @shard/audio | Re-import the file (shard import --json). |
| `audio/invalid-duck` | @shard/audio | by is the share of gain taken away: 0.3 plays the bus at 70%. |
| `audio/no-plugin` | @shard/audio | Add "audio" to plugins in shard.json (or app.addPlugin(audioPlugin())). |
| `audio/unknown-bus` | @shard/audio |  |
| `audio/unsupported-format` | @shard/audio | Audio clips are WAV (PCM or float), Ogg Vorbis, Ogg Opus, MP3, or FLAC. |
| `data/extends-cycle` | @shard/assets | Point "$extends" at a file that does not extend this one. |
| `data/extends-type-mismatch` | @shard/assets |  |
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
| `ik/not-a-chain` | @shard/animation | Each joint must be an ancestor of the next (root → mid → tip; chain entries top first, above the joint). |
| `ik/unknown-joint` | @shard/animation | Joint fields are paths under the IK entity or an ancestor (the model root): "Armature/Hips/UpLeg_L". animation_describe on the model lists what bound. |
| `input/unknown-action` | @shard/input | Use "<map name>.<action>", e.g. "game/Controls.jump". |
| `input/unknown-binding` | @shard/input | Use Gamepad:LeftStick, Gamepad:RightStick, { composite: "wasd" \| "arrows" }, or { up, down, left, right }. |
| `mesh/invalid` | @shard/mesh | positions/normals: 3 per vertex, uvs/uvs1: 2, colors/tangents/joints/weights: 4; indices must be < vertex count. |
| `mesh/invalid-artifact` | @shard/mesh | Re-import the source (`shard import --force`). |
| `nav/bad-cache` | @shard/nav |  |
| `nav/bake-failed` | @shard/nav | Check the NavSource geometry has upward faces flatter than maxSlope, wide enough for agentRadius. |
| `nav/invalid-grid` | @shard/nav |  |
| `nav/no-navmesh` | @shard/nav | Check nav.describe: the grid may be waiting for data, or the navmesh for sources. |
| `nav/not-ready` | @shard/nav | Add the nav plugin (or nav/grid for grids only) and await app.init(). |
| `nav/out-of-bounds` | @shard/nav | nav.describe lists each grid and navmesh with its bounds. |
| `particles/invalid-effect` | @shard/particles |  |
| `physics/both-dimensions` | @shard/physics | Enable one physics plugin per app: physics3d for 3D games, physics2d for 2D. |
| `physics/character-has-body` | @shard/physics | The controller makes its own kinematic body and capsule. Remove RigidBody and Collider, or put extra colliders on a child. |
| `physics/invalid-shape` | @shard/physics | Check radius, halfExtents, halfHeight, points, or the mesh. |
| `physics/not-ready` | @shard/physics | Add the physics3d or physics2d plugin and await app.init() before querying. |
| `physics/unsupported-shape` | @shard/physics | 2D shapes: ball, cuboid, capsule, convex, trimesh, heightfield, segment, polyline. |
| `platform/fs-not-found` | @shard/platform-node |  |
| `platform/fs-read-only` | @shard/platform-web | Writes need a writable host such as Studio or the CLI. |
| `prefab/cycle` | @shard/scene | A prefab can’t contain or extend itself, directly or through others. |
| `prefab/duplicate-name` | @shard/scene | Rename the child, or change the generated one with "overrides" instead. |
| `prefab/invalid` | @shard/scene | Write { "version": 1, "root": { "name": "...", "components": {...}, "children": [...] } }, or a variant with "extends". |
| `prefab/invalid-component` | @shard/scene |  |
| `prefab/not-an-instance` | @shard/protocol | Pass the entity with scene/PrefabInstance or scene/SceneInstance, e.g. "player-ship". |
| `prefab/not-found` | @shard/scene | Pass a *.prefab.json path under an asset root (run `shard import` for new files), or register one with registerPrefab. |
| `prefab/not-loaded` | @shard/scene | Preload it with `await loadPrefab(world, path)`, or place it with scene/PrefabInstance, which waits for it to load. |
| `prefab/read-only` | @shard/scene | Apply from the CLI or Studio, which can write the project folder. |
| `prefab/stale-override` | @shard/scene | The prefab changed (a renamed or removed entity?). The override is kept in the file; fix or delete it. |
| `prefab/unknown-field` | @shard/scene | A prefab has "root" (an entity), or "extends" plus "rootComponents", "overrides", and "children" (a variant). |
| `prefab/unknown-path` | @shard/scene | Override paths are relative to the root, e.g. "Hull" or "Hull/Cockpit". |
| `prefab/unsupported-version` | @shard/scene |  |
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
| `protocol/no-preview` | @shard/protocol | Previews exist for textures, materials, meshes, scenes, and types that register one. |
| `protocol/no-renderer` | @shard/protocol |  |
| `protocol/no-view` | @shard/protocol |  |
| `protocol/unknown-component` | @shard/protocol | schema.list returns every component name. |
| `protocol/unknown-debug-view` | @shard/protocol | Use 'clusters', 'cascades', 'lod', 'culling', 'none', or 'shadow-map:<light>'. |
| `protocol/unknown-entity` | @shard/protocol | Pass an entity id from world.query, or a scene path like "ship/camera". |
| `protocol/unknown-overlay` | @shard/protocol |  |
| `protocol/unknown-resource` | @shard/protocol |  |
| `protocol/unsettable-resource` | @shard/protocol | Only resources that are plain JSON objects can be set. |
| `render/capture-format` | @shard/render |  |
| `render/duplicate-node` | @shard/render |  |
| `render/graph-cycle` | @shard/render | Check reads/writes and `after` on these nodes. |
| `render/material-field-clash` | @shard/render | Give the field another name, or use extends: "none". |
| `render/material-standard-missing` | @shard/render |  |
| `render/missing-resource` | @shard/render | Declare it in a node's `writes` (as a transient texture) or with graph.declare. |
| `render/no-shadow-map` | @shard/render | Set shadows: true on the light, and check render.describe for the shadow budget. |
| `render/no-view` | @shard/render | Spawn an entity with Camera3d, or pass the camera to pick from. |
| `render/not-ready` | @shard/render | Await app.init() so the render plugin can create the GPU device. |
| `render/too-many-joints` | @shard/gltf | Split the mesh, or remove helper bones before exporting. |
| `render/unknown-buffer` | @shard/render |  |
| `render/unknown-camera` | @shard/render | Pass a Camera3d entity that has rendered at least one frame. |
| `render/unknown-material-type` | @shard/render |  |
| `retarget/unmapped-root` | @shard/animation | Add it to the joint map (*.jointmap.json): { "joints": { "<source>": "<target>" } }. |
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
| `schema/type-mismatch` | @shard/assets | Give the base file by path: { "path": "data/weapons/laser.weapon.json" }. |
| `schema/unknown-field` | @shard/ui |  |
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
| `sprite/atlas-too-large` | @shard/sprite | Raise maxSize, or split the images into several atlases. |
| `sprite/duplicate-region` | @shard/sprite | Region names are unique within an atlas. |
| `sprite/invalid-tilemap` | @shard/sprite |  |
| `sprite/no-atlas` | @shard/sprite |  |
| `sprite/no-layer` | @shard/sprite |  |
| `sprite/no-texture` | @shard/sprite |  |
| `sprite/not-a-tilemap` | @shard/sprite |  |
| `sprite/tile-out-of-range` | @shard/sprite |  |
| `sprite/tilemap-not-loaded` | @shard/sprite | Wait for its TilemapData asset, or create one with TilemapData.create. |
| `sprite/unsupported-image` | @shard/sprite |  |
| `testing/missing-component` | @shard/testing |  |
| `testing/unknown-entity` | @shard/testing | Use a scene path like "ship/camera" or an entity id. |
| `text/font-parse-failed` | @shard/text | Fonts import from .ttf and .otf files (TrueType or CFF outlines). |
| `text/import-failed` | @shard/text |  |
| `text/invalid-metrics` | @shard/text | Re-import the font (`shard import`). |
| `text/not-loaded` | @shard/protocol | asset.list shows fonts (type Font); pass a .ttf or .otf path. |
| `texture/decode-failed` | @shard/texture |  |
| `texture/invalid` | @shard/texture |  |
| `texture/transcoder-unavailable` | @shard/texture | Basis Universal ships in @shard/texture/vendor/basis; check the files are present. |
| `texture/unsupported-format` | @shard/texture | Use a 2D image or a cube map (6 faces). |
| `ui/ambiguous-path` | @shard/ui |  |
| `ui/disabled` | @shard/ui | Set disabled to false on its UiButton or UiToggle first. |
| `ui/hidden` | @shard/ui | A node with display none, under a hidden anchor, or outside a root can't be clicked. |
| `ui/invalid-length` | @shard/ui | Use pixels (120 or "120"), a percent of the parent ("50%"), or "auto". |
| `ui/no-root` | @shard/ui | Parent it (ChildOf) under an entity with ui/UiRoot, or add UiRoot to the top node. |
| `ui/not-clickable` | @shard/ui | ui.click takes the path of a node with ui/UiButton or ui/UiToggle (see ui.describe). |
| `ui/not-focusable` | @shard/ui | Focus takes a node with UiButton, UiToggle, UiSlider, or UiTextInput. |
| `ui/unknown-node` | @shard/ui | Pass an entity id or a scene path of a node under a UiRoot (ui.describe lists them). |
| `ui/unknown-state` | @shard/ui |  |
| `ui/unknown-style` | @shard/ui | Add it to the root's *.theme.json styles, or fix UiNode.style (ui.describe shows each node's). |
