import type { World } from '@aethervtt/shard-core'
import { App, definePlugin } from '@aethervtt/shard-runtime'
import { loadScene, ScenePlugin } from '@aethervtt/shard-scene'
import { SkyFrame, skyPlugin } from '@aethervtt/shard-sky'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { WeatherState } from './components'
import { weatherPlugin } from './plugin'

/** The sky and weather simulate without drawing: a stand-in for the renderer they draw with. */
const noRenderer = definePlugin({ name: 'render/forward', build() {} })

async function weatherScene(weather: Record<string, unknown>) {
  const app = new App().addPlugin(
    TransformPlugin,
    ScenePlugin,
    noRenderer,
    skyPlugin,
    weatherPlugin,
  )
  await app.init()
  loadScene(app.world, {
    version: 1,
    entities: [
      {
        name: 'sky',
        components: { 'sky/Sky': {}, 'sky/Clouds': {}, 'weather/Weather': weather },
      },
    ],
  })
  return app
}

const surfaces = (world: World) => {
  const s = world.resource(WeatherState)
  return [s.wetness, s.snowCover, s.dustCover]
}

describe('weather loaded from a scene (0133, 0134)', () => {
  it('starts the simulated surfaces from the weather, and keeps them numbers', async () => {
    const app = await weatherScene({ source: 'preset', preset: 'partly-cloudy' })
    for (let i = 0; i < 120; i++) app.update(1 / 60)
    expect(surfaces(app.world)).toEqual([0, 0, 0])
    expect(Number.isFinite(app.world.resource(WeatherState).temperature)).toBe(true)
    // A frame whose inputs aren't numbers (the sun's elevation here) doesn't poison the state.
    app.world.resource(SkyFrame).celestial.sunElevation = Number.NaN
    app.update(1 / 60)
    for (let i = 0; i < 60; i++) app.update(1 / 60)
    for (const v of surfaces(app.world)) expect(Number.isFinite(v)).toBe(true)
    expect(Number.isFinite(app.world.resource(WeatherState).temperature)).toBe(true)
    await app.dispose()
  })

  it('starts wet when it is already raining', async () => {
    const app = await weatherScene({ source: 'preset', preset: 'rain' })
    app.update(1 / 60)
    app.update(1 / 60)
    const s = app.world.resource(WeatherState)
    expect(s.wetness).toBe(1)
    expect(s.surfacesStarted).toBe(true)
    await app.dispose()
  })
})
