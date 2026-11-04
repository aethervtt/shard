import type { Entity, World } from '@aethervtt/shard-core'
import { finestPage, type HeightfieldRuntime, pageHeight } from '@aethervtt/shard-terrain'
import { insideShape, WaterBodies, type WaterBodiesState, type WaterBodyRecord } from './bodies'
import type { WaterOpticsValue } from './optics'

/** What `waterAt` writes. */
export interface WaterSample {
  /** The body whose water is here, or null. */
  body: Entity | null
  /** The water surface's height here (NaN without water). */
  surfaceHeight: number
  /** How far below the surface the point is (surface − y; negative above it, NaN without water). */
  depth: number
  /** The ground's height under the point (−Infinity where there's none known). */
  groundHeight: number
  /** Water velocity (m/s); rivers bring it in 0097 part 2, so zero for now. */
  flow: [number, number, number]
  /** The surface normal (straight up until waves, 0098). */
  normal: [number, number, number]
  /** Whether the point is in water: below the surface and above the ground. */
  underwater: boolean
  /** The body's optics, or null. */
  optics: WaterOpticsValue | null
}

export function waterSample(): WaterSample {
  return {
    body: null,
    surfaceHeight: Number.NaN,
    depth: Number.NaN,
    groundHeight: Number.NEGATIVE_INFINITY,
    flow: [0, 0, 0],
    normal: [0, 1, 0],
    underwater: false,
    optics: null,
  }
}

const local = new Float64Array(3)

/**
 * The ground under world (x, z), from the first heightfield terrain (0071) that covers it, as
 * `terrainHeightAt` finds it (the finest page held on the CPU), or −Infinity. No allocation.
 */
export function groundAt(state: WaterBodiesState, x: number, y: number, z: number): number {
  for (let i = 0; i < state.terrainCount; i++) {
    const h = heightfieldGround(state.terrains[i]!, x, y, z)
    if (!Number.isNaN(h)) return h
  }
  return Number.NEGATIVE_INFINITY
}

/** A terrain's ground under a world point, in world y, or NaN off it. */
export function heightfieldGround(rt: HeightfieldRuntime, x: number, y: number, z: number): number {
  const layout = rt.layout
  if (!layout || !rt.pages) return Number.NaN
  rt.frame.pointToPlanet(x, y, z, local)
  const tx = local[0]!
  const tz = local[2]!
  if (tx < 0 || tz < 0 || tx > layout.sizeX || tz > layout.sizeZ) return Number.NaN
  const page = finestPage(rt, tx, tz)
  if (!page) return Number.NaN
  const h = pageHeight(rt, page, tx, tz)
  const m = rt.frame.toOrigin
  return m[4]! * tx + m[5]! * h + m[6]! * tz + m[7]!
}

/** The body whose water covers world (x, z): the last drawn that contains it, or undefined. */
export function bodyAt(state: WaterBodiesState, x: number, z: number): WaterBodyRecord | undefined {
  // Drawn lowest priority first, so the last that covers the point is on top (the info texture's
  // raster agrees: later bodies overwrite earlier ones).
  for (let i = state.count - 1; i >= 0; i--) {
    const r = state.sorted[i]!
    if (r.shape === null || insideShape(r.shape, x, z)) return r
  }
  return undefined
}

/**
 * The water at a world position (0097): the body there, its surface height, the point's depth
 * below it, the ground under it, and whether the point is under water. CPU only, deterministic,
 * no allocation: it evaluates the bodies' outlines (as of the last `water/bodies` run) and the
 * heightfield's pages, never the GPU's info texture.
 */
export function waterAt(world: World, position: ArrayLike<number>, out: WaterSample): WaterSample {
  const x = position[0]!
  const y = position[1]!
  const z = position[2]!
  const state = world.tryResource(WaterBodies)
  out.flow[0] = 0
  out.flow[1] = 0
  out.flow[2] = 0
  out.normal[0] = 0
  out.normal[1] = 1
  out.normal[2] = 0
  if (!state) {
    out.body = null
    out.surfaceHeight = Number.NaN
    out.depth = Number.NaN
    out.groundHeight = Number.NEGATIVE_INFINITY
    out.underwater = false
    out.optics = null
    return out
  }
  const ground = groundAt(state, x, y, z)
  out.groundHeight = ground
  const r = bodyAt(state, x, z)
  if (!r) {
    out.body = null
    out.surfaceHeight = Number.NaN
    out.depth = Number.NaN
    out.underwater = false
    out.optics = null
    return out
  }
  out.body = r.entity
  out.surfaceHeight = r.level
  out.depth = r.level - y
  out.underwater = y < r.level && y > ground
  out.optics = r.optics
  return out
}
