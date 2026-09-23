# 0038 — Save/load, settings, and localization

- **Status:** accepted
- **Packages:** `@shard/save` (new), `@shard/platform`, `@shard/scene`, `@shard/input`, `@shard/ui`
- **Depends on:** 0002, 0010, 0030, 0031, 0036

## Context

Three game services every shipped game needs, all of which are "serialize some schema'd data and
put it somewhere": saving and loading the game, remembering the player's settings, and showing text
in the player's language. The schema system already serializes every component, and scenes
already know what was authored, so most of the work is choosing what to save and where.

A save that stores the whole world is large and breaks whenever a scene changes. A save that
stores only the differences from the authored scenes is small, survives scene edits, and reuses
0010's "unchanged since load" tracking.

## Goals

- Save and load game state to named slots: the loaded scenes, what changed in them, runtime-spawned
  entities (prefab instances by reference), and persistent resources.
- Opt-in and opt-out per component and entity (`Persist`, `NoSave`), migration through component
  versions, and a save format version.
- Storage through the platform: files in Node and Tauri, IndexedDB in browsers.
- Settings: a schema'd resource persisted per user, with project defaults, applied live (volume
  buses, graphics options, key rebinding).
- Localization: string tables per locale, keys with parameters and plural rules, live locale
  switching, `UiText.key` and `Text.key` resolved automatically, and missing-key validation.

## Non-goals

- Cloud saves, save encryption, and autosave policies (a game schedules `save`).
- Binary save formats (0002 non-goal; JSON compresses well).
- Saving physics solver state beyond body poses and velocities (contacts rebuild in a step).
- Machine translation, and fonts for scripts the text renderer doesn't shape (0025 limits).

## Design

### What a save holds

```json
{
  "version": 1,
  "engine": "0.x",
  "time": { "elapsed": 1234.5, "frame": 74070 },
  "scenes": {
    "scenes/main.scene.json": {
      "changed": { "ship": { "core/Transform": { "translation": [10, 2, 0] }, "star-explorer/Health": { "current": 40 } } },
      "removed": ["asteroids/rock-12"]
    }
  },
  "spawned": [
    { "prefab": { "guid": "…", "path": "prefabs/drone.prefab.json" }, "parent": "base",
      "components": { "core/Transform": { "translation": [4, 0, 1] } }, "overrides": {} },
    { "components": { "star-explorer/Waypoint": { "label": "Crash site" } } }
  ],
  "resources": { "star-explorer/Inventory": { "items": [] } },
  "rng": { "star-explorer/loot": [1, 2, 3, 4] }
}
```

- Scene entities save as field diffs against the authored scene (the same diff as `saveScene`,
  0010, and prefab overrides, 0030). Despawned scene entities are listed by path.
- Runtime-spawned prefab instances save as the prefab ref plus root components and overrides.
  Other runtime entities save their components in full, with entity references rewritten to paths
  or save-local ids.
- `Persist` on a resource definition (an option on `defineResource` with a schema) includes it.
  `NoSave` on an entity, or `save: false` on a component definition, leaves it out. Derived
  components (`serialize: false`) never save.
- Named RNG streams (`rng.fork` labels) save their state, so loot after a load matches loot
  without one.

### Load

`loadGame(world, slot)` unloads the current scenes, loads each saved scene file fresh (current
version from disk), applies the diffs and removals, spawns the saved entities, restores resources
and RNG states, and waits for `whenSceneReady`. Component data older than the current schema goes
through its migrations (0002), and a diff whose path no longer exists in the scene is reported as
`save/stale-entity` and skipped.

### Storage

`platform.storage` gains `read(key)`, `write(key, bytes)`, `list(prefix)`, and `delete(key)`.
Node and Tauri write under the user data directory (`<appData>/<project>/saves/<slot>.json`), and
the browser uses IndexedDB. Headless tests use a memory store.

### Settings

```ts
export const Settings = project.settings({
  masterVolume: t.f32({ default: 1, min: 0, max: 1 }),
  fullscreen: t.bool(),
  quality: t.enum(['low', 'medium', 'high'], { default: 'high' }),
})
```

- A settings definition is a schema'd resource saved to `settings.json` in platform storage on
  change (debounced), loaded before `Startup`. Project defaults can come from `settings/*.json`.
- Engine settings are built in: bus volumes (0035), window and quality options, and **input
  bindings**, where a rebinding stores the changed action map bindings (0008) as an override of
  the authored map.

### Localization

```
locales/en.strings.json   { "hud.fuel": "Fuel: {amount}%", "items.count": { "one": "{n} item", "other": "{n} items" } }
locales/pt-BR.strings.json
```

- String tables are data assets. `Locale` (resource) holds the current locale and a fallback
  chain (`pt-BR` → `pt` → `en`). `tr(world, 'hud.fuel', { amount: 42 })` formats with `{name}`
  parameters and plural categories from `Intl.PluralRules`, and numbers with `Intl.NumberFormat`.
- `UiText.key` and `Text.key` render the translated string and update when the locale or the
  table changes. `params` on the same component fill parameters.
- `shard validate` reports keys missing from any locale, parameters that differ between locales,
  and keys used in scenes and prefabs that no table defines.

### Agent surface

- **Protocol:** `save.write { slot }`, `save.read { slot }`, `save.list`, `save.describe { slot }`
  (entity counts, size, what differs from the scenes), `settings.get` and `settings.set`, and
  `locale.set` plus `locale.missing`. MCP tools `save_game` and `load_game`.
- The save format has a JSON Schema, so an agent can read a save and edit it for a test fixture
  ("load a save where the player has 10 fuel").
- A skill, `save-and-settings.md`, and `localize.md`.
- **Errors:** `save/not-found`, `save/version-mismatch`, `save/stale-entity` (warning),
  `locale/missing-key` (warning at runtime, error in validate), `locale/bad-plural`.

## Decisions

- **Saves are diffs against authored scenes.** Small files, and scene edits after a save don't
  corrupt it: new authored content appears, and changed fields keep the player's values.
- **Schema'd resources and components only.** Everything saved has a schema, so saves validate,
  migrate, and load through the same code as scenes.
- **Settings are just a persisted resource.** Systems read them like any resource, and changes
  apply live through normal change detection.
- **`Intl` for plurals and numbers.** Every host has it, and CLDR data is too large to ship.

## Acceptance criteria

- [ ] Save, change the world, load: the world hash matches the hash at save time, including a
      runtime-spawned prefab and a moved scene entity. A despawned scene entity stays despawned.
- [ ] Adding an entity to the scene file after saving: loading the save shows the new entity and
      keeps the saved changes.
- [ ] A component bumped to version 2 with a migration loads a version-1 save correctly.
- [ ] Physics bodies resume with their saved velocities (a thrown box keeps flying after load).
- [ ] Settings changed at runtime persist across an app restart (Node storage), and a rebinding
      changes which key fires the action.
- [ ] Switching locale updates every `UiText` with a key on the next frame. Plurals follow
      `Intl.PluralRules` for `en` and `pt-BR`. `shard validate` lists a key missing in `pt-BR`.
- [ ] Browser saves round-trip through IndexedDB in the playground.

## Open questions

- None blocking.
