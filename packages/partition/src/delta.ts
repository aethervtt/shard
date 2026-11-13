import {
  ChildOf,
  type ComponentDef,
  type Entity,
  findComponent,
  isPlainObject,
  type JsonObject,
  type JsonValue,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { InstancePart } from '@aethervtt/shard-scene'
import { CellBound, StreamedCell } from './components'

/**
 * An added entity in a delta (`+n`): its saved components, and its parent's path in the cell when
 * it hangs under a generated entity. Entity fields are written as null (0113: references don't
 * survive a cell unloading).
 */
export interface SavedCellEntity {
  parent?: string
  components: Record<string, JsonObject>
  /** What a hook keeps besides saved components (net/Replicated for a dormant zombie). */
  extra?: JsonObject
}

/** A cell's changes against its generated baseline (0113), in the form saves write. */
export interface CellDeltaJson {
  generator: string
  version: number
  /** 0030 overrides by path, plus `+n` keys for added static entities. */
  entries: Record<string, JsonValue>
  revs: Record<string, number>
  dormant: SavedCellEntity[]
  /** Last `+n` handed out. */
  next: number
}

export interface Tombstone {
  rev: number
  /** Baseline values to put back for a patch that left the delta. */
  restore: JsonValue | undefined
}

/** A cell's delta while the world runs: entries by key, with a rev each for incremental sync. */
export class DeltaState {
  generator: string
  version: number
  readonly entries = new Map<string, JsonValue>()
  readonly revs = new Map<string, number>()
  /** Keys that left the delta, for peers that still have them. */
  readonly dropped = new Map<string, Tombstone>()
  /** The override keys of each generated path (the path itself, and its component removals). */
  readonly byPath = new Map<string, Set<string>>()
  dormant: SavedCellEntity[] = []
  rev = 0
  next = 0

  constructor(generator: string, version: number) {
    this.generator = generator
    this.version = version
  }

  get empty(): boolean {
    return this.entries.size === 0 && this.dormant.length === 0
  }

  /** Sets a key; returns whether it changed. */
  set(key: string, value: JsonValue, path?: string): boolean {
    const old = this.entries.get(key)
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(value)) return false
    this.entries.set(key, value)
    this.revs.set(key, ++this.rev)
    this.dropped.delete(key)
    if (path !== undefined) {
      let keys = this.byPath.get(path)
      if (!keys) {
        keys = new Set()
        this.byPath.set(path, keys)
      }
      keys.add(key)
    }
    return true
  }

  drop(key: string, restore?: JsonValue, path?: string): boolean {
    if (!this.entries.delete(key)) return false
    this.revs.delete(key)
    this.dropped.set(key, { rev: ++this.rev, restore })
    if (path !== undefined) this.byPath.get(path)?.delete(key)
    return true
  }

  /** The overrides part (every key that isn't `+n`). */
  overrides(): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = {}
    for (const [k, v] of this.entries) if (!k.startsWith('+')) out[k] = v
    return out
  }

  toJson(): CellDeltaJson {
    const entries: Record<string, JsonValue> = {}
    const revs: Record<string, number> = {}
    for (const [k, v] of this.entries) {
      entries[k] = v
      revs[k] = this.revs.get(k) ?? 0
    }
    return {
      generator: this.generator,
      version: this.version,
      entries,
      revs,
      dormant: this.dormant,
      next: this.next,
    }
  }

  static fromJson(json: CellDeltaJson): DeltaState {
    const d = new DeltaState(json.generator, json.version)
    let rev = 0
    for (const [k, v] of Object.entries(json.entries)) {
      const r = json.revs[k] ?? 0
      d.entries.set(k, v)
      d.revs.set(k, r)
      if (r > rev) rev = r
      if (!k.startsWith('+')) d.index(k)
    }
    d.rev = rev
    d.dormant = json.dormant ?? []
    d.next = json.next ?? 0
    return d
  }

  /** Records `key` under its generated path (a component removal key under its entity). */
  index(key: string): void {
    const path = pathOfKey(key)
    let keys = this.byPath.get(path)
    if (!keys) {
      keys = new Set()
      this.byPath.set(path, keys)
    }
    keys.add(key)
  }
}

/** The entity path of an override key: `b3/crate/zomboid/Contents` → `b3/crate`. */
export function pathOfKey(key: string): string {
  const parts = key.split('/')
  if (parts.length >= 3 && findComponent(`${parts.at(-2)}/${parts.at(-1)}`)) {
    return parts.slice(0, -2).join('/')
  }
  return key
}

/** Components a cell entity's saved form leaves out: hierarchy and partition bookkeeping. */
function skipped(def: ComponentDef): boolean {
  return (
    !def.saved ||
    def === ChildOf ||
    def === InstancePart ||
    def === CellBound ||
    def === StreamedCell
  )
}

/** An entity's saved components as JSON, with entity fields nulled. */
export function serializeComponents(
  world: World,
  entity: Entity,
  leaveOut?: ReadonlySet<string>,
): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = {}
  for (const def of world.componentsOf(entity)) {
    if (skipped(def) || leaveOut?.has(def.name)) continue
    const json = def.serialize(world.get(entity, def) as never)
    for (const [name, field] of Object.entries(def.fields)) {
      if (field.kind === 'entity') json[name] = null
    }
    out[def.name] = json
  }
  return out
}

/** Adds components from their JSON (unknown names are reported, not thrown). */
export function addComponents(
  world: World,
  entity: Entity,
  components: Record<string, JsonValue>,
  warn: (error: ShardError) => void,
): void {
  for (const [name, json] of Object.entries(components)) {
    const def = findComponent(name)
    if (!def) {
      warn(
        new ShardError('save/unknown-component', `No component "${name}"`, {
          hint: 'A cell delta names a component no module defines any more.',
        }),
      )
      continue
    }
    if (!isPlainObject(json)) continue
    const merged = world.has(entity, def)
      ? { ...def.serialize(world.get(entity, def) as never), ...json }
      : json
    try {
      world.add(entity, def, def.deserialize(merged) as never)
    } catch (err) {
      warn(err as ShardError)
    }
  }
}

/**
 * The part of an override value a client may see: secret components left out. Returns undefined
 * when nothing is left (the whole key is secret).
 */
export function publicValue(
  key: string,
  value: JsonValue,
  secret: ReadonlySet<string>,
): JsonValue | undefined {
  if (secret.size === 0) return value
  if (key.startsWith('+')) {
    const saved = value as unknown as SavedCellEntity
    const components: Record<string, JsonObject> = {}
    for (const [name, json] of Object.entries(saved.components)) {
      if (!secret.has(name)) components[name] = json
    }
    return { ...saved, components } as unknown as JsonValue
  }
  if (value === null) {
    const path = pathOfKey(key)
    return path !== key && secret.has(key.slice(path.length + 1)) ? undefined : null
  }
  const out: JsonObject = {}
  let any = false
  for (const [name, fields] of Object.entries(value as JsonObject)) {
    if (secret.has(name)) continue
    out[name] = fields
    any = true
  }
  return any ? out : undefined
}

/** Field patches in `patch` that differ from `base` (component by component). */
export function subtractPatch(patch: JsonObject, base: JsonObject | undefined): JsonObject | null {
  if (!base) return patch
  const out: JsonObject = {}
  let any = false
  for (const [name, fields] of Object.entries(patch)) {
    const b = base[name]
    if (!isPlainObject(fields) || !isPlainObject(b)) {
      out[name] = fields
      any = true
      continue
    }
    const left: JsonObject = {}
    let anyField = false
    for (const [f, v] of Object.entries(fields as JsonObject)) {
      if (JSON.stringify(v) === JSON.stringify((b as JsonObject)[f])) continue
      left[f] = v
      anyField = true
    }
    if (anyField) {
      out[name] = left
      any = true
    }
  }
  return any ? out : null
}

/** Merges override sets: later ones win field by field. */
export function mergeOverrides(...sets: Record<string, JsonValue>[]): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const set of sets) {
    for (const [key, value] of Object.entries(set)) {
      const old = out[key]
      if (value === null || !isPlainObject(old) || !isPlainObject(value)) {
        out[key] = value
        continue
      }
      const merged: JsonObject = { ...(old as JsonObject) }
      for (const [name, fields] of Object.entries(value as JsonObject)) {
        const o = merged[name]
        merged[name] =
          isPlainObject(o) && isPlainObject(fields)
            ? { ...(o as JsonObject), ...(fields as JsonObject) }
            : fields
      }
      out[key] = merged
    }
  }
  return out
}
