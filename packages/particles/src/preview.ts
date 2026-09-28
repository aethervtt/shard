import { defineAssetPreview } from '@aethervtt/shard-assets'

/** An effect after one second of seeded, fixed-step simulation, in a private world. */
export const particleEffectPreview = defineAssetPreview(
  'ParticleEffect',
  async (world, path, width, height) => {
    // The preview renders in an app of its own; its code loads only when a preview is asked for.
    const { renderEffectPreview } = await import('./preview-render')
    return renderEffectPreview(world, path, width, height)
  },
)
