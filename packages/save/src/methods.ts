import { defineSchema, ShardError, t } from '@shard/core'
import type { AppMethod } from '@shard/runtime'
import {
  captureGame,
  describeSave,
  listSaves,
  loadGame,
  readSave,
  saveGame,
  writeSave,
} from './save'
import { allSettings, findSettings, flushSettings, setSettings } from './settings'

const slot = () => t.string({ required: true, description: 'The slot name, e.g. "slot1".' })

function settingsOrThrow(name: string) {
  const def = findSettings(name)
  if (!def) {
    throw new ShardError('save/unknown-settings', `No settings named "${name}"`, {
      hint: `Settings: ${allSettings()
        .map((d) => d.name)
        .join(', ')}.`,
    })
  }
  return def
}

/** Protocol methods for saves and settings (served when the save plugin is on). */
export const saveMethods: AppMethod[] = [
  {
    name: 'save.write',
    description:
      'Saves the game to a slot (what changed in the loaded scenes, runtime entities, persisted resources, RNG streams, time). With json, writes that save instead (an edited fixture).',
    params: defineSchema('protocol/SaveWriteParams', {
      slot: slot(),
      json: t.json({ description: 'A save file to write as is, instead of saving the game.' }),
      meta: t.json({ description: "The game's own data about the slot (a label, the level)." }),
    }),
    handler: async ({ world }, params) => {
      if (params.json !== null && params.json !== undefined) {
        await writeSave(world, params.slot as string, params.json)
        return { slot: params.slot, written: true }
      }
      const file = await saveGame(world, params.slot as string, {
        ...(params.meta !== null ? { meta: params.meta as never } : {}),
      })
      return { slot: params.slot, ...describeSave(file) }
    },
  },
  {
    name: 'save.read',
    description:
      "A slot's save file as JSON, without loading it: read it, edit it, and write it back with save.write { json } to make a test fixture. Without slot: the game as it would save now.",
    params: defineSchema('protocol/SaveReadParams', {
      slot: t.string({ description: 'The slot; empty: capture the running game.' }),
    }),
    handler: async ({ world }, params) =>
      params.slot ? readSave(world, params.slot as string) : captureGame(world),
  },
  {
    name: 'save.load',
    description:
      'Loads a slot: the saved scenes reload from their current files, then the saved changes, spawned entities, resources, RNG streams, and time apply. Returns warnings for parts that no longer match the scenes (save/stale-entity).',
    params: defineSchema('protocol/SaveLoadParams', {
      slot: t.string({ description: 'The slot to load.' }),
      json: t.json({ description: 'A save file to load instead of a slot.' }),
    }),
    handler: async ({ world }, params) => {
      const source =
        params.json !== null && params.json !== undefined
          ? (params.json as never)
          : (params.slot as string)
      if (!source) {
        throw new ShardError('save/not-found', 'Pass a slot or a save json to load', {
          hint: 'save.list shows the saved slots.',
        })
      }
      const report = await loadGame(world, source)
      return { ...report, warnings: report.warnings.map((w) => w.toJSON()) }
    },
  },
  {
    name: 'save.list',
    description: 'Saved slots with their size, time, and meta.',
    params: defineSchema('protocol/SaveListParams', {}),
    handler: async ({ world }) => ({ slots: await listSaves(world) }),
  },
  {
    name: 'save.describe',
    description:
      'What a save holds: bytes, time, meta, per scene the changed entities (and which components) and removed ones, spawned entities by prefab, resources, and RNG streams. Without slot: the running game.',
    params: defineSchema('protocol/SaveDescribeParams', {
      slot: t.string({ description: 'The slot; empty: the game as it would save now.' }),
    }),
    handler: async ({ world }, params) =>
      describeSave(params.slot ? await readSave(world, params.slot as string) : captureGame(world)),
  },
  {
    name: 'settings.get',
    description:
      "Settings resources as JSON (engine/Settings: bus volumes, quality, locale, rebindings; plus the game's own). With name, just that one.",
    params: defineSchema('protocol/SettingsGetParams', {
      name: t.string({ description: 'e.g. "engine/Settings"; empty: all.' }),
    }),
    handler: ({ world }, params) => {
      const defs = params.name ? [settingsOrThrow(params.name as string)] : allSettings()
      const out: Record<string, unknown> = {}
      for (const def of defs) out[def.name] = def.schema.serialize(world.initResource(def) as never)
      return { settings: out }
    },
  },
  {
    name: 'settings.set',
    description:
      "Sets fields of a settings resource and applies them now (volumes, quality, locale, and bindings take effect at once); written to the player's settings.json.",
    params: defineSchema('protocol/SettingsSetParams', {
      name: t.string({ default: 'engine/Settings', description: 'The settings resource.' }),
      values: t.json({ required: true, description: 'Fields to set: { "quality": "low" }.' }),
    }),
    handler: async ({ world }, params) => {
      const def = settingsOrThrow(params.name as string)
      setSettings(world, def, (params.values ?? {}) as Record<string, unknown>)
      await flushSettings(world)
      return { [def.name]: def.schema.serialize(world.resource(def) as never) }
    },
  },
]
