import { ShardError } from '../error'
import type { ComponentDef } from '../schema/component'

// The grant that lets host code write `hostOnly` components (0061). Internal to core: the package
// exports neither function, so only core's own owner registry can open it.

let depth = 0

/** Runs `fn` with `hostOnly` component writes allowed. */
export function withHostWrite<T>(fn: () => T): T {
  depth++
  try {
    return fn()
  } finally {
    depth--
  }
}

/** Throws unless a host grant is open. The world calls it before writing a `hostOnly` component. */
export function assertHostWrite(def: ComponentDef): void {
  if (depth > 0) return
  throw new ShardError(
    'core/owner-not-authorable',
    `"${def.name}" can only be written by the host`,
    {
      hint: 'Ownership is a grant from host code: spawn with world.owners.spawn(owner, ...) or world.owners.adopt(owner, entity).',
    },
  )
}
