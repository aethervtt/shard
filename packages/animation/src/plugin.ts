import { onRemove, PostUpdate } from '@shard/core'
import { definePlugin } from '@shard/runtime'
import { TransformSystems } from '@shard/transform'
import { AnimationClips } from './clip'
import { AnimationMasks, AnimationPlayer } from './components'
import { animationMethods } from './methods'
import { AnimationStateResource, forgetBinding, sampleAnimations } from './player'

/** Animation players: clips sampled onto joints and fields, blended, with root motion and events. */
export const animationPlugin = definePlugin({
  name: 'animation',
  dependencies: ['core/transform'],
  build(app) {
    const w = app.world
    w.initResource(AnimationClips)
    w.initResource(AnimationMasks)
    w.initResource(AnimationStateResource)
    w.observe(onRemove(AnimationPlayer), ({ entity, world }) => forgetBinding(world, entity))
    app.addSystems(PostUpdate, sampleAnimations.before(TransformSystems))
    app.addMethod(...animationMethods)
  },
})
