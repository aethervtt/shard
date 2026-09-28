import { Last } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { DeformPath, prepareInstances } from './instances'
import { RenderSet } from './plugin'
import { prepareDeforms, skeletonOverlay } from './skinning'

/**
 * Skinning and morph targets (spec 0034): SkinnedMesh and MorphWeights deform the meshes they're on,
 * and the skeleton overlay draws joints. Without it those meshes draw in their rest pose.
 */
export const skinningPlugin = definePlugin({
  name: 'render/skinning',
  provides: [skeletonOverlay],
  dependencies: ['render/forward'],
  build(app) {
    app
      .insertResource(DeformPath, { installed: true })
      .addSystems(Last, prepareDeforms.inSet(RenderSet.Prepare).after(prepareInstances))
  },
})
