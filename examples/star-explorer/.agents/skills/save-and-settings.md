# Save the game, and remember settings

Saves are on in every project (no plugin to add). A save holds only what changed: per loaded
scene, the fields that differ from the scene file and the entities despawned; entities spawned at
runtime (prefab instances as the prefab plus overrides); resources defined with `persist`; named
RNG streams; and time. Loading reloads each scene from its current file, so scene edits made after
a save show up, and the player's changes stay.

```ts
import { loadGame, saveGame } from '@aethervtt/shard-save'

await saveGame(world, 'slot1', { meta: { label: 'Crash site' } })
await loadGame(world, 'slot1') // between frames: from a UI click handler, ready(), or a tool
```

- What's saved: components that serialize, unless defined with `save: false`. Tag an entity
  `save/NoSave` to leave it out (and keep it as it is through a load).
- Resources: `project.resource('Inventory', { schema, persist: true, init })`, where `schema` is a
  `defineSchema` of its fields. Only resources with `persist` go in saves.
- Loot that matches after a load: draw from `world.resource(GlobalRng).stream('star-explorer/loot')`
  (a named stream); saves record every stream's state.
- A component whose fields change gets `version` and `migrate`; old saves migrate on load.
  Migrations see only the saved fields, so handle missing ones.
- Saves go to platform storage: `.shard/user/saves/<slot>.json` for `shard serve` and
  `shard mcp` (tests and `shard run` keep them in memory), IndexedDB in the browser.

Test fixtures: `save_game`, then `save.read` gives the JSON (schema
`.shard/schemas/save.schema.json`). Edit a value and load it with `load_game { json }`:

```ts
const save = await game.saves.read()
save.scenes['scenes/main.scene.json'].changed.ship = { 'star-explorer/Ship': { fuel: 10 } }
await game.saves.load(save)
```

`load_game` returns warnings (`save/stale-entity`) for saved changes whose entity is no longer in
the scene file.

## Settings

```ts
export const Settings = project.settings({
  invertY: t.bool(),
  difficulty: t.enum(['normal', 'easy', 'hard']),
})
```

Settings load before Startup: project defaults from `settings/*.json`
(`{ "star-explorer/Settings": { "difficulty": "easy" } }`), then the player's `settings.json`. Read them
like any resource; plain writes persist within half a second. `setSettings(world, Settings, {...})`
validates and applies at once. `engine/Settings` is built in: `volumes` (bus → volume), `quality`
(shadow map sizes), `locale`, and `bindings`, which `rebindAction(world, '<map>.<action>',
['Key:KeyJ'])` fills in. Agents use `settings.get` and `settings.set`.
