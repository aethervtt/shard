import { onRemove, PostUpdate } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { propagateTransforms, TransformSystems } from '@aethervtt/shard-transform'
import * as animatorModule from './animator'
import { Animator, AnimatorStateResource, evaluateGraphs, forgetAnimator } from './animator'
import * as clipModule from './clip'
import { AnimationClips } from './clip'
import * as componentsModule from './components'
import { AnimationMasks, AnimationPlayer } from './components'
import * as graphModule from './graph'
import { AnimationGraphs } from './graph'
import * as ikModule from './ik'
import {
  ChainIk,
  FootPlacement,
  forgetSolver,
  IK_KINDS,
  IkStateResource,
  LookAtIk,
  solveIk,
  TwoBoneIk,
} from './ik'
import { animationMethods } from './methods'
import * as playerModule from './player'
import { AnimationStateResource, forgetBinding, sampleAnimations } from './player'
import * as previewModule from './preview'
import * as retargetModule from './retarget'
import { JointMaps } from './retarget'
import * as socketModule from './socket'
import { Attach, AttachStateResource, attachToSockets, forgetAttachment } from './socket'

/**
 * Animation players (clips sampled onto joints and fields, blended, with root motion and events),
 * the animation graphs that drive them, retargeting, IK on the result, and socket attachments.
 */
export const animationPlugin = definePlugin({
  name: 'animation',
  provides: [
    animatorModule,
    clipModule,
    componentsModule,
    graphModule,
    ikModule,
    playerModule,
    previewModule,
    retargetModule,
    socketModule,
  ],
  dependencies: ['core/transform'],
  build(app) {
    const w = app.world
    w.initResource(AnimationClips)
    w.initResource(AnimationMasks)
    w.initResource(AnimationStateResource)
    w.initResource(AnimationGraphs)
    w.initResource(AnimatorStateResource)
    w.initResource(JointMaps)
    w.initResource(IkStateResource)
    w.initResource(AttachStateResource)
    w.observe(onRemove(AnimationPlayer), ({ entity, world }) => forgetBinding(world, entity))
    w.observe(onRemove(Animator), ({ entity, world }) => forgetAnimator(world, entity))
    w.observe(onRemove(TwoBoneIk), ({ entity, world }) => forgetSolver(world, IK_KINDS.two, entity))
    w.observe(onRemove(LookAtIk), ({ entity, world }) => forgetSolver(world, IK_KINDS.look, entity))
    w.observe(onRemove(ChainIk), ({ entity, world }) => forgetSolver(world, IK_KINDS.chain, entity))
    w.observe(onRemove(FootPlacement), ({ entity, world }) =>
      forgetSolver(world, IK_KINDS.feet, entity),
    )
    w.observe(onRemove(Attach), ({ entity, world }) => forgetAttachment(world, entity))
    app.addSystems(PostUpdate, evaluateGraphs.before(sampleAnimations))
    app.addSystems(PostUpdate, sampleAnimations.before(TransformSystems))
    app.addSystems(PostUpdate, attachToSockets.after(sampleAnimations).before(TransformSystems))
    // IK solves the propagated pose and re-propagates what it changes, inside the transform set so
    // everything ordered after TransformSystems sees the final pose.
    app.addSystems(PostUpdate, solveIk.inSet(TransformSystems).after(propagateTransforms))
    app.addMethod(...animationMethods)
  },
})
