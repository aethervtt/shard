import { defineDataType } from '@aethervtt/shard-assets'
import { type AssetRef, type FieldValue, type Infer, ShardError, t } from '@aethervtt/shard-core'
import { DIE_KINDS, type DieKind, KIND_DEFINITIONS } from './builtins'
import { requireDie } from './definition'
import type { DiceEffectRecipeValue } from './effects'
import { recipeProblems } from './effects'
import { defaultLayoutFor, type FaceLayoutValue, layoutProblems } from './layout'
import { findDiceFamily } from './material'

// Skins (0054): data that binds a die's look together. A family (a registered material), its
// parameters, per-kind variants (layout, bevel, parameters), sounds and effect recipes. Skins
// reference registered definitions and families only: the host decides which skins exist.

const VARIANT = t.struct(
  {
    layout: t.handle('dice/FaceLayout', {
      description: 'The face layout; null prints numbers (pips on a d6).',
    }),
    bevel: t.f32({ min: 0, max: 0.3, description: "Chamfer; 0 keeps the definition's." }),
    params: t.json({
      default: {},
      description: 'Family parameters for this kind, over the skin’s.',
    }),
  },
  { description: 'What changes for one kind of die.' },
)

export const IMPACT_SOUNDS = ['resin', 'metal', 'wood', 'glass'] as const
export type ImpactSound = (typeof IMPACT_SOUNDS)[number]

/** A dice skin: `data/**\/*.dice-skin.json`. */
export const DiceSkin = defineDataType(
  'dice/DiceSkin',
  {
    version: t.u8({ default: 1, min: 1, max: 1, description: 'Format version: 1.' }),
    id: t.string({ description: 'A name for tools and errors.' }),
    family: t.string({
      default: 'dice/SolidDice',
      description: 'The dice family (a material type defined with defineDiceFamily).',
    }),
    params: t.json({
      default: {},
      description:
        "The family's parameters: standard fields (baseColor, roughness…), dice fields (markColor, edgeColor…) and its own. Validated against the family's schema.",
    }),
    variants: t.struct(
      Object.fromEntries(DIE_KINDS.map((k) => [k, VARIANT])) as Record<DieKind, typeof VARIANT>,
      { description: 'Per kind: layout, bevel and parameters.' },
    ),
    sounds: t.struct(
      {
        impact: t.enum(IMPACT_SOUNDS, { description: 'What contacts sound like.' }),
        accent: t.enum(['', 'resin-chime', 'arcane-spark', 'void-whump'], {
          description: 'A cue played when the dice land (with effects on). Empty: none.',
        }),
      },
      { description: 'Sounds.' },
    ),
    effects: t.list(t.handle('dice/DiceEffectRecipe'), {
      description: 'Effect recipes, at most 4.',
    }),
  },
  {
    extension: 'dice-skin',
    description: 'A dice skin: family, parameters, variants, sounds, effects.',
  },
)

export type DiceSkinValue = Infer<typeof DiceSkin>
export type DiceSkinVariant = FieldValue<typeof VARIANT>

/** Parameters the package sets itself; a skin can't. */
const RESERVED = ['marks', 'dropped', 'fade', 'result', 'resultTime', 'alphaMode']
export const MAX_SKIN_EFFECTS = 4

export interface SkinContext {
  layout?: (ref: AssetRef) => FaceLayoutValue | undefined
  recipe?: (ref: AssetRef) => DiceEffectRecipeValue | undefined
}

function checkParams(family: string, params: unknown, path: string, out: ShardError[]): void {
  const f = findDiceFamily(family)
  if (!f) return
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    out.push(
      new ShardError('dice/invalid-skin', `${path} must be an object of parameters`, { path }),
    )
    return
  }
  for (const key of Object.keys(params)) {
    if (RESERVED.includes(key)) {
      out.push(
        new ShardError(
          'dice/reserved-param',
          `${path}/${key} is set by the package, not by skins`,
          {
            path: `${path}/${key}`,
            hint: 'Dropped dice, fades and results are the presentation’s; the mark atlas is baked from the layout.',
          },
        ),
      )
    }
  }
  for (const err of f.type.schema.validate(params)) {
    out.push(
      new ShardError(err.code, err.message, {
        path: `${path}${err.path && err.path !== '/' ? err.path : ''}`,
        hint: err.hint ?? `Parameters of ${family}.`,
      }),
    )
  }
}

/**
 * Everything wrong with a skin, each error with a path into it: an unknown family
 * (`dice/unknown-family`), parameters its family doesn't have, a layout that can't show a value
 * of its kind (`dice/layout-missing-value`), more than 4 recipes, or a recipe over its bounds
 * (`dice/recipe-bounds`). Layouts and recipes resolve through `ctx`.
 */
export function validateDiceSkin(skin: DiceSkinValue, ctx: SkinContext = {}): ShardError[] {
  const out: ShardError[] = []
  for (const err of DiceSkin.validate(DiceSkin.serialize(skin as never) as never)) out.push(err)
  const family = findDiceFamily(skin.family)
  if (!family) {
    out.push(
      new ShardError(
        'dice/unknown-family',
        `Skin "${skin.id}" names family "${skin.family}", which isn't defined`,
        {
          path: '/family',
          hint: 'Families: dice/SolidDice, dice/ResinDice, dice/MetalDice, dice/GlassDice, and those the host defines with defineDiceFamily.',
        },
      ),
    )
  } else {
    checkParams(skin.family, skin.params, '/params', out)
  }
  for (const kind of DIE_KINDS) {
    const variant = skin.variants[kind]
    if (family) checkParams(skin.family, variant.params, `/variants/${kind}/params`, out)
    if (variant.layout) {
      const layout = ctx.layout?.(variant.layout)
      if (!layout) {
        out.push(
          new ShardError(
            'dice/unknown-layout',
            `Skin "${skin.id}": the ${kind} layout isn't loaded`,
            {
              path: `/variants/${kind}/layout`,
            },
          ),
        )
        continue
      }
      for (const id of KIND_DEFINITIONS[kind]) {
        for (const err of layoutProblems(layout, requireDie(id))) {
          out.push(
            new ShardError(err.code, err.message, {
              path: `/variants/${kind}/layout${err.path ?? ''}`,
              hint: err.hint,
            }),
          )
        }
      }
    }
  }
  if (skin.effects.length > MAX_SKIN_EFFECTS) {
    out.push(
      new ShardError(
        'dice/recipe-bounds',
        `Skin "${skin.id}" has ${skin.effects.length} effect recipes; at most ${MAX_SKIN_EFFECTS}`,
        {
          path: '/effects',
        },
      ),
    )
  }
  skin.effects.forEach((ref, i) => {
    const recipe = ref ? ctx.recipe?.(ref) : undefined
    if (!recipe) {
      out.push(
        new ShardError(
          'dice/unknown-recipe',
          `Skin "${skin.id}": effect recipe ${i} isn't loaded`,
          {
            path: `/effects/${i}`,
          },
        ),
      )
      return
    }
    for (const err of recipeProblems(recipe)) {
      out.push(
        new ShardError(err.code, err.message, {
          path: `/effects/${i}${err.path ?? ''}`,
          hint: err.hint,
        }),
      )
    }
  })
  return out
}

/** A skin from its JSON form (files, or objects written like them), with defaults filled in. */
export function diceSkin(json: Record<string, unknown>): DiceSkinValue {
  return DiceSkin.deserialize(json) as DiceSkinValue
}

/** The layout a skin prints on a kind, and its bevel. */
export function skinVariant(
  skin: DiceSkinValue,
  kind: DieKind,
  definition: string,
  layouts: (ref: AssetRef) => FaceLayoutValue | undefined,
): { layout: FaceLayoutValue; bevel: number | undefined; params: Record<string, unknown> } {
  const variant = skin.variants[kind]
  const layout =
    (variant.layout ? layouts(variant.layout) : undefined) ??
    defaultLayoutFor(requireDie(definition))
  return {
    layout,
    bevel: variant.bevel > 0 ? variant.bevel : undefined,
    params: { ...(skin.params as object), ...(variant.params as object) },
  }
}

// --- built-in skins ----------------------------------------------------------------------------

const skinRef = (id: string): AssetRef<'dice/DiceSkin'> => ({
  type: 'dice/DiceSkin',
  guid: `dice:skin/${id}`,
  path: `dice:skin/${id}`,
})

/** Skins the package ships, one or two per family, for previews, tests and quick starts. */
export const DICE_SKINS = {
  ivory: skinRef('ivory'),
  obsidian: skinRef('obsidian'),
  teal: skinRef('teal'),
  ember: skinRef('ember'),
  brass: skinRef('brass'),
  frost: skinRef('frost'),
} as const

export const BUILTIN_SKINS: Readonly<Record<keyof typeof DICE_SKINS, Record<string, unknown>>> = {
  ivory: {
    id: 'ivory',
    family: 'dice/SolidDice',
    params: {
      baseColor: '#efe6d2',
      roughness: 0.42,
      markColor: '#1f1a14',
      markRoughness: 0.7,
      edgeColor: '#fff8ea',
      edgeMix: 0.35,
      fleck: 0.18,
      fleckColor: '#c9b89a',
    },
    sounds: { impact: 'resin' },
  },
  obsidian: {
    id: 'obsidian',
    family: 'dice/SolidDice',
    params: {
      baseColor: '#141318',
      roughness: 0.2,
      markColor: '#d9b45a',
      markMetallic: 1,
      markRoughness: 0.28,
      markDepth: 0.8,
      edgeColor: '#3a3642',
      edgeMix: 0.4,
      fleck: 0.3,
      fleckColor: '#5b5470',
    },
    sounds: { impact: 'resin' },
  },
  teal: {
    id: 'teal',
    family: 'dice/ResinDice',
    params: {
      baseColor: '#168c8c',
      roughness: 0.18,
      markColor: '#f4fff9',
      markRoughness: 0.5,
      edgeColor: '#37d8c9',
      edgeMix: 0.25,
      resinDeep: '#073f44',
      resinGlow: '#37d8c9',
    },
    sounds: { impact: 'resin', accent: 'resin-chime' },
  },
  ember: {
    id: 'ember',
    family: 'dice/ResinDice',
    params: {
      baseColor: '#b8321a',
      roughness: 0.2,
      markColor: '#fff1c9',
      markEmissive: 900,
      edgeColor: '#ff9a3c',
      edgeMix: 0.3,
      resinDeep: '#3a0703',
      resinGlow: '#ff8a2a',
      resinLight: 5200,
      resinSwirl: 0.75,
    },
    sounds: { impact: 'resin', accent: 'arcane-spark' },
  },
  brass: {
    id: 'brass',
    family: 'dice/MetalDice',
    params: {
      baseColor: '#d7a64a',
      roughness: 0.32,
      markColor: '#1b120a',
      markRoughness: 0.6,
      markDepth: 0.9,
      edgeColor: '#f6d68c',
      edgeMix: 0.2,
    },
    sounds: { impact: 'metal' },
  },
  frost: {
    id: 'frost',
    family: 'dice/GlassDice',
    params: {
      baseColor: '#9fd6ff',
      roughness: 0.05,
      markColor: '#ffffff',
      markEmissive: 400,
      markDepth: 0.3,
      edgeColor: '#e6f6ff',
      edgeMix: 0.5,
      glassClarity: 0.82,
    },
    sounds: { impact: 'glass', accent: 'resin-chime' },
  },
}
