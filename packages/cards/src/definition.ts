import { defineDataType } from '@aethervtt/shard-assets'
import { defineComponent, type Infer, ShardError, t } from '@aethervtt/shard-core'

const mask = t.struct({
  texture: t.handle('Texture'),
  channel: t.enum(['r', 'g', 'b', 'a']),
  space: t.enum(['face', 'art']),
  invert: t.bool(),
  scale: t.vec2({ default: [1, 1] }),
  offset: t.vec2(),
})
const layer = t.struct({
  family: t.string({ default: 'cards/rainbow' }),
  strength: t.f32({ default: 0.65, min: 0, max: 1 }),
  mask,
  parameters: t.json({ default: {} }),
})
const face = t.struct({
  art: t.handle('Texture'),
  fit: t.enum(['contain', 'cover', 'stretch']),
  background: t.color({ default: [0.025, 0.03, 0.045, 1] }),
  uvRect: t.vec4({ default: [0, 0, 1, 1] }),
  rotation: t.u8({ min: 0, max: 3 }),
  finishes: t.list(layer),
})

/** Data assets and runtime definitions use the same schema. */
export const CardDefinition = defineDataType(
  'cards/CardDefinition',
  {
    label: t.string(),
    size: t.vec2({ default: [0.063, 0.088], unit: 'm' }),
    cornerRadius: t.f32({ default: 0.003, min: 0, unit: 'm' }),
    thickness: t.f32({ default: 0.0003, min: 0, unit: 'm' }),
    edgeColor: t.color({ default: [0.26, 0.28, 0.34, 1] }),
    front: face,
    back: face,
  },
  {
    extension: 'card',
    description: 'Two-sided printed card with independently masked foil layers.',
  },
)

export type CardDefinitionValue = Infer<typeof CardDefinition>
export type CardFace = CardDefinitionValue['front']
export type CardFinishLayer = CardFace['finishes'][number]

export const CARD_SIZES = {
  poker: [0.063, 0.088],
  bridge: [0.057, 0.088],
  tarot: [0.07, 0.12],
} as const

export function cardDefinition(json: unknown): CardDefinitionValue {
  const value = CardDefinition.deserialize(json)
  if (
    value.size[0] <= 0 ||
    value.size[1] <= 0 ||
    value.cornerRadius > Math.min(value.size[0], value.size[1]) / 2
  ) {
    throw new ShardError(
      'cards/invalid-size',
      'Card dimensions must be positive and fit the corner radius',
      {
        path: '/size',
        hint: 'Use dimensions in metres; poker is [0.063, 0.088].',
      },
    )
  }
  if (value.front.finishes.length > 4 || value.back.finishes.length > 4) {
    throw new ShardError('cards/layer-limit', 'Each face supports up to four independent finishes')
  }
  return value
}

export const Card = defineComponent('cards/Card', {
  instanceId: t.string(),
  definition: t.handle('cards/CardDefinition'),
  seed: t.u32(),
  finishStrength: t.f32({ default: 1, min: 0, max: 2 }),
  enabled: t.bool({ default: true }),
})
export const CardTilt = defineComponent('cards/Tilt', {
  enabled: t.bool({ default: false }),
  maxDegrees: t.vec2({ default: [8, 8] }),
  responseSeconds: t.f32({ default: 0.12, min: 0 }),
  returnSeconds: t.f32({ default: 0.18, min: 0 }),
})
export const CardInteraction = defineComponent('cards/Interaction', {
  enabled: t.bool({ default: true }),
  draggable: t.bool({ default: false }),
})
