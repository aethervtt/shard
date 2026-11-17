import { defineResource } from '@aethervtt/shard-core'
import { VIEW_BINDINGS } from './view-bindings'

/**
 * Sky occlusion (0131): while `enabled`, lit pipelines link `SKY_OCCLUSION`, and the lighting stage
 * multiplies each directional light by `sky_occlusion(world, toward_light)` from the WGSL module
 * `shard::sky_occlusion`, which the plugin that sets this registers (the sky's cloud shadows).
 * Render owns the hook and never imports the sky.
 */
export interface SkyOcclusionValue {
  enabled: boolean
  /**
   * Surface weather (0134): while set, lit pipelines link `SURFACE_WEATHER`, and forward fragments
   * pass their surface through `surface_weather(p, in)` from `shard::surface_weather`, which the
   * plugin that sets this registers. Set before the first frame; it doesn't change at runtime.
   */
  surface: boolean
  /**
   * A map the module may sample at `SKY_OCCLUSION_BINDING` of the view group (full tier only; a
   * white texture until set). Swap the view to rebind it.
   */
  map: GPUTextureView | undefined
}

/** The view group's binding for SkyOcclusion.map, while the hook is on (full tier). */
export const SKY_OCCLUSION_BINDING = VIEW_BINDINGS.skyOcclusion

export const SkyOcclusion = defineResource<SkyOcclusionValue>('render/SkyOcclusion', {
  description:
    'Cloud shadows on directional lights (0131): set enabled when shard::sky_occlusion is registered.',
  init: () => ({ enabled: false, surface: false, map: undefined }),
})
