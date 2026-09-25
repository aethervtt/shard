# Make a prefab

A prefab is a reusable entity tree: `prefabs/<name>.prefab.json`, validated against
`.shard/schemas/prefab.schema.json`. It has one `root` entity, written like a scene entity:

```json
{ "$schema": "../.shard/schemas/prefab.schema.json", "version": 1,
  "assets": { "hull": { "type": "Material", "value": { "baseColor": "#8a93a6" } } },
  "root": { "name": "ship",
    "components": { "core/Transform": {}, "maze-chase/Health": { "max": 100 } },
    "children": [
      { "name": "Hull", "components": { "scene/SceneInstance": { "scene": { "path": "assets/ship.glb#Scene" } } } },
      { "name": "Exhaust", "components": { "particles/ParticleSystem": { "effect": { "path": "assets/fx/exhaust.particles.json" } } } }
    ] } }
```

1. **Extract**: move an entity and its children out of a scene into `root`. Entity fields inside
   the prefab use paths from the root (`"Hull"`, `"Hull/Cockpit"`; `"."` is the root).
   `shard import` then `shard validate --json`: errors point into the file.
2. **Place** it in a scene. The instance entity *is* the root: the prefab's root components merge
   into it, and fields the entity sets win. Its children are generated, at `player-ship/Exhaust`:

   ```json
   { "name": "player-ship", "components": {
     "core/Transform": { "translation": [0, 5, 0] },
     "scene/PrefabInstance": { "prefab": { "path": "prefabs/ship.prefab.json" },
       "overrides": {
         "Exhaust": { "particles/ParticleSystem": { "timeScale": 2 } },
         "Hull/Cockpit": { "render/MeshMaterial": { "material": { "path": "materials/red.material.json" } } },
         "Hull/Antenna": null,
         "Exhaust/particles/ParticleEmitterOverrides": null } } } }
   ```

   Override keys are paths from the instance and reach into models inside it (`Hull/Cockpit`).
   A patch sets fields (adding the component if missing), `null` removes the entity, and a path
   ending in a component name set to `null` removes that component. Authored `children` of the
   instance sit next to the generated ones (names can't clash). `scene/SceneInstance` takes the same
   `overrides` for a model placed directly.
3. **Override live**: `patch_entity` on `player-ship/Exhaust`, check `prefab_overrides`, then
   `save_scene` with `"write": true`: the change is written into `overrides`, nothing else.
   `prefab.apply` (protocol) moves an instance's overrides into the prefab file instead.
4. **Variant**: a prefab that extends another. Editing the base updates every variant.

   ```json
   { "version": 1, "extends": { "path": "prefabs/ship.prefab.json" },
     "rootComponents": { "maze-chase/Health": { "max": 250 } },
     "overrides": { "Hull/Antenna": null },
     "children": [{ "name": "Turret", "components": { "core/Transform": {} } }] }
   ```
5. **Spawn from code**: load once, then spawning copies a compiled template (cheap enough for
   bullets). In a system, pass `ctx.commands` to spawn when the commands apply:

   ```ts
   import { loadPrefab, spawnPrefab } from '@shard/scene'
   await loadPrefab(world, 'prefabs/ship.prefab.json') // e.g. in the plugin's setup
   const ship = spawnPrefab(ctx.commands, 'prefabs/ship.prefab.json', {
     transform: { translation: [0, 5, 0] },
     overrides: { Exhaust: { 'particles/ParticleSystem': { timeScale: 2 } } },
   })
   ```

   Unloaded prefabs throw `prefab/not-loaded`. MCP `spawn_prefab` does the same from tools.

Saving a prefab file updates every running instance and keeps each one's overrides; an override
whose path no longer exists is kept in the file and logged as `prefab/stale-override`.
`get_asset` on a prefab shows its entity tree, and on a variant its base chain.
