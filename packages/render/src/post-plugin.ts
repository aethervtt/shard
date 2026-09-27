import { PostUpdate } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { applyPhysicalCameras } from './camera'
import { RenderDescribers, Shaders } from './plugin'
import { PostEffect, PostFeatures } from './post'
import { adaptExposure, addPostNodes, describePost, ExposureMeters } from './post-nodes'
import { POST_SHADERS } from './post-shaders'
import { registerShaders } from './shaders'

/** The effects postPlugin runs. FXAA is fxaaPlugin; grading and vignette are the tonemap's. */
const POST_EFFECTS =
  PostEffect.Fog |
  PostEffect.Taa |
  PostEffect.MotionBlur |
  PostEffect.DepthOfField |
  PostEffect.Bloom |
  PostEffect.AutoExposure |
  PostEffect.Ssao

/**
 * Post-processing (spec 0023): the prepass, SSAO, fog, TAA, motion blur, depth of field, bloom, and
 * auto exposure, for the cameras that have their components.
 */
export const postPlugin = definePlugin({
  name: 'render/post',
  dependencies: ['render/forward'],
  provides: [ExposureMeters],
  build(app) {
    app.world.initResource(PostFeatures).effects |= POST_EFFECTS
    app.addSystems(PostUpdate, adaptExposure.after(applyPhysicalCameras))
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), POST_SHADERS)
    app.world.initResource(RenderDescribers).set('post', (world) => describePost(world))
    addPostNodes(app.world)
  },
})
