import { FixedUpdate, PostUpdate, Update } from '@aethervtt/shard-core'
import {
  addRenderFeatures,
  Gpu,
  Graph,
  registerShaders,
  ShaderData,
  Shaders,
  SkyOcclusion,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import { Weather, WeatherMaskBrush, WeatherState, WeatherZone } from './components'
import { LightningState, spawnFlashLight, updateLightning } from './lightning'
import { precipitationNode, uploadWeather, WeatherGpuResource } from './render'
import { WEATHER_SLOTS, weatherShaders } from './shaders'
import { driveWeather, updateWeather } from './state'

/**
 * Weather (0133) and surface weather (0134): the weather at the listener drives the clouds, fog
 * and wind; rain, snow and lightning are drawn around the camera; and every standard surface gets
 * wet, puddled, snowed on or dusty. Install after the sky plugin.
 */
export const weatherPlugin = definePlugin({
  name: 'weather',
  dependencies: ['render/forward', 'sky'],
  provides: [
    Weather,
    WeatherZone,
    WeatherMaskBrush,
    WeatherState,
    LightningState,
    WeatherGpuResource,
  ],
  build(app) {
    const world = app.world
    world.initResource(WeatherState)
    world.initResource(LightningState)
    world.initResource(WeatherGpuResource)
    app.addSystems(FixedUpdate, updateWeather)
    app.addSystems(Update, updateLightning)
    app.addSystems(PostUpdate, driveWeather.before(TransformSystems), uploadWeather)
  },
  ready(app) {
    const world = app.world
    const shaders = world.tryResource(Shaders)
    const data = world.tryResource(ShaderData)
    if (!shaders || !data) return
    const gpu = world.resource(WeatherGpuResource)
    gpu.slot = data.reserve('weather', WEATHER_SLOTS)
    registerShaders(shaders, weatherShaders(gpu.slot))
    // Surface weather on every standard surface (0134).
    world.initResource(SkyOcclusion).surface = true
    spawnFlashLight(world)
    if (world.resource(Gpu).tier !== 'full') return
    addRenderFeatures(world, {
      name: 'weather',
      description: 'Rain, snow and lightning bolts around the camera (0133).',
      nodes: ['weather/precipitation'],
      baseline: 'unsupported',
      components: [Weather],
    })
    world.resource(Graph).addNode('weather/precipitation', precipitationNode(world))
  },
})
