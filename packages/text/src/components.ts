import { defineComponent, t } from '@shard/core'
import { Visibility } from '@shard/render'
import { Transform } from '@shard/transform'

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const

/** Fields shared by world and screen text. */
const textFields = {
  value: t.string({ description: 'The text. "\\n" breaks a line.' }),
  font: t.handle('Font', { description: 'An imported font (.ttf, .otf).' }),
  color: t.color({ default: [1, 1, 1, 1], description: 'Fill color (linear).' }),
  align: t.enum(TEXT_ALIGNS, { description: 'Line alignment within the block.' }),
  anchor: t.vec2({
    default: [0.5, 0.5],
    description: 'Pivot of the text block, y up: [0, 0] bottom left, [1, 1] top right.',
  }),
  maxWidth: t.f32({ min: 0, description: 'Wrap lines longer than this (0: never wrap).' }),
  lineHeight: t.f32({
    default: 1.2,
    min: 0.1,
    description: 'Distance between baselines, as a multiple of the size.',
  }),
  weight: t.f32({
    min: -0.25,
    max: 0.25,
    description: 'Thickens (+) or thins (−) the strokes, in em fractions of the distance range.',
  }),
  outline: t.struct(
    {
      width: t.f32({
        min: 0,
        max: 0.25,
        description:
          "Outline thickness, in em (0: none). At most about half the font's distance range: range ÷ (2 × atlas size), 0.04 em at the defaults.",
      }),
      color: t.color({ default: [0, 0, 0, 1], description: 'Outline color (linear).' }),
    },
    { description: 'An outline around the glyphs, from the distance field.' },
  ),
  shadow: t.struct(
    {
      offset: t.vec2({ description: 'Shadow offset in em, y up (0, 0 with softness: a glow).' }),
      softness: t.f32({
        min: 0,
        max: 1,
        description: 'Blur of the shadow (0: none unless offset).',
      }),
      color: t.color({ default: [0, 0, 0, 0.6], description: 'Shadow color (linear, alpha).' }),
    },
    { description: 'A soft shadow or glow behind the glyphs.' },
  ),
}

export const Text = defineComponent(
  'text/Text',
  {
    ...textFields,
    size: t.f32({
      default: 1,
      min: 0,
      unit: 'm',
      description: 'Height of one em, in world units.',
    }),
    billboard: t.bool({ description: 'Always face the camera (labels, markers).' }),
  },
  {
    description:
      "Text in the world, in the entity's XY plane (or facing the camera): MSDF glyphs, sharp at any size and angle.",
    requires: [Transform, Visibility],
  },
)

export const SCREEN_CORNERS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const

export const ScreenText = defineComponent(
  'text/ScreenText',
  {
    ...textFields,
    size: t.f32({ default: 24, min: 0, description: 'Height of one em, in pixels.' }),
    corner: t.enum(SCREEN_CORNERS, {
      description: "The view point it's positioned from.",
    }),
    position: t.vec2({ description: 'Offset from the corner in pixels, x right, y down.' }),
  },
  {
    description:
      'Text over the finished image (after tonemapping), placed in pixels from a view corner.',
    requires: [Visibility],
  },
)
