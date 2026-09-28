import { defineAssetPreview } from '@aethervtt/shard-assets'

/**
 * A clip on its model (the source file's scene) at 5 evenly spaced times, left to right, in a
 * private world that shares the game's GPU and asset stores. Property clips have no model.
 */
export const animationClipPreview = defineAssetPreview(
  'AnimationClip',
  async (world, path, width, height) => {
    // The preview renders in an app of its own; its code loads only when a preview is asked for.
    const { renderClipPreview } = await import('./preview-render')
    return renderClipPreview(world, path, width, height)
  },
)
