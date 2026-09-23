import { ShardError } from '../error'

/** `namespace/PascalName`, e.g. `core/Transform`, `game/Health`, `my-game/DoorState`. */
const NAME = /^[a-z][a-z0-9-]*\/[A-Z][A-Za-z0-9]*$/

export function assertName(kind: string, name: string): void {
  if (!NAME.test(name)) {
    throw new ShardError('schema/invalid-name', `Invalid ${kind} name "${name}"`, {
      hint: 'Use "namespace/PascalName", e.g. "game/Health".',
    })
  }
}

let nextId = 0

/** Process-wide ids, dense from 0, shared by components, resources, and events. */
export function allocateId(): number {
  return nextId++
}

// --- redefinition (hot reload) ----------------------------------------------------

export interface Redefinition {
  readonly kind: 'component' | 'resource' | 'event'
  readonly name: string
  /** The definition being replaced; the new one reuses its id. */
  readonly previous: { readonly id: number }
  readonly next: { readonly id: number }
  /** Puts the previous definition back in the global catalog (a failed reload). */
  undo(): void
}

let scope: { namespace: string; changes: Redefinition[] } | undefined

/**
 * Starts a redefinition scope: until `endRedefinition`, defining a component, resource, or event
 * whose name is in `namespace` and already exists replaces it, keeping its id, instead of creating
 * a second definition. Hot reload evaluates the new project bundle inside one.
 */
export function beginRedefinition(namespace: string): void {
  if (scope) {
    throw new ShardError('schema/redefinition-active', 'A redefinition scope is already open')
  }
  scope = { namespace, changes: [] }
}

/** Ends the scope and returns what was redefined. */
export function endRedefinition(): Redefinition[] {
  const changes = scope?.changes ?? []
  scope = undefined
  return changes
}

/** True when `name` may replace an existing definition right now. */
export function isRedefinable(name: string): boolean {
  return scope !== undefined && name.startsWith(`${scope.namespace}/`)
}

export function recordRedefinition(change: Redefinition): void {
  scope?.changes.push(change)
}
