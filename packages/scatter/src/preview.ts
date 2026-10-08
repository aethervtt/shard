import { defineAssetPreview } from '@aethervtt/shard-assets'

/**
 * A ScatterSet on a 64 m test patch (spec 0045), from above and at eye level (`options.view`:
 * 'top', 'eye', or both side by side). `asset.preview` and `procgen.preview` use it.
 */
export const scatterSetPreview = defineAssetPreview(
  'scatter/ScatterSet',
  async (world, path, width, height, options) => {
    // The preview renders in an app of its own; its code loads only when a preview is asked for.
    const { renderScatterPreview } = await import('./preview-render')
    return renderScatterPreview(world, path, width, height, options)
  },
)
