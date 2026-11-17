import { FixedUpdate, PostUpdate, PreUpdate } from '@aethervtt/shard-core'
import {
  addRenderFeatures,
  Gpu,
  Graph,
  registerShaders,
  ShaderGlobals,
  Shaders,
  SkyOcclusion,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import { SkyFrame, updateSky } from './celestial'
import { Clock, updateClock } from './clock'
import { Clouds, Sky, TimeOfDay } from './components'
import { advectClouds, CloudMotion, uploadOcclusion } from './motion'
import {
  bindActivity,
  celestialNode,
  cloudsCompositeNode,
  cloudsMarchNode,
  SkyGpuResource,
} from './render'
import { OCCLUSION_SLOTS, occlusionShaders, SKY_SHADERS } from './shaders'

/**
 * Sky and time of day (0130) and clouds (0131): the clock, the sun and moon lights, stars, the moon
 * and aurora over the atmosphere's sky, volumetric clouds, and cloud shadows. Needs the forward
 * renderer (and its atmosphere); reads wind/Wind when the wind plugin is installed.
 */
export const skyPlugin = definePlugin({
  name: 'sky',
  dependencies: ['render/forward'],
  provides: [Sky, Clouds, TimeOfDay, Clock, SkyFrame, CloudMotion, SkyGpuResource],
  build(app) {
    const world = app.world
    world.initResource(TimeOfDay)
    world.initResource(Clock)
    world.initResource(SkyFrame)
    world.initResource(CloudMotion)
    world.initResource(SkyGpuResource)
    app.addSystems(PreUpdate, updateClock)
    app.addSystems(FixedUpdate, advectClouds)
    app.addSystems(PostUpdate, updateSky.before(TransformSystems), uploadOcclusion)
  },
  ready(app) {
    const world = app.world
    const shaders = world.tryResource(Shaders)
    const globals = world.tryResource(ShaderGlobals)
    if (!shaders || !globals) return
    const motion = world.resource(CloudMotion)
    motion.slot = globals.reserve('sky', OCCLUSION_SLOTS)
    registerShaders(shaders, { ...SKY_SHADERS, ...occlusionShaders(motion.slot) })
    // Cloud shadows need compute for nothing: the occlusion is analytic, on both tiers.
    world.initResource(SkyOcclusion).enabled = true
    if (world.resource(Gpu).tier !== 'full') return
    bindActivity(world)
    addRenderFeatures(world, {
      name: 'sky',
      description: 'Stars, the moon and aurora over the sky (0130); volumetric clouds (0131).',
      nodes: ['sky/clouds-march', 'sky/celestial', 'sky/clouds'],
      baseline: 'unsupported',
      components: [Sky, Clouds],
    })
    const graph = world.resource(Graph)
    graph.addNode('sky/clouds-march', cloudsMarchNode())
    graph.addNode('sky/celestial', celestialNode())
    graph.addNode('sky/clouds', cloudsCompositeNode())
  },
})
