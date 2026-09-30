import { type AssetRef, ShardError } from '@aethervtt/shard-core'
import { DIE_KINDS, type DieKind, KIND_DEFINITIONS, kindSides, percentileValues } from './builtins'
import { dieGeometry, frameOf, labelOf, physicalScale, requireDie } from './definition'
import type { DiceTray } from './settle'
import { type DiceTrackRequest, type LaunchEdge, MAX_DICE } from './track'

/** A roll the host decided: what to show, never what to decide (0054). */
export interface DiceRoll {
  /** The host's entry id; also the default seed. */
  id: string
  dice: DiceRollDie[]
  total?: number
  source?: { mine: boolean; gm: boolean }
  /** Host semantic tags, at most 8, for effect conditions. */
  tags?: string[]
  seed?: string
  /** A fixed tray every viewer shares; omitted, the tray follows this viewport. */
  tray?: DiceTray
  /** The tray edge the dice come in from; the seed picks one when omitted. */
  launch?: LaunchEdge
  quality?: DiceQualityPreference
  motion?: 'full' | 'reduced'
  effects?: boolean
  /** 0..1. */
  soundGain?: number
}

export interface DiceRollDie {
  kind: DieKind
  value: number
  /** A DiceSkin. */
  skin: AssetRef<'dice/DiceSkin'> | AssetRef
  dropped?: boolean
  high?: boolean
  low?: boolean
}

export type DiceQualityPreference = 'auto' | 'full' | 'balanced' | 'large-pool'

/** One body on the table: a roll's die, or half of a percentile. */
export interface PhysicalDie {
  /** Index into `roll.dice`. */
  source: number
  kind: DieKind
  definition: string
  /** The definition's value to show (a percentile's tens die shows 1..10). */
  value: number
  /** What the host rolled for the roll die (a percentile's 1..100). */
  rolled: number
  /** The printed mark on top. */
  label: string
  part: 'tens' | 'units' | undefined
  skin: AssetRef
  dropped: boolean
  high: boolean
  low: boolean
  /** World scale of the unit-radius die. */
  scale: number
}

const MAX_TAGS = 8

function invalidValue(message: string, path: string): ShardError {
  return new ShardError('dice/invalid-value', message, {
    path,
    hint: 'The host decides the result; pass one the die can show.',
  })
}

/** Presentation scale by the number of bodies, as Aether steps it. */
export function presentationScale(count: number): number {
  if (count <= 2) return 0.68
  if (count <= 8) return 0.56
  if (count <= 16) return 0.46
  return 0.38
}

/** The tray that follows a viewport: as wide as its aspect allows, 3.15 deep (Aether's). */
export function viewportTray(aspect: number): DiceTray {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  return { halfWidth: Math.max(2.35, Math.min(5.4, 3.15 * a)), halfDepth: 3.15 }
}

/**
 * The bodies a roll puts on the table, in order: percentile plays a tens and a units d10. Values
 * the dice can't show fail with `dice/invalid-value` naming the die; nothing is played.
 */
export function expandRoll(
  roll: DiceRoll,
  kinds: Readonly<Record<DieKind, readonly string[]>> = KIND_DEFINITIONS,
): PhysicalDie[] {
  if (typeof roll.id !== 'string' || roll.id === '') {
    throw new ShardError('dice/invalid-roll', 'A roll needs an id', { path: 'id' })
  }
  if ((roll.tags?.length ?? 0) > MAX_TAGS) {
    throw new ShardError('dice/invalid-roll', `A roll has at most ${MAX_TAGS} tags`, {
      path: 'tags',
    })
  }
  const out: PhysicalDie[] = []
  roll.dice.forEach((die, i) => {
    const path = `dice[${i}]`
    if (!(DIE_KINDS as readonly string[]).includes(die.kind)) {
      throw new ShardError('dice/invalid-roll', `${path}.kind "${die.kind}" isn't a die kind`, {
        path: `${path}.kind`,
        hint: `Kinds: ${DIE_KINDS.join(', ')}.`,
      })
    }
    const sides = kindSides(die.kind)
    if (!Number.isInteger(die.value) || die.value < 1 || die.value > sides) {
      throw invalidValue(
        `${path} is a ${die.kind} showing ${die.value}; it shows 1 to ${sides}`,
        `${path}.value`,
      )
    }
    const defs = kinds[die.kind]
    const values = die.kind === 'percentile' ? percentileValues(die.value) : [die.value]
    defs.forEach((id, k) => {
      const def = requireDie(id)
      const value = values[k] ?? die.value
      frameOf(dieGeometry(def), value)
      out.push({
        source: i,
        kind: die.kind,
        definition: id,
        value,
        rolled: die.value,
        label: labelOf(def, value),
        part: die.kind === 'percentile' ? (k === 0 ? 'tens' : 'units') : undefined,
        skin: die.skin,
        dropped: die.dropped ?? false,
        high: die.high ?? false,
        low: die.low ?? false,
        scale: 0,
      })
    })
  })
  if (out.length === 0 || out.length > MAX_DICE) {
    throw new ShardError(
      'dice/invalid-roll',
      `A roll puts 1 to ${MAX_DICE} dice on the table, not ${out.length}`,
      {
        path: 'dice',
      },
    )
  }
  const base = presentationScale(out.length)
  const reference = dieGeometry(requireDie('d20'))
  for (const d of out)
    d.scale = base * physicalScale(dieGeometry(requireDie(d.definition)), reference)
  return out
}

/** The track request of a roll's bodies: its seed (default the id), tray, and dice. */
export function rollTrackRequest(
  roll: DiceRoll,
  dice: readonly PhysicalDie[],
  tray: DiceTray,
): DiceTrackRequest {
  return {
    seed: roll.seed ?? roll.id,
    tray: { halfWidth: tray.halfWidth, halfDepth: tray.halfDepth },
    dice: dice.map((d) => ({ definition: d.definition, scale: d.scale, dropped: d.dropped })),
    launch: roll.launch,
  }
}
