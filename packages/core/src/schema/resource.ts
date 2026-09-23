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

export function defineResource<T>(
  name: string,
  options: { description?: string; init?: () => T } = {},
): ResourceDef<T> {
  assertName('resource', name)
  return {
    kind: 'resource',
    id: allocateId(),
    name,
    description: options.description,
    init: options.init,
  }
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
