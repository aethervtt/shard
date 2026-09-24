# 0031 — Data assets

- **Status:** implemented
- **Packages:** `@shard/assets`, `@shard/project`, `@shard/core`
- **Depends on:** 0002, 0009, 0014, 0017, 0030

## Context

Games are full of tuning data that isn't an entity: weapon stats, item definitions, biome
palettes, loot tables, dialogue, wave schedules. Unity calls these ScriptableObjects. Keeping them
in code means a script edit and a reload for every tweak, and it hides them from agents, who are
at their best editing a validated JSON file.

The engine already has data assets internally (materials, particle effects, atlases, clips all go
through `defineDataAsset`). Projects can't define their own yet, can't reference one data asset
from another by type, and can't make one asset a variant of another.

## Goals

- Projects define data asset types with the component schema system, in `scripts/`:
  `project.dataAsset('Weapon', fields, { extension: 'weapon' })`.
- Files `data/**/*.weapon.json` are validated by that schema, imported, cached, hot reloaded, and
  published as JSON Schema.
- Components and other data assets reference them with `t.handle('star-explorer/Weapon')`, which
  validates the type.
- Typed, allocation-free reads at runtime: `weapons.get(ref)` returns the value.
- Variants: a file can `$extends` another of the same type and override fields.
- Enumerating a type at runtime ("every item"), for catalogs and loot tables.
- Hot reload in place, and migration when a script reload changes the type's schema.

## Non-goals

- Spreadsheet or CSV import (a later importer on the same types).
- Binary data assets.
- Editing data assets from a running game (they're source files; the protocol writes files).

## Design

### Defining a type

```ts
// scripts/weapons.ts
export const Weapon = project.dataAsset('Weapon', {
  damage: t.f32({ default: 10, min: 0, unit: 'hp' }),
  fireRate: t.f32({ default: 4, unit: 'shots/s' }),
  projectile: t.handle('Prefab'),
  sound: t.handle('AudioClip'),
  upgradesTo: t.handle('star-explorer/Weapon'),
}, { extension: 'weapon', description: 'A ship weapon.' })

// in a component
export const Armed = project.component('Armed', { weapon: t.handle('star-explorer/Weapon') })

// in a system
const weapons = world.resource(Weapon.store)
const stats = weapons.get(armed.weapon)          // Infer<typeof Weapon> | undefined
```

- The type name is namespaced like components (`star-explorer/Weapon`). The extension must be
  unique across importers (`assets/duplicate-extension`).
- `dataAsset` returns a `DataType`: the schema itself (so `Infer<typeof Weapon>` works), plus
  `type` (its asset type), `store` (the resource `star-explorer/WeaponAssets`), `importer`
  (`data/weapon`), and `extension`. Engine packages use the same `defineDataType` from
  `@shard/assets`; `defineDataAsset` (schema + importer only) gained `$extends` too.

### Files

```json
{
  "$schema": "../../.shard/schemas/weapon.schema.json",
  "$extends": { "path": "data/weapons/laser.weapon.json" },
  "damage": 18,
  "sound": { "path": "assets/sfx/heavy-laser.ogg" }
}
```

- `$extends` merges field by field over the base (structs recursively; lists and handles replace).
  It takes a `path` (not a guid: importing runs before the catalog is complete). A path that starts
  at an asset root is a project path; anything else is relative to the file that wrote it, so a base
  can extend its own neighbours. The base must have the same extension
  (`data/extends-type-mismatch`), must exist (`assets/not-found`), and is an import dependency, so
  editing it re-imports its variants. Cycles fail with `data/extends-cycle`.
- The merged value is validated as a whole, so a variant can rely on its base for required fields.
  An error names the file that set the bad field (`bad-base.weapon.json (a base of child…)`).
- The artifact is the merged, normalized value with defaults filled in, so a load is a JSON parse.
- Handle fields become load dependencies, so the prefab and sound above load with the weapon. Handles
  that form a cycle (a weapon that upgrades to one that upgrades back) load alongside each other
  instead of waiting on each other.
- On load, handles get their guid filled in from the catalog, so `store.get(weapon.upgradesTo)`
  works without a path lookup.

### Runtime

- Each type's store is an `AssetStore` (0014). A reload updates the object in place and bumps its
  version, so code holding the value sees the new numbers.
- `assets.all(type)` lists the catalog entries of a type. `loadAll(world, type, { prefix })` (from
  `@shard/assets`, taking the `DataType` or its name) loads them and resolves to the values, sorted
  by path; files that fail to load are left out.
- Unloading follows 0014 reachability: a data asset stays loaded while a component references it,
  something pins it, or another loaded asset depends on it.

### Script reload

A data type is a definition in the project namespace, so hot reload (0017) redefines it. The
importer version is a hash of the type's JSON Schema, so when the schema changes, the reloader's
asset scan re-imports every file of that type against it. The reload report lists them in
`assets.imported`, and files that no longer validate in `assets.failed`, reported like any import
failure while the last good values stay loaded. The store resource survives the reload, so values
update in place. `shard dev` evaluates the project bundle on the Node side too, so its asset
database has the project's importers and re-imports after each rebuild.

### Agent surface

- `.shard/schemas/<extension>.schema.json` for each type, and `.agents/assets.md` gains a
  "Project data types" section: each type, its fields, its extension, and where its files live.
- `asset.get` on a data asset returns its `value`; on a variant, `info.extends` is the chain and
  `info.setBy` maps each field's JSON pointer to the file that set it.
  `asset.list { type: 'star-explorer/Weapon' }` lists them.
- `shard validate` validates every data file, including `$extends`. Handle types in data files are
  checked after the scan (`validateDataAssets`), since the catalog isn't complete while importing.
- `.agents/components.md` names each handle's asset type (`star-explorer/Weapon ref`).
- A generated skill, `make-a-data-asset.md`: define a type, write files, reference them from a
  component, make a variant.
- **Errors:** `data/extends-cycle`, `data/extends-type-mismatch`, `assets/duplicate-extension`, and
  `schema/asset-type-mismatch` for a handle of the wrong type.

## Decisions

- **Data types are component schemas.** Validation, defaults, JSON Schema, docs, and migration
  already exist for components. A second schema language would drift.
- **`$extends` resolves at import.** Runtime code sees plain values and never walks a chain.
- **Stores are per type.** `store.get(ref)` is one map lookup with no casts or allocation.
- **Schema changes re-import.** The importer version includes the schema hash, so a changed type
  can't serve artifacts built with the old one.

## Acceptance criteria

- [x] A project type `Weapon` imports `data/**/*.weapon.json`, fills defaults, and rejects a bad
      field with a pointer into the file. Other files keep importing.
- [x] A component with `t.handle('star-explorer/Weapon')` loads the weapon with its scene, and a
      handle to an asset of another type fails validation with `schema/asset-type-mismatch`.
- [x] A variant with `$extends` has its base's values plus its own. Editing the base updates the
      variant while running. A cycle fails with `data/extends-cycle`.
- [x] Editing a weapon file while running changes the value `store.get` returns within two frames,
      and the object identity stays the same.
- [x] `loadAll(world, 'star-explorer/Weapon')` returns every weapon file's value.
- [x] Adding a field to the type in a script and reloading re-imports every weapon file, and the
      new field has its default.
- [x] `shard docs` writes the weapon schema and lists the type in `.agents/assets.md`.

## Implementation notes

- Structs, lists, and handles expose their inner fields, item type, and asset type on the field
  (`fields`, `item`, `assetType`), which the merge and handle resolution walk.
- `defineImporter` now rejects an extension another importer already claims.
- `scan()` sorts `failed` like `imported`, so reports are deterministic.
- Playground `#data`: a firing range whose four turrets read `.weapon.json` files (two variants of
  the laser) from an in-memory project folder; edit the base, edit a variant, reload the script
  with a new field, and break a file, with measured DPS next to what the data says.

## Open questions

- None blocking. Deferred: CSV and spreadsheet importers for tables of one type.
