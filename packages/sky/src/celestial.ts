import { defineResource, defineSystem, type Entity, quat, type World } from '@aethervtt/shard-core'
import {
  type AtmosphereModel,
  DefaultEnvironment,
  DirectionalLight,
  proceduralSkyModel,
  transmittanceToTop,
} from '@aethervtt/shard-render'
import { FixedTime } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { skyTick } from './clock'
import { Sky, Sunrise, Sunset, TimeOfDay } from './components'
import { type CelestialState, computeCelestial, createCelestial } from './ephemeris'

/** A light reaching the ground: `illuminance × color` is lux per channel. */
export interface GroundLight {
  /** Lux, luminance-weighted: 0 with the light below the horizon. */
  illuminance: number
  /** Linear rgb with a luminance of 1: the light's color reddened by the air. */
  color: Float64Array
}

/** What `sky/update` worked out this frame, for the render nodes and describe. */
export interface SkyFrameState {
  /** The Sky entity, or -1 without one. */
  entity: number
  mode: string
  celestial: CelestialState
  sunLight: Entity | -1
  moonLight: Entity | -1
  /** Which light casts shadows: 'sun', 'moon' or 'none'. */
  shadows: 'sun' | 'moon' | 'none'
  /**
   * The sun's and the moon's light reaching open ground now, through the sky's atmosphere: what
   * the renderer lights an unshadowed surface with, for game code that scales its own light by it
   * (their lights keep their full illuminance; the atmosphere dims them as they're drawn). Cloud
   * shadows aren't counted.
   */
  sunGround: GroundLight
  moonGround: GroundLight
  nightBrightness: number
  stars: number
  twinkle: number
  milkyWay: number
  aurora: number
  moonDisk: number
  moonSize: number
  /** Seconds on the sky tick, for twinkle and aurora: the same for every player. */
  time: number
}

export const SkyFrame = defineResource<SkyFrameState>('sky/Frame', {
  description: "This frame's sun, moon and star frame, and which light casts shadows (0130).",
  init: () => ({
    entity: -1,
    mode: 'none',
    celestial: createCelestial(),
    sunLight: -1,
    moonLight: -1,
    shadows: 'none',
    sunGround: { illuminance: 0, color: new Float64Array([1, 1, 1]) },
    moonGround: { illuminance: 0, color: new Float64Array([1, 1, 1]) },
    nightBrightness: 1,
    stars: 1,
    twinkle: 1,
    milkyWay: 1,
    aurora: 0,
    moonDisk: 1,
    moonSize: 1,
    time: 0,
  }),
})

const SUN_COLOR = [1, 1, 1, 1] as const
const MOON_COLOR = [0.78, 0.86, 1, 1] as const
const x = new Float64Array(3)
const y = new Float64Array(3)
const rotation = [0, 0, 0, 1]

/** A rotation whose +Z (toward the light, as lights read it) is `d`. */
function towardLight(d: Float64Array): number[] {
  // x = normalize(up × d) (or +X when d is vertical), y = d × x.
  let ax = d[2]!
  let az = -d[0]!
  let len = Math.sqrt(ax * ax + az * az)
  if (len < 1e-6) {
    ax = 1
    az = 0
    len = 1
  }
  x[0] = ax / len
  x[1] = 0
  x[2] = az / len
  y[0] = d[1]! * x[2]! - d[2]! * x[1]!
  y[1] = d[2]! * x[0]! - d[0]! * x[2]!
  y[2] = d[0]! * x[1]! - d[1]! * x[0]!
  return quat.fromBasis(rotation, x, y, d)
}

function ensureLight(world: World, entity: number, name: 'sun' | 'moon'): Entity {
  if (
    entity >= 0 &&
    world.isAlive(entity as Entity) &&
    world.has(entity as Entity, DirectionalLight)
  ) {
    return entity as Entity
  }
  return world.spawn(
    [
      DirectionalLight,
      {
        color: [...(name === 'sun' ? SUN_COLOR : MOON_COLOR)] as never,
        illuminance: 0,
        shadows: name === 'sun',
        angularDiameter: name === 'sun' ? 0.53 : 0,
      },
    ],
    Transform,
  )
}

let lastSunElevation = Number.NaN

/**
 * Places the sun and moon (0130) from TimeOfDay and the Sky's path, writes their lights (direction,
 * illuminance, which one casts shadows), and raises Sunrise and Sunset.
 */
export const updateSky = defineSystem({
  name: 'sky/update',
  description:
    "Points the Sky's sun and moon lights from TimeOfDay (0130), hands shadows between them at twilight, and raises Sunrise and Sunset.",
  setup: (world) => ({ query: world.query({ with: [Sky] }) }),
  run: ({ query }, world) => {
    const frame = world.resource(SkyFrame)
    frame.entity = -1
    let entity: Entity | undefined
    for (const table of query.tables) if (table.count > 0) entity = table.entities[0]
    if (entity === undefined) return
    const sky = world.get(entity, Sky)!
    const clock = world.resource(TimeOfDay)
    frame.entity = entity
    frame.mode = sky.mode
    const c = computeCelestial(sky as never, clock, frame.celestial)
    // The atmosphere color mode: the default Earth sky unless the scene set one up.
    const env = world.tryResource(DefaultEnvironment)
    if (env && env.sky === null) env.sky = { turbidity: 2.2 }

    const sun = ensureLight(world, sky.sun as number, 'sun')
    const moon = ensureLight(world, sky.moon as number, 'moon')
    if (sun !== sky.sun || moon !== sky.moon) world.set(entity, Sky, { sun, moon } as never)
    frame.sunLight = sun
    frame.moonLight = moon

    // Shadows: the sun's while it's up; the moon's once the sun is well down and the moon is up.
    const sunShadows = c.sunElevation > -2
    const moonShadows = !sunShadows && c.sunElevation < -6 && c.moonElevation > 2
    frame.shadows = sunShadows ? 'sun' : moonShadows ? 'moon' : 'none'
    const night = sky.nightBrightness
    const moonLux = sky.moonIlluminance * c.illuminated * night * smooth(-2, 4, c.moonElevation)
    writeLight(world, sun, c.sun, sky.sunIlluminance, sunShadows)
    writeLight(world, moon, c.moon, moonLux, moonShadows)
    const model = skyModel(env?.sky)
    groundLight(world, model, sun, c.sun, frame.sunGround)
    groundLight(world, model, moon, c.moon, frame.moonGround)

    frame.nightBrightness = night
    frame.stars = sky.stars
    frame.twinkle = sky.twinkle
    frame.milkyWay = sky.milkyWay
    frame.aurora = sky.aurora
    frame.moonDisk = sky.moonDisk
    frame.moonSize = sky.moonSize
    frame.time = skyTick(world) * (world.tryResource(FixedTime)?.step ?? 1 / 60)

    if (!Number.isNaN(lastSunElevation)) {
      if (lastSunElevation < 0 && c.sunElevation >= 0) world.send(Sunrise, { day: clock.day })
      if (lastSunElevation >= 0 && c.sunElevation < 0) world.send(Sunset, { day: clock.day })
    }
    lastSunElevation = c.sunElevation
  },
})

let model: AtmosphereModel | undefined
const modelSettings = new Float64Array(3).fill(Number.NaN)

/** The atmosphere the default sky draws, remade when its settings change (the weather's haze). */
function skyModel(
  sky: Partial<{ turbidity: number; rayleigh: number; mie: number }> | null | undefined,
): AtmosphereModel {
  const turbidity = sky?.turbidity ?? 2
  const rayleigh = sky?.rayleigh ?? 1
  const mie = sky?.mie ?? 1
  const s = modelSettings
  if (!model || s[0] !== turbidity || s[1] !== rayleigh || s[2] !== mie) {
    s[0] = turbidity
    s[1] = rayleigh
    s[2] = mie
    model = proceduralSkyModel({ turbidity, rayleigh, mie }, model)
  }
  return model
}

/** sin of the sun disk's radius, 0.265°. */
const DISK = Math.sin((0.265 * Math.PI) / 180)
const transmittance = new Float64Array(3)

/**
 * A light's illuminance and color at open ground 10 m up (where the renderer measures it for a
 * camera there) after the air along `dir`. The disk sets over its own width: light fades from full
 * to none as it crosses the horizon, through the air just above it.
 */
function groundLight(
  world: World,
  m: AtmosphereModel,
  light: Entity,
  dir: Float64Array,
  out: GroundLight,
): void {
  const l = world.get(light, DirectionalLight)!
  const visible = smooth(-DISK, DISK, dir[1]!)
  const y = Math.max(dir[1]!, DISK)
  const flat = Math.sqrt(dir[0]! * dir[0]! + dir[2]! * dir[2]!) || 1
  const k = Math.sqrt(1 - y * y) / flat
  transmittanceToTop(m, 0, m.bottom + 0.01, 0, dir[0]! * k, y, dir[2]! * k, transmittance)
  const r = l.color[0]! * transmittance[0]!
  const g = l.color[1]! * transmittance[1]!
  const b = l.color[2]! * transmittance[2]!
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  out.illuminance = l.illuminance * luma * visible
  const inv = luma > 0 ? 1 / luma : 0
  out.color[0] = r * inv
  out.color[1] = g * inv
  out.color[2] = b * inv
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function writeLight(
  world: World,
  light: Entity,
  dir: Float64Array,
  lux: number,
  shadows: boolean,
): void {
  const current = world.get(light, DirectionalLight)!
  if (current.illuminance !== lux || current.shadows !== shadows) {
    world.set(light, DirectionalLight, { illuminance: lux, shadows } as never)
  }
  world.set(light, Transform, { rotation: towardLight(dir) as never })
}
