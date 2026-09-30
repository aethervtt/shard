# Error codes

Every engine error is a `ShardError` with one of these codes.

| Code | Source | Hint |
|---|---|---|
| `animation/invalid-clip` | @aethervtt/shard-animation |  |
| `animation/invalid-joint-map` | @aethervtt/shard-animation |  |
| `animation/invalid-mask` | @aethervtt/shard-animation |  |
| `animation/no-model` | @aethervtt/shard-animation | Clips from .anim.json animate whatever plays them: preview the scene that uses it with a screenshot. |
| `animation/no-player` | @aethervtt/shard-animation | Add animation/AnimationPlayer to the model root first. |
| `animation/unknown-socket` | @aethervtt/shard-animation | Put animation/BoneSocket { "name": ... } on the joint; on a model, add it with a SceneInstance override on the joint path. |
| `animgraph/bad-blend` | @aethervtt/shard-animation | Give each clip its own threshold. |
| `animgraph/bad-condition` | @aethervtt/shard-animation | Conditions use parameter names, numbers, !, &&, \|\|, and comparisons: "grounded && speed > 0.1". |
| `animgraph/bad-parameter` | @aethervtt/shard-animation | Use letters, digits, _ and ., starting with a letter. |
| `animgraph/bad-state` | @aethervtt/shard-animation |  |
| `animgraph/bad-transition` | @aethervtt/shard-animation | Without either it would fire every frame. |
| `animgraph/duplicate-layer` | @aethervtt/shard-animation |  |
| `animgraph/invalid-json` | @aethervtt/shard-animation |  |
| `animgraph/no-animator` | @aethervtt/shard-animation | Add animation/Animator (with a graph) to the entity first. |
| `animgraph/unknown-clip` | @aethervtt/shard-animation | glTF clips are "assets/model.glb#Animation/Name"; get_asset on the model lists them. |
| `animgraph/unknown-component` | @aethervtt/shard-animation |  |
| `animgraph/unknown-field` | @aethervtt/shard-animation |  |
| `animgraph/unknown-mask` | @aethervtt/shard-animation | Masks are *.mask.json files; check the path. |
| `animgraph/unknown-parameter` | @aethervtt/shard-animation |  |
| `animgraph/unknown-state` | @aethervtt/shard-animation |  |
| `animgraph/unreachable-state` | @aethervtt/shard-animation | Add a transition into it, or remove it. |
| `app/duplicate-method` | @aethervtt/shard-runtime |  |
| `app/duplicate-plugin` | @aethervtt/shard-runtime | Unload it first (unloadPlugin). |
| `app/duplicate-system` | @aethervtt/shard-runtime | System names must be unique across all schedules. |
| `app/invalid-state` | @aethervtt/shard-runtime |  |
| `app/missing-plugin` | @aethervtt/shard-runtime |  |
| `app/not-initialized` | @aethervtt/shard-runtime | Await app.init() (or app.run()) first. |
| `app/plugin-cycle` | @aethervtt/shard-runtime |  |
| `app/system-cycle` | @aethervtt/shard-core | Remove one of the after/before constraints in this cycle. |
| `app/system-failed` | @aethervtt/shard-core |  |
| `assets/dependency-failed` | @aethervtt/shard-assets | Fix that file first; this one re-imports with it. |
| `assets/duplicate-extension` | @aethervtt/shard-assets | Every data type needs its own extension. Pick another one. |
| `assets/import-cycle` | @aethervtt/shard-assets | An asset can’t depend on itself, directly or through others. |
| `assets/import-failed` | @aethervtt/shard-assets |  |
| `assets/invalid-importer` | @aethervtt/shard-assets |  |
| `assets/invalid-meta` | @aethervtt/shard-assets | Delete the .meta to get a new guid (references by guid will break), or restore it. |
| `assets/load-failed` | @aethervtt/shard-assets |  |
| `assets/move-target-exists` | @aethervtt/shard-assets |  |
| `assets/no-listing` | @aethervtt/shard-assets | Import on a host with file listing (the CLI, the dev server, Studio). |
| `assets/no-source` | @aethervtt/shard-assets | Only assets imported from project files can be written back. |
| `assets/not-found` | @aethervtt/shard-assets | Check the path; it starts at the project root, e.g. "data/weapons/laser.weapon.json". |
| `assets/not-loaded` | @aethervtt/shard-assets |  |
| `assets/outside-roots` | @aethervtt/shard-assets |  |
| `assets/read-only` | @aethervtt/shard-assets | Use the CLI or Studio, which can write to the project folder. |
| `assets/registry-conflict` | @aethervtt/shard-assets | Two definitions (two apps or bundles) share the name. Rename one, or share the definition. |
| `assets/unknown-importer` | @aethervtt/shard-assets | Remove "importer" from the .meta to pick one by file extension. |
| `assets/unknown-type` | @aethervtt/shard-assets | Define it (project.dataAsset) before loading its files. |
| `audio/decode-failed` | @aethervtt/shard-audio | Re-import the file (shard import --json). |
| `audio/invalid-duck` | @aethervtt/shard-audio | by is the share of gain taken away: 0.3 plays the bus at 70%. |
| `audio/invalid-range` | @aethervtt/shard-audio |  |
| `audio/no-plugin` | @aethervtt/shard-audio | Add "audio" to plugins in shard.json (or app.addPlugin(audioPlugin())). |
| `audio/unknown-bus` | @aethervtt/shard-audio |  |
| `audio/unsupported-format` | @aethervtt/shard-audio | Audio clips are WAV (PCM or float), Ogg Vorbis, Ogg Opus, MP3, or FLAC. |
| `core/owner-invalid` | @aethervtt/shard-core | An Owner is a grant from host code; it cannot be constructed or copied. |
| `core/owner-not-authorable` | @aethervtt/shard-core | Ownership is a grant from host code: spawn with world.owners.spawn(owner, ...) or world.owners.adopt(owner, entity). |
| `core/owner-quota` | @aethervtt/shard-core |  |
| `core/owner-released` | @aethervtt/shard-core | Create a new owner; a released one holds nothing and accepts nothing. |
| `data/extends-cycle` | @aethervtt/shard-assets | Point "$extends" at a file that does not extend this one. |
| `data/extends-type-mismatch` | @aethervtt/shard-assets |  |
| `dice/attachment-budget` | @aethervtt/shard-dice | Draw fewer vertices, split the effect, or raise it with setDiceBudgets first. |
| `dice/busy` | @aethervtt/shard-dice | Queue rolls in the host, dismiss this one, or pass { replace: true }. |
| `dice/device-lost` | @aethervtt/shard-dice | The renderer recreates the device; roll again. |
| `dice/disposed` | @aethervtt/shard-dice |  |
| `dice/entrance-budget` | @aethervtt/shard-dice | Trim the scene, or raise DICE_BUDGETS with setDiceBudgets before defining it. |
| `dice/failed` | @aethervtt/shard-dice |  |
| `dice/family-field-clash` | @aethervtt/shard-dice | Give the field another name: the dice fields are shared by every family. |
| `dice/invalid-definition` | @aethervtt/shard-dice |  |
| `dice/invalid-entrance` | @aethervtt/shard-dice | landAtMs is when the die lands: between 0 and durationMs. |
| `dice/invalid-family` | @aethervtt/shard-dice | Give a WGSL `surface` snippet, or a `shader` module overriding pbr_input. |
| `dice/invalid-glyph` | @aethervtt/shard-dice | Glyph paths are SVG path data (M, L, H, V, C, S, Q, T, A, Z). |
| `dice/invalid-recipe` | @aethervtt/shard-dice |  |
| `dice/invalid-roll` | @aethervtt/shard-dice | Pass the tray the camera shows, e.g. { halfWidth: 5.4, halfDepth: 3.15 }. |
| `dice/invalid-skin` | @aethervtt/shard-dice |  |
| `dice/invalid-value` | @aethervtt/shard-dice | The host decides the result; pass one the die has. |
| `dice/layout-missing-value` | @aethervtt/shard-dice |  |
| `dice/recipe-bounds` | @aethervtt/shard-dice |  |
| `dice/registry-conflict` | @aethervtt/shard-dice | Give the new attachment its own name. |
| `dice/reserved-param` | @aethervtt/shard-dice | Dropped dice, fades and results are the presentation’s; the mark atlas is baked from the layout. |
| `dice/thumbnail-failed` | @aethervtt/shard-dice |  |
| `dice/unknown-die` | @aethervtt/shard-dice |  |
| `dice/unknown-family` | @aethervtt/shard-dice | Families: dice/SolidDice, dice/ResinDice, dice/MetalDice, dice/GlassDice, and those the host defines with defineDiceFamily. |
| `dice/unknown-layout` | @aethervtt/shard-dice |  |
| `dice/unknown-recipe` | @aethervtt/shard-dice |  |
| `dice/unknown-skin` | @aethervtt/shard-dice | Load the skin (or add it to DiceSkin.store) first. |
| `ecs/dead-entity` | @aethervtt/shard-core | It was despawned, or the id is stale. Check world.isAlive(entity) first. |
| `ecs/entity-limit` | @aethervtt/shard-core | High-count data (particles, foliage, tiles) belongs in buffers, not entities. |
| `ecs/missing-component` | @aethervtt/shard-core | Check world.has(entity, component) first, or use tryGet. |
| `ecs/missing-resource` | @aethervtt/shard-core | Insert it with insertResource, or add the plugin that provides it. |
| `ecs/no-resource-init` | @aethervtt/shard-core | Use insertResource with a value instead. |
| `fog/invalid-regions` | @aethervtt/shard-fog | { rev, regions: [{ op: "hide" \| "reveal", strength?, feather?, shape }] } with shapes rect, polygon, multipolygon or brush. |
| `gltf/accessor-out-of-range` | @aethervtt/shard-gltf | The file is truncated or its byteOffset/count are wrong. |
| `gltf/buffer-missing` | @aethervtt/shard-gltf | Keep .bin files next to the .gltf, under the same name the file references. |
| `gltf/invalid` | @aethervtt/shard-gltf | Only glTF 2.0 files are supported. |
| `gltf/tangents-unavailable` | @aethervtt/shard-gltf |  |
| `gltf/unsupported-extension` | @aethervtt/shard-gltf |  |
| `gpu-webgl2/naga-crashed` | @aethervtt/shard-gpu-webgl2 | Report the shader: naga should return an error, not crash. |
| `gpu-webgl2/naga-load-failed` | @aethervtt/shard-gpu-webgl2 | packages/gpu-webgl2/wasm must be served with the app (rebuild with `pnpm build:wasm`). |
| `gpu-webgl2/translate` | @aethervtt/shard-gpu-webgl2 |  |
| `gpu/duplicate-surface` | @aethervtt/shard-gpu | Share the Surface itself (renderPlugin({ gpu, surface })), or remove it first. |
| `gpu/missing-feature` | @aethervtt/shard-gpu |  |
| `gpu/no-adapter` | @aethervtt/shard-gpu |  |
| `gpu/no-context` | @aethervtt/shard-gpu |  |
| `gpu/recovery-failed` | @aethervtt/shard-gpu | Tell the user 3D is unavailable; reloading the page tries again. |
| `gpu/unsupported` | @aethervtt/shard-gpu | Use a browser or webview with WebGPU, or pass `gpu` (e.g. from the `webgpu` package in Node). |
| `ik/not-a-chain` | @aethervtt/shard-animation | Each joint must be an ancestor of the next (root → mid → tip; chain entries top first, above the joint). |
| `ik/unknown-joint` | @aethervtt/shard-animation | Joint fields are paths under the IK entity or an ancestor (the model root): "Armature/Hips/UpLeg_L". animation_describe on the model lists what bound. |
| `input/unknown-action` | @aethervtt/shard-input | Use "<map name>.<action>", e.g. "game/Controls.jump". |
| `input/unknown-binding` | @aethervtt/shard-input | Use Gamepad:LeftStick, Gamepad:RightStick, { composite: "wasd" \| "arrows" }, or { up, down, left, right }. |
| `locale/bad-locale` | @aethervtt/shard-text | Name tables by BCP 47 tag: locales/en.strings.json, locales/pt-BR.strings.json (or hud.pt-BR.strings.json). |
| `locale/bad-plural` | @aethervtt/shard-text | "other" is the form every locale falls back to. |
| `locale/invalid-table` | @aethervtt/shard-text | Map keys to strings: { "hud.fuel": "Fuel: {amount}%" }. |
| `locale/missing-key` | @aethervtt/shard-text |  |
| `locale/param-mismatch` | @aethervtt/shard-text | Every locale gets the same params: use the same {placeholders} in each. |
| `mesh/invalid` | @aethervtt/shard-mesh | positions/normals: 3 per vertex, uvs/uvs1: 2, colors/tangents/joints/weights: 4; indices must be < vertex count. |
| `mesh/invalid-artifact` | @aethervtt/shard-mesh | Re-import the source (`shard import --force`). |
| `mesh/not-gpu` | @aethervtt/shard-mesh | Change a CPU mesh with update(). |
| `mirror/duplicate-key` | @aethervtt/shard-mirror | Keys are the host ids of documents: each may appear once per list. |
| `mirror/no-diff` | @aethervtt/shard-mirror | Pass rev: (doc) => doc.rev when documents carry a revision (cheapest), or equal(prev, next). |
| `nav/bad-cache` | @aethervtt/shard-nav |  |
| `nav/bake-failed` | @aethervtt/shard-nav | Check the NavSource geometry has upward faces flatter than maxSlope, wide enough for agentRadius. |
| `nav/invalid-grid` | @aethervtt/shard-nav |  |
| `nav/no-navmesh` | @aethervtt/shard-nav | Check nav.describe: the grid may be waiting for data, or the navmesh for sources. |
| `nav/not-ready` | @aethervtt/shard-nav | Add the nav plugin (or nav/grid for grids only) and await app.init(). |
| `nav/out-of-bounds` | @aethervtt/shard-nav | nav.describe lists each grid and navmesh with its bounds. |
| `noise/arity` | @aethervtt/shard-noise | Give it two or more inputs: node names, inline nodes, or numbers, e.g. ["a", "b"]. |
| `noise/cycle` | @aethervtt/shard-noise | A node can’t depend on itself; break the loop with a separate node. |
| `noise/domain-mismatch` | @aethervtt/shard-noise | Set "dimensions": 4 on the graph and sample it with a w coordinate, or use dims 3. |
| `noise/frequency-too-high` | @aethervtt/shard-noise | Lower the frequency or octaves: features that fine are invisible anywhere they apply at this extent. |
| `noise/invalid-graph` | @aethervtt/shard-noise | Start from { "output": "height", "nodes": { … } }. |
| `noise/invalid-node` | @aethervtt/shard-noise | For example { "fbm": { "octaves": 5 } }. |
| `noise/invalid-param` | @aethervtt/shard-noise | Check the parameter against .shard/schemas/noise.schema.json. |
| `noise/kernel-load-failed` | @aethervtt/shard-noise | The .wasm files live in packages/noise/wasm; the dev server must serve them. |
| `noise/kernel-not-loaded` | @aethervtt/shard-noise | await loadNoiseKernel() (or load a NoiseGraph asset, which does) before sampling synchronously. |
| `noise/not-a-graph` | @aethervtt/shard-noise | asset.list shows NoiseGraph assets (*.noise.json). |
| `noise/not-loaded` | @aethervtt/shard-noise | asset.status shows why. |
| `noise/out-too-small` | @aethervtt/shard-noise | Size out to one value per point (resolution² for patches, nx × ny for grids). |
| `noise/too-many-octaves` | @aethervtt/shard-noise | Past 16 octaves the extra detail is below a pixel anywhere; raise frequency instead. |
| `noise/too-many-points` | @aethervtt/shard-noise | Split the points over several calls, or use noise.stats for a summary of a whole domain. |
| `noise/unknown-node` | @aethervtt/shard-noise |  |
| `noise/unknown-type` | @aethervtt/shard-noise | Types: value, perlin, simplex, cellular, fbm, ridged, billow, add, multiply, min, max, lerp, select, remap, clamp, curve, terrace, abs, power, constant, warp, scale, translate. |
| `particles/invalid-effect` | @aethervtt/shard-particles |  |
| `physics/both-dimensions` | @aethervtt/shard-physics | Enable one physics plugin per app: physics3d for 3D games, physics2d for 2D. |
| `physics/character-has-body` | @aethervtt/shard-physics | The controller makes its own kinematic body and capsule. Remove RigidBody and Collider, or put extra colliders on a child. |
| `physics/invalid-shape` | @aethervtt/shard-physics | Check radius, halfExtents, halfHeight, points, or the mesh. |
| `physics/not-ready` | @aethervtt/shard-physics | Add the physics3d or physics2d plugin and await app.init() before querying. |
| `physics/track-body` | @aethervtt/shard-physics |  |
| `physics/track-cancelled` | @aethervtt/shard-physics | Its signal was aborted or its client disposed: nothing to fix, record again when needed. |
| `physics/track-client-disposed` | @aethervtt/shard-physics | Create another with createTrackClient. |
| `physics/track-diverged` | @aethervtt/shard-physics | Check its speed, mass and colliders; a smaller step or ccd can help. |
| `physics/track-invalid` | @aethervtt/shard-physics | Pass the ArrayBuffer encodeTrack made, whole. |
| `physics/track-scene` | @aethervtt/shard-physics | See TrackScene in @aethervtt/shard-physics/track. |
| `physics/track-version` | @aethervtt/shard-physics | Record it again with this build, or play it with the build that recorded it. |
| `physics/unknown-settle-rule` | @aethervtt/shard-physics |  |
| `physics/unsupported-shape` | @aethervtt/shard-physics | 2D shapes: ball, cuboid, capsule, convex, trimesh, heightfield, segment, polyline. |
| `physics/worker-crashed` | @aethervtt/shard-physics | The next recording starts a new worker. |
| `platform/bad-storage-key` | @aethervtt/shard-platform-node | Keys are relative paths like "saves/slot1.json". |
| `platform/fs-not-found` | @aethervtt/shard-platform-node |  |
| `platform/fs-read-only` | @aethervtt/shard-platform-web | Writes need a writable host such as Studio or the CLI. |
| `platform/no-storage` | @aethervtt/shard-platform-web | Private browsing modes and some embedded webviews disable it. |
| `platform/worker-crashed` | @aethervtt/shard-platform | The pool started a replacement; the job can be retried. |
| `platform/worker-no-export` | @aethervtt/shard-platform | Worker functions are named exports of the module passed to run(). |
| `platform/workers-disposed` | @aethervtt/shard-platform |  |
| `prefab/cycle` | @aethervtt/shard-scene | A prefab can’t contain or extend itself, directly or through others. |
| `prefab/duplicate-name` | @aethervtt/shard-scene | Rename the child, or change the generated one with "overrides" instead. |
| `prefab/invalid` | @aethervtt/shard-scene | Write { "version": 1, "root": { "name": "...", "components": {...}, "children": [...] } }, or a variant with "extends". |
| `prefab/invalid-component` | @aethervtt/shard-scene |  |
| `prefab/not-an-instance` | @aethervtt/shard-protocol | Pass the entity with scene/PrefabInstance or scene/SceneInstance, e.g. "player-ship". |
| `prefab/not-found` | @aethervtt/shard-scene | Pass a *.prefab.json path under an asset root (run `shard import` for new files), or register one with registerPrefab. |
| `prefab/not-loaded` | @aethervtt/shard-scene | Preload it with `await loadPrefab(world, path)`, or place it with scene/PrefabInstance, which waits for it to load. |
| `prefab/read-only` | @aethervtt/shard-scene | Apply from the CLI or Studio, which can write the project folder. |
| `prefab/stale-override` | @aethervtt/shard-scene | The prefab changed (a renamed or removed entity?). The override is kept in the file; fix or delete it. |
| `prefab/unknown-field` | @aethervtt/shard-scene | A prefab has "root" (an entity), or "extends" plus "rootComponents", "overrides", and "children" (a variant). |
| `prefab/unknown-path` | @aethervtt/shard-scene | Override paths are relative to the root, e.g. "Hull" or "Hull/Cockpit". |
| `prefab/unsupported-version` | @aethervtt/shard-scene |  |
| `procgen/bad-file` | @aethervtt/shard-procgen | A generator file has "generator", "seed", and "params". |
| `procgen/bad-mesh` | @aethervtt/shard-procgen | Detail 6 is already 40 962 vertices. |
| `procgen/bad-name` | @aethervtt/shard-procgen | Generator names are "<namespace>/<Name>", e.g. "star-explorer/Rock". |
| `procgen/bad-output` | @aethervtt/shard-procgen | Use "mesh", "texture", "data", "entities", or a data type (project.dataAsset). |
| `procgen/bad-params` | @aethervtt/shard-procgen | Seeds are integers from 0 to 4294967295; derive child seeds with ctx.childSeed. |
| `procgen/cycle` | @aethervtt/shard-procgen | A generator that calls itself needs different params or a different seed (ctx.childSeed) each level. |
| `procgen/dependency-failed` | @aethervtt/shard-procgen | Add the plugin that defines the asset type to the project. |
| `procgen/generator-failed` | @aethervtt/shard-procgen | The error is in the generator; procgen.run with the same seed and params reproduces it. |
| `procgen/no-preview` | @aethervtt/shard-procgen | procgen.run returns the value summary; asset.get shows it. |
| `procgen/nondeterministic` | @aethervtt/shard-procgen | Generators are pure: use ctx.rng for randomness and pass times in as params. |
| `procgen/output-mismatch` | @aethervtt/shard-procgen | Use its output as a handle instead (a mesh: render/Mesh3d { "mesh": { "path": "procedural:…" } }). |
| `procgen/undeclared-dependency` | @aethervtt/shard-procgen | ctx.load takes the handles in the params (declare a t.handle param and pass the asset in). |
| `procgen/unknown-generator` | @aethervtt/shard-procgen | Name a generator ("star-explorer/StarSystem") or a *.gen.json#Generator. |
| `procgen/worker-bundle-failed` | @aethervtt/shard-node | The project code has to bundle for browsers (no Node built-ins). |
| `project/bundle-failed` | @aethervtt/shard-node |  |
| `project/entry-failed` | @aethervtt/shard-node | The entry must be a module whose default export is defineProject({...}). |
| `project/entry-invalid` | @aethervtt/shard-node | End the file with `export default project`, where project = defineProject({...}). |
| `project/invalid-json` | @aethervtt/shard-project |  |
| `project/invalid-manifest` | @aethervtt/shard-project |  |
| `project/invalid-name` | @aethervtt/shard-project | Use lowercase letters, digits, and dashes, starting with a letter (e.g. "star-explorer"). |
| `project/migration-failed` | @aethervtt/shard-project | Bump the component version and convert the old value in `migrate`, or change the field back. |
| `project/namespace` | @aethervtt/shard-project |  |
| `project/no-bundler` | @aethervtt/shard-project | Pass "url" with a built bundle. |
| `project/not-found` | @aethervtt/shard-project | Run `shard init <dir>` to create a project, or run from a project folder. |
| `project/reload-failed` | @aethervtt/shard-project |  |
| `project/unknown-plugin` | @aethervtt/shard-project |  |
| `protocol/internal` | @aethervtt/shard-protocol |  |
| `protocol/invalid-components` | @aethervtt/shard-protocol |  |
| `protocol/invalid-params` | @aethervtt/shard-protocol |  |
| `protocol/invalid-position64` | @aethervtt/shard-protocol | Pass { "position64": [x, y, z], "grid": <grid> } together. |
| `protocol/method-not-allowed` | @aethervtt/shard-protocol |  |
| `protocol/no-files` | @aethervtt/shard-protocol |  |
| `protocol/no-preview` | @aethervtt/shard-protocol | Previews exist for textures, materials, meshes, scenes, and types that register one. |
| `protocol/no-renderer` | @aethervtt/shard-protocol |  |
| `protocol/no-view` | @aethervtt/shard-protocol |  |
| `protocol/not-a-grid` | @aethervtt/shard-protocol | Pass "grid": the id or path of an entity with transform/Grid. |
| `protocol/unknown-component` | @aethervtt/shard-protocol | schema.list returns every component name. |
| `protocol/unknown-debug-view` | @aethervtt/shard-protocol | Use 'clusters', 'cascades', 'lod', 'culling', 'none', or 'shadow-map:<light>'. |
| `protocol/unknown-entity` | @aethervtt/shard-protocol | Pass an entity id from world.query, or a scene path like "ship/camera". |
| `protocol/unknown-overlay` | @aethervtt/shard-protocol |  |
| `protocol/unknown-owner` | @aethervtt/shard-protocol | owners.describe with no name lists every live owner. |
| `protocol/unknown-resource` | @aethervtt/shard-protocol |  |
| `protocol/unsettable-resource` | @aethervtt/shard-protocol | Only resources that are plain JSON objects can be set. |
| `render/atmosphere-inside-ground` | @aethervtt/shard-render | Give it a positive thickness (Earth 60 000 m). |
| `render/bad-vector` | @aethervtt/shard-render |  |
| `render/capture-format` | @aethervtt/shard-render |  |
| `render/data-textures-not-loaded` | @aethervtt/shard-render | Await loadDataTextures() before making DataStores on a baseline device. |
| `render/disposed` | @aethervtt/shard-render |  |
| `render/duplicate-node` | @aethervtt/shard-render |  |
| `render/feature-missing` | @aethervtt/shard-render | Add materialNoisePlugin from '@aethervtt/shard-render/noise'. |
| `render/graph-cycle` | @aethervtt/shard-render | Check reads/writes and `after` on these nodes. |
| `render/invalid-screen-effect` | @aethervtt/shard-render | A screen effect has a kind, a radius of at least 0, and at most 8 params. |
| `render/material-field-clash` | @aethervtt/shard-render | Give the field another name, or use extends: "none". |
| `render/material-noise-name` | @aethervtt/shard-render | Use lowercase letters, digits, and underscores: { detail: "assets/noise/rock.noise.json" }. |
| `render/missing-resource` | @aethervtt/shard-render | Declare it in a node's `writes` (as a transient texture) or with graph.declare. |
| `render/no-shadow-map` | @aethervtt/shard-render | Set shadows: true on the light, and check render.describe for the shadow budget. |
| `render/no-view` | @aethervtt/shard-render | Spawn an entity with Camera3d, or pass the camera to pick from. |
| `render/noise-graph-missing` | @aethervtt/shard-render | noise paths name *.noise.json assets, e.g. { detail: "assets/noise/rock.noise.json" }. |
| `render/not-an-atmosphere` | @aethervtt/shard-render | Pass the entity that has render/Atmosphere (render.describe lists each camera’s). |
| `render/not-ready` | @aethervtt/shard-render | Await app.init() so the render plugin can create the GPU device. |
| `render/registry-conflict` | @aethervtt/shard-render | Two definitions (two apps or bundles) share the name. Rename one, or share the definition. |
| `render/surface-device` | @aethervtt/shard-render | Pass the GpuContext the surface was added to (surface.gpu), or omit gpu. |
| `render/texture-color-space-mismatch` | @aethervtt/shard-render | Set its usage to match the slot in its .meta, and the copy goes. |
| `render/too-many-joints` | @aethervtt/shard-gltf | Split the mesh, or remove helper bones before exporting. |
| `render/unknown-buffer` | @aethervtt/shard-render |  |
| `render/unknown-camera` | @aethervtt/shard-render | Pass a Camera3d entity that has rendered at least one frame. |
| `render/unknown-material-type` | @aethervtt/shard-render |  |
| `render/which-atmosphere` | @aethervtt/shard-render | Pass entity: an entity with render/Atmosphere. |
| `retarget/unmapped-root` | @aethervtt/shard-animation | Add it to the joint map (*.jointmap.json): { "joints": { "<source>": "<target>" } }. |
| `runtime/disposed` | @aethervtt/shard-runtime | Create a new App; a disposed one has released its GPU objects and listeners. |
| `save/bad-slot` | @aethervtt/shard-save | Slots are letters, digits, "-", and "_" (e.g. "slot1", "autosave"). |
| `save/invalid` | @aethervtt/shard-save |  |
| `save/invalid-settings` | @aethervtt/shard-save |  |
| `save/missing-scene` | @aethervtt/shard-save | The scene file was moved or deleted since the save was made. |
| `save/not-found` | @aethervtt/shard-save | save.list shows the saved slots. |
| `save/stale-entity` | @aethervtt/shard-save | The prefab was moved or deleted since the save was made. |
| `save/stale-field` | @aethervtt/shard-save | Give the component a version and a migrate that renames or drops the field. |
| `save/unknown-component` | @aethervtt/shard-save | The component was renamed or removed from the code; its saved data is skipped. |
| `save/unknown-resource` | @aethervtt/shard-save | The resource was renamed, removed, or lost its persist option; its saved value is skipped. |
| `save/unknown-settings` | @aethervtt/shard-save |  |
| `save/version-mismatch` | @aethervtt/shard-save |  |
| `scene/already-loaded` | @aethervtt/shard-scene | Use reloadScene to replace it, or pass a different id. |
| `scene/asset-unavailable` | @aethervtt/shard-scene |  |
| `scene/conflicting-fields` | @aethervtt/shard-scene |  |
| `scene/derived-component` | @aethervtt/shard-scene |  |
| `scene/duplicate-name` | @aethervtt/shard-scene | Names must be unique among siblings; they form entity paths. |
| `scene/invalid` | @aethervtt/shard-scene |  |
| `scene/invalid-asset` | @aethervtt/shard-scene | Materials: { "type": "Material", "value": {...} }. Meshes: { "type": "Mesh", "procedural": "sphere", "params": {...} }. |
| `scene/invalid-name` | @aethervtt/shard-scene |  |
| `scene/invalid-procedural-param` | @aethervtt/shard-scene |  |
| `scene/not-loaded` | @aethervtt/shard-scene |  |
| `scene/unknown-component` | @aethervtt/shard-scene | Use a registered name like "core/Transform" or "render/Camera3d" (see .agents/components.md). |
| `scene/unknown-entity-path` | @aethervtt/shard-scene |  |
| `scene/unknown-field` | @aethervtt/shard-scene |  |
| `scene/unknown-procedural` | @aethervtt/shard-scene |  |
| `scene/unknown-procedural-param` | @aethervtt/shard-scene |  |
| `scene/unknown-resource` | @aethervtt/shard-scene |  |
| `scene/unsupported-version` | @aethervtt/shard-scene |  |
| `schema/ambiguous-name` | @aethervtt/shard-core | Two modules define the same name. Rename one, or import the shared definition. |
| `schema/asset-not-found` | @aethervtt/shard-core | Check the path, or that the asset has been imported. |
| `schema/asset-type-mismatch` | @aethervtt/shard-core |  |
| `schema/duplicate-name` | @aethervtt/shard-core | Two definitions share a name. Rename one, or import the existing definition. |
| `schema/future-version` | @aethervtt/shard-core |  |
| `schema/invalid-enum` | @aethervtt/shard-core |  |
| `schema/invalid-field` | @aethervtt/shard-core |  |
| `schema/invalid-name` | @aethervtt/shard-core | Use "namespace/PascalName", e.g. "game/Health". |
| `schema/invalid-version` | @aethervtt/shard-core | Versions are integers starting at 1. |
| `schema/missing-field` | @aethervtt/shard-core | Give a "guid", a "path", or both. |
| `schema/missing-migration` | @aethervtt/shard-core |  |
| `schema/out-of-range` | @aethervtt/shard-core |  |
| `schema/persist-needs-schema` | @aethervtt/shard-core | Give it a schema (defineSchema) so saves can validate and migrate it. |
| `schema/redefinition-active` | @aethervtt/shard-core |  |
| `schema/type-mismatch` | @aethervtt/shard-assets | Give the base file by path: { "path": "data/weapons/laser.weapon.json" }. |
| `schema/unknown-field` | @aethervtt/shard-ui |  |
| `schema/unknown-preset` | @aethervtt/shard-core |  |
| `schema/unresolved-entity` | @aethervtt/shard-core | Entity paths are resolved by the scene loader; check the path exists. |
| `shader/bake-version` | @aethervtt/shard-shader | Bake again with this version of Shard. |
| `shader/baseline-data` | @aethervtt/shard-shader |  |
| `shader/compile` | @aethervtt/shard-shader |  |
| `shader/data-misplaced` | @aethervtt/shard-shader | @data @group(2) @binding(0) var<storage, read> name: array<T>; |
| `shader/fragment-kernel` | @aethervtt/shard-shader | Only image kernels run as fragment passes: one storage texture, stored at the invocation id. |
| `shader/hook-signature-mismatch` | @aethervtt/shard-shader |  |
| `shader/invalid-path` | @aethervtt/shard-shader | Use lowercase `package::dir::name`, e.g. `project::water`. |
| `shader/link` | @aethervtt/shard-shader |  |
| `shader/link-unknown-module` | @aethervtt/shard-shader | Check the import path, or register the module. |
| `shader/link-unresolved` | @aethervtt/shard-shader |  |
| `shader/unknown-hook` | @aethervtt/shard-shader | Only functions marked @hook can be overridden. |
| `shader/unsupported-field` | @aethervtt/shard-shader | GPU structs take numbers, bools, enums, vectors, colors, and matrices. f64 fields are not allowed; object fields are skipped. |
| `shader/watch-unsupported` | @aethervtt/shard-shader |  |
| `sprite/atlas-too-large` | @aethervtt/shard-sprite | Raise maxSize, or split the images into several atlases. |
| `sprite/bad-chunk` | @aethervtt/shard-sprite |  |
| `sprite/bad-flag` | @aethervtt/shard-sprite | Flags are fx, fy and r90, joined by +. |
| `sprite/duplicate-region` | @aethervtt/shard-sprite | Region names are unique within an atlas. |
| `sprite/invalid-occluder` | @aethervtt/shard-sprite | Give polygons 3+ points without crossing edges, boxes a nonzero size, and collider occluders a cuboid, ball, capsule, or convex Collider. |
| `sprite/invalid-tilemap` | @aethervtt/shard-sprite | Chunk keys are "cx,cy": the chunk column and row from the top left. |
| `sprite/no-atlas` | @aethervtt/shard-sprite |  |
| `sprite/no-layer` | @aethervtt/shard-sprite |  |
| `sprite/no-palette` | @aethervtt/shard-sprite | Save it once with its atlas (tilemapToJson(data, { atlas })) to give it a palette. |
| `sprite/no-texture` | @aethervtt/shard-sprite |  |
| `sprite/not-a-tilemap` | @aethervtt/shard-sprite |  |
| `sprite/tile-out-of-range` | @aethervtt/shard-sprite |  |
| `sprite/tilemap-needs-atlas` | @aethervtt/shard-sprite | Its tiles are atlas regions: pass the atlas so they can be named (the palette). |
| `sprite/tilemap-not-loaded` | @aethervtt/shard-sprite | Wait for its TilemapData asset, or create one with TilemapData.create. |
| `sprite/unencodable-tile` | @aethervtt/shard-sprite | Region names in rows have no spaces, ":", "*" or "+". Save with encoding base64. |
| `sprite/unknown-tile` | @aethervtt/shard-sprite | Rename it to a region the atlas has, or add the region to the atlas. |
| `sprite/unknown-tilemap` | @aethervtt/shard-sprite | Name a *.tilemap.json asset by path or guid that a Tilemap in the world uses. |
| `sprite/unsupported-image` | @aethervtt/shard-sprite |  |
| `terrain/bad-direction` | @aethervtt/shard-terrain | Pass a direction from the planet’s center in its frame, e.g. the position of a point on it. |
| `terrain/bad-points` | @aethervtt/shard-terrain | e.g. { "latlon": [[0, 0], [45, 90]] }, or { "directions": [[0, 1, 0]] } for the north pole. |
| `terrain/bad-resolution` | @aethervtt/shard-terrain | Use 17, 33 (the default), 65, or 129 vertices per chunk edge. |
| `terrain/climate-outputs` | @aethervtt/shard-terrain | Name the two climate layers "temperature" and "moisture"; each should stay in [−1, 1]. |
| `terrain/no-planet` | @aethervtt/shard-terrain | Add terrain/Planet (with a Grid) to an entity, and the terrain plugin to the app. |
| `terrain/not-a-planet` | @aethervtt/shard-terrain | Add terrain/Planet (and a Grid) to the planet entity, and the terrain plugin to the app. |
| `terrain/not-ready` | @aethervtt/shard-terrain | Its graphs and biomes load asynchronously; step a frame (or await the asset loads) first. |
| `terrain/radius-too-large` | @aethervtt/shard-terrain | Rocky planets go up to about 16 000 km; gas giants have no surface (spec 0046 renders them). |
| `terrain/too-many-biomes` | @aethervtt/shard-terrain | Merge similar biomes, or split the planet’s surface into fewer, broader ones. |
| `terrain/which-planet` | @aethervtt/shard-terrain | Pass planet: an entity id or a scene path (terrain.describe lists them). |
| `testing/missing-component` | @aethervtt/shard-testing |  |
| `testing/unknown-entity` | @aethervtt/shard-testing | Use a scene path like "ship/camera" or an entity id. |
| `text/font-parse-failed` | @aethervtt/shard-text | Fonts import from .ttf and .otf files (TrueType or CFF outlines). |
| `text/import-failed` | @aethervtt/shard-text |  |
| `text/invalid-metrics` | @aethervtt/shard-text | Re-import the font (`shard import`). |
| `text/not-loaded` | @aethervtt/shard-protocol | asset.list shows fonts (type Font); pass a .ttf or .otf path. |
| `texture/decode-failed` | @aethervtt/shard-texture |  |
| `texture/invalid` | @aethervtt/shard-texture |  |
| `texture/invalid-array` | @aethervtt/shard-texture |  |
| `texture/normal-map-mismatch` | @aethervtt/shard-sprite | A normal-map companion must match its image pixel for pixel. |
| `texture/nothing-to-pack` | @aethervtt/shard-texture | Without either, leave metallicRoughnessTexture empty: the scalar factors apply. |
| `texture/transcoder-unavailable` | @aethervtt/shard-texture | Basis Universal ships in @aethervtt/shard-texture/vendor/basis; check the files are present. |
| `texture/unsupported-format` | @aethervtt/shard-texture | Use a 2D image, a 2D array (*.texarray.json), or a cube map (6 faces). |
| `texture/wrong-kind` | @aethervtt/shard-texture | Decode them as RGBA8 (kind "u8"). |
| `transform/cell-outside-grid` | @aethervtt/shard-scene | Nest the entity directly under an entity with transform/Grid, or remove its GridCell. |
| `transform/grid-cycle` | @aethervtt/shard-transform | Check the ChildOf chain of your Grid entities. |
| `transform/multiple-origins` | @aethervtt/shard-scene | Keep one transform/FloatingOrigin per world, usually on the camera. |
| `transform/not-a-grid` | @aethervtt/shard-transform | Pass an entity that has the transform/Grid component. |
| `transform/translation-outside-cell` | @aethervtt/shard-scene | Split the position into transform/GridCell (whole cells) plus a translation under one cell, or place it with entity.patch { "position64": [x, y, z], "grid": <grid> }. |
| `ui/ambiguous-path` | @aethervtt/shard-ui |  |
| `ui/disabled` | @aethervtt/shard-ui | Set disabled to false on its UiButton or UiToggle first. |
| `ui/hidden` | @aethervtt/shard-ui | A node with display none, under a hidden anchor, or outside a root can't be clicked. |
| `ui/invalid-length` | @aethervtt/shard-ui | Use pixels (120 or "120"), a percent of the parent ("50%"), or "auto". |
| `ui/no-root` | @aethervtt/shard-ui | Parent it (ChildOf) under an entity with ui/UiRoot, or add UiRoot to the top node. |
| `ui/not-clickable` | @aethervtt/shard-ui | ui.click takes the path of a node with ui/UiButton or ui/UiToggle (see ui.describe). |
| `ui/not-focusable` | @aethervtt/shard-ui | Focus takes a node with UiButton, UiToggle, UiSlider, or UiTextInput. |
| `ui/unknown-node` | @aethervtt/shard-ui | Pass an entity id or a scene path of a node under a UiRoot (ui.describe lists them). |
| `ui/unknown-state` | @aethervtt/shard-ui |  |
| `ui/unknown-style` | @aethervtt/shard-ui | Add it to the root's *.theme.json styles, or fix UiNode.style (ui.describe shows each node's). |
| `vector/invalid-geometry` | @aethervtt/shard-vector | A region shape is { kind: 'rect' \| 'polygon' \| 'multipolygon' \| 'brush', ... } in world (x, z). |
| `verify/approval-needs-reason` | @aethervtt/shard-verify | Say why it looks the way it does: shard approve <shot> --reason "Shadows are softer since 0058". |
| `verify/idle-timeout` | @aethervtt/shard-verify | Holding nothing: it was slow, not stuck; raise the plan's timeoutMs. |
| `verify/invalid-json` | @aethervtt/shard-verify |  |
| `verify/invalid-plan` | @aethervtt/shard-verify | Plans follow .shard/schemas/capture-plan.schema.json. |
| `verify/invalid-record` | @aethervtt/shard-verify | Records follow .shard/schemas/perf-record.schema.json. |
| `verify/no-browser` | @aethervtt/shard-verify |  |
| `verify/no-canvas` | @aethervtt/shard-verify |  |
| `verify/no-metrics` | @aethervtt/shard-verify | Add metricsPlugin() from @aethervtt/shard-verify/metrics to the app. |
| `verify/not-found` | @aethervtt/shard-verify |  |
| `verify/not-ready` | @aethervtt/shard-verify |  |
| `verify/not-usable` | @aethervtt/shard-verify | The host calls app.markUsable() once the scene is interactive; records start after the frame that follows. |
| `verify/size-mismatch` | @aethervtt/shard-verify | Check the viewport and DPR in the plan, or approve the new size with a reason. |
| `verify/unknown-shot` | @aethervtt/shard-verify |  |
| `verify/unknown-step` | @aethervtt/shard-verify |  |
