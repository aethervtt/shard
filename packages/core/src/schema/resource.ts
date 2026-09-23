import { allocateId, assertName } from './names'

export interface ResourceDef<T> {
  readonly kind: 'resource'
  readonly id: number
  readonly name: string
  readonly description: string | undefined
  /** Creates the initial value for `world.initResource`. */
  readonly init: (() => T) | undefined
  readonly __type?: T
}

const resources = new Map<string, ResourceDef<unknown>>()

export function defineResource<T>(
  name: string,
  options: { description?: string; init?: () => T } = {},
): ResourceDef<T> {
  assertName('resource', name)
  const def: ResourceDef<T> = {
    kind: 'resource',
    id: allocateId(),
    name,
    description: options.description,
    init: options.init,
  }
  resources.set(name, def as ResourceDef<unknown>)
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
  return { kind: 'event', id: allocateId(), name, description: options.description }
}
