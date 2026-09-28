import { ShardError } from '../error'
import type { ComponentDef } from './component'
import { allocateId, assertName, isRedefinable, recordRedefinition } from './names'

export interface ResourceDef<T> {
  readonly kind: 'resource'
  readonly id: number
  readonly name: string
  readonly description: string | undefined
  /** Creates the initial value for `world.initResource`. */
  readonly init: (() => T) | undefined
  /**
   * What hot reload does with the value when the defining code reloads: 'keep' (default) keeps it,
   * since it's game state; 'replace' takes whatever the new code inserts (configuration, such as
   * action maps).
   */
  readonly reload: 'keep' | 'replace'
  /**
   * The value's schema (`defineSchema`), for resources that are plain data: it validates,
   * serializes, and migrates them. Settings and saved resources have one.
   */
  readonly schema: ComponentDef | undefined
  /** Saved games include it (0038). Needs `schema`. */
  readonly persist: boolean
  /**
   * Host code (UI, protocol handlers) writes it between frames, through `world.patchResource` or
   * `world.touchResource` (0052). The on-demand runner's write check watches it.
   */
  readonly hostWritable: boolean
  readonly __type?: T
}

export interface ResourceOptions<T> {
  description?: string
  init?: () => T
  reload?: 'keep' | 'replace'
  schema?: ComponentDef
  persist?: boolean
  hostWritable?: boolean
}

const resources = new Map<string, ResourceDef<unknown>>()

export function defineResource<T>(name: string, options: ResourceOptions<T> = {}): ResourceDef<T> {
  assertName('resource', name)
  if (options.persist && !options.schema) {
    throw new ShardError(
      'schema/persist-needs-schema',
      `Resource "${name}" persists but has no schema`,
      {
        hint: 'Give it a schema (defineSchema) so saves can validate and migrate it.',
      },
    )
  }
  const previous = isRedefinable(name) ? resources.get(name) : undefined
  const def: ResourceDef<T> = {
    kind: 'resource',
    id: previous?.id ?? allocateId(),
    name,
    description: options.description,
    init: options.init,
    reload: options.reload ?? 'keep',
    schema: options.schema,
    persist: options.persist ?? false,
    hostWritable: options.hostWritable ?? false,
  }
  resources.set(name, def as ResourceDef<unknown>)
  if (previous) {
    recordRedefinition({
      kind: 'resource',
      name,
      previous,
      next: def,
      undo: () => resources.set(name, previous),
    })
  }
  return def
}

/** Every resource defined in this process (latest definitions), sorted by name. */
export function allResources(): ResourceDef<unknown>[] {
  return [...resources.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The resource defined under `name` (the latest definition), or undefined. */
export function findResource(name: string): ResourceDef<unknown> | undefined {
  return resources.get(name)
}

export interface EventDef<T> {
  readonly kind: 'event'
  readonly id: number
  readonly name: string
  readonly description: string | undefined
  readonly __type?: T
}

export function defineEvent<T = undefined>(
  name: string,
  options: { description?: string } = {},
): EventDef<T> {
  assertName('event', name)
  const previous = isRedefinable(name) ? events.get(name) : undefined
  const def: EventDef<T> = {
    kind: 'event',
    id: previous?.id ?? allocateId(),
    name,
    description: options.description,
  }
  events.set(name, def as EventDef<unknown>)
  if (previous) {
    recordRedefinition({
      kind: 'event',
      name,
      previous,
      next: def,
      undo: () => events.set(name, previous),
    })
  }
  return def
}

const events = new Map<string, EventDef<unknown>>()

/** The event defined under `name` (the latest definition), or undefined. */
export function allEvents(): EventDef<unknown>[] {
  return [...events.values()]
}

export function findEvent(name: string): EventDef<unknown> | undefined {
  return events.get(name)
}
