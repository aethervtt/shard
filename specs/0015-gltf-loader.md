# 0015 — glTF/GLB loader

- **Status:** implemented
- **Packages:** `@aethervtt/shard-gltf` (new), `@aethervtt/shard-mesh`, `@aethervtt/shard-render`, `@aethervtt/shard-scene`
- **Depends on:** 0004, 0007, 0010, 0014

## Context

glTF 2.0 is how models reach the engine: Blender, every DCC tool, and every asset store export it,
and the No Man's Sky proof project needs ships, props, and creatures authored outside the engine.
0014 gives us importers, sub-assets, and a cache. This spec is the first real importer and the
first one that produces more than one asset per file.

It also has to answer a question scenes haven't had to answer yet: how a scene places a whole
model (a node tree with several meshes and materials) with one line.

## Goals

- Import `.gltf` (with external or data-URI buffers) and `.glb` into meshes, materials, and a
  node tree, entirely in TypeScript, on every host.
- A scene places a model with one component; its nodes appear as addressable child entities.
- Readable, stable sub-asset paths (`assets/ship.glb#Mesh/Hull`) that agents can write by hand.
- Parse and cache skins and animations now, so M6 can play them without re-importing.
- Errors point into the glTF JSON, the same way scene errors point into scene files.

## Non-goals

- Textures. Material texture slots are recorded in the artifact and wired up by 0016.
- Compressed geometry (`KHR_draco_mesh_compression`, `EXT_meshopt_compression`). Files that
  require them fail with `gltf/unsupported-extension`. Added once a model needs them.
- Morph targets, animation playback, skinning on the GPU (M6).
- Point and spot lights at runtime (M5). They're imported as data and reported as skipped.
- Blended transparency (M5). `BLEND` materials import as `MASK` with a warning.
- Exporting glTF.

## Design

### Sub-assets and labels

One source produces these sub-assets, each addressable as `<source>#<label>`:

| Label | Type | From |
|---|---|---|
| `Mesh/<name>` | `Mesh` | a single-primitive mesh |
| `Mesh/<name>/<i>` | `Mesh` | primitive `i` of a multi-primitive mesh |
| `Material/<name>` | `Material` | a material |
| `Scene` | `Scene` | the default scene (node tree) |
| `Scene/<name>` | `Scene` | every scene, when the file has more than one |
| `Skin/<name>` | `Skin` | a skin: joint node paths, inverse bind matrices, rest pose |
| `Animation/<name>` | `AnimationClip` | an animation: channels by node path, sampler data |

`<name>` is the glTF name when it's present and unique within its kind, otherwise the index
(`Mesh/3`). Names beat indices because re-exporting from Blender reorders arrays but keeps names.
Characters outside `[A-Za-z0-9_.-]` become `_`.

### Import

- **Buffers:** the GLB `BIN` chunk, data URIs, or external files read through `ctx.read`, so an
  edited `.bin` re-imports the model (0014 import dependencies). External images are not read yet.
- **Accessors:** every component type, `normalized`, byte strides (interleaved buffers), sparse
  accessors, and `KHR_mesh_quantization`. Values are converted to the engine's attribute formats.
- **Primitives:** triangles, triangle strips, and fans (strips and fans become lists). Points and
  lines are skipped with `gltf/unsupported-primitive`. Missing normals are generated flat, and
  missing indices stay missing (non-indexed draw).
- **Attributes:** `POSITION`, `NORMAL`, `TEXCOORD_0`, `COLOR_0` map to existing `Mesh` fields.
  `TANGENT`, `TEXCOORD_1`, `JOINTS_0`, and `WEIGHTS_0` become new optional `Mesh` fields that the
  renderer ignores until textures (0016) and skinning (M6) use them.
- **Materials:** `pbrMetallicRoughness` factors map to `StandardMaterial` (`baseColor`, `metallic`,
  `roughness`). `emissiveFactor` times `KHR_materials_emissive_strength` maps to `emissive`, and
  `emissiveLuminance` comes from the `emissiveLuminance` import setting (cd/m² per unit of
  strength, default 1000), since glTF emission has no physical unit. `doubleSided` and
  `alphaMode: MASK` with `alphaCutoff` become new `StandardMaterial` fields, and the forward
  renderer supports both (cull mode per pipeline, `discard` in the fragment stage).
- **Cameras and lights:** perspective cameras become `Camera3d` (`yfov` in degrees, `znear`).
  Orthographic cameras map to `orthoHeight`. `KHR_lights_punctual` directional lights become
  `DirectionalLight`, and glTF's lux maps across as-is. Point and spot lights are recorded in the
  scene artifact and skipped with a warning until M5. The `cameras` and `lights` settings, both off
  by default, control whether these are spawned at all. A model shouldn't bring its own camera
  into your scene unless you ask for it.
- **Extensions:** `KHR_lights_punctual`, `KHR_materials_emissive_strength`,
  `KHR_mesh_quantization`, and `KHR_texture_transform` (recorded for 0016) are supported. Any other
  extension in `extensionsRequired` fails the import with `gltf/unsupported-extension`. Unknown
  optional extensions are ignored and listed in the import warnings.
- **Validation:** structural problems fail with `ShardError`s whose `path` is a JSON pointer into
  the glTF JSON (`/meshes/2/primitives/0/attributes/POSITION`), such as an accessor out of range or
  a missing buffer. The asset's error in `asset.get` carries both the source path and the pointer.

### Import settings

```ts
settings: defineSchema('gltf/ImportSettings', {
  scale: t.f32({ default: 1, min: 0, description: 'Uniform scale applied to the node tree.' }),
  forward: t.enum(['+z', '-z'], {
    description: 'Which way the model faces. glTF models face +Z; Shard ships fly toward -Z.',
  }),
  emissiveLuminance: t.f32({ default: 1000, min: 0, unit: 'cd/m²' }),
  cameras: t.bool({ description: 'Spawn the file’s cameras.' }),
  lights: t.bool({ description: 'Spawn the file’s lights.' }),
  generateNormals: t.enum(['missing', 'always', 'never']),
})
```

`scale` and `forward` apply to the scene's root, not baked into vertices, so meshes stay shared
between models imported with different settings.

### Artifacts

- **Mesh** artifacts use a small binary format defined here and owned by `@aethervtt/shard-mesh`
  (`encodeMesh` / `decodeMesh`): a header, an attribute table, then 4-byte-aligned attribute arrays
  and indices in little-endian order. Loading creates TypedArray views over the artifact bytes
  without copying. The primitive meshes and every later mesh importer use the same format.
- **Material** artifacts are `StandardMaterial` JSON, the same as material data assets (0014).
- **Scene** artifacts are scene files (0010 format). Mesh and material references are paths to
  sibling sub-assets (`#Mesh/Hull` becomes `assets/ship.glb#Mesh/Hull`). A developer can read one
  with `asset.get` and copy nodes out of it into a hand-written scene.
- **Skin** and **AnimationClip** artifacts are JSON headers plus Float32Array data, keyed by node
  path so they survive re-exports that reorder nodes. A skin also stores each joint's rest pose
  (local translation, rotation, scale), which retargeting (M6) needs to map motion between
  skeletons with different proportions.

### Placing a model: `scene/SceneInstance`

```json
{
  "name": "ship",
  "components": {
    "core/Transform": { "translation": [0, 2, 0] },
    "scene/SceneInstance": { "scene": { "path": "assets/ship.glb#Scene" } }
  }
}
```

- `SceneInstance { scene: t.handle('Scene') }` spawns the scene asset's entities as children of
  the entity once the asset loads. Their paths continue the parent's (`ship/Hull`,
  `ship/Hull/Cockpit`), so `entity.get`, `entity.patch`, and tests address them like any other
  entity.
- Instance children are generated. `saveScene` skips them, and editing one changes the running
  world only. Overrides that persist come with the prefab spec, which builds on this component.
- When the scene asset reloads (the `.glb` changed), the instance despawns its children and spawns
  the new tree. Patches made to the old children are lost. That matches full-replace scene reload
  (0010).
- `whenSceneReady` waits for instance scenes and everything they reference.
- **Joints are entities.** Every skeleton node spawns like any other node, with a path
  (`hero/Armature/Hips/Spine/Hand_R`). Parenting an entity to a joint attaches it to that bone,
  and transform propagation keeps it there. This works as soon as this spec lands. Skinning and
  animation (M6) move the joint entities, and attached entities follow without further work.
- Node names become entity names. Siblings with the same name get `_2`, `_3`, and so on. A node
  with a multi-primitive mesh gets one child entity per primitive after the first (`Hull/1`).

### Agent surface

- `asset.get` on a `.glb` lists every sub-asset with its label and type, plus import warnings. For
  meshes it adds vertex and triangle counts and bounds. For scenes it adds the node tree and the
  overall bounds. Bounds matter because an agent has to place and scale a model it can't see.
- The import settings schema is published at `shard://schemas/importers/gltf` (0014), and
  `reimport_asset` with `{ settings: { scale: 0.01 } }` fixes a centimeter-scale model.
- The component catalog documents `scene/SceneInstance` with an example.
- Errors: `gltf/invalid`, `gltf/unsupported-extension`, `gltf/unsupported-primitive`,
  `gltf/buffer-missing`, `gltf/accessor-out-of-range`. Each carries a pointer into the glTF JSON.

## Decisions

- **Our own parser, no three.js or loaders.gl.** The importer has to produce engine-native
  artifacts and pointer-carrying errors, and a glTF parser is a few hundred lines. A dependency
  would add weight without doing either.
- **One `Mesh` per primitive.** `Mesh` has one material slot, and the renderer batches by mesh and
  material, so splitting matches how it's drawn.
- **Models are placed through `SceneInstance`.** Copying nodes into scene files would duplicate the
  model and break on re-export. An instance stays linked to the file and hot reloads with it.
- **`scale` and `forward` go on the root.** Mesh artifacts stay shareable, and changing a setting
  re-imports a tiny scene artifact, not the geometry.
- **Cameras and lights are off by default.** Models from asset stores often carry both, and
  dropping a model into a scene shouldn't replace its camera.
- **Joints are entities, not a separate bone array.** Attachments, IK targets, and debugging
  then use what already exists: paths, `ChildOf`, `entity.get`, and transform propagation. The
  M6 animation spec can still sample into packed arrays and write joint transforms in one pass,
  so the per-frame cost stays low.
- **Labels are name-based.** They're readable and survive the array reordering that DCC exports
  cause.

## Acceptance criteria

- [x] Khronos sample models checked in as fixtures import without errors: `Box`, `BoxInterleaved`,
      `TriangleWithoutIndices`, `SimpleSparseAccessor`, `SimpleMeshes`, `CesiumMan`, and
      `LightsPunctualLamp`, in both `.gltf` and `.glb` form where the sample has both.
- [x] Positions, normals, UVs, and indices from each fixture match values decoded independently in
      the test (a reference decode of the accessors).
- [x] A scene with `scene/SceneInstance` pointing at a multi-node fixture renders as authored
      (golden image), and its children are addressable by path through `entity.get`.
- [x] Saving that scene writes the instance entity only, not its children.
- [x] Editing an external `.bin` or the `.gltf` while the app runs re-imports and respawns the
      instance.
- [x] Changing `scale` or `forward` re-imports only the scene artifact. Mesh artifact keys stay the
      same.
- [x] A file requiring `KHR_draco_mesh_compression` fails with `gltf/unsupported-extension`. A
      corrupt accessor fails with a pointer to it. Neither stops other imports.
- [x] `doubleSided` and `MASK` materials render correctly in the golden scene.
- [x] `CesiumMan`'s skin and animation import as `Skin` and `AnimationClip` sub-assets, with joint
      and channel counts that match the file, and a rest pose for every joint.
- [x] An entity parented to a `CesiumMan` joint by path sits at that joint's world transform.
- [x] Importing a 1M-triangle `.glb` takes under 2 s in Node, and loading its mesh artifact takes
      under 20 ms.

## Implementation notes

- **Scene artifacts keep sibling references as `#Mesh/Hull`**, and the Scene asset type resolves
  them against the source's current path at load. Moving a `.glb` needs no re-import, and runtime
  dependencies that point at a moved source are rewritten with it.
- **`scale` and `forward` are baked into the top-level nodes' transforms** rather than a wrapper
  entity, so instance paths stay `ship/Hull`. As built, `forward: "+z"` keeps the file as authored
  and `"-z"` turns the model 180° to face Shard's forward.
- **SceneInstance** lives in `@aethervtt/shard-scene`, with a `ScenePlugin` that `buildApp` adds. Children
  spawn in `whenSceneReady` (headless) and through a PreUpdate system that only does work when an
  instance was added or changed (a dirty flag set by an observer) or its asset reloaded.
- **Names:** unnamed nodes become `Node<index>` (Box.glb's mesh is at `box/Node0/Node1`).
- **Emission:** the emissive color is `emissiveFactor` divided by its largest component; luminance
  is that component × strength × the `emissiveLuminance` setting.
- **Materials:** `StandardMaterial` gained `doubleSided`, `alphaMode` (opaque or mask), and
  `alphaCutoff`. The forward renderer builds a cull-none pipeline variant and discards masked
  fragments. Texture slots are wired by 0016, which bumped the importer to version 2.
- **`asset.get` on a `.glb`** returns a `Source` entry listing its sub-assets, plus `artifact` paths.
- **Fixtures:** the Khronos samples are vendored under `packages/gltf/fixtures/khronos` (7.9 MB,
  with their license files).
- An external `.bin` edit reloads the changed mesh in place (same object, version bumped). A node
  rename in the `.gltf` respawns the instance with the new paths.
- Measured: a 1M-triangle `.glb` imports in about 80 ms and its mesh loads in about 5 ms.

## Open questions

- None blocking. Deferred: meshopt and Draco decoding, until a real model needs them. Meshopt
  comes first because its decoder is small.
