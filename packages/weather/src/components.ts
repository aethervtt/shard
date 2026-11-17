import { defineComponent, defineEvent, defineResource, t } from '@aethervtt/shard-core'
import { GlobalTransform } from '@aethervtt/shard-transform'

// --- channels --------------------------------------------------------------------------------

export interface WeatherChannelOptions {
  default?: number
  min?: number
  max?: number
  /** linear: zones blend toward their value; max: zones and storms can only raise it. */
  blend?: 'linear' | 'max'
}

export interface WeatherChannel extends Required<WeatherChannelOptions> {
  name: string
  index: number
}

const channels: WeatherChannel[] = []
const byName = new Map<string, WeatherChannel>()

/**
 * Registers a weather channel (0133): a value every preset, zone and the state carry, blended like
 * the built-in ones. Returns it, with its slot in `WeatherState.channels`.
 */
export function defineWeatherChannel(
  name: string,
  options: WeatherChannelOptions = {},
): WeatherChannel {
  const existing = byName.get(name)
  if (existing) return existing
  const c: WeatherChannel = {
    name,
    index: channels.length,
    default: options.default ?? 0,
    min: options.min ?? 0,
    max: options.max ?? 1,
    blend: options.blend ?? 'linear',
  }
  channels.push(c)
  byName.set(name, c)
  return c
}

export function weatherChannels(): readonly WeatherChannel[] {
  return channels
}

export function weatherChannel(name: string): WeatherChannel | undefined {
  return byName.get(name)
}

/** The built-in channels, in this order. */
export const CH = {
  cloudCoverage: defineWeatherChannel('cloudCoverage', { default: 0.3 }).index,
  cloudType: defineWeatherChannel('cloudType', { default: 0.5 }).index,
  fog: defineWeatherChannel('fog', { default: 0.05 }).index,
  wind: defineWeatherChannel('wind', { default: 0.3 }).index,
  rain: defineWeatherChannel('rain').index,
  snow: defineWeatherChannel('snow').index,
  dust: defineWeatherChannel('dust').index,
  thunder: defineWeatherChannel('thunder').index,
} as const

/** Room for project channels in the fixed-size state arrays. */
export const MAX_CHANNELS = 32

// --- presets ---------------------------------------------------------------------------------

export interface WeatherPreset {
  displayName: string
  channels: Partial<Record<string, number>>
  /** °C. */
  temperature: number
  /** m/s at wind 1. */
  windSpeed?: number
}

/** The built-in presets (0133). Add your own with `WeatherPresets.set`. */
export const WeatherPresets = new Map<string, WeatherPreset>(
  Object.entries({
    clear: {
      displayName: 'Clear',
      channels: { cloudCoverage: 0.12, cloudType: 0.4, fog: 0.03, wind: 0.2 },
      temperature: 22,
    },
    'partly-cloudy': {
      displayName: 'Partly cloudy',
      channels: { cloudCoverage: 0.42, cloudType: 0.5, fog: 0.06, wind: 0.3 },
      temperature: 20,
    },
    cloudy: {
      displayName: 'Cloudy',
      channels: { cloudCoverage: 0.62, cloudType: 0.55, fog: 0.1, wind: 0.4 },
      temperature: 17,
    },
    overcast: {
      displayName: 'Overcast',
      channels: { cloudCoverage: 0.93, cloudType: 0.25, fog: 0.2, wind: 0.4 },
      temperature: 14,
    },
    foggy: {
      displayName: 'Foggy',
      channels: { cloudCoverage: 0.7, cloudType: 0.15, fog: 1, wind: 0.05 },
      temperature: 10,
    },
    'light-rain': {
      displayName: 'Light rain',
      channels: { cloudCoverage: 0.88, cloudType: 0.35, fog: 0.3, wind: 0.4, rain: 0.35 },
      temperature: 13,
    },
    rain: {
      displayName: 'Rain',
      channels: { cloudCoverage: 0.97, cloudType: 0.45, fog: 0.45, wind: 0.55, rain: 0.8 },
      temperature: 12,
    },
    thunderstorm: {
      displayName: 'Thunderstorm',
      channels: {
        cloudCoverage: 1,
        cloudType: 1,
        fog: 0.5,
        wind: 0.85,
        rain: 1,
        thunder: 1,
      },
      temperature: 16,
    },
    'light-snow': {
      displayName: 'Light snow',
      channels: { cloudCoverage: 0.82, cloudType: 0.3, fog: 0.3, wind: 0.3, snow: 0.4 },
      temperature: -3,
    },
    snow: {
      displayName: 'Snow',
      channels: { cloudCoverage: 0.95, cloudType: 0.35, fog: 0.5, wind: 0.4, snow: 0.85 },
      temperature: -6,
    },
    blizzard: {
      displayName: 'Blizzard',
      channels: { cloudCoverage: 1, cloudType: 0.5, fog: 0.95, wind: 1, snow: 1 },
      temperature: -14,
    },
    'dust-storm': {
      displayName: 'Dust storm',
      channels: { cloudCoverage: 0.25, cloudType: 0.3, fog: 0.6, wind: 1, dust: 1 },
      temperature: 32,
    },
  }),
)

/**
 * A random climate (0133): weighted presets, per season where it says so (a season it leaves out
 * uses `weights`).
 */
export interface Climate {
  weights: Record<string, number>
  seasons?: Partial<Record<'spring' | 'summer' | 'autumn' | 'winter', Record<string, number>>>
}

export const Climates = new Map<string, Climate>(
  Object.entries<Climate>({
    temperate: {
      weights: {
        clear: 3,
        'partly-cloudy': 3,
        cloudy: 2,
        overcast: 1.5,
        foggy: 1,
        'light-rain': 1.5,
        rain: 1,
        thunderstorm: 0.6,
      },
      seasons: {
        summer: { clear: 4, 'partly-cloudy': 3, cloudy: 1.5, 'light-rain': 1, thunderstorm: 1.2 },
        autumn: { cloudy: 2.5, overcast: 2.5, foggy: 2, 'light-rain': 2, rain: 2, clear: 1 },
        winter: {
          overcast: 3,
          cloudy: 2,
          foggy: 1.5,
          'light-snow': 2.5,
          snow: 1.5,
          clear: 1.5,
          rain: 0.5,
        },
      },
    },
    arctic: {
      weights: {
        clear: 1,
        cloudy: 2,
        overcast: 2,
        'light-snow': 3,
        snow: 2,
        blizzard: 1,
        foggy: 1,
      },
      seasons: { summer: { clear: 3, 'partly-cloudy': 3, cloudy: 2, foggy: 1, 'light-rain': 1 } },
    },
    desert: { weights: { clear: 6, 'partly-cloudy': 2, 'dust-storm': 1.5 } },
    tropical: {
      weights: { 'partly-cloudy': 3, cloudy: 2, rain: 2, thunderstorm: 1.5, clear: 1 },
      seasons: { summer: { rain: 3, thunderstorm: 3, cloudy: 2, 'partly-cloudy': 1 } },
    },
  }),
)

// --- components ------------------------------------------------------------------------------

export const Weather = defineComponent(
  'weather/Weather',
  {
    source: t.enum(['preset', 'random', 'schedule'], {
      description:
        'preset: the preset field (changeWeather moves between them); random: a climate; schedule: the schedule list, by game time.',
    }),
    preset: t.string({ default: 'partly-cloudy', description: 'A preset in WeatherPresets.' }),
    climate: t.string({ default: 'temperate', description: 'random: a climate in Climates.' }),
    changeEvery: t.f32({
      default: 3,
      min: 0.05,
      unit: 'h',
      description: 'random: game hours between changes (so a forecast follows the clock).',
    }),
    transition: t.f32({
      default: 45,
      min: 0,
      unit: 's',
      description: 'random: how long each change takes.',
    }),
    seed: t.u32({ default: 1 }),
    schedule: t.list(
      t.struct({
        at: t.f64({ unit: 'h', description: 'Game hours since day 0 (day × 24 + hour).' }),
        preset: t.string({ default: 'rain' }),
        over: t.f32({
          default: 60,
          min: 0,
          unit: 's',
          description: 'Real seconds the change takes.',
        }),
      }),
      { description: 'schedule: changes at game times, in order.' },
    ),
    season: t.enum(['auto', 'spring', 'summer', 'autumn', 'winter'], {
      description: "auto: from the sky's date and the hemisphere of its latitude.",
    }),
    windDirection: t.vec3({ default: [1, 0, 0.35], description: 'Where the wind blows toward.' }),
    windVariance: t.f32({
      default: 25,
      min: 0,
      unit: 'deg',
      description: 'Slow drift of the wind.',
    }),
    materialState: t.enum(['simulate', 'direct'], {
      description:
        'simulate: surfaces get wet, snowed on and dry over time; direct: they follow the weather now.',
    }),
    drivesWind: t.bool({ default: true }),
  },
  {
    description:
      'The weather (0133): its source, wind and how surfaces respond. It drives the clouds, the fog, the wind, rain, snow, lightning and surface weather.',
  },
)

export const WeatherZone = defineComponent(
  'weather/WeatherZone',
  {
    shape: t.enum(['box', 'sphere'], {
      description: 'A unit cube or sphere sized by the Transform.',
    }),
    preset: t.string({ default: 'rain' }),
    edge: t.f32({
      default: 0.3,
      min: 0.001,
      max: 1,
      description: 'Fraction of the shape the weather blends in over.',
    }),
    priority: t.i32({ default: 0 }),
  },
  {
    description: "Regional weather (0133): inside, the weather blends to the zone's preset.",
    requires: [GlobalTransform],
  },
)

export const WeatherMaskBrush = defineComponent(
  'weather/WeatherMaskBrush',
  {
    edge: t.f32({
      default: 0.05,
      min: 0,
      max: 0.5,
      description: 'Fraction of the box that fades.',
    }),
  },
  {
    description:
      'A box the sky does not reach (0133): no rain or snow falls in it and surfaces in it stay dry. For roofed places geometry alone does not mark.',
    requires: [GlobalTransform],
  },
)

// --- state -----------------------------------------------------------------------------------

export interface WeatherStateValue {
  /** Channel values at the listener this frame, by channel index. */
  channels: Float32Array
  /** The base weather (before zones): what a change starts from, and where it's going. */
  from: Float32Array
  to: Float32Array
  /** The change in progress, in sky ticks (the server's on a client). */
  startTick: number
  endTick: number
  preset: string
  displayName: string
  /** °C at the listener: the presets' base temperature, then the season, the day and zones. */
  temperature: number
  /** The presets' temperature alone, blended over a change. */
  baseTemperature: number
  fromTemperature: number
  toTemperature: number
  /** Accumulated surface state, 0..1. */
  wetness: number
  snowCover: number
  dustCover: number
  /** simulate: whether the surface state has started (from the weather's direct values). */
  surfacesStarted: boolean
  /** Where the listener is (the camera). */
  listener: Float64Array
  /** Random climate: the window being shown; schedule: the entry in force. */
  window: number
  /** Spring, summer, autumn, winter weights (they sum to 1). */
  seasons: Float32Array
  season: string
  /** How open the listener is to the sky (mask brushes), 0..1. */
  outdoors: number
}

export const WeatherState = defineResource<WeatherStateValue>('weather/State', {
  description:
    "The weather at the listener (0133): channels, temperature, and the surfaces' state.",
  init: () => ({
    channels: new Float32Array(MAX_CHANNELS),
    from: new Float32Array(MAX_CHANNELS),
    to: new Float32Array(MAX_CHANNELS),
    startTick: 0,
    endTick: 0,
    preset: '',
    displayName: '',
    temperature: 15,
    baseTemperature: 15,
    fromTemperature: 15,
    toTemperature: 15,
    wetness: 0,
    snowCover: 0,
    dustCover: 0,
    surfacesStarted: false,
    listener: new Float64Array(3),
    window: -1,
    seasons: new Float32Array([0, 1, 0, 0]),
    season: 'summer',
    outdoors: 1,
  }),
})

export const WeatherChanged = defineEvent<{ from: string; to: string; displayName: string }>(
  'weather/Changed',
)
export const LightningStrike = defineEvent<{
  position: [number, number, number]
  distance: number
  /** Real seconds until its thunder reaches the listener (distance / 343). */
  thunderIn: number
}>('weather/LightningStrike')
