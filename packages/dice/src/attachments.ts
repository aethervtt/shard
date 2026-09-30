import type { AudioClipAsset, PlaySoundOptions } from '@aethervtt/shard-audio'
import { type AssetRef, type Entity, ShardError, type World } from '@aethervtt/shard-core'
import type { ScreenEffectParams } from '@aethervtt/shard-render'
import type { DieKind } from './builtins'
import type { AccentCue } from './sound'

// Attachments (0054): host-registered scenes on a landed die (Aether's accretion disk, say). A
// recipe's `attachment` effect names one; the package spawns it on each kept die the recipe
// anchors to, at most 4 alive, and despawns it on dismissal, replacement, cancellation or teardown.

export const MAX_ATTACHMENTS = 4

/**
 * What the registries hold scenes to (0065): vertices an attachment or an entrance may declare, and
 * an entrance's longest run. Module-wide, like the registries: set them before defining.
 */
export const DICE_BUDGETS = {
  attachmentVertices: 12_000,
  entranceVertices: 60_000,
  entranceMs: 8_000,
}

/** Raises (or lowers) the budgets; call it before defining attachments and entrances. */
export function setDiceBudgets(budgets: Partial<typeof DICE_BUDGETS>): void {
  Object.assign(DICE_BUDGETS, budgets)
}

/** What a host scene on a die (an attachment, or an entrance, 0065) can reach and do. */
export interface DiceSceneContext {
  world: World
  /** The die: parent what you spawn to it (ChildOf) so it follows the die. */
  die: Entity
  kind: DieKind
  value: number
  label: string
  /** The die's world scale. */
  scale: number
  /** From the recipe effect that named the scene, so one scene serves many skins. */
  params: Record<string, unknown>
  /** The dice camera: face it (spawnDiceWindow). */
  camera: Entity
  /** From the roll and the die: variation that's the same for every viewer. */
  seed: number
  /** The roll's sound gain, 0..1 (`sound` applies it). */
  soundGain: number
  /** Where a world point (default: the die) is in the dice view's CSS pixels; null behind the camera. */
  screen(point?: ArrayLike<number>): [number, number] | null
  /**
   * Publishes (or refreshes) a lens field (0063) centered on the die, in the dice view's CSS
   * pixels. False when the table doesn't allow fields (reduced motion, effects off, large pools)
   * or 4 others are live.
   */
  lens(field: { radius: number; strength: number; ttlMs?: number }): boolean
  /**
   * Publishes (or refreshes) a screen effect (0065) of this kind, centered on the die (or `at`),
   * for the host's table to draw (`fire`). False when the table doesn't allow effects or 8 are live.
   */
  effect(effect: {
    kind: string
    radius: number
    ttlMs?: number
    params?: ScreenEffectParams
    at?: ArrayLike<number>
  }): boolean
  /** Plays a clip at the roll's sound gain (a range scales too); stopped when the roll ends. -1 without audio. */
  sound(clip: AssetRef | AudioClipAsset, options?: PlaySoundOptions): number
  /** Plays one of the package's accent cues. */
  cue(cue: AccentCue, gain?: number): void
}

export type DiceAttachmentContext = DiceSceneContext

export interface DiceAttachmentDef {
  /** Vertices it draws, within `DICE_BUDGETS.attachmentVertices`: declared, and held to. */
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
  const budget = DICE_BUDGETS.attachmentVertices
  if (!(def.vertices > 0) || def.vertices > budget) {
    throw new ShardError(
      'dice/attachment-budget',
      `Attachment "${name}" declares ${def.vertices} vertices; the budget is ${budget}`,
      { hint: 'Draw fewer vertices, split the effect, or raise it with setDiceBudgets first.' },
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
