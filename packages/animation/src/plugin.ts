import { onRemove, PostUpdate } from '@shard/core'
import { definePlugin } from '@shard/runtime'
import { TransformSystems } from '@shard/transform'
import { Animator, AnimatorStateResource, evaluateGraphs, forgetAnimator } from './animator'
import { AnimationClips } from './clip'
import { AnimationMasks, AnimationPlayer } from './components'
import { AnimationGraphs } from './graph'
import { animationMethods } from './methods'
import { AnimationStateResource, forgetBinding, sampleAnimations } from './player'

/**
 * Animation players (clips sampled onto joints and fields, blended, with root motion and events)
 * and the animation graphs that drive them.
 */
export const animationPlugin = definePlugin({
  name: 'animation',
  dependencies: ['core/transform'],
  build(app) {
    const w = app.world
    w.initResource(AnimationClips)
    w.initResource(AnimationMasks)
    w.initResource(AnimationStateResource)
    w.initResource(AnimationGraphs)
    w.initResource(AnimatorStateResource)
    w.observe(onRemove(AnimationPlayer), ({ entity, world }) => forgetBinding(world, entity))
    w.observe(onRemove(Animator), ({ entity, world }) => forgetAnimator(world, entity))
    app.addSystems(PostUpdate, evaluateGraphs.before(sampleAnimations))
    app.addSystems(PostUpdate, sampleAnimations.before(TransformSystems))
    app.addMethod(...animationMethods)
  },
})
