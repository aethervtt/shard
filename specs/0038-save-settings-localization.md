# 0038 — Save/load, settings, and localization

- **Status:** implemented
- **Packages:** `@shard/save` (new), `@shard/core`, `@shard/platform` (and the `platform-*` hosts),
  `@shard/scene`, `@shard/input`, `@shard/text` (localization), `@shard/ui`, `@shard/project`,
  `@shard/node`, `@shard/testing`, `@shard/cli`
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
  "meta": { "label": "Crash site" },
  "schemas": { "star-explorer/Health": 1, "star-explorer/Inventory": 1 },
  "time": { "elapsed": 1234.5, "frame": 74070, "fixedElapsed": 1234.5 },
  "scenes": {
    "scenes/main.scene.json": {
      "changed": { "ship": { "core/Transform": { "translation": [10, 2, 0] }, "star-explorer/Health": { "current": 40 } } },
      "removed": ["asteroids/rock-12"]
    }
  },
  "spawned": [
    { "id": "@0", "prefab": { "guid": "…", "path": "prefabs/drone.prefab.json" }, "parent": "base",
      "components": { "core/Transform": { "translation": [4, 0, 1] } }, "overrides": {} },
    { "id": "@1", "components": { "star-explorer/Waypoint": { "label": "Crash site", "target": "@0" } } }
  ],
  "resources": { "star-explorer/Inventory": { "items": [] } },
  "rng": { "star-explorer/loot": [1, 2, 3, 4] }
}
```

- Scene entities save as field diffs against the scene as loaded (0010's "unchanged since load"
  snapshot). Despawned scene entities are listed by path (a subtree by its root). A reparented
  scene entity records `core/ChildOf`. A scene-placed instance's changed children go into its
  `overrides`, as `saveScene` writes them.
- Runtime-spawned prefab instances save as the prefab ref, the root fields that differ from the
  prefab's root (`null` for a removed component; `prefabRootComponents` in `@shard/scene`), and
  `currentOverrides`. Other runtime entities save their components in full. Every spawned entity
  has a save-local id (`@3`); entity fields become scene paths, save ids, or a path inside a saved
  instance (`@3/Hull`). Parents come before children.
- `persist: true` plus a `schema` (`defineSchema`) on `defineResource` includes a resource. The
  `save/NoSave` tag leaves an entity out (and a load keeps it as it is); `save: false` on a
  component definition (`def.saved`) leaves the component out. Derived components
  (`serialize: false`) never save.
- `schemas` records each saved component's and resource's version, so a load knows what to migrate.
- Named RNG streams save their state: `GlobalRng.stream(label)` returns the same forked `Rng` for a
  label every time (`Rng.getState` / `setState`), and saves record the root stream as
  `core/GlobalRng` plus every named stream. Loot after a load matches loot without one.
- Runtime-made assets (`mem:` guids from `store.add`) are only meaningful in the session that made
  them; a plain runtime entity that holds one reloads with that guid.

### Load

`loadGame(world, slot | file)` reads everything it needs first (the save, each scene file through
`SaveConfig.readScene`, the prefabs), then unloads the current scenes and runtime entities, loads
each saved scene file fresh (current version from disk), spawns the saved entities, applies the
diffs and removals, restores resources, RNG states, and time, and waits for `whenSceneReady`. The
app is paused (`AppControl`) while it runs, so no frame sees a half-loaded world. It returns
`{ scenes, spawned, warnings }`.

Component data older than the current schema goes through its migrations (0002). A diff holds only
the fields that changed, so migrations see partial objects and must tolerate missing fields. A
diff whose path no longer exists in the scene is reported as `save/stale-entity` and skipped, as
are references to missing entities (the field becomes null), unknown components
(`save/unknown-component`), and removed fields (`save/stale-field`). `captureGame` is synchronous
(a system can call it); `saveGame` captures and writes.

### Storage

`platform.storage` is `read(key)`, `write(key, bytes)`, `list(prefix)`, and `delete(key)` (the old
string `get`/`set` had no users). Saves are `saves/<slot>.json`; slot names are letters, digits,
`-`, and `_` (`save/bad-slot`).

- Node: files under `dataDir` (`createFileStorage`), default `.shard/user` in the project. Writes
  go to a temp file and are renamed. `openProject` uses a memory store unless `userData: 'files'`:
  `shard run`, `shard test`, and screenshots never depend on an earlier session, while
  `shard serve` and `shard mcp` keep files.
- Tauri: files under `dataDir` through the fs plugin; Studio passes the app data folder.
- Browser: IndexedDB (`createIndexedDbStorage`); `shard dev` uses one database per project.
- Tests: `createMemoryStorage`.

### Settings

```ts
export const Settings = project.settings({
  masterVolume: t.f32({ default: 1, min: 0, max: 1 }),
  fullscreen: t.bool(),
  quality: t.enum(['low', 'medium', 'high'], { default: 'high' }),
})
```

- `defineSettings(name, fields)` (`project.settings(fields)` names it `<project>/Settings`) is a
  schema'd resource. The save plugin loads them before `Startup`: project defaults from
  `settings/*.json` (`{ "<settings name>": { fields } }`), then the player's `settings.json`.
  Changes are written when they differ, checked twice a second (plain writes to the resource
  count). `setSettings` validates and applies at once; `flushSettings` writes now.
- `engine/Settings` is built in: `volumes` (bus → volume, 0035), `quality` (shadow map sizes),
  `locale`, and **input bindings**: `rebindAction(world, 'map.action', bindings)` (0008; action
  maps keep their authored bindings, so `undefined` restores them) is recorded as an override of
  the authored map, and applied to maps as they're added. `setLocale` is recorded too. Window
  options are left to a game's own settings: no host exposes a window API yet.

### Localization

```
locales/en.strings.json   { "hud.fuel": "Fuel: {amount}%", "items.count": { "one": "{n} item", "other": "{n} items" } }
locales/pt-BR.strings.json
```

- Localization lives in `@shard/text`, which UI already depends on. String tables are assets
  (`*.strings.json`, importer `strings`, type `StringTable`) named by locale: `en.strings.json`,
  `hud.pt-BR.strings.json`. `locales` joins the default asset roots. Hosts load and pin every table
  after the scan (`loadProjectStrings`), since no scene references them.
- `text/Locale` holds `current` and `fallback`; the chain is `pt-BR` → `pt` → `fallback`.
  `tr(world, 'hud.fuel', { amount: 42 })` formats `{name}` parameters, picks plural forms (zero,
  one, two, few, many, other; `other` required, `locale/bad-plural`) by `n`, else `count`, else the
  first number, with `Intl.PluralRules`, and formats numbers with `Intl.NumberFormat`. A `zero`
  form is used for 0 when a table has one. `setLocale` canonicalizes the tag.
- `UiText`, `Text`, and `ScreenText` have `key` and `params`. The `text/localize` system writes
  the resolved string into a derived `text/Localized` component, which UI layout, text rendering,
  and `ui.describe` show instead of `text`. The authored text is never overwritten, so scene saves
  and game saves never capture translations. It resolves only rows whose component changed, unless
  the locale or a table did. A missing key logs `locale/missing-key` once and shows `text`.
- `shard validate` reports keys a locale lacks (`locale/missing-key`), `{params}` that differ
  between locales (`locale/param-mismatch`), and keys used in scenes and prefabs that no table
  defines.

### Agent surface

- **Protocol:** `save.write { slot, meta?, json? }` (json writes an edited save as is),
  `save.read { slot? }` (the save as JSON; without a slot, the game as it would save now),
  `save.load { slot | json }`, `save.list`, `save.describe { slot? }` (size, time, meta, changed
  entities and components per scene, removed ones, spawned by prefab), `settings.get` and
  `settings.set`, and `locale.set` plus `locale.missing`. MCP tools `save_game` and `load_game`.
  Gameplay tests get `game.saves`, `game.settings`, and `game.locale`.
- The save format has a JSON Schema (`.shard/schemas/save.schema.json`), so an agent can read a
  save and edit it for a test fixture ("load a save where the player has 10 fuel"). String tables
  have `strings.schema.json`.
- Skills: `save-and-settings.md` and `localize.md`.
- **Errors:** `save/not-found`, `save/version-mismatch`, `save/invalid`, `save/bad-slot`,
  `save/missing-scene`, `save/stale-entity`, `save/stale-field`, `save/unknown-component`,
  `save/unknown-resource` (the last four are load warnings), `locale/missing-key` (warning at
  runtime, error in validate), `locale/param-mismatch`, `locale/bad-plural`, `locale/bad-locale`.

## Decisions

- **Saves are diffs against authored scenes.** Small files, and scene edits after a save don't
  corrupt it: new authored content appears, and changed fields keep the player's values.
- **Schema'd resources and components only.** Everything saved has a schema, so saves validate,
  migrate, and load through the same code as scenes.
- **Settings are just a persisted resource.** Systems read them like any resource, and changes
  apply live through normal change detection.
- **`Intl` for plurals and numbers.** Every host has it, and CLDR data is too large to ship.

## Acceptance criteria

- [x] Save, change the world, load: the world hash matches the hash at save time, including a
      runtime-spawned prefab and a moved scene entity. A despawned scene entity stays despawned.
      (The hash is id-independent: entities by path, and an instance by its prefab plus
      `currentOverrides`, since a load stores runtime edits to its children as overrides.)
- [x] Adding an entity to the scene file after saving: loading the save shows the new entity and
      keeps the saved changes.
- [x] A component bumped to version 2 with a migration loads a version-1 save correctly.
- [x] Physics bodies resume with their saved velocities (a thrown box keeps flying after load).
- [x] Settings changed at runtime persist across an app restart (Node storage), and a rebinding
      changes which key fires the action.
- [x] Switching locale updates every `UiText` with a key on the next frame. Plurals follow
      `Intl.PluralRules` for `en` and `pt-BR`. `shard validate` lists a key missing in `pt-BR`.
- [x] Browser saves round-trip through IndexedDB in the playground (`#save`: save, reload the
      page, load).

## Open questions

- None blocking.
