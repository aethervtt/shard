import { defineDataType } from '@aethervtt/shard-assets'
import { type FieldValue, type Infer, ShardError, t } from '@aethervtt/shard-core'
import { DIE_KINDS } from './builtins'
import type { DiceRoll, PhysicalDie } from './roll'

// Effect recipes (0054): data a skin carries that plays in the accent phase, when its conditions
// match the roll. Bounded: at most 8 conditions and 3 effects, particle bursts of at most 32.

const CONDITION = t.struct(
  {
    kind: t.enum(['die', 'total', 'source', 'tag'], {
      description:
        'die: a die of the roll matches; total: the roll total compares; source: who rolled; tag: a host tag.',
    }),
    die: t.enum(['any', ...DIE_KINDS], { description: 'die: the kind (any).' }),
    value: t.u16({ description: 'die: the value (0: any).' }),
    face: t.string({ description: "die: the printed label on top ('00'); empty: any." }),
    state: t.enum(['any', 'kept', 'dropped'], { description: 'die: kept or dropped.' }),
    rank: t.enum(['any', 'high', 'low'], { description: 'die: flagged high or low by the host.' }),
    compare: t.enum(['eq', 'gte', 'lte'], { description: 'total: how it compares.' }),
    total: t.f32({ description: 'total: the value compared with.' }),
    source: t.enum(['mine', 'gm', 'other'], { description: 'source: who rolled.' }),
    tag: t.string({ description: 'tag: a host semantic tag.' }),
  },
  { description: 'One condition.' },
)

const EFFECT = t.struct(
  {
    kind: t.enum(
      ['light-pulse', 'particle-burst', 'sound-accent', 'lens-pulse', 'attachment', 'entrance'],
      {
        description:
          'light-pulse: a point light swells and fades; particle-burst: CPU particles; sound-accent: a cue; lens-pulse: a lens field (0063) on the die; attachment: a registered scene on each matching die; entrance: a registered scene brings each matching die in instead of the tumble (0065).',
      },
    ),
    color: t.color({ default: [1, 0.82, 0.45, 1], description: 'light-pulse: color.' }),
    colors: t.list(t.color(), { description: 'particle-burst: 1 to 4 colors.' }),
    intensity: t.f32({ default: 2, min: 0, max: 8, description: 'light-pulse: 0..8.' }),
    count: t.u8({ default: 24, description: 'particle-burst: particles, at most 32.' }),
    durationMs: t.u16({
      default: 700,
      description: 'light-pulse, particle-burst, lens-pulse: 100..1200 ms.',
    }),
    cue: t.enum(['resin-chime', 'arcane-spark', 'void-whump'], {
      description: 'sound-accent: the cue.',
    }),
    gain: t.f32({ default: 0.7, min: 0, max: 1, description: 'sound-accent: 0..1.' }),
    radius: t.f32({
      default: 150,
      min: 0,
      unit: 'px',
      description: 'lens-pulse: field radius (CSS px).',
    }),
    strength: t.f32({
      default: -0.6,
      min: -1,
      max: 1,
      description: 'lens-pulse: below 0 pulls in.',
    }),
    attachment: t.string({ description: 'attachment: the name given to defineDiceAttachment.' }),
    entrance: t.string({ description: 'entrance: the name given to defineDiceEntrance.' }),
    params: t.json({
      default: {},
      description:
        'attachment, entrance: what the scene reads (at most 16 keys), so skins share one.',
    }),
  },
  { description: 'One effect.' },
)

/** An effect recipe: `data/**\/*.dice-effect.json`. */
export const DiceEffectRecipe = defineDataType(
  'dice/DiceEffectRecipe',
  {
    version: t.u8({ default: 1, min: 1, max: 1, description: 'Format version: 1.' }),
    id: t.string({ description: 'Unique per recipe; the same recipe on two skins plays once.' }),
    match: t.enum(['all', 'any'], {
      description: 'Every condition, or any of them. No conditions: always.',
    }),
    conditions: t.list(CONDITION, { description: 'At most 8.' }),
    effects: t.list(EFFECT, { description: '1 to 3.' }),
  },
  {
    extension: 'dice-effect',
    description: 'Effects a skin plays when a roll matches its conditions.',
  },
)

export type DiceEffectRecipeValue = Infer<typeof DiceEffectRecipe>
export type DiceEffect = FieldValue<typeof EFFECT>
export type DiceCondition = FieldValue<typeof CONDITION>

export const RECIPE_LIMITS = {
  conditions: 8,
  effects: 3,
  particles: 32,
  colors: 4,
  minDurationMs: 100,
  maxDurationMs: 1200,
  recipesPerRoll: 4,
  params: 16,
}

/** A recipe from its JSON form, with defaults filled in. */
export function diceEffectRecipe(json: Record<string, unknown>): DiceEffectRecipeValue {
  return DiceEffectRecipe.deserialize(json) as DiceEffectRecipeValue
}

function bounds(message: string, path: string): ShardError {
  return new ShardError('dice/recipe-bounds', message, {
    path,
    hint: `Recipes hold at most ${RECIPE_LIMITS.conditions} conditions and ${RECIPE_LIMITS.effects} effects; bursts ${RECIPE_LIMITS.particles} particles; durations ${RECIPE_LIMITS.minDurationMs}–${RECIPE_LIMITS.maxDurationMs} ms; scene params ${RECIPE_LIMITS.params} keys.`,
  })
}

/** A recipe's problems, each with a path into it. */
export function recipeProblems(recipe: DiceEffectRecipeValue): ShardError[] {
  const out: ShardError[] = []
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(recipe.id))
    out.push(
      new ShardError('dice/invalid-recipe', `Recipe id "${recipe.id}" isn't a lowercase id`, {
        path: '/id',
      }),
    )
  if (recipe.conditions.length > RECIPE_LIMITS.conditions)
    out.push(
      bounds(`Recipe "${recipe.id}" has ${recipe.conditions.length} conditions`, '/conditions'),
    )
  if (recipe.effects.length < 1 || recipe.effects.length > RECIPE_LIMITS.effects)
    out.push(bounds(`Recipe "${recipe.id}" has ${recipe.effects.length} effects`, '/effects'))
  recipe.effects.forEach((e, i) => {
    const path = `/effects/${i}`
    if (e.kind === 'particle-burst') {
      if (e.count < 1 || e.count > RECIPE_LIMITS.particles)
        out.push(bounds(`A burst of ${e.count} particles`, `${path}/count`))
      if (e.colors.length < 1 || e.colors.length > RECIPE_LIMITS.colors)
        out.push(bounds(`A burst with ${e.colors.length} colors`, `${path}/colors`))
    }
    if (e.kind === 'light-pulse' || e.kind === 'particle-burst' || e.kind === 'lens-pulse') {
      if (e.durationMs < RECIPE_LIMITS.minDurationMs || e.durationMs > RECIPE_LIMITS.maxDurationMs)
        out.push(bounds(`A ${e.durationMs} ms ${e.kind}`, `${path}/durationMs`))
    }
    if (e.kind === 'attachment' && !e.attachment)
      out.push(
        new ShardError('dice/invalid-recipe', 'An attachment effect names no attachment', {
          path: `${path}/attachment`,
        }),
      )
    if (e.kind === 'entrance' && !e.entrance)
      out.push(
        new ShardError('dice/invalid-recipe', 'An entrance effect names no entrance', {
          path: `${path}/entrance`,
        }),
      )
    const params = e.params as Record<string, unknown> | null
    if (params && typeof params === 'object' && Object.keys(params).length > RECIPE_LIMITS.params)
      out.push(bounds(`Params with ${Object.keys(params).length} keys`, `${path}/params`))
  })
  return out
}

/** Whether a physical die meets a die condition. */
function dieMatches(c: DiceCondition, d: PhysicalDie): boolean {
  if (c.die !== 'any' && c.die !== d.kind) return false
  if (c.value !== 0 && c.value !== d.rolled) return false
  if (c.face && c.face !== d.label) return false
  if (c.state === 'kept' && d.dropped) return false
  if (c.state === 'dropped' && !d.dropped) return false
  if (c.rank === 'high' && !d.high) return false
  if (c.rank === 'low' && !d.low) return false
  return true
}

function conditionMatches(c: DiceCondition, roll: DiceRoll, dice: readonly PhysicalDie[]): boolean {
  switch (c.kind) {
    case 'total':
      if (roll.total === undefined) return false
      return c.compare === 'eq'
        ? roll.total === c.total
        : c.compare === 'gte'
          ? roll.total >= c.total
          : roll.total <= c.total
    case 'source': {
      if (!roll.source) return false
      const who = roll.source.mine ? 'mine' : roll.source.gm ? 'gm' : 'other'
      return who === c.source
    }
    case 'tag':
      return roll.tags?.includes(c.tag) ?? false
    default:
      return dice.some((d) => dieMatches(c, d))
  }
}

/** A recipe that matched, and the dice its effects play on. */
export interface MatchedRecipe {
  recipe: DiceEffectRecipeValue
  /**
   * Kept dice its effects anchor to: those meeting a die condition, or every kept die when it has
   * none. Dropped dice never anchor effects, though conditions can match `state: 'dropped'`.
   */
  anchors: number[]
}

/**
 * The recipes that play for a roll: each distinct one (by id) whose conditions match, at most 4.
 * `degraded` says a bound refused more.
 */
export function matchRecipes(
  recipes: readonly DiceEffectRecipeValue[],
  roll: DiceRoll,
  dice: readonly PhysicalDie[],
): { matched: MatchedRecipe[]; degraded: boolean } {
  const unique = new Map<string, DiceEffectRecipeValue>()
  for (const r of recipes) if (!unique.has(r.id)) unique.set(r.id, r)
  const matched: MatchedRecipe[] = []
  let degraded = false
  for (const recipe of unique.values()) {
    const cs = recipe.conditions
    const ok =
      cs.length === 0 ||
      (recipe.match === 'all'
        ? cs.every((c) => conditionMatches(c, roll, dice))
        : cs.some((c) => conditionMatches(c, roll, dice)))
    if (!ok) continue
    if (matched.length >= RECIPE_LIMITS.recipesPerRoll) {
      degraded = true
      continue
    }
    const dieConditions = cs.filter((c) => c.kind === 'die')
    const anchors: number[] = []
    dice.forEach((d, i) => {
      if (d.dropped) return
      if (dieConditions.length === 0 || dieConditions.some((c) => dieMatches(c, d))) anchors.push(i)
    })
    matched.push({ recipe, anchors })
  }
  return { matched, degraded }
}
