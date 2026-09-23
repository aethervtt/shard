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
  readonly __type?: T
}

const resources = new Map<string, ResourceDef<unknown>>()

export function defineResource<T>(
  name: string,
  options: { description?: string; init?: () => T; reload?: 'keep' | 'replace' } = {},
): ResourceDef<T> {
  assertName('resource', name)
  const previous = isRedefinable(name) ? resources.get(name) : undefined
  const def: ResourceDef<T> = {
    kind: 'resource',
    id: previous?.id ?? allocateId(),
    name,
    description: options.description,
    init: options.init,
    reload: options.reload ?? 'keep',
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
export function findEvent(name: string): EventDef<unknown> | undefined {
  return events.get(name)
}
