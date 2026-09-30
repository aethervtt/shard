import { type Entity, ShardError, type World } from '@aethervtt/shard-core'
import type { DieKind } from './builtins'

// Attachments (0054): host-registered scenes on a landed die (Aether's accretion disk, say). A
// recipe's `attachment` effect names one; the package spawns it on each kept die the recipe
// anchors to, at most 4 alive, and despawns it on dismissal, replacement, cancellation or teardown.

export const MAX_ATTACHMENTS = 4
export const MAX_ATTACHMENT_VERTICES = 12_000

export interface DiceAttachmentContext {
  world: World
  /** The landed die: parent what you spawn to it (ChildOf) so it follows the die. */
  die: Entity
  kind: DieKind
  value: number
  label: string
  /** The die's world scale. */
  scale: number
  /**
   * Publishes (or refreshes) a lens field (0063) centered on the die, in the dice view's CSS
   * pixels. False when the table doesn't allow fields (reduced motion, effects off, large pools)
   * or 4 others are live.
   */
  lens(field: { radius: number; strength: number; ttlMs?: number }): boolean
}

export interface DiceAttachmentDef {
  /** Vertices it draws, at most 12,000: declared, and held to. */
  vertices: number
  /** Spawns the scene. Returns what it spawned (the package despawns it). */
  spawn(ctx: DiceAttachmentContext): Entity[]
  /**
   * Runs each frame while it's alive, with seconds since it spawned; frames keep coming while any
   * attachment has one. Return true to keep it, false when it's done (it's despawned).
   */
  update?(ctx: DiceAttachmentContext, seconds: number, entities: readonly Entity[]): boolean
}

const attachments = new Map<string, DiceAttachmentDef>()

/** Registers a scene recipes can attach to landed dice by name. */
export function defineDiceAttachment(name: string, def: DiceAttachmentDef): DiceAttachmentDef {
  if (!(def.vertices > 0) || def.vertices > MAX_ATTACHMENT_VERTICES) {
    throw new ShardError(
      'dice/attachment-budget',
      `Attachment "${name}" declares ${def.vertices} vertices; the budget is ${MAX_ATTACHMENT_VERTICES}`,
      { hint: 'Draw fewer vertices, or split the effect.' },
    )
  }
  const existing = attachments.get(name)
  if (existing && existing !== def) {
    throw new ShardError('dice/registry-conflict', `Attachment "${name}" is already defined`, {
      hint: 'Give the new attachment its own name.',
    })
  }
  attachments.set(name, def)
  return def
}

export function findDiceAttachment(name: string): DiceAttachmentDef | undefined {
  return attachments.get(name)
}

export function allDiceAttachments(): string[] {
  return [...attachments.keys()].sort()
}
