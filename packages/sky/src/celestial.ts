import { defineResource, defineSystem, type Entity, quat, type World } from '@aethervtt/shard-core'
import { DefaultEnvironment, DirectionalLight } from '@aethervtt/shard-render'
import { Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { Sky, Sunrise, Sunset, TimeOfDay } from './components'
import { type CelestialState, computeCelestial, createCelestial } from './ephemeris'

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
  nightBrightness: number
  stars: number
  twinkle: number
  milkyWay: number
  aurora: number
  moonDisk: number
  moonSize: number
  /** Seconds, for twinkle and aurora. */
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

    frame.nightBrightness = night
    frame.stars = sky.stars
    frame.twinkle = sky.twinkle
    frame.milkyWay = sky.milkyWay
    frame.aurora = sky.aurora
    frame.moonDisk = sky.moonDisk
    frame.moonSize = sky.moonSize
    frame.time = world.tryResource(Time)?.elapsed ?? 0

    if (!Number.isNaN(lastSunElevation)) {
      if (lastSunElevation < 0 && c.sunElevation >= 0) world.send(Sunrise, { day: clock.day })
      if (lastSunElevation >= 0 && c.sunElevation < 0) world.send(Sunset, { day: clock.day })
    }
    lastSunElevation = c.sunElevation
  },
})

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
