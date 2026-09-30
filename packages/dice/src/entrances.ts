import { type AssetRef, type Entity, ShardError } from '@aethervtt/shard-core'
import { DICE_BUDGETS, type DiceSceneContext } from './attachments'

// Entrances (0065): a die that doesn't tumble, brought in by a host scene (a dragon's breath, a
// meteor) that lands it at a moment it chooses. A recipe's `entrance` effect names one; the table
// takes its die out of the physics, gives it a rest pose, runs the scene after the tumble, and
// lands the die, target up and readable, when the scene says.

/** Entrance dice in one roll; more matches tumble. */
export const MAX_ENTRANCES = 2

/** What an entrance's scene can reach and do: a scene's context, and the die it brings in. */
export interface DiceEntranceContext extends DiceSceneContext {
  /** Where the die lands: the table's choice, target up with the readable twist. */
  rest: { position: [number, number, number]; rotation: [number, number, number, number] }
  /** When it lands, seconds from the scene's start. */
  landAt: number
  /** The host skipped: the die has landed; wind down within 400 ms. */
  readonly skipped: boolean
  /** Places the die this frame, before it lands (the table owns it after). */
  pose(position: ArrayLike<number>, rotation: ArrayLike<number>, scale?: number): void
  /** Shows or hides the die before it lands (it starts hidden; landing shows it). */
  show(visible: boolean): void
  /** Sets the family's own fields on this die's material (not the dice fields). */
  material(fields: Record<string, unknown>): void
}

export interface DiceEntranceDef {
  /** Vertices it draws, within `DICE_BUDGETS.entranceVertices`: declared, and held to. */
  vertices: number
  /** The whole scene, in ms, within `DICE_BUDGETS.entranceMs`. */
  durationMs: number
  /** When the die lands, in ms from the start: at most `durationMs`. */
  landAtMs: number
  /** Where it wants the die: the tray's center, or [u, v] in −1..1 of the tray. Default center. */
  spot?: 'center' | readonly [number, number]
  /** How hard the die lands, 0..1: its impact sound. Default 0.8. */
  impact?: number
  /** Loaded before it plays; a roll waits at most 1.5 s for them after the physics is ready. */
  assets?: readonly AssetRef[]
  /** Spawns the scene; returns what it spawned (the table despawns it). */
  spawn(ctx: DiceEntranceContext): Entity[]
  /** Every frame from the start, with seconds since. Return false to end it early. */
  update?(
    ctx: DiceEntranceContext,
    seconds: number,
    entities: readonly Entity[],
  ): boolean | undefined
}

const entrances = new Map<string, DiceEntranceDef>()

function budget(name: string, message: string): ShardError {
  return new ShardError('dice/entrance-budget', `Entrance "${name}" ${message}`, {
    hint: 'Trim the scene, or raise DICE_BUDGETS with setDiceBudgets before defining it.',
  })
}

/**
 * Registers a scene that brings a die in (0065). Throws `dice/entrance-budget` for a scene over the
 * budgets, `dice/invalid-entrance` for a landing outside it, `dice/registry-conflict` for a name
 * taken.
 */
export function defineDiceEntrance(name: string, def: DiceEntranceDef): DiceEntranceDef {
  if (!(def.vertices > 0) || def.vertices > DICE_BUDGETS.entranceVertices) {
    throw budget(
      name,
      `declares ${def.vertices} vertices; the budget is ${DICE_BUDGETS.entranceVertices}`,
    )
  }
  if (!(def.durationMs > 0) || def.durationMs > DICE_BUDGETS.entranceMs) {
    throw budget(name, `runs ${def.durationMs} ms; the budget is ${DICE_BUDGETS.entranceMs}`)
  }
  if (!(def.landAtMs >= 0 && def.landAtMs <= def.durationMs)) {
    throw new ShardError(
      'dice/invalid-entrance',
      `Entrance "${name}" lands at ${def.landAtMs} ms, outside its ${def.durationMs} ms`,
      { hint: 'landAtMs is when the die lands: between 0 and durationMs.', path: 'landAtMs' },
    )
  }
  const spot = def.spot
  if (spot && spot !== 'center' && !(Math.abs(spot[0]) <= 1 && Math.abs(spot[1]) <= 1)) {
    throw new ShardError('dice/invalid-entrance', `Entrance "${name}" wants a spot off the tray`, {
      hint: "spot is 'center', or [u, v] with each in −1..1 of the tray.",
      path: 'spot',
    })
  }
  const existing = entrances.get(name)
  if (existing && existing !== def) {
    throw new ShardError('dice/registry-conflict', `Entrance "${name}" is already defined`, {
      hint: 'Give the new entrance its own name.',
    })
  }
  entrances.set(name, def)
  return def
}

export function findDiceEntrance(name: string): DiceEntranceDef | undefined {
  return entrances.get(name)
}

export function allDiceEntrances(): string[] {
  return [...entrances.keys()].sort()
}
