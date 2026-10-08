import { defineResource } from '@aethervtt/shard-core'
import type { NodeContext } from './graph'
import type { CameraData } from './view'

/**
 * What the forward passes ask of GPU foliage (0045, `foliagePlugin`): draw a camera's visible
 * foliage into its opaque or G-buffer pass, and its shadow casters into a cascade. The core only
 * holds this hook; the instances, placement, culling and pipelines live in the plugin.
 */
export interface FoliageSupport {
  /** Draws into the open pass; `pass` is PASS_OPAQUE or PASS_GBUFFER. */
  draw(ctx: NodeContext, cam: CameraData, pass: number, renderPass: GPURenderPassEncoder): void
  /**
   * Draws shadow casters into a cascade layer's open pass (its view at `offset`). Foliage casts
   * into the nearest cascade only.
   */
  drawShadow(
    ctx: NodeContext,
    cam: CameraData,
    renderPass: GPURenderPassEncoder,
    offset: number,
    cascade: number,
  ): void
  /** Whether a camera's nearest cascade must redraw this frame (foliage sways: cached ones go stale). */
  animatedShadows(cam: CameraData): boolean
}

export const FoliagePath = defineResource<FoliageSupport>('render/FoliagePath', {
  description: 'Present when GPU foliage (foliagePlugin) is installed.',
})
