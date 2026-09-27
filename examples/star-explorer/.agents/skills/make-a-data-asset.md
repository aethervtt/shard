# Make a data asset

Tuning data that isn't an entity (weapon stats, items, loot tables, wave schedules) is a project
data type: fields in `scripts/`, one JSON file per value.

1. **Define the type** with component-schema fields:

   ```ts
   export const Weapon = project.dataAsset('Weapon', {
     damage: t.f32({ default: 10, min: 0, unit: 'hp', description: 'Damage per hit.' }),
     fireRate: t.f32({ default: 4, unit: 'shots/s' }),
     projectile: t.handle('Prefab', { description: 'Spawned per shot.' }),
     upgradesTo: t.handle('star-explorer/Weapon'),
   }, { extension: 'weapon', description: 'A ship weapon.' })
   ```

   Run `shard docs`: the type shows up in `.agents/assets.md` and its schema is written to
   `.shard/schemas/weapon.schema.json`.
2. **Write files**: `data/weapons/laser.weapon.json`. Missing fields take their defaults.

   ```json
   { "$schema": "../../.shard/schemas/weapon.schema.json", "damage": 12,
     "projectile": { "path": "prefabs/bolt.prefab.json" } }
   ```
3. **Make a variant** that starts from another file and overrides fields (struct fields merge field
   by field, lists and handles replace):

   ```json
   { "$extends": { "path": "data/weapons/laser.weapon.json" }, "damage": 18 }
   ```

   Editing the base re-imports its variants. MCP `get_asset` on a variant shows its value, its
   `extends` chain, and which file set each field (`info.setBy`).
4. **Reference it** from a component: `project.component('Armed', { weapon: t.handle('star-explorer/Weapon') })`,
   and in a scene `"star-explorer/Armed": { "weapon": { "path": "data/weapons/laser.weapon.json" } }`.
   The weapon loads with the scene.
5. **Read it** in a system: `world.resource(Weapon.store).get(armed.weapon)` is one map lookup,
   no allocation. Every weapon at once: `await loadAll(world, Weapon)` (from `@aethervtt/shard-assets`).
6. **Check**: `shard import --json` then `shard validate --json`. Errors point into the file;
   a handle to the wrong type is `schema/asset-type-mismatch`, a loop of variants `data/extends-cycle`.

Saving a data file or changing the type's fields while the game runs reloads the values in place.
