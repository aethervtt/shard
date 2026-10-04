import { defineComponent, defineResource, onAdd, t, type World } from '@aethervtt/shard-core'
import { warnFeatureMissing } from './features'

// Selection and hover outlines (0057). The component is core; the pass is `outlinePlugin`, which
// forwardPlugin includes. Without it, an Outline logs render/feature-missing and draws nothing.

export const OUTLINE_OCCLUSION = ['hide', 'show', 'dim'] as const

export const Outline = defineComponent(
  'render/Outline',
  {
    color: t.color({
      default: [1, 0.78, 0.2, 1],
      description: 'Outline color (linear), with alpha.',
    }),
    width: t.f32({
      default: 2,
      min: 0,
      max: 32,
      unit: 'px',
      description: 'Width in CSS pixels, outside the silhouette, at any zoom and display density.',
    }),
    occluded: t.enum(OUTLINE_OCCLUSION, {
      description:
        'Where something hides the outlined object: hide the outline there, show it anyway, or dim it.',
    }),
  },
  {
    description:
      'Outlines a renderable, or every renderable under this entity. Selection and hover are two Outlines with different colors; the host sets and clears them.',
  },
)

/** Set by `outlinePlugin`: Outlines draw. */
export const OutlinePath = defineResource<{ installed: true }>('render/OutlinePath', {
  description: 'Present when the outline pass is installed.',
})

/** Outline styles a view can draw at once (they ride in the visible entries' top 4 bits). */
export const MAX_OUTLINE_STYLES = 16

/** Warns once per world about an Outline without the outline pass (render/feature-missing). */
export function observeOutlinesWithoutPass(world: World): void {
  world.observe(onAdd(Outline), ({ world: w }) => {
    if (!w.hasResource(OutlinePath))
      warnFeatureMissing(w, 'An entity has Outline', 'outlinePlugin', 'it draws no outline')
  })
}
