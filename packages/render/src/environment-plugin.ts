import { Last } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import {
  DefaultEnvironment,
  describeEnvironment,
  EnvironmentMap,
  Environments,
  ProceduralSky,
  prepareEnvironments,
  runEnvironmentWork,
  Skybox,
} from './environment'
import { ENVIRONMENT_SHADERS } from './environment-shaders'
import { addRenderFeatures } from './features'
import { ForwardStateResource, isCamera, skyNode } from './forward'
import { RenderPhase } from './graph'
import { Gpu, Graph, RenderDescribers, RenderSet, Shaders } from './plugin'
import { registerShaders } from './shaders'

/**
 * Image-based lighting and skies (spec 0019): EnvironmentMap and DefaultEnvironment prefiltered on
 * the GPU, Skybox backgrounds, and ProceduralSky (drawn by atmospherePlugin). Without it, cameras
 * are lit by AmbientLight alone.
 */
export const environmentPlugin = definePlugin({
  name: 'render/environment',
  dependencies: ['render/forward'],
  provides: [DefaultEnvironment, EnvironmentMap, ProceduralSky, Skybox],
  build(app) {
    app.world.initResource(DefaultEnvironment)
    app.addSystems(Last, prepareEnvironments.inSet(RenderSet.Prepare))
  },
  async ready(app) {
    const world = app.world
    // The baseline tier prefilters with fragment passes (0064): loaded only on a baseline device.
    const baseline =
      world.resource(Gpu).tier === 'baseline' ? await import('./baseline/environment') : undefined
    registerShaders(world.resource(Shaders), ENVIRONMENT_SHADERS)
    if (baseline) {
      registerShaders(world.resource(Shaders), baseline.BASELINE_ENVIRONMENT_SHADERS)
      world.resource(Environments).baseline = baseline
    }
    world.initResource(RenderDescribers).set('environment', (w) => describeEnvironment(w))
    const graph = world.resource(Graph)
    addRenderFeatures(world, {
      name: 'render/environment',
      description:
        'Image-based lighting: cube conversion, specular prefilter, SH irradiance, BRDF LUT; and the sky.',
      nodes: ['environment', 'sky'],
      baseline: {
        strategy: 'Prefilter, SH and BRDF LUT as fragment passes into the cube faces and mips',
      },
    })
    graph.addNode('environment', {
      kind: 'raw',
      phase: RenderPhase.Setup,
      enabled: isCamera,
      // Atmosphere environments bake from the atmosphere LUTs.
      reads: ['atmosphere-luts'],
      writes: ['environment'],
      run: runEnvironmentWork,
    })
    graph.addNode('sky', skyNode(world.resource(ForwardStateResource)))
  },
})
