import { affine, defineSystem, type Entity, type World } from '@aethervtt/shard-core'
import { Camera3d, DefaultEnvironment, Fog } from '@aethervtt/shard-render'
import { FixedTime, Time } from '@aethervtt/shard-runtime'
import { Clouds } from '@aethervtt/shard-sky'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import {
  CH,
  Climates,
  Weather,
  WeatherChanged,
  WeatherPresets,
  WeatherState,
  type WeatherStateValue,
  WeatherZone,
  weatherChannels,
} from './components'

function tick(world: World): number {
  const f = world.tryResource(FixedTime)
  return f ? f.tick + f.alpha : 0
}

function step(world: World): number {
  return world.tryResource(FixedTime)?.step ?? 1 / 60
}

function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** A preset's channel values, filled from the channel defaults where it says nothing. */
export function presetValues(name: string, out: Float32Array): number {
  const preset = WeatherPresets.get(name)
  for (const c of weatherChannels()) out[c.index] = preset?.channels[c.name] ?? c.default
  return preset?.temperature ?? 15
}

const scratch = new Float32Array(32)

function begin(world: World, s: WeatherStateValue, preset: string, seconds: number): void {
  s.from.set(s.channels)
  s.fromTemperature = s.temperature
  s.toTemperature = presetValues(preset, s.to)
  const now = tick(world)
  s.startTick = now
  s.endTick = now + Math.max(0, seconds) / step(world)
  if (seconds <= 0) {
    s.channels.set(s.to)
    s.temperature = s.toTemperature
  }
  const before = s.preset
  s.preset = preset
  s.displayName = WeatherPresets.get(preset)?.displayName ?? preset
  if (before !== preset) {
    world.send(WeatherChanged, { from: before, to: preset, displayName: s.displayName })
  }
}

function weatherEntity(world: World): Entity | undefined {
  for (const table of world.query({ with: [Weather] }).tables) {
    if (table.count > 0) return table.entities[0]
  }
  return undefined
}

/**
 * Moves the weather to a preset over `over` real seconds (0 at once), from where it is now. Every
 * machine stepping the same ticks gets the same weather.
 */
export function changeWeather(world: World, preset: string, options: { over?: number } = {}): void {
  const s = world.resource(WeatherState)
  const e = weatherEntity(world)
  if (e !== undefined) world.set(e, Weather, { source: 'preset', preset } as never)
  begin(world, s, preset, options.over ?? 30)
}

/** Picks the random climate's preset for a window: weighted, from the seed. */
function climatePick(climate: string, seed: number, window: number): string {
  const weights = Climates.get(climate) ?? Climates.get('temperate')!
  let total = 0
  for (const k in weights) total += weights[k]!
  let r = hash(seed, window) * total
  for (const k in weights) {
    r -= weights[k]!
    if (r <= 0) return k
  }
  return Object.keys(weights)[0]!
}

const inverse = new Float32Array(12)
const matrix = new Float32Array(12)

/** Zone weights at the listener, applied over the base channels in priority order. */
function applyZones(world: World, s: WeatherStateValue): void {
  const zones: { entity: Entity; priority: number }[] = []
  for (const table of world.query({ with: [WeatherZone, GlobalTransform] }).tables) {
    const p = table.column(WeatherZone, 'priority')
    for (let i = 0; i < table.count; i++)
      zones.push({ entity: table.entities[i]!, priority: p[i]! })
  }
  if (zones.length === 0) return
  zones.sort((a, b) => a.priority - b.priority)
  const L = s.listener
  for (const z of zones) {
    const g = world.get(z.entity, GlobalTransform).matrix as ArrayLike<number>
    for (let k = 0; k < 12; k++) matrix[k] = g[k]!
    if (!affine.invert(inverse, matrix)) continue
    const lx = inverse[0]! * L[0]! + inverse[1]! * L[1]! + inverse[2]! * L[2]! + inverse[3]!
    const ly = inverse[4]! * L[0]! + inverse[5]! * L[1]! + inverse[6]! * L[2]! + inverse[7]!
    const lz = inverse[8]! * L[0]! + inverse[9]! * L[1]! + inverse[10]! * L[2]! + inverse[11]!
    const zone = world.get(z.entity, WeatherZone)
    const m =
      (zone.shape === 'sphere'
        ? Math.sqrt(lx * lx + ly * ly + lz * lz)
        : Math.max(Math.abs(lx), Math.abs(ly), Math.abs(lz))) * 2
    if (m >= 1) continue
    const t = Math.min(1, Math.max(0, (1 - m) / zone.edge))
    const w = t * t * (3 - 2 * t)
    const temperature = presetValues(zone.preset, scratch)
    for (const c of weatherChannels()) {
      const v = scratch[c.index]!
      const cur = s.channels[c.index]!
      s.channels[c.index] = c.blend === 'max' ? Math.max(cur, v * w) : cur + (v - cur) * w
    }
    s.temperature += (temperature - s.temperature) * w
  }
}

/**
 * The weather at the listener (0133): the base (a preset, a change between two, or a random
 * climate), zones over it, and the surfaces' wetness, snow and dust over time. Per fixed tick.
 */
export const updateWeather = defineSystem({
  name: 'weather/update',
  description:
    'Evaluates the weather at the listener per fixed tick (0133): base preset or climate, changes, zones, and the accumulated surface state.',
  setup: (world) => ({ cameras: world.query({ with: [Camera3d, GlobalTransform] }) }),
  run: ({ cameras }, world) => {
    const e = weatherEntity(world)
    if (e === undefined) return
    const w = world.get(e, Weather)
    const s = world.resource(WeatherState)
    for (const table of cameras.tables) {
      if (table.count === 0) continue
      const g = table.column(GlobalTransform, 'matrix')
      s.listener[0] = g[3]!
      s.listener[1] = g[7]!
      s.listener[2] = g[11]!
      break
    }
    const now = tick(world)
    const dt = step(world)
    if (w.source === 'random') {
      const window = Math.floor((now * dt) / w.changeEvery)
      if (window !== s.window) {
        const first = s.window < 0
        s.window = window
        begin(world, s, climatePick(w.climate, w.seed, window), first ? 0 : w.transition)
      }
    } else if (w.preset !== s.preset) {
      // First frame, or the component's preset was written directly.
      begin(world, s, w.preset, s.preset === '' ? 0 : 30)
    }
    // The base: from → to over the change, smoothed.
    const span = s.endTick - s.startTick
    const f = span > 0 ? Math.min(1, Math.max(0, (now - s.startTick) / span)) : 1
    const k = f * f * (3 - 2 * f)
    for (const c of weatherChannels()) {
      s.channels[c.index] = s.from[c.index]! + (s.to[c.index]! - s.from[c.index]!) * k
    }
    s.temperature = s.fromTemperature + (s.toTemperature - s.fromTemperature) * k
    applyZones(world, s)

    // Surfaces: wet in rain and drying after, snow that settles below 1 °C and melts above it,
    // dust that settles in dust and washes off in rain.
    const ch = s.channels
    const rain = ch[CH.rain]!
    const snow = ch[CH.snow]!
    const dust = ch[CH.dust]!
    const wind = ch[CH.wind]!
    if (w.materialState === 'direct') {
      s.wetness = Math.min(1, rain * 1.4)
      s.snowCover = s.temperature < 1 ? Math.min(1, snow * 1.3) : 0
      s.dustCover = dust
      return
    }
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    s.wetness = clamp(
      s.wetness +
        (rain > 0.02
          ? (rain * dt) / 20
          : (-dt / 120) * (1 + wind + Math.max(0, s.temperature) / 20)),
    )
    s.snowCover = clamp(
      s.snowCover + (s.temperature < 1 ? (snow * dt) / 40 : (-dt / 150) * (1 + s.temperature / 10)),
    )
    s.dustCover = clamp(s.dustCover + (dust * dt) / 25 - (rain * dt) / 15 - dt / 900)
  },
})

const lastTurbidity = { value: Number.NaN }

/**
 * Drives the rest of the world from the weather (0133): the clouds, every camera's Fog, the wind,
 * and the sky's haze.
 */
export const driveWeather = defineSystem({
  name: 'weather/drive',
  description: "Writes the weather into the Clouds, cameras' Fog, Wind and the sky's haze (0133).",
  setup: (world) => ({
    clouds: world.query({ with: [Clouds] }),
    fogs: world.query({ with: [Fog] }),
  }),
  run: ({ clouds, fogs }, world) => {
    const e = weatherEntity(world)
    if (e === undefined) return
    const w = world.get(e, Weather)
    const ch = world.resource(WeatherState).channels
    const cov = ch[CH.cloudCoverage]!
    const fog = ch[CH.fog]!
    const rain = ch[CH.rain]!
    const snow = ch[CH.snow]!
    const dust = ch[CH.dust]!
    const wind = ch[CH.wind]!
    for (const table of clouds.tables) {
      for (let i = 0; i < table.count; i++) {
        world.set(table.entities[i]!, Clouds, {
          coverage: cov,
          type: ch[CH.cloudType]!,
          // Storm clouds are darker and denser than fair-weather ones.
          density: 0.035 + 0.035 * cov * cov,
          shadowStrength: 0.8 + 0.18 * cov,
        } as never)
      }
    }
    for (const table of fogs.tables) {
      for (let i = 0; i < table.count; i++) {
        const tint = Math.min(1, dust)
        world.set(table.entities[i]!, Fog, {
          density: 0.0015 + fog * 0.024 + rain * 0.006 + snow * 0.006 + dust * 0.05,
          heightFalloff: 0.05 + 0.1 * (1 - tint),
          color: [0.8 + 0.12 * tint, 0.84 - 0.06 * tint, 0.9 - 0.32 * tint, 1],
        } as never)
      }
    }
    if (w.drivesWind) {
      const windRes = world.tryResource(Wind)
      if (windRes) {
        const t = world.tryResource(Time)?.elapsed ?? 0
        const yaw =
          Math.atan2(w.windDirection[2], w.windDirection[0]) +
          ((w.windVariance * Math.PI) / 180) * Math.sin(t * 0.013 + w.seed) * Math.cos(t * 0.007)
        windRes.direction = [Math.cos(yaw), 0, Math.sin(yaw)]
        windRes.speed = wind * 14
        windRes.gustiness = 0.25 + 0.5 * wind
      }
    }
    // Haze: overcast, fog and dust whiten the sky and its light.
    const env = world.tryResource(DefaultEnvironment)
    if (env?.sky) {
      const turbidity = 2.2 + 5 * cov * cov + 3 * fog + 6 * dust
      if (!(Math.abs(turbidity - lastTurbidity.value) < 0.15)) {
        lastTurbidity.value = turbidity
        env.sky = { ...env.sky, turbidity }
      }
    }
  },
})
