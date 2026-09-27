import { AudioBuses } from '@aethervtt/shard-audio'
import {
  type ComponentDef,
  type ComponentOptions,
  defineResource,
  defineSchema,
  defineSystem,
  type Fields,
  type InferFields,
  isPlainObject,
  type JsonValue,
  pointer,
  type ResourceDef,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { type ActionState, InputQueue } from '@aethervtt/shard-input'
import type { PlatformFileSystem } from '@aethervtt/shard-platform'
import { LightingSettings } from '@aethervtt/shard-render'
import { LogResource, Time } from '@aethervtt/shard-runtime'
import { Locale, setLocale } from '@aethervtt/shard-text'
import { SaveConfig } from './save'

/** A settings resource: plain data with a schema, persisted per user in `settings.json`. */
export interface SettingsDef<F extends Fields = Fields> extends ResourceDef<InferFields<F>> {
  readonly schema: ComponentDef<F>
}

const settingsDefs = new Map<string, SettingsDef>()

/**
 * Defines settings: a schema'd resource the save plugin loads before Startup (project defaults
 * from `settings/*.json`, then the player's `settings.json`) and writes back when it changes.
 * Systems read it like any resource; `setSettings` applies a change at once.
 */
export function defineSettings<const F extends Fields>(
  name: string,
  fields: F,
  options: Pick<ComponentOptions, 'description' | 'version' | 'migrate'> = {},
): SettingsDef<F> {
  const schema = defineSchema(name, fields, options)
  const def = defineResource<InferFields<F>>(name, {
    description: options.description ?? 'Settings, persisted per user.',
    init: () => schema.defaults(),
    schema,
  }) as SettingsDef<F>
  settingsDefs.set(name, def as unknown as SettingsDef)
  return def
}

/** Every settings definition in this process, by name. */
export function allSettings(): SettingsDef[] {
  return [...settingsDefs.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function findSettings(name: string): SettingsDef | undefined {
  return settingsDefs.get(name)
}

export const QUALITY_LEVELS = ['medium', 'low', 'high'] as const

/** Shadow map sizes per quality level: [cascades, spot and point lights]. */
const SHADOWS: Record<(typeof QUALITY_LEVELS)[number], [number, number]> = {
  low: [1024, 512],
  medium: [2048, 1024],
  high: [4096, 2048],
}

/** The engine's own settings: volumes, quality, language, and key rebindings. */
export const EngineSettings = defineSettings(
  'engine/Settings',
  {
    volumes: t.json({
      default: {},
      description:
        'Bus volumes by name (audio/Buses), linear: { "master": 0.8, "music": 0.5 }. Buses not listed keep the volume the game gave them.',
    }),
    quality: t.enum(QUALITY_LEVELS, {
      description:
        'Graphics quality: shadow map sizes (low 1024/512, medium 2048/1024, high 4096/2048).',
    }),
    locale: t.string({
      description:
        'The player\'s language (a BCP 47 tag like "pt-BR"). Empty: the game\'s default. Follows setLocale.',
    }),
    bindings: t.json({
      default: {},
      description:
        'Rebindings over the authored action maps: { "<map>": { "<action>": ["Key:KeyJ"] } }. Follows rebindAction.',
    }),
  },
  {
    description: 'Engine settings: bus volumes, graphics quality, language, and input rebindings.',
  },
)

// --- state -----------------------------------------------------------------------------------------

interface SettingsStateValue {
  /** The JSON last written to (or read from) storage. */
  persisted: string
  /** App time of the last check for changes. */
  checkedAt: number
  /** A write in flight, so `flushSettings` can wait for it. */
  writing: Promise<void> | undefined
  /** What the engine settings last applied, to act only on changes. */
  volumes: Map<string, number>
  quality: string
  locale: string
  /** Locale.current as last seen, to notice setLocale calls. */
  seenLocale: string
  bindingsText: string
  /** Each action map's version when its bindings last matched the settings. */
  maps: WeakMap<ActionState<string>, number>
}

export const SettingsState = defineResource<SettingsStateValue>('save/SettingsState', {
  description: 'Settings persistence: what was last written and applied.',
  init: () => ({
    persisted: '',
    checkedAt: 0,
    writing: undefined,
    volumes: new Map(),
    quality: '',
    locale: '',
    seenLocale: '',
    bindingsText: '{}',
    maps: new WeakMap(),
  }),
})

const SETTINGS_KEY = 'settings.json'
const SETTINGS_VERSION = 1
const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface SettingsFile {
  version: number
  schemas: Record<string, number>
  values: Record<string, JsonValue>
}

function settingsJson(world: World): SettingsFile {
  const values: Record<string, JsonValue> = {}
  const schemas: Record<string, number> = {}
  for (const def of allSettings()) {
    const value = world.tryResource(def)
    if (value === undefined) continue
    values[def.name] = def.schema.serialize(value as never)
    schemas[def.name] = def.schema.version
  }
  return { version: SETTINGS_VERSION, schemas, values }
}

/**
 * Sets fields in a settings resource from JSON (validated field by field) and applies them now;
 * they're written to storage within half a second. Throws the first invalid field.
 */
export function setSettings(world: World, def: SettingsDef, values: Record<string, unknown>): void {
  const value = world.initResource(def) as Record<string, unknown>
  const errors: ShardError[] = []
  const converted: Record<string, unknown> = {}
  for (const [name, json] of Object.entries(values)) {
    const field = def.schema.fields[name]
    if (!field) {
      errors.push(
        new ShardError('schema/unknown-field', `"${def.name}" has no setting "${name}"`, {
          path: pointer('', name),
          hint: `Settings: ${Object.keys(def.schema.fields).join(', ')}.`,
        }),
      )
      continue
    }
    field.validate(json, pointer('', name), errors, undefined)
    if (errors.length === 0) converted[name] = field.fromJson(json, undefined)
  }
  if (errors.length > 0) throw errors[0]
  Object.assign(value, converted)
  applyEngineSettings(world, true)
}

/** Copies known, valid fields of `json` into `target`, reporting the rest. */
function mergeInto(
  def: SettingsDef,
  target: Record<string, unknown>,
  json: unknown,
  from: string,
  warn: (e: ShardError) => void,
): void {
  if (!isPlainObject(json)) {
    warn(new ShardError('schema/type-mismatch', `${from}: "${def.name}" must be an object`))
    return
  }
  for (const [name, value] of Object.entries(json)) {
    const field = def.schema.fields[name]
    if (!field) {
      warn(new ShardError('save/stale-field', `${from}: "${def.name}" has no setting "${name}"`))
      continue
    }
    const errors: ShardError[] = []
    field.validate(value, pointer('', name), errors, undefined)
    if (errors.length > 0) {
      warn(new ShardError(errors[0]!.code, `${from} ${def.name}: ${errors[0]!.message}`))
      continue
    }
    target[name] = field.fromJson(value, undefined)
  }
}

/**
 * Reads project defaults (`settings/*.json`: `{ "<settings name>": { fields } }`) and then the
 * player's `settings.json` into every settings resource. The save plugin calls it before Startup.
 */
export async function loadSettings(
  world: World,
  options: { fs?: PlatformFileSystem } = {},
): Promise<void> {
  const log = world.tryResource(LogResource)
  const warn = (e: ShardError) => log?.log('warn', e.message, { code: e.code, hint: e.hint })
  const state = world.initResource(SettingsState)
  for (const def of allSettings()) world.initResource(def)

  const layers: [string, unknown][] = []
  const fs = options.fs
  if (fs) {
    let files: string[] = []
    if (fs.list) {
      files = (await fs.list('settings'))
        .filter((e) => e.kind === 'file' && e.name.endsWith('.json'))
        .map((e) => `settings/${e.name}`)
        .sort()
    } else if (await fs.exists('settings/defaults.json').catch(() => false)) {
      files = ['settings/defaults.json']
    }
    for (const file of files) {
      try {
        layers.push([file, JSON.parse(await fs.readText(file))])
      } catch (err) {
        warn(new ShardError('save/invalid-settings', `${file}: ${(err as Error).message}`))
      }
    }
  }
  const stored = await world.resource(SaveConfig).storage.read(SETTINGS_KEY)
  let schemas: Record<string, number> = {}
  if (stored) {
    try {
      const json = JSON.parse(decoder.decode(stored)) as Partial<SettingsFile>
      schemas = json.schemas ?? {}
      layers.push([SETTINGS_KEY, json.values ?? {}])
    } catch (err) {
      warn(new ShardError('save/invalid-settings', `settings.json: ${(err as Error).message}`))
    }
  }
  for (const [from, layer] of layers) {
    if (!isPlainObject(layer)) continue
    for (const [name, json] of Object.entries(layer)) {
      const def = findSettings(name)
      if (!def) {
        warn(new ShardError('save/unknown-settings', `${from}: no settings named "${name}"`))
        continue
      }
      let upgraded: unknown = json
      if (from === SETTINGS_KEY) {
        try {
          upgraded = def.schema.upgrade(json, schemas[name] ?? def.schema.version)
        } catch (err) {
          warn(err as ShardError)
          continue
        }
      }
      mergeInto(def, world.resource(def) as Record<string, unknown>, upgraded, from, warn)
    }
  }
  // The locale as the game set it: settings follow later changes, not the default.
  state.seenLocale = world.tryResource(Locale)?.current ?? ''
  applyEngineSettings(world, true)
  state.persisted = stored ? JSON.stringify(settingsJson(world)) : ''
}

/** Writes settings to storage now if they changed (waits for a write in flight). */
export async function flushSettings(world: World): Promise<void> {
  const state = world.initResource(SettingsState)
  await state.writing
  persist(world, state)
  await state.writing
}

function persist(world: World, state: SettingsStateValue): void {
  const file = settingsJson(world)
  const text = JSON.stringify(file)
  if (text === state.persisted) return
  state.persisted = text
  const storage = world.resource(SaveConfig).storage
  const previous = state.writing ?? Promise.resolve()
  state.writing = previous
    .then(() => storage.write(SETTINGS_KEY, encoder.encode(`${JSON.stringify(file, null, 2)}\n`)))
    .catch((err) => void world.tryResource(LogResource)?.error(err))
}

/**
 * Applies engine settings that changed since the last call (volumes, quality, locale, bindings),
 * and records the other way round what the game changed directly (setLocale, rebindAction).
 */
export function applyEngineSettings(world: World, force = false): void {
  const settings = world.tryResource(EngineSettings)
  const state = world.tryResource(SettingsState)
  if (!settings || !state) return
  const buses = world.tryResource(AudioBuses)
  const volumes = settings.volumes
  if (buses && isPlainObject(volumes)) {
    for (const bus in volumes) {
      const v = volumes[bus]
      if (typeof v !== 'number' || state.volumes.get(bus) === v) continue
      state.volumes.set(bus, v)
      const b = buses[bus]
      if (b) b.volume = Math.max(0, v)
    }
  }
  if (settings.quality !== state.quality) {
    state.quality = settings.quality
    const lighting = world.tryResource(LightingSettings)
    const sizes = SHADOWS[settings.quality]
    if (lighting && sizes) {
      lighting.cascadeMapSize = sizes[0]
      lighting.shadowMapSize = sizes[1]
    }
  }
  const locale = world.tryResource(Locale)
  if (locale) {
    if (settings.locale !== state.locale) {
      state.locale = settings.locale
      if (settings.locale !== '') {
        try {
          setLocale(world, settings.locale)
        } catch (err) {
          world.tryResource(LogResource)?.error(err)
        }
      }
      state.seenLocale = locale.current
    } else if (locale.current !== state.seenLocale) {
      // The game switched language itself: remember it.
      state.seenLocale = locale.current
      settings.locale = locale.current
      state.locale = locale.current
    }
  }
  const queue = world.tryResource(InputQueue)
  if (!queue) return
  const bindings = isPlainObject(settings.bindings) ? settings.bindings : {}
  if (force) {
    const text = JSON.stringify(bindings)
    if (text !== state.bindingsText) {
      state.bindingsText = text
      state.maps = new WeakMap()
    }
  }
  for (let i = 0; i < queue.maps.length; i++) {
    const map = queue.maps[i]!
    const seen = state.maps.get(map)
    if (seen === undefined) {
      applyBindings(world, map, bindings[map.name])
      state.maps.set(map, map.version)
    } else if (seen !== map.version) {
      // Rebound by the game (rebindAction): keep it in the settings.
      const rebound = map.rebindings()
      const next = { ...bindings }
      if (Object.keys(rebound).length > 0) next[map.name] = rebound as JsonValue
      else delete next[map.name]
      settings.bindings = next as JsonValue
      state.bindingsText = JSON.stringify(next)
      state.maps.set(map, map.version)
    }
  }
}

function applyBindings(world: World, map: ActionState<string>, overrides: unknown): void {
  const own = isPlainObject(overrides) ? overrides : {}
  for (const action of map.actions()) {
    const bindings = own[action]
    try {
      map.rebind(action, Array.isArray(bindings) ? (bindings as never) : undefined)
    } catch (err) {
      world.tryResource(LogResource)?.error(err)
    }
  }
}

/**
 * Applies engine settings as they change, and writes every settings resource to storage (checked
 * twice a second, so a slider drag writes a handful of times, not every frame).
 */
export const settingsSystem = defineSystem({
  name: 'save/settings',
  description: 'Applies engine settings live and persists changed settings.',
  run: (_, world) => {
    const state = world.resource(SettingsState)
    applyEngineSettings(world)
    const now = world.tryResource(Time)?.elapsed ?? 0
    if (now - state.checkedAt < 0.5) return
    state.checkedAt = now
    applyEngineSettings(world, true)
    persist(world, state)
  },
})
