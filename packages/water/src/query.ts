import type { Entity, World } from '@aethervtt/shard-core'
import { finestPage, type HeightfieldRuntime, pageHeight } from '@aethervtt/shard-terrain'
import {
  BODY_CELL,
  bodyBounds,
  cellKey,
  insideShape,
  WaterBodies,
  type WaterBodiesState,
  type WaterBodyRecord,
} from './bodies'
import type { WaterOpticsValue } from './optics'
import { type RiverPoint, riverAt } from './rivers'
import { seaAt, seaSample, WaveSets, waveTick, waveTime } from './waves/sea'

/** What `waterAt` writes. */
export interface WaterSample {
  /** The body whose water is here, or null. */
  body: Entity | null
  /** The water surface's height here, waves included (NaN without water). */
  surfaceHeight: number
  /** How far below the surface the point is (surface − y; negative above it, NaN without water). */
  depth: number
  /** The ground's height under the point (−Infinity where there's none known). */
  groundHeight: number
  /** Water velocity (m/s): a river's flow there (0123), horizontal; zero elsewhere. */
  flow: [number, number, number]
  /** The surface normal, waves included (0098). */
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
const sea = seaSample()

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

const NO_CELL: number[] = []

/** A river point `bodyAt` found (its surface, flow and depth), when the body is a river. */
export const riverHit: RiverPoint = { surface: 0, flowX: 0, flowZ: 0, depth: 0 }

function covers(r: WaterBodyRecord, x: number, z: number): boolean {
  if (r.river) return riverAt(r.river, x, z, riverHit)
  if (r.shape) return insideShape(r.shape, x, z)
  return true
}

/**
 * The body whose water covers world (x, z): the highest priority of every valid body there (drawn
 * or not, 0123), from the grid of their bounds, or undefined. For a river, `riverHit` holds its
 * surface, flow and depth at the point. No allocation.
 */
export function bodyAt(state: WaterBodiesState, x: number, z: number): WaterBodyRecord | undefined {
  const cell =
    state.grid.get(cellKey(Math.floor(x / BODY_CELL), Math.floor(z / BODY_CELL))) ?? NO_CELL
  const wide = state.wide
  // Both lists ascend by priority: walk them down together, highest first (later bodies overwrite
  // earlier ones in the info texture's raster too).
  let a = cell.length - 1
  let b = wide.length - 1
  while (a >= 0 || b >= 0) {
    const i = b < 0 || (a >= 0 && cell[a]! > wide[b]!) ? cell[a--]! : wide[b--]!
    const r = state.all[i]!
    const bounds = bodyBounds(r)
    if (bounds && (x < bounds[0]! || z < bounds[1]! || x > bounds[2]! || z > bounds[3]!)) continue
    if (covers(r, x, z)) return r
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
  let ground = groundAt(state, x, y, z)
  const r = bodyAt(state, x, z)
  // A river's bed where there's no terrain (0123).
  if (r?.river && ground === Number.NEGATIVE_INFINITY) ground = riverHit.surface - riverHit.depth
  out.groundHeight = ground
  if (!r) {
    out.body = null
    out.surfaceHeight = Number.NaN
    out.depth = Number.NaN
    out.underwater = false
    out.optics = null
    return out
  }
  let surface = r.river ? riverHit.surface : r.level
  if (r.river) {
    out.flow[0] = riverHit.flowX
    out.flow[2] = riverHit.flowZ
  }
  // Waves (0098), at the tick: the CPU evaluator, attenuated by the water's depth here.
  const set = world.tryResource(WaveSets)?.sets.get(r.entity)
  if (set && !set.problem) {
    const tick = waveTick(world)
    seaAt(set, x, z, waveTime(world, tick), tick, r.level - ground, sea)
    surface += sea.height
    const l = Math.sqrt(sea.slopeX * sea.slopeX + 1 + sea.slopeZ * sea.slopeZ)
    out.normal[0] = -sea.slopeX / l
    out.normal[1] = 1 / l
    out.normal[2] = -sea.slopeZ / l
  }
  out.body = r.entity
  out.surfaceHeight = surface
  out.depth = surface - y
  out.underwater = y < surface && y > ground
  out.optics = r.optics
  return out
}
