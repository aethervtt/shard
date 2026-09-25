import { defineComponent, defineResource, t } from '@shard/core'
import { Visibility } from '@shard/render'
import { Transform } from '@shard/transform'

/** The sprite's slot in the sprite renderer's persistent buffer. Managed by the renderer. */
export const SpriteSlot = defineComponent(
  'sprite/SpriteSlot',
  {
    slot: t.u32({ readonly: true, description: 'Slot + 1 (0 = none yet).' }),
  },
  {
    description: "The sprite's slot in the renderer's sprite buffer. Do not write.",
    serialize: false,
  },
)

export const SPRITE_BLENDS = ['alpha', 'additive', 'opaque'] as const
export const SPRITE_SPACES = ['world', 'screen'] as const

export const Sprite = defineComponent(
  'sprite/Sprite',
  {
    texture: t.handle('Texture', {
      description: 'The image to draw (ignored when atlas and region are set).',
    }),
    atlas: t.handle('TextureAtlas', { description: 'An atlas to draw a region of.' }),
    region: t.string({ description: 'Atlas region name, e.g. "hero/idle_0".' }),
    color: t.color({ default: [1, 1, 1, 1], description: 'Tint, multiplied in (linear).' }),
    flipX: t.bool({ description: 'Mirror left to right.' }),
    flipY: t.bool({ description: 'Mirror top to bottom.' }),
    anchor: t.vec2({
      default: [0.5, 0.5],
      description:
        "Pivot in normalized sprite space (0, 0 top left): where the entity's position sits. An atlas region with its own pivot (not the center) uses that instead.",
    }),
    size: t.vec2({
      min: 0,
      unit: 'm',
      description:
        'World size. Zero: the image (or region) size in pixels ÷ Sprite2dSettings.pixelsPerUnit. Screen sprites: pixels.',
    }),
    layer: t.i16({
      description:
        'Draw-order band: higher draws over lower. Within a band, sprites sort by Sprite2dSettings.sort.',
    }),
    blend: t.enum(SPRITE_BLENDS, {
      description:
        'alpha: premultiplied blending, sorted. additive: glows. opaque: alpha-tested at 0.5, writes depth, no sorting needed.',
    }),
    space: t.enum(SPRITE_SPACES, {
      description:
        "world: in the scene, under post-processing (lit by 2D lights under a Lighting2d camera). screen: an overlay after tonemapping, positioned in pixels from the view's top left.",
    }),
    lit: t.bool({
      default: true,
      description:
        'Lit by 2D lights under a Lighting2d camera. Off: drawn at its own color (UI, glowing effects).',
    }),
  },
  {
    description:
      "A textured quad in the entity's XY plane: a texture or an atlas region, tinted, flipped, and anchored.",
    requires: [Transform, Visibility, SpriteSlot],
  },
)

export const SPRITE_SORTS = ['z', 'y'] as const

export interface Sprite2dSettingsValue {
  pixelsPerUnit: number
  sort: (typeof SPRITE_SORTS)[number]
}

export const Sprite2dSettings = defineResource<Sprite2dSettingsValue>('sprite/Sprite2dSettings', {
  description:
    "Sprite defaults: pixelsPerUnit (image pixels per world unit for sprites without a size, default 100) and sort within a layer: 'z' (higher z over lower) or 'y' (lower y over higher, for top-down scenes).",
  init: () => ({ pixelsPerUnit: 100, sort: 'z' }),
})
