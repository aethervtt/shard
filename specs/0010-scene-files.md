# 0010 — Scene files

- **Status:** implemented
- **Packages:** `@shard/scene`
- **Depends on:** 0002, 0004, 0007, 0009

## Context

Scenes are how an agent builds a world without writing engine code. They're JSON the agent can
read, write, diff, and validate before running anything. Every component already has a schema
(0002), so a scene file is mostly a list of entities with component values, plus the glue: entity
references, hierarchy, inline assets, and authoring conveniences.

For a procedural game most content won't be listed entity by entity; it will come from generators
(M7). Scenes stay the place where generators are placed and configured, so the format has to leave
room for that without changing.

## Goals

- A `*.scene.json` format: entities, hierarchy, component values, inline assets, resources.
- Validation of a whole scene against the component schemas, with JSON-pointer paths, before load.
- A composed JSON Schema for scene files, so editors and agents validate while writing.
- Load (spawn) and save (serialize a world subset), with a stable, diff-friendly output.
- Entity references by path, resolved on load.
- Authoring conveniences: presets (`"illuminance": "daylight"`), `rotationEuler` in degrees,
  procedural mesh references.
- Reload: replace a loaded scene's entities when the file changes.

## Non-goals

- Prefabs and overrides (M6 spec); nested scene instancing comes with it.
- Diff-based hot reload that preserves runtime state (full replace for now).
- File-backed assets (M4). Until then assets are inline or procedural.

## Design

### Format

```json
{
  "$schema": "../.shard/schemas/scene.schema.json",
  "version": 1,
  "assets": {
    "hull": { "type": "Material", "value": { "baseColor": "#8a93a6", "metallic": 1, "roughness": 0.35 } },
    "rock": { "type": "Mesh", "procedural": "sphere", "params": { "radius": 2, "segments": 24 } }
  },
  "resources": {
    "render/AmbientLight": { "color": [1, 1, 1], "brightness": 800 }
  },
  "entities": [
    {
      "name": "sun",
      "components": {
        "render/DirectionalLight": { "illuminance": "direct-sun" },
        "core/Transform": { "rotationEuler": [-50, 30, 0] }
      }
    },
    {
      "name": "ship",
      "components": {
        "core/Transform": { "translation": [0, 2, 0] },
        "render/Mesh3d": { "mesh": { "path": "procedural:box?x=4&y=1&z=8" } },
        "render/MeshMaterial": { "material": { "path": "#hull" } }
      },
      "children": [
        {
          "name": "camera",
          "components": {
            "render/Camera3d": { "fovY": 70 },
            "render/Exposure": { "ev100": "sunny" },
            "core/Transform": { "translation": [0, 3, 12] }
          }
        }
      ]
    }
  ]
}
```

- `name` is unique among siblings; an entity's **path** is its names joined with `/`
  (`ship/camera`). `t.entity` fields accept paths.
- `children` sets `ChildOf`; derived components (`Children`, `GlobalTransform`,
  `ComputedVisibility`) are never written. Components opt out with a new schema option,
  `serialize: false`.
- Component keys are registered names; values follow each component's schema.

### Assets in scenes

- `#name` refers to an entry in the scene's `assets` block (materials, procedural meshes).
- `procedural:<primitive>?<params>` makes a mesh from `@shard/mesh` primitives, cached by the full
  string. This is the seed of M7's generators-as-assets: a generator is just a richer
  `procedural:` source.
- File paths (`assets/ship.glb#Mesh0`) are accepted by the format and resolved once the asset
  database exists (M4); until then they fail with `scene/asset-unavailable`.

### Authoring conveniences

- **Presets:** numeric fields that declare presets (`illuminance`, `ev100`) accept the preset name.
  A new schema field option, `presets: Record<string, number>`, makes this general; the JSON Schema
  shows them as an `enum` alternative.
- **`rotationEuler`** on `core/Transform`: degrees, X then Y then Z; converted on load. Save writes
  quaternions unless the entity was loaded with `rotationEuler` and hasn't rotated since, in which
  case it writes the Euler form back, so hand-authored files stay readable.

### Validation

`validateScene(json, registry)` checks the structure, every component against its schema,
asset references, entity paths, and unique sibling names, and collects all errors (not just the
first). `scene/…` codes with pointers like `/entities/1/children/0/components/render~1Camera3d/fovY`.

### Load, save, reload

- `loadScene(world, json, { root? })` validates, then spawns everything in one command batch,
  tagging entities with `SceneMember { scene, path }`. Returns the path → entity map.
- `saveScene(world, scene)` serializes the entities of a scene (or any subset) in path order, with
  keys sorted by the component's field order, so saves are stable and diffs are minimal.
- `reloadScene(world, id, json)` despawns the old members and loads the new file. The CLI and
  Studio call it on file change.

### Agent surface

- Scenes are the main thing agents edit. `validateScene` runs in the CLI and MCP before any load,
  and the composed schema is written to `.shard/schemas/scene.schema.json` (0009).
- Load returns the path map, so tools can address entities by path (`ship/camera`) instead of ids.

## Decisions

- **Names and paths, not ids, in files.** Ids are runtime details; paths are readable and stable
  under edits.
- **Procedural references as asset paths.** Agents can build whole scenes before any asset exists,
  and M7 generators slot into the same mechanism.
- **Collect all validation errors.** An agent fixes a file in one pass instead of one error per run.
- **Full replace on reload.** Simple and correct; state-preserving reload waits for prefabs.
- **`.scene.json` extension.** Plain JSON, so every editor, formatter, and tool understands it.

## Acceptance criteria

- [x] A scene with hierarchy, inline materials, procedural meshes, presets, and `rotationEuler`
      loads and renders as authored (golden image).
- [x] Save after load reproduces the file (same JSON, same key order), including `rotationEuler`.
- [x] Validation reports every error in a broken scene with exact pointers, and the composed JSON
      Schema accepts/rejects the same fixtures.
- [x] `t.entity` fields accept paths and resolve on load; unknown paths fail validation.
- [x] Reload replaces the scene's entities and leaves others alone.
- [x] Loading 10k entities from a scene file takes under 100 ms.

## Implementation notes

- **Authored form is preserved per field, not only for `rotationEuler`.** Load keeps a snapshot of
  each component's serialized value; save writes the authored JSON for any field that still
  serializes the same (presets, `#asset` and `procedural:` references, Euler rotations), and the
  new value otherwise. Unchanged files round-trip byte for byte.
- **f32 fields serialize in their shortest round-trip form** (`0.4`, not `0.4000000059604645`),
  through a new core `f32ToJson` used by numbers, vectors, and colors. Without it every save would
  rewrite hand-authored decimals.
- **Aliases:** `rotationEuler` is handled by a small alias table (`expandComponentAliases`), so
  other components can add authoring forms later. Setting both `rotation` and `rotationEuler` fails
  with `scene/conflicting-fields`.
- **Validation** collects every error and drops a generic asset error when a scene-specific error
  exists at the same pointer. File-path assets fail with `scene/asset-unavailable` until M4.
- **`SceneIndex`** (a resource) maps scene ids and paths to entities; `findEntityByPath` and
  `pathOfEntity` read it. `unloadScene` was added alongside `reloadScene`.
- **Loading** spawns directly rather than through a command batch: it runs between frames (CLI,
  protocol, tests), where direct spawns are safe and let load return the path map immediately.
  The 10k-entity check is best of three runs; it measures about 65 ms.

## Open questions

None.
