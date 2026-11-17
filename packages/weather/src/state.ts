import { affine, defineSystem, type Entity, type World } from '@aethervtt/shard-core'
import { Camera3d, DefaultEnvironment, Fog } from '@aethervtt/shard-render'
import { FixedTime } from '@aethervtt/shard-runtime'
import {
  CloudMotion,
  Clouds,
  clockHoursAt,
  Sky,
  SkyFrame,
  secondsBetween,
  skyTick,
  TimeOfDay,
} from '@aethervtt/shard-sky'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import {
  CH,
  Climates,
  MAX_CHANNELS,
  Weather,
  WeatherChanged,
  WeatherMaskBrush,
  WeatherPresets,
  WeatherState,
  type WeatherStateValue,
  WeatherZone,
  weatherChannels,
} from './components'
import {
  dayOfYear,
  dominantSeason,
  SEASON_TEMPERATURE,
  type Season,
  seasonWeights,
} from './seasons'

/** The sky's tick: the server's on a multiplayer client, so every player has the same weather. */
const tick = skyTick

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
  s.fromTemperature = s.baseTemperature
  s.toTemperature = presetValues(preset, s.to)
  const now = tick(world)
  s.startTick = now
  s.endTick = now + Math.max(0, seconds) / step(world)
  if (seconds <= 0) {
    s.channels.set(s.to)
    s.baseTemperature = s.toTemperature
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

/** Picks the random climate's preset for a window: weighted for the season, from the seed. */
function climatePick(climate: string, season: Season, seed: number, window: number): string {
  const c = Climates.get(climate) ?? Climates.get('temperate')!
  const weights = c.seasons?.[season] ?? c.weights
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
const seasonScratch = new Float32Array(4)

/** Game hours since day 0 on the sky's clock. */
function gameHours(world: World): number {
  const c = world.tryResource(TimeOfDay)
  return c ? c.day * 24 + c.hours : (tick(world) * step(world)) / 3600
}

/** Game hours since day 0 at a tick, past or future. */
function hoursAtTick(world: World, at: number): number {
  return world.tryResource(TimeOfDay) ? clockHoursAt(world, at) : (at * step(world)) / 3600
}

/** Real seconds (at clock speed 1) from one game time to a later one. */
function secondsSince(world: World, from: number, to: number): number {
  const c = world.tryResource(TimeOfDay)
  return c ? secondsBetween(c, from, to) : Math.max(0, to - from) * 3600
}

function latitude(world: World): number {
  for (const table of world.query({ with: [Sky] }).tables) {
    if (table.count > 0) return table.column(Sky, 'latitude')[0]!
  }
  return 45
}

/** Season weights at a number of game hours from now (the Weather's fixed season, or the date's). */
function seasonsAt(
  world: World,
  w: { season: string },
  aheadHours: number,
  out: Float32Array,
): Float32Array {
  if (w.season !== 'auto') {
    out.fill(0)
    out[['spring', 'summer', 'autumn', 'winter'].indexOf(w.season)] = 1
    return out
  }
  const clock = world.tryResource(TimeOfDay)
  if (!clock) {
    out.fill(0)
    out[1] = 1
    return out
  }
  return seasonWeights(dayOfYear(clock, aheadHours / 24), latitude(world), out)
}

/** The preset the base source names at a game time: a schedule's entry, or a climate's window. */
function presetAt(
  world: World,
  w: ReturnType<typeof readWeather>,
  hours: number,
  aheadHours: number,
): { preset: string; key: number; over: number } {
  if (w.source === 'schedule') {
    let entry = -1
    for (let i = 0; i < w.schedule.length; i++) if (w.schedule[i]!.at <= hours) entry = i
    if (entry < 0) return { preset: w.preset, key: -1, over: 0 }
    const e = w.schedule[entry]!
    return { preset: e.preset, key: entry, over: e.over }
  }
  if (w.source === 'random') {
    const window = Math.floor(hours / w.changeEvery)
    const season = dominantSeason(seasonsAt(world, w, aheadHours, seasonScratch))
    return {
      preset: climatePick(w.climate, season, w.seed, window),
      key: window,
      over: w.transition,
    }
  }
  return { preset: w.preset, key: -2, over: 30 }
}

function readWeather(world: World, e: Entity) {
  return world.get(e, Weather)
}

/**
 * A schedule's or a random climate's base weather at a game time (0133): the preset in force, the
 * one before it, and how far the change between them has come (`over` real seconds from the entry
 * or window's start, on the clock). A function of the clock alone, so a player who joins mid-change
 * sees what everyone else does. Fills `from` and `to` with the two presets' channels.
 */
function scheduledAt(
  world: World,
  w: ReturnType<typeof readWeather>,
  hours: number,
  from: Float32Array,
  to: Float32Array,
) {
  const now = presetAt(world, w, hours, 0)
  let start = Number.NEGATIVE_INFINITY
  let before = now.preset
  if (w.source === 'random') {
    start = now.key * w.changeEvery
    // The middle of the window before: clear of its edges.
    before = presetAt(world, w, start - w.changeEvery / 2, start - w.changeEvery / 2 - hours).preset
  } else if (now.key >= 0) {
    start = w.schedule[now.key]!.at
    before = now.key > 0 ? w.schedule[now.key - 1]!.preset : w.preset
  }
  const since = Number.isFinite(start) ? secondsSince(world, start, hours) : 0
  const f = now.over > 0 && Number.isFinite(start) ? Math.min(1, since / now.over) : 1
  return {
    preset: now.preset,
    key: now.key,
    since,
    over: now.over,
    k: f * f * (3 - 2 * f),
    fromTemperature: presetValues(before, from),
    toTemperature: presetValues(now.preset, to),
  }
}

const fromScratch = new Float32Array(MAX_CHANNELS)
const toScratch = new Float32Array(MAX_CHANNELS)

/**
 * The base wind channel at a tick, past or future: the preset change in progress, or the schedule's
 * or climate's. Zones aren't included.
 */
function baseWindAt(
  world: World,
  w: ReturnType<typeof readWeather>,
  s: WeatherStateValue,
  at: number,
): number {
  if (w.source === 'preset') {
    const span = s.endTick - s.startTick
    const f = span > 0 ? Math.min(1, Math.max(0, (at - s.startTick) / span)) : 1
    const k = f * f * (3 - 2 * f)
    return s.from[CH.wind]! + (s.to[CH.wind]! - s.from[CH.wind]!) * k
  }
  const b = scheduledAt(world, w, hoursAtTick(world, at), fromScratch, toScratch)
  return fromScratch[CH.wind]! + (toScratch[CH.wind]! - fromScratch[CH.wind]!) * b.k
}

/** The wind's direction (yaw about up) at a tick: the Weather's, drifting by its variance. */
function windYaw(world: World, w: ReturnType<typeof readWeather>, at: number): number {
  const t = at * step(world)
  return (
    Math.atan2(w.windDirection[2], w.windDirection[0]) +
    ((w.windVariance * Math.PI) / 180) * Math.sin(t * 0.013 + w.seed) * Math.cos(t * 0.007)
  )
}

/** Wind m/s at wind channel 1. */
const WIND_SPEED = 14

/**
 * The wind the weather gives at a tick, for the clouds (CloudMotion.windAt): direction x, z and
 * speed. Its history is known on every machine, so clouds agree for players who joined late.
 */
export function weatherWindAt(world: World, at: number, out: Float64Array): void {
  const e = weatherEntity(world)
  const s = world.resource(WeatherState)
  const w = e === undefined ? undefined : world.get(e, Weather)
  if (!w?.drivesWind || s.preset === '') {
    const wind = world.tryResource(Wind)
    out[0] = wind?.direction[0] ?? 1
    out[1] = wind?.direction[2] ?? 0
    out[2] = wind?.speed ?? 0
    return
  }
  const yaw = windYaw(world, w, at)
  out[0] = Math.cos(yaw)
  out[1] = Math.sin(yaw)
  out[2] = baseWindAt(world, w, s, at) * WIND_SPEED
}

/**
 * The weather the base source will give, every \`step\` game hours for \`hours\` (0133): a schedule's
 * entries and a climate's windows are known ahead, so a forecast is exact. Zones aren't included.
 */
export function forecastWeather(
  world: World,
  options: { hours?: number; step?: number } = {},
): { in: number; at: number; preset: string; displayName: string }[] {
  const e = weatherEntity(world)
  if (e === undefined) return []
  const w = readWeather(world, e)
  const now = gameHours(world)
  const hours = options.hours ?? 24
  const stride = options.step ?? 1
  const out: { in: number; at: number; preset: string; displayName: string }[] = []
  for (let h = 0; h <= hours + 1e-9; h += stride) {
    const { preset } = presetAt(world, w, now + h, h)
    out.push({
      in: h,
      at: now + h,
      preset,
      displayName: WeatherPresets.get(preset)?.displayName ?? preset,
    })
  }
  return out
}

/** How open a point is to the sky through the mask brushes (1 outside them all), on the CPU. */
export function exposureAt(world: World, position: ArrayLike<number>): number {
  let open = 1
  for (const table of world.query({ with: [WeatherMaskBrush, GlobalTransform] }).tables) {
    const g = table.column(GlobalTransform, 'matrix')
    const edge = table.column(WeatherMaskBrush, 'edge')
    for (let i = 0; i < table.count; i++) {
      for (let k = 0; k < 12; k++) matrix[k] = g[i * 12 + k]!
      if (!affine.invert(inverse, matrix)) continue
      const x = position[0]!
      const y = position[1]!
      const z = position[2]!
      const lx = inverse[0]! * x + inverse[1]! * y + inverse[2]! * z + inverse[3]!
      const ly = inverse[4]! * x + inverse[5]! * y + inverse[6]! * z + inverse[7]!
      const lz = inverse[8]! * x + inverse[9]! * y + inverse[10]! * z + inverse[11]!
      const m = Math.max(Math.abs(lx), Math.abs(ly), Math.abs(lz)) * 2
      const e = Math.max(edge[i]!, 0.001)
      const t = Math.min(1, Math.max(0, (m - (1 - e)) / e))
      open = Math.min(open, t * t * (3 - 2 * t))
    }
  }
  return open
}

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
    const motion = world.tryResource(CloudMotion)
    if (e === undefined) {
      if (motion?.windAt === weatherWindAt) motion.windAt = undefined
      return
    }
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
    const hours = gameHours(world)
    seasonsAt(world, w, 0, s.seasons)
    s.season = dominantSeason(s.seasons)
    let k: number
    if (w.source === 'preset') {
      // First frame, or the component's preset was written directly.
      if (w.preset !== s.preset) begin(world, s, w.preset, s.preset === '' ? 0 : 30)
      // The base: from → to over the change, smoothed.
      const span = s.endTick - s.startTick
      const f = span > 0 ? Math.min(1, Math.max(0, (now - s.startTick) / span)) : 1
      k = f * f * (3 - 2 * f)
    } else {
      // A schedule or a climate: from the clock alone.
      const b = scheduledAt(world, w, hours, s.from, s.to)
      k = b.k
      s.window = b.key
      s.fromTemperature = b.fromTemperature
      s.toTemperature = b.toTemperature
      s.startTick = now - b.since / dt
      s.endTick = s.startTick + b.over / dt
      if (b.preset !== s.preset) {
        const before = s.preset
        s.preset = b.preset
        s.displayName = WeatherPresets.get(b.preset)?.displayName ?? b.preset
        world.send(WeatherChanged, { from: before, to: b.preset, displayName: s.displayName })
      }
    }
    for (const c of weatherChannels()) {
      s.channels[c.index] = s.from[c.index]! + (s.to[c.index]! - s.from[c.index]!) * k
    }
    s.baseTemperature = s.fromTemperature + (s.toTemperature - s.fromTemperature) * k
    s.temperature = s.baseTemperature
    // The season shifts it, and the day warms it: up to 4 °C with the sun high.
    for (let j = 0; j < 4; j++) {
      s.temperature +=
        s.seasons[j]! * SEASON_TEMPERATURE[(['spring', 'summer', 'autumn', 'winter'] as const)[j]!]
    }
    const sun = world.tryResource(SkyFrame)?.celestial.sunElevation ?? 30
    if (Number.isFinite(sun)) s.temperature += 4 * Math.max(-0.5, Math.min(1, sun / 50))
    applyZones(world, s)
    if (!Number.isFinite(s.temperature))
      s.temperature = Number.isFinite(s.baseTemperature) ? s.baseTemperature : 15
    s.outdoors = exposureAt(world, s.listener)
    // The clouds follow the wind the weather drives, whose history every machine knows (0131).
    if (motion) {
      if (w.drivesWind) motion.windAt = weatherWindAt
      else if (motion.windAt === weatherWindAt) motion.windAt = undefined
    }

    // Surfaces: wet in rain and drying after, snow that settles below 1 °C and melts above it,
    // dust that settles in dust and washes off in rain.
    const ch = s.channels
    const rain = ch[CH.rain]!
    const snow = ch[CH.snow]!
    const dust = ch[CH.dust]!
    const wind = ch[CH.wind]!
    // Direct, or simulate's start: what the weather now would give. A player who joins in the
    // rain finds the ground wet.
    if (w.materialState === 'direct' || !s.surfacesStarted) {
      s.wetness = Math.min(1, rain * 1.4)
      s.snowCover = s.temperature < 1 ? Math.min(1, snow * 1.3) : 0
      s.dustCover = dust
      s.surfacesStarted = w.materialState !== 'direct'
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
    // Integrated from the last value, a non-number would never recover: start again.
    if (!Number.isFinite(s.wetness + s.snowCover + s.dustCover)) s.surfacesStarted = false
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
        const yaw = windYaw(world, w, tick(world))
        windRes.direction = [Math.cos(yaw), 0, Math.sin(yaw)]
        windRes.speed = wind * WIND_SPEED
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
