import { Last } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { addRenderFeatures } from './features'
import { Graph, RenderSet, Shaders } from './plugin'
import { registerShaders } from './shaders'
import { extractCameras } from './view'
import { extractVolumetricFog, FogVolume, FogVolumes, VolumetricFog } from './volumetric-fog'
import {
  VolumetricFogGpuResource,
  volumetricFogApplyNode,
  volumetricFogLightNode,
} from './volumetric-fog-nodes'
import { VOLUMETRIC_FOG_SHADERS } from './volumetric-fog-shaders'

/**
 * Volumetric fog (0132): VolumetricFog cameras light a froxel volume of their Fog and FogVolumes
 * with the scene's shadowed lights, and apply it over the scene with the Fog continuing beyond.
 * Nothing runs without a VolumetricFog camera.
 */
export const volumetricFogPlugin = definePlugin({
  name: 'render/volumetric-fog',
  dependencies: ['render/forward'],
  provides: [VolumetricFog, FogVolume, FogVolumes, VolumetricFogGpuResource],
  build(app) {
    app.world.initResource(FogVolumes)
    app.world.initResource(VolumetricFogGpuResource)
    app.addSystems(Last, extractVolumetricFog.inSet(RenderSet.Extract).after(extractCameras))
  },
  ready(app) {
    const world = app.world
    registerShaders(world.resource(Shaders), VOLUMETRIC_FOG_SHADERS)
    addRenderFeatures(world, {
      name: 'render/volumetric-fog',
      description: 'Froxel fog lit by shadowed sun, moon, point and spot lights; FogVolumes.',
      nodes: ['volumetric-fog/light', 'volumetric-fog/apply'],
      baseline: 'unsupported',
      components: [VolumetricFog, FogVolume],
    })
    const graph = world.resource(Graph)
    graph.addNode('volumetric-fog/light', volumetricFogLightNode())
    graph.addNode('volumetric-fog/apply', volumetricFogApplyNode())
  },
})
