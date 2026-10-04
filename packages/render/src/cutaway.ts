import { defineComponent, defineResource, type Entity, t } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { Camera3d } from './camera'

// Cutaways (0070). The components are core; the pass variants are `cutawayPlugin`, which
// forwardPlugin includes. Without it, a Cutaway renderable logs render/feature-missing once and
// draws whole.

/** Reveal points a camera can have; more are ignored with `render/too-many-reveal-points`. */
export const MAX_REVEAL_POINTS = 16

export const Cutaway = defineComponent(
  'render/Cutaway',
  {},
  {
    description:
      "Tag on a renderable: it may be cut away around a camera's reveal points (CutawayView). Shadows never cut.",
  },
)

export const CutawayView = defineComponent(
  'render/CutawayView',
  {
    points: t.list(t.vec3, {
      description: `World points to reveal, at most ${MAX_REVEAL_POINTS}: a token's position, the party.`,
    }),
    radius: t.f32({
      default: 2.5,
      min: 0,
      unit: 'm',
      description: "How far from each point's line of sight a Cutaway surface is cut.",
    }),
    margin: t.f32({
      default: 0.6,
      min: 0,
      unit: 'm',
      description:
        'How far in front of a point the cut starts, so the floor it stands on, and a stairwell rim, stay.',
    }),
    edge: t.f32({
      default: 0.3,
      min: 0,
      unit: 'm',
      description: 'Width of the dithered rim; 0 is a hard cut.',
    }),
  },
  {
    description:
      'Cuts Cutaway surfaces away between this camera and its reveal points (0070): a disc in a roof from above, a hole in a wall at an angle. Every camera pass (picking too) sees the hole; shadows do not.',
    requires: [Camera3d],
  },
)

/**
 * Set by `cutawayPlugin`: what the camera passes need to draw the cutaway variants of pipelines.
 * Forward asks it per view, so core imports no cutaway code.
 */
export interface CutawaySupport {
  /** The bind group layout cutaway pipelines take at group 3. */
  layout(gpu: GpuContext): GPUBindGroupLayout
  /** The camera's reveal points, bound at group 3: undefined when it has none this frame. */
  bindGroup(gpu: GpuContext, camera: Entity): GPUBindGroup | undefined
  /**
   * Whether a point of the camera can cut an instance of the batch this frame: its bounds reach a
   * reveal cylinder. The others draw the plain variant (no discard, so no per-fragment cost).
   */
  cuts(camera: Entity, batch: number): boolean
}

export const CutawayPath = defineResource<CutawaySupport>('render/CutawayPath', {
  description: 'Present when cutaways (cutawayPlugin) are installed.',
})
