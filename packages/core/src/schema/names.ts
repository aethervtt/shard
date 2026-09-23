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
