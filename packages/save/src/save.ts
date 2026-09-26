import { assetServer } from '@shard/assets'
import {
  type AnyField,
  allResources,
  ChildOf,
  type ComponentDef,
  Derived,
  defineResource,
  defineTag,
  type Entity,
  type Fields,
  findComponent,
  findResource,
  isPlainObject,
  type JsonValue,
  pointer,
  ShardError,
  type World,
} from '@shard/core'
import { createMemoryStorage, type KeyValueStorage } from '@shard/platform'
import { AppControlResource, FixedTime, GlobalRng, LogResource, Time } from '@shard/runtime'
import {
  currentOverrides,
  findEntityByPath,
  InstancePart,
  instanceEntities,
  instanceKindOf,
  loadPrefab,
  loadScene,
  type Overrides,
  PrefabInstance,
  prefabRootComponents,
  SceneIndex,
  SceneMember,
  spawnPrefab,
  unloadScene,
  updateInstances,
  whenSceneReady,
  worldSchemaContext,
} from '@shard/scene'
import { SAVE_VERSION, type SavedEntity, type SavedScene, type SaveFile } from './format'

export const NoSave = defineTag('save/NoSave', {
  description:
    "Leaves the entity out of saved games: loading keeps it as it is (debug helpers, the session's camera rig).",
})

export interface SaveConfigValue {
  /** Where saves and settings go (`platform.storage`). */
  storage: KeyValueStorage
  /** Reads a scene file by id (its path) when a save loads. */
  readScene: ((id: string) => Promise<unknown>) | undefined
  /** Written into saves as `engine`. */
  engine: string
}

export const SaveConfig = defineResource<SaveConfigValue>('save/Config', {
  description: 'Where saves are stored and how scene files are read on load.',
  init: () => ({ storage: createMemoryStorage(), readScene: undefined, engine: '0.x' }),
})

const SLOT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** The storage key of a slot: `saves/<slot>.json`. */
export function slotKey(slot: string): string {
  if (!SLOT.test(slot)) {
    throw new ShardError('save/bad-slot', `"${slot}" isn't a slot name`, {
      hint: 'Slots are letters, digits, "-", and "_" (e.g. "slot1", "autosave").',
    })
  }
  return `saves/${slot}.json`
}

// --- what gets saved -----------------------------------------------------------------------------

/** Components a save writes for an entity: serializable, not `save: false`, not bookkeeping. */
function isSaved(def: ComponentDef): boolean {
  return def.saved && def !== ChildOf && def !== SceneMember && def !== InstancePart
}

function savedComponents(
  world: World,
  entity: Entity,
): Map<ComponentDef, Record<string, JsonValue>> {
  const out = new Map<ComponentDef, Record<string, JsonValue>>()
  for (const def of world.componentsOf(entity)) {
    if (isSaved(def)) out.set(def, def.serialize(world.get(entity, def)))
  }
  return out
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function parentPath(path: string): string | undefined {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? undefined : path.slice(0, slash)
}

/** Runtime entities a save writes in full: not from a scene file, not generated, not NoSave. */
function isRuntimeSaved(world: World, entity: Entity, authored: Set<Entity>): boolean {
  if (authored.has(entity)) return false
  const components = world.componentsOf(entity)
  let saved = false
  for (const def of components) {
    if (def === InstancePart || def === NoSave || def === Derived) return false
    if (isSaved(def)) saved = true
  }
  return saved
}

function authoredEntities(world: World): Set<Entity> {
  const out = new Set<Entity>()
  for (const scene of world.tryResource(SceneIndex)?.values() ?? []) {
    for (const e of scene.authored.keys()) out.add(e)
  }
  return out
}

/** Runtime saved entities, parents before children. */
function runtimeEntities(world: World, authored: Set<Entity>): Entity[] {
  const out: Entity[] = []
  for (const table of world.allTables()) {
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]! as Entity
      if (isRuntimeSaved(world, e, authored)) out.push(e)
    }
  }
  // Only runtime parents need to come first: scene entities exist before any of these spawn.
  const saved = new Set(out)
  const depth = new Map<Entity, number>()
  const depthOf = (e: Entity): number => {
    let d = depth.get(e)
    if (d !== undefined) return d
    const parent = world.tryGet(e, ChildOf)?.parent
    d = parent === null || parent === undefined || !saved.has(parent) ? 0 : depthOf(parent) + 1
    depth.set(e, d)
    return d
  }
  return out.sort((a, b) => depthOf(a) - depthOf(b))
}

// --- entity references ---------------------------------------------------------------------------

/** Rewrites every entity value inside a component's JSON through `map` (lists and structs too). */
function mapEntities(
  fields: Fields,
  json: Record<string, JsonValue>,
  map: (value: JsonValue, at: string) => JsonValue,
  at = '',
): void {
  for (const name of Object.keys(json)) {
    const field = fields[name]
    if (field) json[name] = mapValue(field, json[name]!, map, pointer(at, name))
  }
}

function mapValue(
  field: AnyField,
  value: JsonValue,
  map: (value: JsonValue, at: string) => JsonValue,
  at: string,
): JsonValue {
  if (field.kind === 'entity') return map(value, at)
  if (field.kind === 'list' && field.item && Array.isArray(value)) {
    const item = field.item
    if (item.kind !== 'entity' && item.kind !== 'struct' && item.kind !== 'list') return value
    return value.map((v, i) => mapValue(item, v, map, pointer(at, i)))
  }
  if (field.kind === 'struct' && field.fields && isPlainObject(value)) {
    mapEntities(field.fields, value as Record<string, JsonValue>, map, at)
  }
  return value
}

function hasEntityFields(fields: Fields): boolean {
  for (const f of Object.values(fields)) {
    if (f.kind === 'entity') return true
    if (f.kind === 'list' && f.item && (f.item.kind === 'entity' || f.item.kind === 'struct'))
      return true
    if (f.kind === 'struct' && f.fields && hasEntityFields(f.fields)) return true
  }
  return false
}

// --- capture -------------------------------------------------------------------------------------

export interface CaptureOptions {
  /** The game's own data about the slot. */
  meta?: JsonValue
}

/**
 * The world as a save: what changed in each loaded scene, runtime entities, persisted resources,
 * RNG streams, and time. Synchronous, so a system can call it mid-frame.
 */
export function captureGame(world: World, options: CaptureOptions = {}): SaveFile {
  const index = world.tryResource(SceneIndex)
  const authored = authoredEntities(world)
  const runtime = runtimeEntities(world, authored)
  const saveId = new Map<Entity, string>()
  for (let i = 0; i < runtime.length; i++) saveId.set(runtime[i]!, `@${i}`)
  const schemas: Record<string, number> = {}
  const scenesLoaded = index?.size ?? 0

  const refOf = (e: Entity): string | null => {
    if (!world.isAlive(e)) return null
    const id = saveId.get(e)
    if (id) return id
    const member = world.tryGet(e, SceneMember)
    if (member && authored.has(e)) {
      return scenesLoaded > 1 && findEntityByPath(world, member.path) !== e
        ? `${member.scene}:${member.path}`
        : member.path
    }
    const part = world.tryGet(e, InstancePart)
    if (part?.instance !== null && part?.instance !== undefined) {
      const base = refOf(part.instance)
      return base === null ? null : `${base}/${part.path}`
    }
    return null
  }
  const refs = (def: ComponentDef, json: Record<string, JsonValue>) => {
    if (hasEntityFields(def.fields))
      mapEntities(def.fields, json, (v) => (typeof v === 'number' ? refOf(v) : v))
    return json
  }
  const note = (def: ComponentDef) => {
    schemas[def.name] = def.version
  }

  const scenes: Record<string, SavedScene> = {}
  for (const [id, scene] of index ?? []) {
    const changed: SavedScene['changed'] = {}
    const removed: string[] = []
    const gone = new Set<string>()
    for (const path of scene.order) {
      const entity = scene.entities.get(path)!
      const parent = parentPath(path)
      if (!world.isAlive(entity) || !authored.has(entity)) {
        gone.add(path)
        if (parent === undefined || !gone.has(parent)) removed.push(path)
        continue
      }
      if (world.has(entity, NoSave)) continue
      const loaded = scene.loaded.get(entity) ?? new Map()
      const now = savedComponents(world, entity)
      const out: Record<string, Record<string, JsonValue> | null> = {}
      for (const [def, value] of now) {
        // An instance's generated entities aren't saved: what changed in them becomes overrides.
        if (instanceKindOf(def))
          value.overrides = (currentOverrides(world, entity) ?? value.overrides) as JsonValue
        const before = loaded.get(def.name)
        if (!before) {
          out[def.name] = refs(def, value)
          note(def)
          continue
        }
        const fields: Record<string, JsonValue> = {}
        for (const field of Object.keys(value)) {
          if (!same(value[field], before[field])) fields[field] = value[field]!
        }
        if (Object.keys(fields).length === 0) continue
        out[def.name] = refs(def, fields)
        note(def)
      }
      for (const name of loaded.keys()) {
        const def = findComponent(name)
        if (def && isSaved(def) && !now.has(def)) out[name] = null
      }
      const expected = parent === undefined ? null : (scene.entities.get(parent) ?? null)
      const actual = world.tryGet(entity, ChildOf)?.parent ?? null
      if (actual !== expected)
        out[ChildOf.name] = { parent: actual === null ? null : refOf(actual) }
      if (Object.keys(out).length > 0) changed[path] = out
    }
    scenes[id] = { changed, removed }
  }

  const spawned: SavedEntity[] = []
  for (const entity of runtime) {
    const entry: SavedEntity = { id: saveId.get(entity)!, components: {} }
    const parent = world.tryGet(entity, ChildOf)?.parent
    if (parent !== null && parent !== undefined) {
      const ref = refOf(parent)
      if (ref !== null) entry.parent = ref
    }
    const instance = world.tryGet(entity, PrefabInstance)
    if (instance?.prefab) {
      entry.prefab = {}
      if (instance.prefab.guid !== undefined) entry.prefab.guid = instance.prefab.guid
      if (instance.prefab.path !== undefined) entry.prefab.path = instance.prefab.path
      const overrides = currentOverrides(world, entity) ?? (instance.overrides as Overrides)
      if (Object.keys(overrides ?? {}).length > 0) entry.overrides = overrides
    }
    // A prefab instance writes what differs from its prefab's root; others write everything.
    const base = entry.prefab ? prefabRootComponents(world, entity) : undefined
    const now = savedComponents(world, entity)
    for (const [def, value] of now) {
      if (def === PrefabInstance && entry.prefab) continue
      const before = base?.get(def.name)
      if (!before) {
        entry.components[def.name] = refs(def, value)
        note(def)
        continue
      }
      const fields: Record<string, JsonValue> = {}
      for (const field of Object.keys(value)) {
        if (!same(value[field], before[field])) fields[field] = value[field]!
      }
      if (Object.keys(fields).length === 0) continue
      entry.components[def.name] = refs(def, fields)
      note(def)
    }
    for (const name of base?.keys() ?? []) {
      const def = findComponent(name)
      if (def && isSaved(def) && !now.has(def)) entry.components[name] = null
    }
    spawned.push(entry)
  }

  const resources: Record<string, JsonValue> = {}
  for (const def of allResources()) {
    if (!def.persist || !def.schema || !world.hasResource(def)) continue
    resources[def.name] = def.schema.serialize(world.resource(def) as never)
    schemas[def.name] = def.schema.version
  }

  const rng: Record<string, number[]> = {}
  const global = world.tryResource(GlobalRng)
  if (global) {
    rng[GlobalRng.name] = global.getState()
    for (const [label, stream] of global.streams()) rng[label] = stream.getState()
  }

  const time = world.tryResource(Time)
  const fixed = world.tryResource(FixedTime)
  const file: SaveFile = {
    version: SAVE_VERSION,
    engine: world.tryResource(SaveConfig)?.engine ?? '0.x',
    schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
    time: {
      elapsed: time?.elapsed ?? 0,
      frame: time?.frame ?? 0,
      ...(fixed ? { fixedElapsed: fixed.elapsed } : {}),
    },
    scenes,
    spawned,
    resources,
    rng,
  }
  if (options.meta !== undefined) file.meta = options.meta
  return file
}

// --- storage ---------------------------------------------------------------------------------------

function config(world: World): SaveConfigValue {
  return world.initResource(SaveConfig)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Saves as written to storage: 2-space JSON, trailing newline. */
export function stringifySave(file: SaveFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/** Captures the game and writes it to a slot. Returns the save. */
export async function saveGame(
  world: World,
  slot: string,
  options: CaptureOptions = {},
): Promise<SaveFile> {
  const key = slotKey(slot)
  const file = captureGame(world, options)
  await config(world).storage.write(key, encoder.encode(stringifySave(file)))
  return file
}

/** Writes a save (for example one an agent edited) to a slot, after checking its shape. */
export async function writeSave(world: World, slot: string, file: unknown): Promise<void> {
  const errors = validateSave(file)
  if (errors.length > 0) throw invalid(slot, errors)
  await config(world).storage.write(slotKey(slot), encoder.encode(stringifySave(file as SaveFile)))
}

/** Reads a slot's save without loading it. Throws `save/not-found` for an empty slot. */
export async function readSave(world: World, slot: string): Promise<SaveFile> {
  const bytes = await config(world).storage.read(slotKey(slot))
  if (!bytes) {
    const slots = await listSaves(world)
    throw new ShardError('save/not-found', `No save in slot "${slot}"`, {
      hint:
        slots.length > 0
          ? `Saved slots: ${slots.map((s) => s.slot).join(', ')}.`
          : 'Nothing has been saved yet.',
    })
  }
  let json: unknown
  try {
    json = JSON.parse(decoder.decode(bytes))
  } catch (cause) {
    throw new ShardError('save/invalid', `Slot "${slot}" isn't valid JSON`, { cause })
  }
  const errors = validateSave(json)
  if (errors.length > 0) throw invalid(slot, errors)
  return json as SaveFile
}

export interface SaveSlotInfo {
  slot: string
  bytes: number
  time: SaveFile['time'] | undefined
  meta: JsonValue | undefined
}

/** Every saved slot with its size, time, and meta, sorted by name. */
export async function listSaves(world: World): Promise<SaveSlotInfo[]> {
  const storage = config(world).storage
  const out: SaveSlotInfo[] = []
  for (const key of await storage.list('saves/')) {
    if (!key.endsWith('.json')) continue
    const slot = key.slice('saves/'.length, -'.json'.length)
    if (!SLOT.test(slot)) continue
    const bytes = await storage.read(key)
    let file: Partial<SaveFile> | undefined
    try {
      file = bytes ? (JSON.parse(decoder.decode(bytes)) as Partial<SaveFile>) : undefined
    } catch {
      file = undefined
    }
    out.push({ slot, bytes: bytes?.length ?? 0, time: file?.time, meta: file?.meta })
  }
  return out
}

export async function deleteSave(world: World, slot: string): Promise<void> {
  await config(world).storage.delete(slotKey(slot))
}

function invalid(slot: string, errors: ShardError[]): ShardError {
  return new ShardError(
    errors[0]!.code,
    `Slot "${slot}" has ${errors.length} problem${errors.length === 1 ? '' : 's'}; first: ${errors[0]!.message}`,
    { path: errors[0]!.path, hint: errors[0]!.hint, details: errors },
  )
}

/** Every problem with a save's shape (component values are checked when it loads). */
export function validateSave(json: unknown): ShardError[] {
  const errors: ShardError[] = []
  const bad = (path: string, message: string, hint?: string) =>
    errors.push(new ShardError('save/invalid', message, { path, hint }))
  if (!isPlainObject(json)) {
    bad('', 'A save must be a JSON object')
    return errors
  }
  if (typeof json.version !== 'number' || json.version > SAVE_VERSION || json.version < 1) {
    errors.push(
      new ShardError(
        'save/version-mismatch',
        `Save format version ${JSON.stringify(json.version)} isn't supported (this build reads ${SAVE_VERSION})`,
        {
          path: '/version',
          hint:
            typeof json.version === 'number' && json.version > SAVE_VERSION
              ? 'The save was written by a newer build of the game.'
              : `Use "version": ${SAVE_VERSION}.`,
        },
      ),
    )
  }
  if (!isPlainObject(json.scenes)) bad('/scenes', '"scenes" must be an object')
  else {
    for (const [id, scene] of Object.entries(json.scenes)) {
      const at = pointer('/scenes', id)
      if (!isPlainObject(scene)) bad(at, `Scene "${id}" must be an object`)
      else {
        if (scene.changed !== undefined && !isPlainObject(scene.changed))
          bad(`${at}/changed`, '"changed" must be an object of scene paths')
        if (scene.removed !== undefined && !Array.isArray(scene.removed))
          bad(`${at}/removed`, '"removed" must be an array of scene paths')
      }
    }
  }
  if (!Array.isArray(json.spawned)) bad('/spawned', '"spawned" must be an array')
  else {
    json.spawned.forEach((e: unknown, i) => {
      const at = `/spawned/${i}`
      if (!isPlainObject(e)) {
        bad(at, 'A spawned entity must be an object')
        return
      }
      if (typeof e.id !== 'string' || !/^@\d+$/.test(e.id))
        bad(`${at}/id`, 'A spawned entity needs an id like "@3"')
      if (!isPlainObject(e.components)) bad(`${at}/components`, '"components" must be an object')
    })
  }
  for (const key of ['resources', 'rng', 'schemas'] as const) {
    if (json[key] !== undefined && !isPlainObject(json[key]))
      bad(`/${key}`, `"${key}" must be an object`)
  }
  return errors
}

// --- load ------------------------------------------------------------------------------------------

export interface LoadReport {
  scenes: string[]
  /** Runtime entities spawned from the save. */
  spawned: number
  /** Parts of the save that no longer apply (`save/stale-entity`, unknown components, bad values). */
  warnings: ShardError[]
}

async function readSceneFile(world: World, id: string): Promise<unknown> {
  const read = config(world).readScene
  if (read) {
    try {
      return await read(id)
    } catch (err) {
      const loaded = world.tryResource(SceneIndex)?.get(id)
      if (loaded) return loaded.file
      throw new ShardError('save/missing-scene', `The save's scene "${id}" can't be read`, {
        hint: 'The scene file was moved or deleted since the save was made.',
        cause: err,
      })
    }
  }
  const loaded = world.tryResource(SceneIndex)?.get(id)
  if (loaded) return loaded.file
  throw new ShardError('save/missing-scene', `The save's scene "${id}" isn't loaded`, {
    hint: 'Without a platform, saves can only reload scenes that are loaded now.',
  })
}

/**
 * Loads a save: unloads the current scenes and runtime entities, loads each saved scene file fresh
 * (its current version), applies the saved changes and removals, spawns the saved entities, and
 * restores resources, RNG streams, and time. Resolves once the scenes' assets and instances are
 * ready. Parts that no longer match the scenes are skipped and reported as warnings.
 */
export async function loadGame(world: World, slot: string | SaveFile): Promise<LoadReport> {
  let file: SaveFile
  if (typeof slot === 'string') file = await readSave(world, slot)
  else {
    const errors = validateSave(slot)
    if (errors.length > 0) throw invalid('(file)', errors)
    file = slot
  }
  const warnings: ShardError[] = []
  const warn = (error: ShardError) => warnings.push(error)

  // Everything that can fail or wait happens before the world changes.
  const sceneIds = Object.keys(file.scenes)
  const sceneFiles = new Map<string, unknown>()
  for (const id of sceneIds) sceneFiles.set(id, await readSceneFile(world, id))
  const usable = new Set<SavedEntity>()
  for (const entry of file.spawned) {
    if (!entry.prefab) {
      usable.add(entry)
      continue
    }
    try {
      await loadPrefab(world, entry.prefab)
      usable.add(entry)
    } catch (err) {
      const e = err instanceof ShardError ? err : undefined
      warn(
        new ShardError(
          'save/stale-entity',
          `Spawned ${entry.id} is an instance of ${entry.prefab.path ?? entry.prefab.guid}, which can't load: ${e?.message ?? err}`,
          {
            path: `/spawned/${file.spawned.indexOf(entry)}`,
            hint: 'The prefab was moved or deleted since the save was made.',
          },
        ),
      )
    }
  }

  // No frame runs on a half-loaded world: the app pauses until the load is done.
  const control = world.tryResource(AppControlResource)
  const wasPaused = control?.paused ?? false
  if (control) control.paused = true
  const ids = new Map<string, Entity>()
  try {
    // Out with the current game.
    const authored = authoredEntities(world)
    for (const e of runtimeEntities(world, authored)) if (world.isAlive(e)) world.despawn(e)
    for (const id of [...(world.tryResource(SceneIndex)?.keys() ?? [])])
      unloadScene(world, id, { collect: false })
    for (const id of sceneIds) loadScene(world, sceneFiles.get(id), { id })
    for (const id of sceneIds) await whenSceneReady(world, id)

    // Runtime entities first, so references to them resolve.
    const resolveRef = (ref: JsonValue, at: string): JsonValue => {
      if (ref === null || typeof ref !== 'string') return null
      const e = resolveEntity(world, ids, ref)
      if (e === undefined) {
        warn(
          new ShardError('save/stale-entity', `No entity "${ref}" to point at`, {
            path: at,
            hint: 'The entity was renamed or deleted in the scene file since the save was made; the field is null.',
          }),
        )
        return null
      }
      return e
    }
    const plain: [SavedEntity, Entity][] = []
    for (const entry of file.spawned) {
      if (!usable.has(entry)) continue
      if (!entry.prefab) {
        // Alive (and empty) now, so instances can be parented under it; components come next.
        const e = world.spawn()
        ids.set(entry.id, e)
        plain.push([entry, e])
      }
    }
    const instances: [SavedEntity, Entity][] = []
    file.spawned.forEach((entry, i) => {
      if (!usable.has(entry) || !entry.prefab) return
      const parent =
        entry.parent === undefined ? undefined : resolveRef(entry.parent, `/spawned/${i}/parent`)
      const e = spawnPrefab(world, entry.prefab, {
        ...(typeof parent === 'number' ? { parent } : {}),
        ...(entry.overrides ? { overrides: entry.overrides } : {}),
      })
      ids.set(entry.id, e)
      instances.push([entry, e])
    })

    const upgrade = (def: ComponentDef, json: Record<string, JsonValue>, at: string) => {
      const from = file.schemas?.[def.name] ?? def.version
      try {
        return def.upgrade(json, from) as Record<string, JsonValue>
      } catch (err) {
        warn(asWarning(err, at))
        return undefined
      }
    }
    const ctx = worldSchemaContext(world)
    /** Converts saved fields to values: references resolved, each field validated on its own. */
    const valuesOf = (def: ComponentDef, raw: Record<string, JsonValue>, at: string) => {
      const json = upgrade(def, structuredClone(raw), at)
      if (!json || !isPlainObject(json)) return undefined
      if (hasEntityFields(def.fields)) mapEntities(def.fields, json, resolveRef, at)
      const out: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(json)) {
        const field = def.fields[name]
        const here = pointer(at, name)
        if (!field) {
          warn(
            new ShardError('save/stale-field', `"${def.name}" has no field "${name}" any more`, {
              path: here,
              hint: 'Give the component a version and a migrate that renames or drops the field.',
            }),
          )
          continue
        }
        const errors: ShardError[] = []
        field.validate(value, here, errors, ctx)
        if (errors.length > 0) {
          warnings.push(errors[0]!)
          continue
        }
        out[name] = field.fromJson(value, ctx)
      }
      return out
    }
    const componentDef = (name: string, at: string) => {
      const def = findComponent(name)
      if (!def) {
        warn(
          new ShardError('save/unknown-component', `No component "${name}" any more`, {
            path: at,
            hint: 'The component was renamed or removed from the code; its saved data is skipped.',
          }),
        )
      }
      return def
    }

    for (const [entry, e] of plain) {
      const index = file.spawned.indexOf(entry)
      for (const [name, raw] of Object.entries(entry.components)) {
        const at = pointer(`/spawned/${index}/components`, name)
        const def = componentDef(name, at)
        const value = def && raw && valuesOf(def, raw, at)
        if (def && value) world.add(e, def, value)
      }
    }
    for (const [entry, e] of plain) {
      if (entry.parent === undefined) continue
      const parent = resolveRef(entry.parent, `/spawned/${file.spawned.indexOf(entry)}/parent`)
      if (typeof parent === 'number') world.add(e, ChildOf, { parent })
    }
    for (const [entry, e] of instances) {
      const index = file.spawned.indexOf(entry)
      for (const [name, raw] of Object.entries(entry.components)) {
        const at = pointer(`/spawned/${index}/components`, name)
        const def = componentDef(name, at)
        if (!def) continue
        if (raw === null) {
          world.remove(e, def)
          continue
        }
        const value = valuesOf(def, raw, at)
        if (!value) continue
        if (world.has(e, def)) world.set(e, def, value)
        else world.add(e, def, value)
      }
    }

    // Then what changed in the scenes.
    const index = world.resource(SceneIndex)
    for (const id of sceneIds) {
      const saved = file.scenes[id]!
      const scene = index.get(id)!
      const base = pointer('/scenes', id)
      for (const path of saved.removed ?? []) {
        const e = scene.entities.get(path)
        if (e === undefined || !world.isAlive(e)) {
          warn(
            new ShardError(
              'save/stale-entity',
              `Removed entity "${path}" isn't in ${id} any more`,
              {
                path: `${base}/removed`,
              },
            ),
          )
          continue
        }
        world.despawn(e)
      }
      for (const [path, components] of Object.entries(saved.changed ?? {})) {
        const at = pointer(`${base}/changed`, path)
        const e = scene.entities.get(path)
        if (e === undefined || !world.isAlive(e)) {
          warn(
            new ShardError(
              'save/stale-entity',
              `"${path}" isn't in ${id} any more; its saved changes are skipped`,
              {
                path: at,
                hint: 'The entity was renamed or deleted in the scene file since the save was made.',
              },
            ),
          )
          continue
        }
        for (const [name, raw] of Object.entries(components)) {
          const here = pointer(at, name)
          if (name === ChildOf.name) {
            const parent =
              raw === null ? null : resolveRef(raw.parent ?? null, pointer(here, 'parent'))
            if (typeof parent === 'number') world.add(e, ChildOf, { parent })
            else world.remove(e, ChildOf)
            continue
          }
          const def = componentDef(name, here)
          if (!def) continue
          if (raw === null) {
            world.remove(e, def)
            continue
          }
          const value = valuesOf(def, raw, here)
          if (!value) continue
          if (world.has(e, def)) world.set(e, def, value)
          else world.add(e, def, value)
        }
      }
    }

    restoreResources(world, file, warn)
    const global = world.tryResource(GlobalRng)
    for (const [label, state] of Object.entries(file.rng ?? {})) {
      if (!global) break
      if (!Array.isArray(state) || state.length !== 4) {
        warn(
          new ShardError('save/invalid', `RNG stream "${label}" needs four state words`, {
            path: pointer('/rng', label),
          }),
        )
        continue
      }
      if (label === GlobalRng.name) global.setState(state)
      else global.stream(label).setState(state)
    }
    const time = world.tryResource(Time)
    if (time && file.time) {
      time.elapsed = file.time.elapsed
      time.frame = file.time.frame
    }
    const fixed = world.tryResource(FixedTime)
    if (fixed && file.time?.fixedElapsed !== undefined) fixed.elapsed = file.time.fixedElapsed

    // Instances whose overrides changed respawn their children now.
    updateInstances(world)
    for (const id of sceneIds) await whenSceneReady(world, id)
    const log = world.tryResource(LogResource)
    for (const w of warnings)
      log?.log('warn', w.message, { code: w.code, path: w.path, hint: w.hint })
    assetServer(world).collect()
  } finally {
    if (control) control.paused = wasPaused
  }
  return { scenes: sceneIds, spawned: ids.size, warnings }
}

function restoreResources(world: World, file: SaveFile, warn: (error: ShardError) => void): void {
  for (const [name, json] of Object.entries(file.resources ?? {})) {
    const at = pointer('/resources', name)
    const def = findResource(name)
    if (!def?.schema) {
      warn(
        new ShardError('save/unknown-resource', `No persisted resource "${name}" any more`, {
          path: at,
          hint: 'The resource was renamed, removed, or lost its persist option; its saved value is skipped.',
        }),
      )
      continue
    }
    let value: Record<string, unknown>
    try {
      const upgraded = def.schema.upgrade(json, file.schemas?.[name] ?? def.schema.version)
      value = def.schema.deserialize(upgraded)
    } catch (err) {
      warn(asWarning(err, at))
      continue
    }
    const current = world.tryResource(def)
    if (isPlainObject(current)) Object.assign(current, value)
    else world.insertResource(def, value)
  }
}

/** A migration or conversion failure, as a warning at `path`. */
function asWarning(err: unknown, path: string): ShardError {
  if (err instanceof ShardError)
    return new ShardError(err.code, err.message, { path, hint: err.hint })
  return new ShardError('save/invalid', String((err as Error)?.message ?? err), { path })
}

/** A save reference (`ship/camera`, `main:ship`, `@3`, `@3/Hull`) to an entity, if it exists. */
function resolveEntity(world: World, ids: Map<string, Entity>, ref: string): Entity | undefined {
  if (ref.startsWith('@')) {
    const slash = ref.indexOf('/')
    const root = ids.get(slash === -1 ? ref : ref.slice(0, slash))
    if (root === undefined || slash === -1) return root
    return instanceEntities(world, root).get(ref.slice(slash + 1))
  }
  const e = findEntityByPath(world, ref)
  return e !== undefined && world.isAlive(e) ? e : undefined
}

// --- describe --------------------------------------------------------------------------------------

/** A save as an overview: sizes, counts, and which scene entities and components it changes. */
export function describeSave(file: SaveFile) {
  const scenes: Record<string, { changed: Record<string, string[]>; removed: string[] }> = {}
  for (const [id, scene] of Object.entries(file.scenes)) {
    const changed: Record<string, string[]> = {}
    for (const [path, components] of Object.entries(scene.changed ?? {})) {
      changed[path] = Object.entries(components).map(([name, v]) =>
        v === null ? `-${name}` : name,
      )
    }
    scenes[id] = { changed, removed: scene.removed ?? [] }
  }
  const prefabs: Record<string, number> = {}
  let plain = 0
  for (const e of file.spawned) {
    if (e.prefab) {
      const key = e.prefab.path ?? e.prefab.guid ?? '?'
      prefabs[key] = (prefabs[key] ?? 0) + 1
    } else plain++
  }
  return {
    version: file.version,
    engine: file.engine,
    meta: file.meta ?? null,
    time: file.time,
    bytes: encoder.encode(stringifySave(file)).length,
    scenes,
    spawned: { total: file.spawned.length, prefabs, entities: plain },
    resources: Object.keys(file.resources ?? {}),
    rng: Object.keys(file.rng ?? {}),
  }
}
