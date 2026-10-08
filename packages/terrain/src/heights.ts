import { defineResource, type Entity, ShardError, type World } from '@aethervtt/shard-core'
import type { Workers } from '@aethervtt/shard-platform'
import { biomeWeights, dominantBiome, MAX_BIOMES } from './biomes'
import type { PlanetRuntime } from './planet'
import { samplePoint } from './points'

/** Every planet's runtime state, and the frame counter terrain systems stamp with. */
export class TerrainState {
  readonly planets = new Map<Entity, PlanetRuntime>()
  frame = 0
  workers: Workers | undefined
  /** Set when a graph or biome asset (re)loaded: planets re-resolve their assets. */
  dirty = true
}

export const TerrainWorld = defineResource<TerrainState>('terrain/World', {
  description: 'Per-planet terrain state: quadtrees, collider chunks, and resolved assets.',
  init: () => new TerrainState(),
})

/** The runtime for a planet entity, ready to sample, or a `terrain/not-ready` error. */
export function planetRuntime(world: World, planet: Entity): PlanetRuntime {
  const rt = world.tryResource(TerrainWorld)?.planets.get(planet)
  if (!rt) {
    throw new ShardError('terrain/not-a-planet', `Entity ${planet} has no terrain/Planet`, {
      hint: 'Add terrain/Planet (and a Grid) to the planet entity, and the terrain plugin to the app.',
    })
  }
  if (rt.problem) throw rt.problem
  if (!rt.ready) {
    throw new ShardError(
      'terrain/not-ready',
      `Planet ${planet} is waiting for ${rt.waiting ?? 'its settings'}`,
      {
        hint: 'Its graphs and biomes load asynchronously; step a frame (or await the asset loads) first.',
      },
    )
  }
  return rt
}

const one = new Float32Array(1)

/** Height-graph metres above radius at a unit direction in the planet's frame. Sync, CPU. */
export function heightAt(rt: PlanetRuntime, x: number, y: number, z: number): number {
  const s = rt.settings!
  if (!rt.height) return 0
  return samplePoint(rt.height, s.seed, x, y, z, s.radius, one) * s.heightScale
}

function unit(direction: ArrayLike<number>, out: Float64Array): Float64Array {
  const x = direction[0]!
  const y = direction[1]!
  const z = direction[2]!
  const len = Math.sqrt(x * x + y * y + z * z)
  if (!(len > 0)) {
    throw new ShardError('terrain/bad-direction', 'The direction is zero or not a number', {
      hint: 'Pass a direction from the planet’s center in its frame, e.g. the position of a point on it.',
    })
  }
  out[0] = x / len
  out[1] = y / len
  out[2] = z / len
  return out
}

const d = new Float64Array(3)

/**
 * The surface height (metres above the planet's radius) in `direction` (the planet's frame, any
 * length), from the canonical CPU noise (0041) the colliders use. Headless-safe and sync; allocates
 * nothing. Between vertices the collider surface is flat triangles, so it can differ from this by
 * the terrain's roughness below the vertex spacing.
 */
export function planetHeightAt(world: World, planet: Entity, direction: ArrayLike<number>): number {
  const rt = planetRuntime(world, planet)
  unit(direction, d)
  return heightAt(rt, d[0]!, d[1]!, d[2]!)
}

export interface PlanetSurface {
  /** Metres above radius. */
  height: number
  /** Below sea level (planets with an ocean). */
  underwater: boolean
  /** Metres of water above the ground (0 on land). */
  depth: number
}

/** Height, and whether and how deep it's under water, in `direction`. */
export function planetSurfaceAt(
  world: World,
  planet: Entity,
  direction: ArrayLike<number>,
  out: PlanetSurface = { height: 0, underwater: false, depth: 0 },
): PlanetSurface {
  const rt = planetRuntime(world, planet)
  unit(direction, d)
  const h = heightAt(rt, d[0]!, d[1]!, d[2]!)
  const s = rt.settings!
  out.height = h
  out.underwater = s.ocean && h < s.seaLevel
  out.depth = out.underwater ? s.seaLevel - h : 0
  return out
}

export interface TerrainSample extends PlanetSurface {
  /** Degrees from flat. */
  slope: number
  /** Climate at the point, before latitude and altitude. */
  temperature: number
  moisture: number
  /** Sine of the latitude. */
  latitude: number
  /** Biome weights (summing to 1), by index in the BiomeSet. */
  biomes: number[]
  /** The heaviest biome's index. */
  biome: number
}

const weights = new Float32Array(MAX_BIOMES)
const t1 = new Float64Array(3)
const t2 = new Float64Array(3)

/**
 * Everything the surface is at a direction: height, water, slope (from two nearby heights), climate,
 * and biome weights, as the terrain shader computes them.
 */
export function terrainSample(rt: PlanetRuntime, direction: ArrayLike<number>): TerrainSample {
  const s = rt.settings!
  unit(direction, d)
  const [x, y, z] = [d[0]!, d[1]!, d[2]!]
  const h = heightAt(rt, x, y, z)
  // Two tangents at the point, a metre-ish apart (a vertex spacing at collider depth).
  const step = Math.max(rt.spacing(rt.colliderDepth), 0.25) / s.radius
  const ax = Math.abs(y) < 0.9 ? 0 : 1
  const ay = Math.abs(y) < 0.9 ? 1 : 0
  // e1 = normalize(axis × d), e2 = d × e1
  let e1x = ay * z
  let e1y = -ax * z
  let e1z = ax * y - ay * x
  const l1 = Math.hypot(e1x, e1y, e1z)
  e1x /= l1
  e1y /= l1
  e1z /= l1
  const e2x = y * e1z - z * e1y
  const e2y = z * e1x - x * e1z
  const e2z = x * e1y - y * e1x
  unit([x + e1x * step, y + e1y * step, z + e1z * step], t1)
  unit([x + e2x * step, y + e2y * step, z + e2z * step], t2)
  const h1 = heightAt(rt, t1[0]!, t1[1]!, t1[2]!)
  const h2 = heightAt(rt, t2[0]!, t2[1]!, t2[2]!)
  const r0 = s.radius + h
  const p0 = [x * r0, y * r0, z * r0]
  const r1 = s.radius + h1
  const r2 = s.radius + h2
  const a = [t1[0]! * r1 - p0[0]!, t1[1]! * r1 - p0[1]!, t1[2]! * r1 - p0[2]!]
  const b = [t2[0]! * r2 - p0[0]!, t2[1]! * r2 - p0[1]!, t2[2]! * r2 - p0[2]!]
  const nx = a[1]! * b[2]! - a[2]! * b[1]!
  const ny = a[2]! * b[0]! - a[0]! * b[2]!
  const nz = a[0]! * b[1]! - a[1]! * b[0]!
  const nl = Math.hypot(nx, ny, nz)
  const cos = Math.abs(nx * x + ny * y + nz * z) / nl
  const slope = (Math.acos(Math.min(1, cos)) * 180) / Math.PI
  let temperature = 0
  let moisture = 0
  if (rt.climate) {
    temperature = samplePoint(rt.climate, s.seed, x, y, z, s.radius, one, 'temperature')
    moisture = samplePoint(rt.climate, s.seed, x, y, z, s.radius, one, 'moisture')
  }
  const table = rt.table
  biomeWeights(table, { temperature, moisture, height: h, slope, latitude: y }, weights)
  const underwater = s.ocean && h < s.seaLevel
  return {
    height: h,
    underwater,
    depth: underwater ? s.seaLevel - h : 0,
    slope,
    temperature,
    moisture,
    latitude: y,
    biomes: Array.from(weights.subarray(0, table.count)),
    biome: dominantBiome(weights, table.count),
  }
}
