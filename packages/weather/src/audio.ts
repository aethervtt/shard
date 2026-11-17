import { AudioEventsState } from '@aethervtt/shard-audio'
import { defineSystem, PostUpdate, type World } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { SkyFrame, TimeOfDay } from '@aethervtt/shard-sky'
import { CH, WeatherState } from './components'
import { LightningState } from './lightning'

/**
 * The global audio parameters weather writes (0133), each only when a project's global parameter
 * bank declares it: author events that read them (rain loops, wind howl, muffled indoors).
 */
export const WEATHER_AUDIO_PARAMETERS = [
  'weather.rain',
  'weather.snow',
  'weather.wind',
  'weather.thunder',
  'weather.dust',
  'weather.outdoors',
  'weather.lightning',
  'time.hour',
  'time.daylight',
] as const

function value(world: World, name: (typeof WEATHER_AUDIO_PARAMETERS)[number]): number {
  const s = world.resource(WeatherState)
  const c = s.channels
  switch (name) {
    case 'weather.rain':
      return c[CH.rain]!
    case 'weather.snow':
      return c[CH.snow]!
    case 'weather.wind':
      return c[CH.wind]!
    case 'weather.thunder':
      return c[CH.thunder]!
    case 'weather.dust':
      return c[CH.dust]!
    case 'weather.outdoors':
      return s.outdoors
    case 'weather.lightning':
      return Math.min(1, world.tryResource(LightningState)?.envelope ?? 0)
    case 'time.hour':
      return world.tryResource(TimeOfDay)?.hours ?? 12
    case 'time.daylight': {
      const e = world.tryResource(SkyFrame)?.celestial.sunElevation ?? 30
      const t = Math.min(1, Math.max(0, (e + 6) / 12))
      return t * t * (3 - 2 * t)
    }
  }
}

/** Writes WEATHER_AUDIO_PARAMETERS into every global audio parameter bank that declares them. */
export const weatherAudio = defineSystem({
  name: 'weather/audio',
  description: 'Writes weather and time into declared global audio parameters (0133, 0077).',
  run: (_, world) => {
    const state = world.tryResource(AudioEventsState)
    if (!state) return
    for (const bank of state.globalBanks.values()) {
      for (const name of WEATHER_AUDIO_PARAMETERS) {
        if (bank.indices.has(name)) bank.set(name, value(world, name))
      }
    }
  },
})

/** Weather into audio (0133): add with the audio events plugin (0077) and weather. */
export const weatherAudioPlugin = definePlugin({
  name: 'weather/audio',
  dependencies: ['weather'],
  build(app) {
    app.addSystems(PostUpdate, weatherAudio)
  },
})
