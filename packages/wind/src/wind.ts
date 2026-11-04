import { defineResource, defineSchema, t, type World } from '@aethervtt/shard-core'
import { NetClock, NetRole } from '@aethervtt/shard-net'
import { FixedTime, Time } from '@aethervtt/shard-runtime'
import { applyZones, WindField } from './zones'

export interface WindValue {
  /** World-space, toward where it blows (normalized when used). */
  direction: [number, number, number]
  /** m/s at 10 m: 0 calm, 6 a breeze, 15 a strong wind, 25+ a storm. */
  speed: number
  /** 0..1: how much gusts add or take away, as a fraction of speed. */
  gustiness: number
  /** Gust waves per metre. */
  gustScale: number
}

/** The speed sway is tuned for: 0045's wind strength 1. `strength = speed / BREEZE`. */
export const BREEZE = 6

/** Gust noise cells crossed per second, downwind (0045's sway). */
export const GUST_DRIFT = 0.6

export const WindSchema = defineSchema('wind/WindValue', {
  direction: t.vec3({
    default: [1, 0, 0.35],
    description: 'World-space direction it blows toward (normalized when used).',
  }),
  speed: t.f32({
    default: 6,
    min: 0,
    unit: 'm/s',
    description: 'At 10 m: 0 calm, 6 a breeze, 15 a strong wind, 25+ a storm.',
  }),
  gustiness: t.f32({
    default: 0.3,
    min: 0,
    max: 1,
    description: 'How much gusts add or take away, as a fraction of speed.',
  }),
  gustScale: t.f32({ default: 0.05, min: 0, unit: '1/m', description: 'Gust waves per metre.' }),
})

/**
 * The wind (spec 0096): one uniform wind with gusts, read by foliage and trees (`shard::wind` in
 * WGSL) and by anything on the CPU through `windAt`. WindZones override it locally. 0049 replaces
 * its source with a per-planet field; readers stay the same.
 */
export const Wind = defineResource<WindValue>('wind/Wind', {
  description:
    'The wind in m/s: direction, speed, gustiness and gust scale. Grass, trees and (later) water and particles read it; WindZone entities override it locally.',
  schema: WindSchema as never,
  init: () => ({ direction: [1, 0, 0.35], speed: 6, gustiness: 0.3, gustScale: 0.05 }),
})

/**
 * The wind fields scatter/Vegetation and nature/Tree carried before 0096, for their material types'
 * `removed`: files that still set them load with them ignored, and their import warns.
 */
export const REMOVED_WIND_FIELDS = {
  windDirection: 'wind comes from the wind/Wind resource (0096); set its direction',
  windStrength: 'wind comes from the wind/Wind resource (0096); set its speed (m/s, 6 per unit)',
  gustScale: 'wind comes from the wind/Wind resource (0096); set its gustScale',
} as const

/** 0045's sway strength for a wind: 1 is a breeze. */
export function windStrength(wind: WindValue): number {
  return wind.speed / BREEZE
}

/** What `windAt` writes. */
export interface WindSample {
  /** Unit direction it blows toward (the uniform wind's when calm). */
  direction: [number, number, number]
  /** Steady speed here, m/s, after zones. */
  speed: number
  /** Gusts here and now, m/s: between −speed × gustiness and +speed × gustiness. */
  gust: number
}

export function windSample(): WindSample {
  return { direction: [1, 0, 0], speed: 0, gust: 0 }
}

/**
 * Seconds on the wind clock, what gusts move with: fixed ticks (and the fraction toward the next)
 * times the step, so it is the same on every machine at a tick. On a multiplayer client, the
 * server's tick (NetClock).
 */
export function windTime(world: World): number {
  const fixed = world.tryResource(FixedTime)
  if (!fixed) return world.tryResource(Time)?.elapsed ?? 0
  const role = world.tryResource(NetRole)
  const ticks =
    role?.role === 'client'
      ? (world.tryResource(NetClock)?.serverTick ?? 0)
      : fixed.tick + fixed.alpha
  return ticks * fixed.step
}

const DEFAULT_WIND: WindValue = {
  direction: [1, 0, 0.35],
  speed: 6,
  gustiness: 0.3,
  gustScale: 0.05,
}

/** The uniform wind's frame: unit direction, a horizontal unit side, as in `shard::wind`. */
export function windBasis(direction: ArrayLike<number>, out: Float64Array | Float32Array): boolean {
  let x = direction[0]!
  let y = direction[1]!
  let z = direction[2]!
  const l = Math.sqrt(x * x + y * y + z * z)
  const ok = l > 1e-9
  if (ok) {
    x /= l
    y /= l
    z /= l
  } else {
    x = 1
    y = 0
    z = 0
  }
  out[0] = x
  out[1] = y
  out[2] = z
  // side = normalize(cross(up, d)), with up = +y (or +x for a vertical wind).
  let sx: number
  let sy: number
  let sz: number
  if (Math.abs(y) < 0.99) {
    sx = z
    sy = 0
    sz = -x
  } else {
    sx = 0
    sy = -z
    sz = y
  }
  const s = Math.sqrt(sx * sx + sy * sy + sz * sz)
  out[3] = sx / s
  out[4] = sy / s
  out[5] = sz / s
  return ok
}

/** An integer hash to [0, 1), as `shard::wind`'s `wind_hash` (u32 math; f32 result). */
export function windHash(x: number, y: number): number {
  let h = (Math.imul(x >>> 0, 747796405) + Math.imul(y >>> 0, 2891336453)) >>> 0
  h = Math.imul((h >>> ((h >>> 28) + 4)) ^ h, 277803737) >>> 0
  return Math.fround(((h >>> 22) ^ h) >>> 0) * (1 / 4294967296)
}

/** Smooth gust noise in [0, 1]: value noise, as `shard::wind`'s `wind_gust_noise`. */
export function gustNoise(px: number, py: number): number {
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  const fx = px - ix
  const fy = py - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a00 = windHash(ix, iy)
  const a10 = windHash(ix + 1, iy)
  const a01 = windHash(ix, iy + 1)
  const a11 = windHash(ix + 1, iy + 1)
  const a = a00 + (a10 - a00) * sx
  const b = a01 + (a11 - a01) * sx
  return a + (b - a) * sy
}

const basis = new Float64Array(6)
const v = new Float64Array(3)

/**
 * The wind at a world-space point (0096): the uniform `Wind`, then WindZones in order (lowest
 * priority first), and gusts for the wind clock's `time` (default now: `windTime`). Writes into
 * `out` and allocates nothing. Matches `wind_at` in `shard::wind` to within 1e-4 m/s. Zones are as
 * of the last PostUpdate (they follow transforms).
 */
export function windAt(
  world: World,
  position: ArrayLike<number>,
  out: WindSample,
  time = windTime(world),
): WindSample {
  const wind = world.tryResource(Wind) ?? DEFAULT_WIND
  const px = position[0]!
  const py = position[1]!
  const pz = position[2]!
  const speed = windBasis(wind.direction, basis) ? wind.speed : 0
  v[0] = basis[0]! * speed
  v[1] = basis[1]! * speed
  v[2] = basis[2]! * speed
  const field = world.tryResource(WindField)
  if (field) applyZones(field.zones, field.count, px, py, pz, v)
  const s = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!)
  const along = (px * basis[0]! + py * basis[1]! + pz * basis[2]!) * wind.gustScale
  const across = (px * basis[3]! + py * basis[4]! + pz * basis[5]!) * wind.gustScale
  const g = gustNoise(along - time * GUST_DRIFT, across)
  const d = out.direction
  if (s > 1e-9) {
    d[0] = v[0]! / s
    d[1] = v[1]! / s
    d[2] = v[2]! / s
  } else {
    d[0] = basis[0]!
    d[1] = basis[1]!
    d[2] = basis[2]!
  }
  out.speed = s
  out.gust = s * wind.gustiness * (2 * g - 1)
  return out
}
