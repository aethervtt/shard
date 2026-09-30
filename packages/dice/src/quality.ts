import type { DiceQualityPreference } from './roll'

// Quality tiers (0054). full: moving shadows, family shaders, effects, attachments and lens
// fields. balanced: the same without attachments and lens fields. large-pool: the solid path of
// each family, no effects, attachments or lens fields, a contact blob under every die while they
// tumble and one static shadow once they land; dice draw instanced by (definition, skin).

export type DiceQuality = 'full' | 'balanced' | 'large-pool'

export interface DiceQualityChoice {
  tier: DiceQuality
  /** Why, for `dice.describe`. */
  reason: string
}

/**
 * The tier for a number of bodies and a preference: `auto` is full up to 12, balanced to 16, then
 * large-pool; `balanced` holds to 12 and `full` to 24 before large-pool takes over.
 */
export function resolveDiceQuality(
  count: number,
  preference: DiceQualityPreference = 'auto',
): DiceQualityChoice {
  const n = `${count} ${count === 1 ? 'die' : 'dice'}`
  switch (preference) {
    case 'large-pool':
      return { tier: 'large-pool', reason: 'large-pool asked for' }
    case 'full':
      return count > 24
        ? { tier: 'large-pool', reason: `full asked for, but ${n} is over 24` }
        : { tier: 'full', reason: `full asked for (${n})` }
    case 'balanced':
      return count > 12
        ? { tier: 'large-pool', reason: `balanced asked for, but ${n} is over 12` }
        : { tier: 'balanced', reason: `balanced asked for (${n})` }
    default:
      if (count > 16) return { tier: 'large-pool', reason: `auto: ${n}, over 16` }
      if (count > 12) return { tier: 'balanced', reason: `auto: ${n}, over 12` }
      return { tier: 'full', reason: `auto: ${n}` }
  }
}
