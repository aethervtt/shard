import { defineResource } from '@aethervtt/shard-core'

/**
 * Sky occlusion (0131): while `enabled`, lit pipelines link `SKY_OCCLUSION`, and the lighting stage
 * multiplies each directional light by `sky_occlusion(world, toward_light)` from the WGSL module
 * `shard::sky_occlusion`, which the plugin that sets this registers (the sky's cloud shadows).
 * Render owns the hook and never imports the sky.
 */
export interface SkyOcclusionValue {
  enabled: boolean
  /**
   * A map the module may sample at `SKY_OCCLUSION_BINDING` of the view group (full tier only; a
   * white texture until set). Swap the view to rebind it.
   */
  map: GPUTextureView | undefined
}

/** The view group's binding for SkyOcclusion.map, while the hook is on (full tier). */
export const SKY_OCCLUSION_BINDING = 19

export const SkyOcclusion = defineResource<SkyOcclusionValue>('render/SkyOcclusion', {
  description:
    'Cloud shadows on directional lights (0131): set enabled when shard::sky_occlusion is registered.',
  init: () => ({ enabled: false, map: undefined }),
})
