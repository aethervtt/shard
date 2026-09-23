# 0030 — Prefabs, overrides, and variants

- **Status:** accepted
- **Packages:** `@shard/scene`, `@shard/assets`, `@shard/protocol`, `@shard/project`
- **Depends on:** 0010, 0014, 0015

## Context

A scene today is a flat list of hand-written entities, plus `SceneInstance` for placing a model's
node tree. A game needs reusable, composite things: a ship with its hull, thrusters, particle
exhaust, collider, and health; a creature spawned by the hundred; a HUD panel. It needs to place
them in scenes with small changes ("this one is red"), spawn them from code at runtime, and build
variants ("the heavy ship is the ship with more armor").

`SceneInstance` already links an entity to a node tree that hot reloads with its source. Prefabs
extend that: the tree is written in a data file, changes to an instance persist as overrides, and
the same file spawns from code.

## Goals

- `*.prefab.json` files: one root entity with children, components, and inline assets, in the
  scene format. Prefabs are assets with GUIDs, so moving one keeps references.
- `scene/PrefabInstance` places a prefab. The instance entity **is** the prefab root: the root's
  components land on it, and the entity's own components in the scene override them field by field.
- Overrides for descendants as patches keyed by path: change fields, add or remove components,
  remove entities, add children.
- Saving a scene writes an instance's differences from its prefab as overrides, so an
  `entity.patch` on `ship/Hull` survives a save.
- Nested prefabs and variants (a prefab that extends another with overrides).
- Hot reload: editing a prefab file updates every instance and keeps each instance's overrides.
- `spawnPrefab` from code and commands, fast enough to spawn creatures and bullets.
- Overrides on `SceneInstance` too, so a glTF model's material can change per placement.

## Non-goals

- Keeping runtime state of instance children across a prefab reload. Children respawn with
  overrides applied, as model instances do (0015). Runtime-only changes are lost unless saved.
- Scene-to-scene linking beyond prefabs (streaming sub-scenes is M7).
- Prefab editing UI.

## Design

### Files

```json
{
  "$schema": "../.shard/schemas/prefab.schema.json",
  "version": 1,
  "assets": { "hull": { "type": "Material", "value": { "baseColor": "#8a93a6" } } },
  "root": {
    "name": "ship",
    "components": {
      "core/Transform": {},
      "physics/RigidBody": { "kind": "dynamic" },
      "star-explorer/Health": { "max": 100 }
    },
    "children": [
      { "name": "Hull", "components": { "scene/SceneInstance": { "scene": { "path": "assets/ship.glb#Scene" } } } },
      { "name": "Exhaust", "components": { "particles/ParticleSystem": { "effect": { "path": "assets/fx/exhaust.particles.json" } } } }
    ]
  }
}
```

- A variant has `"extends": { "path": "prefabs/ship.prefab.json" }` and no `root`, plus
  `rootComponents` and `overrides` in the same form as an instance's (below). It's resolved at
  import against its base, and the base is an import dependency, so editing the base re-imports
  every variant.
- `prefabs` joins the default `assetRoots`. The importer is `prefab` (`.prefab.json`), producing a
  `Prefab` asset: the resolved, validated tree with its load dependencies.
- Validation is the scene validator's (every error, with pointers into the file), plus
  `prefab/cycle` for a prefab that contains or extends itself.

### Instances and overrides

```json
{
  "name": "player-ship",
  "components": {
    "core/Transform": { "translation": [0, 5, 0] },
    "star-explorer/Health": { "max": 200 },
    "scene/PrefabInstance": {
      "prefab": { "path": "prefabs/ship.prefab.json" },
      "overrides": {
        "Exhaust": { "particles/ParticleSystem": { "timeScale": 2 } },
        "Hull/Cockpit": { "render/MeshMaterial": { "material": { "path": "materials/red.material.json" } } },
        "Hull/Antenna": null,
        "Exhaust/particles/ParticleEmitterOverrides": null
      }
    }
  },
  "children": [{ "name": "Beacon", "components": { "render/PointLight": {} } }]
}
```

- `PrefabInstance { prefab: handle('Prefab'), overrides: json }` on an entity merges the prefab
  root's components into it (fields the entity sets win), and spawns the root's children under it.
- `overrides` maps a path relative to the instance to either a component patch (fields to set; a
  component the entity lacks is added), `null` (remove the entity and its subtree), or, with a
  trailing component name, `null` to remove that component.
- Authored `children` of the instance entity are ordinary scene entities next to the generated
  ones. A name clash is `prefab/duplicate-name`.
- Paths go through nested instances: `Hull/Cockpit` reaches into the glTF scene inside the prefab.
- Unknown paths and bad values are validation errors pointing into `overrides`, such as
  `/entities/3/components/scene~1PrefabInstance/overrides/Hull~1Cockpit`.
- `SceneInstance` gains the same `overrides` field for model instances.

### Spawning

Loading a prefab asset compiles it to a **template**: per entity, the deserialized component
values and the parent index, with asset refs resolved once. Instances and `spawnPrefab` copy
values from the template, and they don't touch JSON again.

```ts
const ship = spawnPrefab(world, 'prefabs/ship.prefab.json', {
  transform: { translation: [0, 5, 0] },
  overrides: { Exhaust: { 'particles/ParticleSystem': { timeScale: 2 } } },
  parent,
})
cmd.spawnPrefab(ref, options)            // the same, deferred, for systems
await loadPrefab(world, ref)             // spawnPrefab needs the asset loaded
```

`spawnPrefab` on an unloaded prefab throws `prefab/not-loaded`, with a hint to preload it or use
`PrefabInstance`, which waits. Runtime-spawned instances aren't scene members unless their parent
is, and they're found by `PrefabInstance` queries like any other.

### Saving

`saveScene` writes an instance entity as its authored components plus a fresh `overrides` diff:
for each generated descendant, the fields whose serialized value differs from the template, added
and removed components, and despawned entities. Unchanged fields keep their authored form (0010),
so an untouched scene still saves byte for byte.

### Hot reload

When a prefab (or anything it depends on) reloads, each instance respawns its generated children
from the new template and reapplies its overrides. Root components that came from the prefab are
rewritten, and fields the instance overrides stay. An override whose path no longer exists is
kept in the file and reported as `prefab/stale-override` (a warning), so a rename in the prefab
doesn't silently lose data.

### Agent surface

- `.shard/schemas/prefab.schema.json` is composed like the scene schema. `shard validate` checks
  prefab files and every instance's overrides.
- `asset.get` on a prefab shows its entity tree, and on a variant its base chain.
- **Protocol:** `prefab.spawn { prefab, transform?, overrides?, parent? }` returns the root and
  its paths. `prefab.overrides { entity }` returns an instance's current diff from its prefab
  (what a save would write). `prefab.apply { entity }` writes an instance's overrides back into
  the prefab file ("apply to prefab").
- **MCP:** `spawn_prefab` and `prefab_overrides`.
- A generated skill, `make-a-prefab.md`: extract entities into a prefab, place it, override it,
  make a variant, spawn it from a system.
- **Errors:** `prefab/not-loaded`, `prefab/cycle`, `prefab/unknown-path`, `prefab/duplicate-name`,
  `prefab/stale-override`.

## Decisions

- **The instance entity is the prefab root.** Root components are the thing you override most
  (position, health), and writing them on the entity is how scenes already work. There's no hidden
  wrapper entity, so paths stay short (`player-ship/Exhaust`).
- **Overrides are path-keyed patches in the scene file.** They read like the prefab itself, and
  they diff cleanly. An agent can write them by hand, or patch the live entity and save.
- **Variants resolve at import.** A variant is its base plus overrides, flattened into one
  template, so spawning a variant costs the same as spawning its base.
- **Templates, not JSON, at spawn time.** Deserialization and asset resolution happen once per
  prefab load, so spawning is a copy.
- **Stale overrides are kept.** Losing authored data on a rename is worse than a warning.

## Acceptance criteria

- [ ] A scene with a prefab instance loads as authored: root components merged with the entity's
      own, generated children addressable by path, authored children alongside (golden image).
- [ ] Field overrides, added components, removed components, and removed entities all apply, at
      any depth, including inside a nested glTF instance.
- [ ] Patching `player-ship/Exhaust` through `entity.patch` and saving writes exactly that field
      into `overrides`. Saving an untouched scene reproduces the file byte for byte.
- [ ] A variant spawns as its base with its overrides. Editing the base file updates instances of
      the variant.
- [ ] Editing a prefab file while running updates all instances within two frames, and each keeps
      its overrides. A renamed child leaves a `prefab/stale-override` warning.
- [ ] A prefab that extends or contains itself fails with `prefab/cycle`.
- [ ] Spawning 1,000 instances of a 10-entity prefab takes under 20 ms (bench).
- [ ] `prefab.apply` writes an instance's overrides into the prefab file, after which the
      instance has no overrides and other instances pick up the change.

## Open questions

- None blocking. Deferred: per-instance keeping of runtime state across prefab reloads.
