import { Last, ProfilerResource } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import {
  Atmosphere,
  AtmosphereSettings,
  atmosphereMethods,
  describeAtmospheres,
  selectAtmospheres,
} from './atmosphere'
import { AtmosphereGpuResource, addAtmosphereNodes, uploadAtmospheres } from './atmosphere-nodes'
import { ATMOSPHERE_SHADERS } from './atmosphere-shaders'
import { Atmospheres } from './atmosphere-state'
import { extractLights } from './lights'
import { RenderDescribers, RenderSet, Shaders } from './plugin'
import { registerShaders } from './shaders'
import { extractCameras } from './view'

/**
 * Atmosphere scattering (spec 0044): planets' Atmosphere components and ProceduralSky, with their
 * LUTs, sky, aerial perspective, and the environment bake that lights the scene from them.
 */
export const atmospherePlugin = definePlugin({
  name: 'render/atmosphere',
  // Skies bake into the environment, and ProceduralSky and DefaultEnvironment are its components.
  dependencies: ['render/forward', 'render/environment'],
  provides: [Atmosphere, AtmosphereSettings, Atmospheres, AtmosphereGpuResource],
  build(app) {
    app.world.initResource(Atmospheres)
    app.addSystems(
      Last,
      selectAtmospheres.inSet(RenderSet.Extract).after(extractCameras).after(extractLights),
      uploadAtmospheres.inSet(RenderSet.Upload),
    )
    app.addMethod(...atmosphereMethods)
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), ATMOSPHERE_SHADERS)
    app.world
      .initResource(RenderDescribers)
      .set('atmosphere', (world) =>
        describeAtmospheres(world, world.tryResource(ProfilerResource)?.all()),
      )
    addAtmosphereNodes(app.world)
  },
})
