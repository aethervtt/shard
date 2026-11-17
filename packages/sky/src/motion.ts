import { defineResource, defineSystem, type Entity, type World } from '@aethervtt/shard-core'
import { Camera3d, ShaderGlobals } from '@aethervtt/shard-render'
import { FixedTime } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { SkyFrame } from './celestial'
import { skyTick } from './clock'
import { Clouds } from './components'
import { SHADOW_EXTENT, SHADOW_SIZE } from './shaders'

/** Seconds between the cloud velocity's samples: it changes linearly from one to the next. */
export const CLOUD_WINDOW = 10

/**
 * How far the wind has carried the clouds (0131), a function of the sky's tick: the velocity is
 * sampled at every CLOUD_WINDOW of ticks since tick 0 and integrated between the samples, so a
 * player who joins late sums the same windows and sees the same clouds as everyone else.
 */
export interface CloudMotionState {
  /** Advection in world xz (m), plus the Clouds' phase. */
  offset: Float64Array
  /** Metres of shape evolution. */
  evolution: number
  /** First shard::globals slot of shard::sky_occlusion, or -1. */
  slot: number
  /** The cloud shadow map's center (world xz, snapped to its texels) this frame. */
  shadowCenter: Float64Array
  /**
   * The wind at a tick (`skyTick`'s, past or future), for the clouds: writes direction x, z and
   * speed (m/s at the ground) into `out`. Weather sets it while it drives the wind (0133), so the
   * clouds' history is known on every machine; without it they read wind/Wind now.
   */
  windAt: ((world: World, tick: number, out: Float64Array) => void) | undefined
  /** The window `base` starts: offset x, z and evolution there, and the rates at its ends. */
  window: number
  /** The `windAt` the windows were summed with: a new one sums them again from tick 0. */
  summedWith: CloudMotionState['windAt']
  base: Float64Array
  rate0: Float64Array
  rate1: Float64Array
}

export const CloudMotion = defineResource<CloudMotionState>('sky/CloudMotion', {
  description:
    'The clouds’ wind advection (m) and evolution, a function of the sky tick (0131): the same on every machine.',
  init: () => ({
    offset: new Float64Array(2),
    evolution: 0,
    slot: -1,
    shadowCenter: new Float64Array(2),
    windAt: undefined,
    window: -1,
    summedWith: undefined,
    base: new Float64Array(3),
    rate0: new Float64Array(3),
    rate1: new Float64Array(3),
  }),
})

const wind3 = new Float64Array(3)

const cloudsOf = (world: World, entity: Entity) => world.get(entity, Clouds)

/** The clouds' velocity (m/s in x, z) and evolution rate at a tick, into `out`. */
function rateAt(
  world: World,
  clouds: ReturnType<typeof cloudsOf>,
  motion: CloudMotionState,
  tick: number,
  out: Float64Array,
): void {
  let dx = clouds.direction[0]
  let dz = clouds.direction[2]
  let speed = clouds.speed
  if (clouds.windInfluence > 0) {
    const wind = motion.windAt ? undefined : world.tryResource(Wind)
    if (motion.windAt) {
      motion.windAt(world, tick, wind3)
      dx = wind3[0]!
      dz = wind3[1]!
      speed = wind3[2]! * clouds.windInfluence * clouds.windScale
    } else if (wind) {
      dx = wind.direction[0]
      dz = wind.direction[2]
      speed = wind.speed * clouds.windInfluence * clouds.windScale
    }
  }
  const len = Math.sqrt(dx * dx + dz * dz) || 1
  out[0] = (dx / len) * speed
  out[1] = (dz / len) * speed
  out[2] = clouds.evolution * 1000
}

/**
 * A flash inside the clouds this frame (0133's lightning): world position (m) and strength (the
 * cloud radiance it adds near that point, cd/m²; 0 for none). Weather writes it; the clouds read it.
 */
export interface SkyFlashValue {
  position: Float64Array
  strength: number
}

export const SkyFlash = defineResource<SkyFlashValue>('sky/Flash', {
  description: 'A lightning flash lighting the clouds from inside this frame (0131, 0133).',
  init: () => ({ position: new Float64Array(3), strength: 0 }),
})

/**
 * Carries the clouds along the wind (wind/Wind × windScale, or the Clouds' own speed) to the sky's
 * tick: whole windows since tick 0 at their mean rate, then the rate rising linearly through this
 * one. A new window costs one rate sample; joining late, one per window passed.
 */
export const advectClouds = defineSystem({
  name: 'sky/advect-clouds',
  description:
    'Sets the cloud offset and evolution at the sky tick (0131): the wind sampled every CLOUD_WINDOW seconds since tick 0, integrated between samples.',
  run: (_, world) => {
    const frame = world.resource(SkyFrame)
    if (frame.entity < 0 || !world.has(frame.entity as Entity, Clouds)) return
    const clouds = cloudsOf(world, frame.entity as Entity)
    const step = world.tryResource(FixedTime)?.step ?? 1 / 60
    const motion = world.resource(CloudMotion)
    const ticks = Math.max(1, Math.round(CLOUD_WINDOW / step))
    const seconds = ticks * step
    const tick = Math.max(0, skyTick(world))
    const window = Math.floor(tick / ticks)
    const base = motion.base
    const r0 = motion.rate0
    const r1 = motion.rate1
    if (motion.window < 0 || window < motion.window || motion.summedWith !== motion.windAt) {
      // First run, the tick went back (a client reconnected), or the weather started driving the
      // wind: from tick 0 again.
      motion.summedWith = motion.windAt
      motion.window = 0
      base.fill(0)
      rateAt(world, clouds, motion, 0, r0)
      rateAt(world, clouds, motion, ticks, r1)
    }
    while (motion.window < window) {
      for (let c = 0; c < 3; c++) {
        base[c] = base[c]! + (r0[c]! + r1[c]!) * 0.5 * seconds
        r0[c] = r1[c]!
      }
      motion.window++
      rateAt(world, clouds, motion, (motion.window + 1) * ticks, r1)
    }
    const u = (tick - window * ticks) * step
    const k = (u * u) / (2 * seconds)
    motion.offset[0] = base[0]! + r0[0]! * u + (r1[0]! - r0[0]!) * k
    motion.offset[1] = base[1]! + r0[1]! * u + (r1[1]! - r0[1]!) * k
    motion.evolution = base[2]! + r0[2]! * u + (r1[2]! - r0[2]!) * k
  },
})

/** Writes shard::sky_occlusion's block: the shadow map, the layer and the cloud map. */
export const uploadOcclusion = defineSystem({
  name: 'sky/occlusion',
  description:
    "Centers the cloud shadow map on the camera and writes the cloud shadows' globals block (0131).",
  setup: (world) => ({ cameras: world.query({ with: [Camera3d, GlobalTransform] }) }),
  run: ({ cameras }, world) => {
    const motion = world.resource(CloudMotion)
    if (motion.slot < 0) return
    const globals = world.tryResource(ShaderGlobals)
    if (!globals) return
    const v = globals.values
    const o = 4 + motion.slot * 4
    const frame = world.resource(SkyFrame)
    const on =
      frame.entity >= 0 && frame.mode !== 'none' && world.has(frame.entity as Entity, Clouds)
    if (!on) {
      v[o + 6] = 0
      return
    }
    for (const table of cameras.tables) {
      if (table.count === 0) continue
      const g = table.column(GlobalTransform, 'matrix')
      const texel = SHADOW_EXTENT / SHADOW_SIZE
      motion.shadowCenter[0] = Math.round(g[3]! / texel) * texel
      motion.shadowCenter[1] = Math.round(g[11]! / texel) * texel
      break
    }
    const clouds = world.get(frame.entity as Entity, Clouds)
    v[o] = motion.shadowCenter[0]!
    v[o + 1] = motion.shadowCenter[1]!
    v[o + 2] = 1 / SHADOW_EXTENT
    v[o + 3] = clouds.coverage
    v[o + 4] = clouds.bottom + clouds.thickness * 0.35
    v[o + 5] = clouds.shadowStrength
    v[o + 6] = clouds.shadows ? 1 : 0
    // Stratus is thin: its shadows are lighter than a cumulonimbus'.
    v[o + 7] = 0.55 + 0.45 * clouds.type
    v[o + 8] = motion.offset[0]! + clouds.phase
    v[o + 9] = motion.offset[1]!
    v[o + 10] = clouds.mapScale
  },
})
